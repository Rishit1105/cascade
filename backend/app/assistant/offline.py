"""Built-in answer engine (no API key needed): intent routing over live data plus knowledge-base
retrieval. Answers are composed from tool results, so every number is the app's own."""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..errors import DomainError
from ..models import Proposal
from . import kb, tools

GREETING = re.compile(r"^\s*(hi|hello|hey|hiya|yo|good (morning|afternoon|evening)|namaste|greetings)\b[\s!.,]*$", re.I)
THANKS = re.compile(r"\b(thanks|thank you|thx|cheers|great|awesome|perfect|nice)\b", re.I)
PCT = re.compile(r"(\d{1,3})\s*%")
ASPECTS: list[tuple[str, tuple[str, ...]]] = [
    ("treasury", ("treasury", "runway", "budget", "money", "afford", "cost", "overrun", "balance", "burn", "fund", "milestone", "tranche", "payout")),
    ("execution", ("execut", "guard", "simulat", "halt", "sentinel", "payload", "attack", "backdoor", "drain", "upgrade", "bytecode", "manifest", "tamper", "safe to run")),
    ("conflicts", ("conflict", "relationship", "related", "transfer", "insider", "connected", "link", "self-dealing", "wallet")),
    ("evaluation", ("risk", "evaluation", "score", "estimate", "probability", "how bad", "dangerous", "safe", "chain")),
    ("findings", ("finding", "gap", "missing", "issue", "problem", "concern", "red flag", "wrong", "contradict", "question")),
    ("activity", ("activity", "history", "happened", "timeline", "recent", "latest", "events", "log")),
]


def _last_pid(messages: list[dict[str, str]], context: dict[str, Any]) -> str | None:
    for m in reversed(messages):
        found = tools.PID.findall(m.get("content", ""))
        if found:
            return found[-1].upper()
    pid = (context or {}).get("proposal_id")
    return str(pid).upper() if pid and tools.PID.fullmatch(str(pid)) else None


def _aspect(text: str) -> str | None:
    t = text.lower()
    for name, words in ASPECTS:
        if any(w in t for w in words):
            return name
    return None


def _sev(s: str) -> str:
    return {"critical": "Critical", "high": "High", "medium": "Medium", "low": "Low"}.get(s, s.title())


def _link(label: str, to: str) -> dict[str, str]:
    return {"label": label, "to": to}


def suggestions(context: dict[str, Any], pid: str | None = None) -> list[str]:
    path = (context or {}).get("path", "/")
    pid = pid or "GOV-042"
    if path.startswith("/guardian"):
        return [f"Is {pid}'s payload safe to execute?", "What does ManifestMismatch mean?", "Explain the execution tunnel", "What did the GOV-043 comparison find?"]
    if path.startswith("/financial"):
        return [f"What happens to runway if {pid} overruns by 30%?", "How is available balance calculated?", "How do I use the 3D explorer?", "Which payouts are still pending?"]
    if path.startswith("/audit"):
        return ["What happened most recently?", "How does ledger verification work?", "What does chain-confirmed mean?", "Which alerts are open?"]
    if path.startswith("/relationships"):
        return [f"What conflicts does {pid} have?", "Does a transfer prove common ownership?", "What is COI-R004?", "Which proposal is riskiest?"]
    if path.startswith("/voting"):
        return ["How healthy was participation?", "What is the Nakamoto coefficient?", f"Did the recipient's power vote on {pid}?", "Which proposal is riskiest?"]
    if path.startswith("/proposals"):
        return [f"Summarise {pid} for a voter", f"What is missing from {pid}?", f"Should I worry about {pid}?", "How does proposer Q&A work?"]
    return ["Which proposal is riskiest right now?", "Summarise GOV-042", "Is GOV-043's upgrade safe?", "How do I demo DAOGuard in 5 minutes?"]


