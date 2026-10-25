"""Deterministic treasury impact model.

All amounts are integer base units (mUSDC has 6 decimals); percentages use Decimal with
banker's rounding. The treasury balance is read live from the chain. Burn and commitments are
explicit, editable inputs; fee inflows are derived from FeeVault events. Nothing is projected
that is not an input: no yield, volatility or ROI.
"""

from __future__ import annotations

from decimal import ROUND_HALF_EVEN, ROUND_HALF_UP, Decimal
from typing import Any

from eth_utils import keccak
from sqlalchemy.orm import Session

from ..clock import from_timestamp, iso, utcnow
from ..errors import ValidationFailed
from ..models import KeyValue, Proposal
from ..runtime import runtime
from .labels import format_units
from .manifests import PayloadError, parse_uint

DECIMALS = 6
GUARD_STATUS = {0: "none", 1: "approved", 2: "executed", 3: "halted"}
FEE_RECORDED_TOPIC = "0x" + keccak(text="FeeRecorded(address,uint256,uint256)").hex()

DEFAULT_INPUTS: dict[str, Any] = {
    "burn_items": [
        {"label": "Core contributor payroll", "monthly_base": "140000000000"},
        {"label": "Infrastructure & tooling", "monthly_base": "18000000000"},
    ],
    "other_commitments": [
        {"label": "Q4 security retainer (budgeted, not yet on-chain)", "amount_base": "60000000000"},
    ],
    "source": "Demo inputs entered by the treasury team (fictional). Editable on the Financial impact page.",
}


def treasury_balance() -> int | None:
    deployment = runtime.deployment
    if deployment is None or not runtime.chain.is_connected():
        return None
    usdc = runtime.chain.contract("MockUSDC", deployment.c("usdc"))
    return int(usdc.functions.balanceOf(deployment.c("guard")).call())


def get_inputs(db: Session) -> dict[str, Any]:
    row = db.get(KeyValue, "treasury_inputs")
    return row.value if row else DEFAULT_INPUTS


def save_inputs(db: Session, inputs: dict[str, Any]) -> dict[str, Any]:
    clean: dict[str, Any] = {"burn_items": [], "other_commitments": [], "source": str(inputs.get("source") or "Edited by a reviewer")}
    try:
        for i, item in enumerate(inputs.get("burn_items", [])):
            clean["burn_items"].append({"label": str(item["label"]).strip() or f"Item {i + 1}", "monthly_base": str(parse_uint(item["monthly_base"], f"burn_items[{i}].monthly_base"))})
        for i, item in enumerate(inputs.get("other_commitments", [])):
            clean["other_commitments"].append({"label": str(item["label"]).strip() or f"Commitment {i + 1}", "amount_base": str(parse_uint(item["amount_base"], f"other_commitments[{i}].amount_base"))})
    except (PayloadError, KeyError) as exc:
        raise ValidationFailed("invalid_treasury_inputs", str(exc)) from exc
    row = db.get(KeyValue, "treasury_inputs")
    if row:
        row.value = clean
    else:
        db.add(KeyValue(key="treasury_inputs", value=clean))
    db.commit()
    return clean


def fee_inflows_30d() -> dict[str, Any]:
    deployment = runtime.require_deployment()
    chain = runtime.chain
    logs = chain.get_logs(deployment.c("fee_vault"), [FEE_RECORDED_TOPIC], 0)
    now_ts = chain.latest_timestamp()
    cutoff = now_ts - 30 * 86400
    total = 0
    count = 0
    for log in logs:
        block = chain.block(log["block_number"])
        if int(block["timestamp"], 16) >= cutoff:
            total += int(log["args"]["fee"])
            count += 1
    return {"monthly_base": str(total), "events": count, "window_days": 30,
            "source": "Sum of FeeVault FeeRecorded events over the last 30 days (local chain)."}


