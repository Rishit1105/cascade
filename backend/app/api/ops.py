"""Audit ledger, alerts & escalation, relationship graph, voting, treasury and reports."""

from __future__ import annotations

import csv
import io
import json
from typing import Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..errors import Conflict, NotFound, ValidationFailed
from ..models import Alert, AuditAnchor, AuditEvent, Report
from ..runtime import DELEGATE_ROLES, runtime
from ..services import alerts, audit, coi, execution, proposals, reports, treasury, voting
from ..services.labels import Labeler
from ..services.notifications import notify
from .deps import actor, require_ready
from .schemas import AlertActionIn, AnnotationIn, EmergencyIn, ManualAlertIn, ReportIn, TreasuryInputsIn, TxVerifyIn

router = APIRouter(prefix="/api", dependencies=[Depends(require_ready)])


# ------------------------------------------------------------------ audit
def _events(db: Session, proposal: str | None, event_type: str | None, status: str | None, verification: str | None, limit: int) -> list[AuditEvent]:
    q = select(AuditEvent)
    if proposal:
        q = q.where(AuditEvent.proposal_id == proposal)
    if event_type:
        q = q.where(AuditEvent.event_type == event_type)
    if status:
        q = q.where(AuditEvent.status == status)
    if verification:
        q = q.where(AuditEvent.verification == verification)
    return list(db.scalars(q.order_by(AuditEvent.seq.desc()).limit(limit)))


@router.get("/audit-events")
def audit_events(proposal: str | None = None, type: str | None = None, status: str | None = None, verification: str | None = None,
                 limit: int = Query(default=200, ge=1, le=1000), db: Session = Depends(get_db)) -> dict[str, Any]:
    items = _events(db, proposal, type, status, verification, limit)
    types = sorted({t for (t,) in db.execute(select(AuditEvent.event_type).distinct())})
    return {"items": [audit.serialize(e) for e in items], "event_types": types}