# --------------------------------------------------------------------------- composers
def _proposal_overview(db: Session, pid: str) -> tuple[str, list[dict[str, str]], list[str]]:
    p = tools.get_proposal(db, pid)
    ev = tools.get_evaluation(db, pid)
    top = max(ev["stages"], key=lambda s: s["estimate_pct"])
    lines = [f"### {p['id']} · {p['title']}", "",
             f"**{p['status'].title()}** {p['category']} proposal requesting **{p['requested']}** from {p['recipient'] or 'no recipient'} (proposer {p['proposer'].split(' (')[0]}).", ""]
    if p["brief"] and p["brief"]["summary"]:
        lines += [f"> {p['brief']['summary'][1] if len(p['brief']['summary']) > 1 else p['brief']['summary'][0]}", ""]
    gov = p["governance"]
    lines += [
        "**Where it stands**",
        f"- Vote: {gov['state'] or 'not submitted'}" + (f" · turnout {gov['participation_pct']}%" if gov.get("participation_pct") else "") + (" · quorum reached" if gov.get("quorum_reached") else ""),
        f"- ExecutionGuard: **{p['guard']['status']}**" + (f" (v{p['guard']['version']})" if p["guard"].get("version") else ""),
        f"- Evaluation chain: **{ev['combined_estimate_pct']}%** combined estimate; highest stage is {top['name']} at {top['estimate_pct']}%",
        "",
    ]
    if p["open_findings"]:
        lines.append(f"**Open findings ({len(p['open_findings'])})**")
        for f in p["open_findings"][:4]:
            lines.append(f"- {_sev(f['severity'])} · {f['title']} ({f['rule']})")
        lines.append("")
    if p["brief"] and p["brief"]["contradictions"]:
        lines += ["**Contradiction**", f"- {p['brief']['contradictions'][0]}", ""]
    q = p["questions"]
    if any(q.values()):
        lines += [f"**Proposer Q&A:** {q['open'] + q['needs_more']} awaiting the proposer, {q['answered']} awaiting review, {q['accepted']} accepted.", ""]
    lines.append("_The combined estimate is a model estimate to direct attention, not a probability of fraud._")
    links = [_link(f"Open {pid}", p["pages"]["workspace"]), _link("Execution guardian", p["pages"]["guardian"]), _link("Treasury impact", p["pages"]["financial"])]
    return "\n".join(lines), links, ["get_proposal", "get_evaluation"]


def _evaluation(db: Session, pid: str) -> tuple[str, list[dict[str, str]], list[str]]:
    ev = tools.get_evaluation(db, pid)
    lines = [f"### Evaluation chain for {pid}: {ev['combined_estimate_pct']}% combined", ""]
    for s in ev["stages"]:
        lines.append(f"**{s['name']} · {s['estimate_pct']}%** ({s['band']}, prior {s['prior_pct']}%)")
        if s["evidence"]:
            for e in s["evidence"][:4]:
                arrow = "raises" if e["direction"] == "raises" else "lowers" if e["direction"] == "lowers" else "leaves"
                lines.append(f"- ×{e['likelihood_ratio']} {arrow} it: {e['factor']}")
        else:
            lines.append("- No evidence recorded for this stage yet.")
        for n in s["notes"][:1]:
            lines.append(f"- _{n}_")
        lines.append("")
    lines.append(f"Method: {ev['formula']}. {ev['label']}")
    return "\n".join(lines), [_link("Evaluation chain on the Overview", "/"), _link("Edit likelihood ratios", "/settings")], ["get_evaluation"]


def _findings(db: Session, pid: str) -> tuple[str, list[dict[str, str]], list[str]]:
    f = tools.get_findings(db, pid)
    items = f["open_findings"]
    if not items:
        return f"**{pid} has no open findings.** Resolved and dismissed findings are kept in its history.", [_link(f"Findings of {pid}", f"/proposals/{pid}?tab=findings")], ["get_findings"]
    lines = [f"### {len(items)} open finding(s) on {pid}", ""]
    for x in items[:7]:
        lines.append(f"**{_sev(x['severity'])} · {x['title']}** `{x['rule']}`")
        lines.append(f"- {x['explanation'][:260]}")
        if x["ask"]:
            lines.append(f"- Ask: _{x['ask']}_")
        lines.append("")
    lines.append(f"_{f['note']}_ You can turn any gap into a question for the proposer on the Q&A tab.")
    return "\n".join(lines), [_link("Findings", f"/proposals/{pid}?tab=findings"), _link("Ask the proposer", f"/proposals/{pid}?tab=qa")], ["get_findings"]


