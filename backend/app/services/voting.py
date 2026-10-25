"""Voting & participation analytics from Governor and token events on the local chain.

Concentration metrics describe how voting power is distributed; they are governance indicators,
not evidence of manipulation. Pattern heuristics are labelled "possible cluster for review".
"""

from __future__ import annotations

from collections import defaultdict
from decimal import Decimal
from typing import Any

from eth_utils import keccak
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Finding, Proposal
from ..runtime import ACCOUNT_ROLES, DELEGATE_ROLES, VOTER_ROLES, runtime
from .governance import GOV_STATES, votes_for
from .labels import Labeler, format_units
from .proposals import latest_version

DELEGATE_TOPIC = "0x" + keccak(text="DelegateChanged(address,address,address)").hex()

METRIC_DEFINITIONS = {
    "token_weighted": "Votes are weighted by ATLAS voting power at the proposal's snapshot block.",
    "participation": "Voting power cast (for + against + abstain) ÷ total ATLAS supply at the snapshot.",
    "unique_voters": "Distinct addresses that cast a vote, regardless of weight.",
    "quorum": "4% of supply must vote FOR or ABSTAIN for a proposal to be valid (OpenZeppelin counting).",
    "top_share": "Share of all delegated voting power held by the largest delegate(s).",
    "hhi": "Herfindahl–Hirschman index of voting-power shares (0–10,000). Above 2,500 is commonly called highly concentrated.",
    "nakamoto": "Smallest number of delegates whose combined power exceeds 50%.",
    "gini": "Gini coefficient of voting power across delegates with power (0 = equal, 1 = one holder).",
}


def _power_table(db: Session) -> list[dict[str, Any]]:
    deployment = runtime.require_deployment()
    token = runtime.chain.contract("AtlasToken", deployment.c("atlas"))
    labeler = Labeler(db)
    rows = []
    roles = {deployment.a(r[0]).lower(): r[0] for r in ACCOUNT_ROLES}
    for role in VOTER_ROLES + ["wallet_a"]:
        addr = deployment.a(role)
        rows.append({
            "address": addr,
            "label": labeler.label(addr),
            "role": roles.get(addr.lower()),
            "is_delegate": role in DELEGATE_ROLES,
            "voting_power": int(token.functions.getVotes(addr).call()),
            "balance": int(token.functions.balanceOf(addr).call()),
            "delegates_to": token.functions.delegates(addr).call(),
        })
    return rows


def concentration(powers: list[int]) -> dict[str, Any]:
    powers = sorted([p for p in powers if p > 0], reverse=True)
    total = sum(powers)
    if not total:
        return {"total": "0", "top1_pct": "0", "top3_pct": "0", "hhi": 0, "nakamoto": 0, "gini": "0"}
    shares = [Decimal(p) / Decimal(total) for p in powers]
    hhi = int(sum(s * s for s in shares) * 10_000)
    cum, nakamoto = Decimal(0), 0
    for s in shares:
        cum += s
        nakamoto += 1
        if cum > Decimal("0.5"):
            break
    n = len(powers)
    asc = sorted(powers)
    gini = Decimal(sum((2 * (i + 1) - n - 1) * p for i, p in enumerate(asc))) / (Decimal(n) * Decimal(total))
    return {
        "total": str(total),
        "top1_pct": f"{shares[0] * 100:.2f}",
        "top3_pct": f"{sum(shares[:3]) * 100:.2f}",
        "hhi": hhi,
        "hhi_band": "highly concentrated" if hhi > 2500 else "moderately concentrated" if hhi > 1500 else "unconcentrated",
        "nakamoto": nakamoto,
        "gini": f"{gini:.3f}",
        "holders": n,
    }


