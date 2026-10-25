"""Proposal lifecycle: drafts, action specs, disclosures, committed versions and their diffs."""

from __future__ import annotations

import difflib
import re
from typing import Any

from eth_abi import encode as abi_encode
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak, to_checksum_address
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..chain.client import TxReverted
from ..clock import iso, utcnow
from ..errors import Conflict, NotFound, ValidationFailed
from ..models import Disclosure, EvidenceDocument, Proposal, ProposalVersion, new_id
from ..runtime import Deployment, runtime
from . import audit
from .canonical import CANON_VERSION, content_hash, merkle_root
from .decoder import describe_action
from .findings import sync_findings
from .labels import Labeler, format_units
from .manifests import Action, PayloadError, manifest_document, parse_address, parse_hex_bytes, parse_operation, parse_uint, proposal_key

EDITABLE_FIELDS = [
    "title", "summary", "category", "proposer_address", "proposer_label", "recipient_address", "recipient_label",
    "requested_amount_base", "purpose", "body", "milestones", "risks", "assumptions", "benefits", "budget_breakdown",
    "draft_actions",
]
CATEGORIES = {"grant", "upgrade", "budget", "retainer", "parameter"}
SELECTOR_TRANSFER = "0xa9059cbb"


def get_proposal(db: Session, proposal_id: str) -> Proposal:
    p = db.get(Proposal, proposal_id)
    if p is None:
        raise NotFound("proposal_not_found", f"Proposal {proposal_id} does not exist.")
    return p


def latest_version(p: Proposal) -> ProposalVersion | None:
    return p.versions[-1] if p.versions else None


def get_version(p: Proposal, version: int) -> ProposalVersion:
    for v in p.versions:
        if v.version == version:
            return v
    raise NotFound("version_not_found", f"{p.id} has no committed version {version}.")


def approved_version(p: Proposal) -> ProposalVersion | None:
    """The version whose manifest governance approved (or executed / halted)."""
    for v in reversed(p.versions):
        if v.governance_status in ("approved", "executed", "halted"):
            return v
    return None


# ------------------------------------------------------------------ actions
def build_actions(specs: list[dict[str, Any]], deployment: Deployment) -> list[Action]:
    """Turn editable action specs into exact executable actions. Strict: no coercion."""
    if not isinstance(specs, list):
        raise ValidationFailed("invalid_actions", "draft_actions must be a list")
    actions: list[Action] = []
    for i, spec in enumerate(specs):
        path = f"draft_actions[{i}]"
        if not isinstance(spec, dict) or "kind" not in spec:
            raise ValidationFailed("invalid_actions", f"{path}: each action needs a 'kind'")
        try:
            kind = spec["kind"]
            if kind == "erc20_transfer":
                token = parse_address(spec.get("token") or deployment.c("usdc"), f"{path}.token")
                recipient = parse_address(spec.get("recipient"), f"{path}.recipient")
                amount = parse_uint(spec.get("amount_base"), f"{path}.amount_base")
                if amount == 0:
                    raise PayloadError(f"{path}.amount_base", "must be greater than zero")
                data = SELECTOR_TRANSFER + abi_encode(["address", "uint256"], [recipient, amount]).hex()
                actions.append(Action(token, 0, data, 0))
            elif kind == "proxy_upgrade":
                admin = parse_address(spec.get("proxy_admin") or deployment.c("proxy_admin"), f"{path}.proxy_admin")
                proxy = parse_address(spec.get("proxy") or deployment.c("fee_vault"), f"{path}.proxy")
                impl = parse_address(spec.get("implementation"), f"{path}.implementation")
                call = parse_hex_bytes(spec.get("call_data", "0x"), f"{path}.call_data")
                selector = "0x" + keccak(text="upgradeAndCall(address,address,bytes)")[:4].hex()
                data = selector + abi_encode(["address", "address", "bytes"], [proxy, impl, bytes.fromhex(call[2:])]).hex()
                actions.append(Action(admin, 0, data, 0))
            elif kind == "raw":
                actions.append(
                    Action(
                        parse_address(spec.get("target"), f"{path}.target"),
                        parse_uint(spec.get("value", "0"), f"{path}.value"),
                        parse_hex_bytes(spec.get("data"), f"{path}.data"),
                        parse_operation(spec.get("operation", 0), f"{path}.operation"),
                    )
                )
            else:
                raise PayloadError(f"{path}.kind", "must be erc20_transfer, proxy_upgrade or raw")
        except PayloadError as exc:
            raise ValidationFailed("invalid_actions", str(exc), {"path": exc.path}) from exc
    return actions


