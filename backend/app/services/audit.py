"""Append-only, hash-chained audit ledger with optional on-chain anchoring.

event_hash = sha256(canonical({"event": <fields>, "prev": prev_hash})). Any edit to a stored
event, or a deleted / reordered event, breaks every later link and is reported by verify().
Off-chain events are labelled "off-chain"; only events backed by a mined transaction are
"chain-confirmed", and verify() re-checks those receipts against the node.
"""

from __future__ import annotations

import logging
import secrets
import threading
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..chain.client import TxResult
from ..clock import from_timestamp, iso, utcnow
from ..db import SessionLocal
from ..models import AuditAnchor, AuditEvent
from ..runtime import runtime
from .canonical import canonical_bytes, sha256_hex

log = logging.getLogger("daoguard.audit")
GENESIS_HASH = "sha256:" + "0" * 64
_append_lock = threading.Lock()


def _material(ev: AuditEvent) -> dict[str, Any]:
    return {
        "id": ev.id,
        "proposal_id": ev.proposal_id,
        "event_type": ev.event_type,
        "actor": ev.actor,
        "source": ev.source,
        "verification": ev.verification,
        "status": ev.status,
        "summary": ev.summary,
        "occurred_at": iso(ev.occurred_at),
        "proposal_version": ev.proposal_version,
        "manifest_hash": ev.manifest_hash,
        "tx_hash": ev.tx_hash,
        "block_number": ev.block_number,
        "details": ev.details or {},
    }


def compute_event_hash(ev: AuditEvent, prev_hash: str) -> str:
    return "sha256:" + sha256_hex(canonical_bytes({"event": _material(ev), "prev": prev_hash}))


