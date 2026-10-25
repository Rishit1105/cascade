"""Runtime-tunable policy: severities per rule, autonomous halt, and the risk-chain model.

Defaults live here; overrides are stored in the kv table and edited from Settings. Every value
is visible to reviewers so that no score is opaque.
"""

from __future__ import annotations

import copy
from typing import Any

from sqlalchemy.orm import Session

from ..models import KeyValue

DEFAULT_POLICY: dict[str, Any] = {
    "auto_halt_on_block_verdict": True,
    "severity_overrides": {},
    "risk_model": {
        "description": (
            "Each stage starts from a prior probability that a material issue exists. Every finding "
            "multiplies the prior odds by a likelihood ratio (LR > 1 raises concern, LR < 1 lowers it). "
            "Stages are combined assuming independence. This is a transparent model estimate, not a "
            "probability of fraud and not a fact."
        ),
        "priors": {"claims": 0.15, "conflict": 0.10, "vote": 0.05, "execution": 0.05},
        "likelihood_ratios": {
            "missing_info.high": 2.2,
            "missing_info.medium": 1.5,
            "missing_info.low": 1.15,
            "claims.contradiction": 3.0,
            "claims.well_evidenced": 0.6,
            "claims.injection_detected": 1.4,
            "conflict.undisclosed_transfer": 3.0,
            "conflict.shared_funder": 1.4,
            "conflict.recipient_voting_power": 1.8,
            "conflict.embedded_address_link": 4.0,
            "conflict.signed_disclosure": 0.8,
            "conflict.missing_disclosure": 2.0,
            "vote.thin_margin": 1.3,
            "vote.high_concentration": 1.3,
            "vote.quorum_failed": 2.0,
            "vote.passed_clearly": 0.8,
            "execution.manifest_match": 0.25,
            "execution.manifest_mismatch": 20.0,
            "execution.simulation_block": 25.0,
            "execution.simulation_flag": 2.5,
            "execution.simulation_pass": 0.4,
            "execution.payload_changed_after_review": 3.0,
            "execution.halted": 1.0,
        },
    },
}


def get_policy(db: Session) -> dict[str, Any]:
    row = db.get(KeyValue, "policy")
    policy = copy.deepcopy(DEFAULT_POLICY)
    if row and isinstance(row.value, dict):
        stored = row.value
        policy["auto_halt_on_block_verdict"] = bool(stored.get("auto_halt_on_block_verdict", policy["auto_halt_on_block_verdict"]))
        policy["severity_overrides"].update(stored.get("severity_overrides", {}))
        rm = stored.get("risk_model", {})
        policy["risk_model"]["priors"].update(rm.get("priors", {}))
        policy["risk_model"]["likelihood_ratios"].update(rm.get("likelihood_ratios", {}))
    return policy


def save_policy(db: Session, policy: dict[str, Any]) -> dict[str, Any]:
    row = db.get(KeyValue, "policy")
    if row:
        row.value = policy
    else:
        db.add(KeyValue(key="policy", value=policy))
    db.commit()
    return get_policy(db)


def severity_for(db: Session | None, rule_id: str, default: str) -> str:
    if db is None:
        return default
    return get_policy(db)["severity_overrides"].get(rule_id, default)
