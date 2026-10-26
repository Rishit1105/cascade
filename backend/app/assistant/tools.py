"""Read-only live-data tools for the assistant. Each returns compact JSON-safe data built from the
same services the pages use. None of them can vote, execute, halt, sign or write anything."""

from __future__ import annotations

import logging
import re
from typing import Any, Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..errors import DomainError
from ..models import Alert, AuditEvent, Proposal, Question, Simulation
from ..services import audit, governance, policy, proposals, risk_chain, treasury, views, voting
from ..services.findings import active_findings
from ..services.labels import format_units
from . import kb

log = logging.getLogger("daoguard.assistant")

PID = re.compile(r"\bGOV-\d{3,}\b", re.I)


def _usdc(base: Any) -> str:
    return f"{format_units(int(base), 6)} mUSDC"


def _proposal(db: Session, proposal_id: str) -> Proposal:
    return proposals.get_proposal(db, str(proposal_id).strip().upper())


def _open_findings(db: Session, p: Proposal, kinds: list[str] | None = None) -> list[dict[str, Any]]:
    out = []
    for f in active_findings(db, p.id, kinds):
        if f.status in ("open", "challenged"):
            out.append({"id": f.id, "rule": f.rule_id, "kind": f.kind, "severity": f.severity, "status": f.status, "title": f.title,
                        "explanation": f.explanation[:420], "ask": (f.remediation or "")[:240]})
    return out


def list_proposals(db: Session) -> dict[str, Any]:
    items = []
    for p in db.scalars(select(Proposal).order_by(Proposal.id)):
        item = views.proposal_item(db, p)
        gov = governance.state(db, p)
        ev = risk_chain.evaluate(db, p, gov)
        items.append({
            "id": p.id, "title": p.title, "category": p.category, "status": p.status, "requested": item["requested_display"], "requested_base": p.requested_amount_base,
            "proposer": p.proposer_label, "recipient": p.recipient_label, "guard_status": item["guard_status"],
            "open_findings_by_severity": item["open_findings"], "combined_estimate_pct": round(ev["overall"] * 100, 1),
            "riskiest_stage": max(ev["stages"], key=lambda s: s["posterior"])["name"], "page": f"/proposals/{p.id}",
        })
    return {"proposals": items, "note": "combined_estimate_pct is the evaluation chain's model estimate, not a probability of fraud."}


def get_proposal(db: Session, proposal_id: str) -> dict[str, Any]:
    p = _proposal(db, proposal_id)
    item = views.proposal_item(db, p)
    gov = governance.state(db, p)
    v = proposals.latest_version(p)
    brief = None
    from ..services.analysis.service import latest as latest_analysis

    run = latest_analysis(db, p.id)
    if run and isinstance(run.output, dict):
        o = run.output
        brief = {
            "summary": [c.get("text") for c in (o.get("summary") or [])][:5],
            "contradictions": [(c.get("explanation") or c.get("text") or str(c))[:300] if isinstance(c, dict) else str(c)[:300] for c in (o.get("contradictions") or [])],
            "coverage_pct": (o.get("coverage") or {}).get("pct"),
            "questions_voters_should_ask": (o.get("questions") or [])[:6],
            "prompt_injection_flags": len(o.get("injection_flags") or []),
            "analysis_mode": o.get("mode_label"),
        }
    qs = list(db.scalars(select(Question).where(Question.proposal_id == p.id)))
    return {
        "id": p.id, "title": p.title, "category": p.category, "status": p.status, "summary": p.summary,
        "proposer": f"{p.proposer_label} ({p.proposer_address})", "recipient": f"{p.recipient_label} ({p.recipient_address})" if p.recipient_address else None,
        "requested": item["requested_display"], "current_version": p.current_version,
        "milestones": [{"title": m.get("title"), "month": m.get("month"), "amount": _usdc(m["amount_base"]) if m.get("amount_base") else None} for m in (p.milestones or [])],
        "evidence_documents": [e.name for e in p.evidence],
        "governance": {"state": gov.get("state"), "votes": gov.get("votes_display"), "quorum_reached": gov.get("quorum_reached"), "participation_pct": gov.get("participation_pct")},
        "guard": {k: gov["guard"].get(k) for k in ("status", "version", "executable_at_block")},
        "version_manifest_hash": v.manifest_hash if v else None,
        "brief": brief,
        "open_findings": _open_findings(db, p)[:8],
        "questions": {s: sum(1 for q in qs if q.status == s) for s in ("open", "answered", "needs_more", "accepted")},
        "pages": {"workspace": f"/proposals/{p.id}", "guardian": f"/guardian?p={p.id}", "financial": f"/financial?p={p.id}", "qa": f"/proposals/{p.id}?tab=qa"},
    }


