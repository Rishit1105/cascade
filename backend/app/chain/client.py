"""Thin, explicit JSON-RPC client for the local Hardhat demo chain.

All state-changing chain work (transactions, snapshots, simulations) runs under one re-entrant
lock: a simulation snapshots and reverts the chain, so nothing else may write in between.
Reverted transactions are mined by the demo node (status 0) and their revert data is recovered
from debug_traceTransaction, so a contract-enforced rejection always has a real tx hash.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Any

from eth_abi import decode as abi_decode
from eth_utils import to_checksum_address
from web3 import Web3
from web3.contract import Contract

from .artifacts import load_artifacts, signature_db
from .errors import decode_revert

log = logging.getLogger("daoguard.chain")


class ChainUnavailable(RuntimeError):
    pass


class ChainRPCError(RuntimeError):
    def __init__(self, method: str, error: dict[str, Any]):
        super().__init__(f"{method} failed: {error.get('message')}")
        self.method = method
        self.error = error


class TxReverted(RuntimeError):
    """Raised when a transaction we expected to succeed would revert. Nothing was sent."""

    def __init__(self, revert: dict[str, Any] | None, context: str = ""):
        message = (revert or {}).get("explanation") or "transaction would revert"
        super().__init__(f"{context}: {message}" if context else message)
        self.revert = revert


@dataclass
class TxResult:
    tx_hash: str
    block_number: int
    status: int
    gas_used: int
    timestamp: int
    sender: str
    to: str | None
    logs: list[dict[str, Any]] = field(default_factory=list)
    revert: dict[str, Any] | None = None
    contract_address: str | None = None

    @property
    def ok(self) -> bool:
        return self.status == 1

    def as_dict(self) -> dict[str, Any]:
        return {
            "tx_hash": self.tx_hash,
            "block_number": self.block_number,
            "status": "success" if self.ok else "reverted",
            "gas_used": self.gas_used,
            "timestamp": self.timestamp,
            "from": self.sender,
            "to": self.to,
            "logs": self.logs,
            "revert": self.revert,
        }


def _extract_revert_data(error: dict[str, Any]) -> str | None:
    data = error.get("data")
    if isinstance(data, str) and data.startswith("0x"):
        return data
    if isinstance(data, dict):
        inner = data.get("data")
        if isinstance(inner, str) and inner.startswith("0x"):
            return inner
    return None


class _LockedHTTPProvider(Web3.HTTPProvider):
    """Every RPC call, including web3 contract reads, takes the chain lock. A simulation holds the
    lock (re-entrantly) from snapshot to revert, so no other thread can read transient state."""

    def __init__(self, url: str, lock: threading.RLock):
        super().__init__(url, request_kwargs={"timeout": 60})
        self._chain_lock = lock

    def make_request(self, method, params):  # type: ignore[override]
        with self._chain_lock:
            return super().make_request(method, params)


class ChainClient:
    def __init__(self, rpc_url: str):
        self.rpc_url = rpc_url
        self.lock = threading.RLock()
        self.w3 = Web3(_LockedHTTPProvider(rpc_url, self.lock))
        self._contracts: dict[tuple[str, str], Contract] = {}

    # ---------------------------------------------------------------- basics
    def rpc(self, method: str, params: list[Any] | None = None) -> Any:
        try:
            response = self.w3.provider.make_request(method, params or [])
        except Exception as exc:  # connection refused, timeout
            raise ChainUnavailable(f"Local chain not reachable at {self.rpc_url}: {exc}") from exc
        if "error" in response and response["error"]:
            raise ChainRPCError(method, dict(response["error"]))
        return response.get("result")

    def is_connected(self) -> bool:
        try:
            self.rpc("eth_chainId")
            return True
        except Exception:
            return False

    def client_version(self) -> str:
        return str(self.rpc("web3_clientVersion"))

    @property
    def chain_id(self) -> int:
        return int(self.rpc("eth_chainId"), 16)

    def block_number(self) -> int:
        return int(self.rpc("eth_blockNumber"), 16)

    def block(self, number: int | str = "latest") -> dict[str, Any]:
        tag = hex(number) if isinstance(number, int) else number
        return self.rpc("eth_getBlockByNumber", [tag, False])

    def latest_timestamp(self) -> int:
        return int(self.block("latest")["timestamp"], 16)

    def genesis_hash(self) -> str:
        return self.block(0)["hash"]

    def accounts(self) -> list[str]:
        return [to_checksum_address(a) for a in self.rpc("eth_accounts")]

    def get_code(self, address: str) -> str:
        return self.rpc("eth_getCode", [address, "latest"])

    def get_storage(self, address: str, slot: str | int) -> str:
        slot_hex = slot if isinstance(slot, str) else hex(slot)
        return self.rpc("eth_getStorageAt", [address, slot_hex, "latest"])

    def get_balance(self, address: str) -> int:
        return int(self.rpc("eth_getBalance", [address, "latest"]), 16)

    def get_transaction(self, tx_hash: str) -> dict[str, Any] | None:
        return self.rpc("eth_getTransactionByHash", [tx_hash])

    def get_receipt(self, tx_hash: str) -> dict[str, Any] | None:
        return self.rpc("eth_getTransactionReceipt", [tx_hash])

    # ------------------------------------------------------------ contracts
    def contract(self, name: str, address: str) -> Contract:
        key = (name, address.lower())
        if key not in self._contracts:
            abi = load_artifacts()[name].abi
            self._contracts[key] = self.w3.eth.contract(address=to_checksum_address(address), abi=abi)
        return self._contracts[key]

    def encode(self, contract: Contract, fn_name: str, args: list[Any]) -> str:
        return contract.encode_abi(fn_name, args=args)

    def read(self, contract: Contract, fn_name: str, *args: Any) -> Any:
        return contract.functions[fn_name](*args).call()

    def call_raw(
        self, to: str, data: str, sender: str | None = None, value: int = 0, block: str = "latest"
    ) -> dict[str, Any]:
        """eth_call that never raises on revert: returns {ok, data} or {ok: False, revert}."""
        tx: dict[str, Any] = {"to": to, "data": data}
        if sender:
            tx["from"] = sender
        if value:
            tx["value"] = hex(value)
        try:
            return {"ok": True, "data": self.rpc("eth_call", [tx, block])}
        except ChainRPCError as exc:
            revert_data = _extract_revert_data(exc.error)
            decoded = decode_revert(revert_data) if revert_data else None
            if decoded is None:
                decoded = {
                    "name": "RPCError",
                    "signature": None,
                    "selector": None,
                    "args": {},
                    "explanation": exc.error.get("message", "call failed"),
                }
            return {"ok": False, "revert": decoded}

    def call_fn(self, contract: Contract, fn_name: str, args: list[Any], sender: str | None = None) -> dict[str, Any]:
        data = self.encode(contract, fn_name, args)
        result = self.call_raw(contract.address, data, sender=sender)
        if result["ok"]:
            fn_abi = next(i for i in contract.abi if i.get("type") == "function" and i["name"] == fn_name)
            types = [o["type"] for o in fn_abi.get("outputs", [])]
            raw = bytes.fromhex(result["data"][2:])
            result["value"] = abi_decode(types, raw) if types else ()
        return result

    # --------------------------------------------------------- transactions
    def send(
        self,
        sender: str,
        to: str | None,
        data: str = "0x",
        value: int = 0,
        *,
        allow_revert: bool = False,
        gas: int | None = None,
        context: str = "",
    ) -> TxResult:
        """Send a transaction from an unlocked/impersonated account and wait for its receipt.

        With allow_revert=False the call is dry-run first and a revert raises TxReverted without
        sending anything. With allow_revert=True a reverting transaction is still mined so the
        rejection is recorded on-chain.
        """
        with self.lock:
            tx: dict[str, Any] = {"from": sender, "data": data}
            if to:
                tx["to"] = to
            if value:
                tx["value"] = hex(value)
            if gas is None:
                try:
                    estimate = int(self.rpc("eth_estimateGas", [tx]), 16)
                    gas = int(estimate * 1.3) + 60_000
                except ChainRPCError as exc:
                    revert_data = _extract_revert_data(exc.error)
                    decoded = decode_revert(revert_data) if revert_data else {
                        "name": "EstimateFailed",
                        "signature": None,
                        "selector": None,
                        "args": {},
                        "explanation": exc.error.get("message", "gas estimation failed"),
                    }
                    if not allow_revert:
                        raise TxReverted(decoded, context) from exc
                    gas = 3_000_000
            tx["gas"] = hex(gas)
            tx_hash = self.rpc("eth_sendTransaction", [tx])
            receipt = self.get_receipt(tx_hash)
            if receipt is None:  # automine is on; this only happens if the node is misconfigured
                receipt = dict(self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=30))
            return self._result(tx_hash, receipt, sender, to)

    def transact(
        self,
        contract: Contract,
        fn_name: str,
        args: list[Any],
        sender: str,
        *,
        value: int = 0,
        allow_revert: bool = False,
        gas: int | None = None,
    ) -> TxResult:
        data = self.encode(contract, fn_name, args)
        return self.send(
            sender, contract.address, data, value, allow_revert=allow_revert, gas=gas, context=f"{fn_name}()"
        )

    def deploy(self, name: str, args: list[Any], sender: str) -> TxResult:
        artifact = load_artifacts()[name]
        factory = self.w3.eth.contract(abi=artifact.abi, bytecode=artifact.bytecode)
        data = factory.constructor(*args).data_in_transaction
        result = self.send(sender, None, data, context=f"deploy {name}")
        if not result.ok or not result.contract_address:
            raise RuntimeError(f"Deployment of {name} failed: {result.revert}")
        return result

    def _result(self, tx_hash: str, receipt: dict[str, Any], sender: str, to: str | None) -> TxResult:
        status = int(receipt["status"], 16) if isinstance(receipt["status"], str) else int(receipt["status"])
        block_number = (
            int(receipt["blockNumber"], 16) if isinstance(receipt["blockNumber"], str) else int(receipt["blockNumber"])
        )
        gas_used = int(receipt["gasUsed"], 16) if isinstance(receipt["gasUsed"], str) else int(receipt["gasUsed"])
        block = self.block(block_number)
        result = TxResult(
            tx_hash=tx_hash if isinstance(tx_hash, str) else "0x" + bytes(tx_hash).hex(),
            block_number=block_number,
            status=status,
            gas_used=gas_used,
            timestamp=int(block["timestamp"], 16),
            sender=to_checksum_address(sender),
            to=to_checksum_address(to) if to else None,
            logs=decode_logs(receipt.get("logs", [])),
            contract_address=to_checksum_address(receipt["contractAddress"]) if receipt.get("contractAddress") else None,
        )
        if status == 0:
            result.revert = self.revert_reason(result.tx_hash)
        return result

    def revert_reason(self, tx_hash: str) -> dict[str, Any] | None:
        try:
            trace = self.rpc(
                "debug_traceTransaction",
                [tx_hash, {"disableStorage": True, "disableMemory": True, "disableStack": True}],
            )
        except Exception as exc:  # tracing is best-effort context, the status is authoritative
            log.warning("could not trace reverted tx %s: %s", tx_hash, exc)
            return {"name": "Reverted", "signature": None, "selector": None, "args": {}, "explanation": "Transaction reverted."}
        ret = trace.get("returnValue") or ""
        if ret and not ret.startswith("0x"):
            ret = "0x" + ret
        return decode_revert(ret or "0x")

    # ------------------------------------------------------- dev-chain tools
    def snapshot(self) -> str:
        return self.rpc("evm_snapshot")

    def revert_to(self, snapshot_id: str) -> bool:
        return bool(self.rpc("evm_revert", [snapshot_id]))

    def mine(self, blocks: int = 1, interval_seconds: int | None = None) -> None:
        params = [hex(blocks)]
        if interval_seconds is not None:
            params.append(hex(interval_seconds))
        self.rpc("hardhat_mine", params)

    def increase_time(self, seconds: int) -> None:
        if seconds > 0:
            self.rpc("evm_increaseTime", [seconds])

    def impersonate(self, address: str) -> None:
        self.rpc("hardhat_impersonateAccount", [address])

    def stop_impersonating(self, address: str) -> None:
        self.rpc("hardhat_stopImpersonatingAccount", [address])

    def set_balance(self, address: str, wei: int) -> None:
        self.rpc("hardhat_setBalance", [address, hex(wei)])

    def reset(self) -> None:
        self.rpc("hardhat_reset", [])

    def sign_typed_data(self, signer: str, typed_data: dict[str, Any]) -> str:
        import json

        return self.rpc("eth_signTypedData_v4", [signer, json.dumps(typed_data)])

    def get_logs(self, address: str | list[str], topics: list[Any], from_block: int, to_block: int | str = "latest") -> list[dict[str, Any]]:
        params = {
            "address": address,
            "topics": topics,
            "fromBlock": hex(from_block),
            "toBlock": hex(to_block) if isinstance(to_block, int) else to_block,
        }
        return decode_logs(self.rpc("eth_getLogs", [params]))


def _hex(value: Any) -> str:
    if isinstance(value, str):
        return value if value.startswith("0x") else "0x" + value
    return "0x" + bytes(value).hex()


def _fmt_value(value: Any, typ: str) -> Any:
    if typ == "address":
        return to_checksum_address(value)
    if typ.startswith("bytes") and typ != "bytes[]":
        return "0x" + bytes(value).hex()
    if typ.startswith(("uint", "int")):
        return str(value)
    if typ == "bool":
        return bool(value)
    if isinstance(value, (list, tuple)):
        return [_fmt_value(v, typ.rstrip("[]")) for v in value]
    return value


def decode_log(raw: dict[str, Any]) -> dict[str, Any]:
    topics = [_hex(t) for t in raw.get("topics", [])]
    data = bytes.fromhex(_hex(raw.get("data", "0x"))[2:])
    base = {
        "address": to_checksum_address(raw["address"]),
        "tx_hash": _hex(raw.get("transactionHash")) if raw.get("transactionHash") else None,
        "block_number": int(raw["blockNumber"], 16) if isinstance(raw.get("blockNumber"), str) else raw.get("blockNumber"),
        "log_index": int(raw["logIndex"], 16) if isinstance(raw.get("logIndex"), str) else raw.get("logIndex"),
        "topic0": topics[0] if topics else None,
    }
    if not topics:
        return {**base, "event": None, "args": {}}
    for event in signature_db().events.get(topics[0].lower(), []):
        inputs = event.abi.get("inputs", [])
        indexed = [i for i in inputs if i.get("indexed")]
        if len(indexed) != len(topics) - 1:
            continue
        try:
            args: dict[str, Any] = {}
            for inp, topic in zip(indexed, topics[1:]):
                typ = inp["type"]
                if typ in ("string", "bytes") or typ.endswith("]") or typ.startswith("tuple"):
                    args[inp["name"]] = topic  # dynamic indexed values are hashed
                else:
                    args[inp["name"]] = _fmt_value(abi_decode([typ], bytes.fromhex(topic[2:]))[0], typ)
            plain = [i for i in inputs if not i.get("indexed")]
            if plain:
                values = abi_decode([i["type"] for i in plain], data)
                for inp, val in zip(plain, values):
                    args[inp["name"]] = _fmt_value(val, inp["type"])
            return {**base, "event": event.name, "signature": event.signature, "args": args}
        except Exception:
            continue
    return {**base, "event": None, "args": {}, "data": "0x" + data.hex()}


def decode_logs(raw_logs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [decode_log(dict(log)) for log in raw_logs]
