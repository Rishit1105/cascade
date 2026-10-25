"""Composite read models for the UI: proposal list/detail, overview, search, address & tx detail."""

from __future__ import annotations

import re
from collections import Counter
from decimal import Decimal
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..clock import iso
from ..models import (AddressLabel, Alert, AuditEvent, Challenge, ExecutionAttempt, ExecutionCheck, Finding, MilestoneTracking,
                      Proposal, Simulation)
from ..runtime import runtime
from . import coi, governance, risk_chain
from .alerts import serialize as serialize_alert
from .analysis.service import latest as latest_analysis
from .analysis.service import serialize as serialize_analysis
from .audit import serialize as serialize_event
from .decoder import decode_calldata, describe_action
from .evidence import serialize as serialize_evidence
from .findings import active_findings
from .findings import serialize as serialize_finding
from .labels import Labeler, format_units
from .proposals import build_actions, latest_disclosure, latest_version
from .treasury import treasury_balance

CLOSED = {"executed", "defeated", "halted"}


def _guard_status(p: Proposal) -> str:
    deployment = runtime.require_deployment()
    guard = runtime.chain.contract("ExecutionGuard", deployment.c("guard"))
    return ["none", "approved", "executed", "halted"][int(guard.functions.approvalOf(bytes.fromhex(p.key[2:])).call()[4])]


def proposal_item(db: Session, p: Proposal) -> dict[str, Any]:
    findings = active_findings(db, p.id)
    counts = Counter(f.severity for f in findings if f.status in ("open", "challenged"))
    v = latest_version(p)
    return {
        "id": p.id, "title": p.title, "summary": p.summary, "category": p.category, "status": p.status,
        "proposer_address": p.proposer_address, "proposer_label": p.proposer_label,
        "recipient_address": p.recipient_address, "recipient_label": p.recipient_label,
        "requested_amount_base": p.requested_amount_base, "requested_display": f"{format_units(p.requested_amount_base, p.token_decimals)} {p.token_symbol}",
        "token_symbol": p.token_symbol, "current_version": p.current_version, "governance_status": v.governance_status if v else "no_version",
        "guard_status": _guard_status(p), "evidence_count": len(p.evidence), "open_findings": dict(counts),
        "created_at": iso(p.created_at), "updated_at": iso(p.updated_at), "is_demo": p.is_demo,
    }


def list_proposals(db: Session, status: str | None = None, q: str | None = None, category: str | None = None,
                   min_amount: int | None = None, max_amount: int | None = None) -> list[dict[str, Any]]:
    items = []
    for p in db.scalars(select(Proposal).order_by(Proposal.id.desc())):
        if status and p.status != status:
            continue
        if category and p.category != category:
            continue
        if q and q.lower() not in f"{p.id} {p.title} {p.summary} {p.proposer_label} {p.recipient_label}".lower():
            continue
        amount = int(p.requested_amount_base or 0)
        if min_amount is not None and amount < min_amount:
            continue
        if max_amount is not None and amount > max_amount:
            continue
        items.append(proposal_item(db, p))
    return items


