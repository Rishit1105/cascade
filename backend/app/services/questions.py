"""Proposer Q&A: turns missing-information findings into questions the proposer must answer.

Loop: a reviewer asks (usually from a missing-information finding) → the proposer answers, the
answer signed with EIP-712 by the proposer's address and optionally backed by new evidence → a
reviewer accepts it (the finding is resolved, which updates the evaluation chain) or asks for more.
Accepting an answer records that a reviewer found it sufficient; it does not make the answer true.
"""

from __future__ import annotations

from typing import Any

from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import to_checksum_address
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..clock import iso, utcnow
from ..errors import Conflict, NotFound, ValidationFailed
from ..models import Finding, Proposal, Question, new_id
from ..runtime import Deployment, runtime
from . import audit, evidence
from .canonical import content_hash, sha256_tagged
from .findings import active_findings, set_status
from .notifications import notify
from .proposals import latest_version

ASKABLE_KINDS = ("missing_info", "analysis", "conflict")
OPEN_STATES = ("open", "needs_more")


def answer_typed_data(deployment: Deployment, proposal_key: str, question_id: str, round_: int, answer_hash: str) -> dict[str, Any]:
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "ProposerAnswer": [
                {"name": "proposalKey", "type": "bytes32"},
                {"name": "questionId", "type": "string"},
                {"name": "round", "type": "uint64"},
                {"name": "answerHash", "type": "bytes32"},
            ],
        },
        "primaryType": "ProposerAnswer",
        "domain": {"name": "DAOGuard Q&A", "version": "1", "chainId": deployment.chain_id, "verifyingContract": deployment.c("registry")},
        "message": {"proposalKey": proposal_key, "questionId": question_id, "round": round_, "answerHash": answer_hash},
    }


def _answer_hash(question_id: str, round_: int, text: str, evidence_digest: str | None) -> str:
    return content_hash({"question_id": question_id, "round": round_, "text": text, "evidence": evidence_digest})


def recover_signer(typed: dict[str, Any], signature: str) -> str:
    return to_checksum_address(Account.recover_message(encode_typed_data(full_message=typed), signature=signature))


def get_question(db: Session, question_id: str, proposal_id: str | None = None) -> Question:
    q = db.get(Question, question_id)
    if q is None or (proposal_id and q.proposal_id != proposal_id):
        raise NotFound("question_not_found", f"Question {question_id} does not exist.")
    return q


def _entry(kind: str, author: str, role: str, text: str, **extra: Any) -> dict[str, Any]:
    return {"kind": kind, "author": author, "role": role, "at": iso(utcnow()), "text": text, **extra}


def ask(db: Session, p: Proposal, *, text: str, actor: str, finding_id: str | None = None, source: str = "ui") -> Question:
    text = text.strip()
    if len(text) < 10:
        raise ValidationFailed("question_too_short", "Write the question as a full sentence (at least 10 characters).")
    finding: Finding | None = None
    if finding_id:
        finding = db.get(Finding, finding_id)
        if finding is None or finding.proposal_id != p.id:
            raise NotFound("finding_not_found", "Finding not found on this proposal.")
        if finding.status in ("resolved", "dismissed"):
            raise Conflict("finding_closed", f"Finding {finding.id} is already {finding.status}.")
        existing = db.scalars(select(Question).where(Question.finding_id == finding.id, Question.status.in_([*OPEN_STATES, "answered"]))).first()
        if existing:
            raise Conflict("question_exists", f"{existing.id} already asks about this finding.", {"question_id": existing.id})
    v = latest_version(p)
    q = Question(id=new_id("Q"), proposal_id=p.id, finding_id=finding.id if finding else None, rule_id=finding.rule_id if finding else None,
                 version=v.version if v else 0, text=text, status="open", asked_by=actor, asked_at=utcnow(), updated_at=utcnow(),
                 thread=[_entry("question", actor, "reviewer", text)])
    db.add(q)
    notify(db, "info", f"Question for the proposer of {p.id}", text[:300], f"/proposals/{p.id}?tab=qa", audience="proposer")
    db.commit()
    audit.record(event_type="question_asked", summary=f"{actor} asked the proposer of {p.id}: “{text[:160]}”", actor=actor, source=source,
                 status="info", proposal_id=p.id, version=q.version,
                 details={"question_id": q.id, "finding_id": q.finding_id, "rule_id": q.rule_id, "question_hash": content_hash({"q": q.id, "text": text})})
    return q


