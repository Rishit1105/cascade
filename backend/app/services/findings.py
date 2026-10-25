"""Findings store. A finding's original statement is immutable; status changes are appended to
its history, and re-running an analysis supersedes (never deletes) findings that no longer apply."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..clock import iso, utcnow
from ..models import Finding, new_id
from .canonical import content_hash

SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
# Execution and simulation raise their own, more specific alerts.
ALERT_SEVERITIES = {"critical", "high"}


def fingerprint(proposal_id: str, kind: str, rule_id: str, key: Any) -> str:
    return content_hash({"p": proposal_id, "k": kind, "r": rule_id, "key": key})


def sync_findings(
    db: Session,
    proposal_id: str,
    kind: str,
    new_items: list[dict[str, Any]],
    source_ref: str | None = None,
) -> list[Finding]:
    """Upsert findings of one kind by fingerprint; supersede open ones that disappeared."""
    existing = {
        f.fingerprint: f
        for f in db.scalars(
            select(Finding).where(Finding.proposal_id == proposal_id, Finding.kind == kind, Finding.superseded_at.is_(None))
        )
    }
    kept: list[Finding] = []
    seen: set[str] = set()
    for item in new_items:
        fp = fingerprint(proposal_id, kind, item["rule_id"], item.get("key", item["title"]))
        seen.add(fp)
        if fp in existing:
            kept.append(existing[fp])
            continue
        finding = Finding(
            id=new_id("F"),
            proposal_id=proposal_id,
            kind=kind,
            rule_id=item["rule_id"],
            severity=item["severity"],
            confidence=item.get("confidence", "source-supported"),
            title=item["title"],
            explanation=item["explanation"],
            remediation=item.get("remediation"),
            evidence_refs=item.get("evidence_refs", []),
            data=item.get("data", {}),
            fingerprint=fp,
            status="open",
            status_history=[{"status": "open", "at": iso(utcnow()), "by": "DAOGuard", "note": "created"}],
            source_ref=source_ref,
        )
        db.add(finding)
        kept.append(finding)
        if finding.severity in ALERT_SEVERITIES and kind not in ("execution", "simulation"):
            from .alerts import raise_alert  # alerts → audit → db; imported lazily to avoid a cycle

            raise_alert(db, proposal_id=proposal_id, source=kind, severity=finding.severity, title=finding.title,
                        description=finding.explanation, finding_id=finding.id, data={"rule_id": finding.rule_id})
    for fp, finding in existing.items():
        if fp not in seen and finding.status in ("open", "challenged"):
            finding.superseded_at = utcnow()
            finding.status_history = [
                *finding.status_history,
                {"status": "superseded", "at": iso(utcnow()), "by": "DAOGuard", "note": "no longer produced by the latest analysis"},
            ]
    return kept


def set_status(finding: Finding, status: str, by: str, note: str) -> None:
    finding.status = status
    finding.status_history = [*finding.status_history, {"status": status, "at": iso(utcnow()), "by": by, "note": note}]


def serialize(f: Finding) -> dict[str, Any]:
    return {
        "id": f.id,
        "proposal_id": f.proposal_id,
        "kind": f.kind,
        "rule_id": f.rule_id,
        "severity": f.severity,
        "confidence": f.confidence,
        "title": f.title,
        "explanation": f.explanation,
        "remediation": f.remediation,
        "evidence_refs": f.evidence_refs,
        "data": f.data,
        "status": f.status,
        "status_history": f.status_history,
        "source_ref": f.source_ref,
        "created_at": iso(f.created_at),
        "superseded": f.superseded_at is not None,
    }


def active_findings(db: Session, proposal_id: str, kinds: list[str] | None = None) -> list[Finding]:
    query = select(Finding).where(Finding.proposal_id == proposal_id, Finding.superseded_at.is_(None))
    if kinds:
        query = query.where(Finding.kind.in_(kinds))
    items = list(db.scalars(query))
    items.sort(key=lambda f: (SEVERITY_ORDER.get(f.severity, 9), f.created_at))
    return items
