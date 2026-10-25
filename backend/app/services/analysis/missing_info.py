"""Missing-information gate.

Each rule states what was looked for, where, and the question voters should ask. A missing item
is a request for clarification. It is never, by itself, evidence of wrongdoing.
"""

from __future__ import annotations

import re
from typing import Any

from ...models import Disclosure, EvidenceDocument, Proposal

NOT_WRONGDOING = "Missing information is a reason to ask, not evidence of wrongdoing."


def _item(rule_id: str, severity: str, title: str, reason: str, searched: str, question: str, key: Any = None, refs: list | None = None) -> dict[str, Any]:
    return {
        "rule_id": rule_id,
        "severity": severity,
        "confidence": "verified",  # the absence itself is verified against the supplied material
        "title": title,
        "explanation": f"{reason} {NOT_WRONGDOING}",
        "remediation": question,
        "evidence_refs": refs or [{"type": "search", "description": searched}],
        "data": {"searched": searched},
        "key": key or rule_id,
    }


def evaluate(
    proposal: Proposal,
    docs: list[EvidenceDocument],
    brief: dict[str, Any],
    disclosure: Disclosure | None,
    decoded_actions: list[dict[str, Any]],
    treasury_balance_base: int | None,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    is_upgrade = proposal.category == "upgrade" or any(d.get("kind") == "proxy_upgrade" for d in decoded_actions)
    pays_out = int(proposal.requested_amount_base or 0) > 0
    corpus = "\n".join([proposal.body or ""] + [p.get("text", "") for d in docs for p in (d.pages or [])])

    if not docs:
        items.append(_item("MI-R009", "high", "No supporting evidence attached",
                           "The proposal has no attached documents, so none of its claims can be checked.",
                           "evidence documents attached to the proposal",
                           "Which documents support the proposal's claims? Please attach them."))

    if pays_out and not proposal.budget_breakdown and len(brief.get("budget_lines", [])) < 2:
        items.append(_item("MI-R001", "medium", "Budget breakdown missing",
                           "No itemised budget was found in the proposal fields or attached documents.",
                           "proposal budget fields and budget-style lines (label: amount) in all documents",
                           "How is the requested amount split across workstreams, people and tooling?"))

    if pays_out and not proposal.milestones and not brief.get("claims", {}).get("milestones"):
        items.append(_item("MI-R002", "medium", "Delivery milestones missing",
                           "No milestones or deliverables with dates were found.",
                           "proposal milestone fields and milestone / deliverable sentences in all documents",
                           "What will be delivered, by when, and how will the DAO verify each milestone?"))

    audit_sources = brief.get("audit_sources", [])
    if is_upgrade and not audit_sources:
        items.append(_item("MI-R003", "high", "No independent audit for the code change",
                           "The proposal changes contract code but no audit or security review is attached.",
                           "documents named or containing 'audit' / 'security review' / severity findings",
                           "Who reviewed the new code, and where is their report?"))
    if is_upgrade:
        impls = [d.get("upgrade", {}).get("implementation") for d in decoded_actions if d.get("kind") == "proxy_upgrade"]
        mentioned = {a.lower() for a in re.findall(r"0x[a-fA-F0-9]{40}", "\n".join(p.get("text", "") for d in docs for p in (d.pages or [])))}
        for impl in impls:
            if impl and audit_sources and impl.lower() not in mentioned:
                items.append(_item("MI-R011", "high", "Audit evidence does not cover the submitted implementation",
                                   f"The executable payload installs implementation {impl}, but no attached document mentions that address. "
                                   "Attached audit material may describe different code.",
                                   "all implementation addresses mentioned in attached documents",
                                   "Does the audit report cover exactly the bytecode at the submitted implementation address? "
                                   "Please provide the audited codehash.",
                                   key=f"MI-R011:{impl.lower()}"))
        if not re.search(r"\b(upgrade plan|deployment plan|execution plan|## execution|rollout)\b", corpus, re.I):
            items.append(_item("MI-R006", "medium", "Upgrade plan missing",
                               "No step-by-step upgrade / execution plan was found.",
                               "'upgrade plan', 'execution plan', 'rollout' in proposal text and documents",
                               "What exact transactions will execute, in which order, and who executes them?"))
        if not re.search(r"\b(rollback|roll back|revert plan|downgrade)\b", corpus, re.I):
            items.append(_item("MI-R007", "medium", "Rollback plan missing",
                               "No rollback or recovery plan was found for the code change.",
                               "'rollback', 'revert plan', 'downgrade' in proposal text and documents",
                               "If the new code misbehaves, how and how fast can the DAO roll back?"))

    if pays_out and proposal.recipient_address:
        facts = brief.get("facts", {})
        recipient_fact = facts.get("recipient", {})
        if not proposal.recipient_label or recipient_fact.get("status") != "source-quoted":
            items.append(_item("MI-R004", "medium", "Recipient details not evidenced",
                               "The recipient address is not identified in the supplied material, so voters cannot see who controls it.",
                               "recipient address in proposal text and documents",
                               "Who controls the recipient address (people, multisig signers), and how was it verified?"))

    if disclosure is None:
        items.append(_item("MI-R005", "high", "Conflict-of-interest disclosure missing",
                           "The proposer has not published a signed conflict-of-interest disclosure for this proposal.",
                           "signed disclosures recorded for this proposal",
                           "Does the proposer have any financial or organisational relationship with the recipient or with delegates?"))

    if not brief.get("claims", {}).get("risks") and not proposal.risks:
        items.append(_item("MI-R008", "low", "Risks not described",
                           "No risk statements were found in the proposal or its documents.",
                           "risk-related sentences in all sources",
                           "What could go wrong, and what is the DAO's exposure if it does?"))

    requested = int(proposal.requested_amount_base or 0)
    if requested and treasury_balance_base and requested * 100 > treasury_balance_base * 15 and not audit_sources:
        items.append(_item("MI-R010", "medium", "Large allocation without independent review",
                           f"The request exceeds 15% of the treasury and no independent review is attached.",
                           "treasury share and review / audit documents",
                           "Has an independent party reviewed the budget and the recipient's capacity to deliver?"))

    for c in brief.get("contradictions", []):
        items.append(
            {
                "rule_id": "MI-R012" if c["kind"] == "amount" else "MI-R013",
                "severity": c["severity"],
                "confidence": "source-supported",
                "title": "Sources disagree on the amount" if c["kind"] == "amount" else "Sources name a different payment address",
                "explanation": c["text"] + " " + NOT_WRONGDOING,
                "remediation": "Which figure / address is correct, and why do the documents differ?",
                "evidence_refs": [{"type": "citation", **cit} for cit in c["citations"]],
                "data": {"contradiction": c},
                "key": f"{c['kind']}:{c['citations'][0]['doc_id']}:{c['citations'][0]['char_start']}",
            }
        )
    return items
