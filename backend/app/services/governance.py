"""On-chain voting through the OpenZeppelin Governor.

A version's governor proposal has exactly one action: ExecutionGuard.approveManifest(key,
version, manifestHash). Voters therefore approve an exact executable digest. Votes are real
transactions from the demo node's delegate accounts (labelled as demo voters).
"""

from __future__ import annotations

from typing import Any

from eth_utils import keccak
from sqlalchemy.orm import Session

from ..chain.client import TxReverted
from ..clock import from_timestamp, iso
from ..errors import Conflict, ValidationFailed
from ..models import Proposal, ProposalVersion
from ..runtime import ACCOUNT_ROLES, DELEGATE_ROLES, VOTER_ROLES, Deployment, runtime
from . import audit
from .labels import Labeler, format_units
from .proposals import latest_version

GOV_STATES = ["Pending", "Active", "Canceled", "Defeated", "Succeeded", "Queued", "Expired", "Executed"]
SUPPORT = {0: "against", 1: "for", 2: "abstain"}
VOTE_CAST_TOPIC = "0x" + keccak(text="VoteCast(address,uint256,uint8,uint256,string)").hex()


def _calls(v: ProposalVersion, p: Proposal, deployment: Deployment) -> tuple[list[str], list[int], list[bytes], str]:
    guard = runtime.chain.contract("ExecutionGuard", deployment.c("guard"))
    data = guard.encode_abi("approveManifest", args=[bytes.fromhex(p.key[2:]), v.version, bytes.fromhex(v.manifest_hash[2:])])
    description = (
        f"{p.id} v{v.version}: {p.title}\n\n"
        f"Approves exactly one action: ExecutionGuard.approveManifest for manifest {v.manifest_hash}.\n"
        f"Content hash {v.content_hash} (ProposalRegistry tx {v.tx_hash})."
    )
    return [deployment.c("guard")], [0], [bytes.fromhex(data[2:])], description


def _governor():
    deployment = runtime.require_deployment()
    return runtime.chain.contract("AtlasGovernor", deployment.c("governor"))


def submit(db: Session, p: Proposal, actor: str, source: str = "ui") -> ProposalVersion:
    deployment = runtime.require_deployment()
    v = latest_version(p)
    if v is None:
        raise Conflict("no_version", "Commit a reviewed version before opening a vote.")
    if v.governor_proposal_id:
        raise Conflict("vote_exists", f"v{v.version} already has an on-chain vote.")
    targets, values, calldatas, description = _calls(v, p, deployment)
    governor = _governor()
    try:
        tx = runtime.chain.transact(governor, "propose", [targets, values, calldatas, description], p.proposer_address)
    except TxReverted as exc:
        raise Conflict("propose_rejected", f"The governor rejected the proposal: {exc}", exc.revert) from exc
    created = next((l for l in tx.logs if l.get("event") == "ProposalCreated"), None)
    if created is None:
        raise Conflict("propose_failed", "ProposalCreated event not found in the receipt.")
    v.governor_proposal_id = created["args"]["proposalId"]
    v.governor_description = description
    v.governance_status = "voting"
    p.status = "voting"
    db.commit()
    audit.record(
        event_type="governance_proposed",
        summary=f"On-chain vote opened for {p.id} v{v.version}. The only action voters approve is the manifest digest {v.manifest_hash[:12]}….",
        actor=p.proposer_label or p.proposer_address,
        source=source,
        status="info",
        proposal_id=p.id,
        version=v.version,
        manifest_hash=v.manifest_hash,
        tx=tx,
        details={"governor_proposal_id": v.governor_proposal_id, "vote_start": created["args"].get("voteStart"), "vote_end": created["args"].get("voteEnd")},
    )
    return v


def votes_for(proposal_id: int | str) -> list[dict[str, Any]]:
    deployment = runtime.require_deployment()
    chain = runtime.chain
    out = []
    for log in chain.get_logs(deployment.c("governor"), [VOTE_CAST_TOPIC], 0):
        if str(log["args"].get("proposalId")) != str(proposal_id):
            continue
        block = chain.block(log["block_number"])
        out.append(
            {
                "voter": log["args"]["voter"],
                "support": SUPPORT.get(int(log["args"]["support"]), "unknown"),
                "weight": log["args"]["weight"],
                "reason": log["args"].get("reason") or "",
                "tx_hash": log["tx_hash"],
                "block_number": log["block_number"],
                "timestamp": iso(from_timestamp(int(block["timestamp"], 16))),
            }
        )
    return out


