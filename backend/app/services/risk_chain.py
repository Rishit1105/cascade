"""Probabilistic evaluation chain: Proposal Claims → Conflict of Interest → On-chain Voting →
Execution Discrepancy.

Each stage holds a prior probability that a material issue exists and updates it with the
likelihood ratio of every piece of evidence (Bayes in odds form). Priors and ratios are editable
in Settings, and every contribution is listed, so no number is a black box. Output is a model
estimate. It is not a probability of fraud and not a statement of fact.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import ExecutionAttempt, ExecutionCheck, Proposal, Simulation
from .analysis.service import latest as latest_analysis
from .findings import active_findings
from .policy import get_policy
from .proposals import approved_version, latest_disclosure, latest_version

STAGES = [
    ("claims", "Proposal Claims", "Are the proposal's claims evidenced and complete?", "/proposals"),
    ("conflict", "Conflict of Interest Risk", "Are relationships between the parties disclosed and explained?", "/relationships"),
    ("vote", "On-Chain Voting", "Was the decision made with healthy, independent participation?", "/voting"),
    ("execution", "Execution Discrepancy", "Does what will execute match what was approved and described?", "/guardian"),
]


def _posterior(prior: float, items: list[dict[str, Any]]) -> float:
    odds = Decimal(str(prior)) / (1 - Decimal(str(prior)))
    for it in items:
        odds *= Decimal(str(it["lr"]))
    return float(odds / (1 + odds))


def evaluate(db: Session, p: Proposal, gov_state: dict[str, Any] | None = None) -> dict[str, Any]:
    model = get_policy(db)["risk_model"]
    lrs, priors = model["likelihood_ratios"], model["priors"]
    # Resolved (e.g. by an accepted proposer answer) and dismissed findings no longer count as evidence of an issue.
    findings = [f for f in active_findings(db, p.id) if f.status not in ("resolved", "dismissed")]

    def item(key: str, label: str, source: str | None = None) -> dict[str, Any]:
        lr = float(lrs.get(key, 1.0))
        return {"key": key, "label": label, "lr": lr, "direction": "raises" if lr > 1 else "lowers" if lr < 1 else "neutral", "source": source}

    stages: dict[str, dict[str, Any]] = {k: {"items": [], "metrics": {}, "status": "not_started"} for k, *_ in STAGES}

    # Claims.
    run = latest_analysis(db, p.id)
    claims = stages["claims"]
    if run:
        claims["status"] = "complete"
        cov = run.output.get("coverage", {})
        claims["metrics"] = {"coverage_pct": cov.get("pct"), "claims_cited": cov.get("claims_cited"), "claims_total": cov.get("claims_total"),
                             "gaps": sum(1 for f in findings if f.kind == "missing_info")}
        if cov.get("pct", 0) >= 70:
            claims["items"].append(item("claims.well_evidenced", f"{cov.get('pct')}% of extracted claims quote a source"))
    for f in findings:
        if f.kind == "missing_info":
            claims["items"].append(item(f"missing_info.{f.severity}" if f.severity in ("high", "medium", "low") else "missing_info.low", f.title, f.id))
        elif f.kind == "analysis":
            claims["items"].append(item("claims.contradiction", f.title, f.id))
    if any(f.kind == "injection" for f in findings):
        inj = next(f for f in findings if f.kind == "injection")
        claims["items"].append(item("claims.injection_detected", "Instruction-like text found in evidence", inj.id))

    # Conflict.
    conflict = stages["conflict"]
    coi = [f for f in findings if f.kind == "conflict"]
    disclosure = latest_disclosure(db, p.id)
    lv = latest_version(p)
    if coi or disclosure:
        conflict["status"] = "complete"
    rule_map = {"COI-R001": "conflict.undisclosed_transfer", "COI-R004": "conflict.embedded_address_link", "COI-R003": "conflict.shared_funder",
                "COI-R005": "conflict.recipient_voting_power", "COI-R002": "conflict.shared_funder"}
    for f in coi:
        if f.severity == "info":
            continue
        if f.rule_id in rule_map:
            conflict["items"].append(item(rule_map[f.rule_id], f.title, f.id))
    for f in findings:
        if f.rule_id == "SIM-R010":
            conflict["items"].append(item("conflict.embedded_address_link", f.title, f.id))
    if disclosure and lv and lv.disclosure_hash == disclosure.disclosure_hash:
        conflict["items"].append(item("conflict.signed_disclosure", f"Signed disclosure bound to v{lv.version}"))
    if disclosure is None:
        conflict["status"] = "in_progress"
        conflict["items"].append(item("conflict.missing_disclosure", "No conflict-of-interest disclosure published"))
    conflict["metrics"] = {"leads": sum(1 for f in coi if f.severity != "info"), "disclosure": "signed" if disclosure else "missing"}

    # Vote.
    vote = stages["vote"]
    if gov_state and gov_state.get("state") not in (None, "not_submitted"):
        vote["status"] = "complete" if gov_state["state"] not in ("Pending", "Active") else "in_progress"
        f_, a_, ab = int(gov_state["votes"]["for"]), int(gov_state["votes"]["against"]), int(gov_state["votes"]["abstain"])
        cast = f_ + a_ + ab
        vote["metrics"] = {"state": gov_state["state"], "for_pct": f"{f_ * 100 / cast:.1f}" if cast else "0", "against_pct": f"{a_ * 100 / cast:.1f}" if cast else "0",
                           "participation_pct": gov_state.get("participation_pct"), "quorum_reached": gov_state.get("quorum_reached")}
        if vote["status"] == "complete":
            if not gov_state.get("quorum_reached"):
                vote["items"].append(item("vote.quorum_failed", "Quorum not reached"))
            elif cast and (f_ - a_) * 10 < cast:
                vote["items"].append(item("vote.thin_margin", "Winning margin under 10% of votes cast"))
            else:
                vote["items"].append(item("vote.passed_clearly", "Clear margin with quorum reached"))
    else:
        vote["metrics"] = {"state": "not submitted"}

    # Execution.
    execution = stages["execution"]
    av = approved_version(p) or lv
    sims = list(db.scalars(select(Simulation).where(Simulation.proposal_id == p.id).order_by(Simulation.started_at.desc())))
    sim = next((s for s in sims if av and s.manifest_hash == av.manifest_hash and s.status == "completed"), None)
    if sim:
        execution["status"] = "complete"
        execution["items"].append(item(f"execution.simulation_{sim.verdict}", f"Simulation {sim.id} of the {'approved' if approved_version(p) else 'latest'} manifest: {sim.verdict.upper()}", sim.id))
    checks = list(db.scalars(select(ExecutionCheck).where(ExecutionCheck.proposal_id == p.id).order_by(ExecutionCheck.checked_at.desc())))
    safe_check = next((c for c in checks if c.status == "MATCH"), None)
    if safe_check:
        execution["items"].append(item("execution.manifest_match", "A submitted payload matched the approved manifest exactly", safe_check.id))
    if any(f.rule_id == "DG-V001" for f in findings):
        f = next(f for f in findings if f.rule_id == "DG-V001")
        execution["items"].append(item("execution.payload_changed_after_review", f.title, f.id))
    attempts = list(db.scalars(select(ExecutionAttempt).where(ExecutionAttempt.proposal_id == p.id)))
    rejected = [a for a in attempts if a.outcome == "rejected"]
    executed = [a for a in attempts if a.outcome == "executed"]
    guard_status = (gov_state or {}).get("guard", {}).get("status")
    execution["metrics"] = {"guard": guard_status, "simulation": sim.verdict if sim else None, "blocked_attempts": len(rejected), "executed": bool(executed)}
    if guard_status == "halted":
        execution["status"] = "contained"
    if rejected:
        execution["notes"] = [f"{len(rejected)} tampered payload(s) were rejected by the contract: enforcement worked, so they do not raise this estimate."]

    result_stages = []
    survive = 1.0
    for key, name, question, link in STAGES:
        st = stages[key]
        prior = float(priors[key])
        post = _posterior(prior, st["items"])
        survive *= 1 - post
        result_stages.append({
            "key": key, "name": name, "question": question, "link": link, "status": st["status"],
            "prior": prior, "posterior": round(post, 4), "items": st["items"], "metrics": st["metrics"], "notes": st.get("notes", []),
            "band": "high" if post >= 0.5 else "elevated" if post >= 0.2 else "low",
        })
    return {
        "proposal_id": p.id,
        "stages": result_stages,
        "overall": round(1 - survive, 4),
        "method": model["description"],
        "formula": "posterior odds = prior odds × Π likelihood ratios; overall = 1 − Π(1 − stage posterior)",
        "label": "Model estimate (configurable). Not a probability of fraud.",
    }