def _treasury(db: Session, pid: str, text: str) -> tuple[str, list[dict[str, str]], list[str]]:
    m = PCT.search(text)
    overrun = int(m.group(1)) if m else 0
    release = "milestones" if re.search(r"milestone|tranche", text, re.I) else "lump"
    t = tools.get_treasury_impact(db, pid, overrun, release)
    lines = [f"### Treasury impact of {pid}" + (f" with a {overrun}% overrun" if overrun else "") + f" ({'milestone tranches' if release == 'milestones' else 'lump sum'})", "",
             f"- On-chain treasury: **{t['treasury_balance_onchain']}**",
             f"- This proposal: **{t['this_proposal']}** ({t['share_of_treasury_pct']}% of the treasury)",
             f"- Available after commitments: {t['available_before']} → **{t['available_after']}**",
             f"- Net monthly burn: {t['net_monthly_burn']}",
             f"- Runway: **{t['runway_months_before']} → {t['runway_months_after']} months**" + (f" ({t['runway_change_pct']}%)" if t["runway_change_pct"] else ""),
             f"- Projected available balance at month 12: {t['projected_available_month_12']}"]
    if t["first_month_below_zero"] is not None:
        lines.append(f"- ⚠ The projection goes **below zero in month {t['first_month_below_zero']}** under these inputs.")
    lines += ["", "**Payout schedule**"] + [f"- Month {s['month']}: {s['amount']} · {s['label']}" for s in t["schedule"]]
    for issue in t["schedule_issues"]:
        lines.append(f"- _Note: {issue}_")
    lines += ["", f"_Projection from the configured inputs: {t['assumptions'][0]} {t['assumptions'][3]}_"]
    return "\n".join(lines), [_link("Open the financial impact page", t["page"])], ["get_treasury_impact"]


def _execution(db: Session, pid: str) -> tuple[str, list[dict[str, str]], list[str]]:
    x = tools.get_execution_status(db, pid)
    g = x["guard"]
    sims = x["recent_simulations"]
    verdicts = [s_["verdict"] for s_ in sims]
    if g["status"] == "halted":
        bottom = "**No.** The approval is halted on-chain, so the guard will refuse to execute it."
    elif "block" in verdicts and not (sims and sims[0]["verdict"] == "pass"):
        bottom = "**Not as submitted.** The latest simulation of this payload is **BLOCK**: observed behaviour contradicts what voters were told."
    elif g["status"] == "executed":
        bottom = "**Already executed.** The approved manifest ran once; any replay reverts with AlreadyExecuted."
    elif g["status"] == "none":
        bottom = "**Not yet.** Governance has not approved a manifest on the guard, so any execution attempt reverts with NotApproved."
    else:
        bottom = "**Only the exact approved payload can run.** No blocking simulation verdict is recorded; tampered variants revert on-chain."
    lines = [f"### Execution status of {pid}", "", bottom, "", f"- ExecutionGuard approval: **{g['status']}**" + (f" (v{g['version']}, manifest `{(g.get('manifest_hash') or '')[:12]}…`)" if g.get("version") else "")]
    if g["status"] == "approved" and g.get("executable_at_block"):
        left = g["executable_at_block"] - (x["current_block"] or 0)
        lines.append(f"- Review window: " + (f"{left} block(s) left" if left > 0 else f"elapsed (executable since block {g['executable_at_block']})"))
    if g["status"] == "halted":
        lines.append("- **Halted by the guardian/sentinel.** Execution fails with ProposalIsHalted; only a newer version approved by a new vote can run.")
    if x["recent_simulations"]:
        lines += ["", "**Recent simulations**"]
        for s in x["recent_simulations"][:3]:
            lines.append(f"- {s['verdict'].upper()} · {s['scenario'] or 'manifest'} ({s['trigger']}): {s['summary'][:200]}")
    if x["recent_attempts"]:
        lines += ["", "**Recent execution attempts**"]
        for a in x["recent_attempts"][:4]:
            lines.append(f"- {a['scenario'] or 'custom'}: **{a['outcome']}**" + (f" with `{a['revert']}`" if a["revert"] else "") + (f" · block {a['block']}" if a["block"] else ""))
    lines += ["", "The contract, not this page, decides: only the exact EIP-712 digest governance approved can execute, and any change reverts on-chain."]
    return "\n".join(lines), [_link("Open the execution guardian", x["page"]), _link("Bytecode simulation", f"/guardian?p={pid}&view=bytecode")], ["get_execution_status"]


