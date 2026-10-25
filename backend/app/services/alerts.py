"""Alert inbox and triage workflow. Every transition is appended to the alert's history and the
audit ledger; resolutions and dismissals require a written justification."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..clock import iso, utcnow
from ..errors import Conflict, ValidationFailed
from ..models import Alert, new_id
from . import audit

TRANSITIONS: dict[str, tuple[set[str], str]] = {
    "assign": ({"new", "triaged", "escalated"}, ""),
    "triage": ({"new"}, "triaged"),
    "escalate": ({"new", "triaged"}, "escalated"),
    "resolve": ({"new", "triaged", "escalated"}, "resolved"),
    "dismiss": ({"new", "triaged", "escalated"}, "dismissed"),
    "reopen": ({"resolved", "dismissed"}, "triaged"),
}


def raise_alert(
    db: Session,
    *,
    proposal_id: str | None,
    source: str,
    severity: str,
    title: str,
    description: str,
    finding_id: str | None = None,
    data: dict[str, Any] | None = None,
) -> Alert:
    existing = db.scalars(
        select(Alert).where(Alert.proposal_id == proposal_id, Alert.title == title, Alert.status.in_(["new", "triaged", "escalated"]))
    ).first()
    now = iso(utcnow())
    if existing:
        existing.history = [*existing.history, {"action": "re-triggered", "by": "DAOGuard", "at": now, "note": description[:300]}]
        existing.data = {**existing.data, "latest": data or {}}
        existing.updated_at = utcnow()
        return existing
    alert = Alert(
        id=new_id("AL"),
        proposal_id=proposal_id,
        finding_id=finding_id,
        source=source,
        severity=severity,
        title=title,
        description=description,
        status="new",
        history=[{"action": "created", "by": "DAOGuard", "at": now, "note": f"Raised by {source}"}],
        data=data or {},
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    db.add(alert)
    # Commit before the ledger append: the ledger writes in its own transaction and SQLite allows
    # one writer, so holding an uncommitted write here would deadlock against it.
    db.commit()
    audit.record(event_type="alert_raised", summary=f"[{severity.upper()}] {title}", actor="DAOGuard", source="system",
                 status="warning" if severity in ("medium", "low", "info") else "failure", proposal_id=proposal_id,
                 details={"alert_id": alert.id, "source": source})
    return alert


def transition(db: Session, alert: Alert, action: str, actor: str, note: str = "", assignee: str | None = None) -> Alert:
    if action not in TRANSITIONS:
        raise ValidationFailed("invalid_action", f"Unknown action {action}.")
    allowed_from, target = TRANSITIONS[action]
    if alert.status not in allowed_from:
        raise Conflict("invalid_transition", f"Cannot {action} an alert that is {alert.status}.")
    if action in ("resolve", "dismiss", "escalate") and len(note.strip()) < 8:
        raise ValidationFailed("justification_required", f"A written justification is required to {action} an alert.")
    if action == "assign":
        if not assignee or not assignee.strip():
            raise ValidationFailed("assignee_required", "Choose who should review this alert.")
        alert.assignee = assignee.strip()
        if alert.status == "new":
            alert.status = "triaged"
    else:
        alert.status = target
    if action in ("resolve", "dismiss"):
        alert.resolution = note.strip()
    alert.history = [*alert.history, {"action": action, "by": actor, "at": iso(utcnow()), "note": note.strip(), "assignee": assignee}]
    alert.updated_at = utcnow()
    db.commit()
    audit.record(event_type=f"alert_{action}", summary=f"Alert {alert.id} {action}d by {actor}" + (f": {note.strip()[:160]}" if note.strip() else "."),
                 actor=actor, source="ui", status="info", proposal_id=alert.proposal_id,
                 details={"alert_id": alert.id, "status": alert.status, "assignee": alert.assignee, "note": note.strip()})
    return alert


def record_action(db: Session, alert: Alert, action: str, actor: str, note: str, data: dict[str, Any] | None = None) -> None:
    alert.history = [*alert.history, {"action": action, "by": actor, "at": iso(utcnow()), "note": note, "data": data or {}}]
    alert.updated_at = utcnow()
    if alert.status == "new":
        alert.status = "escalated" if action in ("halted", "dispute_filed") else "triaged"
    db.commit()


def serialize(a: Alert) -> dict[str, Any]:
    return {
        "id": a.id, "proposal_id": a.proposal_id, "finding_id": a.finding_id, "source": a.source, "severity": a.severity,
        "title": a.title, "description": a.description, "status": a.status, "assignee": a.assignee, "resolution": a.resolution,
        "history": a.history, "data": a.data, "created_at": iso(a.created_at), "updated_at": iso(a.updated_at),
    }