def manifest_for(p: Proposal, version: int, deployment: Deployment, labeler: Labeler) -> dict[str, Any]:
    actions = build_actions(p.draft_actions or [], deployment)
    if not actions:
        raise ValidationFailed("empty_manifest", "A proposal needs at least one executable action before it can be committed.")
    rich = []
    for i, a in enumerate(actions):
        d = describe_action(a, labeler)
        rich.append(
            {
                "index": i,
                "target": a.target,
                "value": str(a.value),
                "data": a.data,
                "operation": a.operation,
                "kind": d.get("kind"),
                "function": d.get("function"),
                "args": d.get("args"),
                "token_address": d.get("token_address"),
                "token_symbol": d.get("token_symbol"),
                "expected_recipient": d.get("expected_recipient"),
                "expected_amount_base": d.get("expected_amount_base"),
                "upgrade": d.get("upgrade"),
                "privileged": d.get("privileged"),
                "human_readable": d.get("human_readable"),
            }
        )
    return manifest_document(proposal_id=p.id, version=version, chain_id=deployment.chain_id, guard=deployment.c("guard"), actions=rich)


# ------------------------------------------------------------------ create / update
def _validate_fields(data: dict[str, Any], deployment: Deployment | None) -> dict[str, Any]:
    out = dict(data)
    try:
        if "proposer_address" in out:
            out["proposer_address"] = parse_address(out["proposer_address"], "proposer_address")
        if out.get("recipient_address"):
            out["recipient_address"] = parse_address(out["recipient_address"], "recipient_address")
        if "requested_amount_base" in out:
            out["requested_amount_base"] = str(parse_uint(out["requested_amount_base"], "requested_amount_base"))
    except PayloadError as exc:
        raise ValidationFailed("invalid_field", str(exc), {"path": exc.path}) from exc
    if "category" in out and out["category"] not in CATEGORIES:
        raise ValidationFailed("invalid_field", f"category must be one of {sorted(CATEGORIES)}")
    if "title" in out and not str(out["title"]).strip():
        raise ValidationFailed("invalid_field", "title is required")
    for list_field in ("milestones", "risks", "assumptions", "benefits", "budget_breakdown", "draft_actions"):
        if list_field in out and not isinstance(out[list_field], list):
            raise ValidationFailed("invalid_field", f"{list_field} must be a list")
    if deployment and "draft_actions" in out:
        build_actions(out["draft_actions"], deployment)
    return out


def next_proposal_id(db: Session) -> str:
    numbers = [int(m.group(1)) for pid in db.scalars(select(Proposal.id)) if (m := re.match(r"GOV-(\d+)$", pid))]
    return f"GOV-{(max(numbers) + 1 if numbers else 1):03d}"


def create_proposal(db: Session, data: dict[str, Any], actor: str, source: str = "ui", is_demo: bool = False) -> Proposal:
    deployment = runtime.require_deployment()
    data = _validate_fields(data, deployment)
    pid = data.pop("id", None) or next_proposal_id(db)
    if db.get(Proposal, pid):
        raise Conflict("proposal_exists", f"{pid} already exists.")
    if not data.get("draft_actions") and data.get("recipient_address") and int(data.get("requested_amount_base") or 0) > 0:
        data["draft_actions"] = [
            {"kind": "erc20_transfer", "token": deployment.c("usdc"), "recipient": data["recipient_address"], "amount_base": data["requested_amount_base"]}
        ]
    p = Proposal(
        id=pid,
        key=proposal_key(pid),
        token_address=deployment.c("usdc"),
        treasury_address=deployment.c("guard"),
        status="draft",
        is_demo=is_demo,
        created_at=utcnow(),
        updated_at=utcnow(),
        **{k: v for k, v in data.items() if k in EDITABLE_FIELDS},
    )
    if not p.proposer_label:
        p.proposer_label = Labeler(db).label(p.proposer_address) or ""
    db.add(p)
    db.commit()
    audit.record(event_type="proposal_created", summary=f"{pid} “{p.title}” created as a draft.", actor=actor, source=source,
                 status="info", proposal_id=pid, details={"category": p.category, "requested_amount_base": p.requested_amount_base})
    return p


