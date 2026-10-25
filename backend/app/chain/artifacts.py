"""Compiled contract artifacts plus a signature database built from every known ABI.

The signature DB lets the decoder and the bytecode analyser name 4-byte selectors, event topics
and custom errors. Selectors that are not in the DB are reported as unknown, never guessed.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from eth_utils import function_signature_to_4byte_selector, keccak

ARTIFACT_DIR = Path(__file__).resolve().parent / "artifacts"

# Well-known signatures that are not in our compiled ABIs but commonly appear in DAO payloads.
EXTRA_FUNCTION_SIGNATURES = [
    "transferOwnership(address)",
    "renounceOwnership()",
    "upgradeTo(address)",
    "upgradeToAndCall(address,bytes)",
    "changeAdmin(address)",
    "setApprovalForAll(address,bool)",
    "increaseAllowance(address,uint256)",
    "decreaseAllowance(address,uint256)",
    "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)",
    "addOwnerWithThreshold(address,uint256)",
    "enableModule(address)",
    "selfdestruct(address)",
    "multicall(bytes[])",
    "setGuardian(address)",
    "pause()",
    "unpause()",
]

# Calls that change who controls funds, code or permissions.
PRIVILEGED_FUNCTIONS = {
    "approve(address,uint256)": "grants a token allowance",
    "increaseAllowance(address,uint256)": "grants a token allowance",
    "setApprovalForAll(address,bool)": "grants operator rights over all tokens",
    "grantRole(bytes32,address)": "grants an access-control role",
    "revokeRole(bytes32,address)": "revokes an access-control role",
    "renounceRole(bytes32,address)": "renounces an access-control role",
    "transferOwnership(address)": "transfers contract ownership",
    "renounceOwnership()": "removes contract ownership",
    "upgradeAndCall(address,address,bytes)": "replaces a contract's implementation code",
    "upgradeTo(address)": "replaces a contract's implementation code",
    "upgradeToAndCall(address,bytes)": "replaces a contract's implementation code",
    "changeAdmin(address)": "changes a proxy admin",
    "setFeeBps(uint16)": "changes a protocol fee parameter",
    "enableModule(address)": "adds a Safe module with full control",
    "addOwnerWithThreshold(address,uint256)": "adds a multisig owner",
    "setGuardian(address)": "changes a guardian",
    "pause()": "pauses a protocol",
}


@dataclass
class Artifact:
    name: str
    abi: list[dict[str, Any]]
    bytecode: str
    deployed_bytecode: str


@dataclass
class FunctionSig:
    selector: str
    signature: str
    name: str
    inputs: list[dict[str, Any]]
    state_mutability: str | None
    contracts: set[str] = field(default_factory=set)


@dataclass
class EventSig:
    topic: str
    signature: str
    name: str
    abi: dict[str, Any]


@dataclass
class ErrorSig:
    selector: str
    signature: str
    name: str
    inputs: list[dict[str, Any]]


def _canonical_type(param: dict[str, Any]) -> str:
    t = param["type"]
    if t.startswith("tuple"):
        inner = ",".join(_canonical_type(c) for c in param.get("components", []))
        return f"({inner}){t[5:]}"
    return t


def abi_signature(item: dict[str, Any]) -> str:
    return f"{item['name']}({','.join(_canonical_type(p) for p in item.get('inputs', []))})"


class SignatureDB:
    def __init__(self, artifacts: dict[str, Artifact]):
        self.functions: dict[str, FunctionSig] = {}
        self.events: dict[str, list[EventSig]] = {}
        self.errors: dict[str, ErrorSig] = {}
        for artifact in artifacts.values():
            for item in artifact.abi:
                kind = item.get("type")
                if kind == "function":
                    sig = abi_signature(item)
                    selector = "0x" + function_signature_to_4byte_selector(sig).hex()
                    entry = self.functions.setdefault(
                        selector,
                        FunctionSig(selector, sig, item["name"], item.get("inputs", []), item.get("stateMutability")),
                    )
                    entry.contracts.add(artifact.name)
                elif kind == "event":
                    sig = abi_signature(item)
                    topic = "0x" + keccak(text=sig).hex()
                    bucket = self.events.setdefault(topic, [])
                    if not any(e.abi.get("inputs") == item.get("inputs") for e in bucket):
                        bucket.append(EventSig(topic, sig, item["name"], item))
                elif kind == "error":
                    sig = abi_signature(item)
                    selector = "0x" + keccak(text=sig)[:4].hex()
                    self.errors.setdefault(selector, ErrorSig(selector, sig, item["name"], item.get("inputs", [])))
        for sig in EXTRA_FUNCTION_SIGNATURES:
            selector = "0x" + function_signature_to_4byte_selector(sig).hex()
            if selector not in self.functions:
                name = sig.split("(")[0]
                types = sig[len(name) + 1 : -1]
                inputs = [{"name": f"arg{i}", "type": t} for i, t in enumerate(types.split(",")) if t]
                self.functions[selector] = FunctionSig(selector, sig, name, inputs, None)
        # Standard revert payloads.
        self.errors.setdefault("0x08c379a0", ErrorSig("0x08c379a0", "Error(string)", "Error", [{"name": "message", "type": "string"}]))
        self.errors.setdefault("0x4e487b71", ErrorSig("0x4e487b71", "Panic(uint256)", "Panic", [{"name": "code", "type": "uint256"}]))

    def function(self, selector: str) -> FunctionSig | None:
        return self.functions.get(selector.lower())

    def error(self, selector: str) -> ErrorSig | None:
        return self.errors.get(selector.lower())


@lru_cache
def load_artifacts() -> dict[str, Artifact]:
    if not ARTIFACT_DIR.exists():
        raise RuntimeError(
            f"Contract artifacts not found in {ARTIFACT_DIR}. Run `npm run compile && npm run export` in contracts/."
        )
    artifacts: dict[str, Artifact] = {}
    for path in sorted(ARTIFACT_DIR.glob("*.json")):
        raw = json.loads(path.read_text(encoding="utf-8"))
        artifacts[raw["contractName"]] = Artifact(
            name=raw["contractName"],
            abi=raw["abi"],
            bytecode=raw["bytecode"],
            deployed_bytecode=raw["deployedBytecode"],
        )
    return artifacts


@lru_cache
def signature_db() -> SignatureDB:
    return SignatureDB(load_artifacts())


def abi_of(name: str) -> list[dict[str, Any]]:
    return load_artifacts()[name].abi
