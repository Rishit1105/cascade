"""Persistence model.

Big integers (token base units, wei) are stored as decimal strings: SQLite integers are 64-bit and
on-chain amounts are not. Nested, append-only structures (snapshots, discrepancy lists, reports)
are JSON columns and are always replaced wholesale, never mutated in place.
"""

from __future__ import annotations

import secrets
from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .clock import utcnow
from .db import Base, UTCDateTime


def new_id(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(4).upper()}"


class KeyValue(Base):
    """Deployment registry, runtime policy, indexer cursors."""

    __tablename__ = "kv"
    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


class AddressLabel(Base):
    """Human labels for addresses. Labels are demo annotations, never identity claims."""

    __tablename__ = "address_labels"
    address: Mapped[str] = mapped_column(String(42), primary_key=True)
    label: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(32))  # wallet | delegate | treasury | contract | service
    role: Mapped[str | None] = mapped_column(String(48), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=True)


class Proposal(Base):
    __tablename__ = "proposals"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)  # e.g. GOV-042
    key: Mapped[str] = mapped_column(String(66), unique=True)  # keccak256(id), used on-chain
    title: Mapped[str] = mapped_column(String(200))
    summary: Mapped[str] = mapped_column(Text, default="")
    category: Mapped[str] = mapped_column(String(32), default="grant")  # grant | upgrade | budget | retainer
    proposer_address: Mapped[str] = mapped_column(String(42))
    proposer_label: Mapped[str] = mapped_column(String(120), default="")
    recipient_address: Mapped[str | None] = mapped_column(String(42), nullable=True)
    recipient_label: Mapped[str | None] = mapped_column(String(120), nullable=True)
    token_symbol: Mapped[str] = mapped_column(String(16), default="mUSDC")
    token_address: Mapped[str | None] = mapped_column(String(42), nullable=True)
    token_decimals: Mapped[int] = mapped_column(Integer, default=6)
    requested_amount_base: Mapped[str] = mapped_column(String(80), default="0")
    treasury_address: Mapped[str | None] = mapped_column(String(42), nullable=True)
    purpose: Mapped[str] = mapped_column(Text, default="")
    body: Mapped[str] = mapped_column(Text, default="")  # full human-readable proposal text
    milestones: Mapped[list] = mapped_column(JSON, default=list)
    risks: Mapped[list] = mapped_column(JSON, default=list)
    assumptions: Mapped[list] = mapped_column(JSON, default=list)
    benefits: Mapped[list] = mapped_column(JSON, default=list)
    budget_breakdown: Mapped[list] = mapped_column(JSON, default=list)
    draft_actions: Mapped[list] = mapped_column(JSON, default=list)  # executable action specs
    status: Mapped[str] = mapped_column(String(24), default="draft")
    current_version: Mapped[int] = mapped_column(Integer, default=0)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    versions: Mapped[list[ProposalVersion]] = relationship(
        back_populates="proposal", order_by="ProposalVersion.version", cascade="all, delete-orphan"
    )
    evidence: Mapped[list[EvidenceDocument]] = relationship(
        back_populates="proposal", order_by="EvidenceDocument.added_at", cascade="all, delete-orphan"
    )