def get_evaluation(db: Session, proposal_id: str) -> dict[str, Any]:
    p = _proposal(db, proposal_id)
    ev = risk_chain.evaluate(db, p, governance.state(db, p))
    return {
        "proposal_id": p.id, "combined_estimate_pct": round(ev["overall"] * 100, 1), "label": ev["label"], "formula": ev["formula"],
        "stages": [{"name": s["name"], "question": s["question"], "status": s["status"], "prior_pct": round(s["prior"] * 100, 1),
                    "estimate_pct": round(s["posterior"] * 100, 1), "band": s["band"],
                    "evidence": [{"factor": i["label"], "likelihood_ratio": i["lr"], "direction": i["direction"]} for i in s["items"]],
                    "notes": s.get("notes", [])} for s in ev["stages"]],
    }


def get_findings(db: Session, proposal_id: str) -> dict[str, Any]:
    p = _proposal(db, proposal_id)
    return {"proposal_id": p.id, "open_findings": _open_findings(db, p), "note": "A missing item is a reason to ask, not evidence of wrongdoing."}


def get_treasury_impact(db: Session, proposal_id: str, overrun_pct: int = 0, release: str = "lump") -> dict[str, Any]:
    p = _proposal(db, proposal_id)
    overrun_pct = max(0, min(200, int(overrun_pct or 0)))
    release = release if release in ("lump", "milestones") else "lump"
    d = treasury.impact(db, p, overrun_pct=overrun_pct, release=release, horizon_months=18)
    series = d["series"]
    first_negative = next((s["month"] for s in series if int(s["after_base"]) < 0), None)
    return {
        "proposal_id": p.id, "overrun_pct": overrun_pct, "release": release,
        "treasury_balance_onchain": _usdc(d["balance_base"]), "this_proposal": _usdc(d["active_amount_base"]), "share_of_treasury_pct": d["share_of_treasury_pct"],
        "pending_approvals": _usdc(d["pending_total_base"]), "other_commitments": _usdc(d["other_commitments_base"]),
        "available_before": _usdc(d["available_before_base"]), "available_after": _usdc(d["available_after_base"]),
        "net_monthly_burn": _usdc(d["net_monthly_burn_base"]), "runway_months_before": d["runway_before_months"], "runway_months_after": d["runway_after_months"],
        "runway_change_pct": d["runway_change_pct"], "schedule": [{"month": s["month"], "amount": _usdc(s["amount_base"]), "label": s["label"]} for s in d["schedule"]],
        "projected_available_month_12": _usdc(series[min(12, len(series) - 1)]["after_base"]), "first_month_below_zero": first_negative,
        "schedule_issues": d.get("schedule_issues", []), "assumptions": d["assumptions"], "page": f"/financial?p={p.id}",
    }


def get_execution_status(db: Session, proposal_id: str) -> dict[str, Any]:
    p = _proposal(db, proposal_id)
    gov = governance.state(db, p)
    from ..models import ExecutionAttempt

    attempts = list(db.scalars(select(ExecutionAttempt).where(ExecutionAttempt.proposal_id == p.id).order_by(ExecutionAttempt.created_at.desc()).limit(5)))
    sims = list(db.scalars(select(Simulation).where(Simulation.proposal_id == p.id).order_by(Simulation.started_at.desc()).limit(4)))
    return {
        "proposal_id": p.id, "guard": gov["guard"], "current_block": gov.get("current_block"),
        "recent_attempts": [{"scenario": a.scenario, "outcome": a.outcome, "revert": (a.revert or {}).get("name"), "tx_hash": a.tx_hash, "block": a.block_number} for a in attempts],
        "recent_simulations": [{"id": s.id, "scenario": s.scenario, "trigger": s.trigger, "verdict": s.verdict, "summary": ((s.report or {}).get("summary") or "")[:360]} for s in sims],
        "page": f"/guardian?p={p.id}",
    }


