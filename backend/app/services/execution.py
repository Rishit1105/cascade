"""Execution gateway: demo scenarios, advisory checks, on-chain preflight, guarded execution,
guardian halts and reviewer disputes.

The advisory comparison explains differences; the ExecutionGuard contract decides. Tampered
payloads are deliberately still sent to the contract so the rejection is contract-enforced
and recorded on-chain, never just a dashboard warning.
"""

from __future__ import annotations

import copy
from typing import Any

from eth_abi import encode as abi_encode
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..chain.client import TxReverted
from ..clock import iso
from ..errors import Conflict, NotFound, ValidationFailed
from ..models import ExecutionAttempt, ExecutionCheck, MilestoneTracking, Proposal, new_id
from ..runtime import runtime
from . import audit
from .alerts import raise_alert
from .canonical import content_hash
from .execution_checks import compare
from .labels import Labeler, format_token
from .manifests import PayloadError, manifest_to_payload, parse_payload
from .notifications import notify
from .proposals import approved_version, get_version, latest_version

SCENARIOS: dict[str, dict[str, str]] = {
    "safe": {"label": "Approved payload", "description": "Exactly the manifest governance approved.", "expect": "accepted"},
    "tampered_recipient": {"label": "Changed recipient", "description": "The transfer recipient is swapped for Wallet B.", "expect": "rejected"},
    "changed_amount": {"label": "Changed amount", "description": "The transfer amount is raised by 10%.", "expect": "rejected"},
    "extra_allowance": {"label": "Extra privileged action", "description": "Adds an unlimited mUSDC allowance to an unknown spender.", "expect": "rejected"},
    "missing_action": {"label": "Missing action", "description": "Drops the last approved action from the batch.", "expect": "rejected"},
    "stale_version": {"label": "Stale version", "description": "Submits the payload as an earlier version number.", "expect": "rejected"},
    "wrong_guard": {"label": "Wrong guard context", "description": "Addresses the payload to a different ExecutionGuard deployment.", "expect": "rejected"},
    "wrong_chain": {"label": "Wrong chain", "description": "Payload prepared for chain 1 (Ethereum mainnet).", "expect": "not sent"},
    "reviewed_implementation": {"label": "Reviewed implementation", "description": "The upgrade payload from the version that was reviewed (v1).", "expect": "differs"},
}
UPGRADE_SCENARIOS = ["safe", "reviewed_implementation", "stale_version", "wrong_guard", "wrong_chain"]
TRANSFER_SCENARIOS = ["safe", "tampered_recipient", "changed_amount", "extra_allowance", "missing_action", "stale_version", "wrong_guard", "wrong_chain"]


def _reference_manifest(p: Proposal) -> tuple[dict[str, Any] | None, int | None, str]:
    v = approved_version(p)
    if v:
        return v.manifest, v.version, "approved"
    v = latest_version(p)
    if v:
        return v.manifest, v.version, "latest committed (not yet approved)"
    return None, None, "none"


def available_scenarios(p: Proposal) -> list[dict[str, Any]]:
    manifest, version, basis = _reference_manifest(p)
    if manifest is None:
        return []
    kinds = {a.get("kind") for a in manifest["actions"]}
    keys = UPGRADE_SCENARIOS if "proxy_upgrade" in kinds else TRANSFER_SCENARIOS
    if "proxy_upgrade" in kinds and len(p.versions) < 2:
        keys = [k for k in keys if k != "reviewed_implementation"]
    if len(manifest["actions"]) < 1:
        keys = [k for k in keys if k != "missing_action"]
    return [{"id": k, **SCENARIOS[k], "basis": basis, "version": version} for k in keys]


def scenario_payload(p: Proposal, scenario: str) -> dict[str, Any]:
    deployment = runtime.require_deployment()
    manifest, version, _ = _reference_manifest(p)
    if manifest is None:
        raise Conflict("no_manifest", f"{p.id} has no committed manifest yet.")
    if scenario not in SCENARIOS:
        raise ValidationFailed("unknown_scenario", f"Unknown scenario {scenario}.")
    payload = manifest_to_payload(manifest)
    actions = payload["actions"]
    transfer_idx = next((i for i, a in enumerate(manifest["actions"]) if a.get("kind") == "erc20_transfer"), None)
    if scenario == "tampered_recipient":
        if transfer_idx is None:
            raise Conflict("scenario_unavailable", "This manifest has no transfer to tamper with.")
        a = manifest["actions"][transfer_idx]
        actions[transfer_idx]["data"] = "0xa9059cbb" + abi_encode(["address", "uint256"], [deployment.a("wallet_b"), int(a["expected_amount_base"])]).hex()
    elif scenario == "changed_amount":
        if transfer_idx is None:
            raise Conflict("scenario_unavailable", "This manifest has no transfer amount to change.")
        a = manifest["actions"][transfer_idx]
        amount = int(a["expected_amount_base"]) * 110 // 100
        actions[transfer_idx]["data"] = "0xa9059cbb" + abi_encode(["address", "uint256"], [a["expected_recipient"], amount]).hex()
    elif scenario == "extra_allowance":
        approve = "0x095ea7b3" + abi_encode(["address", "uint256"], [deployment.a("attacker"), 2**256 - 1]).hex()
        actions.append({"target": deployment.c("usdc"), "value": "0", "data": approve, "operation": 0})
    elif scenario == "missing_action":
        actions.pop()
    elif scenario == "stale_version":
        current = version or 1
        payload["version"] = current - 1 if current > 1 else current + 1
    elif scenario == "wrong_guard":
        payload["guard"] = deployment.c("legacy_guard")
    elif scenario == "wrong_chain":
        payload["chain_id"] = 1
    elif scenario == "reviewed_implementation":
        v1 = get_version(p, 1)
        payload = manifest_to_payload(copy.deepcopy(v1.manifest))
        payload["version"] = version
    return payload


