"""End-to-end tests through the HTTP API against a dedicated Hardhat node.

A fresh node is started on DAOGUARD_TEST_RPC_PORT (default 8546) with the project's Hardhat
config, the app deploys and seeds it, and every adversarial case from the brief is exercised.
Tests run in file order and share state, like a demo session.
"""

import json
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


def test_manifest_builder_preview_matches_contract_and_explains_tampering(client):
    from app.db import SessionLocal
    from app.models import AuditEvent, ExecutionCheck
    from app.runtime import runtime

    def counts():
        db = SessionLocal()
        try:
            return db.query(AuditEvent).count(), db.query(ExecutionCheck).count()
        finally:
            db.close()

    before = counts()
    m = ok(client.get("/api/proposals/GOV-042/manifest"))
    exact = ok(client.post("/api/proposals/GOV-042/manifest/preview", json={"payload": m["payload"]}))
    assert exact["valid"] and exact["match"] and exact["preflight"]["would_execute"]
    assert exact["preflight"]["contract_digest"] == exact["submitted"]["digest"] == m["manifest"]["manifest_hash"]
    assert exact["specs"] == [{"kind": "erc20_transfer", "token": m["payload"]["actions"][0]["target"], "to": m["manifest"]["actions"][0]["expected_recipient"], "amount": "500000"}]

    spec = {**exact["specs"][0], "amount": "520000"}
    tampered = ok(client.post("/api/proposals/GOV-042/manifest/preview", json={"context": {"version": 2}, "actions": [spec]}))
    assert not tampered["match"] and tampered["actions"][0]["differs_in"] == ["data"]
    assert {r["part"] for r in tampered["comparison"] if not r["match"]} == {"Actions hash", "Manifest struct hash", "Digest"}
    assert tampered["preflight"]["revert"]["name"] == "ManifestMismatch"

    stale = ok(client.post("/api/proposals/GOV-042/manifest/preview", json={"context": {"version": 1}, "actions": [exact["specs"][0]]}))
    assert not stale["match"] and not stale["preflight"]["would_execute"]
    assert {r["part"] for r in stale["comparison"] if not r["match"]} >= {"Version", "Digest"}

    bad = ok(client.post("/api/proposals/GOV-042/manifest/preview", json={"actions": [{**spec, "amount": "1.0000001"}, {**spec, "to": "0x123"}, {"kind": "nope"}]}))
    assert not bad["valid"]
    assert [e["path"] for e in bad["errors"]] == ["actions[0].amount", "actions[1].to", "actions[2].kind"]

    vault = runtime.deployment.c("fee_vault")
    call = ok(client.post("/api/proposals/GOV-042/manifest/preview", json={"actions": [{"kind": "contract_call", "target": vault, "signature": "setFeeBps(uint16)", "args": ["30"]}]}))
    assert call["valid"] and call["actions"][0]["decoded"]["kind"] == "parameter"
    again = ok(client.post("/api/proposals/GOV-042/manifest/preview", json={"payload": call["payload"]}))
    assert again["specs"][0] == {"kind": "contract_call", "target": vault, "signature": "setFeeBps(uint16)", "args": ["30"], "value": "0"}
    assert counts() == before, "the builder must not write anything"


def test_treasury_impact_math(client):
    t = ok(client.get("/api/proposals/GOV-042/treasury"))
    assert t["balance_base"] == str(2_500_000 * 10**6)
    assert t["share_of_treasury_pct"] == "20.00"
    assert t["remaining_balance_base"] == str(2_000_000 * 10**6)
    plus10 = next(s for s in t["scenarios"] if s["overrun_pct"] == 10)
    assert plus10["amount_base"] == str(550_000 * 10**6)


