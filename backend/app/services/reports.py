"""Audit report export (PDF / JSON / CSV).

Reports preserve evidence labels (chain-confirmed vs off-chain, verified vs heuristic) and always
include limitations and the demo-data notice, so exported material never overstates conclusions.
"""

from __future__ import annotations

import csv
import io
import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..clock import iso, utcnow
from ..config import get_settings
from ..errors import ValidationFailed
from ..models import AuditEvent, ExecutionAttempt, ExecutionCheck, Proposal, Report, Simulation, new_id
from ..runtime import runtime
from . import audit
from .canonical import sha256_hex
from .findings import active_findings
from .findings import serialize as serialize_finding
from .labels import format_units

SECTIONS = {
    "proposal": "Proposal details",
    "versions": "Versions and commitments",
    "evidence": "Evidence register",
    "analysis": "Brief and information gaps",
    "financial": "Financial impact",
    "voting": "Voting record",
    "conflicts": "Conflict-of-interest review",
    "execution": "Execution checks and attempts",
    "simulation": "Simulation results",
    "timeline": "Audit timeline",
}
FORMATS = {"pdf", "json", "csv"}
LIMITATIONS = [
    "All entities, amounts and transactions are fictional demo data on a local development chain.",
    "Hashes prove that content equals what was committed; they do not prove the content is true.",
    "Relationship edges show observed value transfers or statements, not common ownership or misconduct.",
    "Simulation results describe behaviour against the chain state at the time of simulation, not under all future states.",
    "Risk-chain figures are outputs of a configurable model, not probabilities of fraud.",
    "The ExecutionGuard enforces only transactions routed through it; it cannot stop transactions sent to other contracts.",
]


