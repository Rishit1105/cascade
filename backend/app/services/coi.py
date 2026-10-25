"""Relationship graph and conflict-of-interest analysis.

Edges come from four kinds of provenance, always labelled:
  * verified_observation: a local-chain event (Transfer, DelegateChanged, VoteCast) or bytecode
  * disclosed:            the proposer's signed disclosure
  * record:               DAOGuard's own records (proposal author, manifest recipient, evidence)
  * unverified_lead:      manual annotations and heuristics (e.g. a common funding source)
A transfer shows that value moved. It never shows common ownership, control or misconduct.
"""

from __future__ import annotations

from collections import defaultdict, deque
from functools import lru_cache
from typing import Any

from eth_utils import keccak
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..clock import from_timestamp, iso
from ..models import Annotation, ExecutionAttempt, Proposal, new_id
from ..runtime import runtime
from . import bytecode
from .findings import sync_findings
from .labels import Labeler, format_token
from .proposals import latest_disclosure, latest_version

TRANSFER_TOPIC = "0x" + keccak(text="Transfer(address,address,uint256)").hex()
DELEGATE_TOPIC = "0x" + keccak(text="DelegateChanged(address,address,address)").hex()
VOTE_TOPIC = "0x" + keccak(text="VoteCast(address,uint256,uint8,uint256,string)").hex()
ZERO = "0x0000000000000000000000000000000000000000"
EDGE_WEIGHT = {"transfer": 0.85, "delegated_to": 0.6, "disclosed_affiliation": 0.95, "manual_annotation": 0.4, "embedded_in_bytecode": 0.9}
HOP_DECAY = 0.7
NOTE = "A transfer shows that value moved between addresses. It does not show common ownership, control or misconduct."


@lru_cache(maxsize=4096)
def _block_ts(number: int) -> int:
    return int(runtime.chain.block(number)["timestamp"], 16)


def _chain_events() -> dict[str, list[dict[str, Any]]]:
    deployment = runtime.require_deployment()
    chain = runtime.chain
    transfers = []
    for log in chain.get_logs(deployment.c("usdc"), [TRANSFER_TOPIC], 0):
        if log["args"]["from"] == ZERO:
            continue
        transfers.append({**log["args"], "token": deployment.c("usdc"), "tx_hash": log["tx_hash"], "block_number": log["block_number"],
                          "timestamp": iso(from_timestamp(_block_ts(log["block_number"])))})
    delegations = []
    for log in chain.get_logs(deployment.c("atlas"), [DELEGATE_TOPIC], 0):
        a = log["args"]
        if a["delegator"].lower() == a["toDelegate"].lower():
            continue
        delegations.append({**a, "tx_hash": log["tx_hash"], "block_number": log["block_number"], "timestamp": iso(from_timestamp(_block_ts(log["block_number"])))})
    votes = []
    for log in chain.get_logs(deployment.c("governor"), [VOTE_TOPIC], 0):
        votes.append({**log["args"], "tx_hash": log["tx_hash"], "block_number": log["block_number"], "timestamp": iso(from_timestamp(_block_ts(log["block_number"])))})
    return {"transfers": transfers, "delegations": delegations, "votes": votes}


def _embedded_addresses(db: Session) -> list[dict[str, Any]]:
    """Unknown addresses hard-coded in implementations referenced by any committed upgrade."""
    deployment = runtime.require_deployment()
    known = {v.lower() for v in deployment.contracts.values()}
    out = []
    seen: set[str] = set()
    for p in db.scalars(select(Proposal)):
        for v in p.versions:
            for a in v.manifest.get("actions", []):
                impl = (a.get("upgrade") or {}).get("implementation")
                if not impl or impl.lower() in seen:
                    continue
                seen.add(impl.lower())
                analysis = bytecode.analyze(runtime.chain.get_code(impl))
                for addr in analysis["embedded_addresses"]:
                    if addr.lower() not in known:
                        out.append({"implementation": impl, "address": addr, "proposal_id": p.id, "version": v.version})
    return out