def proposal_detail(db: Session, p: Proposal) -> dict[str, Any]:
    deployment = runtime.require_deployment()
    labeler = Labeler(db)
    item = proposal_item(db, p)
    try:
        draft = [describe_action(a, labeler) for a in build_actions(p.draft_actions or [], deployment)]
        draft_error = None
    except Exception as exc:
        draft, draft_error = [], str(exc)
    disclosure = latest_disclosure(db, p.id)
    run = latest_analysis(db, p.id)
    tracking = {m.index: m for m in db.scalars(select(MilestoneTracking).where(MilestoneTracking.proposal_id == p.id))}
    sims = list(db.scalars(select(Simulation).where(Simulation.proposal_id == p.id).order_by(Simulation.started_at.desc())))
    return {
        **item,
        "key": p.key,
        "token_address": p.token_address,
        "token_decimals": p.token_decimals,
        "treasury_address": p.treasury_address,
        "purpose": p.purpose,
        "body": p.body,
        "milestones": [
            {**m, "tracking": {"status": tracking[i].status, "note": tracking[i].note, "verification": tracking[i].verification,
                               "evidence_refs": tracking[i].evidence_refs, "updated_at": iso(tracking[i].updated_at), "updated_by": tracking[i].updated_by}
             if i in tracking else None}
            for i, m in enumerate(p.milestones or [])
        ],
        "risks": p.risks, "assumptions": p.assumptions, "benefits": p.benefits, "budget_breakdown": p.budget_breakdown,
        "draft_actions": p.draft_actions, "draft_decoded": draft, "draft_error": draft_error,
        "versions": [
            {"version": v.version, "content_hash": v.content_hash, "manifest_hash": v.manifest_hash, "evidence_root": v.evidence_root,
             "disclosure_hash": v.disclosure_hash, "committed_at": iso(v.committed_at), "author": v.author, "tx_hash": v.tx_hash,
             "block_number": v.block_number, "governance_status": v.governance_status, "governor_proposal_id": v.governor_proposal_id,
             "changed_fields": v.changed_fields, "change_note": v.change_note}
            for v in p.versions
        ],
        "evidence": [serialize_evidence(e) for e in p.evidence],
        "disclosure": {"id": disclosure.id, "statement": disclosure.statement, "disclosure_hash": disclosure.disclosure_hash,
                       "signer": disclosure.signer, "created_at": iso(disclosure.created_at)} if disclosure else None,
        "analysis": serialize_analysis(run) if run else None,
        "findings": [serialize_finding(f) for f in active_findings(db, p.id)],
        "challenges": [
            {"id": c.id, "finding_id": c.finding_id, "author": c.author, "statement": c.statement, "counter_evidence": c.counter_evidence,
             "status": c.status, "reviewer": c.reviewer, "response": c.response, "created_at": iso(c.created_at), "responded_at": iso(c.responded_at)}
            for c in db.scalars(select(Challenge).where(Challenge.proposal_id == p.id).order_by(Challenge.created_at))
        ],
        "simulations": [{"id": s.id, "version": s.version, "verdict": s.verdict, "trigger": s.trigger, "scenario": s.scenario,
                         "finished_at": iso(s.finished_at), "summary": (s.report or {}).get("summary")} for s in sims[:6]],
        "governance": governance.state(db, p),
    }


def overview(db: Session) -> dict[str, Any]:
    proposals = list(db.scalars(select(Proposal).order_by(Proposal.id)))
    balance = treasury_balance() or 0
    attempts = list(db.scalars(select(ExecutionAttempt)))
    checks = list(db.scalars(select(ExecutionCheck)))
    open_alerts = list(db.scalars(select(Alert).where(Alert.status.in_(["new", "triaged", "escalated"])).order_by(Alert.created_at.desc())))
    under_review = [p for p in proposals if p.status not in CLOSED]
    needing_review = []
    pipeline = []
    for p in proposals:
        findings = [f for f in active_findings(db, p.id) if f.status in ("open", "challenged")]
        if any(f.severity in ("critical", "high") for f in findings) or p.status in ("draft", "in_review"):
            needing_review.append(p.id)
        gov = governance.state(db, p)
        chain_eval = risk_chain.evaluate(db, p, gov)
        pipeline.append({"proposal": proposal_item(db, p), "evaluation": chain_eval})
    sev = Counter(a.severity for a in open_alerts)
    return {
        "data_label": "Demo data: fictional DAO on a local chain.",
        "metrics": {
            "active_proposals": len(under_review),
            "needing_review": len(needing_review),
            "needing_review_ids": needing_review,
            "checks_passed": sum(1 for c in checks if c.status == "MATCH"),
            "checks_mismatched": sum(1 for c in checks if c.status == "MISMATCH"),
            "executions_succeeded": sum(1 for a in attempts if a.outcome == "executed"),
            "executions_blocked": sum(1 for a in attempts if a.outcome == "rejected"),
            "treasury_balance_base": str(balance),
            "allocation_under_review_base": str(sum(int(p.requested_amount_base or 0) for p in under_review)),
            "allocation_share_pct": f"{Decimal(sum(int(p.requested_amount_base or 0) for p in under_review)) * 100 / Decimal(balance):.1f}" if balance else "0",
            "open_alerts": len(open_alerts),
            "open_alerts_by_severity": dict(sev),
        },
        "pipeline": pipeline,
        "recent_events": [serialize_event(e) for e in db.scalars(select(AuditEvent).order_by(AuditEvent.seq.desc()).limit(12))],
        "alerts": [serialize_alert(a) for a in open_alerts[:6]],
        "sentinel": runtime.sentinel.status if runtime.sentinel else {"running": False},
        "block_number": runtime.chain.block_number(),
    }