def _conflicts(db: Session, pid: str) -> tuple[str, list[dict[str, str]], list[str]]:
    c = tools.get_conflicts(db, pid)
    if not c["conflict_findings"]:
        return f"**No open conflict-of-interest leads on {pid}.** {c['note']}", [_link("Relationship explorer", c["page"])], ["get_conflicts"]
    lines = [f"### Conflict-of-interest leads on {pid}", ""]
    for f in c["conflict_findings"]:
        lines += [f"**{_sev(f['severity'])} · {f['title']}** `{f['rule']}`", f"- {f['explanation'][:300]}", ""]
    lines.append(f"_{c['note']}_")
    return "\n".join(lines), [_link("Relationship explorer", c["page"])], ["get_conflicts"]


def _activity(db: Session, pid: str | None) -> tuple[str, list[dict[str, str]], list[str]]:
    a = tools.get_recent_activity(db, 7, pid)
    lines = [f"### Latest ledger events{' for ' + pid if pid else ''}", ""]
    for e in a["recent_events"]:
        lines.append(f"- **{e['type'].replace('_', ' ')}** · {e['proposal'] or 'system'} · {e['when'][:16].replace('T', ' ')}" + (" · chain-confirmed" if e["verification"] == "chain-confirmed" else "") + f"  \n  {e['summary'][:180]}")
    if a["open_alerts"] and not pid:
        lines += ["", f"**Open alerts ({len(a['open_alerts'])})**"] + [f"- {_sev(x['severity'])} · {x['title']} ({x['proposal'] or 'system'})" for x in a["open_alerts"][:5]]
    return "\n".join(lines), [_link("Audit timeline", "/audit"), _link("Escalation inbox", "/escalation")], ["get_recent_activity"]


def _ranking(db: Session) -> tuple[str, list[dict[str, str]], list[str]]:
    data = tools.list_proposals(db)
    ranked = sorted(data["proposals"], key=lambda p: -p["combined_estimate_pct"])
    lines = ["### Proposals ranked by the evaluation chain", ""]
    for i, p in enumerate(ranked, 1):
        sev = ", ".join(f"{n} {k}" for k, n in p["open_findings_by_severity"].items()) or "no open findings"
        lines.append(f"{i}. **{p['id']} · {p['title']}** ({p['status']}, {p['requested']}): **{p['combined_estimate_pct']}%** combined; highest stage {p['riskiest_stage']}; {sev}; guard {p['guard_status']}")
    lines += ["", f"_{data['note']}_ Ask me about any of them for the details."]
    top = ranked[0]["id"] if ranked else "GOV-042"
    return "\n".join(lines), [_link(f"Open {top}", f"/proposals/{top}"), _link("Overview", "/")], ["list_proposals"]