def update_proposal(db: Session, p: Proposal, patch: dict[str, Any], actor: str, source: str = "ui") -> Proposal:
    deployment = runtime.require_deployment()
    if p.status in ("executed",):
        raise Conflict("proposal_closed", f"{p.id} has been executed; open a new proposal instead.")
    patch = _validate_fields({k: v for k, v in patch.items() if k in EDITABLE_FIELDS}, deployment)
    changed = [k for k, v in patch.items() if getattr(p, k) != v]
    for k in changed:
        setattr(p, k, patch[k])
    if changed:
        p.updated_at = utcnow()
        if p.status == "draft":
            p.status = "in_review"
        db.commit()
        audit.record(event_type="proposal_draft_updated", summary=f"Draft of {p.id} edited ({', '.join(changed)}). Committed versions are unchanged.",
                     actor=actor, source=source, proposal_id=p.id, details={"changed_fields": changed})
    return p


# ------------------------------------------------------------------ disclosures
def latest_disclosure(db: Session, proposal_id: str) -> Disclosure | None:
    return db.scalars(select(Disclosure).where(Disclosure.proposal_id == proposal_id).order_by(Disclosure.created_at.desc()).limit(1)).first()


def save_disclosure(db: Session, p: Proposal, statement: dict[str, Any], actor: str, source: str = "ui") -> Disclosure:
    relationships = statement.get("relationships") or []
    if not isinstance(relationships, list):
        raise ValidationFailed("invalid_disclosure", "relationships must be a list")
    clean_rel = []
    for i, r in enumerate(relationships):
        if not isinstance(r, dict) or not str(r.get("party", "")).strip() or not str(r.get("relationship", "")).strip():
            raise ValidationFailed("invalid_disclosure", f"relationships[{i}] needs a party and a relationship")
        addr = r.get("address")
        if addr:
            try:
                addr = parse_address(addr, f"relationships[{i}].address")
            except PayloadError as exc:
                raise ValidationFailed("invalid_disclosure", str(exc)) from exc
        clean_rel.append({"party": str(r["party"]).strip(), "address": addr, "relationship": str(r["relationship"]).strip(), "details": str(r.get("details") or "").strip()})
    no_conflicts = bool(statement.get("no_conflicts"))
    if no_conflicts and clean_rel:
        raise ValidationFailed("invalid_disclosure", "A disclosure cannot both attest 'no conflicts' and list relationships.")
    if not no_conflicts and not clean_rel:
        raise ValidationFailed("invalid_disclosure", "List at least one relationship, or attest that there are none.")
    clean = {
        "proposal_id": p.id,
        "proposer": p.proposer_address,
        "no_conflicts": no_conflicts,
        "relationships": clean_rel,
        "holdings": str(statement.get("holdings") or "").strip(),
        "compensation": str(statement.get("compensation") or "").strip(),
        "statement_version": "dg-disclosure-1",
    }
    d = Disclosure(id=new_id("DS"), proposal_id=p.id, statement=clean, disclosure_hash=content_hash(clean), signer=p.proposer_address, created_at=utcnow())
    db.add(d)
    db.commit()
    audit.record(event_type="disclosure_published",
                 summary=f"Proposer published a conflict-of-interest disclosure for {p.id} "
                         f"({'no conflicts attested' if no_conflicts else f'{len(clean_rel)} relationship(s) disclosed'}).",
                 actor=p.proposer_label or p.proposer_address, source=source, proposal_id=p.id,
                 details={"disclosure_id": d.id, "disclosure_hash": d.disclosure_hash})
    return d


def disclosure_typed_data(deployment: Deployment, key: str, version: int, content: str, disclosure: str) -> dict[str, Any]:
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "Disclosure": [
                {"name": "proposalKey", "type": "bytes32"},
                {"name": "version", "type": "uint64"},
                {"name": "contentHash", "type": "bytes32"},
                {"name": "disclosureHash", "type": "bytes32"},
            ],
        },
        "primaryType": "Disclosure",
        "domain": {"name": "DAOGuard ProposalRegistry", "version": "1", "chainId": deployment.chain_id, "verifyingContract": deployment.c("registry")},
        "message": {"proposalKey": key, "version": version, "contentHash": content, "disclosureHash": disclosure},
    }


