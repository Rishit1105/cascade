"""DAOGuard sentinel: watches the chain and reviews every approved manifest before it can run.

On each ManifestApproved event it simulates the exact approved payload against the proposal's
declared intent. A BLOCK verdict (contradicted intent, unapproved fund movement, new
non-governance capabilities) triggers an on-chain guardian halt when policy allows; FLAG raises
an alert for humans. The guardian role can only block; it cannot approve or execute anything.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from eth_utils import keccak
from sqlalchemy import select

from ..clock import iso, utcnow
from ..db import SessionLocal
from ..models import KeyValue, Proposal, ProposalVersion
from ..runtime import runtime
from . import audit
from .alerts import raise_alert
from .canonical import content_hash
from .findings import sync_findings
from .manifests import manifest_actions
from .notifications import notify
from .policy import get_policy

log = logging.getLogger("daoguard.sentinel")
MANIFEST_APPROVED_TOPIC = "0x" + keccak(text="ManifestApproved(bytes32,uint64,bytes32,uint64)").hex()


def declared_text(p: Proposal, v: ProposalVersion) -> str:
    return "\n\n".join(filter(None, [p.body, v.snapshot.get("body") if v.snapshot.get("body") != p.body else None, v.change_note]))


def simulation_findings(sim_report: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "rule_id": f["rule_id"],
            "severity": f["severity"],
            "confidence": "verified",
            "title": f["title"],
            "explanation": f["explanation"],
            "remediation": "Do not execute until the proposer explains the observed behaviour and a corrected version is reviewed.",
            "evidence_refs": [{"type": "simulation", "evidence": f.get("evidence")}],
            "data": {"evidence": f.get("evidence")},
            "key": f"{f['rule_id']}:{f['title']}",
        }
        for f in sim_report.get("findings", [])
    ]


def review_version(db, p: Proposal, v: ProposalVersion, trigger: str = "sentinel", allow_halt: bool = True) -> dict[str, Any]:
    from .execution import halt
    from .simulation import run_simulation

    audit.record(event_type="sentinel_review_started", summary=f"Sentinel simulating {p.id} v{v.version} approved manifest against its declared intent.",
                 actor="DAOGuard sentinel", source="sentinel", status="info", proposal_id=p.id, version=v.version, manifest_hash=v.manifest_hash)
    sim = run_simulation(db, p, actions=manifest_actions(v.manifest), approved_manifest=v.manifest, declared_text=declared_text(p, v),
                         version=v.version, manifest_hash=v.manifest_hash, scenario="approved_manifest", trigger=trigger)
    report = sim.report or {}
    sync_findings(db, p.id, "simulation", simulation_findings(report), source_ref=sim.id)
    db.commit()
    audit.record(
        event_type="simulation_completed",
        summary=f"Simulation of {p.id} v{v.version}: verdict {sim.verdict.upper()}. {report.get('summary', report.get('error', ''))[:300]}",
        actor="DAOGuard sentinel", source="sentinel",
        status={"pass": "success", "flag": "warning", "block": "failure"}.get(sim.verdict, "warning"),
        proposal_id=p.id, version=v.version, manifest_hash=v.manifest_hash,
        details={"simulation_id": sim.id, "verdict": sim.verdict, "rules": [f["rule_id"] for f in report.get("findings", [])], "chain_block": sim.chain_block},
    )
    outcome: dict[str, Any] = {"simulation_id": sim.id, "verdict": sim.verdict, "halted": False}
    if sim.verdict == "block":
        policy = get_policy(db)
        alert = raise_alert(db, proposal_id=p.id, source="simulation", severity="critical",
                            title=f"Simulation contradicts approved intent for {p.id} v{v.version}",
                            description=report.get("summary", "Simulation produced a BLOCK verdict."),
                            data={"simulation_id": sim.id})
        db.commit()
        if allow_halt and policy["auto_halt_on_block_verdict"]:
            try:
                result = halt(db, p, f"Sentinel simulation {sim.id}: " + "; ".join(f["title"] for f in report.get("findings", [])[:3]),
                              "DAOGuard sentinel", source="sentinel",
                              reason_data={"simulation_id": sim.id, "report_hash": content_hash({"findings": report.get("findings", [])})})
                outcome.update(halted=True, halt_tx=result["tx_hash"])
                from .alerts import record_action

                record_action(db, alert, "halted", "DAOGuard sentinel", "Autonomous on-chain halt within the review window.", result)
            except Exception as exc:  # e.g. already executed: report loudly, never pretend it was halted
                log.error("auto-halt failed for %s: %s", p.id, exc)
                audit.record(event_type="auto_halt_failed", summary=f"Sentinel could NOT halt {p.id}: {exc}", actor="DAOGuard sentinel",
                             source="sentinel", status="failure", proposal_id=p.id, version=v.version)
                notify(db, "critical", f"Sentinel could not halt {p.id}", str(exc)[:300], f"/guardian?proposal={p.id}")
                db.commit()
        else:
            notify(db, "critical", f"{p.id} needs a human decision", "Simulation produced a BLOCK verdict; autonomous halt is disabled by policy.", f"/escalation?proposal={p.id}")
            db.commit()
    elif sim.verdict == "flag":
        raise_alert(db, proposal_id=p.id, source="simulation", severity="high", title=f"Simulation flagged {p.id} v{v.version} for review",
                    description=report.get("summary", ""), data={"simulation_id": sim.id})
        notify(db, "warning", f"Sentinel flagged {p.id}", report.get("summary", "")[:300], f"/guardian?proposal={p.id}")
        db.commit()
    elif sim.verdict == "pass":
        notify(db, "success", f"Sentinel review passed for {p.id} v{v.version}", "No deviation from the declared intent was observed.", f"/guardian?proposal={p.id}")
        db.commit()
    return outcome


class Sentinel:
    def __init__(self, poll_seconds: float):
        self.poll_seconds = poll_seconds
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self.status: dict[str, Any] = {"running": False, "last_tick": None, "last_block": None, "reviews": 0, "last_error": None}

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="daoguard-sentinel", daemon=True)
        self._thread.start()
        self.status["running"] = True

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=15)
        self.status["running"] = False

    def wake(self) -> None:
        self._wake.set()

    def signal_stop(self) -> None:
        """Non-blocking stop, safe to call from the sentinel thread itself."""
        self._stop.set()
        self._wake.set()
        self.status["running"] = False

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
                self.status["last_error"] = None
            except Exception as exc:
                log.exception("sentinel tick failed")
                self.status["last_error"] = f"{type(exc).__name__}: {exc}"
            self._wake.wait(self.poll_seconds)
            self._wake.clear()

    def tick(self) -> None:
        deployment = runtime.deployment
        if deployment is None:
            return
        chain = runtime.chain
        if chain.genesis_hash() != deployment.genesis_hash:
            log.warning("chain genesis changed: the node was restarted; scheduling a re-bootstrap")
            from ..bootstrap import request_rebootstrap

            request_rebootstrap("The local chain restarted, so the demo is being re-deployed and re-seeded.")
            return
        db = SessionLocal()
        try:
            row = db.get(KeyValue, "sentinel_cursor")
            cursor = int(row.value) if row else deployment.deployed_block
            latest = chain.block_number()
            self.status.update(last_tick=iso(utcnow()), last_block=latest)
            if latest <= cursor:
                return
            logs = chain.get_logs(deployment.c("guard"), [MANIFEST_APPROVED_TOPIC], cursor + 1, latest)
            for log_ in logs:
                self._handle_approval(db, log_)
            if row:
                row.value = latest
            else:
                db.add(KeyValue(key="sentinel_cursor", value=latest))
            db.commit()
        finally:
            db.close()

    def _handle_approval(self, db, log_: dict[str, Any]) -> None:
        key = log_["args"]["proposalKey"]
        manifest_hash = log_["args"]["manifestHash"]
        p = db.scalars(select(Proposal).where(Proposal.key == key)).first()
        v = db.scalars(select(ProposalVersion).where(ProposalVersion.manifest_hash == manifest_hash)).first()
        if p is None or v is None:
            raise_alert(db, proposal_id=p.id if p else None, source="sentinel", severity="critical",
                        title="Governance approved a manifest DAOGuard has never seen",
                        description=f"ManifestApproved for key {key[:12]}… with digest {manifest_hash[:12]}… has no committed version, so its contents cannot be reviewed.",
                        data={"tx_hash": log_["tx_hash"], "block_number": log_["block_number"]})
            db.commit()
            return
        self.status["reviews"] += 1
        review_version(db, p, v)


def mark_cursor_at_head(db) -> None:
    latest = runtime.chain.block_number()
    row = db.get(KeyValue, "sentinel_cursor")
    if row:
        row.value = latest
    else:
        db.add(KeyValue(key="sentinel_cursor", value=latest))
    db.commit()
