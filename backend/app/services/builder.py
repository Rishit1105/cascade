"""Manifest builder: structured actions → exact calldata → EIP-712 digest, compared live with the
manifest governance approved.

Read-only. Nothing is stored, signed or sent: the builder encodes, hashes and asks the guard's
preflight() view (an eth_call) whether it would execute, so a reviewer can see exactly which byte
of a payload breaks the match before anyone submits it.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Any

from eth_abi import encode as abi_encode
from eth_utils import keccak

from sqlalchemy import select

from ..models import AddressLabel, Proposal
from ..runtime import Deployment, runtime
from .decoder import decode_calldata, describe_action
from .labels import Labeler, token_meta
from .manifests import (MANIFEST_TYPEHASH, Action, PayloadError, action_struct_hash, domain_separator, parse_address, parse_bytes32,
                        parse_hex_bytes, parse_operation, parse_payload, parse_uint, proposal_key, UINT64_MAX)
from .proposals import approved_version, latest_version

KINDS = ("erc20_transfer", "erc20_approve", "proxy_upgrade", "contract_call", "raw")
_SIG_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\(([^()]*)\)$")
_SCALAR_TYPE = re.compile(r"^(address|bool|string|bytes([1-9]|[12][0-9]|3[0-2])?|u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?)$")


def _selector(signature: str) -> str:
    return "0x" + keccak(text=signature)[:4].hex()


def token_decimals(token: str) -> int:
    meta = token_meta(token)
    if meta:
        return meta[1]
    try:  # any other ERC-20 on the connected chain
        res = runtime.chain.call_raw(token, _selector("decimals()"))
        return int(res["data"], 16) if res["ok"] and res["data"] not in (None, "0x") else 18
    except Exception:
        return 18


def parse_amount(spec: dict[str, Any], token: str, path: str) -> int:
    """Human amount ("500000.5") in token units, or exact base units via amount_base."""
    if spec.get("amount_base") not in (None, ""):
        return parse_uint(spec["amount_base"], f"{path}.amount_base")
    raw = str(spec.get("amount", "")).replace(",", "").replace("_", "").strip()
    if not raw:
        raise PayloadError(f"{path}.amount", "is required")
    try:
        value = Decimal(raw)
    except InvalidOperation:
        raise PayloadError(f"{path}.amount", "expected a decimal number such as 500000 or 12.5") from None
    if not value.is_finite() or value < 0:
        raise PayloadError(f"{path}.amount", "must be a non-negative number")
    decimals = token_decimals(token)
    base = value * (Decimal(10) ** decimals)
    if base != base.to_integral_value():
        raise PayloadError(f"{path}.amount", f"has more than {decimals} decimal places for this token")
    return parse_uint(str(int(base)), f"{path}.amount")


def _encode_arg(typ: str, value: Any, path: str) -> Any:
    text = value if isinstance(value, str) else str(value)
    if typ == "address":
        return parse_address(text.strip(), path)
    if typ == "bool":
        if text.strip().lower() not in ("true", "false"):
            raise PayloadError(path, "expected true or false")
        return text.strip().lower() == "true"
    if typ == "string":
        return text
    if typ.startswith("bytes"):
        data = parse_hex_bytes(text.strip(), path)
        raw = bytes.fromhex(data[2:])
        if typ != "bytes" and len(raw) != int(typ[5:]):
            raise PayloadError(path, f"{typ} needs exactly {typ[5:]} bytes")
        return raw
    bits = int(re.sub(r"^u?int", "", typ) or 256)
    signed = typ.startswith("int")
    t = text.strip()
    if signed and t.startswith("-") and t[1:].isdigit():
        number = int(t)
    else:
        number = parse_uint(t, path)
    lo, hi = (-(2 ** (bits - 1)), 2 ** (bits - 1) - 1) if signed else (0, 2**bits - 1)
    if not lo <= number <= hi:
        raise PayloadError(path, f"out of range for {typ}")
    return number


def encode_contract_call(signature: str, args: list[Any], path: str) -> str:
    sig = re.sub(r"\s+", "", signature or "")
    m = _SIG_RE.match(sig)
    if not m:
        raise PayloadError(f"{path}.signature", "expected a function signature such as setFeeBps(uint16)")
    types = [t for t in m.group(2).split(",") if t]
    for i, t in enumerate(types):
        if not _SCALAR_TYPE.match(t):
            raise PayloadError(f"{path}.signature", f"argument {i + 1} type '{t}' is not supported here (arrays and tuples: use raw calldata)")
    if not isinstance(args, list) or len(args) != len(types):
        raise PayloadError(f"{path}.args", f"{sig} takes {len(types)} argument(s), got {len(args) if isinstance(args, list) else 0}")
    values = [_encode_arg(t, a, f"{path}.args[{i}]") for i, (t, a) in enumerate(zip(types, args))]
    return _selector(sig) + (abi_encode(types, values).hex() if types else "")


def encode_spec(spec: Any, i: int, d: Deployment) -> Action:
    path = f"actions[{i}]"
    if not isinstance(spec, dict):
        raise PayloadError(path, "expected an object")
    kind = spec.get("kind")
    if kind == "erc20_transfer":
        token = parse_address(spec.get("token") or d.c("usdc"), f"{path}.token")
        to = parse_address(spec.get("to"), f"{path}.to")
        amount = parse_amount(spec, token, path)
        return Action(token, 0, _selector("transfer(address,uint256)") + abi_encode(["address", "uint256"], [to, amount]).hex(), 0)
    if kind == "erc20_approve":
        token = parse_address(spec.get("token") or d.c("usdc"), f"{path}.token")
        spender = parse_address(spec.get("spender"), f"{path}.spender")
        amount = parse_amount(spec, token, path)
        return Action(token, 0, _selector("approve(address,uint256)") + abi_encode(["address", "uint256"], [spender, amount]).hex(), 0)
    if kind == "proxy_upgrade":
        admin = parse_address(spec.get("proxy_admin") or d.c("proxy_admin"), f"{path}.proxy_admin")
        proxy = parse_address(spec.get("proxy") or d.c("fee_vault"), f"{path}.proxy")
        impl = parse_address(spec.get("implementation"), f"{path}.implementation")
        call = parse_hex_bytes(spec.get("call_data") or "0x", f"{path}.call_data")
        data = _selector("upgradeAndCall(address,address,bytes)") + abi_encode(["address", "address", "bytes"], [proxy, impl, bytes.fromhex(call[2:])]).hex()
        return Action(admin, 0, data, 0)
    if kind == "contract_call":
        target = parse_address(spec.get("target"), f"{path}.target")
        return Action(target, parse_uint(spec.get("value") or "0", f"{path}.value"), encode_contract_call(spec.get("signature", ""), spec.get("args", []), path), 0)
    if kind == "raw":
        return Action(parse_address(spec.get("target"), f"{path}.target"), parse_uint(spec.get("value") or "0", f"{path}.value"),
                      parse_hex_bytes(spec.get("data") or "0x", f"{path}.data"), parse_operation(spec.get("operation", 0), f"{path}.operation"))
    raise PayloadError(f"{path}.kind", f"must be one of {', '.join(KINDS)}")


def _human_amount(base: int, token: str) -> str:
    value = Decimal(base) / (Decimal(10) ** token_decimals(token))
    return format(value.normalize(), "f")


def to_spec(a: Action, d: Deployment) -> dict[str, Any]:
    """Inverse of encode_spec, so any payload can be edited in structured form without losing a byte."""
    decoded = decode_calldata(a.data)
    sig = decoded.get("signature")
    plain = a.value == 0 and a.operation == 0 and decoded.get("known")
    if plain and sig == "transfer(address,uint256)":
        to, amount = decoded["args"][0]["value"], int(decoded["args"][1]["value"])
        return {"kind": "erc20_transfer", "token": a.target, "to": to, "amount": _human_amount(amount, a.target)}
    if plain and sig == "approve(address,uint256)":
        spender, amount = decoded["args"][0]["value"], int(decoded["args"][1]["value"])
        return {"kind": "erc20_approve", "token": a.target, "spender": spender, "amount": _human_amount(amount, a.target)}
    if plain and sig == "upgradeAndCall(address,address,bytes)":
        args = decoded["args"]
        return {"kind": "proxy_upgrade", "proxy_admin": a.target, "proxy": args[0]["value"], "implementation": args[1]["value"], "call_data": args[2]["value"]}
    if a.operation == 0 and decoded.get("known") and sig and all(_SCALAR_TYPE.match(x["type"]) for x in decoded["args"]):
        spec = {"kind": "contract_call", "target": a.target, "signature": sig, "args": [x["value"] if isinstance(x["value"], str) else str(x["value"]).lower() if isinstance(x["value"], bool) else str(x["value"]) for x in decoded["args"]], "value": str(a.value)}
        # Re-encoding must reproduce the exact bytes (e.g. non-canonical padding would not): otherwise keep it raw.
        try:
            if encode_contract_call(sig, spec["args"], "check") == a.data:
                return spec
        except PayloadError:
            pass
    return {"kind": "raw", "target": a.target, "value": str(a.value), "data": a.data, "operation": a.operation}


def address_book(db) -> dict[str, Any]:
    """Labelled demo addresses and tokens for the builder's pickers (labels are annotations, not identity)."""
    d = runtime.require_deployment()
    rows = list(db.scalars(select(AddressLabel).order_by(AddressLabel.kind, AddressLabel.label)))
    return {
        "addresses": [{"address": r.address, "label": r.label, "kind": r.kind} for r in rows],
        "tokens": [{"address": d.c("usdc"), "symbol": "mUSDC", "decimals": 6}, {"address": d.c("atlas"), "symbol": "ATLAS", "decimals": 18}],
        "defaults": {"chain_id": d.chain_id, "guard": d.c("guard"), "proxy_admin": d.c("proxy_admin"), "fee_vault": d.c("fee_vault")},
    }