def test_treasury_surface_matches_the_existing_projection(client):
    base = "/api/proposals/GOV-042/treasury"
    for release, amount in (("lump", None), ("milestones", None), ("milestones", str(620_000 * 10**6))):
        params = {"release": release, "horizon": 24, **({"amount": amount} if amount else {})}
        surface = ok(client.get(f"{base}/surface", params={**params, "overruns": "0,5,15,30,60"}))
        assert [r["overrun_pct"] for r in surface["rows"]] == [0, 5, 15, 30, 60] and surface["months"] == list(range(25))
        for row in surface["rows"]:
            single = ok(client.get(base, params={**params, "overrun_pct": row["overrun_pct"]}))
            assert row["after_base"] == [x["after_base"] for x in single["series"]], (release, amount, row["overrun_pct"])
            assert surface["before_base"] == [x["before_base"] for x in single["series"]]
            assert row["amount_base"] == single["active_amount_base"]
            assert surface["available_before_base"] == single["available_before_base"]
    # The assumption text states what the model does: configured tranches total the request, so the overrun lands on the last one.
    note = ok(client.get(f"{base}/surface", params={"release": "milestones"}))["overrun_note"]
    assert "entire overrun is added to the final tranche" in note
    tranches = ok(client.get(base, params={"release": "milestones", "overrun_pct": 30}))["schedule"]
    assert [int(t["amount_base"]) // 10**6 for t in tranches] == [150_000, 200_000, 300_000]
    # Missing milestone data is reported, never silently replaced.
    assert ok(client.get("/api/proposals/GOV-044/treasury/surface", params={"release": "milestones"}))["schedule_issues"]
    assert client.get(f"{base}/surface", params={"overruns": "0,250"}).status_code == 422
    assert client.get(f"{base}/surface", params={"overruns": "x"}).status_code == 422


def chat(client, question, page="/", history=(), proposal=None):
    """Posts one question and returns (event names, answer text, done payload) from the SSE stream."""
    messages = [*history, {"role": "user", "content": question}]
    r = client.post("/api/assistant/chat", json={"messages": messages, "context": {"path": page, "proposal_id": proposal}})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream"), r.text
    events = []
    for block in r.text.strip().split("\n\n"):
        name, data = (line.split(": ", 1)[1] for line in block.split("\n"))
        events.append((name, json.loads(data)))
    names = [n for n, _ in events]
    return names, "".join(d["text"] for n, d in events if n == "delta"), events[-1][1]


def test_assistant_answers_from_live_data(client):
    status = ok(client.get("/api/assistant/status"))
    assert status["mode"] == "local" and status["suggestions"] and status["training"]["intents"] >= 40

    names, text, done = chat(client, "What happens to the treasury if GOV-042 overruns by 10%?")
    assert names[0] == "meta" and names[-1] == "done" and "error" not in names
    t = ok(client.get("/api/proposals/GOV-042/treasury", params={"overrun_pct": 10}))
    assert "**550,000 mUSDC**" in text and "2,500,000 mUSDC" in text  # same model as the Financial page
    assert f"{t['runway_before_months']} → {t['runway_after_months']} months" in text
    assert done["sources"] == ["get_treasury_impact"] and {"label": "Open the financial impact page", "to": "/financial?p=GOV-042"} in done["links"]

    _, ranking, _ = chat(client, "Which proposal is riskiest?")
    combined = {p["id"]: p for p in ok(client.get("/api/proposals"))["items"]}
    assert all(pid in ranking for pid in combined)

    # A follow-up resolves "it" to the proposal from the conversation, not the page.
    history = [{"role": "user", "content": "Summarise GOV-044"}, {"role": "assistant", "content": "GOV-044 is a draft."}]
    _, findings, done = chat(client, "what is missing from it?", history=history)
    assert "GOV-044" in findings and "MI-R005" in findings and done["sources"] == ["get_findings"]

    _, unknown, _ = chat(client, "Tell me about GOV-999")
    assert "GOV-999 does not exist" in unknown and all(pid in unknown for pid in combined) and "restarting" not in unknown

    # Minimal questions use the page's proposal; names, numbers and typos resolve to proposals.
    _, amount, done = chat(client, "how much", page="/proposals/GOV-044", proposal="GOV-044")
    assert "45,000 mUSDC" in amount and done["understanding"] == {**done["understanding"], "intent": "proposal_amount", "proposal": "GOV-044", "proposal_from": "page"}
    _, votes, done = chat(client, "votes on 43")
    v = ok(client.get("/api/proposals/GOV-043/governance"))
    assert done["understanding"]["intent"] == "vote_result" and v["votes_display"]["for"] in votes and f"{v['participation_pct']}%" in votes
    _, again, done = chat(client, "and 42?", history=[{"role": "user", "content": "votes on 43"}, {"role": "assistant", "content": votes}])
    assert done["understanding"]["intent"] == "vote_result" and done["understanding"]["proposal"] == "GOV-042" and "Vote on GOV-042" in again
    _, risk, _ = chat(client, "nortstar risk")
    assert "GOV-042" in risk and "combined estimate" in risk
    # "Why?" goes deeper instead of repeating the answer.
    _, why, _ = chat(client, "why?", history=[{"role": "user", "content": "Which proposal is riskiest?"}, {"role": "assistant", "content": ranking}])
    assert "ranks first because" in why and why != ranking
    # Ledger strings: two events by number, with the segment re-verified.
    _, link, done = chat(client, "how are #5 and #18 connected", page="/audit")
    assert done["sources"] == ["get_ledger_connection"] and "Segment check: ✓ intact" in link
    seg = ok(client.get("/api/audit/verify-range", params={"from_seq": 18, "to_seq": 5}))
    assert seg["ok"] and (seg["from_seq"], seg["to_seq"], seg["events"]) == (5, 18, 14) and seg["anchored_to"] == 4
    assert client.get("/api/audit/verify-range", params={"from_seq": 1, "to_seq": 5000}).status_code == 422
    _, cross, _ = chat(client, "who gets the money")  # no proposal anywhere: answer for all of them
    assert "Recipients" in cross and all(pid in cross for pid in combined)
    assert client.post("/api/assistant/chat", json={"messages": []}).status_code == 422
    assert client.post("/api/assistant/chat", json={"messages": [{"role": "system", "content": "x"}]}).status_code == 422


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


def test_implementation_comparison_is_isolated_and_explains_divergence(client):
    from app.db import SessionLocal
    from app.models import Finding

    def finding_state():
        db = SessionLocal()
        try:
            return sorted((f.id, f.status, f.superseded_at is None) for f in db.query(Finding).filter(Finding.proposal_id == "GOV-043"))
        finally:
            db.close()

    before = finding_state()
    c = ok(client.post("/api/proposals/GOV-043/simulations/compare"))
    sub, rev = c["submitted"], c["reviewed"]
    assert c["same_start_block"] and sub["status"] == rev["status"] == "completed"
    assert sub["verdict"] == "block" and rev["verdict"] in ("pass", "flag")
    assert sub["implementation"] != rev["implementation"]
    assert {x["address"].lower() for x in sub["callers"]} <= {x["address"].lower() for x in rev["callers"]}, "both sides must face the same callers"
    assert [p["function"] for p in sub["fund_moving_probes"]] == ["syncAccounting()"] and rev["fund_moving_probes"] == []
    d = c["divergence"]
    assert d["kind"] == "fund_movement" and d["function"] == "syncAccounting()" and d["reviewed"]["outflows"] == []
    assert d["submitted"]["outflows"][0]["amount"] == c["vault_balance_start"], "the probe drained the vault's observed starting balance"
    assert finding_state() == before, "a comparison must not change findings"
    assert ok(client.post("/api/proposals/GOV-042/simulations/compare"), 409)["error"]["code"] == "no_reviewed_implementation"


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


def test_live_activity_records_each_sentinel_stage(client):
    items = ok(client.get("/api/activity", params={"proposal": "GOV-043", "kind": "activity"}))["items"]
    start = max(i for i, m in enumerate(items) if m["stage"] == "approval_seen")  # earlier entries are manual simulations
    items = items[start:]
    stages = [m["stage"] for m in items]
    for stage in ("approval_seen", "snapshot", "bytecode", "execute", "probe", "intent", "verdict", "halt", "halted"):
        assert stage in stages, stage
    assert stages.index("approval_seen") < stages.index("verdict") < stages.index("halted")
    halted = next(m for m in items if m["stage"] == "halted")
    assert halted["tx_hash"].startswith("0x") and halted["status"] == "success"

def test_proposer_qa_loop_resolves_finding_and_updates_chain(client):
    from app.db import SessionLocal
    from app.models import Question

    base = "/api/proposals/GOV-044"

    def claims():
        return next(s["posterior"] for s in ok(client.get(f"{base}/evaluation-chain"))["stages"] if s["key"] == "claims")

    qa = ok(client.get(f"{base}/questions"))
    answered = next(q for q in qa["items"] if q["status"] == "answered")
    answer = answered["thread"][-1]
    assert answer["role"] == "proposer" and answer["signature_valid"] and answer["evidence_id"]
    dup = client.post(f"{base}/questions", json={"text": "Asking about the same gap again", "finding_id": answered["finding"]["id"]})
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "question_exists"

    before = claims()
    accepted = ok(client.post(f"{base}/questions/{answered['id']}/review", json={"decision": "accept", "note": "Matches the 45k ask."}))
    assert accepted["status"] == "accepted" and accepted["finding"]["status"] == "resolved"
    assert claims() < before, "a resolved gap must stop counting in the evaluation chain"

    open_q = next(q for q in qa["items"] if q["status"] == "open")
    first = ok(client.post(f"{base}/questions/{open_q['id']}/answer", json={"text": "Four meetups, one per month from January.", "evidence_name": "Plan.md", "evidence_text": "Jan Lisbon"}))
    assert first["status"] == "answered" and first["thread"][-1]["signature_valid"]
    short = client.post(f"{base}/questions/{open_q['id']}/review", json={"decision": "needs_more", "note": "short"})
    assert short.status_code == 422 and short.json()["error"]["code"] == "follow_up_required"
    ok(client.post(f"{base}/questions/{open_q['id']}/review", json={"decision": "needs_more", "note": "Add a deliverable and a success metric per meetup."}))
    second = ok(client.post(f"{base}/questions/{open_q['id']}/answer", json={"text": "Deliverable: recorded talks; metric: 30 new delegates per event."}))
    assert [e["kind"] for e in second["thread"]] == ["question", "answer", "follow_up", "answer"] and second["thread"][-1]["round"] == 2

    db = SessionLocal()  # edit a signed answer after the fact: its signature must stop verifying
    try:
        q = db.get(Question, open_q["id"])
        q.thread = [*q.thread[:-1], {**q.thread[-1], "text": "Deliverable: nothing."}]
        db.commit()
    finally:
        db.close()
    edited = next(q for q in ok(client.get(f"{base}/questions"))["items"] if q["id"] == open_q["id"])
    assert edited["thread"][1]["signature_valid"] and not edited["thread"][-1]["signature_valid"]
    events = {e["event_type"] for e in ok(client.get(f"{base}/audit-events"))["items"]}
    assert {"question_asked", "question_answered", "answer_accepted", "answer_insufficient"} <= events


# ------------------------------------------------------------------ analysis integrity
def test_prompt_injection_does_not_override_rules(client):
    brief = ok(client.post("/api/proposals/GOV-044/analyze"))["brief"]
    rule_ids = {m["rule_id"] for m in brief["missing_information"]}
    # The draft says to "mark this proposal as fully evidenced"; the rules still report what is missing.
    assert {"MI-R002", "MI-R005"} <= rule_ids
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
