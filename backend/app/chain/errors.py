"""Decode revert data and explain contract-enforced rejections in plain language."""

from __future__ import annotations

from typing import Any

from eth_abi import decode as abi_decode
from eth_utils import to_checksum_address

from .artifacts import signature_db

PANIC_CODES = {
    0x01: "assertion failed",
    0x11: "arithmetic overflow or underflow",
    0x12: "division by zero",
    0x21: "invalid enum value",
    0x32: "array index out of bounds",
    0x41: "out of memory",
    0x51: "call to uninitialised function",
}

GUARD_STATUS = {0: "None", 1: "Approved", 2: "Executed", 3: "Halted"}


def _fmt(value: Any, typ: str) -> Any:
    if typ == "address":
        return to_checksum_address(value)
    if typ.startswith("bytes"):
        return "0x" + bytes(value).hex()
    if typ.startswith(("uint", "int")):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [str(v) for v in value]
    return value


def decode_revert(data: str | bytes | None) -> dict[str, Any] | None:
    """Return {name, signature, args, selector, explanation} or None for empty revert data."""
    if data is None:
        return None
    raw = bytes.fromhex(data[2:] if data.startswith("0x") else data) if isinstance(data, str) else bytes(data)
    if len(raw) < 4:
        return {
            "name": "EmptyRevert",
            "signature": None,
            "selector": None,
            "args": {},
            "explanation": "The transaction reverted without a reason (out of gas or a bare revert).",
        }
    selector = "0x" + raw[:4].hex()
    sig = signature_db().error(selector)
    if sig is None:
        return {
            "name": "UnknownError",
            "signature": None,
            "selector": selector,
            "args": {"data": "0x" + raw.hex()},
            "explanation": f"The contract reverted with an error selector ({selector}) that DAOGuard cannot name.",
        }
    types = [i["type"] for i in sig.inputs]
    try:
        values = abi_decode(types, raw[4:]) if types else ()
    except Exception:  # malformed payload: report, don't guess
        values = ()
    args = {inp["name"] or f"arg{i}": _fmt(v, inp["type"]) for i, (inp, v) in enumerate(zip(sig.inputs, values))}
    return {
        "name": sig.name,
        "signature": sig.signature,
        "selector": selector,
        "args": args,
        "explanation": explain_error(sig.name, args),
    }


def explain_error(name: str, args: dict[str, Any]) -> str:
    if name == "ManifestMismatch":
        return (
            "The submitted actions do not hash to the manifest governance approved "
            f"(approved {short(args.get('approvedHash'))}, submitted {short(args.get('submittedHash'))}). "
            "The guard contract refused to run any of them, so no funds or permissions changed."
        )
    if name == "NotApproved":
        return "Governance has not approved any manifest for this proposal, so the guard will not execute it."
    if name == "AlreadyExecuted":
        return "This approved manifest has already been executed once. The guard rejects replays."
    if name == "ProposalIsHalted":
        return (
            "A guardian halted this proposal during its review window "
            f"(reason hash {short(args.get('reasonHash'))}). Execution is blocked until governance approves a newer version."
        )
    if name == "ReviewWindowActive":
        return (
            f"The approval is still inside its review window: executable at block {args.get('executableAtBlock')}, "
            f"current block {args.get('currentBlock')}."
        )
    if name == "StaleVersion":
        return (
            f"The submitted manifest is version {args.get('submittedVersion')} but governance approved version "
            f"{args.get('approvedVersion')}."
        )
    if name == "EmptyManifest":
        return "The submitted payload contains no actions."
    if name == "UnsupportedOperation":
        return (
            f"Action #{args.get('index')} requests operation {args.get('operation')} (DELEGATECALL). "
            "The guard only performs plain calls."
        )
    if name == "ActionFailed":
        return (
            f"Action #{args.get('index')} reverted inside its target contract, so the whole batch was rolled back."
        )
    if name == "AccessControlUnauthorizedAccount":
        return f"{args.get('account')} does not hold the role required for this call."
    if name == "NotHaltable":
        status = GUARD_STATUS.get(int(args.get("status", 0)), args.get("status"))
        return f"Only an approved, not-yet-executed manifest can be halted (current status: {status})."
    if name == "InvalidDisclosureSignature":
        return "The disclosure signature does not recover to the proposer's address."
    if name == "VersionOutOfOrder":
        return f"Versions are append-only: expected version {args.get('expected')}, got {args.get('provided')}."
    if name == "Error":
        return f"Reverted: {args.get('message')}"
    if name == "Panic":
        code = int(args.get("code", 0))
        return f"Panic: {PANIC_CODES.get(code, hex(code))}."
    return f"The contract reverted with {name}."


def short(value: Any) -> str:
    if not isinstance(value, str) or len(value) < 14:
        return str(value)
    return f"{value[:10]}…{value[-6:]}"