def _treasury_overview(db: Session) -> tuple[str, list[dict[str, str]], list[str]]:
    t = tools.get_treasury_overview(db)
    lines = ["### Atlas DAO treasury", "", f"- On-chain balance: **{t['treasury_balance_onchain']}** (block {t['as_of_block']})",
             f"- Monthly burn inputs: {t['monthly_burn_inputs']} · fee inflow (30 days): {t['fee_inflow_30d']}"]
    lines += [f"- Approved but not yet executed: {x['amount']} for {x['proposal']}" for x in t["pending_approvals"]] or ["- No approved payouts are pending."]
    lines += ["", "Ask about a specific proposal (for example “runway impact of GOV-042 with a 30% overrun”) for the full projection."]
    return "\n".join(lines), [_link("Financial impact", "/financial")], ["get_treasury_overview"]


def _knowledge(query: str) -> tuple[str, list[dict[str, str]], list[str]] | None:
    hits = kb.search(query, k=3)
    if not hits or hits[0][0] < 2.4:
        return None
    _, best = hits[0]
    body = best.body
    lines = [f"### {best.title}", "", body]
    related = [s.title for score, s in hits[1:] if score > hits[0][0] * 0.55]
    if related:
        lines += ["", "Related: " + " · ".join(related)]
    links = [_link(f"Open {best.link}", best.link)] if best.link else []
    return "\n".join(lines), links, [f"guide: {best.title}"]


# Precise definitions for exact terms people ask about (contract errors, rule ids, core concepts).
TERMS: dict[str, tuple[str, str, str]] = {
    "manifestmismatch": ("ManifestMismatch", "The ExecutionGuard recomputed the EIP-712 digest of the submitted actions and it differs from the digest governance approved, so it refused to run any of them. Nothing moves; the revert is recorded on-chain with a transaction hash. Typical causes: a changed recipient, amount, target, calldata, version or an extra or missing action.", "/guardian?p=GOV-042&scenario=tampered_recipient"),
    "alreadyexecuted": ("AlreadyExecuted", "The approved manifest already ran once. The guard executes each approval exactly once, so a replay of the same payload reverts.", "/guardian?p=GOV-042"),
    "proposalishalted": ("ProposalIsHalted", "A guardian (or the sentinel, after a BLOCK simulation verdict) halted the approval during the review window. The manifest can never execute; only a newer version approved by a new vote can.", "/proposals/GOV-043"),
    "notapproved": ("NotApproved", "Governance has not approved any manifest for this proposal, so the guard has nothing it is allowed to execute.", "/guardian"),
    "reviewwindowactive": ("ReviewWindowActive", "The approval is still inside its review window (5 blocks in the demo), the time reserved for the sentinel and guardians to review and, if needed, halt it. Execution is possible once the window has passed.", "/guardian"),
    "staleversion": ("StaleVersion", "The payload was built for an older or different proposal version than the one governance approved.", "/guardian"),
    "unsupportedoperation": ("UnsupportedOperation", "The payload asked for a DELEGATECALL. The guard never performs delegatecalls, because they would run foreign code with the treasury's own storage and permissions.", "/guardian"),
    "review window": ("Review window", "The blocks between a governance approval and the earliest block at which it may execute (5 in the demo). The sentinel simulates the approved manifest inside this window and can halt it.", "/guardian"),
    "preflight": ("Preflight", "A read-only eth_call to ExecutionGuard.preflight() that runs the same checks as execute() without sending a transaction. It is a prediction: nothing is sent and nothing moves.", "/guardian"),
    "sentinel": ("Sentinel", "A background service that watches for ManifestApproved events, simulates each approved manifest and, on a BLOCK verdict, halts it on-chain during the review window. It can only block; it can never approve or execute.", "/proposals/GOV-043"),
    "digest": ("Manifest digest", "The EIP-712 hash binding the chain id, guard address, proposal key, version and every action's target, value, calldata and operation. Governance approves this digest and the guard recomputes it before executing.", "/guardian?view=builder"),
    "chain-confirmed": ("Chain-confirmed", "An audit-ledger event backed by a mined transaction; verification re-checks its receipt against the node. Events without a transaction are labelled off-chain.", "/audit"),
    "likelihood ratio": ("Likelihood ratio", "How much one piece of evidence multiplies the odds that a stage has a material issue. Above 1 raises the estimate, below 1 lowers it. All ratios are listed and editable in Settings.", "/settings"),
}
RULES = {"MI": "missing-information rule", "DG": "payload rule", "COI": "conflict-of-interest rule", "SIM": "simulation rule", "INJ": "prompt-injection rule"}
RULE_TITLES = {
    "MI-R001": "Budget breakdown missing", "MI-R002": "Delivery milestones missing", "MI-R003": "No independent audit for the code change",
    "MI-R004": "Recipient details not evidenced", "MI-R005": "Conflict-of-interest disclosure missing", "MI-R006": "Upgrade plan missing",
    "MI-R007": "Rollback plan missing", "MI-R008": "Risks not described", "MI-R009": "No supporting evidence attached",
    "MI-R010": "Large allocation without independent review", "MI-R011": "Audit evidence does not cover the submitted implementation",
    "MI-R012": "Sources disagree on the amount",
    "COI-R001": "Undisclosed observed transfer between proposer and recipient", "COI-R002": "Shared funding source (weak link)",
    "COI-R003": "Common funding source for proposer and recipient", "COI-R004": "Undisclosed transfer between proposer and an address embedded in submitted code",
    "COI-R005": "Recipient's delegated voting power was used in this vote",
    "SIM-R001": "Undeclared external function", "SIM-R002": "Address hard-coded in new bytecode", "SIM-R004": "An action reverts in simulation",
    "SIM-R005": "New path for non-governance funds movement", "SIM-R006": "Non-governance control change", "SIM-R007": "Funds move somewhere the decision did not approve",
    "SIM-R008": "Treasury allowance granted", "SIM-R010": "Embedded address connected to the proposer", "SIM-R011": "Upgrade target has no code",
    "INJ-R001": "Instruction-like text found in evidence (prompt injection)",
}
try:  # payload rules come straight from the rule engine, so titles can never drift
    from ..services.execution_checks import RULES as _DG

    RULE_TITLES.update({k: v[0] for k, v in _DG.items()})