def _known_guards() -> dict[str, str]:
    deployment = runtime.require_deployment()
    return {deployment.c("guard").lower(): "guard", deployment.c("legacy_guard").lower(): "legacy_guard"}


def run_check(db: Session, p: Proposal, raw_payload: dict[str, Any], scenario: str | None, actor: str, source: str = "ui") -> ExecutionCheck:
    deployment = runtime.require_deployment()
    try:
        payload = parse_payload(raw_payload)
    except PayloadError as exc:
        raise ValidationFailed("invalid_payload", str(exc), {"path": exc.path}) from exc
    labeler = Labeler(db)
    av = approved_version(p)
    result = compare(av.manifest if av else None, payload, labeler, db)

    preflight: dict[str, Any] = {"performed": False}
    if payload.chain_id != deployment.chain_id:
        preflight = {"performed": False, "reason": f"Payload is for chain {payload.chain_id}; the connected node is chain {deployment.chain_id}."}
    elif payload.guard.lower() not in _known_guards():
        preflight = {"performed": False, "reason": "Payload is addressed to an unknown contract, not an ExecutionGuard deployment."}
    else:
        guard = runtime.chain.contract("ExecutionGuard", payload.guard)
        res = runtime.chain.call_fn(guard, "preflight", [bytes.fromhex(payload.proposal_key[2:]), payload.version, [a.as_tuple() for a in payload.actions]])
        preflight = {
            "performed": True,
            "guard": payload.guard,
            "would_execute": res["ok"],
            "contract_hash": "0x" + res["value"][0].hex() if res["ok"] else None,
            "revert": res.get("revert"),
            "note": "eth_call to ExecutionGuard.preflight(): the same checks execute() enforces, without sending a transaction.",
        }
    check = ExecutionCheck(
        id=new_id("XC"),
        proposal_id=p.id,
        version=payload.version,
        scenario=scenario,
        status=result["status"],
        approved_manifest_hash=result["approved_manifest_hash"],
        submitted_manifest_hash=result["submitted_manifest_hash"],
        approved_manifest=av.manifest if av else None,
        submitted_payload=payload.as_dict(),
        submitted_decoded=result["submitted_decoded"],
        discrepancies=result["discrepancies"],
        preflight={**preflight, "alignment": result["alignment"], "summary": result["summary"], "approved_decoded": result.get("approved_decoded", [])},
        actor=actor,
    )
    db.add(check)
    db.commit()
    audit.record(
        event_type="execution_check",
        summary=f"Preflight check of a submitted payload for {p.id}: {result['status']}"
                + (f" ({len(result['discrepancies'])} discrepancy finding(s))." if result["discrepancies"] else ".")
                + (" Contract preflight: would " + ("execute." if preflight.get("would_execute") else f"revert with {preflight.get('revert', {}).get('name')}.") if preflight.get("performed") else ""),
        actor=actor,
        source=source,
        status="success" if result["status"] == "MATCH" else "failure" if result["status"] == "MISMATCH" else "warning",
        proposal_id=p.id,
        version=payload.version,
        manifest_hash=result["submitted_manifest_hash"],
        details={"check_id": check.id, "scenario": scenario, "rules": [d["rule_id"] for d in result["discrepancies"]], "advisory": True},
    )
    return check


def _balances(holders: list[str]) -> dict[str, int]:
    deployment = runtime.require_deployment()
    usdc = runtime.chain.contract("MockUSDC", deployment.c("usdc"))
    return {h: int(usdc.functions.balanceOf(h).call()) for h in holders}


