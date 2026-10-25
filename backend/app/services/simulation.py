"""Execution simulator for submitted payloads, including protocol upgrades.

Method (local demo chain):
  1. evm_snapshot.
  2. For each upgrade action, statically analyse the old and new implementation bytecode and run
     baseline capability probes against the *current* code.
  3. Execute the actual submitted actions as the ExecutionGuard (impersonated), exactly as the
     guard would call them, recording receipts, decoded events and balance changes.
  4. Re-run the same probes against the upgraded code. Callers include an unprivileged account,
     the proposer and every address embedded in the new bytecode. A capability that appears only
     after the upgrade (e.g. a caller that can now move vault funds) is a behavioural deviation.
  5. Check each declared intent assertion against these observations.
  6. evm_revert: the chain is left exactly as it was.

Findings are observations for this chain state, not proofs of safety under all future states.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from eth_abi import encode as abi_encode
from eth_utils import keccak, to_checksum_address
from sqlalchemy.orm import Session

from ..chain.artifacts import signature_db
from ..chain.client import ChainClient
from ..clock import utcnow
from ..models import Proposal, Simulation, new_id
from ..runtime import Deployment, runtime
from . import bytecode, live
from .decoder import describe_action
from .intent import extract_assertions, transfer_assertions
from .labels import Labeler, format_token
from .manifests import Action, manifest_actions

log = logging.getLogger("daoguard.simulation")

EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
PROBE_ACCOUNT = to_checksum_address("0x" + keccak(text="daoguard.probe.unprivileged")[:20].hex())
TRANSFER_TOPIC = "0x" + keccak(text="Transfer(address,address,uint256)").hex()
BEHAVIOUR_SAMPLES = [1_000_000, 1_999, 12_345, 15_170, 33_333]
VAULT_VIEWS = ["feeBps", "treasury", "asset", "totalCollected", "accountedBalance", "version"]

LIMITATIONS = [
    "Simulated against the current local chain state only; different future state can change outcomes.",
    "Capability probes call every external function with simple argument patterns from a fixed set of callers "
    "(an unprivileged account, the proposer, and addresses embedded in the new code). A backdoor gated on a "
    "secret argument value or an unlisted caller can evade probing.",
    "Static bytecode analysis identifies dispatcher selectors and embedded constants; it does not decompile logic.",
    "A PASS means no deviation was observed by these checks. It is not a proof that the code is safe.",
]

SEV_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}


def _addr_word(value: str) -> str:
    return "0x" + value[-40:]


def _read_slot_address(chain: ChainClient, contract: str, slot: str) -> str | None:
    raw = chain.get_storage(contract, slot)
    value = int(raw, 16)
    return to_checksum_address(_addr_word(raw)) if value else None


def _balance_of(chain: ChainClient, token: str, holder: str) -> int:
    data = "0x70a08231" + abi_encode(["address"], [holder]).hex()
    res = chain.call_raw(token, data)
    return int(res["data"], 16) if res["ok"] and res["data"] not in ("0x", None) else 0


def _owner_of(chain: ChainClient, contract: str) -> str | None:
    res = chain.call_raw(contract, "0x8da5cb5b")  # owner()
    if res["ok"] and res["data"] and len(res["data"]) >= 66:
        return to_checksum_address(_addr_word(res["data"]))
    return None


def _vault_views(chain: ChainClient, vault: str) -> dict[str, str | None]:
    db = signature_db()
    out: dict[str, str | None] = {}
    for name in VAULT_VIEWS:
        selector = "0x" + keccak(text=f"{name}()")[:4].hex()
        fn = db.function(selector)
        res = chain.call_raw(vault, selector)
        if not res["ok"] or not fn:
            out[name] = None
            continue
        data = res["data"]
        if name in ("treasury", "asset"):
            out[name] = to_checksum_address(_addr_word(data))
        elif name == "version":
            try:
                from eth_abi import decode as abi_decode

                out[name] = abi_decode(["string"], bytes.fromhex(data[2:]))[0]
            except Exception:
                out[name] = None
        else:
            out[name] = str(int(data, 16))
    return out


def _transfers(logs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {"token": l["address"], "from": l["args"]["from"], "to": l["args"]["to"], "amount": l["args"]["value"]}
        for l in logs
        if l.get("event") == "Transfer" and "value" in l.get("args", {})
    ]


def _approvals(logs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {"token": l["address"], "owner": l["args"]["owner"], "spender": l["args"]["spender"], "amount": l["args"]["value"]}
        for l in logs
        if l.get("event") == "Approval" and "spender" in l.get("args", {})
    ]


def _event_summary(logs: list[dict[str, Any]], labeler: Labeler) -> list[dict[str, Any]]:
    out = []
    for l in logs:
        out.append(
            {
                "contract": l["address"],
                "contract_label": labeler.label(l["address"]),
                "event": l.get("event") or l.get("topic0"),
                "args": l.get("args", {}),
            }
        )
    return out


def _arg_variants(inputs: list[dict[str, Any]] | None, caller: str, big_amount: int) -> list[bytes]:
    if inputs is None:
        return [b"", b"\x00" * 64]
    types = [i["type"] for i in inputs]

    def build(big: bool) -> list[Any]:
        values = []
        for t in types:
            if t == "address":
                values.append(caller)
            elif t.startswith(("uint", "int")):
                bits = int(re.sub(r"^u?int", "", t) or 256)
                values.append(min(big_amount, 2 ** (bits - 1) - 1) if big else 0)
            elif t == "bool":
                values.append(True)
            elif t == "bytes32":
                values.append(b"\x00" * 32)
            elif t.startswith("bytes") and not t.endswith("]"):
                values.append(b"" if t == "bytes" else b"\x00" * int(t[5:]))
            elif t == "string":
                values.append("")
            else:
                raise ValueError(f"unsupported probe type {t}")
        return values

    variants = []
    try:
        variants.append(abi_encode(types, build(False)) if types else b"")
        if any(t.startswith(("uint", "int")) for t in types):
            variants.append(abi_encode(types, build(True)))
    except ValueError:
        variants = [b"\x00" * 32 * len(types)]
    return variants


class _Sim:
    def __init__(self, db: Session, deployment: Deployment, proposal: Proposal, sim_id: str | None = None):
        self.db = db
        self.sim_id = sim_id
        self.d = deployment
        self.chain = runtime.chain
        self.labeler = Labeler(db)
        self.proposal = proposal
        self.tokens = [deployment.c("usdc"), deployment.c("atlas")]
        self.treasury = deployment.c("guard")
        self.findings: list[dict[str, Any]] = []

    def step(self, stage: str, message: str, status: str = "info") -> None:
        live.activity(self.proposal.id, stage, message, status, simulation_id=self.sim_id)

    def finding(self, rule_id: str, severity: str, title: str, explanation: str, evidence: Any = None) -> None:
        self.findings.append(
            {"rule_id": rule_id, "severity": severity, "title": title, "explanation": explanation, "evidence": evidence}
        )

    # ------------------------------------------------------------- probes
    def probe(self, proxy: str, functions: list[dict[str, Any]], callers: list[tuple[str, str]], phase: str) -> list[dict[str, Any]]:
        chain = self.chain
        watched = {proxy.lower(), self.treasury.lower()}
        vault_balance = _balance_of(chain, self.d.c("usdc"), proxy) or 1_000_000
        db = signature_db()
        results: list[dict[str, Any]] = []
        for fn in functions:
            sig = db.function(fn["selector"])
            if sig and sig.state_mutability in ("view", "pure"):
                continue
            inputs = sig.inputs if sig else None
            for caller_role, caller in callers:
                best: dict[str, Any] | None = None
                for args in _arg_variants(inputs, caller, vault_balance):
                    calldata = fn["selector"] + args.hex()
                    snap = chain.snapshot()
                    try:
                        chain.impersonate(caller)
                        chain.set_balance(caller, 10**20)
                        impl_before = _read_slot_address(chain, proxy, EIP1967_IMPL_SLOT)
                        admin_before = _read_slot_address(chain, proxy, EIP1967_ADMIN_SLOT)
                        res = chain.send(caller, proxy, calldata, allow_revert=True, gas=3_000_000)
                        outflows = [
                            t for t in _transfers(res.logs)
                            if t["from"].lower() in watched and t["to"].lower() != self.treasury.lower()
                        ]
                        control_changed = (
                            _read_slot_address(chain, proxy, EIP1967_IMPL_SLOT) != impl_before
                            or _read_slot_address(chain, proxy, EIP1967_ADMIN_SLOT) != admin_before
                        )
                        outcome = {
                            "phase": phase,
                            "function": fn.get("signature") or fn["selector"],
                            "selector": fn["selector"],
                            "caller": caller,
                            "caller_role": caller_role,
                            "caller_label": self.labeler.label(caller),
                            "status": "success" if res.ok else "reverted",
                            "revert": (res.revert or {}).get("name") if not res.ok else None,
                            "outflows": [
                                {**t, "display": f"{format_token(t['amount'], t['token'])} → {self.labeler.describe(t['to'])}"}
                                for t in outflows
                            ],
                            "control_changed": control_changed,
                        }
                    finally:
                        chain.revert_to(snap)
                        if caller not in self.d.accounts.values():
                            chain.stop_impersonating(caller)
                    if best is None or outcome["outflows"] or (outcome["status"] == "success" and best["status"] != "success"):
                        best = outcome
                    if outcome["outflows"] or outcome["control_changed"]:
                        break
                if best:
                    results.append(best)
        return results

    def behaviour_samples(self, proxy: str, functions: list[dict[str, Any]]) -> dict[str, dict[int, str | None]]:
        db = signature_db()
        out: dict[str, dict[int, str | None]] = {}
        for fn in functions:
            sig = db.function(fn["selector"])
            if not sig or sig.state_mutability not in ("view", "pure"):
                continue
            if [i["type"] for i in sig.inputs] != ["uint256"]:
                continue
            values: dict[int, str | None] = {}
            for sample in BEHAVIOUR_SAMPLES:
                res = self.chain.call_raw(proxy, fn["selector"] + abi_encode(["uint256"], [sample]).hex())
                values[sample] = str(int(res["data"], 16)) if res["ok"] else None
            out[sig.signature] = values
        return out

    # ------------------------------------------------------------- main run
    def run(
        self,
        actions: list[Action],
        approved_manifest: dict[str, Any] | None,
        declared_text: str,
        reference_impls: dict[str, str] | None = None,
        extra_callers: list[tuple[str, str]] | None = None,
    ) -> dict[str, Any]:
        chain, L = self.chain, self.labeler
        decoded = [describe_action(a, L) for a in actions]
        for i, d in enumerate(decoded):
            d["index"] = i
        approved_decoded = []
        if approved_manifest:
            approved_decoded = [describe_action(a, L) for a in manifest_actions(approved_manifest)]
            for i, d in enumerate(approved_decoded):
                d["index"] = i

        intents = extract_assertions(declared_text)
        assertions = intents["assertions"] + transfer_assertions(approved_decoded or decoded)
        for i, a in enumerate(assertions, start=1):
            a["id"] = f"IA-{i:02d}"
        self.step("decode", f"Decoded {len(decoded)} action(s); extracted {len(assertions)} checkable intent assertion(s) from the proposal text.")

        holders: set[str] = {self.treasury, self.d.c("fee_vault")}
        for d in decoded:
            holders.add(d["target"])
            for arg in d.get("args", []):
                if arg["type"] == "address":
                    holders.add(arg["value"])
        if self.proposal.recipient_address:
            holders.add(self.proposal.recipient_address)
        holders.add(self.proposal.proposer_address)

        # Upgrade pre-analysis.
        upgrades: list[dict[str, Any]] = []
        for d in decoded:
            if d.get("kind") != "proxy_upgrade":
                continue
            proxy = d["upgrade"]["proxy"]
            new_impl = d["upgrade"]["implementation"]
            old_impl = _read_slot_address(chain, proxy, EIP1967_IMPL_SLOT)
            old_an = bytecode.analyze(chain.get_code(old_impl)) if old_impl else {"selectors": [], "functions": [], "embedded_addresses": []}
            new_an = bytecode.analyze(chain.get_code(new_impl))
            bdiff = bytecode.diff(old_an, new_an)
            known_contracts = {v.lower() for v in self.d.contracts.values()}
            embedded_new = [a for a in bdiff["embedded_addresses_added"] if a.lower() not in known_contracts]
            callers = [("unprivileged account", PROBE_ACCOUNT), ("proposer", self.proposal.proposer_address)]
            callers += [("address embedded in new code", a) for a in embedded_new]
            # Extra callers (e.g. from a comparison run) so two implementations are probed by the same accounts.
            seen = {a.lower() for _, a in callers}
            callers += [(r, a) for r, a in (extra_callers or []) if a.lower() not in seen and not seen.add(a.lower())]
            holders.update(embedded_new)
            upgrades.append(
                {
                    "action_index": d["index"],
                    "proxy": proxy,
                    "proxy_label": L.label(proxy),
                    "old_implementation": old_impl,
                    "old_label": L.label(old_impl) if old_impl else None,
                    "new_implementation": new_impl,
                    "new_label": L.label(new_impl),
                    "old_analysis": old_an,
                    "new_analysis": new_an,
                    "bytecode_diff": bdiff,
                    "embedded_unknown": embedded_new,
                    "callers": [{"role": r, "address": a, "label": L.label(a)} for r, a in callers],
                    "probes_before": self.probe(proxy, old_an["functions"], callers, "before") if old_impl else [],
                    "samples_before": self.behaviour_samples(proxy, old_an["functions"]),
                    "state_before": _vault_views(chain, proxy),
                    "admin_before": _read_slot_address(chain, proxy, EIP1967_ADMIN_SLOT),
                    "reference_implementation": (reference_impls or {}).get(proxy.lower()),
                }
            )
            self.step("bytecode", f"Upgrade of {L.label(proxy) or proxy}: new code has {len(new_an['selectors'])} entry points"
                      + (f" and hard-codes {len(embedded_new)} unknown address(es)" if embedded_new else "") + f"; ran {len(upgrades[-1]['probes_before'])} baseline probes.",
                      "warning" if embedded_new else "info")
            if not new_an.get("size"):
                self.finding("SIM-R011", "critical", "Upgrade target has no code",
                             f"The new implementation {L.describe(new_impl)} has no deployed bytecode. The upgrade would brick the contract.")

        def snapshot_balances() -> dict[tuple[str, str], int]:
            return {(h, t): _balance_of(chain, t, h) for h in holders for t in self.tokens}

        proxy_admin = self.d.c("proxy_admin")
        before_bal = snapshot_balances()
        before_admin_owner = _owner_of(chain, proxy_admin)

        # Execute the submitted actions exactly as the guard would.
        self.step("execute", f"Executing {len(actions)} action(s) as the ExecutionGuard (impersonated) on the snapshot.")
        chain.impersonate(self.treasury)
        chain.set_balance(self.treasury, 10**21)
        action_results: list[dict[str, Any]] = []
        all_logs: list[dict[str, Any]] = []
        try:
            for a, d in zip(actions, decoded):
                if a.operation != 0:
                    action_results.append({"index": d["index"], "description": d["human_readable"], "status": "not_executed",
                                           "reason": "DELEGATECALL: the guard never performs it, so it cannot run."})
                    continue
                res = chain.send(self.treasury, a.target, a.data, a.value, allow_revert=True, gas=6_000_000)
                all_logs.extend(res.logs)
                action_results.append(
                    {
                        "index": d["index"],
                        "description": d["human_readable"],
                        "status": "success" if res.ok else "reverted",
                        "gas_used": res.gas_used,
                        "revert": res.revert,
                        "events": _event_summary(res.logs, L),
                    }
                )
                if not res.ok:
                    self.finding("SIM-R004", "high", f"Action #{d['index'] + 1} reverts",
                                 f"{d['human_readable']} reverted in simulation: {(res.revert or {}).get('explanation', 'no reason')}. "
                                 "Execution through the guard would fail as a whole.", res.revert)
        finally:
            chain.stop_impersonating(self.treasury)
        reverted = sum(1 for r in action_results if r["status"] == "reverted")
        self.step("execute", f"{len(action_results) - reverted} action(s) succeeded" + (f", {reverted} reverted" if reverted else "") + ".",
                  "warning" if reverted else "success")

        after_bal = snapshot_balances()
        after_admin_owner = _owner_of(chain, proxy_admin)
        balance_changes = []
        for (h, t), before in before_bal.items():
            after = after_bal[(h, t)]
            if after != before:
                balance_changes.append(
                    {
                        "holder": h,
                        "holder_label": L.label(h),
                        "token": t,
                        "token_symbol": "mUSDC" if t == self.d.c("usdc") else "ATLAS",
                        "before": str(before),
                        "after": str(after),
                        "delta": str(after - before),
                        "display": f"{'+' if after > before else '−'}{format_token(abs(after - before), t)}",
                    }
                )

        state_changes: list[dict[str, Any]] = []
        if before_admin_owner != after_admin_owner:
            state_changes.append({"what": "ProxyAdmin owner", "before": before_admin_owner, "after": after_admin_owner})

        # Post-upgrade analysis.
        for up in upgrades:
            proxy = up["proxy"]
            current_impl = _read_slot_address(chain, proxy, EIP1967_IMPL_SLOT)
            up["implementation_after"] = current_impl
            up["admin_after"] = _read_slot_address(chain, proxy, EIP1967_ADMIN_SLOT)
            up["state_after"] = _vault_views(chain, proxy)
            if current_impl != up["old_implementation"]:
                state_changes.append({"what": f"{up['proxy_label'] or proxy} implementation", "before": up["old_implementation"], "after": current_impl})
            if up["admin_after"] != up["admin_before"]:
                state_changes.append({"what": f"{up['proxy_label'] or proxy} admin", "before": up["admin_before"], "after": up["admin_after"]})
            for key, before_val in up["state_before"].items():
                after_val = up["state_after"].get(key)
                if key not in ("version",) and before_val != after_val:
                    state_changes.append({"what": f"{up['proxy_label'] or proxy}.{key}()", "before": before_val, "after": after_val})
            up["probes_after"] = self.probe(proxy, up["new_analysis"]["functions"], [(c["role"], c["address"]) for c in up["callers"]], "after")
            up["samples_after"] = self.behaviour_samples(proxy, up["new_analysis"]["functions"])
            before_caps = {(p["caller"].lower(), p["function"]) for p in up["probes_before"] if p["outflows"] or p["control_changed"]}
            up["new_capabilities"] = [
                p for p in up["probes_after"]
                if (p["outflows"] or p["control_changed"]) and (p["caller"].lower(), p["function"]) not in before_caps
            ]
            self.step("probe", f"Re-probed the upgraded code with {len(up['callers'])} caller(s): "
                      + (f"{len(up['new_capabilities'])} new way(s) to move funds or change control." if up["new_capabilities"] else "no new fund-moving capability."),
                      "failure" if up["new_capabilities"] else "success")
            behaviour_diff = []
            for fn_sig, after_vals in up["samples_after"].items():
                before_vals = up["samples_before"].get(fn_sig)
                if not before_vals:
                    continue
                for sample, new_val in after_vals.items():
                    old_val = before_vals.get(sample)
                    if old_val != new_val:
                        behaviour_diff.append({"function": fn_sig, "input": str(sample), "old": old_val, "new": new_val})
            up["behaviour_diff"] = behaviour_diff
            up["reference"] = self._reference_comparison(up)
            self._upgrade_findings(up, intents["declared_functions"])

        # Execution-level outflow checks against the approved decision.
        approved_transfers = [
            (d["token_address"].lower(), str(d["expected_recipient"]).lower(), str(d["expected_amount_base"]))
            for d in (approved_decoded or [])
            if d.get("kind") == "erc20_transfer"
        ]
        observed_transfers = _transfers(all_logs)
        for t in observed_transfers:
            if t["from"].lower() not in (self.treasury.lower(), self.d.c("fee_vault").lower()):
                continue
            if t["to"].lower() == self.treasury.lower():
                continue
            if approved_manifest is not None and (t["token"].lower(), t["to"].lower(), t["amount"]) not in approved_transfers:
                self.finding("SIM-R007", "critical", "Funds move somewhere the decision did not approve",
                             f"Executing this payload sends {format_token(t['amount'], t['token'])} from "
                             f"{L.describe(t['from'])} to {L.describe(t['to'])}, which does not match any approved transfer.",
                             t)
        for ap in _approvals(all_logs):
            if ap["owner"].lower() == self.treasury.lower() and int(ap["amount"]) > 0:
                approved_allowance = any(d.get("kind") == "erc20_approve" for d in approved_decoded)
                if not approved_allowance:
                    self.finding("SIM-R008", "high", "Treasury allowance granted",
                                 f"The payload lets {L.describe(ap['spender'])} spend {format_token(ap['amount'], ap['token'])} "
                                 "of treasury funds at any later time, without another vote.", ap)

        evaluated = [self._evaluate(a, upgrades, balance_changes, observed_transfers, state_changes) for a in assertions]
        violated = sum(1 for a in evaluated if a["status"] == "violated")
        self.step("intent", f"Checked {len(evaluated)} intent assertion(s) against observed behaviour: "
                  + (f"{violated} contradicted." if violated else "none contradicted."), "failure" if violated else "success")

        for a in evaluated:
            if a["status"] == "violated":
                self.finding(f"SIM-IA-{a['kind']}", "critical" if a["kind"] in ("CUSTODY_UNCHANGED", "FUNCTION_MOVES_NO_FUNDS", "EXACT_TRANSFER", "OWNERSHIP_UNCHANGED") else "high",
                             f"Declared intent contradicted: {a['claim']}",
                             f"The proposal states “{a['quote']}”, but simulation shows: {a['evidence_text']}", {"assertion": a["id"]})

        self.findings.sort(key=lambda f: SEV_RANK.get(f["severity"], 9))
        if any(f["severity"] == "critical" for f in self.findings):
            verdict = "block"
        elif any(f["severity"] in ("high", "medium") for f in self.findings):
            verdict = "flag"
        else:
            verdict = "pass"
        summary = self._summary(verdict, evaluated, upgrades, balance_changes)
        return {
            "engine": "Local Hardhat node: evm_snapshot → execute as ExecutionGuard (impersonated) → differential probes → evm_revert",
            "verdict": verdict,
            "summary": summary,
            "actions": action_results,
            "decoded_actions": decoded,
            "balance_changes": balance_changes,
            "state_changes": state_changes,
            "upgrades": upgrades,
            "intent": {"method": intents["method"], "declared_functions": intents["declared_functions"], "assertions": evaluated},
            "findings": self.findings,
            "limitations": LIMITATIONS,
        }

    def _reference_comparison(self, up: dict[str, Any]) -> dict[str, Any] | None:
        """Compare the submitted implementation with the one reviewed in an earlier version."""
        ref = up.get("reference_implementation")
        if not ref:
            return None
        L, chain = self.labeler, self.chain
        if ref.lower() == up["new_implementation"].lower():
            return {"implementation": ref, "label": L.label(ref), "identical": True, "selectors_added": [], "selectors_removed": [],
                    "embedded_added": [], "behaviour_diff": [], "capabilities_added": [], "probes": []}
        ref_an = bytecode.analyze(chain.get_code(ref))
        sdiff = bytecode.diff(ref_an, up["new_analysis"])
        proxy = up["proxy"]
        selector = "0x" + keccak(text="upgradeAndCall(address,address,bytes)")[:4].hex()
        upgrade_data = selector + abi_encode(["address", "address", "bytes"], [proxy, ref, b""]).hex()
        snap = chain.snapshot()
        try:
            chain.impersonate(self.treasury)
            chain.set_balance(self.treasury, 10**21)
            chain.send(self.treasury, self.d.c("proxy_admin"), upgrade_data, allow_revert=True, gas=1_000_000)
            chain.stop_impersonating(self.treasury)
            ref_probes = self.probe(proxy, ref_an["functions"], [(c["role"], c["address"]) for c in up["callers"]], "reviewed")
            ref_samples = self.behaviour_samples(proxy, ref_an["functions"])
        finally:
            chain.revert_to(snap)
        ref_caps = {(p["caller"].lower(), p["function"]) for p in ref_probes if p["outflows"] or p["control_changed"]}
        caps_added = [p for p in up["probes_after"]
                      if (p["outflows"] or p["control_changed"]) and (p["caller"].lower(), p["function"]) not in ref_caps]
        behaviour = []
        for fn_sig, new_vals in up["samples_after"].items():
            if fn_sig not in ref_samples:
                continue
            for sample, val in new_vals.items():
                if ref_samples[fn_sig].get(sample) != val:
                    behaviour.append({"function": fn_sig, "input": str(sample), "reviewed": ref_samples[fn_sig].get(sample), "submitted": val})
        return {
            "implementation": ref,
            "label": L.label(ref),
            "identical": False,
            "codehash_reviewed": ref_an.get("codehash"),
            "codehash_submitted": up["new_analysis"].get("codehash"),
            "selectors_added": sdiff["selectors_added"],
            "selectors_removed": sdiff["selectors_removed"],
            "embedded_added": sdiff["embedded_addresses_added"],
            "behaviour_diff": behaviour,
            "capabilities_added": caps_added,
            "probes": ref_probes,
        }

    def _upgrade_findings(self, up: dict[str, Any], declared_functions: list[str]) -> None:
        L = self.labeler
        bdiff = up["bytecode_diff"]
        for fn in bdiff["selectors_added"]:
            name = (fn.get("signature") or "").split("(")[0]
            if not name or name not in declared_functions:
                self.finding("SIM-R001", "high", "Undeclared external function",
                             f"The new implementation adds {fn.get('signature') or fn['selector']} which the proposal text never mentions.",
                             fn)
        for addr in up["embedded_unknown"]:
            linked = self._proposer_link(addr)
            self.finding("SIM-R002", "high", "Address hard-coded in new bytecode",
                         f"The new implementation embeds {L.describe(addr)} as a constant. The proposal does not reference this address."
                         + (f" On-chain history links it to the proposer: {linked['display']}." if linked else ""),
                         {"address": addr, "proposer_link": linked})
            if linked:
                self.finding("SIM-R010", "high", "Embedded address connected to the proposer",
                             f"{L.describe(addr)} received funds from the proposer before this upgrade was proposed "
                             f"({linked['display']}). This is an observed transfer, not proof of common ownership.",
                             linked)
        for op, why in bdiff["risky_opcodes_introduced"].items():
            self.finding("SIM-R003", "high", f"{op} introduced", f"The new code contains {op}, which {why}; the old code did not.", {"opcode": op})
        for cap in up["new_capabilities"]:
            if cap["outflows"]:
                moved = "; ".join(o["display"] for o in cap["outflows"])
                self.finding("SIM-R005", "critical", "New path for non-governance funds movement",
                             f"After the upgrade, {cap['caller_role']} {L.describe(cap['caller'])} can call {cap['function']} and move "
                             f"{moved}. Before the upgrade the same call moved nothing.", cap)
            if cap["control_changed"]:
                self.finding("SIM-R006", "critical", "Non-governance control change",
                             f"After the upgrade, {L.describe(cap['caller'])} can change the proxy's implementation or admin via {cap['function']}.", cap)
        if up["admin_after"] != up["admin_before"]:
            self.finding("SIM-R006", "critical", "Proxy admin changed by upgrade",
                         f"The upgrade changes the proxy admin from {L.describe(up['admin_before'])} to {L.describe(up['admin_after'])}.")
        for key in ("feeBps", "treasury", "asset"):
            if up["state_before"].get(key) != up["state_after"].get(key):
                self.finding("SIM-R009", "medium", f"Stored parameter {key} changed",
                             f"{key}() reads {up['state_before'].get(key)} before and {up['state_after'].get(key)} after the upgrade, "
                             "which suggests a storage layout change.")

    def _proposer_link(self, addr: str) -> dict[str, Any] | None:
        proposer = self.proposal.proposer_address
        topics = [TRANSFER_TOPIC, "0x" + "00" * 12 + proposer[2:].lower(), "0x" + "00" * 12 + addr[2:].lower()]
        logs = self.chain.get_logs(self.d.c("usdc"), topics, 0)
        if not logs:
            return None
        first = logs[0]
        return {
            "tx_hash": first["tx_hash"],
            "block_number": first["block_number"],
            "amount": first["args"]["value"],
            "display": f"{format_token(first['args']['value'], self.d.c('usdc'))} from {self.labeler.describe(proposer)} "
                       f"in block {first['block_number']} (tx {first['tx_hash'][:10]}…)",
        }

    def _evaluate(self, a: dict[str, Any], upgrades: list[dict[str, Any]], balance_changes: list[dict[str, Any]],
                  transfers: list[dict[str, Any]], state_changes: list[dict[str, Any]]) -> dict[str, Any]:
        L = self.labeler
        out = {**a, "status": "not_tested", "evidence_text": "No simulation evidence applies to this statement."}
        kind = a["kind"]
        caps = [c for up in upgrades for c in up.get("new_capabilities", [])]
        fund_caps = [c for c in caps if c["outflows"]]
        if kind == "CUSTODY_UNCHANGED":
            if fund_caps:
                c = fund_caps[0]
                out.update(status="violated", evidence_text=f"{L.describe(c['caller'])} can call {c['function']} and move {c['outflows'][0]['display']}.")
            elif upgrades:
                out.update(status="consistent", evidence_text="No probed caller gained a way to move vault or treasury funds.")
        elif kind == "FUNCTION_MOVES_NO_FUNDS":
            fn = a["params"]["function"]
            moving = [p for up in upgrades for p in up.get("probes_after", []) if p["function"].startswith(fn + "(") and p["outflows"]]
            called = [p for up in upgrades for p in up.get("probes_after", []) if p["function"].startswith(fn + "(")]
            if moving:
                p = moving[0]
                out.update(status="violated", evidence_text=f"Calling {p['function']} as {L.describe(p['caller'])} moved {p['outflows'][0]['display']}.")
            elif called:
                out.update(status="consistent", evidence_text=f"{len(called)} probe call(s) to {fn} moved no funds.")
            else:
                out.update(status="not_tested", evidence_text=f"{fn} was not found in the new implementation's dispatcher.")
        elif kind == "OWNERSHIP_UNCHANGED":
            control = [s for s in state_changes if "admin" in s["what"].lower() or "owner" in s["what"].lower()]
            ctl_caps = [c for c in caps if c["control_changed"]]
            if control or ctl_caps:
                out.update(status="violated", evidence_text="; ".join(f"{s['what']}: {s['before']} → {s['after']}" for s in control) or "a probed caller can change control.")
            elif upgrades:
                out.update(status="consistent", evidence_text="Proxy admin and ProxyAdmin owner are unchanged after execution.")
        elif kind == "NO_NEW_PRIVILEGES":
            embedded = [addr for up in upgrades for addr in up["embedded_unknown"]]
            if caps or embedded:
                detail = []
                if caps:
                    detail.append(f"{L.describe(caps[0]['caller'])} gains a capability via {caps[0]['function']}")
                if embedded:
                    detail.append(f"new code hard-codes {', '.join(L.describe(e) for e in embedded)}")
                out.update(status="violated", evidence_text="; ".join(detail) + ".")
            elif upgrades:
                out.update(status="consistent", evidence_text="No caller-specific capability or new embedded address was observed.")
        elif kind == "NO_FUNCTIONAL_CHANGE" and any(up.get("reference") for up in upgrades):
            parts = []
            for up in upgrades:
                ref = up.get("reference")
                if not ref or ref["identical"]:
                    continue
                if ref["selectors_added"] or ref["selectors_removed"]:
                    parts.append("dispatcher functions differ from the reviewed implementation")
                if ref["embedded_added"]:
                    parts.append(f"the new code hard-codes {', '.join(L.describe(a) for a in ref['embedded_added'])}, absent from the reviewed code")
                if ref["behaviour_diff"]:
                    bd = ref["behaviour_diff"][0]
                    parts.append(f"{bd['function']}({bd['input']}) returns {bd['submitted']} instead of {bd['reviewed']}")
                for cap in ref["capabilities_added"][:1]:
                    moved = f" and move {cap['outflows'][0]['display']}" if cap["outflows"] else ""
                    parts.append(f"{L.describe(cap['caller'])} can call {cap['function']}{moved}, which the reviewed implementation did not allow")
            if parts:
                out.update(status="violated", evidence_text="Compared with the reviewed implementation: " + "; ".join(parts) + ".")
            else:
                same = all(up["reference"]["identical"] for up in upgrades if up.get("reference"))
                out.update(status="consistent", evidence_text="Byte-identical to the reviewed implementation." if same else
                           "Same functions, embedded addresses, sampled outputs and caller capabilities as the reviewed implementation.")
        elif kind == "NO_FUNCTIONAL_CHANGE":
            diffs = [d for up in upgrades for d in up.get("behaviour_diff", [])]
            added = [f for up in upgrades for f in up["bytecode_diff"]["selectors_added"]]
            removed = [f for up in upgrades for f in up["bytecode_diff"]["selectors_removed"]]
            if diffs or added or removed or caps:
                parts = []
                if added:
                    parts.append(f"functions added: {', '.join(f.get('signature') or f['selector'] for f in added)}")
                if removed:
                    parts.append(f"functions removed: {', '.join(f.get('signature') or f['selector'] for f in removed)}")
                if diffs:
                    parts.append(f"{diffs[0]['function']}({diffs[0]['input']}) returns {diffs[0]['new']} instead of {diffs[0]['old']}")
                if caps:
                    parts.append(f"{L.describe(caps[0]['caller'])} gains a capability via {caps[0]['function']}")
                out.update(status="violated", evidence_text="; ".join(parts) + ".")
            elif upgrades:
                out.update(status="consistent", evidence_text="Same dispatcher functions and identical sampled outputs.")
        elif kind == "FEE_ROUNDING_HALF_UP":
            diffs = [d for up in upgrades for d in up.get("behaviour_diff", []) if d["function"].startswith("quoteFee")]
            if diffs:
                out.update(status="consistent", evidence_text=f"quoteFee({diffs[0]['input']}) changes from {diffs[0]['old']} to {diffs[0]['new']}, consistent with half-up rounding.")
            elif upgrades:
                out.update(status="violated", evidence_text="Sampled quoteFee outputs are unchanged, so rounding behaviour did not change.")
        elif kind == "EXACT_TRANSFER":
            p = a["params"]
            hit = [t for t in transfers if t["token"].lower() == p["token"].lower() and t["to"].lower() == p["recipient"].lower() and t["amount"] == p["amount"]]
            if hit:
                out.update(status="consistent", evidence_text=f"Observed exactly {format_token(p['amount'], p['token'])} to {L.describe(p['recipient'])}.")
            elif transfers:
                t = transfers[0]
                out.update(status="violated", evidence_text=f"Observed {format_token(t['amount'], t['token'])} to {L.describe(t['to'])} instead.")
            else:
                out.update(status="violated", evidence_text="No matching transfer was observed.")
        return out

    def _summary(self, verdict: str, evaluated: list[dict[str, Any]], upgrades: list[dict[str, Any]], balance_changes: list[dict[str, Any]]) -> str:
        violated = [a for a in evaluated if a["status"] == "violated"]
        if verdict == "block":
            lead = "Simulation contradicts what the community was told."
        elif verdict == "flag":
            lead = "Simulation found issues that need review before execution."
        else:
            lead = "Simulation observed behaviour consistent with the declared intent."
        parts = [lead]
        if violated:
            parts.append(f"{len(violated)} declared statement(s) contradicted, e.g. “{violated[0]['quote']}”: {violated[0]['evidence_text']}")
        if upgrades:
            caps = sum(len(u.get("new_capabilities", [])) for u in upgrades)
            parts.append(f"{len(upgrades)} upgrade(s) analysed; {caps} new caller capability(ies) appeared after upgrade.")
        if balance_changes:
            parts.append(f"{len(balance_changes)} balance change(s) during execution.")
        return " ".join(parts)


def reviewed_implementations(proposal: Proposal, version: int | None, actions: list[Action]) -> dict[str, str]:
    """proxy → implementation from the most recent earlier committed version: the code reviewers
    actually looked at. Only earlier versions count, so v1 has no reference."""
    from .decoder import decode_calldata

    proxies = set()
    for a in actions:
        dec = decode_calldata(a.data)
        if dec.get("signature") == "upgradeAndCall(address,address,bytes)":
            proxies.add(str(dec["args"][0]["value"]).lower())
    refs: dict[str, str] = {}
    for v in sorted(proposal.versions, key=lambda x: x.version):
        if version is not None and v.version >= version:
            continue
        for act in v.manifest.get("actions", []):
            up = act.get("upgrade") or {}
            proxy = str(up.get("proxy", "")).lower()
            if proxy in proxies and up.get("implementation"):
                refs[proxy] = up["implementation"]
    return refs


def run_simulation(
    db: Session,
    proposal: Proposal,
    *,
    actions: list[Action],
    approved_manifest: dict[str, Any] | None,
    declared_text: str,
    version: int | None,
    manifest_hash: str | None,
    scenario: str | None,
    trigger: str = "manual",
    reference_impls: dict[str, str] | None = None,
    extra_callers: list[tuple[str, str]] | None = None,
) -> Simulation:
    deployment = runtime.require_deployment()
    chain = runtime.chain
    sim = Simulation(
        id=new_id("SIM"),
        proposal_id=proposal.id,
        version=version,
        scenario=scenario,
        trigger=trigger,
        manifest_hash=manifest_hash,
        status="running",
        verdict="error",
        started_at=utcnow(),
    )
    with chain.lock:
        sim.chain_block = chain.block_number()
        snap = chain.snapshot()
        live.activity(proposal.id, "snapshot", f"Snapshot of the chain at block {sim.chain_block}; nothing below touches real state.", simulation_id=sim.id)
        try:
            refs = reference_impls if reference_impls is not None else reviewed_implementations(proposal, version, actions)
            report = _Sim(db, deployment, proposal, sim.id).run(actions, approved_manifest, declared_text, refs, extra_callers)
            sim.status, sim.verdict, sim.report = "completed", report["verdict"], report
        except Exception as exc:  # report failure explicitly; never claim a pass
            log.exception("simulation failed for %s", proposal.id)
            sim.status, sim.verdict = "failed", "error"
            sim.report = {"error": f"{type(exc).__name__}: {exc}", "limitations": LIMITATIONS, "findings": []}
        finally:
            if not chain.revert_to(snap):
                log.error("evm_revert to %s failed; chain state may include simulation effects", snap)
    live.activity(proposal.id, "verdict", f"Verdict {sim.verdict.upper()}. Chain reverted to block {sim.chain_block}.",
                  {"pass": "success", "flag": "warning", "block": "failure"}.get(sim.verdict, "failure"), simulation_id=sim.id, verdict=sim.verdict)
    sim.finished_at = utcnow()
    db.add(sim)
    db.commit()
    return sim


def serialize(sim: Simulation) -> dict[str, Any]:
    from ..clock import iso

    return {
        "id": sim.id,
        "proposal_id": sim.proposal_id,
        "version": sim.version,
        "scenario": sim.scenario,
        "trigger": sim.trigger,
        "manifest_hash": sim.manifest_hash,
        "status": sim.status,
        "verdict": sim.verdict,
        "chain_block": sim.chain_block,
        "started_at": iso(sim.started_at),
        "finished_at": iso(sim.finished_at),
        "report": sim.report,
    }


def _comparison_side(sim: Simulation) -> dict[str, Any]:
    report = sim.report or {}
    up = (report.get("upgrades") or [None])[0] or {}
    new = up.get("new_analysis") or {}
    probes = up.get("probes_after") or []
    return {
        "simulation_id": sim.id,
        "status": sim.status,
        "verdict": sim.verdict,
        "error": report.get("error"),
        "start_block": sim.chain_block,
        "summary": report.get("summary"),
        "implementation": up.get("new_implementation"),
        "implementation_label": up.get("new_label"),
        "codehash": new.get("codehash"),
        "code_size": new.get("size"),
        "embedded_unknown": up.get("embedded_unknown") or [],
        "vault": up.get("proxy"),
        "vault_label": up.get("proxy_label"),
        "upgrade_status": next((a["status"] for a in report.get("actions", []) if a.get("index") == up.get("action_index")), None),
        "callers": up.get("callers") or [],
        "probes": probes,
        "fund_moving_probes": [p for p in probes if p.get("outflows")],
        "control_probes": [p for p in probes if p.get("control_changed")],
        "balance_changes": report.get("balance_changes", []),
        "findings": report.get("findings", []),
        "assertions": (report.get("intent") or {}).get("assertions", []),
        "limitations": report.get("limitations", LIMITATIONS),
    }


def _first_divergence(sub: dict[str, Any], rev: dict[str, Any]) -> dict[str, Any] | None:
    """First probe (same caller, same function) whose observed outcome differs, fund movement first."""
    reviewed = {(p["caller"].lower(), p["function"]): p for p in rev["probes"]}
    candidates = []
    for order, p in enumerate(sub["probes"]):
        other = reviewed.get((p["caller"].lower(), p["function"]))
        moved, other_moved = bool(p.get("outflows")), bool(other and other.get("outflows"))
        control, other_control = bool(p.get("control_changed")), bool(other and other.get("control_changed"))
        if moved != other_moved:
            rank = 0
        elif control != other_control:
            rank = 1
        elif other is None:
            rank = 2
        elif p["status"] != other["status"]:
            rank = 3
        else:
            continue
        candidates.append((rank, order, p, other))
    if not candidates:
        return None
    rank, _, p, other = min(candidates, key=lambda c: (c[0], c[1]))
    kind = ["fund_movement", "control_change", "function_only_in_submitted", "call_status"][rank]
    return {"kind": kind, "function": p["function"], "caller": p["caller"], "caller_role": p["caller_role"], "caller_label": p.get("caller_label"),
            "submitted": p, "reviewed": other}


def compare_upgrade(db: Session, proposal: Proposal) -> dict[str, Any]:
    """Simulate the submitted and the reviewed implementation from the same starting block with the
    same probe callers, each inside its own snapshot (evm_revert after each). No findings are
    changed and the deployed implementation is never switched."""
    from ..errors import Conflict
    from .execution import available_scenarios, scenario_payload
    from .manifests import parse_payload
    from .proposals import approved_version, latest_version
    from .sentinel import declared_text

    if "reviewed_implementation" not in {s["id"] for s in available_scenarios(proposal)}:
        raise Conflict("no_reviewed_implementation", f"{proposal.id} has no earlier reviewed implementation to compare against.")
    basis = approved_version(proposal) or latest_version(proposal)
    text = declared_text(proposal, basis)
    chain = runtime.chain
    with chain.lock:  # nothing else may move the chain between the two runs
        submitted_payload = parse_payload(scenario_payload(proposal, "safe"))
        sub = run_simulation(db, proposal, actions=list(submitted_payload.actions), approved_manifest=basis.manifest, declared_text=text,
                             version=submitted_payload.version, manifest_hash=None, scenario="comparison: submitted implementation",
                             trigger="comparison", reference_impls={})
        sub_up = ((sub.report or {}).get("upgrades") or [{}])[0]
        callers = [("address embedded in the submitted code" if c["role"] == "address embedded in new code" else c["role"], c["address"])
                   for c in sub_up.get("callers", [])]
        vault = sub_up.get("proxy")
        vault_start = _balance_of(chain, runtime.require_deployment().c("usdc"), vault) if vault else None  # snapshot already reverted
        reviewed_payload = parse_payload(scenario_payload(proposal, "reviewed_implementation"))
        rev = run_simulation(db, proposal, actions=list(reviewed_payload.actions), approved_manifest=basis.manifest, declared_text=text,
                             version=reviewed_payload.version, manifest_hash=None, scenario="comparison: reviewed implementation",
                             trigger="comparison", reference_impls={}, extra_callers=callers)
    submitted, reviewed = _comparison_side(sub), _comparison_side(rev)
    both_ok = sub.status == "completed" and rev.status == "completed"
    return {
        "proposal_id": proposal.id,
        "basis_version": basis.version,
        "same_start_block": sub.chain_block == rev.chain_block,
        "start_block": sub.chain_block,
        "vault": vault,
        "vault_label": sub_up.get("proxy_label"),
        "vault_balance_start": str(vault_start) if vault_start is not None else None,
        "vault_balance_start_display": format_token(vault_start, runtime.require_deployment().c("usdc")) if vault_start is not None else None,
        "submitted": submitted,
        "reviewed": reviewed,
        "divergence": _first_divergence(submitted, reviewed) if both_ok else None,
        "note": "Simulation on a local snapshot, reverted after each run. Both sides start from the same block and are probed by the same callers. "
                "No issue observed means none was observed under these probes, not that the code is safe.",
    }