except Exception:  # pragma: no cover
    pass


def _term(text: str) -> tuple[str, list[dict[str, str]], list[str]] | None:
    t = text.lower().replace("`", "")
    for key, (name, definition, link) in TERMS.items():
        if key in t.replace(" ", "") or key in t:
            return f"### {name}\n\n{definition}", [_link("See it in the app", link)], [f"term: {name}"]
    m = re.search(r"\b(MI|DG|COI|SIM|INJ)-R?(\d{3})\b", text, re.I)
    if m:
        code = f"{m.group(1).upper()}-R{m.group(2)}"
        hits = kb.search(code, k=1)
        line = next((ln for _, sec in hits for ln in re.split(r"(?<=[.;])\s", sec.body) if code in ln or code.split("-")[1] in ln), None)
        title = RULE_TITLES.get(code)
        body = f"### {code}" + (f": {title}" if title else "") + f"\n\n{code} is a {RULES[m.group(1).upper()]}" + (f" that flags **{title.lower()}**." if title else ".")
        if not title and line:
            body += f" {line.strip()}"
        note = {
            "MI": "Each rule states what was searched and the question to ask; a missing item is a reason to ask, not evidence of wrongdoing.",
            "DG": "Rules explain a mismatch; the ExecutionGuard contract is what actually refuses to execute it.",
            "COI": "A transfer proves value moved, not common ownership; treat it as a lead to explain.",
            "SIM": "Simulation findings hold for the probed callers and current state; a pass is not a proof of safety.",
            "INJ": "Flagged text is treated strictly as data and never changes rules or results.",
        }[m.group(1).upper()]
        return f"{body}\n\n{note}", [], [f"rule: {code}"]
    return None