def answer(db: Session, p: Proposal, q: Question, *, text: str, actor: str, evidence_name: str | None = None, evidence_text: str | None = None,
           source: str = "ui") -> Question:
    if q.status not in OPEN_STATES:
        raise Conflict("question_not_open", f"{q.id} is {q.status}; only open questions can be answered.")
    text = text.strip()
    if len(text) < 10:
        raise ValidationFailed("answer_too_short", "The answer must be at least 10 characters.")
    deployment = runtime.require_deployment()
    if p.proposer_address not in deployment.accounts.values():
        raise Conflict("proposer_cannot_sign", "The proposer address is not a demo node account, so it cannot sign answers in this sandbox.")

    has_evidence = bool(evidence_text and evidence_text.strip())
    round_ = sum(1 for e in q.thread if e["kind"] == "answer") + 1
    # The signature covers the evidence digest, so the answer and its attachment cannot be separated later.
    evidence_digest = sha256_tagged(evidence_text.encode("utf-8")) if has_evidence else None
    answer_hash = _answer_hash(q.id, round_, text, evidence_digest)
    typed = answer_typed_data(deployment, p.key, q.id, round_, answer_hash)
    signature = runtime.chain.sign_typed_data(p.proposer_address, typed)
    signer = recover_signer(typed, signature)
    if signer.lower() != p.proposer_address.lower():
        raise Conflict("signature_mismatch", f"Answer signature recovered {signer}, not the proposer.")
    doc = None
    if has_evidence:
        doc = evidence.attach(db, p, name=(evidence_name or f"Answer to {q.id}").strip()[:200], source_type="note", text=evidence_text,
                              actor=actor, source=source)

    # The answer belongs to the proposer (whose key signs it); entered_by records who typed it in.
    q.thread = [*q.thread, _entry("answer", p.proposer_label or p.proposer_address, "proposer", text, entered_by=actor, round=round_, answer_hash=answer_hash, signature=signature, signer=signer,
                                  evidence_id=doc.id if doc else None, evidence_name=doc.name if doc else None, evidence_hash=evidence_digest)]
    q.status, q.updated_at = "answered", utcnow()
    notify(db, "info", f"Proposer answered {q.id} on {p.id}", text[:300], f"/proposals/{p.id}?tab=qa")
    db.commit()
    audit.record(event_type="question_answered", summary=f"Proposer of {p.id} answered {q.id} (round {round_}), signed by {signer[:10]}…"
                 + (f" with new evidence “{doc.name}”." if doc else "."),
                 actor=actor, source=source, status="info", proposal_id=p.id, version=q.version,
                 details={"question_id": q.id, "round": round_, "answer_hash": answer_hash, "signer": signer, "evidence_id": doc.id if doc else None})
    return q


def review(db: Session, p: Proposal, q: Question, *, decision: str, note: str, actor: str, source: str = "ui") -> Question:
    if q.status != "answered":
        raise Conflict("question_not_answered", f"{q.id} is {q.status}; only an answered question can be reviewed.")
    note = note.strip()
    if decision not in ("accept", "needs_more"):
        raise ValidationFailed("invalid_decision", "decision must be accept or needs_more.")
    if decision == "needs_more" and len(note) < 10:
        raise ValidationFailed("follow_up_required", "Say what is still missing (at least 10 characters).")
    finding = db.get(Finding, q.finding_id) if q.finding_id else None
    if decision == "accept":
        q.thread = [*q.thread, _entry("accepted", actor, "reviewer", note or "Answer accepted as sufficient.")]
        q.status = "accepted"
        if finding and finding.status in ("open", "challenged"):
            set_status(finding, "resolved", actor, f"Resolved by the proposer's signed answer to {q.id}." + (f" {note[:200]}" if note else ""))
    else:
        q.thread = [*q.thread, _entry("follow_up", actor, "reviewer", note)]
        q.status = "needs_more"
        notify(db, "warning", f"Follow-up needed on {q.id}", note[:300], f"/proposals/{p.id}?tab=qa", audience="proposer")
    q.updated_at = utcnow()
    db.commit()
    audit.record(event_type="answer_accepted" if decision == "accept" else "answer_insufficient",
                 summary=(f"{actor} accepted the proposer's answer to {q.id}" + (f"; finding {finding.id} resolved." if finding and decision == "accept" else "."))
                 if decision == "accept" else f"{actor} found the answer to {q.id} insufficient: {note[:160]}",
                 actor=actor, source=source, status="success" if decision == "accept" else "warning", proposal_id=p.id, version=q.version,
                 details={"question_id": q.id, "finding_id": q.finding_id, "decision": decision})
    return q