def get_conflicts(db: Session, proposal_id: str) -> dict[str, Any]:
    p = _proposal(db, proposal_id)
    return {"proposal_id": p.id, "conflict_findings": _open_findings(db, p, ["conflict"]),
            "note": "A transfer proves value moved, not common ownership; these are leads to explain.", "page": f"/relationships?p={p.id}"}


def get_recent_activity(db: Session, limit: int = 8, proposal_id: str | None = None) -> dict[str, Any]:
    limit = max(1, min(25, int(limit or 8)))
    q = select(AuditEvent).order_by(AuditEvent.seq.desc()).limit(limit)
    if proposal_id:
        q = q.where(AuditEvent.proposal_id == str(proposal_id).upper())
    events = [{"when": e.occurred_at.isoformat(), "type": e.event_type, "proposal": e.proposal_id, "status": e.status, "verification": e.verification,
               "summary": e.summary[:260], "tx_hash": e.tx_hash} for e in db.scalars(q)]
    alerts = [{"severity": a.severity, "title": a.title, "proposal": a.proposal_id, "status": a.status}
              for a in db.scalars(select(Alert).where(Alert.status.in_(["new", "triaged", "escalated"])).order_by(Alert.created_at.desc()).limit(8))]
    return {"recent_events": events, "open_alerts": alerts, "pages": {"audit": "/audit", "escalation": "/escalation"}}


def get_treasury_overview(db: Session) -> dict[str, Any]:
    o = treasury.overview(db)
    burn = sum(int(i["monthly_base"]) for i in o["inputs"]["burn_items"])
    return {"treasury_balance_onchain": _usdc(o["balance_base"]), "pending_approvals": [{"proposal": x["proposal_id"], "amount": _usdc(x["amount_base"])} for x in o["pending_approvals"]],
            "monthly_burn_inputs": _usdc(burn), "fee_inflow_30d": _usdc(o["monthly_inflow"]["monthly_base"]), "as_of_block": o["as_of_block"], "page": "/financial"}


def search_knowledge(db: Session, query: str) -> dict[str, Any]:
    hits = kb.search(query, k=3)
    return {"sections": [{"title": s.title, "content": s.body, "page": s.link} for _, s in hits] or [], "query": query}


def get_votes(db: Session, proposal_id: str) -> dict[str, Any]:
    p = _proposal(db, proposal_id)
    gov = governance.state(db, p)
    sel = (voting.overview(db, p.id) or {}).get("selected") or {}
    voters = sorted(gov.get("voters") or [], key=lambda v: -int(v.get("weight") or 0))
    return {
        "proposal_id": p.id, "state": gov.get("state"), "governance_status": gov.get("governance_status"), "votes": gov.get("votes_display"),
        "quorum_reached": gov.get("quorum_reached"), "participation_pct": gov.get("participation_pct"), "deadline_block": gov.get("deadline_block"),
        "blocks_remaining": gov.get("blocks_remaining"), "current_block": gov.get("current_block"),
        "unique_voters": sel.get("unique_voters"), "eligible_voters": sel.get("eligible_voters"), "count_by_side": (sel.get("distribution") or {}).get("by_count"),
        "top_voters": [{"voter": v.get("voter_label") or v["voter"], "support": v["support"], "votes": format_units(int(v["weight"]), 18, 0), "reason": v.get("reason")} for v in voters[:8]],
        "risk_signals": [{"level": s.get("level"), "title": s.get("title"), "detail": s.get("detail")} for s in sel.get("risk_signals") or []],
        "voting_mode": gov.get("voting_mode"), "page": f"/voting?p={p.id}",
    }


def get_voting_power(db: Session) -> dict[str, Any]:
    o = voting.overview(db, None)
    c = o["concentration"]
    return {
        "holders_with_power": c["holders"], "top1_pct": c["top1_pct"], "top3_pct": c["top3_pct"], "hhi": c["hhi"], "hhi_band": c["hhi_band"],
        "nakamoto_coefficient": c["nakamoto"], "gini": c["gini"], "definitions": o.get("metric_definitions", {}),
        "largest_holders": [{"holder": r["label"], "voting_power": r["voting_power_display"], "role": r.get("role"), "delegates_to": r.get("delegates_to")} for r in o["power_table"][:8]],
        "proposals": [{"proposal": x["proposal_id"], "state": x["state"], "participation_pct": x["participation_pct"]} for x in o.get("proposals", [])],
        "page": "/voting",
    }