def _components(chain_id: int, guard: str, key: str, version: int, actions: list[Action]) -> dict[str, Any]:
    dom = domain_separator(chain_id, guard)
    hashes = [action_struct_hash(a) for a in actions]
    actions_hash = keccak(b"".join(hashes))
    struct = keccak(abi_encode(["bytes32", "bytes32", "uint64", "bytes32"], [MANIFEST_TYPEHASH, bytes.fromhex(key[2:]), version, actions_hash]))
    return {
        "chain_id": chain_id,
        "guard": guard,
        "domain_separator": "0x" + dom.hex(),
        "proposal_key": key,
        "version": version,
        "action_hashes": ["0x" + h.hex() for h in hashes],
        "actions_hash": "0x" + actions_hash.hex(),
        "struct_hash": "0x" + struct.hex(),
        "digest": "0x" + keccak(b"\x19\x01" + dom + struct).hex(),
    }


def _context(raw: Any, d: Deployment, p: Proposal, basis_version: int) -> tuple[int, str, str, int]:
    raw = raw if isinstance(raw, dict) else {}
    chain_id = parse_uint(raw.get("chain_id", d.chain_id), "context.chain_id", maximum=UINT64_MAX)
    guard = parse_address(raw.get("guard") or d.c("guard"), "context.guard")
    key = parse_bytes32(raw.get("proposal_key") or proposal_key(p.id), "context.proposal_key")
    version = parse_uint(raw.get("version", basis_version), "context.version", maximum=UINT64_MAX)
    return chain_id, guard, key, version