def build(db: Session, p: Proposal, sections: list[str]) -> dict[str, Any]:
    from . import coi, governance, treasury
    from .analysis.service import latest as latest_analysis

    data: dict[str, Any] = {
        "report_type": "DAOGuard audit report",
        "generated_at": iso(utcnow()),
        "data_label": "DEMO DATA: fictional DAO on a local chain",
        "proposal_id": p.id,
        "chain": {"chain_id": runtime.deployment.chain_id if runtime.deployment else None,
                  "block": runtime.chain.block_number() if runtime.deployment else None},
        "limitations": LIMITATIONS,
        "sections": {},
    }
    s = data["sections"]
    if "proposal" in sections:
        s["proposal"] = {"id": p.id, "title": p.title, "category": p.category, "status": p.status, "proposer": p.proposer_address,
                         "proposer_label": p.proposer_label, "recipient": p.recipient_address, "recipient_label": p.recipient_label,
                         "requested": f"{format_units(p.requested_amount_base, p.token_decimals)} {p.token_symbol}", "summary": p.summary,
                         "current_version": p.current_version}
    if "versions" in sections:
        s["versions"] = [{"version": v.version, "committed_at": iso(v.committed_at), "author": v.author, "content_hash": v.content_hash,
                          "manifest_hash": v.manifest_hash, "evidence_root": v.evidence_root, "disclosure_hash": v.disclosure_hash,
                          "tx_hash": v.tx_hash, "block_number": v.block_number, "governance_status": v.governance_status,
                          "changed_fields": v.changed_fields, "verification": "chain-confirmed (ProposalRegistry)"} for v in p.versions]
    if "evidence" in sections:
        s["evidence"] = [{"id": e.id, "name": e.name, "type": e.source_type, "content_hash": e.content_hash, "verification": e.verification_status,
                          "injection_flags": len(e.injection_flags or []), "added_at": iso(e.added_at)} for e in p.evidence]
    if "analysis" in sections:
        run = latest_analysis(db, p.id)
        s["analysis"] = {
            "mode": run.output.get("mode_label") if run else None,
            "summary": [x["text"] for x in (run.output.get("summary", []) if run else [])],
            "coverage": run.output.get("coverage") if run else None,
            "findings": [serialize_finding(f) for f in active_findings(db, p.id, ["missing_info", "analysis", "injection"])],
        }
    if "financial" in sections and p.requested_amount_base and int(p.requested_amount_base):
        imp = treasury.impact(db, p)
        s["financial"] = {k: imp[k] for k in ("as_of", "block_number", "balance_base", "requested_base", "share_of_treasury_pct", "remaining_balance_base",
                                               "available_after_base", "runway_before_months", "runway_after_months", "formulas", "assumptions", "scenarios")}
    if "voting" in sections:
        st = governance.state(db, p)
        s["voting"] = {k: st.get(k) for k in ("state", "votes", "quorum", "quorum_reached", "participation_pct", "snapshot_block", "deadline_block", "guard")}
        s["voting"]["voters"] = [{"voter": v["voter"], "label": v.get("voter_label"), "support": v["support"], "weight": v["weight"], "tx_hash": v["tx_hash"]}
                                 for v in st.get("voters", [])]
    if "conflicts" in sections:
        c = coi.analyze(db, p, persist=False)
        s["conflicts"] = {"findings": c["findings"], "connection_index": c["connection_index"], "method": c["connection_index_method"],
                          "transactions": c["transactions"], "note": c["note"], "disclosure": c["disclosure"]}
    if "execution" in sections:
        s["execution"] = {
            "checks": [{"id": c.id, "scenario": c.scenario, "status": c.status, "submitted_hash": c.submitted_manifest_hash,
                        "rules": [d["rule_id"] for d in c.discrepancies], "checked_at": iso(c.checked_at), "nature": "advisory"}
                       for c in db.scalars(select(ExecutionCheck).where(ExecutionCheck.proposal_id == p.id).order_by(ExecutionCheck.checked_at))],
            "attempts": [{"id": a.id, "scenario": a.scenario, "outcome": a.outcome, "tx_hash": a.tx_hash, "block_number": a.block_number,
                          "revert": (a.revert or {}).get("name"), "explanation": (a.revert or {}).get("explanation"),
                          "nature": "contract-enforced" if a.tx_hash else "gateway refusal"}
                         for a in db.scalars(select(ExecutionAttempt).where(ExecutionAttempt.proposal_id == p.id).order_by(ExecutionAttempt.created_at))],
        }
    if "simulation" in sections:
        s["simulation"] = [{"id": x.id, "version": x.version, "trigger": x.trigger, "verdict": x.verdict, "summary": (x.report or {}).get("summary"),
                            "findings": [{"rule_id": f["rule_id"], "severity": f["severity"], "title": f["title"]} for f in (x.report or {}).get("findings", [])],
                            "chain_block": x.chain_block, "finished_at": iso(x.finished_at)}
                           for x in db.scalars(select(Simulation).where(Simulation.proposal_id == p.id).order_by(Simulation.started_at))]
    if "timeline" in sections:
        s["timeline"] = [{"seq": e.seq, "at": iso(e.occurred_at), "type": e.event_type, "actor": e.actor, "status": e.status, "summary": e.summary,
                          "verification": e.verification, "tx_hash": e.tx_hash, "block_number": e.block_number, "event_hash": e.event_hash}
                         for e in db.scalars(select(AuditEvent).where(AuditEvent.proposal_id == p.id).order_by(AuditEvent.seq))]
    return data


def _csv(data: dict[str, Any]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["section", "item", "field", "value", "verification"])
    w.writerow(["meta", "report", "generated_at", data["generated_at"], ""])
    w.writerow(["meta", "report", "data_label", data["data_label"], ""])
    for i, lim in enumerate(data["limitations"]):
        w.writerow(["meta", f"limitation {i + 1}", "text", lim, ""])

    def walk(section: str, item: str, value: Any, prefix: str = "") -> None:
        if isinstance(value, dict):
            verification = value.get("verification") or value.get("nature") or value.get("confidence") or ""
            for k, v in value.items():
                if isinstance(v, (dict, list)):
                    walk(section, item, v, f"{prefix}{k}.")
                else:
                    w.writerow([section, item, f"{prefix}{k}", v, verification])
        elif isinstance(value, list):
            for i, v in enumerate(value):
                walk(section, f"{item}[{i}]" if item else str(i), v, prefix)
        else:
            w.writerow([section, item, prefix.rstrip("."), value, ""])

    for section, value in data["sections"].items():
        walk(section, "", value)
    return buf.getvalue().encode("utf-8")


