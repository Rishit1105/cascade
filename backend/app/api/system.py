from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from .. import __version__, bootstrap
from ..chain.client import ChainUnavailable
from ..clock import iso, utcnow
from ..db import get_db
from ..runtime import ACCOUNT_ROLES, CONTRACT_LABELS, runtime
from ..services import audit, notifications, policy, views
from ..services.analysis.llm import provider_status
from .deps import actor, require_ready
from .schemas import NotificationsReadIn, PolicyIn, ResetIn

router = APIRouter(prefix="/api")


@router.get("/health")
def health() -> dict[str, Any]:
    chain: dict[str, Any] = {"connected": False}
    try:
        if runtime.chain.is_connected():
            chain = {"connected": True, "chain_id": runtime.chain.chain_id, "block": runtime.chain.block_number(),
                     "client": runtime.chain.client_version()}
    except ChainUnavailable:
        pass
    return {"status": "ok", "version": __version__, "state": runtime.state, "chain": chain, "ai": provider_status(), "time": iso(utcnow())}


@router.get("/system/status")
def system_status(db: Session = Depends(get_db)) -> dict[str, Any]:
    d = runtime.deployment
    out: dict[str, Any] = {"state": runtime.state, "ai": provider_status(), "sentinel": runtime.sentinel.status if runtime.sentinel else {"running": False},
                           "demo": True, "data_label": "Fictional demo DAO on a local Hardhat chain. No real funds."}
    if d is not None:
        out["deployment"] = {
            "chain_id": d.chain_id, "genesis_hash": d.genesis_hash, "deployed_block": d.deployed_block,
            "review_window_blocks": d.review_window_blocks, "voting_delay_blocks": d.voting_delay_blocks,
            "voting_period_blocks": d.voting_period_blocks, "quorum_percent": d.quorum_percent,
            "contracts": [{"key": k, "address": v, "label": CONTRACT_LABELS.get(k, (k, ""))[0]} for k, v in d.contracts.items()],
            "accounts": [{"role": r, "address": d.a(r), "label": label, "kind": kind, "description": desc} for r, _, label, kind, desc in ACCOUNT_ROLES],
        }
        try:
            out["block_number"] = runtime.chain.block_number()
        except ChainUnavailable:
            out["block_number"] = None
    return out


@router.post("/system/reset", status_code=202)
def reset(body: ResetIn, who: str = Depends(actor)) -> dict[str, Any]:
    if runtime.deployment is not None:
        try:
            audit.record(event_type="demo_reset_requested", summary="Demo reset requested: the local chain and database will be rebuilt.",
                         actor=who, source="ui", status="warning")
        except Exception:
            pass
    started = bootstrap.start(reset_chain=True, reason="Resetting the demo: re-deploying contracts and re-seeding history")
    return {"started": started, "state": runtime.state}


@router.get("/settings", dependencies=[Depends(require_ready)])
def get_settings_(db: Session = Depends(get_db)) -> dict[str, Any]:
    from ..services.execution_checks import RULES

    return {"policy": policy.get_policy(db), "rules": {k: {"title": t, "default_severity": s} for k, (t, s) in RULES.items()}, "ai": provider_status()}


@router.put("/settings", dependencies=[Depends(require_ready)])
def put_settings(body: PolicyIn, db: Session = Depends(get_db), who: str = Depends(actor)) -> dict[str, Any]:
    from ..errors import ValidationFailed

    for k, v in body.priors.items():
        if k not in policy.DEFAULT_POLICY["risk_model"]["priors"] or not 0.001 <= v <= 0.95:
            raise ValidationFailed("invalid_prior", f"Prior {k} must be a known stage between 0.001 and 0.95.")
    for k, v in body.likelihood_ratios.items():
        if k not in policy.DEFAULT_POLICY["risk_model"]["likelihood_ratios"] or not 0.01 <= v <= 100:
            raise ValidationFailed("invalid_lr", f"Likelihood ratio {k} must be a known key between 0.01 and 100.")
    current = policy.get_policy(db)
    new = {
        "auto_halt_on_block_verdict": body.auto_halt_on_block_verdict,
        "severity_overrides": body.severity_overrides,
        "risk_model": {"priors": {**current["risk_model"]["priors"], **body.priors},
                       "likelihood_ratios": {**current["risk_model"]["likelihood_ratios"], **body.likelihood_ratios}},
    }
    saved = policy.save_policy(db, new)
    audit.record(event_type="policy_updated", summary=f"Review policy updated (autonomous halt {'on' if body.auto_halt_on_block_verdict else 'off'}).",
                 actor=who, source="ui", status="warning", details={"policy": new})
    return {"policy": saved}


@router.get("/notifications")
def get_notifications(db: Session = Depends(get_db)) -> dict[str, Any]:
    return notifications.list_notifications(db)


@router.post("/notifications/read")
def read_notifications(body: NotificationsReadIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    notifications.mark_read(db, body.ids)
    return notifications.list_notifications(db)


@router.get("/overview", dependencies=[Depends(require_ready)])
def overview(db: Session = Depends(get_db)) -> dict[str, Any]:
    return views.overview(db)


@router.get("/search", dependencies=[Depends(require_ready)])
def search(q: str = Query(min_length=1, max_length=120), db: Session = Depends(get_db)) -> dict[str, Any]:
    return {"results": views.search(db, q)}


@router.get("/chain/tx/{tx_hash}", dependencies=[Depends(require_ready)])
def tx(tx_hash: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    from ..errors import ValidationFailed
    import re

    if not re.fullmatch(r"0x[0-9a-fA-F]{64}", tx_hash):
        raise ValidationFailed("invalid_tx_hash", "Expected a 0x-prefixed 32-byte transaction hash.")
    return views.tx_detail(db, tx_hash)


@router.get("/chain/address/{address}", dependencies=[Depends(require_ready)])
def address(address: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    from ..errors import ValidationFailed
    from ..services.manifests import PayloadError, parse_address

    try:
        addr = parse_address(address, "address")
    except PayloadError as exc:
        raise ValidationFailed("invalid_address", str(exc)) from exc
    return views.address_detail(db, addr)