def get_versions(db: Session, proposal_id: str) -> dict[str, Any]:
    p = _proposal(db, proposal_id)
    vs = sorted(p.versions, key=lambda v: v.version)
    latest_changes: list[dict[str, Any]] = []
    if len(vs) >= 2:
        d = proposals.version_diff(db, p, vs[-2].version, vs[-1].version)
        latest_changes = [{"field": c["path"], "category": c["category"], "summary": c["summary"]} for c in d["changes"][:10]]
    return {
        "proposal_id": p.id, "current_version": p.current_version,
        "versions": [{"version": v.version, "committed_at": v.committed_at.isoformat(), "author": v.author, "change_note": v.change_note,
                      "changed_fields": v.changed_fields, "on_chain_tx": v.tx_hash, "manifest_hash": v.manifest_hash} for v in vs],
        "latest_changes": latest_changes, "page": f"/versions?p={p.id}",
    }


def get_evidence(db: Session, proposal_id: str) -> dict[str, Any]:
    p = _proposal(db, proposal_id)
    return {
        "proposal_id": p.id,
        "documents": [{"name": e.name, "type": e.source_type, "verification": e.verification_status, "pages": len(e.pages or []), "content_hash": e.content_hash,
                       "added_by": e.added_by, "prompt_injection_flags": len(e.injection_flags or [])} for e in p.evidence],
        "note": "A content hash proves a document is unchanged since it was committed, not that it is true.", "page": f"/proposals/{p.id}?tab=evidence",
    }


def get_questions(db: Session, proposal_id: str) -> dict[str, Any]:
    p = _proposal(db, proposal_id)
    qs = list(db.scalars(select(Question).where(Question.proposal_id == p.id).order_by(Question.asked_at)))
    return {
        "proposal_id": p.id,
        "questions": [{"question": q.text, "status": q.status, "rule": q.rule_id, "asked_by": q.asked_by, "replies": len(q.thread or []),
                       "latest": ((q.thread or [{}])[-1].get("text") or "")[:240] if q.thread else None} for q in qs],
        "counts": {s: sum(1 for q in qs if q.status == s) for s in ("open", "answered", "needs_more", "accepted", "withdrawn")},
        "page": f"/proposals/{p.id}?tab=qa",
    }


def get_alerts(db: Session, proposal_id: str | None = None) -> dict[str, Any]:
    q = select(Alert).where(Alert.status.in_(["new", "triaged", "escalated"])).order_by(Alert.created_at.desc())
    if proposal_id:
        q = q.where(Alert.proposal_id == str(proposal_id).upper())
    rows = list(db.scalars(q))
    return {
        "open_alerts": [{"id": a.id, "severity": a.severity, "title": a.title, "proposal": a.proposal_id, "source": a.source, "status": a.status,
                         "assignee": a.assignee, "raised": a.created_at.isoformat()} for a in rows],
        "by_severity": {s: sum(1 for a in rows if a.severity == s) for s in ("critical", "high", "medium", "low")}, "page": "/escalation",
    }


def verify_ledger(db: Session) -> dict[str, Any]:
    r = audit.verify(db)
    return {"intact": r["ok"], "events": r["event_count"], "broken_links": len(r["breaks"]), "breaks": r["breaks"][:5],
            "receipts_confirmed": r["chain_receipts"]["confirmed"], "receipts_checked": r["chain_receipts"]["checked"],
            "anchors": [{"up_to": a["seq_upto"], "on_chain": a["found_on_chain"], "matches": a["matches_recomputed_ledger"]} for a in r["anchors"]],
            "note": r["note"], "page": "/audit"}


_REF = re.compile(r"(^|_)(id|hash)$")