def build_graph(db: Session) -> dict[str, Any]:
    deployment = runtime.require_deployment()
    labeler = Labeler(db)
    events = _chain_events()
    nodes: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    contracts = {v.lower(): k for k, v in deployment.contracts.items()}

    def addr_node(addr: str) -> str:
        nid = addr.lower()
        if nid not in nodes:
            kind = labeler.kind(addr)
            role = labeler.role(addr)
            if contracts.get(nid) == "guard":
                ntype = "treasury"
            elif nid in contracts:
                ntype = "contract"
            elif kind == "delegate":
                ntype = "delegate"
            else:
                ntype = "wallet"
            nodes[nid] = {"id": nid, "type": ntype, "label": labeler.label(addr) or f"{addr[:6]}…{addr[-4:]}", "address": addr,
                          "role": role, "labelled": labeler.known(addr), "tags": []}
        return nid

    nodes["dao"] = {"id": "dao", "type": "dao", "label": "Atlas DAO (demo)", "address": None, "tags": []}
    for name in ("guard", "governor", "atlas", "usdc", "registry"):
        nid = addr_node(deployment.c(name))
        edges.append({"id": f"dao-{name}", "source": "dao", "target": nid, "type": "governs", "label": "DAO contract",
                      "evidence_level": "record", "provenance": {"kind": "deployment record"}, "directed": False})

    # Transfers, aggregated per (from, to).
    agg: dict[tuple[str, str], dict[str, Any]] = {}
    for t in events["transfers"]:
        key = (t["from"].lower(), t["to"].lower())
        entry = agg.setdefault(key, {"from": t["from"], "to": t["to"], "total": 0, "txs": []})
        entry["total"] += int(t["value"])
        entry["txs"].append({"tx_hash": t["tx_hash"], "block_number": t["block_number"], "timestamp": t["timestamp"], "amount": t["value"]})
    for (f, to), e in agg.items():
        s, d = addr_node(e["from"]), addr_node(e["to"])
        first = e["txs"][0]
        edges.append({
            "id": f"tx-{f}-{to}", "source": s, "target": d, "type": "transfer",
            "label": f"{format_token(e['total'], deployment.c('usdc'))}" + (f" · {len(e['txs'])} txs" if len(e["txs"]) > 1 else ""),
            "evidence_level": "verified_observation", "value_base": str(e["total"]), "token": "mUSDC", "count": len(e["txs"]),
            "provenance": {"kind": "local-chain Transfer event", "tx_hash": first["tx_hash"], "block_number": first["block_number"],
                           "timestamp": first["timestamp"], "transactions": e["txs"]},
            "directed": True,
        })
    for dlg in events["delegations"]:
        s, d = addr_node(dlg["delegator"]), addr_node(dlg["toDelegate"])
        edges.append({"id": f"dlg-{s}-{d}-{dlg['block_number']}", "source": s, "target": d, "type": "delegated_to", "label": "delegated ATLAS votes",
                      "evidence_level": "verified_observation", "directed": True,
                      "provenance": {"kind": "local-chain DelegateChanged event", "tx_hash": dlg["tx_hash"], "block_number": dlg["block_number"], "timestamp": dlg["timestamp"]}})

    gov_ids: dict[str, tuple[str, int]] = {}
    for p in db.scalars(select(Proposal)):
        pid = f"proposal:{p.id}"
        nodes[pid] = {"id": pid, "type": "proposal", "label": p.id, "subtitle": p.title, "status": p.status, "proposal_id": p.id, "tags": []}
        edges.append({"id": f"{pid}-dao", "source": pid, "target": "dao", "type": "submitted_to", "label": "proposal", "evidence_level": "record",
                      "provenance": {"kind": "proposal record"}, "directed": True})
        committed = bool(p.versions)
        edges.append({"id": f"{pid}-proposer", "source": addr_node(p.proposer_address), "target": pid, "type": "proposed", "label": "proposed",
                      "evidence_level": "verified_observation" if committed else "record",
                      "provenance": {"kind": "EIP-712 disclosure signature recovered on commit" if committed else "proposal record",
                                     "tx_hash": p.versions[-1].tx_hash if committed else None}, "directed": True})
        v = latest_version(p)
        if v:
            if v.governor_proposal_id:
                gov_ids[str(v.governor_proposal_id)] = (pid, v.version)
            for a in v.manifest["actions"]:
                if a.get("expected_recipient"):
                    edges.append({"id": f"{pid}-pays-{a['index']}", "source": pid, "target": addr_node(a["expected_recipient"]), "type": "pays",
                                  "label": f"pays {format_token(a['expected_amount_base'], a['target'])}", "evidence_level": "record",
                                  "provenance": {"kind": f"committed manifest v{v.version}", "manifest_hash": v.manifest_hash}, "directed": True})
                if a.get("upgrade"):
                    edges.append({"id": f"{pid}-upgrade-{a['index']}", "source": pid, "target": addr_node(a["upgrade"]["implementation"]),
                                  "type": "executes_contract", "label": "installs implementation", "evidence_level": "record",
                                  "provenance": {"kind": f"committed manifest v{v.version}", "manifest_hash": v.manifest_hash}, "directed": True})
        for doc in p.evidence:
            did = f"doc:{doc.id}"
            nodes[did] = {"id": did, "type": "evidence", "label": doc.name, "subtitle": doc.source_type, "doc_id": doc.id, "proposal_id": p.id,
                          "content_hash": doc.content_hash, "tags": ["injection-flagged"] if doc.injection_flags else []}
            edges.append({"id": f"{pid}-{did}", "source": pid, "target": did, "type": "references_evidence", "label": "evidence",
                          "evidence_level": "record", "provenance": {"kind": "evidence record", "content_hash": doc.content_hash}, "directed": True})
        disclosure = latest_disclosure(db, p.id)
        if disclosure:
            for r in disclosure.statement.get("relationships", []):
                if r.get("address"):
                    edges.append({"id": f"disc-{disclosure.id}-{r['address'].lower()}", "source": addr_node(p.proposer_address), "target": addr_node(r["address"]),
                                  "type": "disclosed_affiliation", "label": r["relationship"], "evidence_level": "disclosed",
                                  "provenance": {"kind": "proposer's disclosure", "disclosure_hash": disclosure.disclosure_hash}, "directed": False})
        for att in db.scalars(select(ExecutionAttempt).where(ExecutionAttempt.proposal_id == p.id, ExecutionAttempt.tx_hash.is_not(None))):
            tid = f"txn:{att.tx_hash}"
            nodes[tid] = {"id": tid, "type": "transaction", "label": f"{att.tx_hash[:10]}…", "subtitle": f"execution {att.outcome}",
                          "tx_hash": att.tx_hash, "block_number": att.block_number, "outcome": att.outcome, "tags": [att.outcome]}
            edges.append({"id": f"{pid}-{tid}", "source": pid, "target": tid, "type": "execution_attempt", "label": att.outcome,
                          "evidence_level": "verified_observation", "provenance": {"kind": "local-chain transaction receipt", "tx_hash": att.tx_hash,
                                                                                    "block_number": att.block_number}, "directed": True})
    for vote in events["votes"]:
        target = gov_ids.get(str(vote["proposalId"]))
        if not target:
            continue
        support = {0: "against", 1: "for", 2: "abstain"}.get(int(vote["support"]), "?")
        edges.append({"id": f"vote-{vote['tx_hash']}", "source": addr_node(vote["voter"]), "target": target[0], "type": "voted",
                      "label": f"voted {support}", "support": support, "weight": vote["weight"], "evidence_level": "verified_observation",
                      "provenance": {"kind": "local-chain VoteCast event", "tx_hash": vote["tx_hash"], "block_number": vote["block_number"], "timestamp": vote["timestamp"]},
                      "directed": True})
    for emb in _embedded_addresses(db):
        edges.append({"id": f"emb-{emb['implementation'].lower()}-{emb['address'].lower()}", "source": addr_node(emb["implementation"]),
                      "target": addr_node(emb["address"]), "type": "embedded_in_bytecode", "label": "address hard-coded in bytecode",
                      "evidence_level": "verified_observation", "provenance": {"kind": "deployed bytecode (PUSH constant)", "proposal_id": emb["proposal_id"]},
                      "directed": True})
    for ann in db.scalars(select(Annotation)):
        edges.append({"id": f"ann-{ann.id}", "source": addr_node(ann.source_address), "target": addr_node(ann.target_address), "type": "manual_annotation",
                      "label": ann.relation, "evidence_level": ann.evidence_level, "note": ann.note,
                      "provenance": {"kind": "manual annotation", "created_by": ann.created_by, "created_at": iso(ann.created_at)}, "directed": False})

    degree: dict[str, int] = defaultdict(int)
    for e in edges:
        degree[e["source"]] += 1
        degree[e["target"]] += 1
    for n in nodes.values():
        n["degree"] = degree.get(n["id"], 0)
    return {
        "nodes": list(nodes.values()),
        "edges": edges,
        "legend": {
            "evidence_levels": {
                "verified_observation": "Observed on the local chain (event, receipt or bytecode)",
                "disclosed": "Stated in the proposer's signed disclosure",
                "record": "DAOGuard record (proposal, manifest, evidence)",
                "unverified_lead": "Manual annotation or heuristic. Needs evidence",
            }
        },
        "note": NOTE,
        "block_number": runtime.chain.block_number(),
        "data_label": "Fictional demo entities on a local chain. Labels are annotations, not identity claims.",
    }


