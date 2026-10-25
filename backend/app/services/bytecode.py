"""Static analysis of deployed EVM bytecode.

Extracts dispatcher selectors, embedded address constants (PUSH20 / address-shaped PUSH32, which
is how Solidity stores immutables) and an opcode risk profile, and diffs two implementations.
Static analysis only narrows where to look; the simulator's behavioural probes decide.
"""

from __future__ import annotations

from typing import Any

from eth_utils import keccak, to_checksum_address

from ..chain.artifacts import signature_db

OPCODES: dict[int, str] = {
    0x00: "STOP", 0x01: "ADD", 0x02: "MUL", 0x03: "SUB", 0x04: "DIV", 0x05: "SDIV", 0x06: "MOD", 0x07: "SMOD",
    0x08: "ADDMOD", 0x09: "MULMOD", 0x0A: "EXP", 0x0B: "SIGNEXTEND", 0x10: "LT", 0x11: "GT", 0x12: "SLT",
    0x13: "SGT", 0x14: "EQ", 0x15: "ISZERO", 0x16: "AND", 0x17: "OR", 0x18: "XOR", 0x19: "NOT", 0x1A: "BYTE",
    0x1B: "SHL", 0x1C: "SHR", 0x1D: "SAR", 0x20: "KECCAK256", 0x30: "ADDRESS", 0x31: "BALANCE", 0x32: "ORIGIN",
    0x33: "CALLER", 0x34: "CALLVALUE", 0x35: "CALLDATALOAD", 0x36: "CALLDATASIZE", 0x37: "CALLDATACOPY",
    0x38: "CODESIZE", 0x39: "CODECOPY", 0x3A: "GASPRICE", 0x3B: "EXTCODESIZE", 0x3C: "EXTCODECOPY",
    0x3D: "RETURNDATASIZE", 0x3E: "RETURNDATACOPY", 0x3F: "EXTCODEHASH", 0x40: "BLOCKHASH", 0x41: "COINBASE",
    0x42: "TIMESTAMP", 0x43: "NUMBER", 0x44: "PREVRANDAO", 0x45: "GASLIMIT", 0x46: "CHAINID", 0x47: "SELFBALANCE",
    0x48: "BASEFEE", 0x49: "BLOBHASH", 0x4A: "BLOBBASEFEE", 0x50: "POP", 0x51: "MLOAD", 0x52: "MSTORE",
    0x53: "MSTORE8", 0x54: "SLOAD", 0x55: "SSTORE", 0x56: "JUMP", 0x57: "JUMPI", 0x58: "PC", 0x59: "MSIZE",
    0x5A: "GAS", 0x5B: "JUMPDEST", 0x5C: "TLOAD", 0x5D: "TSTORE", 0x5E: "MCOPY", 0x5F: "PUSH0",
    0xA0: "LOG0", 0xA1: "LOG1", 0xA2: "LOG2", 0xA3: "LOG3", 0xA4: "LOG4", 0xF0: "CREATE", 0xF1: "CALL",
    0xF2: "CALLCODE", 0xF3: "RETURN", 0xF4: "DELEGATECALL", 0xF5: "CREATE2", 0xFA: "STATICCALL", 0xFD: "REVERT",
    0xFE: "INVALID", 0xFF: "SELFDESTRUCT",
}
for _i in range(1, 33):
    OPCODES[0x5F + _i] = f"PUSH{_i}"
for _i in range(1, 17):
    OPCODES[0x7F + _i] = f"DUP{_i}"
    OPCODES[0x8F + _i] = f"SWAP{_i}"

RISKY_OPCODES = {
    "SELFDESTRUCT": "can delete the contract and send its ETH anywhere",
    "DELEGATECALL": "runs external code with this contract's storage and balance",
    "CALLCODE": "deprecated delegate-style call",
    "CREATE": "deploys new contracts",
    "CREATE2": "deploys contracts at predictable addresses",
    "ORIGIN": "uses tx.origin, which is unsafe for authorisation",
}
PROFILE_OPCODES = ["CALL", "STATICCALL", "DELEGATECALL", "CALLCODE", "SELFDESTRUCT", "CREATE", "CREATE2", "SSTORE",
                   "CALLER", "ORIGIN", "LOG1", "LOG2", "LOG3", "LOG4"]
_MIN_ADDRESS_VALUE = 2**140  # filters small constants; random addresses clear this with p ≈ 1 - 2^-20
_ALL_FF_20 = (1 << 160) - 1


def strip_metadata(code: bytes) -> bytes:
    if len(code) < 4:
        return code
    meta_len = int.from_bytes(code[-2:], "big")
    if 0 < meta_len < 200 and len(code) > meta_len + 2 and code[-(meta_len + 2)] in (0xA1, 0xA2, 0xA3, 0xA4):
        return code[: -(meta_len + 2)]
    return code