def recover_disclosure_signer(typed: dict[str, Any], signature: str) -> str:
    message = encode_typed_data(full_message=typed)
    return to_checksum_address(Account.recover_message(message, signature=signature))


# ------------------------------------------------------------------ versions
def snapshot_document(p: Proposal, version: int, manifest: dict[str, Any], evidence: list[EvidenceDocument], disclosure: Disclosure | None) -> dict[str, Any]:
    return {
        "canonicalization": CANON_VERSION,
        "proposal_id": p.id,
        "version": version,
        "title": p.title,
        "summary": p.summary,
        "category": p.category,
        "proposer": p.proposer_address,
        "recipient": p.recipient_address,
        "token": p.token_address,
        "requested_amount_base": str(p.requested_amount_base),
        "purpose": p.purpose,
        "body": p.body,
        "milestones": p.milestones or [],
        "risks": p.risks or [],
        "assumptions": p.assumptions or [],
        "benefits": p.benefits or [],
        "budget_breakdown": p.budget_breakdown or [],
        "evidence": sorted(({"id": e.id, "name": e.name, "content_hash": e.content_hash} for e in evidence), key=lambda e: e["id"]),
        "disclosure_hash": disclosure.disclosure_hash if disclosure else None,
        "manifest_hash": manifest["manifest_hash"],
        "actions": [
            {"target": a["target"], "value": a["value"], "data": a["data"], "operation": a["operation"], "human_readable": a["human_readable"]}
            for a in manifest["actions"]
        ],
    }


def commit_version(db: Session, p: Proposal, actor: str, change_note: str = "", source: str = "ui") -> ProposalVersion:
    deployment = runtime.require_deployment()
    chain = runtime.chain
    labeler = Labeler(db)
    disclosure = latest_disclosure(db, p.id)
    if disclosure is None:
        raise Conflict("disclosure_required",
                       "The proposer must publish a conflict-of-interest disclosure before a version can be committed.")
    if p.proposer_address not in deployment.accounts.values():
        raise Conflict("proposer_cannot_sign",
                       "The proposer address is not one of the demo node's accounts, so it cannot sign the disclosure in this sandbox.")
    if p.status in ("voting", "approved"):
        current = latest_version(p)
        if current and current.governance_status in ("voting", "succeeded", "approved"):
            raise Conflict("version_locked",
                           f"Version {current.version} is {current.governance_status}. Wait for the vote to end or be halted before committing a new version.")
    if p.status == "executed":
        raise Conflict("proposal_closed", f"{p.id} has already been executed.")

    version = p.current_version + 1
    manifest = manifest_for(p, version, deployment, labeler)
    evidence = list(p.evidence)
    evidence_hashes = sorted(e.content_hash for e in evidence)
    root = merkle_root(evidence_hashes)
    snapshot = snapshot_document(p, version, manifest, evidence, disclosure)
    c_hash = content_hash(snapshot)

    typed = disclosure_typed_data(deployment, p.key, version, c_hash, disclosure.disclosure_hash)
    signature = chain.sign_typed_data(p.proposer_address, typed)
    recovered = recover_disclosure_signer(typed, signature)
    if recovered.lower() != p.proposer_address.lower():
        raise Conflict("signature_mismatch", f"Disclosure signature recovered {recovered}, not the proposer.")

    registry = chain.contract("ProposalRegistry", deployment.c("registry"))
    try:
        tx = chain.transact(
            registry,
            "commitVersion",
            [
                bytes.fromhex(p.key[2:]), version, bytes.fromhex(c_hash[2:]), bytes.fromhex(manifest["manifest_hash"][2:]),
                bytes.fromhex(root[2:]), bytes.fromhex(disclosure.disclosure_hash[2:]), p.proposer_address,
                bytes.fromhex(signature[2:]),
            ],
            deployment.a("sentinel"),
        )
    except TxReverted as exc:
        raise Conflict("commit_rejected", f"ProposalRegistry rejected the commit: {exc}", exc.revert) from exc

    previous = latest_version(p)
    changes = diff_snapshots(previous.snapshot, snapshot, labeler) if previous else []
    v = ProposalVersion(
        proposal_id=p.id,
        version=version,
        snapshot=snapshot,
        content_hash=c_hash,
        manifest=manifest,
        manifest_hash=manifest["manifest_hash"],
        evidence_root=root,
        evidence_hashes=evidence_hashes,
        disclosure=disclosure.statement,
        disclosure_hash=disclosure.disclosure_hash,
        disclosure_signature=signature,
        changed_fields=[c["path"] for c in changes],
        change_note=change_note,
        author=actor,
        committed_at=utcnow(),
        tx_hash=tx.tx_hash,
        block_number=tx.block_number,
        governance_status="not_submitted",
    )
    p.versions.append(v)
    p.current_version = version
    p.status = "committed"
    p.updated_at = utcnow()
    db.commit()

    sync_findings(db, p.id, "version", version_findings(p, changes, previous, version), source_ref=f"v{version}")
    db.commit()
    audit.record(
        event_type="version_committed",
        summary=f"{p.id} v{version} committed on-chain: content, manifest, evidence root and signed disclosure hashes recorded.",
        actor=actor,
        source=source,
        status="success",
        proposal_id=p.id,
        version=version,
        manifest_hash=manifest["manifest_hash"],
        tx=tx,
        details={"content_hash": c_hash, "evidence_root": root, "disclosure_hash": disclosure.disclosure_hash,
                 "changed_fields": v.changed_fields, "change_note": change_note, "proposer_signature_recovered": recovered},
    )
    return v