# --------------------------------------------------------------------- conflicts
def _adjacency(graph: dict[str, Any]) -> dict[str, list[tuple[str, dict[str, Any]]]]:
    hubs = {n["id"] for n in graph["nodes"] if n["type"] in ("treasury", "contract", "dao", "proposal", "evidence", "transaction")}
    adj: dict[str, list[tuple[str, dict[str, Any]]]] = defaultdict(list)
    for e in graph["edges"]:
        if e["type"] not in EDGE_WEIGHT:
            continue
        if e["source"] in hubs and e["type"] != "embedded_in_bytecode":
            continue
        if e["target"] in hubs:
            continue
        adj[e["source"]].append((e["target"], e))
        adj[e["target"]].append((e["source"], e))
    return adj


def _paths(adj: dict[str, list[tuple[str, dict[str, Any]]]], start: str, goal: str, max_hops: int = 3) -> list[list[dict[str, Any]]]:
    results: list[list[dict[str, Any]]] = []
    queue: deque[tuple[str, list[dict[str, Any]], set[str]]] = deque([(start, [], {start})])
    while queue:
        node, path, seen = queue.popleft()
        if len(path) >= max_hops:
            continue
        for nxt, edge in adj.get(node, []):
            if nxt in seen:
                continue
            new_path = path + [edge]
            if nxt == goal:
                results.append(new_path)
            else:
                queue.append((nxt, new_path, seen | {nxt}))
    return results


