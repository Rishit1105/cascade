"""Proposal brief orchestration: deterministic extraction always runs; an LLM may add
interpretation on top when configured. Findings (missing info, injection, contradictions) are
deterministic and do not depend on the model."""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...clock import iso, utcnow
from ...models import AnalysisRun, Proposal, new_id
from ...runtime import runtime
from .. import audit
from ..canonical import content_hash
from ..decoder import describe_action
from ..findings import sync_findings
from ..labels import Labeler
from ..proposals import build_actions, latest_disclosure
from ..treasury import treasury_balance
from . import extractive, llm, missing_info

log = logging.getLogger("daoguard.analysis")


def analyze(db: Session, p: Proposal, actor: str = "reviewer", source: str = "ui") -> AnalysisRun:
    deployment = runtime.require_deployment()
    labeler = Labeler(db)
    docs = list(p.evidence)
    balance = treasury_balance()
    try:
        decoded = [describe_action(a, labeler) for a in build_actions(p.draft_actions or [], deployment)]
    except Exception:
        decoded = []
    disclosure = latest_disclosure(db, p.id)
    sources = extractive.all_sources(p, docs)
    inputs = {"proposal": {k: getattr(p, k) for k in ("title", "body", "summary", "requested_amount_base", "recipient_address")},
              "docs": [d.content_hash for d in docs], "disclosure": disclosure.disclosure_hash if disclosure else None}
    provider = llm.provider_status()
    run = AnalysisRun(id=new_id("AN"), proposal_id=p.id, mode=provider["mode"], status="running", input_hash=content_hash(inputs), created_at=utcnow())

    brief = extractive.run(p, docs, balance)
    brief["requested_decision"] = (
        "Approve the following executable action(s): " + " ".join(d["human_readable"] for d in decoded)
        if decoded else "No executable action has been defined yet."
    )
    brief["mode_label"] = provider["label"]
    brief["is_demo_analysis"] = provider["provider"] is None
    llm_error = None
    if provider["provider"]:
        try:
            interpreted = llm.run(sources)
            brief["llm"] = interpreted
            brief["summary"] = interpreted["summary"] + [s for s in brief["summary"] if s["basis"].startswith("deterministic")]
            for cat, items in interpreted["claims"].items():
                existing = {c["text"].lower() for c in brief["claims"].get(cat, [])}
                brief["claims"].setdefault(cat, []).extend(c for c in items if c["text"].lower() not in existing)
            brief["open_questions_model"] = interpreted["open_questions"]
            brief["unknowns"] = interpreted["unknowns"]
        except Exception as exc:  # model failure must never block the deterministic brief
            log.warning("LLM analysis failed for %s: %s", p.id, exc)
            llm_error = f"{type(exc).__name__}: {exc}"
            brief["mode_label"] = "Deterministic extraction (the configured AI model failed; see error)"
            run.mode = "deterministic-extractive (llm failed)"

    gaps = missing_info.evaluate(p, docs, brief, disclosure, decoded, balance)
    brief["missing_information"] = gaps
    brief["questions"] = [g["remediation"] for g in gaps] + brief.get("open_questions_model", [])

    injection_items = []
    for d in docs:
        passages: dict[tuple[int, str], list[str]] = {}
        for f in d.injection_flags or []:
            passages.setdefault((f["page"], f["quote"]), []).append(f["pattern"])
        for (page, quote), patterns in passages.items():
            injection_items.append(
                {
                    "rule_id": "INJ-R001",
                    "severity": "medium",
                    "confidence": "verified",
                    "title": f"Instruction-like text in “{d.name}”",
                    "explanation": (
                        f"The document contains text addressed to automated reviewers ({', '.join(sorted(set(patterns)))}): “{quote[:180]}”. "
                        "DAOGuard treats every document as data; this text did not change any rule, finding or manifest."
                    ),
                    "remediation": "Ask the author why the document contains instructions aimed at automated reviewers.",
                    "evidence_refs": [{"type": "citation", "doc_id": d.id, "doc_name": d.name, "page": page, "quote": quote}],
                    "data": {"patterns": sorted(set(patterns)), "page": page, "quote": quote},
                    "key": f"{d.id}:{page}:{quote[:80]}",
                }
            )
    brief["injection_flags"] = injection_items

    run.output = brief
    run.status = "completed"
    run.error = llm_error
    db.add(run)
    contradiction_rules = {"MI-R012", "MI-R013"}
    sync_findings(db, p.id, "missing_info", [g for g in gaps if g["rule_id"] not in contradiction_rules], source_ref=run.id)
    sync_findings(db, p.id, "analysis", [g for g in gaps if g["rule_id"] in contradiction_rules], source_ref=run.id)
    sync_findings(db, p.id, "injection", injection_items, source_ref=run.id)
    db.commit()
    audit.record(
        event_type="analysis_completed",
        summary=f"Proposal brief generated for {p.id} ({brief['mode_label']}): {brief['coverage']['claims_cited']}/{brief['coverage']['claims_total']} claims cited, "
                f"{len(gaps)} information gap(s).",
        actor=actor,
        source=source,
        status="warning" if llm_error else "info",
        proposal_id=p.id,
        details={"analysis_id": run.id, "mode": run.mode, "input_hash": run.input_hash, "llm_error": llm_error},
    )
    return run


def latest(db: Session, proposal_id: str) -> AnalysisRun | None:
    return db.scalars(select(AnalysisRun).where(AnalysisRun.proposal_id == proposal_id).order_by(AnalysisRun.created_at.desc()).limit(1)).first()


def serialize(run: AnalysisRun) -> dict[str, Any]:
    return {"id": run.id, "proposal_id": run.proposal_id, "mode": run.mode, "status": run.status, "input_hash": run.input_hash,
            "error": run.error, "created_at": iso(run.created_at), "brief": run.output}