def state(db: Session, p: Proposal, v: ProposalVersion | None = None) -> dict[str, Any]:
    deployment = runtime.require_deployment()
    chain = runtime.chain
    labeler = Labeler(db)
    v = v or latest_version(p)
    current_block = chain.block_number()
    guard = chain.contract("ExecutionGuard", deployment.c("guard"))
    approval = guard.functions.approvalOf(bytes.fromhex(p.key[2:])).call()
    guard_status = ["none", "approved", "executed", "halted"][int(approval[4])]
    guard_info = {
        "status": guard_status,
        "manifest_hash": "0x" + approval[0].hex() if guard_status != "none" else None,
        "version": int(approval[1]) if guard_status != "none" else None,
        "approved_at_block": int(approval[2]) if guard_status != "none" else None,
        "executable_at_block": int(approval[3]) if guard_status != "none" else None,
        "halt_reason": "0x" + approval[5].hex() if guard_status == "halted" else None,
        "review_window_blocks": deployment.review_window_blocks,
    }
    base = {"proposal_id": p.id, "current_block": current_block, "guard": guard_info, "version": v.version if v else None}
    if v is None or not v.governor_proposal_id:
        return {**base, "state": "not_submitted", "governance_status": v.governance_status if v else "no_version"}
    governor = _governor()
    pid = int(v.governor_proposal_id)
    gstate = GOV_STATES[int(governor.functions.state(pid).call())]
    against, for_, abstain = governor.functions.proposalVotes(pid).call()
    snapshot = int(governor.functions.proposalSnapshot(pid).call())
    deadline = int(governor.functions.proposalDeadline(pid).call())
    quorum = int(governor.functions.quorum(snapshot).call()) if snapshot < current_block else None
    token = chain.contract("AtlasToken", deployment.c("atlas"))
    supply = int(token.functions.getPastTotalSupply(snapshot).call()) if snapshot < current_block else int(token.functions.totalSupply().call())
    votes = votes_for(pid)
    for vote in votes:
        vote["voter_label"] = labeler.label(vote["voter"])
    cast = against + for_ + abstain
    return {
        **base,
        "state": gstate,
        "governance_status": v.governance_status,
        "governor_proposal_id": v.governor_proposal_id,
        "description": v.governor_description,
        "snapshot_block": snapshot,
        "deadline_block": deadline,
        "blocks_remaining": max(0, deadline - current_block),
        "votes": {"for": str(for_), "against": str(against), "abstain": str(abstain)},
        "votes_display": {k: format_units(x, 18, 0) for k, x in (("for", for_), ("against", against), ("abstain", abstain))},
        "quorum": str(quorum) if quorum is not None else None,
        "quorum_reached": quorum is not None and (for_ + abstain) >= quorum,
        "total_supply": str(supply),
        "participation_pct": f"{cast * 100 / supply:.2f}" if supply else "0",
        "voters": votes,
        "voting_mode": "Token-weighted (ATLAS checkpoints at the snapshot block). Votes are cast by demo delegate accounts on the local chain.",
    }


def voter_accounts(db: Session) -> list[dict[str, Any]]:
    deployment = runtime.require_deployment()
    token = runtime.chain.contract("AtlasToken", deployment.c("atlas"))
    labels = {r[0]: r[2] for r in ACCOUNT_ROLES}
    out = []
    for role in VOTER_ROLES:
        addr = deployment.a(role)
        out.append({"role": role, "address": addr, "label": labels.get(role, role), "voting_power": str(token.functions.getVotes(addr).call()),
                    "is_delegate": role in DELEGATE_ROLES})
    return out


def cast_vote(db: Session, p: Proposal, voter: str, support: int, reason: str, actor: str, source: str = "ui") -> dict[str, Any]:
    deployment = runtime.require_deployment()
    if support not in SUPPORT:
        raise ValidationFailed("invalid_support", "support must be 0 (against), 1 (for) or 2 (abstain)")
    allowed = {deployment.a(r).lower(): r for r in VOTER_ROLES}
    if voter.lower() not in allowed:
        raise ValidationFailed("unknown_voter", "Votes can only be cast from the demo voter accounts.")
    v = latest_version(p)
    if v is None or not v.governor_proposal_id:
        raise Conflict("no_vote", "There is no open on-chain vote for this proposal.")
    governor = _governor()
    pid = int(v.governor_proposal_id)
    gstate = GOV_STATES[int(governor.functions.state(pid).call())]
    if gstate == "Pending":
        snap = int(governor.functions.proposalSnapshot(pid).call())
        raise Conflict("vote_pending", f"Voting opens after block {snap}. Advance the demo chain by a block first.")
    if gstate != "Active":
        raise Conflict("vote_closed", f"Voting is {gstate.lower()}.")
    if governor.functions.hasVoted(pid, voter).call():
        raise Conflict("already_voted", "This account has already voted on this proposal.")
    tx = runtime.chain.transact(governor, "castVoteWithReason", [pid, support, reason[:280]], voter)
    vote = next((l for l in tx.logs if l.get("event") == "VoteCast"), None)
    label = Labeler(db).label(voter) or voter
    weight = int(vote["args"]["weight"]) if vote else 0
    audit.record(
        event_type="vote_cast",
        summary=f"{label} voted {SUPPORT[support].upper()} on {p.id} v{v.version} with {format_units(weight, 18, 0)} ATLAS.",
        actor=label,
        source=source,
        status="info",
        proposal_id=p.id,
        version=v.version,
        manifest_hash=v.manifest_hash,
        tx=tx,
        details={"support": SUPPORT[support], "weight": str(weight), "reason": reason, "acting_user": actor},
    )
    return {"tx_hash": tx.tx_hash, "block_number": tx.block_number, "weight": str(weight)}


