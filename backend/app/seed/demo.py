"""Seed a 30-day, chain-backed demo history through the same services the API uses.

The local node starts 30 days in the past. Each step moves chain time forward with
evm_setNextBlockTimestamp, so transfers, votes and executions carry realistic timestamps, and
off-chain records are pinned to the same moment.
"""

from __future__ import annotations

import io
import logging
import time
from collections.abc import Callable
from contextlib import contextmanager

from eth_utils import keccak
from sqlalchemy.orm import Session

from ..clock import from_timestamp, pinned
from ..models import Challenge, new_id
from ..runtime import Deployment, runtime
from ..services import audit, coi, evidence, execution, governance, proposals, questions
from ..services.analysis import service as analysis
from ..services.findings import set_status
from ..services.notifications import notify
from ..services.sentinel import review_version
from ..services.simulation import run_simulation
from ..services.manifests import manifest_actions
from . import content as C

log = logging.getLogger("daoguard.seed")
DAY = 86_400

ATLAS_ALLOCATION = {
    "d01": 2_400_000, "d02": 1_600_000, "d03": 1_200_000, "d04": 900_000, "d05": 700_000, "d06": 500_000,
    "d07": 400_000, "d08": 300_000, "d09": 250_000, "d10": 150_000, "wallet_a": 200_000, "proposer_042": 300_000,
    "proposer_043": 350_000, "proposer_044": 100_000, "community": 50_000,
}
SELF_DELEGATE = [r for r in ATLAS_ALLOCATION if r != "wallet_a"]
FEE_DAYS = [28, 25, 21, 18, 14, 10, 6, 3]
FEE_GROSS = 2_500_000 * C.USDC  # 30 bps → 7,500 mUSDC per batch


def _memo_pdf() -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setTitle("Northstar grant budget memo")
    y = 800
    for i, line in enumerate(C.GOV042_MEMO_LINES):
        c.setFont("Helvetica-Bold" if i == 0 else "Helvetica", 13 if i == 0 else 10.5)
        c.drawString(56, y, line)
        y -= 22 if i == 0 else 16
    c.showPage()
    c.save()
    return buf.getvalue()