def _shared(a: AuditEvent, b: AuditEvent) -> list[str]:
    out = []
    if a.tx_hash and a.tx_hash == b.tx_hash:
        out.append(f"same transaction {a.tx_hash[:12]}…")
    if a.manifest_hash and a.manifest_hash == b.manifest_hash:
        out.append(f"same approved manifest {a.manifest_hash[:12]}…")
    ra = {v: k for k, v in (a.details or {}).items() if isinstance(v, str) and len(v) >= 6 and _REF.search(k)}
    for k, v in (b.details or {}).items():
        if isinstance(v, str) and v in ra:
            out.append(f"both reference {k.replace('_', ' ')} {v}")
    if a.proposal_id and a.proposal_id == b.proposal_id:
        out.append(f"same proposal {a.proposal_id}" + (f" v{a.proposal_version}" if a.proposal_version and a.proposal_version == b.proposal_version else ""))
    if a.actor == b.actor:
        out.append(f"same actor ({a.actor})")
    return out


def get_ledger_connection(db: Session, from_seq: int, to_seq: int) -> dict[str, Any]:
    lo, hi = sorted((int(from_seq), int(to_seq)))
    a = db.scalars(select(AuditEvent).where(AuditEvent.seq == lo)).first()
    b = db.scalars(select(AuditEvent).where(AuditEvent.seq == hi)).first()
    if not a or not b:
        raise DomainError("not_found", f"Ledger event #{lo if not a else hi} does not exist.")
    seg = audit.verify_segment(db, lo, hi)
    shared = _shared(a, b)
    strong = any(s.startswith(("same transaction", "same approved manifest", "both reference")) for s in shared)
    return {
        "from": {"seq": a.seq, "type": a.event_type, "proposal": a.proposal_id, "when": a.occurred_at.isoformat(), "summary": a.summary[:200]},
        "to": {"seq": b.seq, "type": b.event_type, "proposal": b.proposal_id, "when": b.occurred_at.isoformat(), "summary": b.summary[:200]},
        "ledger_links_between": hi - lo, "seconds_apart": int((b.occurred_at - a.occurred_at).total_seconds()), "shared": shared,
        "strength": "direct" if strong else "related" if shared else "hash chain only",
        "segment_intact": seg["ok"], "segment_events": seg["events"], "receipts_rechecked": seg["receipts_checked"], "page": "/audit",
    }


def lookup_actor(db: Session, name: str) -> dict[str, Any]:
    from rapidfuzz import fuzz, process

    from ..models import AddressLabel

    rows = list(db.scalars(select(AddressLabel)))
    target = None
    if re.fullmatch(r"0x[0-9a-fA-F]{40}", name.strip()):
        target = next((r for r in rows if r.address.lower() == name.strip().lower()), None)
    if target is None and rows:
        best = process.extractOne(name, {i: r.label for i, r in enumerate(rows)}, scorer=fuzz.WRatio)
        if best and best[1] >= 72:
            target = rows[best[2]]
    if target is None:
        raise DomainError("not_found", f"No labelled address matches “{name}”.")
    detail = views.address_detail(db, target.address)
    addr = target.address.lower()
    involved = [{"proposal": p.id, "role": "proposer" if (p.proposer_address or "").lower() == addr else "recipient", "title": p.title}
                for p in db.scalars(select(Proposal)) if addr in ((p.proposer_address or "").lower(), (p.recipient_address or "").lower())]
    votes = [{"proposal": e.proposal_id, "summary": e.summary[:160]} for e in db.scalars(select(AuditEvent).where(AuditEvent.event_type == "vote_cast", AuditEvent.actor == target.label))]
    return {"label": target.label, "address": target.address, "kind": target.kind, "role": detail.get("role"), "is_contract": detail.get("is_contract"),
            "balances": detail.get("balances"), "voting_power": detail.get("voting_power"), "proposals": involved, "votes": votes[:8],
            "relationships": len(detail.get("relationships") or []), "note": detail.get("note"), "page": f"/relationships?focus={target.address}"}


def get_policy(db: Session) -> dict[str, Any]:
    pol = policy.get_policy(db)
    rm = pol.get("risk_model", {})
    return {"auto_halt_on_block_verdict": pol.get("auto_halt_on_block_verdict"), "severity_overrides": pol.get("severity_overrides"),
            "priors": rm.get("priors"), "likelihood_ratios": rm.get("likelihood_ratios"), "description": rm.get("description"), "page": "/settings"}


