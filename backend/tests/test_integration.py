"""End-to-end tests through the HTTP API against a dedicated Hardhat node.

A fresh node is started on DAOGUARD_TEST_RPC_PORT (default 8546) with the project's Hardhat
config, the app deploys and seeds it, and every adversarial case from the brief is exercised.
Tests run in file order and share state, like a demo session.
"""

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
from sqlalchemy import select, update

from conftest import TEST_RPC_PORT

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"
RPC = f"http://127.0.0.1:{TEST_RPC_PORT}"


def _rpc_up() -> bool:
    try:
        return httpx.post(RPC, json={"jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []}, timeout=2).status_code == 200
    except httpx.HTTPError:
        return False


@pytest.fixture(scope="module")
def node():
    if _rpc_up():
        yield None  # reuse an already running test node
        return
    npx = shutil.which("npx.cmd" if sys.platform == "win32" else "npx")
    if not npx or not (CONTRACTS / "node_modules").exists():
        pytest.skip("Hardhat is not installed (run npm install in contracts/)")
    proc = subprocess.Popen(
        [npx, "hardhat", "node", "--hostname", "127.0.0.1", "--port", str(TEST_RPC_PORT)],
        cwd=CONTRACTS, env={**os.environ, "DAOGUARD_NODE": "1"}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + 90
    while not _rpc_up():
        if time.time() > deadline:
            proc.kill()
            pytest.fail("test Hardhat node did not start")
        time.sleep(0.5)
    yield proc
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
    else:
        proc.terminate()


@pytest.fixture(scope="module")
def client(node):
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        deadline = time.time() + 180
        while True:
            state = c.get("/api/health").json()["state"]
            if state["phase"] == "ready":
                break
            if state["phase"] == "error":
                pytest.fail(f"bootstrap failed: {state['error']}")
            if time.time() > deadline:
                pytest.fail(f"bootstrap timed out in phase {state['phase']}")
            time.sleep(0.5)
        yield c


def ok(r: httpx.Response, status: int = 200):
    assert r.status_code == status, r.text
    return r.json()


def treasury_balance():
    from app.services.treasury import treasury_balance as tb

    return tb()


def execute(client, pid, scenario):
    return ok(client.post(f"/api/proposals/{pid}/demo-execution", json={"scenario": scenario}), 201)["attempt"]


# ------------------------------------------------------------------ seeded state
def test_seeded_demo(client):
    items = {p["id"]: p for p in ok(client.get("/api/proposals"))["items"]}
    assert {k: v["status"] for k, v in items.items()} == {"GOV-041": "executed", "GOV-042": "approved", "GOV-043": "voting", "GOV-044": "draft"}
    assert items["GOV-042"]["guard_status"] == "approved"


def test_manifest_digest_parity_with_contract(client):
    from app.runtime import runtime
    from app.services.manifests import manifest_actions, manifest_digest

    m = ok(client.get("/api/proposals/GOV-042/manifest"))["manifest"]
    guard = runtime.chain.contract("ExecutionGuard", m["guard"])
    onchain = guard.functions.hashManifest(bytes.fromhex(m["proposal_key"][2:]), m["version"], [a.as_tuple() for a in manifest_actions(m)]).call()
    assert "0x" + onchain.hex() == m["manifest_hash"] == manifest_digest(m["chain_id"], m["guard"], m["proposal_key"], m["version"], manifest_actions(m))


def test_treasury_impact_math(client):
    t = ok(client.get("/api/proposals/GOV-042/treasury"))
    assert t["balance_base"] == str(2_500_000 * 10**6)
    assert t["share_of_treasury_pct"] == "20.00"
    assert t["remaining_balance_base"] == str(2_000_000 * 10**6)
    plus10 = next(s for s in t["scenarios"] if s["overrun_pct"] == 10)
    assert plus10["amount_base"] == str(550_000 * 10**6)


# ------------------------------------------------------------------ adversarial execution
@pytest.mark.parametrize(
    "scenario,revert",
    [
        ("tampered_recipient", "ManifestMismatch"),
        ("changed_amount", "ManifestMismatch"),
        ("extra_allowance", "ManifestMismatch"),
        ("missing_action", "EmptyManifest"),
        ("stale_version", "StaleVersion"),
        ("wrong_guard", "NotApproved"),
    ],
)
def test_tampered_payloads_are_rejected_on_chain(client, scenario, revert):
    from app.runtime import runtime

    before = treasury_balance()
    attempt = execute(client, "GOV-042", scenario)
    assert attempt["outcome"] == "rejected" and attempt["revert"]["name"] == revert
    receipt = runtime.chain.get_receipt(attempt["tx_hash"])
    assert int(receipt["status"], 16) == 0  # mined and reverted on-chain
    assert treasury_balance() == before
    assert attempt["balance_changes"] == []


def test_wrong_chain_payload_is_not_sent(client):
    attempt = execute(client, "GOV-042", "wrong_chain")
    assert attempt["outcome"] == "not_sent" and attempt["tx_hash"] is None


def test_unauthorized_caller_is_rejected(client):
    from app.chain.client import TxReverted
    from app.runtime import runtime
    from app.services.manifests import manifest_actions

    d = runtime.deployment
    m = ok(client.get("/api/proposals/GOV-042/manifest"))["manifest"]
    guard = runtime.chain.contract("ExecutionGuard", d.c("guard"))
    with pytest.raises(TxReverted) as err:
        runtime.chain.transact(guard, "execute", [bytes.fromhex(m["proposal_key"][2:]), m["version"], [a.as_tuple() for a in manifest_actions(m)]], d.a("community"))
    assert err.value.revert["name"] == "AccessControlUnauthorizedAccount"


def test_approved_payload_executes_once(client):
    before = treasury_balance()
    attempt = execute(client, "GOV-042", "safe")
    assert attempt["outcome"] == "executed"
    assert before - treasury_balance() == 500_000 * 10**6
    assert any(c["holder_label"] and "Wallet A" in c["holder_label"] for c in attempt["balance_changes"])
    replay = execute(client, "GOV-042", "safe")
    assert replay["outcome"] == "rejected" and replay["revert"]["name"] == "AlreadyExecuted"


def test_advisory_check_explains_mismatch(client):
    check = ok(client.post("/api/proposals/GOV-042/execution-checks", json={"scenario": "tampered_recipient"}), 201)
    assert check["status"] == "MISMATCH"
    assert [d["rule_id"] for d in check["discrepancies"]] == ["DG-R000", "DG-R009"]


# ------------------------------------------------------------------ contested upgrade
def test_simulation_catches_obfuscated_upgrade(client):
    sim = ok(client.post("/api/proposals/GOV-043/simulations", json={}), 201)
    assert sim["verdict"] == "block"
    violated = {a["kind"] for a in sim["report"]["intent"]["assertions"] if a["status"] == "violated"}
    assert {"FUNCTION_MOVES_NO_FUNDS", "CUSTODY_UNCHANGED", "NO_FUNCTIONAL_CHANGE"} <= violated
    caps = sim["report"]["upgrades"][0]["new_capabilities"]
    assert caps and caps[0]["function"] == "syncAccounting()" and caps[0]["outflows"]


def test_reviewed_implementation_passes(client):
    sim = ok(client.post("/api/proposals/GOV-043/simulations", json={"scenario": "reviewed_implementation"}), 201)
    assert sim["verdict"] == "pass"


def test_simulation_leaves_chain_untouched(client):
    from app.runtime import runtime

    d = runtime.deployment
    impl = runtime.chain.get_storage(d.c("fee_vault"), "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc")
    assert impl.lower().endswith(d.c("fee_vault_v1")[2:].lower())


def test_sentinel_halts_approved_backdoor_and_guard_enforces(client):
    result = ok(client.post("/api/proposals/GOV-043/governance/finalize"))
    assert result["approved"] is True
    deadline = time.time() + 30
    while ok(client.get("/api/proposals/GOV-043/governance"))["guard"]["status"] != "halted":
        assert time.time() < deadline, "sentinel did not halt in time"
        time.sleep(0.5)
    ok(client.post("/api/proposals/GOV-043/governance/advance", json={"blocks": 6}))
    attempt = execute(client, "GOV-043", "safe")
    assert attempt["outcome"] == "rejected" and attempt["revert"]["name"] == "ProposalIsHalted"
    events = [e["event_type"] for e in ok(client.get("/api/proposals/GOV-043/audit-events"))["items"]]
    assert {"proposal_halted", "simulation_completed", "execution_rejected"} <= set(events)


# ------------------------------------------------------------------ analysis integrity
def test_prompt_injection_does_not_override_rules(client):
    brief = ok(client.post("/api/proposals/GOV-044/analyze"))["brief"]
    rule_ids = {m["rule_id"] for m in brief["missing_information"]}
    assert {"MI-R001", "MI-R002", "MI-R005"} <= rule_ids
    assert brief["injection_flags"], "injection attempt should be reported"


def test_relationship_findings_never_claim_ownership(client):
    coi = ok(client.get("/api/proposals/GOV-042/conflicts"))
    assert coi["findings"]
    for f in coi["findings"]:
        assert f["confidence"] in ("verified", "heuristic")
    direct = next(f for f in coi["findings"] if f["rule_id"] == "COI-R001")
    assert "does not show common ownership" in direct["explanation"]
    graph = ok(client.get("/api/graph"))
    assert all(e["evidence_level"] == "unverified_lead" for e in graph["edges"] if e["type"] == "manual_annotation")


def test_commit_requires_disclosure_and_input_is_validated(client):
    r = client.post("/api/proposals/GOV-044/versions/commit", json={})
    assert r.status_code == 409 and r.json()["error"]["code"] == "disclosure_required"
    bad = client.post("/api/proposals/GOV-042/execution-checks", json={"payload": {"chain_id": 31337, "guard": "0x123", "proposal_key": "0x" + "00" * 32, "version": 1, "actions": []}})
    assert bad.status_code == 422 and "$.guard" in bad.json()["error"]["message"]


# ------------------------------------------------------------------ full lifecycle
def test_full_lifecycle_new_version_vote_and_execution(client):
    p = ok(client.get("/api/proposals/GOV-044"))
    ok(client.put("/api/proposals/GOV-044/disclosure", json={"no_conflicts": False, "relationships": [{"party": "Events WG", "address": p["recipient_address"], "relationship": "proposer is a signer"}]}))
    ok(client.patch("/api/proposals/GOV-044", json={"milestones": [{"title": "Lisbon meetup", "month": 1, "amount_base": str(45_000 * 10**6)}]}))
    v = ok(client.post("/api/proposals/GOV-044/versions/commit", json={"change_note": "test"}), 201)
    assert v["version"] == 1 and v["tx_hash"]
    assert ok(client.post("/api/proposals/GOV-044/versions/1/verify"))["ok"] is True
    ok(client.post("/api/proposals/GOV-044/governance/propose"))
    cast = ok(client.post("/api/proposals/GOV-044/governance/simulate-votes?outcome=pass"))
    assert cast["state"]["state"] == "Active"
    ok(client.post("/api/proposals/GOV-044/governance/advance", json={"blocks": cast["state"]["blocks_remaining"] + 1}))
    assert ok(client.post("/api/proposals/GOV-044/governance/finalize"))["approved"] is True
    early = execute(client, "GOV-044", "safe")
    assert early["outcome"] == "rejected" and early["revert"]["name"] == "ReviewWindowActive"
    deadline = time.time() + 30
    while not any(s["trigger"] == "sentinel" for s in ok(client.get("/api/proposals/GOV-044/simulations"))["items"]):
        assert time.time() < deadline, "sentinel never reviewed the approval"
        time.sleep(0.5)
    sentinel = next(s for s in ok(client.get("/api/proposals/GOV-044/simulations"))["items"] if s["trigger"] == "sentinel")
    assert sentinel["verdict"] == "pass"  # an honest transfer must not be halted
    ok(client.post("/api/proposals/GOV-044/governance/advance", json={"blocks": 6}))
    attempt = execute(client, "GOV-044", "safe")
    assert attempt["outcome"] == "executed"
    m = ok(client.patch("/api/proposals/GOV-044/milestones/0", json={"status": "completed", "evidence": attempt["tx_hash"]}))
    assert m["verification"] == "chain-verified transaction"


def test_reports_export_all_formats(client):
    for fmt, magic in (("pdf", b"%PDF"), ("json", b"{"), ("csv", b"section")):
        rep = ok(client.post("/api/reports", json={"proposal_id": "GOV-042", "format": fmt, "sections": []}), 201)
        body = client.get(f"/api/reports/{rep['id']}/download").content
        assert body.startswith(magic)


# ------------------------------------------------------------------ tamper evidence (runs last)
def test_ledger_and_evidence_tampering_is_detected(client):
    from app.db import SessionLocal
    from app.models import AuditEvent, EvidenceDocument

    assert ok(client.post("/api/audit/verify"))["ok"] is True
    db = SessionLocal()
    try:
        doc = db.scalars(select(EvidenceDocument).where(EvidenceDocument.proposal_id == "GOV-042")).first()
        db.execute(update(EvidenceDocument).where(EvidenceDocument.id == doc.id).values(content_hash="sha256:" + "f" * 64))
        target = db.scalars(select(AuditEvent).order_by(AuditEvent.seq).offset(5).limit(1)).first()
        db.execute(update(AuditEvent).where(AuditEvent.seq == target.seq).values(summary="edited after the fact"))
        db.commit()
    finally:
        db.close()
    checks = {c["check"]: c["ok"] for c in ok(client.post("/api/proposals/GOV-042/versions/2/verify"))["checks"]}
    assert checks["Evidence files unchanged since commit"] is False
    ledger = ok(client.post("/api/audit/verify"))
    assert ledger["ok"] is False and ledger["breaks"][0]["seq"] == target.seq
