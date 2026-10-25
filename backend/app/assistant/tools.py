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
from ..services import governance, proposals, risk_chain, treasury, views
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
            "id": p.id, "title": p.title, "category": p.category, "status": p.status, "requested": item["requested_display"],
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
]
HANDLERS: dict[str, Callable[..., dict[str, Any]]] = {
    "list_proposals": list_proposals, "get_proposal": get_proposal, "get_evaluation": get_evaluation, "get_findings": get_findings,
    "get_treasury_impact": get_treasury_impact, "get_execution_status": get_execution_status, "get_conflicts": get_conflicts,
    "get_recent_activity": get_recent_activity, "get_treasury_overview": get_treasury_overview, "search_knowledge": search_knowledge,
}
STATUS_TEXT = {
    "list_proposals": "Comparing all proposals", "get_proposal": "Reading {proposal_id}", "get_evaluation": "Checking the evaluation chain for {proposal_id}",
    "get_findings": "Reviewing findings for {proposal_id}", "get_treasury_impact": "Running the treasury model for {proposal_id}",
    "get_execution_status": "Checking the guard and simulations for {proposal_id}", "get_conflicts": "Tracing relationships for {proposal_id}",
    "get_recent_activity": "Reading the audit ledger", "get_treasury_overview": "Reading the treasury", "search_knowledge": "Searching the product guide",
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