def version_findings(p: Proposal, changes: list[dict[str, Any]], previous: ProposalVersion | None, version: int) -> list[dict[str, Any]]:
    items = []
    critical_categories = {"recipient", "amount", "target", "calldata", "implementation", "permissions"}
    exec_changes = [c for c in changes if c["category"] in critical_categories]
    if previous and exec_changes:
        impl = [c for c in exec_changes if c["category"] == "implementation"]
        items.append(
            {
                "rule_id": "DG-V001",
                "severity": "high",
                "confidence": "verified",
                "title": "Executable payload changed after an earlier version" + (" (new implementation)" if impl else ""),
                "explanation": (
                    f"Between v{previous.version} and v{version}, {len(exec_changes)} executable field(s) changed: "
                    + "; ".join(c["summary"] for c in exec_changes[:4])
                    + ". Reviews, audits and simulations of the earlier version do not automatically apply to the new payload."
                ),
                "remediation": "Re-run simulation and confirm any audit covers the new payload before voting.",
                "evidence_refs": [{"type": "version_diff", "from": previous.version, "to": version}],
                "data": {"changes": exec_changes},
                "key": f"v{previous.version}->v{version}",
            }
        )
    return items


# ------------------------------------------------------------------ diffs
def _flatten(value: Any, prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    if isinstance(value, dict):
        for k, v in value.items():
            out.update(_flatten(v, f"{prefix}.{k}" if prefix else k))
    elif isinstance(value, list) and value and all(isinstance(v, (dict, list)) for v in value):
        for i, v in enumerate(value):
            out.update(_flatten(v, f"{prefix}[{i}]"))
    else:
        out[prefix] = value
    return out


def _categorise(path: str) -> str:
    if path in ("recipient",):
        return "recipient"
    if path == "requested_amount_base":
        return "amount"
    if path.startswith("actions") and path.endswith(".target"):
        return "target"
    if path.startswith("actions") and (path.endswith(".data") or path.endswith(".value") or path.endswith(".operation")):
        return "calldata"
    if path.startswith("evidence"):
        return "evidence"
    if path.startswith("milestones"):
        return "milestones"
    if path == "disclosure_hash":
        return "disclosure"
    if path in ("body", "summary", "purpose", "title"):
        return "text"
    if path == "manifest_hash":
        return "manifest"
    if path.startswith("budget"):
        return "budget"
    return "other"


def _line_diff(a: str, b: str) -> list[dict[str, Any]]:
    left, right = (a or "").splitlines(), (b or "").splitlines()
    rows: list[dict[str, Any]] = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(a=left, b=right, autojunk=False).get_opcodes():
        if tag == "equal":
            rows.extend({"tag": "equal", "left": left[i], "right": right[j1 + k]} for k, i in enumerate(range(i1, i2)))
        elif tag == "replace":
            span = max(i2 - i1, j2 - j1)
            for k in range(span):
                rows.append({"tag": "replace", "left": left[i1 + k] if i1 + k < i2 else None, "right": right[j1 + k] if j1 + k < j2 else None})
        elif tag == "delete":
            rows.extend({"tag": "delete", "left": left[i], "right": None} for i in range(i1, i2))
        else:
            rows.extend({"tag": "insert", "left": None, "right": right[j]} for j in range(j1, j2))
    return rows


def diff_snapshots(old: dict[str, Any], new: dict[str, Any], labeler: Labeler) -> list[dict[str, Any]]:
    a, b = _flatten(old), _flatten(new)
    ignore = {"version", "canonicalization"}
    changes: list[dict[str, Any]] = []
    for path in sorted(set(a) | set(b)):
        if path in ignore or path.endswith("human_readable"):
            continue
        before, after = a.get(path), b.get(path)
        if before == after:
            continue
        category = _categorise(path)
        kind = "added" if path not in a else "removed" if path not in b else "changed"
        summary = f"{path} {kind}"
        if category == "recipient":
            summary = f"recipient changed from {labeler.describe(before)} to {labeler.describe(after)}"
        elif category == "amount":
            summary = f"amount changed from {format_units(before or 0, 6)} to {format_units(after or 0, 6)}"
        elif category == "target":
            summary = f"target changed from {labeler.describe(before)} to {labeler.describe(after)}"
        changes.append({"path": path, "kind": kind, "category": category, "before": before, "after": after, "summary": summary})
    # Decode calldata changes into argument-level changes (recipient / amount / implementation).
    from .decoder import decode_calldata

    for c in list(changes):
        if c["category"] == "calldata" and c["path"].endswith(".data") and c["before"] and c["after"]:
            da, db_ = decode_calldata(c["before"]), decode_calldata(c["after"])
            if da.get("signature") and da.get("signature") == db_.get("signature"):
                for x, y in zip(da["args"], db_["args"]):
                    if str(x["value"]).lower() != str(y["value"]).lower():
                        cat = "implementation" if da["signature"].startswith("upgrade") and x["name"] in ("implementation", "newImplementation") else (
                            "recipient" if x["type"] == "address" else "amount" if x["type"].startswith("uint") else "calldata")
                        changes.append(
                            {
                                "path": c["path"].replace(".data", f".args.{x['name']}"),
                                "kind": "changed",
                                "category": cat,
                                "before": x["value"],
                                "after": y["value"],
                                "summary": f"{da['signature'].split('(')[0]} argument {x['name']} changed from "
                                           f"{labeler.describe(x['value']) if x['type'] == 'address' else x['value']} to "
                                           f"{labeler.describe(y['value']) if y['type'] == 'address' else y['value']}",
                            }
                        )
    return changes


def version_diff(db: Session, p: Proposal, from_version: int, to_version: int | None) -> dict[str, Any]:
    deployment = runtime.require_deployment()
    labeler = Labeler(db)
    old = get_version(p, from_version)
    if to_version is None:
        manifest = manifest_for(p, p.current_version + 1, deployment, labeler) if p.draft_actions else {"manifest_hash": None, "actions": []}
        new_snapshot = snapshot_document(p, p.current_version + 1, manifest, list(p.evidence), latest_disclosure(db, p.id))
        new_meta = {"version": "draft", "content_hash": content_hash(new_snapshot), "committed_at": None, "author": None}
    else:
        new = get_version(p, to_version)
        new_snapshot = new.snapshot
        new_meta = {"version": new.version, "content_hash": new.content_hash, "committed_at": iso(new.committed_at), "author": new.author}
    changes = diff_snapshots(old.snapshot, new_snapshot, labeler)
    text_diffs = {
        field: _line_diff(old.snapshot.get(field, ""), new_snapshot.get(field, ""))
        for field in ("body", "summary", "purpose")
        if old.snapshot.get(field) != new_snapshot.get(field)
    }
    old_ev = {e["id"]: e for e in old.snapshot.get("evidence", [])}
    new_ev = {e["id"]: e for e in new_snapshot.get("evidence", [])}
    return {
        "proposal_id": p.id,
        "from": {"version": old.version, "content_hash": old.content_hash, "committed_at": iso(old.committed_at), "author": old.author},
        "to": new_meta,
        "identical": not changes,
        "identical_note": "Identical means the canonical content hashes match. It does not mean the proposal is truthful.",
        "changes": changes,
        "highlights": [c for c in changes if c["category"] in ("recipient", "amount", "target", "calldata", "implementation", "permissions", "evidence", "milestones", "disclosure")],
        "text_diffs": text_diffs,
        "evidence": {
            "added": [new_ev[k] for k in new_ev.keys() - old_ev.keys()],
            "removed": [old_ev[k] for k in old_ev.keys() - new_ev.keys()],
            "changed": [new_ev[k] for k in new_ev.keys() & old_ev.keys() if new_ev[k]["content_hash"] != old_ev[k]["content_hash"]],
        },
    }


def verify_version(db: Session, p: Proposal, version: int) -> dict[str, Any]:
    """Recompute every hash of a committed version and compare with what the chain recorded."""
    deployment = runtime.require_deployment()
    chain = runtime.chain
    v = get_version(p, version)
    checks: list[dict[str, Any]] = []

    def check(name: str, ok: bool, detail: str) -> None:
        checks.append({"check": name, "ok": ok, "detail": detail})

    recomputed_content = content_hash(v.snapshot)
    check("Snapshot content hash", recomputed_content == v.content_hash, f"recomputed {recomputed_content}")
    from .manifests import manifest_actions, manifest_digest

    digest = manifest_digest(v.manifest["chain_id"], v.manifest["guard"], v.manifest["proposal_key"], v.manifest["version"], manifest_actions(v.manifest))
    check("Manifest EIP-712 digest", digest == v.manifest_hash, f"recomputed {digest}")
    current_docs = {e.id: e for e in p.evidence}
    tampered = [e["id"] for e in v.snapshot.get("evidence", []) if e["id"] in current_docs and current_docs[e["id"]].content_hash != e["content_hash"]]
    missing = [e["id"] for e in v.snapshot.get("evidence", []) if e["id"] not in current_docs]
    root = merkle_root(sorted(e["content_hash"] for e in v.snapshot.get("evidence", [])))
    check("Evidence Merkle root", root == v.evidence_root, f"recomputed {root}")
    check("Evidence files unchanged since commit", not tampered and not missing,
          "all committed evidence files still hash to their committed values" if not tampered and not missing
          else f"changed: {tampered or 'none'}; missing: {missing or 'none'}")
    typed = disclosure_typed_data(deployment, p.key, version, v.content_hash, v.disclosure_hash)
    try:
        signer = recover_disclosure_signer(typed, v.disclosure_signature)
        check("Disclosure signed by proposer", signer.lower() == p.proposer_address.lower(), f"signature recovers to {signer}")
    except Exception as exc:
        check("Disclosure signed by proposer", False, f"signature invalid: {exc}")
    registry = chain.contract("ProposalRegistry", deployment.c("registry"))
    onchain: dict[str, Any] | None = None
    try:
        rec = registry.functions.getVersion(bytes.fromhex(p.key[2:]), version).call()
        onchain = {
            "content_hash": "0x" + rec[0].hex(),
            "manifest_hash": "0x" + rec[1].hex(),
            "evidence_root": "0x" + rec[2].hex(),
            "disclosure_hash": "0x" + rec[3].hex(),
            "proposer": rec[4],
            "block_number": rec[6],
        }
        check("On-chain content hash", onchain["content_hash"] == v.content_hash, f"registry stores {onchain['content_hash']}")
        check("On-chain manifest hash", onchain["manifest_hash"] == v.manifest_hash, f"registry stores {onchain['manifest_hash']}")
        check("On-chain evidence root", onchain["evidence_root"] == v.evidence_root, f"registry stores {onchain['evidence_root']}")
        check("On-chain disclosure hash", onchain["disclosure_hash"] == v.disclosure_hash, f"registry stores {onchain['disclosure_hash']}")
    except Exception as exc:
        check("On-chain record found", False, f"registry lookup failed: {exc}")
    ok = all(c["ok"] for c in checks)
    audit.record(event_type="version_verified", summary=f"{p.id} v{version} integrity re-verified: {'all checks passed' if ok else 'MISMATCH found'}.",
                 actor="reviewer", source="ui", status="success" if ok else "failure", proposal_id=p.id, version=version,
                 manifest_hash=v.manifest_hash, details={"checks": checks})
    return {
        "proposal_id": p.id,
        "version": version,
        "ok": ok,
        "checks": checks,
        "onchain": onchain,
        "note": "A matching hash proves the content equals what was committed. It does not prove the content is true.",
    }
