"""Request schemas. Unknown fields are rejected; amounts are base-unit strings validated again by
the services (never silently coerced)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class MilestoneIn(Strict):
    title: str = Field(min_length=1, max_length=160)
    deliverable: str = ""
    month: int | None = Field(default=None, ge=0, le=60)
    amount_base: str | None = None


class BudgetLineIn(Strict):
    item: str = Field(min_length=1, max_length=160)
    amount_base: str


class ProposalCreate(Strict):
    id: str | None = Field(default=None, pattern=r"^GOV-\d{3,}$")
    title: str = Field(min_length=3, max_length=200)
    summary: str = ""
    category: Literal["grant", "upgrade", "budget", "retainer", "parameter"] = "grant"
    proposer_address: str
    proposer_label: str = ""
    recipient_address: str | None = None
    recipient_label: str | None = None
    requested_amount_base: str = "0"
    purpose: str = ""
    body: str = ""
    milestones: list[MilestoneIn] = []
    risks: list[str] = []
    assumptions: list[str] = []
    benefits: list[str] = []
    budget_breakdown: list[BudgetLineIn] = []
    draft_actions: list[dict[str, Any]] = []


class ProposalPatch(Strict):
    title: str | None = Field(default=None, min_length=3, max_length=200)
    summary: str | None = None
    category: Literal["grant", "upgrade", "budget", "retainer", "parameter"] | None = None
    recipient_address: str | None = None
    recipient_label: str | None = None
    requested_amount_base: str | None = None
    purpose: str | None = None
    body: str | None = None
    milestones: list[MilestoneIn] | None = None
    risks: list[str] | None = None
    assumptions: list[str] | None = None
    benefits: list[str] | None = None
    budget_breakdown: list[BudgetLineIn] | None = None
    draft_actions: list[dict[str, Any]] | None = None


class EvidenceIn(Strict):
    name: str = Field(min_length=1, max_length=200)
    source_type: Literal["text", "url", "forum", "transaction", "contract", "note"]
    text: str | None = None
    location: str | None = None


class RelationshipIn(Strict):
    party: str
    address: str | None = None
    relationship: str
    details: str = ""


class DisclosureIn(Strict):
    no_conflicts: bool = False
    relationships: list[RelationshipIn] = []
    holdings: str = ""
    compensation: str = ""


class CommitIn(Strict):
    change_note: str = Field(default="", max_length=600)


class FindingStatusIn(Strict):
    status: Literal["resolved", "dismissed", "open"]
    note: str = Field(min_length=8, max_length=1000)


class ChallengeIn(Strict):
    finding_id: str
    statement: str = Field(min_length=10, max_length=2000)
    counter_evidence: list[dict[str, Any]] = []


class ChallengeResponseIn(Strict):
    decision: Literal["upheld", "rejected"]
    response: str = Field(min_length=8, max_length=2000)


class VoteIn(Strict):
    voter: str
    support: Literal[0, 1, 2]
    reason: str = Field(default="", max_length=280)


class AdvanceIn(Strict):
    blocks: int = Field(ge=1, le=200)


class PayloadRequest(Strict):
    scenario: str | None = None
    payload: dict[str, Any] | None = None


class SimulationRequest(Strict):
    scenario: str | None = None
    payload: dict[str, Any] | None = None
    version: int | None = None


class HaltIn(Strict):
    reason: str = Field(min_length=8, max_length=1000)
    confirm: str


class DisputeIn(Strict):
    version: int = Field(ge=1)
    statement: str = Field(min_length=10, max_length=2000)


class MilestoneUpdateIn(Strict):
    status: Literal["pending", "completed", "overdue", "disputed"]
    note: str = Field(default="", max_length=1000)
    evidence: str | None = Field(default=None, max_length=500)


class AnnotationIn(Strict):
    source_address: str
    target_address: str
    relation: str = Field(min_length=2, max_length=64)
    note: str = Field(default="", max_length=1000)


class TxVerifyIn(Strict):
    tx_hash: str = Field(pattern=r"^0x[0-9a-fA-F]{64}$")


class AlertActionIn(Strict):
    note: str = ""
    assignee: str | None = None


class ManualAlertIn(Strict):
    proposal_id: str | None = None
    severity: Literal["critical", "high", "medium", "low", "info"] = "medium"
    title: str = Field(min_length=4, max_length=240)
    description: str = Field(min_length=4, max_length=2000)
    data: dict[str, Any] = {}


class EmergencyIn(Strict):
    action: Literal["halt", "dispute", "notify"]
    reason: str = Field(min_length=8, max_length=1000)
    confirm: str | None = None
    version: int | None = None


class ReportIn(Strict):
    proposal_id: str
    format: Literal["pdf", "json", "csv"]
    sections: list[str] = []


class ResetIn(Strict):
    confirm: Literal["RESET"]


class TreasuryInputsIn(Strict):
    burn_items: list[dict[str, Any]]
    other_commitments: list[dict[str, Any]]
    source: str = ""


class PolicyIn(Strict):
    auto_halt_on_block_verdict: bool
    severity_overrides: dict[str, Literal["critical", "high", "medium", "low", "info"]] = {}
    priors: dict[str, float] = {}
    likelihood_ratios: dict[str, float] = {}


class NotificationsReadIn(Strict):
    ids: list[str] | None = None