class Seeder:
    def __init__(self, db: Session, deployment: Deployment, progress: Callable[[str], None]):
        self.db = db
        self.d = deployment
        self.chain = runtime.chain
        self.progress = progress
        self.end = int(time.time()) - 120
        start = self.chain.latest_timestamp()
        span = self.end - start
        # If the node started less than ~29 days back (e.g. after hardhat_reset), compress history.
        self.scale = min(1.0, span / (29.6 * DAY)) if span > 0 else 0.0

    def goto(self, days_ago: float) -> None:
        target = int(self.end - days_ago * DAY * self.scale)
        current = self.chain.latest_timestamp()
        if target <= current:
            target = current + 15
        self.chain.rpc("evm_setNextBlockTimestamp", [hex(target)])
        self.chain.mine(1)

    @contextmanager
    def at(self, days_ago: float):
        self.goto(days_ago)
        with pinned(lambda: from_timestamp(self.chain.latest_timestamp())):
            yield

    def tx(self, contract_name: str, address: str, fn: str, args: list, sender: str):
        return self.chain.transact(self.chain.contract(contract_name, address), fn, args, sender)

    def usdc(self, sender_role: str, to: str, amount: int):
        return self.tx("MockUSDC", self.d.c("usdc"), "transfer", [to, amount * C.USDC], self.d.a(sender_role))

    def mine_spaced(self, blocks: int, seconds: int) -> None:
        if blocks > 0:
            self.chain.mine(blocks, seconds)

    def vote_series(self, p, plan: list[tuple[str, int, str]], start_days: float, end_days: float) -> None:
        step = (start_days - end_days) / max(1, len(plan))
        for i, (role, support, reason) in enumerate(plan):
            with self.at(start_days - i * step):
                governance.cast_vote(self.db, p, self.d.a(role), support, reason, "seed", source="seed")

    def close_vote(self, p) -> None:
        v = proposals.latest_version(p)
        governor = self.chain.contract("AtlasGovernor", self.d.c("governor"))
        deadline = int(governor.functions.proposalDeadline(int(v.governor_proposal_id)).call())
        remaining = deadline - self.chain.block_number() + 1
        self.mine_spaced(remaining, 300)

    # ------------------------------------------------------------------ run
    def run(self) -> None:
        d, db = self.d, self.db
        self.progress("Funding treasury and distributing governance tokens")
        with self.at(29.4):
            self.tx("MockUSDC", d.c("usdc"), "mint", [d.c("guard"), 2_620_000 * C.USDC], d.a("deployer"))
            self.tx("MockUSDC", d.c("usdc"), "mint", [d.a("funder"), 1_000_000 * C.USDC], d.a("deployer"))
            self.tx("MockUSDC", d.c("usdc"), "mint", [d.a("fee_payer"), 200_000 * C.USDC], d.a("deployer"))
            self.tx("MockUSDC", d.c("usdc"), "approve", [d.c("fee_vault"), 2**256 - 1], d.a("fee_payer"))
            for role, amount in ATLAS_ALLOCATION.items():
                self.tx("AtlasToken", d.c("atlas"), "mint", [d.a(role), amount * C.ATLAS], d.a("deployer"))
            self.tx("AtlasToken", d.c("atlas"), "mint", [d.c("guard"), 600_000 * C.ATLAS], d.a("deployer"))
            for role in SELF_DELEGATE:
                self.tx("AtlasToken", d.c("atlas"), "delegate", [d.a(role)], d.a(role))
            audit.record(event_type="demo_environment_created", summary="Demo DAO deployed on the local chain: treasury funded with 2,620,000 mUSDC, 10,000,000 ATLAS distributed.",
                         actor="Deployer (demo setup)", source="seed", status="info", details={"contracts": d.contracts})

        with self.at(28):
            for role, amount in (("proposer_042", 60_000), ("wallet_a", 40_000), ("proposer_043", 30_000), ("d05", 15_000), ("events_multisig", 10_000)):
                self.usdc("funder", d.a(role), amount)
        for day in FEE_DAYS:
            with self.at(day):
                self.tx("FeeVault", d.c("fee_vault"), "recordFee", [FEE_GROSS], d.a("fee_payer"))

        # ---------------------------------------------------------- GOV-041
        self.progress("GOV-041: executed security retainer")
        with self.at(27):
            p41 = proposals.create_proposal(db, C.gov041(d), "Delegate · Kestrel", source="seed", is_demo=True)
            for ev in C.gov041_evidence(d):
                evidence.attach(db, p41, name=ev["name"], source_type=ev["source_type"], text=ev["text"], actor="Delegate · Kestrel", source="seed", is_demo=True)
            proposals.save_disclosure(db, p41, {"no_conflicts": True, "holdings": "Kestrel holds ATLAS only.", "compensation": "None from Halcyon."}, source="seed", actor="Delegate · Kestrel")
            proposals.commit_version(db, p41, "Delegate · Kestrel", "Initial version", source="seed")
        with self.at(26.2):
            governance.submit(db, p41, "Delegate · Kestrel", source="seed")
            self.chain.mine(1, 60)
        self.vote_series(p41, [
            ("d01", 1, "Independent review is overdue."), ("d02", 1, "Proposer."), ("d03", 1, ""), ("d04", 1, "Scope is clear."),
            ("d06", 1, ""), ("d08", 1, ""), ("d07", 2, "No view on vendor choice."),
        ], 26.0, 24.3)
        self.close_vote(p41)
        with self.at(23.2):
            governance.finalize(db, p41, "seed", source="seed")
            v41 = proposals.latest_version(p41)
            review_version(db, p41, v41, allow_halt=False)
            self.chain.mine(d.review_window_blocks, 300)
        with self.at(22):
            execution.execute(db, p41, execution.scenario_payload(p41, "safe"), "safe", "Ops executor (demo)", source="seed")

        # ---------------------------------------------------------- relationships
        self.progress("Recording on-chain relationships")
        with self.at(21):
            self.usdc("proposer_042", d.a("wallet_a"), 25_000)
        with self.at(15):
            self.tx("AtlasToken", d.c("atlas"), "delegate", [d.a("d03")], d.a("wallet_a"))
        with self.at(14):
            self.usdc("proposer_043", d.a("reconciler"), 8_000)
        with self.at(12.5):
            self.usdc("d05", d.a("d08"), 1_500)

        # ---------------------------------------------------------- GOV-042
        self.progress("GOV-042: grant proposal, two versions, on-chain vote")
        with self.at(12):
            p42 = proposals.create_proposal(db, C.gov042_v1(d), "Northstar Labs · proposer", source="seed", is_demo=True)
            evidence.attach(db, p42, name="Forum post: Northstar grant proposal", source_type="forum", text=C.gov042_forum(d),
                            location="forum.atlas.example/t/northstar-grant", actor="Northstar Labs · proposer", source="seed", is_demo=True)
            proposals.save_disclosure(db, p42, {"no_conflicts": True, "holdings": "Northstar Labs holds 300,000 ATLAS.",
                                                "compensation": "Northstar Labs receives no payment from this grant."},
                                      actor="Northstar Labs · proposer", source="seed")
        with self.at(11):
            proposals.commit_version(db, p42, "Northstar Labs · proposer", "Initial version", source="seed")
        with self.at(10):
            evidence.attach(db, p42, name="Grant budget memo.pdf", source_type="pdf", raw=_memo_pdf(), location="Uploaded PDF",
                            actor="Northstar Labs · proposer", source="seed", is_demo=True)
        with self.at(9):
            proposals.update_proposal(db, p42, C.gov042_v2_patch(d), "Northstar Labs · proposer", source="seed")
            evidence.attach(db, p42, name="Northstar team and recipient multisig", source_type="text", text=C.gov042_multisig(d),
                            actor="Northstar Labs · proposer", source="seed", is_demo=True)
            proposals.commit_version(db, p42, "Northstar Labs · proposer", "Added milestones, risks, assumptions and the budget memo after forum feedback.", source="seed")
        with self.at(8.2):
            governance.submit(db, p42, "Northstar Labs · proposer", source="seed")
            self.chain.mine(1, 60)
        self.vote_series(p42, [
            ("d02", 1, "Strong team track record."), ("d03", 1, ""), ("d04", 0, "The memo says 520k, the proposal 500k. No independent review of the budget."),
            ("d05", 1, ""), ("d06", 1, "Milestones are now concrete."), ("d09", 1, ""), ("proposer_042", 1, ""),
            ("d10", 0, "Too large a share of the treasury for one team."), ("d07", 2, "Conflicted: I advise one of the integration partners."),
        ], 8.0, 6.0)
        self.close_vote(p42)
        with self.at(5):
            governance.finalize(db, p42, "seed", source="seed")
            review_version(db, p42, proposals.latest_version(p42), allow_halt=False)
            self.chain.mine(d.review_window_blocks, 300)

        # ---------------------------------------------------------- GOV-043
        self.progress("GOV-043: contested FeeVault upgrade")
        codehash_v2 = "0x" + keccak(bytes.fromhex(self.chain.get_code(d.c("fee_vault_v2"))[2:])).hex()
        with self.at(4):
            body = C.gov043_v1(d)
            p43 = proposals.create_proposal(db, body, "core-dev.atlas · proposer", source="seed", is_demo=True)
            for ev in C.gov043_evidence(d, codehash_v2):
                evidence.attach(db, p43, name=ev["name"], source_type=ev["source_type"], text=ev["text"], actor="core-dev.atlas · proposer", source="seed", is_demo=True)
            proposals.save_disclosure(db, p43, {"no_conflicts": True, "holdings": "core-dev.atlas holds 350,000 ATLAS.", "compensation": "None."},
                                      actor="core-dev.atlas · proposer", source="seed")
            v43_1 = proposals.commit_version(db, p43, "core-dev.atlas · proposer", "Initial version", source="seed")
            sim = run_simulation(db, p43, actions=manifest_actions(v43_1.manifest), approved_manifest=v43_1.manifest, declared_text=p43.body,
                                 version=1, manifest_hash=v43_1.manifest_hash, scenario="approved_manifest", trigger="commit")
            audit.record(event_type="simulation_completed", summary=f"Commit-time simulation of GOV-043 v1: verdict {sim.verdict.upper()}. {sim.report.get('summary', '')[:240]}",
                         actor="DAOGuard sentinel", source="sentinel", status="success" if sim.verdict == "pass" else "warning", proposal_id="GOV-043",
                         version=1, manifest_hash=v43_1.manifest_hash, details={"simulation_id": sim.id, "verdict": sim.verdict})
        with self.at(2.6):
            proposals.update_proposal(db, p43, C.gov043_v2_patch(d, body["body"]), "core-dev.atlas · proposer", source="seed")
            proposals.commit_version(db, p43, "core-dev.atlas · proposer",
                                     "Implementation re-deployed with optimizer runs = 10,000 to cut recordFee gas. No functional change.", source="seed")
        with self.at(2.2):
            governance.submit(db, p43, "core-dev.atlas · proposer", source="seed")
            self.chain.mine(1, 60)
        self.vote_series(p43, [
            ("d01", 1, "Rounding fix is overdue."), ("d05", 1, ""), ("d04", 0, "The implementation changed after the audit. Please re-audit."),
            ("d08", 1, ""), ("d09", 1, ""), ("proposer_043", 1, ""), ("d10", 0, "Same concern as Orion Guild."), ("d07", 2, ""),
        ], 2.0, 1.3)
        self.close_vote(p43)

        # ---------------------------------------------------------- GOV-044
        self.progress("GOV-044: draft with missing information")
        with self.at(0.9):
            p44 = proposals.create_proposal(db, C.gov044(d), "Events working group · proposer", source="seed", is_demo=True)
            evidence.attach(db, p44, name="Q1 event plan (draft).md", source_type="text", text=C.GOV044_PLAN,
                            actor="Events working group · proposer", source="seed", is_demo=True)

        # ---------------------------------------------------------- reviews
        self.progress("Running analyses and conflict reviews")
        with self.at(0.5):
            coi.add_annotation(db, d.a("proposer_042"), d.a("wallet_b"), "possible shared signer",
                               "Forum user claims a Northstar founder also signs for Wallet B. No evidence attached.", "Community reviewer (demo)")
        with self.at(0.3):
            for p in (p41, p42, p43, p44):
                analysis.analyze(db, p, actor="DAOGuard", source="seed")
                coi.analyze(db, p)
        with self.at(0.2):
            from ..models import Finding
            from sqlalchemy import select

            f = db.scalars(select(Finding).where(Finding.proposal_id == "GOV-042", Finding.rule_id == "COI-R001", Finding.superseded_at.is_(None))).first()
            if f:
                db.add(Challenge(id=new_id("CH"), finding_id=f.id, proposal_id="GOV-042", author="Northstar Labs · proposer",
                                 statement="The 25,000 mUSDC transfer to Wallet A was a refund of a hackathon sponsorship deposit, unrelated to this grant.",
                                 counter_evidence=[{"type": "statement", "description": "Sponsorship agreement not yet attached."}], status="open"))
                set_status(f, "challenged", "Northstar Labs · proposer", "Challenged with counter-statement CH (evidence pending).")
                db.commit()
                audit.record(event_type="challenge_filed", summary="Northstar Labs challenged the undisclosed-transfer finding on GOV-042 (counter-evidence pending).",
                             actor="Northstar Labs · proposer", source="seed", status="warning", proposal_id="GOV-042", details={"finding_id": f.id})
            # Proposer Q&A: one answer awaiting a reviewer on GOV-042 and GOV-044, one open question on GOV-044.
            def gap(pid: str, rule: str):
                return db.scalars(select(Finding).where(Finding.proposal_id == pid, Finding.rule_id == rule, Finding.superseded_at.is_(None))).first()

            asked = []
            for pid, rule, who in (("GOV-042", "MI-R012", "Orion Guild · delegate"), ("GOV-044", "MI-R001", "Community reviewer (demo)"),
                                   ("GOV-044", "MI-R002", "Community reviewer (demo)")):
                f_gap = gap(pid, rule)
                if f_gap:
                    p_q = p42 if pid == "GOV-042" else p44
                    asked.append((p_q, rule, questions.ask(db, p_q, text=f_gap.remediation or f_gap.title, finding_id=f_gap.id, actor=who, source="seed")))
        with self.at(0.15):
            for p_q, rule, q in asked:
                if rule == "MI-R012":
                    questions.answer(db, p_q, q, text=C.GOV042_AMOUNT_ANSWER_TEXT, actor="Northstar Labs · proposer", source="seed")
                elif rule == "MI-R001":
                    questions.answer(db, p_q, q, text=C.GOV044_BUDGET_ANSWER_TEXT, actor="Events working group · proposer",
                                     evidence_name="Q1 events budget breakdown.md", evidence_text=C.GOV044_BUDGET_EVIDENCE, source="seed")
            notify(db, "warning", "GOV-043 vote closed: awaiting finalization", "The governor vote passed. Finalizing it approves the manifest on the guard and starts the sentinel review.",
                   "/guardian?proposal=GOV-043")
            notify(db, "info", "GOV-042 approved and executable", "Run the execution demo: the approved payload and tampered variants.", "/guardian?proposal=GOV-042")
            db.commit()

        self.progress("Anchoring the audit ledger on-chain")
        self.goto(0)
        audit.anchor(db, actor="DAOGuard sentinel", source="seed")