def search(db: Session, q: str) -> list[dict[str, Any]]:
    q = q.strip()
    if len(q) < 2:
        return []
    out: list[dict[str, Any]] = []
    like = f"%{q}%"
    for p in db.scalars(select(Proposal).where(or_(Proposal.id.ilike(like), Proposal.title.ilike(like), Proposal.summary.ilike(like))).limit(8)):
        out.append({"type": "proposal", "id": p.id, "title": f"{p.id} · {p.title}", "subtitle": p.status, "link": f"/proposals/{p.id}"})
    for a in db.scalars(select(AddressLabel).where(or_(AddressLabel.label.ilike(like), AddressLabel.address.ilike(like))).limit(8)):
        out.append({"type": "address", "id": a.address, "title": a.label, "subtitle": a.address, "link": f"/relationships?focus={a.address.lower()}"})
    if re.fullmatch(r"0x[0-9a-fA-F]{64}", q):
        out.append({"type": "transaction", "id": q, "title": f"Transaction {q[:12]}…", "subtitle": "open in the explorer drawer", "link": f"/audit?tx={q}"})
    for f in db.scalars(select(Finding).where(Finding.title.ilike(like), Finding.superseded_at.is_(None)).limit(6)):
        out.append({"type": "finding", "id": f.id, "title": f.title, "subtitle": f"{f.proposal_id} · {f.severity}", "link": f"/proposals/{f.proposal_id}?tab=findings"})
    for e in db.scalars(select(AuditEvent).where(AuditEvent.summary.ilike(like)).order_by(AuditEvent.seq.desc()).limit(6)):
        out.append({"type": "event", "id": e.id, "title": e.summary[:90], "subtitle": f"{e.event_type} · {iso(e.occurred_at)}", "link": f"/audit?event={e.id}"})
    return out


def address_detail(db: Session, address: str) -> dict[str, Any]:
    deployment = runtime.require_deployment()
    chain = runtime.chain
    labeler = Labeler(db)
    usdc = chain.contract("MockUSDC", deployment.c("usdc"))
    atlas = chain.contract("AtlasToken", deployment.c("atlas"))
    code = chain.get_code(address)
    graph = coi.build_graph(db)
    edges = [e for e in graph["edges"] if e["source"] == address.lower() or e["target"] == address.lower()]
    return {
        "address": address, "label": labeler.label(address), "kind": labeler.kind(address), "role": labeler.role(address),
        "is_contract": code not in ("0x", "0x0"), "code_size": (len(code) - 2) // 2,
        "balances": {"ETH": format_units(chain.get_balance(address), 18, 4), "mUSDC": format_units(usdc.functions.balanceOf(address).call(), 6),
                     "ATLAS": format_units(atlas.functions.balanceOf(address).call(), 18, 0)},
        "voting_power": format_units(atlas.functions.getVotes(address).call(), 18, 0),
        "relationships": edges,
        "note": "Labels are demo annotations, not identity claims.",
    }


def tx_detail(db: Session, tx_hash: str) -> dict[str, Any]:
    chain = runtime.chain
    labeler = Labeler(db)
    tx = chain.get_transaction(tx_hash)
    if tx is None:
        return {"tx_hash": tx_hash, "found": False}
    base = coi.verify_transaction(tx_hash)
    decoded = decode_calldata(tx.get("input") or "0x")
    events = list(db.scalars(select(AuditEvent).where(AuditEvent.tx_hash == tx_hash)))
    return {
        **base,
        "from_label": labeler.label(tx["from"]), "to_label": labeler.label(tx.get("to")),
        "value_wei": str(int(tx.get("value", "0x0"), 16)), "input": tx.get("input"), "decoded_input": decoded,
        "audit_events": [serialize_event(e) for e in events],
        "explorer_note": "Local chain explorer: read directly from the Hardhat node. No public explorer indexes this chain.",
    }


def counts(db: Session) -> dict[str, int]:
    return {"alerts_open": db.scalar(select(func.count()).select_from(Alert).where(Alert.status.in_(["new", "triaged", "escalated"]))) or 0}