def _pdf(data: dict[str, Any]) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    from xml.sax.saxutils import escape

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
                            title=f"DAOGuard audit report {data['proposal_id']}", author="DAOGuard")
    styles = getSampleStyleSheet()
    teal = colors.HexColor("#168A78")
    body = ParagraphStyle("body", parent=styles["BodyText"], fontSize=8.5, leading=11)
    small = ParagraphStyle("small", parent=body, fontSize=7.5, leading=9.5, textColor=colors.HexColor("#4B5563"))
    h1 = ParagraphStyle("h1", parent=styles["Heading1"], fontSize=16, textColor=colors.HexColor("#17212B"))
    h2 = ParagraphStyle("h2", parent=styles["Heading2"], fontSize=11.5, textColor=teal, spaceBefore=10)
    P = lambda t, st=body: Paragraph(escape(str(t if t is not None else "—")), st)  # noqa: E731

    def table(rows: list[list[Any]], widths: list[float] | None = None) -> Table:
        t = Table([[P(c, small) for c in r] for r in rows], colWidths=widths, repeatRows=1)
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F4F6")),
            ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#DDE3E8")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ]))
        return t

    story: list[Any] = [P("DAOGuard audit report", h1), P(f"{data['proposal_id']} · generated {data['generated_at']} · chain {data['chain']['chain_id']} block {data['chain']['block']}", small),
                        Spacer(1, 4), P(data["data_label"], ParagraphStyle("warn", parent=body, textColor=colors.HexColor("#B7791F")))]
    s = data["sections"]
    if "proposal" in s:
        story += [P(SECTIONS["proposal"], h2), table([["Field", "Value"]] + [[k, v] for k, v in s["proposal"].items()], [40 * mm, 138 * mm])]
    if "versions" in s:
        story += [P(SECTIONS["versions"], h2), table([["v", "Committed", "Content hash", "Manifest hash", "Tx / block", "Status"]] +
                                                     [[v["version"], v["committed_at"], v["content_hash"], v["manifest_hash"], f"{v['tx_hash']} / {v['block_number']}", v["governance_status"]] for v in s["versions"]],
                                                     [8 * mm, 26 * mm, 40 * mm, 40 * mm, 46 * mm, 18 * mm])]
    if "evidence" in s:
        story += [P(SECTIONS["evidence"], h2), table([["ID", "Name", "Type", "Content hash", "Verification"]] +
                                                     [[e["id"], e["name"], e["type"], e["content_hash"], e["verification"] + (f" · {e['injection_flags']} injection flag(s)" if e["injection_flags"] else "")] for e in s["evidence"]],
                                                     [20 * mm, 45 * mm, 15 * mm, 68 * mm, 30 * mm])]
    if "analysis" in s:
        a = s["analysis"]
        story += [P(SECTIONS["analysis"], h2), P(f"Mode: {a['mode']}", small)] + [P(f"• {x}") for x in a["summary"]]
        if a["findings"]:
            story.append(table([["Rule", "Severity", "Finding", "Question to ask"]] + [[f["rule_id"], f["severity"], f["title"], f["remediation"]] for f in a["findings"]],
                               [18 * mm, 16 * mm, 70 * mm, 74 * mm]))
    if "financial" in s:
        f = s["financial"]
        story += [P(SECTIONS["financial"], h2), P(f"As of block {f['block_number']} ({f['as_of']}).", small),
                  table([["Measure", "Formula", "Value"]] + [[x["name"], x["formula"], x["value"]] for x in f["formulas"]], [40 * mm, 88 * mm, 50 * mm])]
        story += [P("Assumptions", small)] + [P(f"• {x}", small) for x in f["assumptions"]]
    if "voting" in s:
        v = s["voting"]
        story += [P(SECTIONS["voting"], h2), P(f"State: {v.get('state')} · quorum reached: {v.get('quorum_reached')} · participation {v.get('participation_pct')}%", small)]
        if v.get("voters"):
            story.append(table([["Voter", "Support", "Weight (wei)", "Tx"]] + [[x["label"] or x["voter"], x["support"], x["weight"], x["tx_hash"]] for x in v["voters"]],
                               [50 * mm, 18 * mm, 40 * mm, 70 * mm]))
    if "conflicts" in s:
        c = s["conflicts"]
        story += [P(SECTIONS["conflicts"], h2), P(c["note"], small)]
        if c["findings"]:
            story.append(table([["Rule", "Severity", "Confidence", "Finding"]] + [[x["rule_id"], x["severity"], x["confidence"], x["title"]] for x in c["findings"]],
                               [18 * mm, 18 * mm, 22 * mm, 120 * mm]))
    if "execution" in s:
        e = s["execution"]
        story += [P(SECTIONS["execution"], h2)]
        if e["attempts"]:
            story.append(table([["Attempt", "Scenario", "Outcome", "Enforcement", "Tx / block", "Reason"]] +
                               [[x["id"], x["scenario"], x["outcome"], x["nature"], f"{x['tx_hash']} / {x['block_number']}", x["explanation"]] for x in e["attempts"]],
                               [18 * mm, 22 * mm, 16 * mm, 22 * mm, 50 * mm, 50 * mm]))
        else:
            story.append(P("No execution attempts recorded.", small))
    if "simulation" in s:
        story += [P(SECTIONS["simulation"], h2)]
        for x in s["simulation"]:
            story += [P(f"{x['id']} · v{x['version']} · {x['trigger']} · verdict {x['verdict'].upper()}"), P(x["summary"] or "", small)]
    if "timeline" in s:
        story += [P(SECTIONS["timeline"], h2), table([["#", "When", "Event", "Verification", "Summary"]] +
                                                     [[t["seq"], t["at"], t["type"], t["verification"], t["summary"]] for t in s["timeline"]],
                                                     [8 * mm, 30 * mm, 30 * mm, 24 * mm, 86 * mm])]
    story += [P("Limitations", h2)] + [P(f"• {x}", small) for x in data["limitations"]]
    doc.build(story)
    return buf.getvalue()


