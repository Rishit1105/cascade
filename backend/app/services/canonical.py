"""Canonical serialisation and hashing.

dg-canon-1: UTF-8 JSON, keys sorted, no insignificant whitespace, strings NFC-normalised,
floats forbidden (amounts are integer base units or decimal strings), datetimes as ISO-8601 UTC.
Two documents hash equal iff their canonical forms are byte-identical. A matching hash proves
the content equals what was committed. It says nothing about whether the content is true.
"""

from __future__ import annotations

import hashlib
import json
import unicodedata
from datetime import datetime
from decimal import Decimal
from typing import Any

from eth_utils import keccak

from ..clock import iso

CANON_VERSION = "dg-canon-1"
ZERO_HASH = "0x" + "00" * 32


class CanonicalizationError(ValueError):
    pass


def _normalize(value: Any, path: str = "$") -> Any:
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        raise CanonicalizationError(f"{path}: floats are not allowed in canonical documents; use base units")
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, datetime):
        return iso(value)
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if not isinstance(k, str):
                raise CanonicalizationError(f"{path}: object keys must be strings")
            out[unicodedata.normalize("NFC", k)] = _normalize(v, f"{path}.{k}")
        return out
    if isinstance(value, (list, tuple)):
        return [_normalize(v, f"{path}[{i}]") for i, v in enumerate(value)]
    raise CanonicalizationError(f"{path}: unsupported type {type(value).__name__}")


def canonical_bytes(document: Any) -> bytes:
    return json.dumps(
        _normalize(document), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def keccak_hex(data: bytes) -> str:
    return "0x" + keccak(data).hex()


def content_hash(document: Any) -> str:
    """keccak256 of the canonical form; used for on-chain commitments."""
    return keccak_hex(canonical_bytes(document))


def sha256_tagged(data: bytes) -> str:
    """Tagged SHA-256 for evidence files (matches what `sha256sum` prints)."""
    return "sha256:" + hashlib.sha256(data).hexdigest()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ------------------------------------------------------------------ merkle tree
# Sorted-pair keccak tree (OpenZeppelin MerkleProof compatible). Leaves are keccak256 of the
# 32-byte evidence digest, so an inner node can never be passed off as a leaf.


def _leaf(tagged_sha256: str) -> bytes:
    digest = bytes.fromhex(tagged_sha256.split(":", 1)[1])
    return keccak(digest)


def _pair(a: bytes, b: bytes) -> bytes:
    return keccak(a + b) if a <= b else keccak(b + a)


def merkle_root(evidence_hashes: list[str]) -> str:
    if not evidence_hashes:
        return ZERO_HASH
    level = sorted(_leaf(h) for h in evidence_hashes)
    while len(level) > 1:
        nxt = []
        for i in range(0, len(level), 2):
            nxt.append(_pair(level[i], level[i + 1]) if i + 1 < len(level) else level[i])
        level = nxt
    return "0x" + level[0].hex()


def merkle_proof(evidence_hashes: list[str], target: str) -> list[str]:
    leaves = sorted(_leaf(h) for h in evidence_hashes)
    node = _leaf(target)
    if node not in leaves:
        raise ValueError("evidence hash is not part of this set")
    proof: list[str] = []
    level = leaves
    index = level.index(node)
    while len(level) > 1:
        sibling = index ^ 1
        if sibling < len(level):
            proof.append("0x" + level[sibling].hex())
        nxt = []
        for i in range(0, len(level), 2):
            nxt.append(_pair(level[i], level[i + 1]) if i + 1 < len(level) else level[i])
        level = nxt
        index //= 2
    return proof


def verify_merkle_proof(proof: list[str], root: str, target: str) -> bool:
    node = _leaf(target)
    for sibling in proof:
        node = _pair(node, bytes.fromhex(sibling[2:]))
    return "0x" + node.hex() == root.lower()