def execute(db: Session, p: Proposal, raw_payload: dict[str, Any], scenario: str | None, actor: str, source: str = "ui") -> ExecutionAttempt:
    deployment = runtime.require_deployment()
    labeler = Labeler(db)
    check = run_check(db, p, raw_payload, scenario, actor, source)
    payload = parse_payload(raw_payload)
    base = dict(id=new_id("EA"), proposal_id=p.id, version=payload.version, check_id=check.id, scenario=scenario,
                submitted_manifest_hash=check.submitted_manifest_hash, actor=actor)

    refusal = None
    if payload.chain_id != deployment.chain_id:
        refusal = f"Not sent: the payload targets chain {payload.chain_id} but the connected node is chain {deployment.chain_id}. A transaction signed for one chain cannot execute on another."
    elif payload.guard.lower() not in _known_guards():
        refusal = "Not sent: the payload is addressed to a contract that is not an ExecutionGuard."
    if refusal:
        attempt = ExecutionAttempt(**base, outcome="not_sent", revert={"name": "NotSent", "explanation": refusal, "args": {}})
        db.add(attempt)
        db.commit()
        audit.record(event_type="execution_not_sent", summary=f"{p.id}: {refusal}", actor=actor, source=source, status="warning",
                     proposal_id=p.id, version=payload.version, manifest_hash=check.submitted_manifest_hash,
                     details={"attempt_id": attempt.id, "scenario": scenario, "enforcement": "gateway refusal (off-chain, not contract-enforced)"})
        return attempt

    holders = {deployment.c("guard")}
    for d in check.submitted_decoded:
        if d.get("expected_recipient"):
            holders.add(d["expected_recipient"])
    holders_list = sorted(holders)
    before = _balances(holders_list)
    guard = runtime.chain.contract("ExecutionGuard", payload.guard)
    tx = runtime.chain.transact(
        guard,
        "execute",
        [bytes.fromhex(payload.proposal_key[2:]), payload.version, [a.as_tuple() for a in payload.actions]],
        deployment.a("executor"),
        allow_revert=True,
        gas=3_000_000,
    )
    after = _balances(holders_list)
    changes = [
        {"holder": h, "holder_label": labeler.label(h), "before": str(before[h]), "after": str(after[h]), "delta": str(after[h] - before[h]),
         "display": f"{'+' if after[h] > before[h] else '−'}{format_token(abs(after[h] - before[h]), deployment.c('usdc'))}"}
        for h in holders_list if after[h] != before[h]
    ]
    attempt = ExecutionAttempt(**base, outcome="executed" if tx.ok else "rejected", tx_hash=tx.tx_hash, block_number=tx.block_number,
                               revert=tx.revert, balance_changes=changes)
    db.add(attempt)
    v = None
    if tx.ok:
        try:
            v = get_version(p, payload.version)
            v.governance_status = "executed"
        except NotFound:
            pass
        p.status = "executed"
        for i, _ in enumerate(p.milestones or []):
            if not db.scalars(select(MilestoneTracking).where(MilestoneTracking.proposal_id == p.id, MilestoneTracking.index == i)).first():
                db.add(MilestoneTracking(proposal_id=p.id, index=i, status="pending", updated_by="DAOGuard"))
    db.commit()

    if tx.ok:
        moved = "; ".join(f"{c['holder_label'] or c['holder']}: {c['display']}" for c in changes)
        audit.record(event_type="execution_succeeded", summary=f"ExecutionGuard executed {p.id} v{payload.version}. {moved}",
                     actor="Ops executor (demo)", source=source, status="success", proposal_id=p.id, version=payload.version,
                     manifest_hash=check.submitted_manifest_hash, tx=tx,
                     details={"attempt_id": attempt.id, "scenario": scenario, "balance_changes": changes, "requested_by": actor})
        notify(db, "success", f"{p.id} executed through the guard", f"Manifest {check.submitted_manifest_hash[:12]}… matched the approval.", f"/audit?proposal={p.id}")
    else:
        reason = (tx.revert or {}).get("name", "Reverted")
        audit.record(event_type="execution_rejected",
                     summary=f"ExecutionGuard REJECTED a payload for {p.id} ({reason}). The transaction reverted on-chain; no funds or permissions changed.",
                     actor="Ops executor (demo)", source=source, status="failure", proposal_id=p.id, version=payload.version,
                     manifest_hash=check.submitted_manifest_hash, tx=tx,
                     details={"attempt_id": attempt.id, "scenario": scenario, "revert": tx.revert, "enforcement": "contract-enforced", "requested_by": actor,
                              "advisory_rules": [d["rule_id"] for d in check.discrepancies]})
        raise_alert(db, proposal_id=p.id, source="execution", severity="critical",
                    title=f"Blocked execution attempt on {p.id}: {reason}",
                    description=(tx.revert or {}).get("explanation", "The guard reverted the attempt."),
                    data={"attempt_id": attempt.id, "tx_hash": tx.tx_hash, "block_number": tx.block_number, "check_id": check.id, "scenario": scenario})
        # The rejected payload is an attempt, not a property of the approved proposal: it is recorded
        # as an alert and an execution attempt, not as a finding against the proposal.
        notify(db, "critical", f"Guard rejected a payload for {p.id}", (tx.revert or {}).get("explanation", ""), f"/guardian?proposal={p.id}")
    db.commit()
    return attempt