_PID_PROP = {"proposal_id": {"type": "string", "description": "Proposal id such as GOV-042"}}
TOOLS: list[dict[str, Any]] = [
    {"name": "list_proposals", "description": "All proposals with status, amount, guard status, open findings and the evaluation chain's combined estimate. Use to compare or rank proposals.",
     "input_schema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "get_proposal", "description": "One proposal: summary, parties, amount, milestones, evidence, vote and guard state, brief highlights, open findings and Q&A counts.",
     "input_schema": {"type": "object", "properties": _PID_PROP, "required": ["proposal_id"], "additionalProperties": False}},
    {"name": "get_evaluation", "description": "The four-stage evaluation chain for a proposal with every likelihood ratio, prior and estimate.",
     "input_schema": {"type": "object", "properties": _PID_PROP, "required": ["proposal_id"], "additionalProperties": False}},
    {"name": "get_findings", "description": "Open findings (missing information, contradictions, conflicts, simulation, version, injection) for a proposal.",
     "input_schema": {"type": "object", "properties": _PID_PROP, "required": ["proposal_id"], "additionalProperties": False}},
    {"name": "get_treasury_impact", "description": "Treasury impact of a proposal: share of treasury, available balance, runway before/after, payout schedule, for a cost overrun % and release type.",
     "input_schema": {"type": "object", "properties": {**_PID_PROP, "overrun_pct": {"type": "integer", "minimum": 0, "maximum": 200}, "release": {"type": "string", "enum": ["lump", "milestones"]}},
                      "required": ["proposal_id"], "additionalProperties": False}},
    {"name": "get_execution_status", "description": "ExecutionGuard approval status, recent execution attempts (with revert names) and recent simulation verdicts for a proposal.",
     "input_schema": {"type": "object", "properties": _PID_PROP, "required": ["proposal_id"], "additionalProperties": False}},
    {"name": "get_conflicts", "description": "Conflict-of-interest findings for a proposal (transfers, shared funders, embedded addresses, recipient voting power).",
     "input_schema": {"type": "object", "properties": _PID_PROP, "required": ["proposal_id"], "additionalProperties": False}},
    {"name": "get_recent_activity", "description": "Newest audit-ledger events and open alerts, optionally for one proposal.",
     "input_schema": {"type": "object", "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 25}, "proposal_id": {"type": "string"}}, "additionalProperties": False}},
    {"name": "get_treasury_overview", "description": "On-chain treasury balance, pending approved payouts, burn inputs and fee inflows.",
     "input_schema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "search_knowledge", "description": "Search the DAOGuard product guide (pages, features, concepts, how-to, limits) when you need exact product details.",
     "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"], "additionalProperties": False}},
    {"name": "get_votes", "description": "Vote result for a proposal: for/against/abstain, quorum, turnout, deadline, largest voters with reasons, and voting risk signals.",
     "input_schema": {"type": "object", "properties": _PID_PROP, "required": ["proposal_id"], "additionalProperties": False}},
    {"name": "get_voting_power", "description": "DAO-wide voting-power concentration (top-1/top-3 share, HHI, Nakamoto coefficient, Gini) and the largest holders.",
     "input_schema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "get_versions", "description": "Committed versions of a proposal with authors, change notes, on-chain commitments and the field-level changes in the latest version.",
     "input_schema": {"type": "object", "properties": _PID_PROP, "required": ["proposal_id"], "additionalProperties": False}},
    {"name": "get_evidence", "description": "Evidence documents attached to a proposal with type, verification status, hash and prompt-injection flags.",
     "input_schema": {"type": "object", "properties": _PID_PROP, "required": ["proposal_id"], "additionalProperties": False}},
    {"name": "get_questions", "description": "Reviewer questions to the proposer (Q&A) for a proposal, with status and latest reply.",
     "input_schema": {"type": "object", "properties": _PID_PROP, "required": ["proposal_id"], "additionalProperties": False}},
    {"name": "get_alerts", "description": "Open alerts (severity, source, status, assignee), optionally for one proposal.",
     "input_schema": {"type": "object", "properties": {"proposal_id": {"type": "string"}}, "additionalProperties": False}},
    {"name": "verify_ledger", "description": "Re-hash the whole audit ledger and re-check transaction receipts and anchors (read-only).",
     "input_schema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "get_ledger_connection", "description": "How two audit-ledger events (by sequence number) are connected: shared transaction/manifest/record ids, time apart, and whether the hash chain between them verifies.",
     "input_schema": {"type": "object", "properties": {"from_seq": {"type": "integer", "minimum": 1}, "to_seq": {"type": "integer", "minimum": 1}}, "required": ["from_seq", "to_seq"], "additionalProperties": False}},
    {"name": "lookup_actor", "description": "Look up a labelled address (delegate, proposer, recipient, contract) by name or 0x address: balances, voting power, proposals and votes.",
     "input_schema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"], "additionalProperties": False}},
    {"name": "get_policy", "description": "Current policy: auto-halt on BLOCK verdicts, severity overrides, evaluation-chain priors and likelihood ratios.",
     "input_schema": {"type": "object", "properties": {}, "additionalProperties": False}},
]
HANDLERS: dict[str, Callable[..., dict[str, Any]]] = {
    "list_proposals": list_proposals, "get_proposal": get_proposal, "get_evaluation": get_evaluation, "get_findings": get_findings,
    "get_treasury_impact": get_treasury_impact, "get_execution_status": get_execution_status, "get_conflicts": get_conflicts,
    "get_recent_activity": get_recent_activity, "get_treasury_overview": get_treasury_overview, "search_knowledge": search_knowledge,
    "get_votes": get_votes, "get_voting_power": get_voting_power, "get_versions": get_versions, "get_evidence": get_evidence,
    "get_questions": get_questions, "get_alerts": get_alerts, "verify_ledger": verify_ledger, "get_ledger_connection": get_ledger_connection,
    "lookup_actor": lookup_actor, "get_policy": get_policy,
}
STATUS_TEXT = {
    "list_proposals": "Comparing all proposals", "get_proposal": "Reading {proposal_id}", "get_evaluation": "Checking the evaluation chain for {proposal_id}",
    "get_findings": "Reviewing findings for {proposal_id}", "get_treasury_impact": "Running the treasury model for {proposal_id}",
    "get_execution_status": "Checking the guard and simulations for {proposal_id}", "get_conflicts": "Tracing relationships for {proposal_id}",
    "get_recent_activity": "Reading the audit ledger", "get_treasury_overview": "Reading the treasury", "search_knowledge": "Searching the product guide",
    "get_votes": "Counting the votes on {proposal_id}", "get_voting_power": "Measuring voting-power concentration", "get_versions": "Comparing versions of {proposal_id}",
    "get_evidence": "Listing evidence for {proposal_id}", "get_questions": "Reading the Q&A for {proposal_id}", "get_alerts": "Checking open alerts",
    "verify_ledger": "Re-hashing the audit ledger", "get_ledger_connection": "Tracing two ledger events", "lookup_actor": "Looking up {name}", "get_policy": "Reading the policy",
}


