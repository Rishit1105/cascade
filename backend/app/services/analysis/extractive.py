"""Deterministic, extractive proposal brief.

Every claim in the brief is a verbatim sentence from a source with its document, page and
character offsets. Structured fields that no source supports are reported as
"not evidenced in supplied material". Arithmetic is integer/Decimal only.
"""

from __future__ import annotations

import re
from typing import Any

from ...models import EvidenceDocument, Proposal
from ..labels import format_units
from .text import ADDRESS_RE, Sentence, parse_amounts, sentences

CATEGORY_RULES: dict[str, re.Pattern[str]] = {
    "benefits": re.compile(
        r"\b(will|would|expected to|aims? to|intended to|so that|in order to)\b.*\b(enable|improve|increase|grow|reduce|attract|onboard|deliver|support|accelerate|lower|expand|fund|strengthen)\b|\bbenefit",
        re.I,
    ),
    "risks": re.compile(r"\brisks?\b|\bmay (fail|delay|not|slip)\b|\bcould (fail|delay|slip|lose)\b|\buncertain|\bexposure\b|\bvulnerab|\bif .* fails?\b", re.I),
    "assumptions": re.compile(r"\bassum|\bestimate|\bprojected\b|\bforecast|\bbased on\b|\bexpected cost|\bbudgeted\b", re.I),
    "dependencies": re.compile(r"\bdepends? on\b|\brequires?\b|\bprerequisite|\bintegrat(e|ion) with\b|\bcontingent\b|\bsubject to\b", re.I),
    "milestones": re.compile(r"^(milestone|m\d\b|phase \d|tranche)|\bmilestone\b|\bdeliverable", re.I),
}
BUDGET_LINE_RE = re.compile(r"^\s*[-*•]?\s*[A-Za-z][^:\n]{2,60}[:–-]\s*\$?\s?\d[\d,]*(\.\d+)?\s?(k|K|m|M)?\s?(m?USDC|USD)?\b", re.M)
AUDIT_RE = re.compile(r"\baudit(ed|or|s)?\b|\bsecurity review\b", re.I)


def proposal_source(proposal: Proposal) -> dict[str, Any]:
    return {
        "id": f"proposal:{proposal.id}",
        "name": f"{proposal.id} proposal text",
        "source_type": "proposal",
        "pages": [{"page": 1, "section": "Proposal", "text": proposal.body or proposal.summary or ""}],
    }


def all_sources(proposal: Proposal, docs: list[EvidenceDocument]) -> list[dict[str, Any]]:
    out = [proposal_source(proposal)]
    for d in docs:
        out.append({"id": d.id, "name": d.name, "source_type": d.source_type, "pages": d.pages or []})
    return out


def _claim(category: str, s: Sentence) -> dict[str, Any]:
    return {
        "category": category,
        "text": s.text,
        "status": "source-quoted",
        "confidence": "source-supported",
        "citations": [s.citation()],
    }