def _path_weight(path: list[dict[str, Any]]) -> float:
    w = 1.0
    for e in path:
        w *= EDGE_WEIGHT.get(e["type"], 0.3)
    return w * (HOP_DECAY ** (len(path) - 1))


def analyze(db: Session, p: Proposal, persist: bool = True) -> dict[str, Any]:
    deployment = runtime.require_deployment()
    labeler = Labeler(db)
    graph = build_graph(db)
    adj = _adjacency(graph)
    proposer = p.proposer_address.lower()
    v = latest_version(p)
    parties: list[dict[str, Any]] = [{"role": "proposer", "address": p.proposer_address, "label": labeler.label(p.proposer_address)}]
    counterparties: list[tuple[str, str]] = []
    if p.recipient_address:
        counterparties.append(("recipient", p.recipient_address))
    for emb in _embedded_addresses(db):
        if emb["proposal_id"] == p.id:
            counterparties.append(("address embedded in submitted code", emb["address"]))
    for role, addr in counterparties:
        parties.append({"role": role, "address": addr, "label": labeler.label(addr)})

    disclosure = latest_disclosure(db, p.id)
    disclosed = {r["address"].lower() for r in (disclosure.statement.get("relationships", []) if disclosure else []) if r.get("address")}
    findings: list[dict[str, Any]] = []
    path_out: list[dict[str, Any]] = []
    tx_rows: dict[str, dict[str, Any]] = {}

    def add_tx_rows(path: list[dict[str, Any]], tags: list[str]) -> None:
        for e in path:
            if e["type"] != "transfer":
                continue
            for t in e["provenance"].get("transactions", []):
                tx_rows.setdefault(t["tx_hash"], {
                    "tx_hash": t["tx_hash"], "block_number": t["block_number"], "timestamp": t["timestamp"],
                    "amount_base": t["amount"], "amount_display": format_token(t["amount"], deployment.c("usdc")),
                    "from": graph_node_addr(graph, e["source"]), "to": graph_node_addr(graph, e["target"]),
                    "from_label": node_label(graph, e["source"]), "to_label": node_label(graph, e["target"]), "tags": set(),
                })["tags"].update(tags)

    connection_scores = []
    for role, addr in counterparties:
        target = addr.lower()
        paths = _paths(adj, proposer, target)
        weights = [_path_weight(pth) for pth in paths]
        score = 1.0
        for w in weights:
            score *= 1 - w
        index = round((1 - score) * 100)
        connection_scores.append({"counterparty_role": role, "address": addr, "index": index, "paths": len(paths)})
        for pth, w in sorted(zip(paths, weights), key=lambda x: -x[1])[:5]:
            hops = [{"from": node_label(graph, e["source"]), "to": node_label(graph, e["target"]), "type": e["type"], "label": e["label"],
                     "evidence_level": e["evidence_level"], "tx_hash": e["provenance"].get("tx_hash"), "block_number": e["provenance"].get("block_number")}
                    for e in pth]
            path_out.append({"counterparty_role": role, "counterparty": addr, "hops": hops, "length": len(pth), "weight": round(w, 3)})
            add_tx_rows(pth, ["Proposer", role.capitalize() if role == "recipient" else "Embedded address"])
        direct = [pth for pth in paths if len(pth) == 1 and pth[0]["type"] == "transfer"]
        if direct:
            e = direct[0][0]
            is_disclosed = target in disclosed
            findings.append({
                "rule_id": "COI-R001" if role == "recipient" else "COI-R004",
                "severity": "info" if is_disclosed else "high",
                "confidence": "verified",
                "title": (f"Disclosed relationship confirmed on-chain: proposer and {role}" if is_disclosed
                          else f"Undisclosed observed transfer between proposer and {role}"),
                "explanation": (f"{labeler.describe(graph_node_addr(graph, e['source']))} sent "
                                f"{e['label']} to {labeler.describe(graph_node_addr(graph, e['target']))} "
                                f"(first in block {e['provenance'].get('block_number')}). "
                                + ("The proposer disclosed this relationship." if is_disclosed else
                                   f"The proposer's disclosure {'attests no conflicts' if disclosure and disclosure.statement.get('no_conflicts') else 'does not mention this address'}. ")
                                + NOTE),
                "remediation": f"Ask the proposer to explain the payment to the {role} and amend the disclosure if a relationship exists.",
                "evidence_refs": [{"type": "transaction", "tx_hash": t["tx_hash"], "block_number": t["block_number"]} for t in e["provenance"].get("transactions", [])],
                "data": {"edge": e["id"], "counterparty": addr},
                "key": f"direct:{proposer}:{target}",
            })
        elif paths:
            best = max(zip(paths, weights), key=lambda x: x[1])[0]
            route = " → ".join(f"{node_label(graph, e['source'])} ({e['label']}) {node_label(graph, e['target'])}" for e in best)
            findings.append({
                "rule_id": "COI-R002",
                "severity": "medium",
                "confidence": "heuristic",
                "title": f"Indirect connection ({len(best)} hops) between proposer and {role}",
                "explanation": f"Path: {route}. {NOTE}",
                "remediation": "Treat as a lead for review, not a finding of fact.",
                "evidence_refs": [{"type": "path", "hops": len(best)}],
                "data": {"counterparty": addr},
                "key": f"path:{proposer}:{target}",
            })

        # Common funding source (heuristic).
        funders_p = {e["source"] for e in graph["edges"] if e["type"] == "transfer" and e["target"] == proposer}
        funders_c = {e["source"] for e in graph["edges"] if e["type"] == "transfer" and e["target"] == target}
        hub_ids = {n["id"] for n in graph["nodes"] if n["type"] in ("treasury", "contract")}
        for funder in (funders_p & funders_c) - hub_ids:
            findings.append({
                "rule_id": "COI-R003",
                "severity": "low",
                "confidence": "heuristic",
                "title": f"Common funding source for proposer and {role}",
                "explanation": f"{node_label(graph, funder)} sent funds to both the proposer and the {role}. Exchanges and payroll wallets fund many "
                               f"unrelated accounts, so this is a weak lead only. {NOTE}",
                "remediation": "Only relevant if combined with stronger evidence.",
                "evidence_refs": [{"type": "address", "address": graph_node_addr(graph, funder)}],
                "data": {"funder": graph_node_addr(graph, funder)},
                "key": f"funder:{funder}:{target}",
            })
            for e in graph["edges"]:
                if e["type"] == "transfer" and e["source"] == funder and e["target"] in (proposer, target):
                    add_tx_rows([e], ["Common funder"])

    # Recipient voting power used in this proposal's vote.
    if p.recipient_address and v and v.governor_proposal_id:
        r = p.recipient_address.lower()
        delegates = [e for e in graph["edges"] if e["type"] == "delegated_to" and e["source"] == r]
        votes = [e for e in graph["edges"] if e["type"] == "voted" and e["target"] == f"proposal:{p.id}"]
        for d in delegates:
            for vote in votes:
                if vote["source"] == d["target"]:
                    findings.append({
                        "rule_id": "COI-R005",
                        "severity": "medium",
                        "confidence": "verified",
                        "title": "Recipient's delegated voting power was used in this vote",
                        "explanation": f"The recipient delegated its ATLAS votes to {node_label(graph, d['target'])}, who voted {vote.get('support')} on {p.id}. "
                                       "The recipient's own tokens therefore counted towards its own grant. Delegation is normal; the overlap is worth disclosing.",
                        "remediation": "Ask the delegate whether the recipient's delegated weight should have abstained.",
                        "evidence_refs": [{"type": "transaction", "tx_hash": d["provenance"]["tx_hash"]}, {"type": "transaction", "tx_hash": vote["provenance"]["tx_hash"]}],
                        "data": {"delegate": graph_node_addr(graph, d["target"])},
                        "key": f"delegated-vote:{r}:{d['target']}",
                    })
    # A missing disclosure is reported once, by the missing-information gate (MI-R005).
    if persist:
        sync_findings(db, p.id, "conflict", findings, source_ref="coi")
        db.commit()
    tx_list = sorted(({**t, "tags": sorted(t["tags"])} for t in tx_rows.values()), key=lambda t: t["block_number"])
    return {
        "proposal_id": p.id,
        "parties": parties,
        "disclosure": {
            "present": disclosure is not None,
            "statement": disclosure.statement if disclosure else None,
            "disclosure_hash": disclosure.disclosure_hash if disclosure else None,
            "signed_in_version": v.version if v and disclosure and v.disclosure_hash == disclosure.disclosure_hash else None,
        },
        "connection_index": connection_scores,
        "connection_index_method": (
            "Noisy-OR over relationship paths up to 3 hops: each path weight is the product of edge weights "
            f"({', '.join(f'{k} {w}' for k, w in EDGE_WEIGHT.items())}) × {HOP_DECAY}^(hops−1). "
            "0 means no observed path, 100 means many strong direct paths. It measures connectedness, not wrongdoing."
        ),
        "paths": path_out,
        "findings": findings,
        "transactions": tx_list,
        "note": NOTE,
    }