def halt(db: Session, p: Proposal, reason: str, actor: str, source: str = "ui", reason_data: dict[str, Any] | None = None) -> dict[str, Any]:
    deployment = runtime.require_deployment()
    if not reason.strip():
        raise ValidationFailed("reason_required", "A written reason is required to halt a proposal.")
    reason_doc = {"proposal_id": p.id, "reason": reason.strip(), "by": actor, **(reason_data or {})}
    reason_hash = content_hash(reason_doc)
    guard = runtime.chain.contract("ExecutionGuard", deployment.c("guard"))
    try:
        tx = runtime.chain.transact(guard, "halt", [bytes.fromhex(p.key[2:]), bytes.fromhex(reason_hash[2:])], deployment.a("sentinel"))
    except TxReverted as exc:
        raise Conflict("halt_rejected", f"The guard refused the halt: {exc}", exc.revert) from exc
    for v in p.versions:
        if v.governance_status == "approved":
            v.governance_status = "halted"
    p.status = "halted"
    db.commit()
    audit.record(event_type="proposal_halted",
                 summary=f"GUARDIAN HALT: {p.id} can no longer execute this approval. Reason: {reason.strip()[:200]}",
                 actor=actor, source=source, status="failure", proposal_id=p.id, tx=tx,
                 details={"reason_hash": reason_hash, "reason": reason_doc, "power": "Guardians can only block; they cannot approve, change or execute."})
    notify(db, "critical", f"{p.id} halted on-chain", reason.strip()[:200], f"/guardian?proposal={p.id}", audience="delegates")
    db.commit()
    return {"tx_hash": tx.tx_hash, "block_number": tx.block_number, "reason_hash": reason_hash}


def file_dispute(db: Session, p: Proposal, version: int, statement: str, actor: str, source: str = "ui") -> dict[str, Any]:
    deployment = runtime.require_deployment()
    if len(statement.strip()) < 10:
        raise ValidationFailed("statement_required", "Describe the dispute in at least a sentence.")
    doc = {"proposal_id": p.id, "version": version, "statement": statement.strip(), "filed_by": actor}
    dispute_hash = content_hash(doc)
    registry = runtime.chain.contract("ProposalRegistry", deployment.c("registry"))
    try:
        tx = runtime.chain.transact(registry, "fileDispute", [bytes.fromhex(p.key[2:]), version, bytes.fromhex(dispute_hash[2:])], deployment.a("community"))
    except TxReverted as exc:
        raise Conflict("dispute_rejected", f"The registry refused the dispute: {exc}", exc.revert) from exc
    audit.record(event_type="dispute_filed", summary=f"Cryptographic dispute filed against {p.id} v{version}: statement hash {dispute_hash[:12]}… recorded on-chain.",
                 actor=actor, source=source, status="warning", proposal_id=p.id, version=version, tx=tx,
                 details={"dispute_hash": dispute_hash, "statement": statement.strip(), "filed_from": deployment.a("community")})
    return {"tx_hash": tx.tx_hash, "block_number": tx.block_number, "dispute_hash": dispute_hash}


def serialize_check(c: ExecutionCheck) -> dict[str, Any]:
    return {
        "id": c.id, "proposal_id": c.proposal_id, "version": c.version, "scenario": c.scenario, "status": c.status,
        "approved_manifest_hash": c.approved_manifest_hash, "submitted_manifest_hash": c.submitted_manifest_hash,
        "approved_manifest": c.approved_manifest, "submitted_payload": c.submitted_payload, "submitted_decoded": c.submitted_decoded,
        "discrepancies": c.discrepancies, "preflight": c.preflight, "actor": c.actor, "checked_at": iso(c.checked_at),
    }


def serialize_attempt(a: ExecutionAttempt) -> dict[str, Any]:
    return {
        "id": a.id, "proposal_id": a.proposal_id, "version": a.version, "check_id": a.check_id, "scenario": a.scenario,
        "submitted_manifest_hash": a.submitted_manifest_hash, "outcome": a.outcome, "tx_hash": a.tx_hash,
        "block_number": a.block_number, "revert": a.revert, "balance_changes": a.balance_changes, "actor": a.actor,
        "created_at": iso(a.created_at),
        "enforcement": "contract-enforced" if a.tx_hash else "gateway refusal (not sent)",
    }

