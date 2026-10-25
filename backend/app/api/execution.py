from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..errors import Conflict, NotFound, ValidationFailed
from ..models import ExecutionAttempt, ExecutionCheck, Simulation
from ..services import audit, execution, proposals
from ..services.manifests import PayloadError, manifest_actions, parse_payload
from ..services.sentinel import declared_text, simulation_findings
from ..services.findings import sync_findings
from ..services.simulation import run_simulation
from ..services.simulation import serialize as serialize_sim
from .deps import actor, require_ready
from .schemas import DisputeIn, HaltIn, PayloadRequest, SimulationRequest

router = APIRouter(prefix="/api", dependencies=[Depends(require_ready)])


def _payload(p, body: PayloadRequest | SimulationRequest) -> tuple[dict[str, Any], str | None]:
    if body.payload is not None:
        return body.payload, body.scenario or "custom"
    if body.scenario:
        return execution.scenario_payload(p, body.scenario), body.scenario
    raise ValidationFailed("payload_required", "Provide a scenario id or a payload.")


@router.get("/proposals/{proposal_id}/intent")
def intent(proposal_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    """Declared-intent assertions parsed from the text voters saw (offsets index into `text`)."""
    from ..services.intent import extract_assertions

    p = proposals.get_proposal(db, proposal_id)
    v = proposals.approved_version(p) or proposals.latest_version(p)
    text = declared_text(p, v) if v else p.body
    return {"proposal_id": p.id, "version": v.version if v else None, "text": text, **extract_assertions(text)}


@router.get("/proposals/{proposal_id}/scenarios")
def scenarios(proposal_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    return {"items": execution.available_scenarios(p)}


@router.get("/proposals/{proposal_id}/scenarios/{scenario}/payload")
def scenario_payload(proposal_id: str, scenario: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    return {"scenario": scenario, "payload": execution.scenario_payload(p, scenario)}


@router.post("/proposals/{proposal_id}/execution-checks", status_code=201)
def create_check(proposal_id: str, body: PayloadRequest, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    payload, scenario = _payload(p, body)
    return execution.serialize_check(execution.run_check(db, p, payload, scenario, who))


@router.get("/proposals/{proposal_id}/execution-checks")
def list_checks(proposal_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    proposals.get_proposal(db, proposal_id)
    rows = db.scalars(select(ExecutionCheck).where(ExecutionCheck.proposal_id == proposal_id).order_by(ExecutionCheck.checked_at.desc()).limit(30))
    return {"items": [execution.serialize_check(c) for c in rows]}


@router.post("/proposals/{proposal_id}/demo-execution", status_code=201)
def demo_execution(proposal_id: str, body: PayloadRequest, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    payload, scenario = _payload(p, body)
    attempt = execution.execute(db, p, payload, scenario, who)
    check = db.get(ExecutionCheck, attempt.check_id)
    return {"attempt": execution.serialize_attempt(attempt), "check": execution.serialize_check(check) if check else None}


@router.get("/proposals/{proposal_id}/execution-attempts")
def attempts(proposal_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    proposals.get_proposal(db, proposal_id)
    rows = db.scalars(select(ExecutionAttempt).where(ExecutionAttempt.proposal_id == proposal_id).order_by(ExecutionAttempt.created_at.desc()))
    return {"items": [execution.serialize_attempt(a) for a in rows]}


@router.post("/proposals/{proposal_id}/simulations", status_code=201)
def simulate(proposal_id: str, body: SimulationRequest, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    approved = proposals.approved_version(p) or proposals.latest_version(p)
    if body.payload is None and body.scenario is None:
        v = proposals.get_version(p, body.version) if body.version else approved
        if v is None:
            raise Conflict("no_version", "Commit a version before simulating it.")
        actions, manifest_hash, version, scenario, reference = manifest_actions(v.manifest), v.manifest_hash, v.version, f"v{v.version} manifest", v.manifest
        text = declared_text(p, v)
    else:
        raw, scenario = _payload(p, body)
        try:
            payload = parse_payload(raw)
        except PayloadError as exc:
            raise ValidationFailed("invalid_payload", str(exc), {"path": exc.path}) from exc
        actions, manifest_hash, version, reference = list(payload.actions), None, payload.version, approved.manifest if approved else None
        text = declared_text(p, approved) if approved else p.body
    sim = run_simulation(db, p, actions=actions, approved_manifest=reference, declared_text=text, version=version,
                         manifest_hash=manifest_hash, scenario=scenario, trigger="manual")
    if manifest_hash and sim.status == "completed":
        sync_findings(db, p.id, "simulation", simulation_findings(sim.report), source_ref=sim.id)
        db.commit()
    audit.record(event_type="simulation_completed",
                 summary=f"Manual simulation of {p.id} ({scenario}): verdict {sim.verdict.upper()}. {(sim.report or {}).get('summary', (sim.report or {}).get('error', ''))[:240]}",
                 actor=who, source="ui", status={"pass": "success", "flag": "warning", "block": "failure"}.get(sim.verdict, "warning"),
                 proposal_id=p.id, version=version, manifest_hash=manifest_hash, details={"simulation_id": sim.id, "verdict": sim.verdict, "scenario": scenario})
    return serialize_sim(sim)


@router.get("/proposals/{proposal_id}/simulations")
def list_simulations(proposal_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    proposals.get_proposal(db, proposal_id)
    rows = db.scalars(select(Simulation).where(Simulation.proposal_id == proposal_id).order_by(Simulation.started_at.desc()).limit(20))
    return {"items": [{k: v for k, v in serialize_sim(s).items() if k != "report"} | {"summary": (s.report or {}).get("summary")} for s in rows]}


@router.get("/simulations/{simulation_id}")
def get_simulation(simulation_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    sim = db.get(Simulation, simulation_id)
    if sim is None:
        raise NotFound("simulation_not_found", "Simulation not found.")
    return serialize_sim(sim)


@router.post("/proposals/{proposal_id}/halt")
def halt(proposal_id: str, body: HaltIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    if body.confirm.strip() != p.id:
        raise ValidationFailed("confirmation_mismatch", f"Type {p.id} to confirm the halt.")
    return execution.halt(db, p, body.reason, who)


@router.post("/proposals/{proposal_id}/disputes", status_code=201)
def dispute(proposal_id: str, body: DisputeIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    proposals.get_version(p, body.version)
    return execution.file_dispute(db, p, body.version, body.statement, who)