def run(proposal: Proposal, docs: list[EvidenceDocument], treasury_balance_base: int | None) -> dict[str, Any]:
    sources = all_sources(proposal, docs)
    all_sentences: list[Sentence] = []
    for src in sources:
        all_sentences.extend(sentences(src["id"], src["name"], src["pages"]))

    claims: dict[str, list[dict[str, Any]]] = {k: [] for k in CATEGORY_RULES}
    seen_text: set[str] = set()
    for s in all_sentences:
        key = s.text.lower()
        if key in seen_text:
            continue
        for category, rule in CATEGORY_RULES.items():
            if rule.search(s.text):
                claims[category].append(_claim(category, s))
                seen_text.add(key)
                break

    decimals = proposal.token_decimals
    requested = int(proposal.requested_amount_base or 0)
    amount_mentions: list[dict[str, Any]] = []
    address_mentions: list[dict[str, Any]] = []
    for s in all_sentences:
        for amt in parse_amounts(s.text, decimals):
            amount_mentions.append({**amt, "citation": s.citation(), "sentence": s.text})
        for addr in ADDRESS_RE.findall(s.text):
            address_mentions.append({"address": addr, "citation": s.citation()})

    # Facts: the structured value, and whether any source states it.
    facts: dict[str, Any] = {}
    if requested:
        supporting = [m for m in amount_mentions if int(m["base_units"]) == requested]
        facts["requested_amount"] = {
            "value_base": str(requested),
            "display": f"{format_units(requested, decimals)} {proposal.token_symbol}",
            "status": "source-quoted" if supporting else "not_evidenced",
            "citations": [m["citation"] for m in supporting[:3]],
            "note": None if supporting else "No supplied source states this amount.",
        }
    if proposal.recipient_address:
        supporting = [m for m in address_mentions if m["address"].lower() == proposal.recipient_address.lower()]
        facts["recipient"] = {
            "value": proposal.recipient_address,
            "label": proposal.recipient_label,
            "status": "source-quoted" if supporting else "not_evidenced",
            "citations": [m["citation"] for m in supporting[:3]],
            "note": None if supporting else "The recipient address does not appear in any supplied source.",
        }

    contradictions: list[dict[str, Any]] = []
    if requested:
        for m in amount_mentions:
            sentence = m["sentence"].lower()
            if int(m["base_units"]) != requested and re.search(r"\b(request|grant|total|ask|allocation)\w*\b", sentence) and int(m["base_units"]) > requested // 20:
                contradictions.append(
                    {
                        "kind": "amount",
                        "text": f"A source mentions {m['text']} in a funding context, while the proposal requests "
                                f"{format_units(requested, decimals)} {proposal.token_symbol}.",
                        "citations": [m["citation"]],
                        "severity": "medium",
                    }
                )
    if proposal.recipient_address:
        for m in address_mentions:
            sent = m["citation"]["quote"].lower()
            if m["address"].lower() != proposal.recipient_address.lower() and re.search(r"\b(recipient|pay|paid|receive|send|wallet|multisig)\b", sent):
                contradictions.append(
                    {
                        "kind": "recipient",
                        "text": f"A source names {m['address']} as a payment address, but the manifest pays {proposal.recipient_address}.",
                        "citations": [m["citation"]],
                        "severity": "high",
                    }
                )

    budget_lines = []
    for src in sources[1:]:
        for page in src["pages"]:
            for bm in BUDGET_LINE_RE.finditer(page.get("text", "")):
                budget_lines.append({"doc_id": src["id"], "doc_name": src["name"], "page": page.get("page", 1), "line": bm.group(0).strip()})
    audit_sources = [
        {"doc_id": src["id"], "doc_name": src["name"]}
        for src in sources[1:]
        if AUDIT_RE.search(src["name"]) or any(re.search(r"\baudit report\b|\bsecurity review\b|\bfindings?\b.*\b(critical|high|medium)\b", p.get("text", ""), re.I) for p in src["pages"])
    ]

    total_claims = sum(len(v) for v in claims.values()) + len(facts)
    cited = sum(len(v) for v in claims.values()) + sum(1 for f in facts.values() if f["status"] == "source-quoted")

    # Plain-language summary: every sentence either quotes a source or is a labelled calculation.
    summary: list[dict[str, Any]] = []
    summary.append(
        {
            "text": f"{proposal.proposer_label or 'The proposer'} asks the DAO to approve “{proposal.title}”.",
            "basis": "proposal record",
            "citations": [],
        }
    )
    purpose_sentences = [s for s in all_sentences if s.doc_id == f"proposal:{proposal.id}"][:1]
    if purpose_sentences:
        summary.append({"text": f"In the proposer's words: “{purpose_sentences[0].text}”", "basis": "quoted", "citations": [purpose_sentences[0].citation()]})
    if requested and treasury_balance_base:
        share_bp = requested * 10_000 // treasury_balance_base
        summary.append(
            {
                "text": f"It requests {format_units(requested, decimals)} {proposal.token_symbol}, {share_bp / 100:.2f}% of the treasury's "
                        f"current {format_units(treasury_balance_base, decimals)} {proposal.token_symbol}.",
                "basis": "deterministic calculation from the on-chain treasury balance",
                "citations": facts.get("requested_amount", {}).get("citations", []),
            }
        )
    if claims["risks"]:
        summary.append({"text": f"The material names {len(claims['risks'])} risk(s), for example: “{claims['risks'][0]['text']}”", "basis": "quoted", "citations": claims["risks"][0]["citations"]})
    else:
        summary.append({"text": "No supplied material describes risks.", "basis": "absence of evidence", "citations": []})
    summary.append(
        {
            "text": f"{cited} of {total_claims} extracted claims are backed by a quoted source.",
            "basis": "coverage count",
            "citations": [],
        }
    )

    return {
        "summary": summary,
        "requested_decision": None,  # filled by the service from the manifest
        "facts": facts,
        "claims": claims,
        "contradictions": contradictions,
        "amount_mentions": [{k: v for k, v in m.items() if k != "sentence"} for m in amount_mentions],
        "address_mentions": address_mentions,
        "budget_lines": budget_lines,
        "audit_sources": audit_sources,
        "coverage": {"claims_total": total_claims, "claims_cited": cited, "pct": round(100 * cited / total_claims) if total_claims else 0},
        "sources": [{"id": s["id"], "name": s["name"], "source_type": s["source_type"], "pages": len(s["pages"])} for s in sources],
    }