CAPABILITIES = """### I'm the DAOGuard assistant

I know this prototype inside out and read its live data. Ask me things like:

- **Proposals:** “Summarise GOV-042”, “What is missing from GOV-044?”
- **Risk:** “Which proposal is riskiest?”, “Explain GOV-043's evaluation chain”
- **Execution:** “Is GOV-043's upgrade safe to execute?”, “What does ManifestMismatch mean?”
- **Treasury:** “What happens to runway if GOV-042 overruns by 30%?”
- **Conflicts:** “Who is connected to GOV-042's recipient?”
- **How-to:** “How do I demo DAOGuard?”, “How does proposer Q&A work?”

I only read data. I never vote, execute, halt or change anything."""


def answer(db: Session, messages: list[dict[str, str]], context: dict[str, Any]) -> dict[str, Any]:
    text = (messages[-1]["content"] if messages else "").strip()
    pid = _last_pid(messages, context)
    if not text or re.fullmatch(r"(help|\?|what can you do\??|who are you\??)", text.lower()):
        return {"text": CAPABILITIES, "links": [], "sources": ["assistant"], "suggestions": suggestions(context, pid)}
    if GREETING.match(text):
        return {"text": "Hello! " + CAPABILITIES.split("\n", 2)[2], "links": [], "sources": ["assistant"], "suggestions": suggestions(context, pid)}
    if THANKS.search(text) and len(text) < 40:
        return {"text": "Glad that helped. Anything else you'd like to check?", "links": [], "sources": [], "suggestions": suggestions(context, pid)}

    lower = text.lower()
    mentioned = tools.PID.findall(text)
    # "How does X work?" with no proposal named is about the product, even on a proposal's page.
    concept = bool(re.match(r"\s*(what|how|why|explain|define|describe|tell me about|meaning)\b", lower)) and not mentioned and not re.search(r"\b(this|it|its)\b", lower)
    try:
        if re.search(r"\b(which|rank|compare|riskiest|worst|safest|all proposals|list (the )?proposals|every proposal)\b", lower) and not (len(mentioned) == 1 and "compare" not in lower):
            body, links, src = _ranking(db)
        elif pid and not concept and (mentioned or re.search(r"\b(this|it|its|the proposal|that one)\b", lower) or _aspect(lower)):
            asp = _aspect(lower)
            body, links, src = {
                "treasury": lambda: _treasury(db, pid, text), "execution": lambda: _execution(db, pid), "conflicts": lambda: _conflicts(db, pid),
                "evaluation": lambda: _evaluation(db, pid), "findings": lambda: _findings(db, pid), "activity": lambda: _activity(db, pid),
            }.get(asp or "", lambda: _proposal_overview(db, pid))()
        elif re.search(r"\b(treasury|balance|runway)\b", lower) and not re.search(r"\b(how|calculat|formula|explain)\b", lower):
            body, links, src = _treasury_overview(db)
        elif re.search(r"\b(alerts?|recent|latest|what happened|activity|going on)\b", lower) and not re.search(r"\bhow\b", lower):
            body, links, src = _activity(db, None)
        elif (t := _term(text)) is not None:
            body, links, src = t
        else:
            k = _knowledge(text)
            if k is None:
                body = ("I couldn't match that to DAOGuard's data or guide. I'm running the **built-in engine** (no AI model key is configured), "
                        "which answers about this prototype: its proposals, risks, treasury, execution checks, audit trail and how to use each page.\n\n"
                        "Try rephrasing, pick a suggestion below, or add `ANTHROPIC_API_KEY` to `backend/.env` to enable open-ended answers from Claude.")
                links, src = [], []
            else:
                body, links, src = k
    except DomainError as exc:  # e.g. a proposal id that does not exist: say so and list the real ones
        known = ", ".join(db.scalars(select(Proposal.id).order_by(Proposal.id)))
        body, links, src = f"{exc.message} The proposals in this demo are {known}.", [_link("All proposals", "/proposals")], []
    except Exception as exc:  # live data unavailable (e.g. chain restarting): say so plainly
        body, links, src = f"I couldn't read the live data just now ({exc}). The chain may be restarting; please try again in a moment.", [], []
    return {"text": body, "links": links, "sources": src, "suggestions": suggestions(context, pid)}