def preview(db, p: Proposal, body: dict[str, Any]) -> dict[str, Any]:
    from .execution import _known_guards

    d = runtime.require_deployment()
    labeler = Labeler(db)
    basis = approved_version(p)
    basis_label = "approved"
    if basis is None:
        basis, basis_label = latest_version(p), "latest committed (not approved)"
    errors: list[dict[str, str]] = []
    actions: list[Action] = []
    specs: list[dict[str, Any]] = []

    if body.get("payload") is not None:
        try:
            payload = parse_payload(body["payload"])
            chain_id, guard, key, version = payload.chain_id, payload.guard, payload.proposal_key, payload.version
            actions = list(payload.actions)
        except PayloadError as exc:
            return {"valid": False, "errors": [{"path": exc.path, "message": exc.message}], "basis": basis_label}
        specs = [to_spec(a, d) for a in actions]
    else:
        try:
            chain_id, guard, key, version = _context(body.get("context"), d, p, basis.version if basis else 1)
        except PayloadError as exc:
            errors.append({"path": exc.path, "message": exc.message})
            chain_id, guard, key, version = d.chain_id, d.c("guard"), proposal_key(p.id), basis.version if basis else 1
        raw_actions = body.get("actions") or []
        if not isinstance(raw_actions, list) or len(raw_actions) > 32:
            errors.append({"path": "actions", "message": "expected a list of at most 32 actions"})
            raw_actions = []
        for i, spec in enumerate(raw_actions):
            try:
                actions.append(encode_spec(spec, i, d))
                specs.append(spec)
            except PayloadError as exc:
                errors.append({"path": exc.path, "message": exc.message})
        if errors:
            return {"valid": False, "errors": errors, "basis": basis_label}

    payload_out = {"chain_id": chain_id, "guard": guard, "proposal_key": key, "version": version, "actions": [a.as_dict() for a in actions]}
    submitted = _components(chain_id, guard, key, version, actions)
    approved = None
    if basis is not None:
        m = basis.manifest
        approved_actions = [Action(a["target"], int(a["value"]), a["data"], int(a.get("operation", 0))) for a in m["actions"]]
        approved = _components(int(m["chain_id"]), m["guard"], m["proposal_key"], int(m["version"]), approved_actions)
        approved.update(manifest_hash=m["manifest_hash"], actions=[a.as_dict() for a in approved_actions], human=[a.get("human_readable") for a in m["actions"]])

    def row(part: str, sub: Any, app: Any, note: str = "") -> dict[str, Any]:
        same = app is not None and str(sub).lower() == str(app).lower()
        return {"part": part, "submitted": sub, "approved": app, "match": same, "note": note}

    comparison: list[dict[str, Any]] = []
    action_rows: list[dict[str, Any]] = []
    if approved:
        comparison += [
            row("Chain id", chain_id, approved["chain_id"], "part of the EIP-712 domain"),
            row("Guard (verifying contract)", guard, approved["guard"], "part of the EIP-712 domain"),
            row("Domain separator", submitted["domain_separator"], approved["domain_separator"]),
            row("Proposal key", key, approved["proposal_key"], f"keccak256(\"{p.id}\")"),
            row("Version", version, approved["version"]),
            row("Action count", len(actions), len(approved["action_hashes"])),
            row("Actions hash", submitted["actions_hash"], approved["actions_hash"], "keccak256 of the concatenated action struct hashes"),
            row("Manifest struct hash", submitted["struct_hash"], approved["struct_hash"]),
            row("Digest", submitted["digest"], approved["digest"], "what ExecutionGuard compares"),
        ]
    for i, a in enumerate(actions):
        app = approved["actions"][i] if approved and i < len(approved["actions"]) else None
        fields = []
        if app:
            for f in ("target", "value", "data", "operation"):
                sv, av = a.as_dict()[f], app[f]
                if str(sv).lower() != str(av).lower():
                    fields.append(f)
        action_rows.append({
            "index": i,
            "spec": specs[i],
            "action": a.as_dict(),
            "decoded": describe_action(a, labeler),
            "struct_hash": submitted["action_hashes"][i],
            "approved_struct_hash": approved["action_hashes"][i] if app else None,
            "matches_approved": bool(app) and not fields,
            "differs_in": fields if app else ["not in the approved manifest"],
        })
    missing = [{"index": i, "human": approved["human"][i]} for i in range(len(actions), len(approved["actions"]))] if approved else []

    preflight: dict[str, Any] = {"performed": False}
    if not actions:
        preflight["reason"] = "A manifest needs at least one action (the guard rejects an empty one)."
    elif chain_id != d.chain_id:
        preflight["reason"] = f"Built for chain {chain_id}; the connected node is chain {d.chain_id}."
    elif guard.lower() not in _known_guards():
        preflight["reason"] = "Addressed to a contract that is not an ExecutionGuard deployment."
    else:
        res = runtime.chain.call_fn(runtime.chain.contract("ExecutionGuard", guard), "preflight", [bytes.fromhex(key[2:]), version, [a.as_tuple() for a in actions]])
        preflight = {"performed": True, "would_execute": res["ok"], "revert": res.get("revert"),
                     "contract_digest": "0x" + res["value"][0].hex() if res["ok"] else None}

    return {
        "valid": True,
        "errors": [],
        "basis": basis_label,
        "basis_version": basis.version if basis else None,
        "payload": payload_out,
        "specs": specs,
        "submitted": submitted,
        "approved": {k: v for k, v in approved.items() if k not in ("actions", "human")} if approved else None,
        "match": bool(approved) and submitted["digest"] == approved["digest"],
        "comparison": comparison,
        "actions": action_rows,
        "missing_actions": missing,
        "preflight": preflight,
        "note": "Read-only: encoded and hashed locally, then checked with an eth_call to ExecutionGuard.preflight(). Nothing is stored or sent.",
    }