def generate(db: Session, p: Proposal, fmt: str, sections: list[str], actor: str) -> Report:
    if fmt not in FORMATS:
        raise ValidationFailed("invalid_format", "format must be pdf, json or csv")
    sections = [x for x in sections if x in SECTIONS] or list(SECTIONS)
    data = build(db, p, sections)
    if fmt == "json":
        payload = json.dumps(data, indent=2, default=str).encode("utf-8")
    elif fmt == "csv":
        payload = _csv(data)
    else:
        payload = _pdf(data)
    rid = new_id("RPT")
    stamp = utcnow().strftime("%Y%m%d-%H%M%S")
    name = f"DAOGuard_{p.id}_{stamp}.{fmt}"
    path = get_settings().reports_dir / f"{rid}_{name}"
    path.write_bytes(payload)
    report = Report(id=rid, proposal_id=p.id, format=fmt, sections=sections, file_name=name, sha256="sha256:" + sha256_hex(payload),
                    size_bytes=len(payload), generated_by=actor, generated_at=utcnow())
    db.add(report)
    db.commit()
    audit.record(event_type="report_generated", summary=f"{fmt.upper()} audit report for {p.id} generated ({len(sections)} section(s)).",
                 actor=actor, source="ui", status="info", proposal_id=p.id, details={"report_id": rid, "sha256": report.sha256, "sections": sections})
    return report


def file_path(report: Report):
    return get_settings().reports_dir / f"{report.id}_{report.file_name}"


def serialize(r: Report) -> dict[str, Any]:
    return {"id": r.id, "proposal_id": r.proposal_id, "format": r.format, "sections": r.sections, "file_name": r.file_name, "sha256": r.sha256,
            "size_bytes": r.size_bytes, "generated_by": r.generated_by, "generated_at": iso(r.generated_at)}
