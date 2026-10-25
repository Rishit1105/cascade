from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..clock import iso, utcnow
from ..db import get_db
from ..errors import Conflict, NotFound, ValidationFailed
from ..models import Challenge, EvidenceDocument, Finding, MilestoneTracking, new_id
from ..runtime import runtime
from ..services import audit, coi, evidence, governance, proposals, questions, risk_chain, treasury, views
from ..services.analysis import service as analysis
from ..services.analysis.text import ADDRESS_RE, parse_amounts
from ..services.canonical import merkle_proof, verify_merkle_proof
from ..services.findings import active_findings, set_status
from ..services.findings import serialize as serialize_finding
from .deps import actor, require_ready
from .schemas import (AdvanceIn, AnswerIn, AnswerReviewIn, ChallengeIn, ChallengeResponseIn, CommitIn, DisclosureIn, EvidenceIn,
                      FindingStatusIn, MilestoneUpdateIn, ProposalCreate, ProposalPatch, QuestionIn, VoteIn, WithdrawIn)

router = APIRouter(prefix="/api", dependencies=[Depends(require_ready)])


@router.get("/proposals")
def list_proposals(
    status: str | None = None, q: str | None = None, category: str | None = None,
    min_amount: int | None = Query(default=None, ge=0), max_amount: int | None = Query(default=None, ge=0),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    return {"items": views.list_proposals(db, status, q, category, min_amount, max_amount)}


@router.post("/proposals", status_code=201)
def create(body: ProposalCreate, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.create_proposal(db, body.model_dump(), who)
    return views.proposal_detail(db, p)


@router.post("/proposals/import", status_code=201)
async def import_proposal(
    file: UploadFile = File(...),
    proposer_role: str = Form("community"),
    db: Session = Depends(get_db),
    who: str = Depends(actor),
) -> dict[str, Any]:
    deployment = runtime.require_deployment()
    if proposer_role not in deployment.accounts:
        raise ValidationFailed("invalid_proposer", "Choose one of the demo accounts as proposer.")
    raw = await file.read()
    name = file.filename or "imported-proposal"
    is_pdf = name.lower().endswith(".pdf") or raw.startswith(b"%PDF")
    if is_pdf:
        pages = evidence.pdf_pages(raw)
        text = "\n\n".join(p["text"] for p in pages)
    else:
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValidationFailed("unsupported_file", "Import a PDF, Markdown or plain-text file.") from exc
    if not text.strip():
        raise ValidationFailed("empty_file", "The file contains no text.")
    heading = re.search(r"^#{1,3}\s+(.+)$", text, re.M)
    title = (heading.group(1) if heading else text.strip().splitlines()[0])[:180].strip()
    amounts = parse_amounts(text)
    requested = next((a for a in amounts if re.search(r"request|grant|fund", text[max(0, a["start"] - 80):a["end"]], re.I)), amounts[0] if amounts else None)
    addresses = ADDRESS_RE.findall(text)
    data = {
        "title": title if len(title) >= 3 else f"Imported proposal {name}",
        "summary": "Imported from " + name + ". Review every extracted field before committing.",
        "category": "grant",
        "proposer_address": deployment.a(proposer_role),
        "recipient_address": addresses[0] if addresses else None,
        "requested_amount_base": requested["base_units"] if requested else "0",
        "body": text[:20000],
    }
    p = proposals.create_proposal(db, data, who)
    if is_pdf:
        evidence.attach(db, p, name=name, source_type="pdf", raw=raw, location="Imported file", actor=who)
    else:
        evidence.attach(db, p, name=name, source_type="text", raw=raw, location="Imported file", actor=who)
    detail = views.proposal_detail(db, p)
    detail["import_notes"] = {
        "title_source": "first heading" if heading else "first line",
        "amount_source": requested["text"] if requested else None,
        "recipient_source": addresses[0] if addresses else None,
        "note": "Fields were extracted deterministically from the file and need human confirmation.",
    }
    return detail


@router.get("/proposals/{proposal_id}")
def get_proposal(proposal_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    return views.proposal_detail(db, proposals.get_proposal(db, proposal_id))


@router.patch("/proposals/{proposal_id}")
def patch_proposal(proposal_id: str, body: ProposalPatch, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    proposals.update_proposal(db, p, body.model_dump(exclude_unset=True), who)
    return views.proposal_detail(db, p)


@router.post("/proposals/{proposal_id}/analyze")
def analyze(proposal_id: str, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    run = analysis.analyze(db, p, actor=who)
    coi.analyze(db, p)
    return analysis.serialize(run)


@router.get("/proposals/{proposal_id}/analysis")
def get_analysis(proposal_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    proposals.get_proposal(db, proposal_id)
    run = analysis.latest(db, proposal_id)
    if run is None:
        raise NotFound("no_analysis", "No brief has been generated yet.")
    return analysis.serialize(run)


@router.post("/proposals/{proposal_id}/evidence", status_code=201)
def add_evidence(proposal_id: str, body: EvidenceIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    doc = evidence.attach(db, p, name=body.name, source_type=body.source_type, text=body.text, location=body.location, actor=who)
    return evidence.serialize(doc, include_pages=True)


@router.post("/proposals/{proposal_id}/evidence/upload", status_code=201)
async def upload_evidence(proposal_id: str, file: UploadFile = File(...), name: str = Form(""), db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    raw = await file.read()
    fname = name.strip() or file.filename or "evidence"
    if (file.filename or "").lower().endswith(".pdf") or raw.startswith(b"%PDF"):
        doc = evidence.attach(db, p, name=fname, source_type="pdf", raw=raw, location=file.filename, actor=who)
    else:
        try:
            raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValidationFailed("unsupported_file", "Upload a PDF, Markdown or plain-text file.") from exc
        doc = evidence.attach(db, p, name=fname, source_type="text", raw=raw, location=file.filename, actor=who)
    return evidence.serialize(doc, include_pages=True)


@router.get("/proposals/{proposal_id}/evidence/{doc_id}")
def get_evidence(proposal_id: str, doc_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    doc = db.get(EvidenceDocument, doc_id)
    if doc is None or doc.proposal_id != proposal_id:
        raise NotFound("evidence_not_found", f"{doc_id} is not attached to {proposal_id}.")
    return evidence.serialize(doc, include_pages=True)


@router.get("/proposals/{proposal_id}/evidence/{doc_id}/proof")
def evidence_proof(proposal_id: str, doc_id: str, version: int | None = None, db: Session = Depends(get_db)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    doc = db.get(EvidenceDocument, doc_id)
    if doc is None or doc.proposal_id != proposal_id:
        raise NotFound("evidence_not_found", f"{doc_id} is not attached to {proposal_id}.")
    v = proposals.get_version(p, version) if version else proposals.latest_version(p)
    if v is None:
        raise Conflict("no_version", "No committed version yet; evidence is not part of any on-chain root.")
    if doc.content_hash not in v.evidence_hashes:
        return {"included": False, "version": v.version, "note": f"{doc.name} was attached after v{v.version} was committed, so it is not in that root."}
    proof = merkle_proof(v.evidence_hashes, doc.content_hash)
    return {"included": True, "version": v.version, "leaf_hash": doc.content_hash, "proof": proof, "root": v.evidence_root,
            "verified": verify_merkle_proof(proof, v.evidence_root, doc.content_hash), "registry_tx": v.tx_hash,
            "method": "Sorted-pair keccak256 Merkle tree over keccak256(sha256(file)) leaves (OpenZeppelin MerkleProof compatible)."}


@router.put("/proposals/{proposal_id}/disclosure")
def put_disclosure(proposal_id: str, body: DisclosureIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    d = proposals.save_disclosure(db, p, body.model_dump(), who)
    coi.analyze(db, p)
    return {"id": d.id, "statement": d.statement, "disclosure_hash": d.disclosure_hash, "signer": d.signer, "created_at": iso(d.created_at),
            "note": "The proposer's key signs this disclosure together with the content hash when the next version is committed."}


@router.get("/proposals/{proposal_id}/findings")
def findings(proposal_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    proposals.get_proposal(db, proposal_id)
    return {"items": [serialize_finding(f) for f in active_findings(db, proposal_id)]}


@router.post("/proposals/{proposal_id}/findings/{finding_id}/status")
def finding_status(proposal_id: str, finding_id: str, body: FindingStatusIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    f = db.get(Finding, finding_id)
    if f is None or f.proposal_id != proposal_id:
        raise NotFound("finding_not_found", "Finding not found.")
    set_status(f, body.status, who, body.note)
    db.commit()
    audit.record(event_type="finding_status_changed", summary=f"Finding {f.id} ({f.title[:80]}) marked {body.status}: {body.note[:160]}",
                 actor=who, source="ui", status="info", proposal_id=proposal_id, details={"finding_id": f.id, "status": body.status})
    return serialize_finding(f)


@router.post("/proposals/{proposal_id}/challenges", status_code=201)
def challenge(proposal_id: str, body: ChallengeIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    f = db.get(Finding, body.finding_id)
    if f is None or f.proposal_id != proposal_id:
        raise NotFound("finding_not_found", "Finding not found.")
    c = Challenge(id=new_id("CH"), finding_id=f.id, proposal_id=proposal_id, author=who, statement=body.statement,
                  counter_evidence=body.counter_evidence, status="open")
    db.add(c)
    set_status(f, "challenged", who, f"Challenge {c.id} filed")
    db.commit()
    audit.record(event_type="challenge_filed", summary=f"{who} challenged finding “{f.title[:80]}”. The original finding is preserved.",
                 actor=who, source="ui", status="warning", proposal_id=proposal_id, details={"challenge_id": c.id, "finding_id": f.id, "statement": body.statement})
    return {"id": c.id, "status": c.status}


@router.post("/challenges/{challenge_id}/respond")
def respond(challenge_id: str, body: ChallengeResponseIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    c = db.get(Challenge, challenge_id)
    if c is None:
        raise NotFound("challenge_not_found", "Challenge not found.")
    if c.status != "open":
        raise Conflict("challenge_closed", "This challenge has already been answered.")
    c.status, c.reviewer, c.response, c.responded_at = body.decision, who, body.response, utcnow()
    f = db.get(Finding, c.finding_id)
    if f:
        set_status(f, "dismissed" if body.decision == "upheld" else "open", who,
                   f"Challenge {c.id} {body.decision}: {body.response[:200]}")
    db.commit()
    audit.record(event_type="challenge_answered", summary=f"Challenge {c.id} {body.decision} by {who}.", actor=who, source="ui",
                 status="info", proposal_id=c.proposal_id, details={"challenge_id": c.id, "response": body.response})
    return {"id": c.id, "status": c.status}


# ------------------------------------------------------------------ proposer Q&A
@router.get("/proposals/{proposal_id}/questions")
def list_questions(proposal_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    return questions.overview(db, proposals.get_proposal(db, proposal_id))


@router.post("/proposals/{proposal_id}/questions", status_code=201)
def ask_question(proposal_id: str, body: QuestionIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    return questions.serialize(db, p, questions.ask(db, p, text=body.text, finding_id=body.finding_id, actor=who))


@router.post("/proposals/{proposal_id}/questions/{question_id}/answer")
def answer_question(proposal_id: str, question_id: str, body: AnswerIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    q = questions.get_question(db, question_id, proposal_id)
    return questions.serialize(db, p, questions.answer(db, p, q, text=body.text, actor=who, evidence_name=body.evidence_name, evidence_text=body.evidence_text))


@router.post("/proposals/{proposal_id}/questions/{question_id}/review")
def review_answer(proposal_id: str, question_id: str, body: AnswerReviewIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    q = questions.get_question(db, question_id, proposal_id)
    return questions.serialize(db, p, questions.review(db, p, q, decision=body.decision, note=body.note, actor=who))


@router.post("/proposals/{proposal_id}/questions/{question_id}/withdraw")
def withdraw_question(proposal_id: str, question_id: str, body: WithdrawIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    q = questions.get_question(db, question_id, proposal_id)
    return questions.serialize(db, p, questions.withdraw(db, p, q, note=body.note, actor=who))


@router.post("/proposals/{proposal_id}/versions/commit", status_code=201)
def commit(proposal_id: str, body: CommitIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    v = proposals.commit_version(db, p, who, body.change_note)
    return {"version": v.version, "content_hash": v.content_hash, "manifest_hash": v.manifest_hash, "evidence_root": v.evidence_root,
            "disclosure_hash": v.disclosure_hash, "tx_hash": v.tx_hash, "block_number": v.block_number, "changed_fields": v.changed_fields}


@router.get("/proposals/{proposal_id}/versions")
def versions(proposal_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    return {"items": views.proposal_detail(db, p)["versions"], "draft_dirty": p.status in ("draft", "in_review")}


@router.get("/proposals/{proposal_id}/versions/diff")
def diff(proposal_id: str, from_: int = Query(alias="from", ge=1), to: str = "draft", db: Session = Depends(get_db)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    to_version = None if to == "draft" else int(to) if to.isdigit() else None
    if to != "draft" and to_version is None:
        raise ValidationFailed("invalid_version", "to must be a version number or 'draft'.")
    return proposals.version_diff(db, p, from_, to_version)


@router.post("/proposals/{proposal_id}/versions/{version}/verify")
def verify(proposal_id: str, version: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    return proposals.verify_version(db, proposals.get_proposal(db, proposal_id), version)


@router.get("/proposals/{proposal_id}/manifest")
def manifest(proposal_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    from ..services.manifests import manifest_to_payload

    p = proposals.get_proposal(db, proposal_id)
    av = proposals.approved_version(p)
    lv = proposals.latest_version(p)
    ref = av or lv
    gov = governance.state(db, p)
    return {
        "proposal_id": p.id,
        "basis": "approved" if av else ("latest committed" if lv else "none"),
        "version": ref.version if ref else None,
        "manifest": ref.manifest if ref else None,
        "payload": manifest_to_payload(ref.manifest) if ref else None,
        "guard": gov["guard"],
        "note": "The manifest digest binds chain id, guard address, proposal key, version and every action's target, value, calldata and operation.",
    }


@router.get("/proposals/{proposal_id}/treasury")
def treasury_impact(proposal_id: str, amount: str | None = None, overrun_pct: int = Query(default=0, ge=0, le=200),
                    release: str = "lump", horizon: int = Query(default=18, ge=3, le=36), db: Session = Depends(get_db)) -> dict[str, Any]:
    from ..services.manifests import PayloadError, parse_uint

    p = proposals.get_proposal(db, proposal_id)
    override = None
    if amount not in (None, ""):
        try:
            override = parse_uint(amount, "amount")
        except PayloadError as exc:
            raise ValidationFailed("invalid_amount", str(exc)) from exc
    return treasury.impact(db, p, amount_override=override, overrun_pct=overrun_pct, release=release, horizon_months=horizon)


@router.get("/proposals/{proposal_id}/dependencies")
def dependencies(proposal_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    return {"items": treasury.dependency_checks(db, p)}


@router.post("/proposals/{proposal_id}/dependencies/{check_id}/run")
def run_dependency(proposal_id: str, check_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    items = treasury.dependency_checks(db, p, only=check_id)
    if not items:
        raise NotFound("check_not_found", f"No dependency check {check_id} applies to {proposal_id}.")
    return items[0]


@router.patch("/proposals/{proposal_id}/milestones/{index}")
def update_milestone(proposal_id: str, index: int, body: MilestoneUpdateIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    if not 0 <= index < len(p.milestones or []):
        raise NotFound("milestone_not_found", "No such milestone.")
    if p.status != "executed":
        raise Conflict("not_executed", "Milestone delivery is tracked after the proposal has executed.")
    m = db.scalars(select(MilestoneTracking).where(MilestoneTracking.proposal_id == p.id, MilestoneTracking.index == index)).first()
    if m is None:
        m = MilestoneTracking(proposal_id=p.id, index=index)
        db.add(m)
    verification = "unverified"
    refs = list(m.evidence_refs or [])
    if body.evidence:
        ev = body.evidence.strip()
        if re.fullmatch(r"0x[0-9a-fA-F]{64}", ev):
            found = runtime.chain.get_receipt(ev) is not None
            verification = "chain-verified transaction" if found else "transaction not found"
        else:
            verification = "evidence attached (unverified)"
        refs.append({"value": ev, "verification": verification, "added_by": who, "added_at": iso(utcnow())})
    m.status, m.note, m.evidence_refs, m.verification, m.updated_by, m.updated_at = body.status, body.note, refs, verification if body.evidence else m.verification, who, utcnow()
    db.commit()
    title = p.milestones[index].get("title", f"Milestone {index + 1}")
    audit.record(event_type="milestone_updated", summary=f"{p.id} milestone “{title}” marked {body.status} ({m.verification}).",
                 actor=who, source="ui", status="warning" if body.status in ("overdue", "disputed") else "info", proposal_id=p.id,
                 details={"index": index, "status": body.status, "note": body.note, "evidence": body.evidence})
    return {"index": index, "status": m.status, "verification": m.verification, "evidence_refs": m.evidence_refs}


@router.get("/proposals/{proposal_id}/governance")
def governance_state(proposal_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    return {**governance.state(db, p), "voters_available": governance.voter_accounts(db)}


@router.post("/proposals/{proposal_id}/governance/propose")
def propose(proposal_id: str, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    governance.submit(db, p, who)
    return governance.state(db, p)


@router.post("/proposals/{proposal_id}/governance/vote")
def vote(proposal_id: str, body: VoteIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    result = governance.cast_vote(db, p, body.voter, body.support, body.reason, who)
    return {**result, "state": governance.state(db, p)}


@router.post("/proposals/{proposal_id}/governance/simulate-votes")
def simulate_votes(proposal_id: str, outcome: str = Query(default="pass", pattern="^(pass|fail)$"), db: Session = Depends(get_db),
                   who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    cast = governance.simulate_votes(db, p, who, outcome)
    return {"cast": cast, "state": governance.state(db, p)}


@router.post("/proposals/{proposal_id}/governance/advance")
def advance(proposal_id: str, body: AdvanceIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    moved = governance.advance(body.blocks, who, p.id)
    return {**moved, "state": governance.state(db, p)}


@router.post("/proposals/{proposal_id}/governance/finalize")
def finalize(proposal_id: str, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    result = governance.finalize(db, p, who)
    return {**result, "state": governance.state(db, p)}


@router.get("/proposals/{proposal_id}/evaluation-chain")
def evaluation_chain(proposal_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    return risk_chain.evaluate(db, p, governance.state(db, p))


@router.get("/proposals/{proposal_id}/conflicts")
def conflicts(proposal_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    return coi.analyze(db, proposals.get_proposal(db, proposal_id), persist=False)


@router.post("/proposals/{proposal_id}/conflicts/refresh")
def refresh_conflicts(proposal_id: str, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    p = proposals.get_proposal(db, proposal_id)
    result = coi.analyze(db, p, persist=True)
    audit.record(event_type="conflict_review_run", summary=f"Conflict-of-interest review re-run for {p.id}: {len(result['findings'])} finding(s).",
                 actor=who, source="ui", status="info", proposal_id=p.id)
    return result