def record(
    *,
    event_type: str,
    summary: str,
    actor: str,
    source: str = "api",
    status: str = "info",
    proposal_id: str | None = None,
    version: int | None = None,
    manifest_hash: str | None = None,
    tx: TxResult | None = None,
    tx_hash: str | None = None,
    block_number: int | None = None,
    occurred_at: datetime | None = None,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Append one event in its own transaction so the chain of hashes is never interleaved."""
    if tx is not None:
        tx_hash, block_number = tx.tx_hash, tx.block_number
        occurred_at = occurred_at or from_timestamp(tx.timestamp)
    verification = "chain-confirmed" if tx_hash else "off-chain"
    with _append_lock:
        db = SessionLocal()
        try:
            last = db.scalars(select(AuditEvent).order_by(AuditEvent.seq.desc()).limit(1)).first()
            prev_hash = last.event_hash if last else GENESIS_HASH
            ev = AuditEvent(
                id=f"EV-{secrets.token_hex(5).upper()}",
                proposal_id=proposal_id,
                event_type=event_type,
                actor=actor,
                source=source,
                verification=verification,
                status=status,
                summary=summary,
                occurred_at=occurred_at or utcnow(),
                proposal_version=version,
                manifest_hash=manifest_hash,
                tx_hash=tx_hash,
                block_number=block_number,
                details=details or {},
                prev_hash=prev_hash,
                event_hash="",
            )
            ev.event_hash = compute_event_hash(ev, prev_hash)
            db.add(ev)
            db.commit()
            return serialize(ev)
        finally:
            db.close()


def serialize(ev: AuditEvent) -> dict[str, Any]:
    data = _material(ev)
    data.update({"seq": ev.seq, "prev_hash": ev.prev_hash, "event_hash": ev.event_hash})
    return data


def head(db: Session) -> tuple[int, str]:
    last = db.scalars(select(AuditEvent).order_by(AuditEvent.seq.desc()).limit(1)).first()
    return (last.seq, last.event_hash) if last else (0, GENESIS_HASH)


def anchor(db: Session, actor: str = "DAOGuard sentinel", source: str = "api") -> dict[str, Any]:
    """Publish the current ledger head to ProposalRegistry.anchorAudit (hash only)."""
    deployment = runtime.require_deployment()
    chain = runtime.chain
    seq, head_hash = head(db)
    head_bytes = bytes.fromhex(head_hash.split(":", 1)[1])
    count = db.scalar(select(func.count()).select_from(AuditEvent)) or 0
    registry = chain.contract("ProposalRegistry", deployment.c("registry"))
    tx = chain.transact(registry, "anchorAudit", [head_bytes, count], deployment.a("sentinel"))
    row = AuditAnchor(seq_upto=seq, ledger_head=head_hash, tx_hash=tx.tx_hash, block_number=tx.block_number,
                      anchored_at=from_timestamp(tx.timestamp))
    db.add(row)
    db.commit()
    record(
        event_type="ledger_anchored",
        summary=f"Audit ledger head (event #{seq}) anchored on-chain in ProposalRegistry.",
        actor=actor,
        source=source,
        status="success",
        tx=tx,
        details={"seq_upto": seq, "ledger_head": head_hash, "event_count": count},
    )
    return {"seq_upto": seq, "ledger_head": head_hash, "tx_hash": tx.tx_hash, "block_number": tx.block_number}


def verify(db: Session, check_chain: bool = True) -> dict[str, Any]:
    events = list(db.scalars(select(AuditEvent).order_by(AuditEvent.seq)))
    prev = GENESIS_HASH
    breaks: list[dict[str, Any]] = []
    heads: dict[int, str] = {}
    for ev in events:
        if ev.prev_hash != prev:
            breaks.append({"seq": ev.seq, "id": ev.id, "problem": "prev_hash does not link to the previous event"})
        expected = compute_event_hash(ev, ev.prev_hash)
        if expected != ev.event_hash:
            breaks.append({"seq": ev.seq, "id": ev.id, "problem": "stored content does not match its event hash"})
        prev = ev.event_hash
        heads[ev.seq] = ev.event_hash

    chain_checks = {"checked": 0, "confirmed": 0, "mismatched": [], "skipped": False}
    anchors_out: list[dict[str, Any]] = []
    if check_chain and runtime.deployment is not None and runtime.chain.is_connected():
        for ev in events:
            if not ev.tx_hash:
                continue
            chain_checks["checked"] += 1
            receipt = runtime.chain.get_receipt(ev.tx_hash)
            if receipt is None:
                chain_checks["mismatched"].append({"seq": ev.seq, "tx_hash": ev.tx_hash, "problem": "transaction not found on node"})
                continue
            block = int(receipt["blockNumber"], 16)
            if ev.block_number is not None and block != ev.block_number:
                chain_checks["mismatched"].append({"seq": ev.seq, "tx_hash": ev.tx_hash, "problem": f"block {block} != recorded {ev.block_number}"})
                continue
            chain_checks["confirmed"] += 1
        registry_addr = runtime.deployment.c("registry")
        onchain = {
            log_["args"]["ledgerHead"].lower(): log_
            for log_ in runtime.chain.get_logs(registry_addr, [], 0)
            if log_.get("event") == "AuditAnchored"
        }
        for anchor_row in db.scalars(select(AuditAnchor).order_by(AuditAnchor.id)):
            head_hex = "0x" + anchor_row.ledger_head.split(":", 1)[1]
            on = onchain.get(head_hex.lower())
            recomputed = heads.get(anchor_row.seq_upto)
            anchors_out.append(
                {
                    "seq_upto": anchor_row.seq_upto,
                    "ledger_head": anchor_row.ledger_head,
                    "tx_hash": anchor_row.tx_hash,
                    "block_number": anchor_row.block_number,
                    "found_on_chain": on is not None,
                    "matches_recomputed_ledger": recomputed == anchor_row.ledger_head,
                }
            )
    else:
        chain_checks["skipped"] = True

    ok = not breaks and not chain_checks["mismatched"] and all(
        a["found_on_chain"] and a["matches_recomputed_ledger"] for a in anchors_out
    )
    return {
        "ok": ok,
        "event_count": len(events),
        "head": events[-1].event_hash if events else GENESIS_HASH,
        "breaks": breaks,
        "chain_receipts": chain_checks,
        "anchors": anchors_out,
        "verified_at": iso(utcnow()),
        "note": "Hash links prove the ledger was not edited after the fact. They do not prove that the recorded off-chain statements are true.",
    }