@router.get("/proposals/{proposal_id}/audit-events")
def proposal_audit(proposal_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    proposals.get_proposal(db, proposal_id)
    return {"items": [audit.serialize(e) for e in _events(db, proposal_id, None, None, None, 1000)]}


@router.post("/audit/verify")
def verify_ledger(db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    result = audit.verify(db)
    audit.record(event_type="ledger_verified", summary=f"Audit ledger verified: {'intact' if result['ok'] else 'BROKEN'} "
                 f"({result['event_count']} events, {result['chain_receipts']['confirmed']} chain receipts re-checked).",
                 actor=who, source="ui", status="success" if result["ok"] else "failure",
                 details={"breaks": result["breaks"], "anchors": len(result["anchors"])})
    return result


@router.post("/audit/anchor")
def anchor(db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    return audit.anchor(db, actor=who, source="ui")


@router.get("/audit/anchors")
def anchors(db: Session = Depends(get_db)) -> dict[str, Any]:
    rows = db.scalars(select(AuditAnchor).order_by(AuditAnchor.id.desc()))
    return {"items": [{"seq_upto": a.seq_upto, "ledger_head": a.ledger_head, "tx_hash": a.tx_hash, "block_number": a.block_number,
                       "anchored_at": a.anchored_at.isoformat()} for a in rows]}


@router.get("/audit/export")
def export_audit(format: str = "json", proposal: str | None = None, db: Session = Depends(get_db)) -> Response:
    if format not in ("json", "csv"):
        raise ValidationFailed("invalid_format", "format must be json or csv")
    events = list(reversed(_events(db, proposal, None, None, None, 5000)))
    rows = [audit.serialize(e) for e in events]
    name = f"daoguard_audit_{proposal or 'all'}.{format}"
    if format == "json":
        body = json.dumps({"data_label": "Demo data: fictional DAO on a local chain", "events": rows,
                           "integrity": "Each event_hash = sha256(canonical(event) || prev_hash). Re-verify with POST /api/audit/verify."}, indent=2).encode()
        media = "application/json"
    else:
        buf = io.StringIO()
        w = csv.writer(buf)
        cols = ["seq", "occurred_at", "proposal_id", "event_type", "actor", "source", "verification", "status", "summary",
                "proposal_version", "manifest_hash", "tx_hash", "block_number", "prev_hash", "event_hash"]
        w.writerow(cols)
        for r in rows:
            w.writerow([r.get(c) for c in cols])
        body = buf.getvalue().encode()
        media = "text/csv"
    return Response(content=body, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ------------------------------------------------------------------ alerts
@router.get("/alerts")
def list_alerts(status: str | None = None, severity: str | None = None, proposal: str | None = None, db: Session = Depends(get_db)) -> dict[str, Any]:
    q = select(Alert)
    if status == "open":
        q = q.where(Alert.status.in_(["new", "triaged", "escalated"]))
    elif status:
        q = q.where(Alert.status == status)
    if severity:
        q = q.where(Alert.severity == severity)
    if proposal:
        q = q.where(Alert.proposal_id == proposal)
    items = list(db.scalars(q.order_by(Alert.created_at.desc())))
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    items.sort(key=lambda a: (a.status in ("resolved", "dismissed"), order.get(a.severity, 9)))
    reviewers = ["Security council · Ana (demo)", "Delegate · Orion Guild", "Treasury steward (demo)", "Demo reviewer"]
    return {"items": [alerts.serialize(a) for a in items], "reviewers": reviewers}


@router.post("/alerts", status_code=201)
def create_alert(body: ManualAlertIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    """A reviewer flags something for review (e.g. a relationship edge). Recorded as a manual alert."""
    if body.proposal_id:
        proposals.get_proposal(db, body.proposal_id)
    a = alerts.raise_alert(db, proposal_id=body.proposal_id, source="manual", severity=body.severity, title=body.title,
                           description=f"{body.description} (flagged by {who})", data={"flagged_by": who, **body.data})
    return alerts.serialize(a)


@router.post("/alerts/{alert_id}/emergency")
def emergency(alert_id: str, body: EmergencyIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    a = db.get(Alert, alert_id)
    if a is None:
        raise NotFound("alert_not_found", "Alert not found.")
    if not a.proposal_id:
        raise Conflict("no_proposal", "This alert is not linked to a proposal.")
    p = proposals.get_proposal(db, a.proposal_id)
    if body.action == "halt":
        if (body.confirm or "").strip() != p.id:
            raise ValidationFailed("confirmation_mismatch", f"Type {p.id} to confirm the halt.")
        result = execution.halt(db, p, body.reason, who, reason_data={"alert_id": a.id})
        alerts.record_action(db, a, "halted", who, body.reason, result)
    elif body.action == "dispute":
        version = body.version or p.current_version
        if not version:
            raise Conflict("no_version", "There is no committed version to dispute.")
        result = execution.file_dispute(db, p, version, body.reason, who)
        alerts.record_action(db, a, "dispute_filed", who, body.reason, result)
    else:
        deployment = runtime.require_deployment()
        labeler = Labeler(db)
        names = [labeler.label(deployment.a(r)) for r in DELEGATE_ROLES]
        notify(db, "warning", f"Review requested: {a.title}", body.reason, f"/escalation?alert={a.id}", audience="delegates")
        db.commit()
        audit.record(event_type="delegates_notified", summary=f"{len(names)} delegates notified about alert {a.id} (in-app demo notification).",
                     actor=who, source="ui", status="info", proposal_id=p.id, details={"alert_id": a.id, "recipients": names, "message": body.reason})
        result = {"notified": names, "channel": "in-app (demo)"}
        alerts.record_action(db, a, "delegates_notified", who, body.reason, result)
    return {"alert": alerts.serialize(a), "result": result}


@router.post("/alerts/{alert_id}/{action}")
def alert_action(alert_id: str, action: str, body: AlertActionIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    a = db.get(Alert, alert_id)
    if a is None:
        raise NotFound("alert_not_found", "Alert not found.")
    return alerts.serialize(alerts.transition(db, a, action, who, body.note, body.assignee))


# ------------------------------------------------------------------ graph
@router.get("/graph")
def graph(db: Session = Depends(get_db)) -> dict[str, Any]:
    return coi.build_graph(db)


@router.post("/graph/annotations", status_code=201)
def annotate(body: AnnotationIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    ann = coi.add_annotation(db, body.source_address, body.target_address, body.relation, body.note, who)
    return {"id": ann.id, "evidence_level": ann.evidence_level}


@router.post("/graph/verify-tx")
def verify_tx(body: TxVerifyIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    result = coi.verify_transaction(body.tx_hash)
    audit.record(event_type="transaction_reverified", summary=f"Transaction {body.tx_hash[:12]}… re-read from the node: {'found' if result['found'] else 'NOT FOUND'}.",
                 actor=who, source="ui", status="success" if result["found"] else "failure", details={"tx_hash": body.tx_hash})
    return result


# ------------------------------------------------------------------ voting / treasury
@router.get("/voting")
def voting_overview(proposal: str | None = None, db: Session = Depends(get_db)) -> dict[str, Any]:
    return voting.overview(db, proposal)


@router.get("/voting/delegates")
def voting_delegates(db: Session = Depends(get_db)) -> dict[str, Any]:
    return voting.delegates(db)


@router.get("/treasury")
def treasury_overview(db: Session = Depends(get_db)) -> dict[str, Any]:
    return treasury.overview(db)


@router.put("/treasury/inputs")
def treasury_inputs(body: TreasuryInputsIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    saved = treasury.save_inputs(db, body.model_dump())
    audit.record(event_type="treasury_inputs_updated", summary="Treasury burn and commitment inputs edited (manual inputs, not chain data).",
                 actor=who, source="ui", status="info", details=saved)
    return saved


# ------------------------------------------------------------------ reports
@router.get("/reports")
def list_reports(db: Session = Depends(get_db)) -> dict[str, Any]:
    rows = db.scalars(select(Report).order_by(Report.generated_at.desc()))
    return {"items": [reports.serialize(r) for r in rows], "sections": reports.SECTIONS}


@router.post("/reports", status_code=201)
def create_report(body: ReportIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, body.proposal_id)
    return reports.serialize(reports.generate(db, p, body.format, body.sections, who))


@router.get("/reports/{report_id}/download")
def download_report(report_id: str, db: Session = Depends(get_db)) -> FileResponse:
    r = db.get(Report, report_id)
    if r is None:
        raise NotFound("report_not_found", "Report not found.")
    path = reports.file_path(r)
    if not path.exists():
        raise NotFound("report_file_missing", "The report file is no longer on disk.")
    media = {"pdf": "application/pdf", "json": "application/json", "csv": "text/csv"}[r.format]
    return FileResponse(path, media_type=media, filename=r.file_name)