def disassemble(code: bytes) -> list[tuple[int, str, bytes | None]]:
    out: list[tuple[int, str, bytes | None]] = []
    pc = 0
    while pc < len(code):
        op = code[pc]
        name = OPCODES.get(op, f"UNKNOWN_0x{op:02x}")
        if 0x60 <= op <= 0x7F:
            size = op - 0x5F
            out.append((pc, name, code[pc + 1 : pc + 1 + size]))
            pc += 1 + size
        else:
            out.append((pc, name, None))
            pc += 1
    return out


def extract_selectors(ins: list[tuple[int, str, bytes | None]]) -> list[str]:
    found: set[str] = set()
    for i, (_, name, data) in enumerate(ins):
        if name != "PUSH4" or data is None or len(data) != 4:
            continue
        if data in (b"\xff\xff\xff\xff", b"\x00\x00\x00\x00"):
            continue
        nxt = [ins[j][1] for j in range(i + 1, min(i + 3, len(ins)))]
        if nxt and (nxt[0] == "EQ" or (len(nxt) > 1 and nxt[0].startswith("DUP") and nxt[1] == "EQ")):
            found.add("0x" + data.hex())
    return sorted(found)


def extract_addresses(ins: list[tuple[int, str, bytes | None]]) -> list[str]:
    found: set[str] = set()
    for _, name, data in ins:
        if data is None:
            continue
        if name == "PUSH20":
            value = int.from_bytes(data, "big")
        elif name == "PUSH32" and data[:12] == b"\x00" * 12:
            value = int.from_bytes(data[12:], "big")
        else:
            continue
        if value == _ALL_FF_20 or value < _MIN_ADDRESS_VALUE:
            continue
        found.add(to_checksum_address(value.to_bytes(20, "big")))
    return sorted(found)


def analyze(code_hex: str) -> dict[str, Any]:
    raw = bytes.fromhex(code_hex[2:] if code_hex.startswith("0x") else code_hex)
    if not raw:
        return {"empty": True, "size": 0, "codehash": None, "selectors": [], "functions": [], "embedded_addresses": [], "opcodes": {}}
    body = strip_metadata(raw)
    ins = disassemble(body)
    counts: dict[str, int] = {}
    for _, name, _ in ins:
        if name in PROFILE_OPCODES:
            counts[name] = counts.get(name, 0) + 1
    db = signature_db()
    selectors = extract_selectors(ins)
    functions = []
    for sel in selectors:
        fn = db.function(sel)
        functions.append(
            {
                "selector": sel,
                "signature": fn.signature if fn else None,
                "state_mutability": fn.state_mutability if fn else None,
                "known": fn is not None,
            }
        )
    return {
        "empty": False,
        "size": len(raw),
        "codehash": "0x" + keccak(raw).hex(),
        "selectors": selectors,
        "functions": functions,
        "embedded_addresses": extract_addresses(ins),
        "opcodes": counts,
        "risky_opcodes": {op: RISKY_OPCODES[op] for op in RISKY_OPCODES if counts.get(op, 0) > 0 or _has(ins, op)},
    }


def _has(ins: list[tuple[int, str, bytes | None]], opname: str) -> bool:
    return any(name == opname for _, name, _ in ins)


def diff(old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    old_sel, new_sel = set(old.get("selectors", [])), set(new.get("selectors", []))
    fn_new = {f["selector"]: f for f in new.get("functions", [])}
    fn_old = {f["selector"]: f for f in old.get("functions", [])}
    old_addr, new_addr = set(old.get("embedded_addresses", [])), set(new.get("embedded_addresses", []))
    opcode_delta = {}
    for op in PROFILE_OPCODES:
        a, b = old.get("opcodes", {}).get(op, 0), new.get("opcodes", {}).get(op, 0)
        if a != b:
            opcode_delta[op] = {"old": a, "new": b}
    return {
        "codehash_changed": old.get("codehash") != new.get("codehash"),
        "size": {"old": old.get("size"), "new": new.get("size")},
        "selectors_added": [fn_new[s] for s in sorted(new_sel - old_sel)],
        "selectors_removed": [fn_old[s] for s in sorted(old_sel - new_sel)],
        "selectors_common": len(old_sel & new_sel),
        "embedded_addresses_added": sorted(new_addr - old_addr),
        "embedded_addresses_removed": sorted(old_addr - new_addr),
        "risky_opcodes_introduced": {
            op: why for op, why in new.get("risky_opcodes", {}).items() if op not in old.get("risky_opcodes", {})
        },
        "opcode_delta": opcode_delta,
    }
