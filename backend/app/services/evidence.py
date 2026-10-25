"""Evidence ingestion: text, markdown, PDF and references. Every item is content-hashed;
re-attaching identical content is rejected, and instruction-like text is flagged on ingestion."""

from __future__ import annotations

import io
import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..clock import iso, utcnow
from ..errors import Conflict, ValidationFailed
from ..models import EvidenceDocument, Proposal, new_id
from ..runtime import runtime
from . import audit
from .analysis.injection import scan_pages
from .canonical import sha256_tagged

SOURCE_TYPES = {"pdf", "text", "url", "forum", "transaction", "contract", "note"}
MAX_BYTES = 8 * 1024 * 1024
HEADING_RE = re.compile(r"^(#{1,4})\s+(.+)$", re.M)


def split_sections(text: str) -> list[dict[str, Any]]:
    """Split markdown-ish text into sections; each section is a 'page' with a section title."""
    text = text.replace("\r\n", "\n")
    matches = list(HEADING_RE.finditer(text))
    if not matches:
        return [{"page": 1, "section": None, "text": text.strip()}]
    pages = []
    if matches[0].start() > 0 and text[: matches[0].start()].strip():
        pages.append({"page": 1, "section": None, "text": text[: matches[0].start()].strip()})
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[m.end():end].strip()
        pages.append({"page": len(pages) + 1, "section": m.group(2).strip(), "text": body or m.group(2).strip()})
    return pages


def pdf_pages(data: bytes) -> list[dict[str, Any]]:
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(data))
        pages = [{"page": i + 1, "section": None, "text": (page.extract_text() or "").strip()} for i, page in enumerate(reader.pages)]
    except (PdfReadError, ValueError, KeyError) as exc:
        raise ValidationFailed("unreadable_pdf", f"The PDF could not be parsed: {exc}") from exc
    if not any(p["text"] for p in pages):
        raise ValidationFailed("pdf_without_text", "The PDF has no extractable text (it may be scanned). OCR is not supported in this prototype.")
    return pages


def attach(
    db: Session,
    proposal: Proposal,
    *,
    name: str,
    source_type: str,
    raw: bytes | None = None,
    text: str | None = None,
    location: str | None = None,
    actor: str = "reviewer",
    source: str = "ui",
    is_demo: bool = False,
) -> EvidenceDocument:
    if source_type not in SOURCE_TYPES:
        raise ValidationFailed("invalid_source_type", f"source_type must be one of {sorted(SOURCE_TYPES)}")
    if not name.strip():
        raise ValidationFailed("invalid_name", "Evidence needs a name.")
    verification = "hash-recorded"
    if source_type == "pdf":
        if raw is None:
            raise ValidationFailed("missing_file", "A PDF upload is required.")
        if len(raw) > MAX_BYTES:
            raise ValidationFailed("file_too_large", "Evidence files are limited to 8 MB.")
        if not raw.startswith(b"%PDF"):
            raise ValidationFailed("not_a_pdf", "The uploaded file is not a PDF.")
        pages = pdf_pages(raw)
        digest = sha256_tagged(raw)
    elif source_type == "transaction":
        tx_hash = (text or location or "").strip()
        if not re.fullmatch(r"0x[0-9a-fA-F]{64}", tx_hash):
            raise ValidationFailed("invalid_tx_hash", "Transaction evidence needs a 0x-prefixed 32-byte transaction hash.")
        receipt = runtime.chain.get_receipt(tx_hash) if runtime.chain.is_connected() else None
        verification = "chain-verified" if receipt else "not-found-on-chain"
        summary = f"Transaction {tx_hash} " + (
            f"mined in block {int(receipt['blockNumber'], 16)} with status {'success' if int(receipt['status'], 16) == 1 else 'reverted'}." if receipt else "was not found on the connected chain."
        )
        pages = [{"page": 1, "section": "Transaction reference", "text": summary}]
        location = tx_hash
        digest = sha256_tagged(tx_hash.lower().encode())
    else:
        body = text if text is not None else (raw.decode("utf-8", errors="strict") if raw is not None else None)
        if body is None or not body.strip():
            raise ValidationFailed("empty_evidence", "Evidence text is empty.")
        if len(body.encode()) > MAX_BYTES:
            raise ValidationFailed("file_too_large", "Evidence text is limited to 8 MB.")
        pages = split_sections(body)
        digest = sha256_tagged(raw if raw is not None else body.encode("utf-8"))

    duplicate = db.scalars(
        select(EvidenceDocument).where(EvidenceDocument.proposal_id == proposal.id, EvidenceDocument.content_hash == digest)
    ).first()
    if duplicate:
        audit.record(event_type="evidence_duplicate_rejected", summary=f"Duplicate evidence for {proposal.id} rejected (same hash as {duplicate.id}).",
                     actor=actor, source=source, status="warning", proposal_id=proposal.id, details={"content_hash": digest, "existing": duplicate.id})
        raise Conflict("duplicate_evidence", f"Identical content is already attached as {duplicate.id} ({duplicate.name}).", {"existing_id": duplicate.id})

    flags = scan_pages(pages)
    doc = EvidenceDocument(
        id=new_id("DOC"),
        proposal_id=proposal.id,
        source_type=source_type,
        name=name.strip(),
        location=location,
        pages=pages,
        content_hash=digest,
        verification_status=verification,
        injection_flags=flags,
        added_by=actor,
        added_at=utcnow(),
        is_demo=is_demo,
    )
    proposal.evidence.append(doc)
    db.commit()
    audit.record(
        event_type="evidence_attached",
        summary=f"Evidence “{doc.name}” attached to {proposal.id} ({source_type}, {len(pages)} page/section(s))."
        + (f" {len(flags)} instruction-like passage(s) flagged and treated as data." if flags else ""),
        actor=actor,
        source=source,
        status="warning" if flags else "info",
        proposal_id=proposal.id,
        details={"evidence_id": doc.id, "content_hash": digest, "verification": verification, "injection_flags": len(flags)},
    )
    return doc


def serialize(doc: EvidenceDocument, include_pages: bool = False) -> dict[str, Any]:
    first_text = next((p.get("text", "") for p in doc.pages or [] if p.get("text")), "")
    data = {
        "id": doc.id,
        "proposal_id": doc.proposal_id,
        "source_type": doc.source_type,
        "name": doc.name,
        "location": doc.location,
        "content_hash": doc.content_hash,
        "verification_status": doc.verification_status,
        "injection_flags": doc.injection_flags,
        "page_count": len(doc.pages or []),
        "excerpt": first_text[:280],
        "added_by": doc.added_by,
        "added_at": iso(doc.added_at),
        "is_demo": doc.is_demo,
    }
    if include_pages:
        data["pages"] = doc.pages
    return data