def pending_approvals(db: Session, exclude: str | None = None) -> list[dict[str, Any]]:
    """Transfers approved by governance on the guard but not yet executed."""
    deployment = runtime.require_deployment()
    guard = runtime.chain.contract("ExecutionGuard", deployment.c("guard"))
    out = []
    from .proposals import approved_version

    for p in db.query(Proposal).all():
        if p.id == exclude:
            continue
        v = approved_version(p)
        if v is None:
            continue
        status = GUARD_STATUS.get(int(guard.functions.approvalOf(bytes.fromhex(p.key[2:])).call()[4]), "none")
        if status != "approved":
            continue
        amount = sum(int(a.get("expected_amount_base") or 0) for a in v.manifest["actions"] if a.get("kind") == "erc20_transfer")
        if amount:
            out.append({"proposal_id": p.id, "title": p.title, "amount_base": str(amount), "version": v.version})
    return out


def _pct(numerator: int, denominator: int) -> str:
    if denominator <= 0:
        return "n/a"
    return str((Decimal(numerator) * 100 / Decimal(denominator)).quantize(Decimal("0.01"), rounding=ROUND_HALF_EVEN))


def _months(amount: int, burn: int) -> str | None:
    if burn <= 0:
        return None
    return str((Decimal(amount) / Decimal(burn)).quantize(Decimal("0.1"), rounding=ROUND_HALF_EVEN))


def _runway_change(before: str | None, after: str | None) -> str | None:
    if before is None or after is None or Decimal(before) <= 0:
        return None
    change = (Decimal(after) - Decimal(before)) * 100 / Decimal(before)
    return str(change.quantize(Decimal("0.1"), rounding=ROUND_HALF_EVEN))


