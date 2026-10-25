"""Decode action calldata into named functions, typed arguments and a plain-language description."""

from __future__ import annotations

from typing import Any

from eth_abi import decode as abi_decode
from eth_utils import to_checksum_address

from ..chain.artifacts import PRIVILEGED_FUNCTIONS, signature_db
from .labels import ROLE_HASHES, Labeler, format_token, token_meta
from .manifests import Action


def _fmt_arg(value: Any, typ: str) -> Any:
    if typ == "address":
        return to_checksum_address(value)
    if typ.startswith("bytes") and not typ.endswith("]"):
        return "0x" + bytes(value).hex()
    if typ.startswith(("uint", "int")):
        return str(value)
    if typ.endswith("]") and isinstance(value, (list, tuple)):
        return [_fmt_arg(v, typ[: typ.rindex("[")]) for v in value]
    return value


def decode_calldata(data: str) -> dict[str, Any]:
    raw = bytes.fromhex(data[2:]) if data and data != "0x" else b""
    if len(raw) == 0:
        return {"selector": None, "signature": None, "name": None, "args": [], "known": True, "plain_transfer": True}
    if len(raw) < 4:
        return {"selector": "0x" + raw.hex(), "signature": None, "name": None, "args": [], "known": False, "error": "calldata shorter than a selector"}
    selector = "0x" + raw[:4].hex()
    fn = signature_db().function(selector)
    if fn is None:
        return {"selector": selector, "signature": None, "name": None, "args": [], "known": False, "error": "unknown function selector"}
    types = [i["type"] for i in fn.inputs]
    try:
        values = abi_decode(types, raw[4:]) if types else ()
    except Exception as exc:
        return {"selector": selector, "signature": fn.signature, "name": fn.name, "args": [], "known": False, "error": f"arguments do not decode: {exc}"}
    args = [
        {"name": inp.get("name") or f"arg{i}", "type": inp["type"], "value": _fmt_arg(val, inp["type"])}
        for i, (inp, val) in enumerate(zip(fn.inputs, values))
    ]
    return {"selector": selector, "signature": fn.signature, "name": fn.name, "args": args, "known": True}


def arg(decoded: dict[str, Any], index: int) -> Any:
    args = decoded.get("args") or []
    return args[index]["value"] if index < len(args) else None


def describe_action(action: Action, labeler: Labeler) -> dict[str, Any]:
    """Structured decode + expectations + a sentence a non-developer can read."""
    decoded = decode_calldata(action.data)
    sig = decoded.get("signature")
    target_label = labeler.describe(action.target)
    info: dict[str, Any] = {
        "target": action.target,
        "target_label": labeler.label(action.target),
        "value": str(action.value),
        "data": action.data,
        "operation": action.operation,
        "selector": decoded.get("selector"),
        "function": sig,
        "args": decoded.get("args", []),
        "decoded": decoded.get("known", False),
        "privileged": PRIVILEGED_FUNCTIONS.get(sig or ""),
        "token_address": None,
        "token_symbol": None,
        "expected_recipient": None,
        "expected_amount_base": None,
    }
    meta = token_meta(action.target)
    if sig == "transfer(address,uint256)":
        recipient, amount = arg(decoded, 0), arg(decoded, 1)
        info.update(
            kind="erc20_transfer",
            token_address=action.target,
            token_symbol=meta[0] if meta else None,
            expected_recipient=recipient,
            expected_amount_base=amount,
            human_readable=f"Transfer {format_token(amount, action.target)} from the treasury to {labeler.describe(recipient)}.",
        )
    elif sig in ("approve(address,uint256)", "increaseAllowance(address,uint256)"):
        spender, amount = arg(decoded, 0), arg(decoded, 1)
        info.update(
            kind="erc20_approve",
            token_address=action.target,
            token_symbol=meta[0] if meta else None,
            human_readable=f"Allow {labeler.describe(spender)} to spend {format_token(amount, action.target)} held by the treasury.",
        )
    elif sig == "upgradeAndCall(address,address,bytes)":
        proxy, impl, call = arg(decoded, 0), arg(decoded, 1), arg(decoded, 2)
        extra = " and run an initialisation call" if call and call != "0x" else ""
        info.update(
            kind="proxy_upgrade",
            upgrade={"proxy": proxy, "implementation": impl, "call_data": call},
            human_readable=f"Upgrade {labeler.describe(proxy)} to implementation {labeler.describe(impl)}{extra} (via {target_label}).",
        )
    elif sig in ("grantRole(bytes32,address)", "revokeRole(bytes32,address)"):
        role, account = arg(decoded, 0), arg(decoded, 1)
        verb = "Grant" if sig.startswith("grant") else "Revoke"
        info.update(
            kind="role_change",
            human_readable=f"{verb} {ROLE_HASHES.get(role, role)} {'to' if verb == 'Grant' else 'from'} {labeler.describe(account)} on {target_label}.",
        )
    elif sig == "transferOwnership(address)":
        info.update(kind="ownership", human_readable=f"Transfer ownership of {target_label} to {labeler.describe(arg(decoded, 0))}.")
    elif sig == "setFeeBps(uint16)":
        info.update(kind="parameter", human_readable=f"Set the fee on {target_label} to {arg(decoded, 0)} basis points.")
    elif decoded.get("plain_transfer"):
        info.update(
            kind="native_transfer",
            expected_recipient=action.target,
            expected_amount_base=str(action.value),
            human_readable=f"Send {format_token(action.value, None, 'ETH', 18)} to {target_label}.",
        )
    elif decoded.get("known"):
        args_text = ", ".join(f"{a['name']}={a['value']}" for a in decoded["args"])
        info.update(kind="contract_call", human_readable=f"Call {decoded['name']}({args_text}) on {target_label}.")
    else:
        info.update(
            kind="unknown",
            human_readable=f"Call an unrecognised function ({decoded.get('selector')}) on {target_label}. DAOGuard cannot decode it.",
        )
    if action.operation == 1:
        info["human_readable"] += " Requested as DELEGATECALL, which the guard refuses to perform."
    if action.value and info.get("kind") != "native_transfer":
        info["human_readable"] += f" Sends {format_token(action.value, None, 'ETH', 18)} along with the call."
    return info