class ProposalVersion(Base):
    """An immutable, committed snapshot. Never edited after creation except chain/vote status."""

    __tablename__ = "proposal_versions"
    __table_args__ = (UniqueConstraint("proposal_id", "version"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    proposal_id: Mapped[str] = mapped_column(ForeignKey("proposals.id", ondelete="CASCADE"))
    version: Mapped[int] = mapped_column(Integer)
    snapshot: Mapped[dict] = mapped_column(JSON)
    content_hash: Mapped[str] = mapped_column(String(66))
    manifest: Mapped[dict] = mapped_column(JSON)
    manifest_hash: Mapped[str] = mapped_column(String(66), index=True)
    evidence_root: Mapped[str] = mapped_column(String(66))
    evidence_hashes: Mapped[list] = mapped_column(JSON, default=list)
    disclosure: Mapped[dict] = mapped_column(JSON)
    disclosure_hash: Mapped[str] = mapped_column(String(66))
    disclosure_signature: Mapped[str] = mapped_column(Text)
    changed_fields: Mapped[list] = mapped_column(JSON, default=list)
    change_note: Mapped[str] = mapped_column(Text, default="")
    author: Mapped[str] = mapped_column(String(120))
    committed_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    tx_hash: Mapped[str | None] = mapped_column(String(66), nullable=True)
    block_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    governor_proposal_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    governor_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    governance_status: Mapped[str] = mapped_column(String(24), default="not_submitted")

    proposal: Mapped[Proposal] = relationship(back_populates="versions")


class EvidenceDocument(Base):
    __tablename__ = "evidence_documents"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    proposal_id: Mapped[str] = mapped_column(ForeignKey("proposals.id", ondelete="CASCADE"))
    source_type: Mapped[str] = mapped_column(String(24))  # pdf | text | url | forum | transaction | contract | note
    name: Mapped[str] = mapped_column(String(200))
    location: Mapped[str | None] = mapped_column(Text, nullable=True)
    pages: Mapped[list] = mapped_column(JSON, default=list)  # [{page, section, text}]
    content_hash: Mapped[str] = mapped_column(String(80))  # sha256:...
    verification_status: Mapped[str] = mapped_column(String(32), default="hash-recorded")
    injection_flags: Mapped[list] = mapped_column(JSON, default=list)
    added_by: Mapped[str] = mapped_column(String(120), default="reviewer")
    added_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=True)

    proposal: Mapped[Proposal] = relationship(back_populates="evidence")


class Disclosure(Base):
    """Proposer's conflict-of-interest disclosure for the next version (latest wins until committed)."""

    __tablename__ = "disclosures"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    proposal_id: Mapped[str] = mapped_column(ForeignKey("proposals.id", ondelete="CASCADE"), index=True)
    statement: Mapped[dict] = mapped_column(JSON)
    disclosure_hash: Mapped[str] = mapped_column(String(66))
    signer: Mapped[str] = mapped_column(String(42))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class AnalysisRun(Base):
    __tablename__ = "analysis_runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    proposal_id: Mapped[str] = mapped_column(ForeignKey("proposals.id", ondelete="CASCADE"), index=True)
    mode: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16))
    input_hash: Mapped[str] = mapped_column(String(66))
    output: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Finding(Base):
    """A reviewable observation. Original fields are immutable; only status moves, with history."""

    __tablename__ = "findings"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    proposal_id: Mapped[str] = mapped_column(ForeignKey("proposals.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(24))  # missing_info | conflict | execution | simulation | injection | analysis
    rule_id: Mapped[str] = mapped_column(String(24))
    severity: Mapped[str] = mapped_column(String(16))  # critical | high | medium | low | info
    confidence: Mapped[str] = mapped_column(String(24))  # verified | source-supported | heuristic | unverified
    title: Mapped[str] = mapped_column(String(240))
    explanation: Mapped[str] = mapped_column(Text)
    remediation: Mapped[str | None] = mapped_column(Text, nullable=True)
    evidence_refs: Mapped[list] = mapped_column(JSON, default=list)
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    fingerprint: Mapped[str] = mapped_column(String(66), index=True)
    status: Mapped[str] = mapped_column(String(16), default="open")  # open | challenged | resolved | dismissed
    status_history: Mapped[list] = mapped_column(JSON, default=list)
    source_ref: Mapped[str | None] = mapped_column(String(48), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    superseded_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class Challenge(Base):
    __tablename__ = "challenges"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    finding_id: Mapped[str] = mapped_column(ForeignKey("findings.id", ondelete="CASCADE"), index=True)
    proposal_id: Mapped[str] = mapped_column(ForeignKey("proposals.id", ondelete="CASCADE"))
    author: Mapped[str] = mapped_column(String(120))
    statement: Mapped[str] = mapped_column(Text)
    counter_evidence: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(16), default="open")  # open | upheld | rejected
    reviewer: Mapped[str | None] = mapped_column(String(120), nullable=True)
    response: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    responded_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class ExecutionCheck(Base):
    __tablename__ = "execution_checks"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    proposal_id: Mapped[str] = mapped_column(ForeignKey("proposals.id", ondelete="CASCADE"), index=True)
    version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    scenario: Mapped[str | None] = mapped_column(String(48), nullable=True)
    status: Mapped[str] = mapped_column(String(16))  # MATCH | MISMATCH | UNKNOWN
    approved_manifest_hash: Mapped[str | None] = mapped_column(String(66), nullable=True)
    submitted_manifest_hash: Mapped[str | None] = mapped_column(String(66), nullable=True)
    approved_manifest: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    submitted_payload: Mapped[dict] = mapped_column(JSON)
    submitted_decoded: Mapped[list] = mapped_column(JSON, default=list)
    discrepancies: Mapped[list] = mapped_column(JSON, default=list)
    preflight: Mapped[dict] = mapped_column(JSON, default=dict)
    actor: Mapped[str] = mapped_column(String(120), default="reviewer")
    checked_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class ExecutionAttempt(Base):
    __tablename__ = "execution_attempts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    proposal_id: Mapped[str] = mapped_column(ForeignKey("proposals.id", ondelete="CASCADE"), index=True)
    version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    check_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    scenario: Mapped[str | None] = mapped_column(String(48), nullable=True)
    submitted_manifest_hash: Mapped[str | None] = mapped_column(String(66), nullable=True)
    outcome: Mapped[str] = mapped_column(String(16))  # executed | rejected | not_sent
    tx_hash: Mapped[str | None] = mapped_column(String(66), nullable=True)
    block_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    revert: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    balance_changes: Mapped[list] = mapped_column(JSON, default=list)
    actor: Mapped[str] = mapped_column(String(120), default="executor")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Simulation(Base):
    __tablename__ = "simulations"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    proposal_id: Mapped[str] = mapped_column(ForeignKey("proposals.id", ondelete="CASCADE"), index=True)
    version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    scenario: Mapped[str | None] = mapped_column(String(48), nullable=True)
    trigger: Mapped[str] = mapped_column(String(16), default="manual")  # manual | sentinel | commit
    manifest_hash: Mapped[str | None] = mapped_column(String(66), nullable=True)
    status: Mapped[str] = mapped_column(String(16))  # completed | failed
    verdict: Mapped[str] = mapped_column(String(8))  # pass | flag | block | error
    report: Mapped[dict] = mapped_column(JSON, default=dict)
    chain_block: Mapped[int | None] = mapped_column(Integer, nullable=True)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class AuditEvent(Base):
    """Hash-chained, append-only ledger. event_hash = sha256(canonical(event) || prev_hash)."""

    __tablename__ = "audit_events"

    seq: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    id: Mapped[str] = mapped_column(String(32), unique=True)
    proposal_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    event_type: Mapped[str] = mapped_column(String(48), index=True)
    actor: Mapped[str] = mapped_column(String(120))
    source: Mapped[str] = mapped_column(String(24))  # ui | api | sentinel | chain-indexer | seed | system
    verification: Mapped[str] = mapped_column(String(24))  # chain-confirmed | off-chain
    status: Mapped[str] = mapped_column(String(16))  # success | failure | warning | info
    summary: Mapped[str] = mapped_column(Text)
    occurred_at: Mapped[datetime] = mapped_column(UTCDateTime)
    proposal_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    manifest_hash: Mapped[str | None] = mapped_column(String(66), nullable=True)
    tx_hash: Mapped[str | None] = mapped_column(String(66), nullable=True, index=True)
    block_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    prev_hash: Mapped[str] = mapped_column(String(80))
    event_hash: Mapped[str] = mapped_column(String(80))


class AuditAnchor(Base):
    __tablename__ = "audit_anchors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    seq_upto: Mapped[int] = mapped_column(Integer)
    ledger_head: Mapped[str] = mapped_column(String(80))
    tx_hash: Mapped[str] = mapped_column(String(66))
    block_number: Mapped[int] = mapped_column(Integer)
    anchored_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    proposal_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    finding_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    source: Mapped[str] = mapped_column(String(24))
    severity: Mapped[str] = mapped_column(String(16))
    title: Mapped[str] = mapped_column(String(240))
    description: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="new")  # new | triaged | escalated | resolved | dismissed
    assignee: Mapped[str | None] = mapped_column(String(120), nullable=True)
    resolution: Mapped[str | None] = mapped_column(Text, nullable=True)
    history: Mapped[list] = mapped_column(JSON, default=list)
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    level: Mapped[str] = mapped_column(String(16))  # info | warning | critical | success
    title: Mapped[str] = mapped_column(String(240))
    body: Mapped[str] = mapped_column(Text, default="")
    link: Mapped[str | None] = mapped_column(String(240), nullable=True)
    audience: Mapped[str] = mapped_column(String(64), default="reviewers")
    read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Report(Base):
    __tablename__ = "reports"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    proposal_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    format: Mapped[str] = mapped_column(String(8))
    sections: Mapped[list] = mapped_column(JSON)
    file_name: Mapped[str] = mapped_column(String(200))
    sha256: Mapped[str] = mapped_column(String(80))
    size_bytes: Mapped[int] = mapped_column(Integer)
    generated_by: Mapped[str] = mapped_column(String(120))
    generated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class MilestoneTracking(Base):
    """Post-approval delivery tracking. Delivery claims stay unverified unless evidence is attached."""

    __tablename__ = "milestone_tracking"
    __table_args__ = (UniqueConstraint("proposal_id", "index"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    proposal_id: Mapped[str] = mapped_column(ForeignKey("proposals.id", ondelete="CASCADE"))
    index: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending | completed | overdue | disputed
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    evidence_refs: Mapped[list] = mapped_column(JSON, default=list)
    verification: Mapped[str] = mapped_column(String(24), default="unverified")
    updated_by: Mapped[str] = mapped_column(String(120), default="reviewer")
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Annotation(Base):
    """Manual graph annotations. Always rendered as 'manual annotation', never as an observation."""

    __tablename__ = "annotations"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    source_address: Mapped[str] = mapped_column(String(42))
    target_address: Mapped[str] = mapped_column(String(42))
    relation: Mapped[str] = mapped_column(String(64))
    note: Mapped[str] = mapped_column(Text, default="")
    evidence_level: Mapped[str] = mapped_column(String(24), default="unverified_lead")
    created_by: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Question(Base):
    """A reviewer's question to the proposer, usually about a missing-information finding.

    The thread is append-only: question, signed proposer answers, reviewer follow-ups. Every entry
    is also written to the hash-chained audit ledger, so an edited thread would no longer match it.
    """

    __tablename__ = "questions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    proposal_id: Mapped[str] = mapped_column(ForeignKey("proposals.id", ondelete="CASCADE"), index=True)
    finding_id: Mapped[str | None] = mapped_column(ForeignKey("findings.id", ondelete="SET NULL"), nullable=True)
    rule_id: Mapped[str | None] = mapped_column(String(24), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=0)  # proposal version the question was asked against
    text: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="open")  # open | answered | needs_more | accepted | withdrawn
    thread: Mapped[list] = mapped_column(JSON, default=list)
    asked_by: Mapped[str] = mapped_column(String(120))
    asked_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