def impact(db: Session, p: Proposal, *, amount_override: int | None = None, overrun_pct: int = 0, release: str = "lump", horizon_months: int = 18) -> dict[str, Any]:
    if release not in ("lump", "milestones"):
        raise ValidationFailed("invalid_release", "release must be 'lump' or 'milestones'")
    if not 0 <= overrun_pct <= 200:
        raise ValidationFailed("invalid_overrun", "overrun_pct must be between 0 and 200")
    if not 3 <= horizon_months <= 36:
        raise ValidationFailed("invalid_horizon", "horizon_months must be between 3 and 36")
    deployment = runtime.require_deployment()
    chain = runtime.chain
    balance = treasury_balance() or 0
    block = chain.block_number()
    as_of = from_timestamp(chain.latest_timestamp())
    inputs = get_inputs(db)
    burn = sum(int(i["monthly_base"]) for i in inputs["burn_items"])
    inflow = fee_inflows_30d()
    inflow_base = int(inflow["monthly_base"])
    net_burn = burn - inflow_base
    other = sum(int(i["amount_base"]) for i in inputs["other_commitments"])
    pending = pending_approvals(db, exclude=p.id)
    pending_total = sum(int(x["amount_base"]) for x in pending)
    requested = amount_override if amount_override is not None else int(p.requested_amount_base or 0)

    def scaled(pct: int) -> int:
        return int((Decimal(requested) * (100 + pct) / 100).to_integral_value(rounding=ROUND_HALF_UP))

    free_before = balance - pending_total - other
    scenarios = []
    for label, pct in (("As requested", 0), ("+10% overrun", 10), ("+25% overrun", 25)) + ((("Custom overrun", overrun_pct),) if overrun_pct not in (0, 10, 25) else ()):
        amount = scaled(pct)
        free_after = free_before - amount
        scenarios.append(
            {
                "label": label,
                "overrun_pct": pct,
                "amount_base": str(amount),
                "share_of_treasury_pct": _pct(amount, balance),
                "remaining_balance_base": str(balance - amount),
                "available_after_commitments_base": str(free_after),
                "runway_months": _months(free_after, net_burn),
                "covered": free_after >= 0,
            }
        )
    active = scaled(overrun_pct)
    runway_before = _months(free_before, net_burn)
    runway_after = _months(free_before - active, net_burn)

    # Payout schedule.
    schedule: list[tuple[int, int, str]] = []
    if release == "milestones" and p.milestones:
        total_ms = sum(int(m.get("amount_base") or 0) for m in p.milestones)
        for i, m in enumerate(p.milestones):
            month = int(m.get("month") or (i + 1) * 2)
            share = int(m.get("amount_base") or 0)
            if total_ms and total_ms != requested:  # scale tranches to the scenario amount
                share = share * active // total_ms
            elif not total_ms:
                share = active // len(p.milestones)
            schedule.append((month, share, m.get("title", f"Milestone {i + 1}")))
        drift = active - sum(s for _, s, _ in schedule)
        if schedule and drift:
            month, share, title = schedule[-1]
            schedule[-1] = (month, share + drift, title)
    else:
        schedule = [(0, active, "Lump-sum transfer")]

    series = []
    paid = 0
    for m in range(horizon_months + 1):
        paid += sum(s for month, s, _ in schedule if month == m)
        before_val = free_before - net_burn * m
        series.append({"month": m, "before_base": str(before_val), "after_base": str(before_val - paid)})

    fmt = lambda v: f"{format_units(v, DECIMALS)} mUSDC"  # noqa: E731
    return {
        "proposal_id": p.id,
        "as_of": iso(as_of),
        "block_number": block,
        "data_label": "Treasury balance read from the local demo chain; burn and commitments are demo inputs.",
        "token": {"symbol": "mUSDC", "decimals": DECIMALS, "address": deployment.c("usdc")},
        "treasury_address": deployment.c("guard"),
        "balance_base": str(balance),
        "requested_base": str(requested),
        "active_amount_base": str(active),
        "overrun_pct": overrun_pct,
        "release": release,
        "share_of_treasury_pct": _pct(active, balance),
        "remaining_balance_base": str(balance - active),
        "pending_approvals": pending,
        "pending_total_base": str(pending_total),
        "other_commitments": inputs["other_commitments"],
        "other_commitments_base": str(other),
        "available_before_base": str(free_before),
        "available_after_base": str(free_before - active),
        "burn_items": inputs["burn_items"],
        "monthly_burn_base": str(burn),
        "monthly_inflow": inflow,
        "net_monthly_burn_base": str(net_burn),
        "runway_before_months": runway_before,
        "runway_after_months": runway_after,
        "runway_change_pct": _runway_change(runway_before, runway_after),
        "runway_note": None if net_burn > 0 else "Runway is not computed: inflows cover the stated burn, so the inputs do not imply a depletion date.",
        "scenarios": scenarios,
        "schedule": [{"month": m, "amount_base": str(s), "label": t} for m, s, t in schedule],
        "series": series,
        "formulas": [
            {"name": "Share of treasury", "formula": "amount ÷ treasury balance × 100", "value": f"{_pct(active, balance)}%"},
            {"name": "Remaining balance", "formula": "treasury balance − amount", "value": fmt(balance - active)},
            {"name": "Available after commitments", "formula": "balance − pending approved payouts − other commitments − amount", "value": fmt(free_before - active)},
            {"name": "Net monthly burn", "formula": "Σ burn items − fee inflows (last 30 days)", "value": fmt(net_burn)},
            {"name": "Runway", "formula": "available after commitments ÷ net monthly burn", "value": f"{runway_after} months" if runway_after else "insufficient data"},
            {"name": "Overrun scenario", "formula": "requested × (100 + overrun %) ÷ 100, rounded half-up to a base unit", "value": fmt(active)},
        ],
        "assumptions": [
            "Burn items and other commitments are manual inputs, not chain data.",
            "Fee inflow is the trailing 30-day sum of FeeVault fees; future fees may differ.",
            "Approved-but-unexecuted transfers are treated as committed.",
            "No investment yield, price change or token volatility is modelled.",
            "mUSDC is treated as 1 USD for display only; it is a demo token.",
        ],
    }