def withdraw(db: Session, p: Proposal, q: Question, *, note: str, actor: str, source: str = "ui") -> Question:
    if q.status == "accepted":
        raise Conflict("question_closed", f"{q.id} was already accepted.")
    q.thread = [*q.thread, _entry("withdrawn", actor, "reviewer", note.strip() or "Question withdrawn.")]
    q.status, q.updated_at = "withdrawn", utcnow()
    db.commit()
    audit.record(event_type="question_withdrawn", summary=f"{actor} withdrew {q.id}.", actor=actor, source=source, status="info",
                 proposal_id=p.id, details={"question_id": q.id})
    return q


def serialize(db: Session, p: Proposal, q: Question) -> dict[str, Any]:
    finding = db.get(Finding, q.finding_id) if q.finding_id else None
    deployment = runtime.deployment
    thread = []
    for e in q.thread:
        item = dict(e)
        if e["kind"] == "answer" and deployment is not None:
            # Re-derive the hash from the stored text: an edited answer no longer matches what was signed.
            try:
                recomputed = _answer_hash(q.id, e["round"], e["text"], e.get("evidence_hash"))
                typed = answer_typed_data(deployment, p.key, q.id, e["round"], recomputed)
                item["signature_valid"] = recomputed == e["answer_hash"] and recover_signer(typed, e["signature"]).lower() == p.proposer_address.lower()
            except Exception:  # malformed entry
                item["signature_valid"] = False
        thread.append(item)
    return {
        "id": q.id,
        "proposal_id": q.proposal_id,
        "finding": {"id": finding.id, "title": finding.title, "severity": finding.severity, "status": finding.status, "kind": finding.kind,
                    "superseded": finding.superseded_at is not None} if finding else None,
        "rule_id": q.rule_id,
        "version": q.version,
        "text": q.text,
        "status": q.status,
        "asked_by": q.asked_by,
        "asked_at": iso(q.asked_at),
        "updated_at": iso(q.updated_at),
        "thread": thread,
    }


def overview(db: Session, p: Proposal) -> dict[str, Any]:
    """Questions plus the open findings nobody has asked about yet (suggested questions)."""
    questions = list(db.scalars(select(Question).where(Question.proposal_id == p.id).order_by(Question.asked_at.desc())))
    asked = {q.finding_id for q in questions if q.finding_id and q.status != "withdrawn"}
    suggestions = [
        {"finding_id": f.id, "rule_id": f.rule_id, "severity": f.severity, "title": f.title, "kind": f.kind,
         "question": f.remediation or f"Please address: {f.title}"}
        for f in active_findings(db, p.id, list(ASKABLE_KINDS))
        if f.status in ("open", "challenged") and f.id not in asked and f.severity != "info"
    ]
    counts = {s: sum(1 for q in questions if q.status == s) for s in ("open", "answered", "needs_more", "accepted", "withdrawn")}
    return {"items": [serialize(db, p, q) for q in questions], "suggestions": suggestions, "counts": counts,
            "note": "Answers are signed by the proposer's address, so they cannot be disowned later. Accepting an answer records a reviewer's judgement; it does not prove the answer is true."}