def graph_node_addr(graph: dict[str, Any], node_id: str) -> str | None:
    for n in graph["nodes"]:
        if n["id"] == node_id:
            return n.get("address")
    return None


def node_label(graph: dict[str, Any], node_id: str) -> str:
    for n in graph["nodes"]:
        if n["id"] == node_id:
            return n["label"]
    return node_id


def add_annotation(db: Session, source_address: str, target_address: str, relation: str, note: str, actor: str) -> Annotation:
    from ..errors import ValidationFailed
    from . import audit
    from .manifests import PayloadError, parse_address

    try:
        s = parse_address(source_address, "source_address")
        t = parse_address(target_address, "target_address")
    except PayloadError as exc:
        raise ValidationFailed("invalid_address", str(exc)) from exc
    if not relation.strip():
        raise ValidationFailed("relation_required", "Describe the relationship.")
    ann = Annotation(id=new_id("ANN"), source_address=s, target_address=t, relation=relation.strip()[:64], note=note.strip(),
                     evidence_level="unverified_lead", created_by=actor)
    db.add(ann)
    db.commit()
    audit.record(event_type="graph_annotation_added", summary=f"Manual annotation added: {relation.strip()} ({s[:8]}… ↔ {t[:8]}…). Shown as an unverified lead.",
                 actor=actor, source="ui", details={"annotation_id": ann.id, "note": note.strip()})
    return ann


def verify_transaction(tx_hash: str) -> dict[str, Any]:
    """Re-read a transfer straight from the node so a reviewer can confirm what the table shows."""
    chain = runtime.chain
    receipt = chain.get_receipt(tx_hash)
    if receipt is None:
        return {"tx_hash": tx_hash, "found": False, "note": "Transaction not found on the connected node."}
    from ..chain.client import decode_logs

    logs = decode_logs(receipt.get("logs", []))
    block = int(receipt["blockNumber"], 16)
    return {
        "tx_hash": tx_hash,
        "found": True,
        "status": "success" if int(receipt["status"], 16) == 1 else "reverted",
        "block_number": block,
        "timestamp": iso(from_timestamp(_block_ts(block))),
        "from": receipt["from"],
        "to": receipt.get("to"),
        "events": [{"contract": l["address"], "event": l.get("event"), "args": l.get("args", {})} for l in logs],
        "verified_at_block": chain.block_number(),
    }
