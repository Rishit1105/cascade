"""Deterministic comparison of a submitted execution payload against the approved manifest.

This is the advisory layer: it explains *what* differs and *why it matters*. It never decides
whether execution is allowed; the ExecutionGuard contract enforces that independently by
recomputing the EIP-712 digest on-chain.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from .decoder import describe_action
from .labels import Labeler, format_token
from .manifests import Action, SubmittedPayload, manifest_actions, payload_digest
from .policy import severity_for

RULES: dict[str, tuple[str, str]] = {
    "DG-R000": ("Manifest digest mismatch", "critical"),
    "DG-R001": ("Chain context changed", "critical"),
    "DG-R002": ("Guard contract changed", "critical"),
    "DG-R003": ("Proposal key changed", "critical"),
    "DG-R004": ("Stale or different version", "critical"),
    "DG-R005": ("Approved action missing", "critical"),
    "DG-R006": ("Unapproved extra action", "critical"),
    "DG-R007": ("Target contract changed", "critical"),
    "DG-R008": ("Function changed", "critical"),
    "DG-R009": ("Recipient changed", "high"),
    "DG-R010": ("Amount changed", "high"),
    "DG-R011": ("Unapproved privileged call", "high"),
    "DG-R012": ("Call arguments changed", "high"),
    "DG-R013": ("DELEGATECALL requested", "critical"),
    "DG-R014": ("Native value changed", "high"),
    "DG-R015": ("Undecodable calldata", "medium"),
    "DG-R016": ("Action order changed", "medium"),
    "DG-R017": ("Upgrade implementation changed", "critical"),
}


class _Ctx:
    def __init__(self, db: Session | None, labeler: Labeler, manifest_hash: str | None, version: int | None):
        self.db = db
        self.labeler = labeler
        self.items: list[dict[str, Any]] = []
        self.evidence = {"type": "approved_manifest", "manifest_hash": manifest_hash, "version": version}

    def add(self, rule_id: str, field_path: str, approved: Any, submitted: Any, explanation: str, **extra: Any) -> None:
        title, default_sev = RULES[rule_id]
        self.items.append(
            {
                "rule_id": rule_id,
                "title": title,
                "severity": severity_for(self.db, rule_id, default_sev),
                "field_path": field_path,
                "approved_value": approved,
                "submitted_value": submitted,
                "explanation": explanation,
                "evidence_ref": self.evidence,
                **extra,
            }
        )


def _similarity(a: Action, b: Action) -> int:
    if a == b:
        return 4
    if a.target.lower() == b.target.lower() and a.data[:10] == b.data[:10]:
        return 3
    if a.target.lower() == b.target.lower():
        return 1
    if a.data[:10] == b.data[:10]:
        return 1
    return 0


def align(approved: list[Action], submitted: list[Action]) -> list[tuple[int | None, int | None]]:
    """Needleman-Wunsch alignment: pairs (approved_idx, submitted_idx); None marks a gap."""
    n, m = len(approved), len(submitted)
    gap = -1.0
    score = [[0.0] * (m + 1) for _ in range(n + 1)]
    move = [[""] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        score[i][0], move[i][0] = i * gap, "up"
    for j in range(1, m + 1):
        score[0][j], move[0][j] = j * gap, "left"
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            diag = score[i - 1][j - 1] + _similarity(approved[i - 1], submitted[j - 1])
            up = score[i - 1][j] + gap
            left = score[i][j - 1] + gap
            best = max(diag, up, left)
            score[i][j] = best
            move[i][j] = "diag" if best == diag else ("up" if best == up else "left")
    pairs: list[tuple[int | None, int | None]] = []
    i, j = n, m
    while i > 0 or j > 0:
        step = move[i][j] if i > 0 and j > 0 else ("up" if i > 0 else "left")
        if step == "diag":
            pairs.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif step == "up":
            pairs.append((i - 1, None))
            i -= 1
        else:
            pairs.append((None, j - 1))
            j -= 1
    pairs.reverse()
    return pairs


def _arg(info: dict[str, Any], idx: int) -> Any:
    args = info.get("args") or []
    return args[idx]["value"] if idx < len(args) else None


def _compare_pair(ctx: _Ctx, ai: int, si: int, a: Action, s: Action, ad: dict[str, Any], sd: dict[str, Any]) -> None:
    L = ctx.labeler
    path = f"actions[{si}]"
    if s.operation != a.operation or s.operation == 1:
        if s.operation == 1:
            ctx.add("DG-R013", f"{path}.operation", a.operation, s.operation,
                    "The submitted action asks the treasury to DELEGATECALL, which would run foreign code with the "
                    "treasury's own storage and permissions. The guard never performs delegatecalls.",
                    approved_index=ai, submitted_index=si)
    if a.target.lower() != s.target.lower():
        same_fn = a.data[:10] == s.data[:10]
        if ad.get("kind") == "erc20_transfer" and same_fn:
            explanation = (f"Approved transfer pays out {L.describe(a.target)}; the submitted transfer uses a different "
                           f"token contract {L.describe(s.target)}. A different token is a different payment.")
        else:
            explanation = (f"The approved action calls {L.describe(a.target)}; the submitted action calls "
                           f"{L.describe(s.target)} instead. Voters approved an interaction with a specific contract.")
        ctx.add("DG-R007", f"{path}.target", a.target, s.target, explanation,
                approved_display=L.describe(a.target), submitted_display=L.describe(s.target),
                approved_index=ai, submitted_index=si)
    if a.value != s.value:
        ctx.add("DG-R014", f"{path}.value", str(a.value), str(s.value),
                f"Native ETH sent with the call changed from {format_token(a.value, None, 'ETH')} to "
                f"{format_token(s.value, None, 'ETH')}.", approved_index=ai, submitted_index=si)
    if a.data == s.data:
        return
    if a.data[:10] != s.data[:10]:
        ctx.add("DG-R008", f"{path}.function", ad.get("function") or a.data[:10], sd.get("function") or s.data[:10],
                f"The approved action calls {ad.get('function') or 'an unknown function'}; the submitted action calls "
                f"{sd.get('function') or 'an unknown function (' + s.data[:10] + ')'}. It does something different.",
                approved_index=ai, submitted_index=si)
        if sd.get("privileged"):
            ctx.add("DG-R011", f"{path}.function", None, sd.get("function"),
                    f"The replacement call {sd.get('privileged')}. That power was never part of the approved decision.",
                    approved_index=ai, submitted_index=si)
        return
    if not sd.get("decoded"):
        ctx.add("DG-R015", f"{path}.data", a.data, s.data,
                "The calldata differs and cannot be decoded with known ABIs, so DAOGuard cannot say what changed. "
                "Treat it as an unverifiable change.", approved_index=ai, submitted_index=si)
        return
    kind = ad.get("kind")
    if kind == "erc20_transfer":
        if str(_arg(ad, 0)).lower() != str(_arg(sd, 0)).lower():
            ctx.add("DG-R009", f"{path}.args.to", _arg(ad, 0), _arg(sd, 0),
                    f"Voters approved paying {L.describe(_arg(ad, 0))}. The submitted transaction pays "
                    f"{L.describe(_arg(sd, 0))} instead. Paying a different address is a different decision, "
                    "even if every other field is identical.",
                    approved_display=L.describe(_arg(ad, 0)), submitted_display=L.describe(_arg(sd, 0)),
                    approved_index=ai, submitted_index=si)
        if str(_arg(ad, 1)) != str(_arg(sd, 1)):
            delta = int(_arg(sd, 1)) - int(_arg(ad, 1))
            pct = (delta * 10_000 // int(_arg(ad, 1))) / 100 if int(_arg(ad, 1)) else 0
            ctx.add("DG-R010", f"{path}.args.amount", str(_arg(ad, 1)), str(_arg(sd, 1)),
                    f"The approved amount is {format_token(_arg(ad, 1), a.target)}; the submitted amount is "
                    f"{format_token(_arg(sd, 1), s.target)} ({'+' if delta > 0 else ''}{pct:.2f}%).",
                    approved_display=format_token(_arg(ad, 1), a.target),
                    submitted_display=format_token(_arg(sd, 1), s.target),
                    approved_index=ai, submitted_index=si)
        return
    if kind == "proxy_upgrade":
        if str(_arg(ad, 1)).lower() != str(_arg(sd, 1)).lower():
            ctx.add("DG-R017", f"{path}.args.implementation", _arg(ad, 1), _arg(sd, 1),
                    f"Voters approved upgrading to {L.describe(_arg(ad, 1))}. The submitted upgrade installs "
                    f"{L.describe(_arg(sd, 1))}: different code would control the contract.",
                    approved_display=L.describe(_arg(ad, 1)), submitted_display=L.describe(_arg(sd, 1)),
                    approved_index=ai, submitted_index=si)
        for idx, name in ((0, "proxy"), (2, "data")):
            if str(_arg(ad, idx)).lower() != str(_arg(sd, idx)).lower():
                ctx.add("DG-R012", f"{path}.args.{name}", _arg(ad, idx), _arg(sd, idx),
                        f"The upgrade's {name} argument changed.", approved_index=ai, submitted_index=si)
        return
    a_args, s_args = ad.get("args") or [], sd.get("args") or []
    for idx, (aa, sa) in enumerate(zip(a_args, s_args)):
        if str(aa["value"]).lower() != str(sa["value"]).lower():
            ctx.add("DG-R012", f"{path}.args.{aa['name']}", aa["value"], sa["value"],
                    f"Argument '{aa['name']}' of {ad.get('function')} changed. "
                    + (f"This call {sd['privileged']}." if sd.get("privileged") else ""),
                    approved_index=ai, submitted_index=si)


def compare(
    approved_manifest: dict[str, Any] | None,
    submitted: SubmittedPayload,
    labeler: Labeler,
    db: Session | None = None,
) -> dict[str, Any]:
    submitted_hash = payload_digest(submitted)
    submitted_actions = list(submitted.actions)
    submitted_decoded = [describe_action(a, labeler) for a in submitted_actions]
    for i, d in enumerate(submitted_decoded):
        d["index"] = i

    if approved_manifest is None:
        return {
            "status": "UNKNOWN",
            "approved_manifest_hash": None,
            "submitted_manifest_hash": submitted_hash,
            "discrepancies": [],
            "submitted_decoded": submitted_decoded,
            "alignment": [],
            "summary": "No approved manifest exists for this proposal, so the payload cannot be verified against a decision.",
        }

    approved_hash = approved_manifest["manifest_hash"]
    ctx = _Ctx(db, labeler, approved_hash, approved_manifest.get("version"))
    approved_actions = manifest_actions(approved_manifest)
    approved_decoded = [describe_action(a, labeler) for a in approved_actions]

    if submitted.chain_id != approved_manifest["chain_id"]:
        ctx.add("DG-R001", "context.chain_id", approved_manifest["chain_id"], submitted.chain_id,
                f"The decision was approved for chain {approved_manifest['chain_id']}; this payload targets chain "
                f"{submitted.chain_id}. An approval never carries over to another network.")
    if submitted.guard.lower() != approved_manifest["guard"].lower():
        ctx.add("DG-R002", "context.guard", approved_manifest["guard"], submitted.guard,
                f"The approval is bound to {labeler.describe(approved_manifest['guard'])}; the payload is addressed "
                f"to {labeler.describe(submitted.guard)}, which holds no approval for it.")
    if submitted.proposal_key.lower() != approved_manifest["proposal_key"].lower():
        ctx.add("DG-R003", "context.proposal_key", approved_manifest["proposal_key"], submitted.proposal_key,
                "The payload claims to execute a different proposal than the one approved.")
    if submitted.version != approved_manifest["version"]:
        ctx.add("DG-R004", "context.version", approved_manifest["version"], submitted.version,
                f"Governance approved version {approved_manifest['version']}; the payload is version "
                f"{submitted.version}. Executing an older or different version is not what was voted on.")

    alignment: list[dict[str, Any]] = []
    if (
        len(approved_actions) == len(submitted_actions)
        and approved_actions != submitted_actions
        and sorted(map(repr, approved_actions)) == sorted(map(repr, submitted_actions))
    ):
        ctx.add("DG-R016", "actions", [d["human_readable"] for d in approved_decoded],
                [d["human_readable"] for d in submitted_decoded],
                "The same actions are present but in a different order. Order can change the outcome "
                "(for example a transfer before or after an allowance), so it is part of the approval.")
        alignment = [{"approved_index": i, "submitted_index": submitted_actions.index(a), "status": "reordered"}
                     for i, a in enumerate(approved_actions)]
    else:
        for ai, si in align(approved_actions, submitted_actions):
            if ai is not None and si is not None:
                _compare_pair(ctx, ai, si, approved_actions[ai], submitted_actions[si], approved_decoded[ai], submitted_decoded[si])
                exact = approved_actions[ai] == submitted_actions[si]
                status = "match" if exact else "mismatch"
                if not exact and not submitted_decoded[si].get("decoded"):
                    status = "unverifiable"
                alignment.append({"approved_index": ai, "submitted_index": si, "status": status})
            elif ai is not None:
                ad = approved_decoded[ai]
                ctx.add("DG-R005", f"approved.actions[{ai}]", ad["human_readable"], None,
                        f"Approved action #{ai + 1} is missing from the submitted payload: {ad['human_readable']} "
                        "Dropping part of an approved batch changes what the decision does.", approved_index=ai)
                alignment.append({"approved_index": ai, "submitted_index": None, "status": "missing"})
            else:
                sd = submitted_decoded[si]  # type: ignore[index]
                ctx.add("DG-R006", f"actions[{si}]", None, sd["human_readable"],
                        f"Submitted action #{si + 1} was never approved: {sd['human_readable']}", submitted_index=si)
                if sd.get("privileged"):
                    ctx.add("DG-R011", f"actions[{si}].function", None, sd.get("function"),
                            f"The unapproved action {sd['privileged']}. Extra privileged calls are a common way to "
                            "smuggle control changes into an otherwise legitimate payout.", submitted_index=si)
                if submitted_actions[si].operation == 1:  # type: ignore[index]
                    ctx.add("DG-R013", f"actions[{si}].operation", None, 1,
                            "The unapproved action requests DELEGATECALL.", submitted_index=si)
                alignment.append({"approved_index": None, "submitted_index": si, "status": "extra"})

    if submitted_hash.lower() != approved_hash.lower():
        ctx.items.insert(
            0,
            {
                "rule_id": "DG-R000",
                "title": RULES["DG-R000"][0],
                "severity": severity_for(db, "DG-R000", RULES["DG-R000"][1]),
                "field_path": "manifest_hash",
                "approved_value": approved_hash,
                "submitted_value": submitted_hash,
                "explanation": (
                    "The submitted payload hashes to a different EIP-712 digest than the one governance approved. "
                    "The ExecutionGuard recomputes this digest on-chain and will refuse to execute."
                ),
                "evidence_ref": ctx.evidence,
            },
        )
        status = "MISMATCH"
    else:
        status = "MATCH"
        ctx.items = []

    if status == "MATCH":
        summary = "The submitted payload is byte-for-byte the manifest governance approved."
    else:
        worst = [d for d in ctx.items if d["rule_id"] != "DG-R000"]
        headline = worst[0]["title"].lower() if worst else "digest differs"
        summary = f"The payload does not match the approved manifest ({len(ctx.items)} finding(s); first: {headline})."

    return {
        "status": status,
        "approved_manifest_hash": approved_hash,
        "submitted_manifest_hash": submitted_hash,
        "discrepancies": ctx.items,
        "approved_decoded": approved_decoded,
        "submitted_decoded": submitted_decoded,
        "alignment": alignment,
        "summary": summary,
    }