def validate(name: str, args: Any) -> str | None:
    """Minimal schema check (inputs are tiny; this guards against malformed or missing fields)."""
    spec = next((t for t in TOOLS if t["name"] == name), None)
    if spec is None:
        return f"unknown tool {name}"
    if not isinstance(args, dict):
        return "input must be an object"
    props = spec["input_schema"].get("properties", {})
    for req in spec["input_schema"].get("required", []):
        if req not in args:
            return f"missing {req}"
    for k, v in args.items():
        if k not in props:
            return f"unexpected field {k}"
        t = props[k].get("type")
        if (t == "string" and not isinstance(v, str)) or (t == "integer" and not (isinstance(v, int) and not isinstance(v, bool))):
            return f"{k} must be {'an' if t == 'integer' else 'a'} {t}"
        if "enum" in props[k] and v not in props[k]["enum"]:
            return f"{k} must be one of {props[k]['enum']}"
    if "proposal_id" in args and args["proposal_id"] and not PID.fullmatch(str(args["proposal_id"]).strip()):
        return "proposal_id must look like GOV-042"
    return None


def run(db: Session, name: str, args: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """Returns (result, is_error)."""
    problem = validate(name, args)
    if problem:
        return {"error": problem}, True
    try:
        return HANDLERS[name](db, **args), False
    except DomainError as exc:
        return {"error": exc.message}, True
    except Exception as exc:  # never let one tool end the conversation; the model can say the data was unavailable
        log.exception("assistant tool %s failed", name)
        db.rollback()
        return {"error": f"{name} is unavailable right now ({type(exc).__name__})"}, True
