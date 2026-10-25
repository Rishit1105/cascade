"""Executable action manifests: strict parsing, EIP-712 hashing and manifest documents.

The digest computed here must be byte-identical to ExecutionGuard.hashManifest(); a test checks
this against the live contract. Inputs are validated, never coerced: a malformed address, amount,
chain id or calldata is an error with the offending field path.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from eth_abi import encode as abi_encode
from eth_utils import is_checksum_address, keccak, to_checksum_address

from .canonical import CANON_VERSION

ACTION_TYPEHASH = keccak(text="Action(address target,uint256 value,bytes data,uint8 operation)")
MANIFEST_TYPEHASH = keccak(
    text="Manifest(bytes32 proposalKey,uint64 version,Action[] actions)"
    "Action(address target,uint256 value,bytes data,uint8 operation)"
)
DOMAIN_TYPEHASH = keccak(text="EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
GUARD_DOMAIN_NAME = "DAOGuard ExecutionGuard"
GUARD_DOMAIN_VERSION = "1"
HASH_SCHEME = "EIP-712 Manifest(bytes32 proposalKey,uint64 version,Action[] actions) / ExecutionGuard v1"

UINT256_MAX = 2**256 - 1
UINT64_MAX = 2**64 - 1
_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
_HEX_RE = re.compile(r"^0x(?:[0-9a-fA-F]{2})*$")
_UINT_RE = re.compile(r"^(0|[1-9][0-9]*)$")


class PayloadError(ValueError):
    def __init__(self, path: str, message: str):
        super().__init__(f"{path}: {message}")
        self.path = path
        self.message = message


# ------------------------------------------------------------------ parsing
def parse_address(value: Any, path: str) -> str:
    if not isinstance(value, str) or not _ADDRESS_RE.match(value):
        raise PayloadError(path, "expected a 0x-prefixed 20-byte hex address")
    body = value[2:]
    if body != body.lower() and body != body.upper() and not is_checksum_address(value):
        raise PayloadError(path, "address has an invalid EIP-55 checksum (mixed case does not match)")
    return to_checksum_address(value)


def parse_uint(value: Any, path: str, maximum: int = UINT256_MAX) -> int:
    if isinstance(value, bool):
        raise PayloadError(path, "expected an unsigned integer, got a boolean")
    if isinstance(value, int):
        number = value
    elif isinstance(value, str) and _UINT_RE.match(value):
        number = int(value)
    elif isinstance(value, str) and value.startswith("0x") and re.fullmatch(r"0x[0-9a-fA-F]+", value):
        number = int(value, 16)
    else:
        raise PayloadError(path, "expected an unsigned integer (base units as a decimal string, no decimals or exponent)")
    if number < 0 or number > maximum:
        raise PayloadError(path, f"value out of range (0..{maximum})")
    return number


def parse_hex_bytes(value: Any, path: str) -> str:
    if not isinstance(value, str) or not _HEX_RE.match(value):
        raise PayloadError(path, "expected 0x-prefixed hex bytes with an even number of digits")
    return value.lower()


def parse_operation(value: Any, path: str) -> int:
    op = parse_uint(value, path, maximum=255)
    if op not in (0, 1):
        raise PayloadError(path, "operation must be 0 (call) or 1 (delegatecall)")
    return op


def parse_bytes32(value: Any, path: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", value):
        raise PayloadError(path, "expected a 0x-prefixed 32-byte hex value")
    return value.lower()


@dataclass(frozen=True)
class Action:
    target: str
    value: int
    data: str
    operation: int = 0

    def as_tuple(self) -> tuple[str, int, bytes, int]:
        return (self.target, self.value, bytes.fromhex(self.data[2:]), self.operation)

    def as_dict(self) -> dict[str, Any]:
        return {"target": self.target, "value": str(self.value), "data": self.data, "operation": self.operation}


@dataclass(frozen=True)
class SubmittedPayload:
    chain_id: int
    guard: str
    proposal_key: str
    version: int
    actions: tuple[Action, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "chain_id": self.chain_id,
            "guard": self.guard,
            "proposal_key": self.proposal_key,
            "version": self.version,
            "actions": [a.as_dict() for a in self.actions],
        }


def parse_action(raw: Any, path: str) -> Action:
    if not isinstance(raw, dict):
        raise PayloadError(path, "expected an object with target, value, data, operation")
    unknown = set(raw) - {"target", "value", "data", "operation", "description"}
    if unknown:
        raise PayloadError(path, f"unexpected field(s): {', '.join(sorted(unknown))}")
    for required in ("target", "value", "data"):
        if required not in raw:
            raise PayloadError(f"{path}.{required}", "is required")
    return Action(
        target=parse_address(raw["target"], f"{path}.target"),
        value=parse_uint(raw["value"], f"{path}.value"),
        data=parse_hex_bytes(raw["data"], f"{path}.data"),
        operation=parse_operation(raw.get("operation", 0), f"{path}.operation"),
    )


def parse_payload(raw: Any) -> SubmittedPayload:
    if not isinstance(raw, dict):
        raise PayloadError("$", "payload must be a JSON object")
    for required in ("chain_id", "guard", "proposal_key", "version", "actions"):
        if required not in raw:
            raise PayloadError(f"$.{required}", "is required")
    actions_raw = raw["actions"]
    if not isinstance(actions_raw, list):
        raise PayloadError("$.actions", "must be a list")
    if len(actions_raw) > 32:
        raise PayloadError("$.actions", "at most 32 actions per manifest")
    return SubmittedPayload(
        chain_id=parse_uint(raw["chain_id"], "$.chain_id", maximum=UINT64_MAX),
        guard=parse_address(raw["guard"], "$.guard"),
        proposal_key=parse_bytes32(raw["proposal_key"], "$.proposal_key"),
        version=parse_uint(raw["version"], "$.version", maximum=UINT64_MAX),
        actions=tuple(parse_action(a, f"$.actions[{i}]") for i, a in enumerate(actions_raw)),
    )


# ------------------------------------------------------------------ hashing
def proposal_key(proposal_id: str) -> str:
    return "0x" + keccak(text=proposal_id).hex()


def domain_separator(chain_id: int, guard: str) -> bytes:
    return keccak(
        abi_encode(
            ["bytes32", "bytes32", "bytes32", "uint256", "address"],
            [
                DOMAIN_TYPEHASH,
                keccak(text=GUARD_DOMAIN_NAME),
                keccak(text=GUARD_DOMAIN_VERSION),
                chain_id,
                to_checksum_address(guard),
            ],
        )
    )


def action_struct_hash(action: Action) -> bytes:
    return keccak(
        abi_encode(
            ["bytes32", "address", "uint256", "bytes32", "uint8"],
            [ACTION_TYPEHASH, action.target, action.value, keccak(bytes.fromhex(action.data[2:])), action.operation],
        )
    )


def manifest_digest(chain_id: int, guard: str, key: str, version: int, actions: list[Action] | tuple[Action, ...]) -> str:
    actions_hash = keccak(b"".join(action_struct_hash(a) for a in actions))
    struct_hash = keccak(
        abi_encode(
            ["bytes32", "bytes32", "uint64", "bytes32"],
            [MANIFEST_TYPEHASH, bytes.fromhex(key[2:]), version, actions_hash],
        )
    )
    return "0x" + keccak(b"\x19\x01" + domain_separator(chain_id, guard) + struct_hash).hex()


def payload_digest(payload: SubmittedPayload) -> str:
    return manifest_digest(payload.chain_id, payload.guard, payload.proposal_key, payload.version, payload.actions)


# ------------------------------------------------------- manifest documents
def manifest_document(
    *,
    proposal_id: str,
    version: int,
    chain_id: int,
    guard: str,
    actions: list[dict[str, Any]],
) -> dict[str, Any]:
    """Rich manifest: the executable tuple per action plus decoded, human-readable expectations.

    Only (target, value, data, operation) and the context are bound by the on-chain digest. The
    descriptive fields are bound by the version's content hash in ProposalRegistry.
    """
    key = proposal_key(proposal_id)
    executable = [Action(a["target"], int(a["value"]), a["data"], int(a.get("operation", 0))) for a in actions]
    return {
        "canonicalization": CANON_VERSION,
        "hash_scheme": HASH_SCHEME,
        "chain_id": chain_id,
        "guard": to_checksum_address(guard),
        "proposal_id": proposal_id,
        "proposal_key": key,
        "version": version,
        "actions": actions,
        "manifest_hash": manifest_digest(chain_id, guard, key, version, executable),
    }


def manifest_to_payload(manifest: dict[str, Any]) -> dict[str, Any]:
    """The executable payload an executor would submit for this manifest."""
    return {
        "chain_id": manifest["chain_id"],
        "guard": manifest["guard"],
        "proposal_key": manifest["proposal_key"],
        "version": manifest["version"],
        "actions": [
            {"target": a["target"], "value": str(a["value"]), "data": a["data"], "operation": a.get("operation", 0)}
            for a in manifest["actions"]
        ],
    }


def manifest_actions(manifest: dict[str, Any]) -> list[Action]:
    return [Action(a["target"], int(a["value"]), a["data"], int(a.get("operation", 0))) for a in manifest["actions"]]