def dependency_checks(db: Session, p: Proposal, only: str | None = None) -> list[dict[str, Any]]:
    """Live on-chain prerequisites for executing the proposal's manifest."""
    deployment = runtime.require_deployment()
    chain = runtime.chain
    from .proposals import build_actions, latest_version

    block = chain.block_number()
    checks: list[dict[str, Any]] = []
    now = iso(utcnow())

    def add(cid: str, label: str, contract: str | None, category: str, status: str, detail: str) -> None:
        if only and cid != only:
            return
        checks.append({"id": cid, "label": label, "contract": contract, "category": category, "status": status, "detail": detail, "block": block, "checked_at": now})

    usdc = deployment.c("usdc")
    add("token-code", "Payment token contract deployed", usdc, "token",
        "pass" if chain.get_code(usdc) not in ("0x", "0x0") else "fail", "mUSDC has bytecode at its address.")
    balance = treasury_balance() or 0
    requested = int(p.requested_amount_base or 0)
    if requested:
        add("balance", "Treasury holds the requested amount", deployment.c("guard"), "treasury",
            "pass" if balance >= requested else "fail",
            f"Balance {format_units(balance, DECIMALS)} vs request {format_units(requested, DECIMALS)} mUSDC.")
        pending_total = sum(int(x["amount_base"]) for x in pending_approvals(db, exclude=p.id))
        add("balance-after-commitments", "Balance covers request plus pending approvals", deployment.c("guard"), "treasury",
            "pass" if balance - pending_total >= requested else "fail",
            f"{format_units(pending_total, DECIMALS)} mUSDC already approved for other proposals.")
    if p.recipient_address:
        code = chain.get_code(p.recipient_address)
        add("recipient-type", "Recipient account type", p.recipient_address, "recipient", "info",
            "Contract account (code present): confirm it can receive and use mUSDC." if code not in ("0x", "0x0") else "Externally owned account (no code).")
    guard = chain.contract("ExecutionGuard", deployment.c("guard"))
    approval = guard.functions.approvalOf(bytes.fromhex(p.key[2:])).call()
    status = GUARD_STATUS.get(int(approval[4]), "none")
    add("guard-approval", "Governance approval recorded on the guard", deployment.c("guard"), "governance",
        {"approved": "pass", "executed": "info", "halted": "fail", "none": "pending"}[status],
        f"Guard status: {status}" + (f", version {approval[1]}, manifest {('0x' + approval[0].hex())[:12]}…" if status != "none" else "."))
    if status == "approved":
        executable_at = int(approval[3])
        add("review-window", "Guardian review window elapsed", deployment.c("guard"), "governance",
            "pass" if block + 1 >= executable_at else "pending",
            f"Executable from block {executable_at}; current block {block}.")
    v = latest_version(p)
    if v and v.governor_proposal_id:
        governor = chain.contract("AtlasGovernor", deployment.c("governor"))
        state = int(governor.functions.state(int(v.governor_proposal_id)).call())
        names = ["Pending", "Active", "Canceled", "Defeated", "Succeeded", "Queued", "Expired", "Executed"]
        add("governor-state", "On-chain vote state", deployment.c("governor"), "governance",
            "pass" if names[state] in ("Succeeded", "Executed") else "fail" if names[state] in ("Defeated", "Canceled", "Expired") else "pending",
            f"Governor proposal for v{v.version}: {names[state]}.")
    try:
        actions = build_actions(p.draft_actions or [], deployment)
    except Exception:
        actions = []
    for i, a in enumerate(actions):
        has_code = chain.get_code(a.target) not in ("0x", "0x0")
        add(f"target-{i}", f"Action #{i + 1} target has code", a.target, "contract", "pass" if has_code else "fail",
            "Target is a deployed contract." if has_code else "No bytecode at target: the call would do nothing or fail.")
    if p.category == "upgrade":
        admin = chain.contract("ProxyAdmin", deployment.c("proxy_admin"))
        owner = admin.functions.owner().call()
        add("proxy-admin-owner", "ProxyAdmin owned by the ExecutionGuard", deployment.c("proxy_admin"), "contract",
            "pass" if owner.lower() == deployment.c("guard").lower() else "fail", f"owner() = {owner}")
    return checks


def overview(db: Session) -> dict[str, Any]:
    deployment = runtime.require_deployment()
    balance = treasury_balance() or 0
    inputs = get_inputs(db)
    pending = pending_approvals(db)
    return {
        "balance_base": str(balance),
        "treasury_address": deployment.c("guard"),
        "pending_approvals": pending,
        "pending_total_base": str(sum(int(x["amount_base"]) for x in pending)),
        "inputs": inputs,
        "monthly_inflow": fee_inflows_30d(),
        "as_of_block": runtime.chain.block_number(),
    }