def overview(db: Session, proposal_id: str | None) -> dict[str, Any]:
    deployment = runtime.require_deployment()
    labeler = Labeler(db)
    power = _power_table(db)
    conc = concentration([r["voting_power"] for r in power])
    governor = runtime.chain.contract("AtlasGovernor", deployment.c("governor"))
    token = runtime.chain.contract("AtlasToken", deployment.c("atlas"))
    current_block = runtime.chain.block_number()

    proposals_summary = []
    selected: dict[str, Any] | None = None
    for p in db.scalars(select(Proposal).order_by(Proposal.id)):
        for v in p.versions:
            if not v.governor_proposal_id:
                continue
            pid = int(v.governor_proposal_id)
            against, for_, abstain = governor.functions.proposalVotes(pid).call()
            snapshot = int(governor.functions.proposalSnapshot(pid).call())
            supply = int(token.functions.getPastTotalSupply(snapshot).call()) if snapshot < current_block else int(token.functions.totalSupply().call())
            cast = against + for_ + abstain
            summary = {
                "proposal_id": p.id, "version": v.version, "title": p.title,
                "state": GOV_STATES[int(governor.functions.state(pid).call())],
                "for": str(for_), "against": str(against), "abstain": str(abstain),
                "participation_pct": f"{Decimal(cast) * 100 / Decimal(supply):.2f}" if supply else "0",
                "snapshot_block": snapshot,
            }
            proposals_summary.append(summary)
            if (proposal_id and p.id == proposal_id and v == latest_version(p)) or (not proposal_id and selected is None):
                selected = {"summary": summary, "proposal": p, "version": v, "gov_id": pid, "supply": supply}
    if proposal_id and selected and selected["proposal"].id != proposal_id:
        selected = None

    detail: dict[str, Any] | None = None
    if selected:
        votes = votes_for(selected["gov_id"])
        votes.sort(key=lambda x: x["block_number"])
        cumulative = {"for": 0, "against": 0, "abstain": 0}
        timeline = []
        for vote in votes:
            cumulative[vote["support"]] += int(vote["weight"])
            timeline.append({"block_number": vote["block_number"], "timestamp": vote["timestamp"], "voter": vote["voter"],
                             "voter_label": labeler.label(vote["voter"]), "support": vote["support"], "weight": vote["weight"],
                             **{f"cum_{k}": str(v) for k, v in cumulative.items()}})
        total_cast = sum(int(v["weight"]) for v in votes)
        conflict_findings = list(db.scalars(select(Finding).where(Finding.proposal_id == selected["proposal"].id, Finding.kind == "conflict", Finding.superseded_at.is_(None))))
        coi_addresses = {str((f.data or {}).get("delegate", "")).lower() for f in conflict_findings if f.rule_id == "COI-R005"}
        p = selected["proposal"]
        top = []
        for vote in sorted(votes, key=lambda x: -int(x["weight"])):
            tags = []
            role = labeler.role(vote["voter"])
            if role in DELEGATE_ROLES:
                tags.append("Delegate")
            if vote["voter"].lower() == p.proposer_address.lower():
                tags.append("Proposer")
            if vote["voter"].lower() in coi_addresses:
                tags.append("Carries recipient-delegated power")
            top.append({**vote, "voter_label": labeler.label(vote["voter"]),
                        "power_pct": f"{Decimal(int(vote['weight'])) * 100 / Decimal(total_cast):.2f}" if total_cast else "0", "tags": tags})
        risks = []
        if top:
            margin = int(selected["summary"]["for"]) - int(selected["summary"]["against"])
            biggest = int(top[0]["weight"])
            if top[0]["support"] == "for" and margin > 0 and biggest >= margin:
                risks.append({"level": "review", "title": "Single voter decisive",
                              "detail": f"{top[0]['voter_label']} alone cast more FOR weight than the winning margin. Without that vote the outcome would differ."})
        for f in conflict_findings:
            if f.rule_id == "COI-R005":
                risks.append({"level": "review", "title": "Recipient-delegated power used", "detail": f.explanation})
        by_block: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for vote in votes:
            by_block[vote["block_number"] // 3].append(vote)
        for bucket in by_block.values():
            sides = {v["support"] for v in bucket}
            if len(bucket) >= 3 and len(sides) == 1:
                risks.append({"level": "heuristic", "title": "Possible cluster for review",
                              "detail": f"{len(bucket)} votes for the same option within 3 blocks ({', '.join(labeler.label(v['voter']) or v['voter'][:8] for v in bucket)}). "
                                        "Timing alone is weak evidence; demo votes are often batched."})
        if not risks:
            risks.append({"level": "none", "title": "No voting patterns flagged", "detail": "No decisive-voter, delegated-power or timing heuristics fired."})
        detail = {
            "proposal_id": p.id, "version": selected["version"].version, "governor_proposal_id": str(selected["gov_id"]),
            "summary": selected["summary"],
            "distribution": {
                "by_weight": {k: selected["summary"][k] for k in ("for", "against", "abstain")},
                "by_count": {s: sum(1 for v in votes if v["support"] == s) for s in ("for", "against", "abstain")},
            },
            "unique_voters": len(votes),
            "eligible_voters": sum(1 for r in power if r["voting_power"] > 0),
            "timeline": timeline,
            "top_voters": top,
            "risk_signals": risks,
        }
    return {
        "data_label": "Votes are real transactions on the local demo chain, cast by fictional demo delegates.",
        "metric_definitions": METRIC_DEFINITIONS,
        "concentration": conc,
        "power_table": [{**r, "voting_power": str(r["voting_power"]), "balance": str(r["balance"]),
                         "voting_power_display": format_units(r["voting_power"], 18, 0)} for r in power],
        "proposals": proposals_summary,
        "selected": detail,
        "block_number": current_block,
    }


def delegates(db: Session) -> dict[str, Any]:
    deployment = runtime.require_deployment()
    chain = runtime.chain
    labeler = Labeler(db)
    power = _power_table(db)
    total_power = sum(r["voting_power"] for r in power) or 1
    delegators: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for log in chain.get_logs(deployment.c("atlas"), [DELEGATE_TOPIC], 0):
        a = log["args"]
        if a["delegator"].lower() != a["toDelegate"].lower():
            delegators[a["toDelegate"].lower()].append({"address": a["delegator"], "label": labeler.label(a["delegator"]), "tx_hash": log["tx_hash"],
                                                         "block_number": log["block_number"]})
    governor = chain.contract("AtlasGovernor", deployment.c("governor"))
    gov_props = []
    for p in db.scalars(select(Proposal).order_by(Proposal.id)):
        for v in p.versions:
            if v.governor_proposal_id:
                gov_props.append((p, v, votes_for(int(v.governor_proposal_id))))
    conflict = list(db.scalars(select(Finding).where(Finding.kind == "conflict", Finding.superseded_at.is_(None), Finding.rule_id == "COI-R005")))
    flagged = {str((f.data or {}).get("delegate", "")).lower(): f for f in conflict}
    cards = []
    for r in power:
        if not r["is_delegate"] and r["voting_power"] == 0:
            continue
        history = []
        for p, v, votes in gov_props:
            mine = next((x for x in votes if x["voter"].lower() == r["address"].lower()), None)
            history.append({"proposal_id": p.id, "version": v.version, "support": mine["support"] if mine else None,
                            "weight": mine["weight"] if mine else None, "tx_hash": mine["tx_hash"] if mine else None,
                            "timestamp": mine["timestamp"] if mine else None})
        voted = [h for h in history if h["support"]]
        f = flagged.get(r["address"].lower())
        cards.append({
            "address": r["address"], "label": r["label"], "role": r["role"], "is_delegate": r["is_delegate"],
            "voting_power": str(r["voting_power"]), "voting_power_display": format_units(r["voting_power"], 18, 0),
            "power_pct": f"{Decimal(r['voting_power']) * 100 / Decimal(total_power):.2f}",
            "delegators": delegators.get(r["address"].lower(), []),
            "votes_cast": len(voted), "proposals_available": len(gov_props),
            "participation_pct": f"{Decimal(len(voted)) * 100 / Decimal(len(gov_props)):.0f}" if gov_props else "0",
            "for_count": sum(1 for h in voted if h["support"] == "for"),
            "against_count": sum(1 for h in voted if h["support"] == "against"),
            "abstain_count": sum(1 for h in voted if h["support"] == "abstain"),
            "last_vote": max((h["timestamp"] for h in voted), default=None),
            "history": history,
            "coi_check": {"status": "review", "detail": f.title, "finding_id": f.id} if f else {"status": "clear", "detail": "No observed relationship to proposers or recipients."},
        })
    cards.sort(key=lambda c: -int(c["voting_power"]))
    return {
        "data_label": "Fictional demo delegates on a local chain. Addresses are not real people.",
        "delegates": cards,
        "concentration": concentration([r["voting_power"] for r in power]),
        "totals": {"total_power": str(total_power), "active_voters": sum(1 for c in cards if c["votes_cast"]), "delegates": sum(1 for c in cards if c["is_delegate"])},
        "block_number": chain.block_number(),
        "governor_proposals": len(gov_props),
        "governor_address": governor.address,
    }