def advance(blocks: int, actor: str, proposal_id: str | None = None) -> dict[str, Any]:
    if not 1 <= blocks <= 200:
        raise ValidationFailed("invalid_blocks", "Advance between 1 and 200 blocks at a time.")
    before = runtime.chain.block_number()
    runtime.chain.mine(blocks, 12)
    after = runtime.chain.block_number()
    audit.record(event_type="demo_chain_advanced", summary=f"Demo chain advanced {blocks} block(s) ({before} → {after}) to move the governance clock.",
                 actor=actor, source="ui", status="info", proposal_id=proposal_id, details={"from_block": before, "to_block": after})
    return {"from_block": before, "to_block": after}


def finalize(db: Session, p: Proposal, actor: str, source: str = "ui") -> dict[str, Any]:
    deployment = runtime.require_deployment()
    v = latest_version(p)
    if v is None or not v.governor_proposal_id:
        raise Conflict("no_vote", "There is no on-chain vote to finalize.")
    governor = _governor()
    pid = int(v.governor_proposal_id)
    gstate = GOV_STATES[int(governor.functions.state(pid).call())]
    if gstate in ("Pending", "Active"):
        deadline = int(governor.functions.proposalDeadline(pid).call())
        raise Conflict("vote_open", f"Voting is still {gstate.lower()} until block {deadline}.")
    if gstate in ("Defeated", "Expired", "Canceled"):
        v.governance_status = "defeated"
        p.status = "defeated"
        db.commit()
        audit.record(event_type="vote_finalized", summary=f"{p.id} v{v.version} vote ended {gstate.lower()}; no manifest was approved.",
                     actor=actor, source=source, status="warning", proposal_id=p.id, version=v.version)
        return {"state": gstate, "approved": False}
    if gstate == "Executed":
        raise Conflict("already_finalized", "The governor proposal has already been executed.")
    targets, values, calldatas, description = _calls(v, p, deployment)
    try:
        tx = runtime.chain.transact(governor, "execute", [targets, values, calldatas, keccak(text=description)], deployment.a("executor"))
    except TxReverted as exc:
        raise Conflict("finalize_rejected", f"The governor could not execute the approval: {exc}", exc.revert) from exc
    approved = next((l for l in tx.logs if l.get("event") == "ManifestApproved"), None)
    v.governance_status = "approved"
    p.status = "approved"
    db.commit()
    audit.record(
        event_type="manifest_approved",
        summary=f"Vote passed: ExecutionGuard now holds approval for {p.id} v{v.version} manifest {v.manifest_hash[:12]}…, "
                f"executable from block {approved['args']['executableAtBlock'] if approved else '?'} after the guardian review window.",
        actor="Atlas Governor",
        source=source,
        status="success",
        proposal_id=p.id,
        version=v.version,
        manifest_hash=v.manifest_hash,
        tx=tx,
        details={"executable_at_block": approved["args"]["executableAtBlock"] if approved else None, "finalized_by": actor},
    )
    if runtime.sentinel is not None:
        runtime.sentinel.wake()
    return {"state": "Executed", "approved": True, "tx_hash": tx.tx_hash, "block_number": tx.block_number}


def auto_vote_plan(p: Proposal, outcome: str) -> list[tuple[str, int, str]]:
    """Demo delegate behaviour for the chosen outcome. The three largest delegates follow the
    outcome; smaller delegates vary deterministically per (proposal, delegate)."""
    lead = {"pass": {"d01": 1, "d02": 1, "d03": 1, "d04": 0}, "fail": {"d01": 0, "d02": 0, "d03": 2, "d04": 0}}[outcome]
    plan = []
    for role in DELEGATE_ROLES:
        h = keccak(text=f"{p.id}:{role}")[0]
        if role in lead:
            support = lead[role]
        elif outcome == "pass":
            support = 1 if h < 180 else (0 if h < 220 else 2)
        else:
            support = 0 if h < 165 else (1 if h < 230 else 2)
        plan.append((role, support, f"Simulated demo delegate ({outcome} scenario)."))
    return plan


def simulate_votes(db: Session, p: Proposal, actor: str, outcome: str = "pass") -> list[dict[str, Any]]:
    deployment = runtime.require_deployment()
    v = latest_version(p)
    if v is None or not v.governor_proposal_id:
        raise Conflict("no_vote", "Open an on-chain vote first.")
    governor = _governor()
    pid = int(v.governor_proposal_id)
    if GOV_STATES[int(governor.functions.state(pid).call())] == "Pending":
        runtime.chain.mine(2, 12)
    if outcome not in ("pass", "fail"):
        raise ValidationFailed("invalid_outcome", "outcome must be 'pass' or 'fail'")
    results = []
    for role, support, reason in auto_vote_plan(p, outcome):
        addr = deployment.a(role)
        if governor.functions.hasVoted(pid, addr).call():
            continue
        if GOV_STATES[int(governor.functions.state(pid).call())] != "Active":
            break
        results.append({"role": role, **cast_vote(db, p, addr, support, reason, actor)})
    return results
