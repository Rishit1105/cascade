"""Local assistant engine: nothing leaves the machine and no API key is needed.

understand() turns a message into an intent (trained model, nlu.py), entities and a proposal
resolved from the message, the conversation or the page. respond() answers it with a focused
composer over live data (every number comes from the app's own services), and only falls back
to the product guide and then to a local open-source LLM when no composer fits."""

from __future__ import annotations

import logging
import random
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..errors import DomainError
from ..models import AddressLabel, AuditEvent, Proposal, Report
from . import kb, local_llm, nlu, offline, semantic, tools
from .offline import _link, _sev

log = logging.getLogger("daoguard.assistant")
Emit = Callable[[str, dict[str, Any]], None]

LOW, VERY_LOW = 0.34, 0.2
META = {"greeting", "thanks", "goodbye", "capabilities", "identity"}
LABEL = {
    "greeting": "Greeting", "thanks": "Thanks", "goodbye": "Goodbye", "capabilities": "What I can do", "identity": "About the assistant",
    "proposal_overview": "Proposal overview", "proposal_amount": "Requested amount", "proposal_recipient": "Recipient", "proposal_proposer": "Proposer",
    "proposal_status": "Status", "proposal_purpose": "Purpose & benefits", "proposal_payouts": "Payout schedule", "risk_evaluation": "Risk evaluation",
    "findings": "Findings & gaps", "execution_safety": "Execution safety", "treasury_impact": "Treasury impact", "conflicts": "Conflicts of interest",
    "versions_changes": "Version changes", "evidence_docs": "Evidence", "qa_status": "Proposer Q&A", "vote_result": "Vote result", "vote_advice": "Voting considerations",
    "voting_power": "Voting power", "actor_lookup": "Address lookup", "ranking": "Ranking", "compare": "Comparison", "list_proposals": "All proposals",
    "treasury_overview": "Treasury", "alerts": "Open alerts", "recent_activity": "Recent activity", "proposal_timeline": "Proposal timeline",
    "ledger_integrity": "Ledger integrity", "ledger_connection": "Ledger connection", "page_help": "This page", "concept": "Definition", "how_to": "How it works",
    "emergency_action": "Emergency actions", "report_generate": "Reports", "settings_policy": "Policy & settings", "elaborate": "More detail",
    "followup_switch": "Follow-up", "out_of_scope": "General question",
}
PAGE_GUIDE = [("/proposals", "Proposals workspace"), ("/relationships", "Relationships and conflicts of interest"), ("/versions", "Proposals workspace"),
              ("/financial", "Financial impact and treasury model"), ("/voting", "Voting and delegates"), ("/guardian", "Execution guardian"),
              ("/audit", "Audit ledger and verification"), ("/escalation", "Risk escalation"), ("/reports", "Reports and export"), ("/settings", "Settings and risk model"), ("/overview", "Overview page"), ("/", "Overview page")]
INTENT_GUIDE = {"risk_evaluation": "Evaluation chain", "findings": "Missing-information rules", "execution_safety": "Execution guardian", "treasury_impact": "Financial impact and treasury model",
                "conflicts": "Relationships and conflicts of interest", "vote_result": "Voting and delegates", "voting_power": "Voting and delegates", "qa_status": "Proposer Q&A",
                "ledger_integrity": "Audit ledger and verification", "evidence_docs": "Cited brief and citations", "emergency_action": "Risk escalation", "report_generate": "Reports and export"}
METHOD_Q = re.compile(r"\bhow (is|are|was|does|do)\b.*\b(calculat|comput|work|derive|determin|measur|scor|made)", re.I)


@dataclass
class Reply:
    text: str
    links: list[dict[str, str]] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    streamed: bool = False
    engine: str = "composer"


@dataclass
class Turn:
    text: str
    intent: str
    confidence: float
    alternatives: list[tuple[str, float]]
    ent: nlu.Entities
    pid: str | None = None
    pid_from: str | None = None
    deep: bool = False
    history: list[dict[str, str]] = field(default_factory=list)
    context: dict[str, Any] = field(default_factory=dict)


def _r(a: tuple[str, list[dict[str, str]], list[str]]) -> Reply:
    return Reply(a[0], a[1], a[2])


# --------------------------------------------------------------------------- understanding
_index: dict[str, Any] = {"key": None, "idx": None, "at": 0.0}


def entity_index(db: Session | None) -> nlu.EntityIndex:
    if db is None:
        from .train import fixture_index

        return fixture_index()
    key = (db.scalar(select(func.count(Proposal.id))), str(db.scalar(select(func.max(Proposal.updated_at)))), db.scalar(select(func.count(AddressLabel.address))))
    if _index["key"] != key or time.time() - _index["at"] > 300:
        props = [nlu.ProposalRef(p.id, p.title, p.category, [p.proposer_label or "", p.recipient_label or ""]) for p in db.scalars(select(Proposal))]
        actors = [(r.label, r.address, r.kind) for r in db.scalars(select(AddressLabel))]
        _index.update(key=key, idx=nlu.EntityIndex(props, actors), at=time.time())
    return _index["idx"]


def _scope(intent: str) -> str:
    return nlu.model().meta.get(intent, {}).get("scope", "global")


def understand(db: Session | None, messages: list[dict[str, str]], context: dict[str, Any], depth: int = 0) -> Turn:
    text = (messages[-1]["content"] if messages else "").strip()
    ent = entity_index(db).extract(text)
    preds = nlu.model().predict(ent.masked, text, use_knn=depth == 0)
    intent, conf = preds[0]
    # Deterministic corrections where the entities settle the question.
    if len(ent.seqs) >= 2:
        intent = "ledger_connection"
    elif METHOD_Q.search(text) and intent in {"risk_evaluation", "treasury_impact", "execution_safety", "vote_result", "voting_power", "report_generate", "ledger_integrity"}:
        intent = "how_to"
    elif (ent.rules or ent.terms) and intent not in {"concept", "how_to", "findings"} and conf < 0.7:
        intent = "concept"
    if len(ent.proposals) >= 2 and _scope(intent) == "proposal" and intent != "followup_switch":
        intent = "compare"
    if ent.actors and not ent.proposals and intent in {"proposal_overview", "proposal_proposer", "proposal_recipient", "identity", "out_of_scope", "concept"}:
        intent = "actor_lookup"
    turn = Turn(text, intent, float(conf), preds[1:4], ent, history=messages, context=context or {})

    prev: Turn | None = None
    if depth == 0:
        idx = next((i for i in range(len(messages) - 2, -1, -1) if messages[i]["role"] == "user"), None)
        if idx is not None:
            prev = understand(db, messages[: idx + 1], context, depth=1)
    if intent == "followup_switch" and prev and prev.intent not in META | {"followup_switch", "elaborate"}:
        turn.intent = prev.intent
    elif intent == "followup_switch":
        turn.intent = "proposal_overview"
    if intent == "elaborate":
        if prev and prev.intent not in META:
            turn.intent, turn.deep = prev.intent, True
            turn.ent = prev.ent if not ent.proposals else ent
        elif (context or {}).get("proposal_id"):  # a bare "why?" on a proposal's page: explain its assessment
            turn.intent, turn.deep = "risk_evaluation", True
        else:
            turn.intent = "capabilities"

    # Which proposal: named in this message, else the last one named in the conversation (three
    # user turns back), else the page the user is on.
    page = (context or {}).get("proposal_id")
    page = str(page).upper() if page and tools.PID.fullmatch(str(page)) else None
    recent = None
    if depth == 0:
        idx_ = entity_index(db)
        for m in [m for m in messages[:-1] if m["role"] == "user"][-3:][::-1]:
            found = idx_.extract(m["content"]).proposals
            if found:
                recent = found[0]
                break
    if turn.ent.proposals:
        turn.pid, turn.pid_from = turn.ent.proposals[0], "message"
    elif recent:
        turn.pid, turn.pid_from = recent, "conversation"
    elif page:
        turn.pid, turn.pid_from = page, "page"
    return turn


# --------------------------------------------------------------------------- helpers
def _proposal_row(db: Session, pid: str) -> Proposal:
    p = db.get(Proposal, pid)
    if p is None:
        raise DomainError("not_found", f"Proposal {pid} does not exist.")
    return p


def _all(db: Session) -> list[dict[str, Any]]:
    return tools.list_proposals(db)["proposals"]


def _table(head: list[str], rows: list[list[str]]) -> str:
    out = ["| " + " | ".join(head) + " |", "|" + "|".join(["---"] * len(head)) + "|"]
    out += ["| " + " | ".join(str(c).replace("|", "/") for c in r) + " |" for r in rows]
    return "\n".join(out)


def _none_named() -> str:
    return "_No proposal named, so here is every proposal. Name one (an id, its number or a word from its title) for the details._"


def _guide(title: str) -> kb.Section | None:
    return next((s for s in kb.sections() if s.title == title), None)


def _guide_reply(sec: kb.Section, intro: str | None = None, related: list[str] | None = None) -> Reply:
    lines = [f"### {sec.title}", ""] + ([intro, ""] if intro else []) + [sec.body]
    if related:
        lines += ["", "Related: " + " · ".join(related)]
    return Reply("\n".join(lines), [_link(f"Open {sec.link}", sec.link)] if sec.link else [], [f"guide: {sec.title}"], engine="guide")


def _short(s: str, n: int = 220) -> str:
    s = re.sub(r"\s+", " ", s or "").strip()
    return s if len(s) <= n else s[: n - 1].rsplit(" ", 1)[0] + "…"


# --------------------------------------------------------------------------- composers
def h_overview(db, t: Turn, ctx, emit) -> Reply:
    if not t.pid:
        return h_list(db, t, ctx, emit)
    r = _r(offline._proposal_overview(db, t.pid))
    if t.deep:
        p = _proposal_row(db, t.pid)
        extra = []
        if p.purpose:
            extra += ["", f"**Purpose:** {_short(p.purpose, 300)}"]
        if p.milestones:
            extra += ["", "**Milestones**"] + [f"- Month {m.get('month')}: {m.get('title')}" for m in p.milestones]
        b = tools.get_proposal(db, t.pid)["brief"] or {}
        if b.get("questions_voters_should_ask"):
            extra += ["", "**Questions voters should ask**"] + [f"- {q if isinstance(q, str) else q.get('text', q)}" for q in b["questions_voters_should_ask"][:4]]
        r.text += "\n" + "\n".join(extra)
    return r


def h_amount(db, t: Turn, ctx, emit) -> Reply:
    if not t.pid:
        rows = sorted(_all(db), key=lambda p: -int(p["requested_base"] or 0))
        body = "### Requested amounts\n\n" + _table(["Proposal", "Request", "Status"], [[f"**{p['id']}** {_short(p['title'], 26)}", p["requested"], p["status"]] for p in rows])
        return Reply(body + "\n\n" + _none_named(), [_link("All proposals", "/proposals")], ["list_proposals"])
    p = tools.get_proposal(db, t.pid)
    imp = tools.get_treasury_impact(db, t.pid)
    lines = [f"### {t.pid} requests **{p['requested']}**", "",
             f"That is **{imp['share_of_treasury_pct']}%** of the on-chain treasury ({imp['treasury_balance_onchain']})." if p["requested"] != "0 mUSDC" else "It moves no funds: the payload changes code or parameters, not balances."]
    if p["milestones"]:
        lines += ["", f"Paid in {len(p['milestones'])} milestones:"] + [f"- Month {m['month']}: {m['amount'] or '—'} · {m['title']}" for m in p["milestones"]]
    for c in (p["brief"] or {}).get("contradictions") or []:
        if re.search(r"\d", c):
            lines += ["", f"⚠ **Sources disagree:** {_short(c, 240)}"]
            break
    lines += ["", f"Runway effect: {imp['runway_months_before']} → **{imp['runway_months_after']} months**."]
    return Reply("\n".join(lines), [_link("Treasury impact", f"/financial?p={t.pid}"), _link(f"Open {t.pid}", f"/proposals/{t.pid}")], ["get_proposal", "get_treasury_impact"])


def h_recipient(db, t: Turn, ctx, emit) -> Reply:
    if not t.pid:
        rows = [[f"**{p['id']}**", p["recipient"] or "—", p["requested"]] for p in _all(db)]
        return Reply("### Recipients\n\n" + _table(["Proposal", "Recipient", "Amount"], rows) + "\n\n" + _none_named(), [_link("Relationship explorer", "/relationships")], ["list_proposals"])
    p = _proposal_row(db, t.pid)
    if not p.recipient_address:
        return Reply(f"**{t.pid} has no recipient.** It is a {p.category} proposal; its payload changes contracts or parameters rather than paying anyone.", [_link(f"Open {t.pid}", f"/proposals/{t.pid}")], ["get_proposal"])
    c = tools.get_conflicts(db, t.pid)["conflict_findings"]
    lines = [f"### {t.pid} pays **{p.recipient_label}**", "", f"- Address: `{p.recipient_address}`", f"- Amount: **{tools.get_proposal(db, t.pid)['requested']}**"]
    try:
        a = tools.lookup_actor(db, p.recipient_address)
        lines.append(f"- Voting power: {a['voting_power']} ATLAS · {a['kind']}")
    except Exception:
        pass
    if c:
        lines += ["", f"**{len(c)} conflict-of-interest lead(s) involve the recipient:**"] + [f"- {_sev(f['severity'])} · {f['title']} `{f['rule']}`" for f in c[:3]]
        lines += ["", "_A transfer shows value moved between addresses, not common ownership._"]
    return Reply("\n".join(lines), [_link("Relationship explorer", f"/relationships?p={t.pid}"), _link(f"Open {t.pid}", f"/proposals/{t.pid}")], ["get_proposal", "get_conflicts"])


def h_proposer(db, t: Turn, ctx, emit) -> Reply:
    if not t.pid:
        rows = [[f"**{p['id']}**", p["proposer"], p["status"]] for p in _all(db)]
        return Reply("### Proposers\n\n" + _table(["Proposal", "Proposer", "Status"], rows) + "\n\n" + _none_named(), [], ["list_proposals"])
    p = _proposal_row(db, t.pid)
    others = [x.id for x in db.scalars(select(Proposal).where(Proposal.proposer_address == p.proposer_address, Proposal.id != p.id))]
    disclosed = db.scalar(select(func.count(AuditEvent.seq)).where(AuditEvent.proposal_id == p.id, AuditEvent.event_type == "disclosure_published"))
    lines = [f"### {t.pid} was proposed by **{p.proposer_label}**", "", f"- Address: `{p.proposer_address}`",
             f"- Conflict-of-interest disclosure: {'**signed and published**' if disclosed else '**missing**, which is itself a finding'}"]
    if others:
        lines.append(f"- Also proposed: {', '.join(others)}")
    return Reply("\n".join(lines), [_link(f"Open {t.pid}", f"/proposals/{t.pid}?tab=disclosure")], ["get_proposal"])


NEXT_STEP = {
    "draft": "It still needs a committed version and submission to the governor before anyone can vote.",
    "voting": "Voting is open; once it succeeds, the approved manifest goes to the ExecutionGuard with a review window.",
    "approved": "Governance approved it. After the review window, only the exact approved payload can execute, once.",
    "executed": "It has executed. The guard refuses any replay with AlreadyExecuted.",
    "halted": "A guardian or the sentinel halted it. Only a new version approved by a new vote can proceed.",
}


def h_status(db, t: Turn, ctx, emit) -> Reply:
    if not t.pid:
        rows = [[f"**{p['id']}**", p["status"], p["guard_status"]] for p in _all(db)]
        return Reply("### Where every proposal stands\n\n" + _table(["Proposal", "Status", "Guard"], rows) + "\n\n" + _none_named(), [_link("Overview", "/overview")], ["list_proposals"])
    p = tools.get_proposal(db, t.pid)
    g = p["governance"]
    lines = [f"### {t.pid} is **{p['status']}**", "", NEXT_STEP.get(p["status"], ""), "",
             f"- Governor state: {g['state'] or 'not submitted'}" + (f" · turnout {g['participation_pct']}%" if g.get("participation_pct") else ""),
             f"- ExecutionGuard: **{p['guard']['status']}**", f"- Current version: v{p['current_version']}"]
    return Reply("\n".join(lines), [_link(f"Open {t.pid}", f"/proposals/{t.pid}"), _link("Execution guardian", f"/guardian?p={t.pid}")], ["get_proposal"])


def h_purpose(db, t: Turn, ctx, emit) -> Reply:
    if not t.pid:
        rows = [[f"**{p['id']}**", _short(p["title"], 60)] for p in _all(db)]
        return Reply("### What each proposal is for\n\n" + _table(["Proposal", "Title"], rows) + "\n\n" + _none_named(), [], ["list_proposals"])
    p = _proposal_row(db, t.pid)
    lines = [f"### What {t.pid} is for", "", p.purpose or p.summary]
    for title, items in (("Stated benefits", p.benefits), ("Stated risks", p.risks), ("Assumptions", p.assumptions)):
        if items:
            lines += ["", f"**{title}**"] + [f"- {x if isinstance(x, str) else x.get('text', x)}" for x in items[:4]]
    lines += ["", "_These are the proposer's own statements; the findings tab shows which ones are evidenced._"]
    return Reply("\n".join(lines), [_link(f"Open {t.pid}", f"/proposals/{t.pid}")], ["get_proposal"])


def h_payouts(db, t: Turn, ctx, emit) -> Reply:
    if not t.pid:
        rows = [[f"**{p['id']}**", str(len(_proposal_row(db, p["id"]).milestones or [])) or "0", p["requested"]] for p in _all(db)]
        return Reply("### Milestones per proposal\n\n" + _table(["Proposal", "Milestones", "Total"], rows) + "\n\n" + _none_named(), [], ["list_proposals"])
    p = _proposal_row(db, t.pid)
    imp = tools.get_treasury_impact(db, t.pid, 0, "milestones")
    lines = [f"### How {t.pid} pays out", ""]
    if p.milestones:
        lines += [_table(["Month", "Milestone", "Amount", "Deliverable"], [[str(m.get("month")), m.get("title", ""), tools._usdc(m["amount_base"]) if m.get("amount_base") else "—", m.get("deliverable") or "—"] for m in p.milestones])]
    else:
        lines.append("No milestones are defined, so the model treats it as a single payment.")
    if p.budget_breakdown:
        lines += ["", "**Budget breakdown**"] + [f"- {b.get('item', b)}: {tools._usdc(b['amount_base']) if isinstance(b, dict) and b.get('amount_base') else ''}" for b in p.budget_breakdown]
    elif p.requested_amount_base not in ("0", None):
        lines += ["", "⚠ No itemised budget breakdown was provided (rule `MI-R001`)."]
    for issue in imp["schedule_issues"]:
        lines.append(f"- _Note: {issue}_")
    return Reply("\n".join(lines), [_link("Treasury impact with milestones", f"/financial?p={t.pid}")], ["get_treasury_impact"])


def h_risk(db, t: Turn, ctx, emit) -> Reply:
    if not t.pid:
        return h_ranking(db, t, ctx, emit)
    if t.deep:
        return _r(offline._evaluation(db, t.pid))
    ev = tools.get_evaluation(db, t.pid)
    pct_ = ev["combined_estimate_pct"]
    rating = "A" if pct_ < 10 else "B" if pct_ < 20 else "C" if pct_ < 35 else "D" if pct_ < 50 else "E" if pct_ < 70 else "F"
    top = max(ev["stages"], key=lambda s: s["estimate_pct"])
    drivers = sorted((e for s in ev["stages"] for e in s["evidence"] if e["direction"] == "raises"), key=lambda e: -e["likelihood_ratio"])[:3]
    lines = [f"### {t.pid}: **{pct_}%** combined estimate · rating **{rating}**", "",
             f"{'High' if pct_ >= 50 else 'Elevated' if pct_ >= 20 else 'Low'} concern. The biggest contributor is **{top['name']}** at {top['estimate_pct']}%.", "",
             _table(["Stage", "Estimate", "Band"], [[s["name"], f"{s['estimate_pct']}%", s["band"]] for s in ev["stages"]])]
    if drivers:
        lines += ["", "**What raises it most**"] + [f"- ×{d['likelihood_ratio']} · {d['factor']}" for d in drivers]
    lines += ["", "_A model estimate to direct attention, not a probability of fraud. Ask “why?” for every factor._"]
    return Reply("\n".join(lines), [_link("Evaluation chain", "/overview"), _link(f"Open {t.pid}", f"/proposals/{t.pid}")], ["get_evaluation"])


def h_findings(db, t: Turn, ctx, emit) -> Reply:
    if not t.pid:
        rows = []
        for p in _all(db):
            f = tools.get_findings(db, p["id"])["open_findings"]
            rows.append([f"**{p['id']}**", str(len(f)), _short(f[0]["title"], 60) if f else "—"])
        return Reply("### Open findings per proposal\n\n" + _table(["Proposal", "Open", "Most severe"], rows) + "\n\n" + _none_named(), [], ["get_findings"])
    if t.deep:
        return _r(offline._findings(db, t.pid))
    items = tools.get_findings(db, t.pid)["open_findings"]
    if not items:
        return Reply(f"**{t.pid} has no open findings.** Resolved and dismissed ones stay in its history.", [_link("Findings", f"/proposals/{t.pid}?tab=findings")], ["get_findings"])
    lines = [f"### {len(items)} open finding(s) on {t.pid}", ""]
    for x in items[:6]:
        lines.append(f"- **{_sev(x['severity'])}** · {x['title']} `{x['rule']}`" + (f"  \n  _Ask: {_short(x['ask'], 150)}_" if x["ask"] else ""))
    lines += ["", "_A missing item is a reason to ask, not evidence of wrongdoing. Say “why?” for the full explanations._"]
    return Reply("\n".join(lines), [_link("Findings", f"/proposals/{t.pid}?tab=findings"), _link("Ask the proposer", f"/proposals/{t.pid}?tab=qa")], ["get_findings"])


def h_execution(db, t: Turn, ctx, emit) -> Reply:
    if not t.pid:
        rows = []
        for p in _all(db):
            x = tools.get_execution_status(db, p["id"])
            v = x["recent_simulations"][0]["verdict"].upper() if x["recent_simulations"] else "—"
            rows.append([f"**{p['id']}**", x["guard"]["status"], v])
        return Reply("### Execution status of every proposal\n\n" + _table(["Proposal", "Guard", "Latest simulation"], rows) + "\n\n" + _none_named(), [_link("Execution guardian", "/guardian")], ["get_execution_status"])
    return _r(offline._execution(db, t.pid))


def h_treasury(db, t: Turn, ctx, emit) -> Reply:
    if not t.pid:
        return _r(offline._treasury_overview(db))
    # The composer reads "<n>%" and "milestone" from text; feed it the extracted entities so "30 percent" works too.
    text = f"{t.ent.pct or 0}% " + ("milestones" if t.ent.release == "milestones" else "")
    return _r(offline._treasury(db, t.pid, text))


def h_conflicts(db, t: Turn, ctx, emit) -> Reply:
    if not t.pid:
        rows = [[f"**{p['id']}**", str(len(tools.get_conflicts(db, p["id"])["conflict_findings"]))] for p in _all(db)]
        return Reply("### Conflict-of-interest leads\n\n" + _table(["Proposal", "Open leads"], rows) + "\n\n" + _none_named(), [_link("Relationship explorer", "/relationships")], ["get_conflicts"])
    return _r(offline._conflicts(db, t.pid))


def h_versions(db, t: Turn, ctx, emit) -> Reply:
    if not t.pid:
        rows = [[f"**{p['id']}**", f"v{_proposal_row(db, p['id']).current_version}"] for p in _all(db)]
        return Reply("### Versions\n\n" + _table(["Proposal", "Current"], rows) + "\n\n" + _none_named(), [_link("Version history", "/versions")], ["get_versions"])
    v = tools.get_versions(db, t.pid)
    if not v["versions"]:
        return Reply(f"**{t.pid} has no committed version yet**; it is still a draft.", [_link("Version history", f"/versions?p={t.pid}")], ["get_versions"])
    lines = [f"### {t.pid} has {len(v['versions'])} committed version(s)", ""]
    for x in v["versions"]:
        lines.append(f"- **v{x['version']}** · {x['committed_at'][:10]} by {x['author']}" + (" · on-chain" if x["on_chain_tx"] else "") + (f" · {_short(x['change_note'], 120)}" if x["change_note"] else ""))
    if v["latest_changes"]:
        lines += ["", f"**What changed in v{v['versions'][-1]['version']}**"] + [f"- {_short(c['summary'], 160)}" for c in v["latest_changes"][:6]]
        if any(c["category"] in ("implementation", "calldata", "manifest") for c in v["latest_changes"]):
            lines += ["", "⚠ The executable payload changed, so earlier reviews and votes may not cover it."]
    return Reply("\n".join(lines), [_link("Compare versions", f"/versions?p={t.pid}")], ["get_versions"])


def h_evidence(db, t: Turn, ctx, emit) -> Reply:
    if not t.pid:
        rows = [[f"**{p['id']}**", str(len(_proposal_row(db, p["id"]).evidence))] for p in _all(db)]
        return Reply("### Evidence per proposal\n\n" + _table(["Proposal", "Documents"], rows) + "\n\n" + _none_named(), [], ["get_evidence"])
    e = tools.get_evidence(db, t.pid)
    if not e["documents"]:
        return Reply(f"**No evidence is attached to {t.pid}.** That is a finding in itself (rule `MI-R009`).", [_link("Evidence", e["page"])], ["get_evidence"])
    rows = [[d["name"], d["type"], d["verification"], "⚠ " + str(d["prompt_injection_flags"]) if d["prompt_injection_flags"] else "—"] for d in e["documents"]]
    return Reply(f"### Evidence attached to {t.pid}\n\n" + _table(["Document", "Type", "Verification", "Injection flags"], rows) + f"\n\n_{e['note']}_", [_link("Evidence tab", e["page"])], ["get_evidence"])


def h_qa(db, t: Turn, ctx, emit) -> Reply:
    if not t.pid:
        rows = []
        for p in _all(db):
            c = tools.get_questions(db, p["id"])["counts"]
            rows.append([f"**{p['id']}**", str(c["open"] + c["needs_more"]), str(c["answered"]), str(c["accepted"])])
        return Reply("### Proposer Q&A\n\n" + _table(["Proposal", "Awaiting proposer", "Awaiting review", "Accepted"], rows) + "\n\n" + _none_named(), [], ["get_questions"])
    q = tools.get_questions(db, t.pid)
    if not q["questions"]:
        return Reply(f"**No questions have been asked on {t.pid} yet.** Turn any finding into a question on the Q&A tab.", [_link("Q&A", q["page"])], ["get_questions"])
    lines = [f"### Q&A on {t.pid}", ""]
    for x in q["questions"][:6]:
        lines.append(f"- **{x['status'].replace('_', ' ')}** · {_short(x['question'], 140)}" + (f"  \n  Latest: _{_short(x['latest'], 150)}_" if x["latest"] else ""))
    return Reply("\n".join(lines), [_link("Open Q&A", q["page"])], ["get_questions"])


def h_votes(db, t: Turn, ctx, emit) -> Reply:
    if not t.pid:
        vp = tools.get_voting_power(db)
        rows = [[f"**{x['proposal']}**", x["state"], f"{x['participation_pct']}%"] for x in vp["proposals"]]
        return Reply("### Votes on every proposal\n\n" + _table(["Proposal", "State", "Turnout"], rows) + "\n\n" + _none_named(), [_link("Voting", "/voting")], ["get_voting_power"])
    v = tools.get_votes(db, t.pid)
    if not v["votes"]:
        return Reply(f"**{t.pid} has not been put to a vote yet** (status {v['governance_status']}).", [_link("Voting", v["page"])], ["get_votes"])
    q = t.text.lower()
    ends = f"Voting ends at block {v['deadline_block']}, {v['blocks_remaining']} blocks from now." if v.get("blocks_remaining") else f"Voting closed at block {v['deadline_block']}."
    turnout = f"Turnout was **{v['participation_pct']}%** and quorum was **{'reached' if v['quorum_reached'] else 'not reached'}** (4% of supply must vote for or abstain)."
    # Lead with the part of the vote the question is about, then the full picture.
    lead = ends if re.search(r"\b(when|deadline|end|ends|close|closes|over)\b", q) else turnout if re.search(r"turnout|quorum|participat", q) else None
    lines = [f"### Vote on {t.pid}: {v['state']}", ""] + ([lead, ""] if lead else []) + [
             f"- For **{v['votes']['for']}** · against **{v['votes']['against']}** · abstain {v['votes']['abstain']} ATLAS",
             f"- Turnout **{v['participation_pct']}%** · quorum {'reached' if v['quorum_reached'] else 'not reached'}" + (f" · {v['unique_voters']} of {v['eligible_voters']} eligible voters" if v.get("unique_voters") else "")]
    if not lead or lead is turnout:
        lines.append(f"- {ends}")
    voters = v["top_voters"] if t.deep else v["top_voters"][:4]
    side = "against" if "against" in q else "for" if re.search(r"\bvoted for\b|\bin favou?r\b", q) else None
    if side:
        voters = [x for x in v["top_voters"] if x["support"] == side] or voters
    if voters:
        lines += ["", f"**{'Voters ' + side if side else 'Largest voters'}**"] + [f"- {x['voter']}: **{x['support']}** with {x['votes']}" + (f" · _{_short(x['reason'], 80)}_" if x.get("reason") else "") for x in voters]
    flagged = [s for s in v["risk_signals"] if s.get("level") not in ("none", "ok", "info", "pass")]
    for s in flagged[:2]:
        lines += ["", f"⚠ **{s['title']}:** {_short(s['detail'], 220)}"]
    if not flagged:
        lines += ["", "No decisive-voter, delegated-power or timing patterns were flagged."]
    return Reply("\n".join(lines), [_link("Voting analysis", v["page"])], ["get_votes"])


def h_vote_advice(db, t: Turn, ctx, emit) -> Reply:
    if not t.pid:
        return Reply("I don't recommend votes: that's your call as a voter. Name a proposal and I'll lay out what to weigh, for and against, from its evidence.", [], [])
    p = tools.get_proposal(db, t.pid)
    ev = tools.get_evaluation(db, t.pid)
    f = p["open_findings"]
    lines = [f"### What to weigh on {t.pid}", "", "I don't tell people how to vote. Here is what the evidence says on each side.", ""]
    pros = [f"Requests {p['requested']}; " + (p["brief"]["summary"][0][:160] if p["brief"] and p["brief"]["summary"] else p["summary"][:160])]
    if p["guard"]["status"] in ("approved", "none"):
        pros.append("Only the exact approved payload can execute, once; tampered variants revert on-chain.")
    cons = [f"{_sev(x['severity'])}: {x['title']}" for x in f[:4]]
    lines += ["**In favour**"] + [f"- {x}" for x in pros] + ["", "**Concerns to resolve first**"] + ([f"- {x}" for x in cons] or ["- No open findings."])
    lines += ["", f"The evaluation chain puts the combined estimate at **{ev['combined_estimate_pct']}%** (a model estimate, not a verdict)."]
    if any(x["severity"] in ("high", "critical") for x in f):
        lines.append("A reasonable step is to ask the proposer about the high-severity items before voting.")
    return Reply("\n".join(lines), [_link("Ask the proposer", f"/proposals/{t.pid}?tab=qa"), _link(f"Open {t.pid}", f"/proposals/{t.pid}")], ["get_proposal", "get_evaluation"])


def h_voting_power(db, t: Turn, ctx, emit) -> Reply:
    v = tools.get_voting_power(db)
    d = v["definitions"]
    lines = ["### Voting-power concentration in Atlas DAO", "",
             f"- Largest holder: **{v['top1_pct']}%** · top three: **{v['top3_pct']}%** of delegated power",
             f"- Nakamoto coefficient: **{v['nakamoto_coefficient']}** (delegates needed to pass 50%)",
             f"- Gini: **{v['gini']}** · HHI: **{v['hhi']}** ({v['hhi_band']}) across {v['holders_with_power']} holders", "",
             _table(["Holder", "Voting power", "Role"], [[x["holder"], x["voting_power"], x["role"] or "—"] for x in v["largest_holders"][:6]])]
    if t.deep or re.search(r"\b(what is|meaning|define|explain)\b", t.text, re.I):
        lines += ["", "**What the metrics mean**"] + [f"- **{k.replace('_', ' ')}**: {_short(val, 200)}" for k, val in d.items() if k in ("nakamoto", "gini", "hhi", "top_share")]
    return Reply("\n".join(lines), [_link("Voting analysis", "/voting")], ["get_voting_power"])


def h_actor(db, t: Turn, ctx, emit) -> Reply:
    name = t.ent.actors[0] if t.ent.actors else re.sub(r"^(who|what)\s+is\s+|^tell me about\s+|\?$", "", t.text, flags=re.I).strip()
    a = tools.lookup_actor(db, name)
    role = a.get("role") if a.get("role") and "_" not in str(a.get("role")) and not re.fullmatch(r"[a-z]\d+", str(a.get("role"))) else None
    lines = [f"### {a['label']}", "", f"- Address: `{a['address']}` · {a['kind']}" + (f" · {role}" if role else ""),
             f"- Voting power: **{a['voting_power']} ATLAS** · balances: " + ", ".join(f"{v} {k}" for k, v in (a.get("balances") or {}).items())]
    if a["proposals"]:
        lines.append("- Proposals: " + ", ".join(f"{x['role']} of {x['proposal']}" for x in a["proposals"]))
    if a["votes"]:
        lines += ["", "**Votes cast**"] + [f"- {x['proposal']}: {_short(x['summary'], 120)}" for x in a["votes"][:5]]
    lines += ["", f"{a['relationships']} relationship edge(s) in the graph. _{a['note']}_"]
    return Reply("\n".join(lines), [_link("Show in relationship explorer", a["page"])], ["lookup_actor"])


def h_ranking(db, t: Turn, ctx, emit) -> Reply:
    items = _all(db)
    txt = t.text.lower()
    if re.search(r"biggest|largest|most expensive|most money|asks? for the most|amount|ask\b", txt):
        items.sort(key=lambda p: -int(p["requested_base"] or 0))
        title, col, val = "Proposals by requested amount", "Request", lambda p: p["requested"]
    elif re.search(r"safest|least risky|lowest risk|best", txt):
        items.sort(key=lambda p: p["combined_estimate_pct"])
        title, col, val = "Proposals from lowest to highest estimate", "Estimate", lambda p: f"{p['combined_estimate_pct']}%"
    elif re.search(r"most findings|most issues|most problematic", txt):
        items.sort(key=lambda p: -sum(p["open_findings_by_severity"].values()))
        title, col, val = "Proposals by open findings", "Open findings", lambda p: str(sum(p["open_findings_by_severity"].values()))
    else:
        items.sort(key=lambda p: -p["combined_estimate_pct"])
        title, col, val = "Proposals ranked by the evaluation chain", "Estimate", lambda p: f"{p['combined_estimate_pct']}%"
    rows = [[str(i), f"**{p['id']}** {_short(p['title'], 22)}", val(p), p["status"]] for i, p in enumerate(items, 1)]
    top = items[0]
    body = (f"### {title}\n\n" + _table(["#", "Proposal", col, "Status"], rows)
            + f"\n\nStart with **{top['id']}**: its riskiest stage is {top['riskiest_stage']}. _The estimate is a model estimate, not a probability of fraud._")
    return Reply(body, [_link(f"Open {top['id']}", f"/proposals/{top['id']}"), _link("Overview", "/overview")], ["list_proposals"])


def h_compare(db, t: Turn, ctx, emit) -> Reply:
    ids = t.ent.proposals if len(t.ent.proposals) >= 2 else [p["id"] for p in _all(db)]
    by = {p["id"]: p for p in _all(db)}
    ids = [i for i in ids if i in by]
    head = ["", *ids]
    rows = [["Title", *[_short(by[i]["title"], 30) for i in ids]], ["Status", *[by[i]["status"] for i in ids]], ["Request", *[by[i]["requested"] for i in ids]],
            ["Combined estimate", *[f"**{by[i]['combined_estimate_pct']}%**" for i in ids]], ["Riskiest stage", *[by[i]["riskiest_stage"] for i in ids]],
            ["Open findings", *[str(sum(by[i]["open_findings_by_severity"].values())) for i in ids]], ["Guard", *[by[i]["guard_status"] for i in ids]]]
    riskiest = max(ids, key=lambda i: by[i]["combined_estimate_pct"])
    return Reply(f"### Comparing {', '.join(ids)}\n\n" + _table(head, rows) + f"\n\n**{riskiest}** carries the highest combined estimate.", [_link(f"Open {riskiest}", f"/proposals/{riskiest}")], ["list_proposals"])


def h_list(db, t: Turn, ctx, emit) -> Reply:
    items = _all(db)
    rows = [[f"**{p['id']}** {_short(p['title'], 26)}", p["status"], p["requested"], f"{p['combined_estimate_pct']}%"] for p in items]
    return Reply(f"### {len(items)} proposals in Atlas DAO\n\n" + _table(["Proposal", "Status", "Request", "Estimate"], rows) + "\n\nAsk about any of them by id, number or name, for example “how risky is northstar?”.", [_link("Proposals", "/proposals")], ["list_proposals"])


def h_treasury_overview(db, t: Turn, ctx, emit) -> Reply:
    return _r(offline._treasury_overview(db))


def h_alerts(db, t: Turn, ctx, emit) -> Reply:
    a = tools.get_alerts(db, t.pid if t.pid_from == "message" else None)
    if not a["open_alerts"]:
        return Reply("**No open alerts.** Nothing needs a human decision right now.", [_link("Risk escalation", "/escalation")], ["get_alerts"])
    s = a["by_severity"]
    lines = [f"### {len(a['open_alerts'])} open alert(s)", "", " · ".join(f"**{n}** {k}" for k, n in s.items() if n), ""]
    for x in a["open_alerts"][:7]:
        lines.append(f"- **{_sev(x['severity'])}** · {x['title']} ({x['proposal'] or 'system'}, {x['status']}" + (f", owner {x['assignee']}" if x["assignee"] else ", no owner") + ")")
    lines += ["", "Each alert has a response playbook on the Risk escalation page: acknowledge, assign, investigate, record the outcome."]
    return Reply("\n".join(lines), [_link("Risk escalation", "/escalation")], ["get_alerts"])


def h_activity(db, t: Turn, ctx, emit) -> Reply:
    return _r(offline._activity(db, None))


def h_timeline(db, t: Turn, ctx, emit) -> Reply:
    if not t.pid:
        return h_activity(db, t, ctx, emit)
    a = tools.get_recent_activity(db, 12 if t.deep else 8, t.pid)
    lines = [f"### Timeline of {t.pid} (newest first)", ""] + [f"- **{e['when'][:10]}** · {e['type'].replace('_', ' ')}" + (" · chain-confirmed" if e["verification"] == "chain-confirmed" else "") + f"  \n  {_short(e['summary'], 150)}" for e in a["recent_events"]]
    return Reply("\n".join(lines), [_link("Audit timeline", f"/audit?proposal={t.pid}")], ["get_recent_activity"])


def h_ledger_integrity(db, t: Turn, ctx, emit) -> Reply:
    emit("status", {"text": "Re-hashing the audit ledger…"})
    v = tools.verify_ledger(db)
    head = "**Intact.**" if v["intact"] else f"**Broken: {v['broken_links']} link(s) fail.**"
    lines = [f"### Audit ledger: {head}", "", f"- {v['events']} events re-hashed in order", f"- {v['receipts_confirmed']}/{v['receipts_checked']} transaction receipts re-confirmed on the node"]
    if v["anchors"]:
        lines.append(f"- {sum(1 for a in v['anchors'] if a['on_chain'] and a['matches'])}/{len(v['anchors'])} on-chain anchors match the recomputed ledger")
    for b in v["breaks"][:3]:
        lines.append(f"- ⚠ #{b['seq']}: {b['problem']}")
    lines += ["", f"_{v['note']}_ This check was read-only; the Verify button on the Audit page also records it in the ledger."]
    return Reply("\n".join(lines), [_link("Audit timeline", "/audit")], ["verify_ledger"])


def h_ledger_connection(db, t: Turn, ctx, emit) -> Reply:
    if len(t.ent.seqs) < 2:
        sec = _guide("Audit ledger and verification")
        return Reply("Name two ledger events by number, for example “how are #5 and #18 connected?”. On the Audit timeline you can also drag a string between any two events.", [_link("Audit timeline", "/audit")], [f"guide: {sec.title}"] if sec else [])
    c = tools.get_ledger_connection(db, t.ent.seqs[0], t.ent.seqs[1])
    secs = c["seconds_apart"]
    gap = f"{secs // 86400}d {secs % 86400 // 3600}h" if secs >= 86400 else f"{secs // 3600}h {secs % 3600 // 60}m" if secs >= 3600 else f"{secs // 60}m {secs % 60}s"
    lines = [f"### #{c['from']['seq']} {c['from']['type'].replace('_', ' ')} → #{c['to']['seq']} {c['to']['type'].replace('_', ' ')}", "",
             f"**{c['strength'].capitalize()}** connection: {c['ledger_links_between']} ledger links and {gap} apart."]
    if c["shared"]:
        lines += ["", "**What they share**"] + [f"- {s}" for s in c["shared"]]
    lines += ["", f"Segment check: {'✓ intact' if c['segment_intact'] else '✗ broken'}, {c['segment_events']} events re-hashed, {c['receipts_rechecked']} receipts re-checked.",
              "", f"- #{c['from']['seq']}: {_short(c['from']['summary'], 140)}", f"- #{c['to']['seq']}: {_short(c['to']['summary'], 140)}"]
    return Reply("\n".join(lines), [_link("Audit timeline", "/audit")], ["get_ledger_connection"])


NAMED_PAGES = [(r"landing|home ?page|start page|front page", "Landing page"), (r"overview|dashboard", "Overview page"), (r"proposals?", "Proposals workspace"),
               (r"relationship|graph", "Relationships and conflicts of interest"), (r"financial|treasury", "Financial impact and treasury model"), (r"voting|delegates?", "Voting and delegates"),
               (r"guardian|execution", "Execution guardian"), (r"audit|ledger|timeline", "Audit ledger and verification"), (r"escalation|alerts?", "Risk escalation"),
               (r"reports?|compliance|export", "Reports and export"), (r"settings", "Settings and risk model")]


def h_page_help(db, t: Turn, ctx, emit) -> Reply:
    path = (ctx or {}).get("path") or "/"
    named = next((sec for pat, sec in NAMED_PAGES if re.search(rf"\b(?:{pat})\b(?:\s+\w+)?\s+(?:page|screen)\b|\bthe\s+(?:{pat})\b", t.text, re.I)), None)
    title = named or next((sec for prefix, sec in PAGE_GUIDE if path == prefix or (prefix != "/" and path.startswith(prefix))), "Overview page")
    if named:  # a page the user named, not necessarily the one they are on
        sec = _guide(named)
        return _guide_reply(sec) if sec else Reply("That page is part of DAOGuard.")
    sec = _guide(title)
    live = ""
    try:
        if path.startswith("/escalation"):
            live = f"Right now there are **{len(tools.get_alerts(db)['open_alerts'])} open alerts**."
        elif path.startswith("/audit"):
            live = f"The ledger holds **{db.scalar(select(func.count(AuditEvent.seq)))} events**. Drag from one event to another on the graph to tie a string and verify the hash links between them."
        elif path.startswith("/proposals") and t.pid:
            live = f"You're looking at **{t.pid}** ({tools.get_proposal(db, t.pid)['status']})."
        elif path.startswith("/reports"):
            live = f"**{db.scalar(select(func.count(Report.id)))} report(s)** generated so far; the readiness score shows its working."
    except Exception:
        pass
    return _guide_reply(sec, live or None) if sec else Reply("This page is part of DAOGuard. Ask me what you'd like to do here.")


GENERAL_TERMS: dict[str, tuple[str, str]] = {
    "dao": ("DAO", "A decentralised autonomous organisation: a group that governs a shared treasury and rules by token-weighted votes recorded on a blockchain. In this demo, Atlas DAO votes with ATLAS tokens and holds mUSDC in a treasury that only the ExecutionGuard can move."),
    "quorum": ("Quorum", "The minimum share of voting power that must take part (FOR or ABSTAIN) for a vote to count. Atlas DAO uses 4% of ATLAS supply; DAOGuard flags thin margins and concentrated turnout."),
    "delegat": ("Delegation", "Token holders can lend their voting power to a delegate without moving tokens. DAOGuard tracks who delegates to whom, because a recipient delegating to a voter on its own grant is a conflict signal (COI-R005)."),
    "multisig": ("Multisig", "A wallet that needs several of its owners to sign before a transaction goes through. Recipients in the demo, such as Wallet A, are labelled multisigs; labels are annotations, not identity proof."),
    "eip-712": ("EIP-712", "An Ethereum standard for signing structured, typed data so a signature binds exact fields. DAOGuard hashes each manifest (chain id, guard, proposal key, version and every action) with EIP-712; governance approves that digest and the guard recomputes it before executing."),
    "eip712": ("EIP-712", "An Ethereum standard for signing structured, typed data so a signature binds exact fields. DAOGuard hashes each manifest with EIP-712; governance approves that digest and the guard recomputes it before executing."),
    "eip 712": ("EIP-712", "An Ethereum standard for signing structured, typed data so a signature binds exact fields. DAOGuard hashes each manifest with EIP-712; the guard recomputes the digest before executing."),
    "calldata": ("Calldata", "The encoded function call a transaction carries: which function to run and with which arguments. Changing one byte of it changes the manifest digest, so the guard refuses it."),
    "manifest": ("Manifest", "The exact list of actions a proposal will execute (target, value, calldata, operation), bound to the chain, guard, proposal and version. Voters approve its EIP-712 digest."),
    "merkle": ("Merkle root", "A single hash that commits to a whole set of documents. DAOGuard commits each version's evidence as a Merkle root, so any single document can later be proven to be part of it."),
    "bytecode": ("Bytecode", "The compiled machine code of a smart contract. DAOGuard diffs the bytecode of an upgrade and simulates it, because the source a voter reads may differ from what is deployed."),
    "proxy": ("Proxy upgrade", "A proxy contract forwards calls to an implementation contract that can be swapped. Upgrading it changes the code behind the same address, which is why GOV-043's new implementation is simulated before execution."),
    "delegatecall": ("DELEGATECALL", "A call that runs another contract's code with the caller's own storage and permissions. The ExecutionGuard never performs one (UnsupportedOperation), because it would hand the treasury's powers to foreign code."),
    "governor": ("Governor contract", "The on-chain contract that runs proposals and votes. Atlas Governor counts ATLAS votes at a snapshot block and, on success, approves the manifest on the ExecutionGuard."),
    "timelock": ("Timelock", "A delay between approval and execution so people can react. DAOGuard's equivalent is the review window: blocks in which the sentinel simulates the approved manifest and can halt it."),
    "gas": ("Gas", "The fee paid to run computation on Ethereum. In this local demo chain gas is free and fictional."),
    "smart contract": ("Smart contract", "A program deployed on a blockchain that holds state and runs exactly as written. DAOGuard's contracts are the ProposalRegistry, ExecutionGuard, Atlas Governor and the demo FeeVault."),
    "ethereum": ("Ethereum", "A public blockchain that runs smart contracts. DAOGuard runs on a local Ethereum-compatible Hardhat chain so every check and revert here is a real transaction."),
    "sybil": ("Sybil attack", "One party posing as many participants, for example by splitting tokens across wallets. DAOGuard can only show observed links between addresses (transfers, shared funders); it never claims two addresses share an owner."),
    "reentrancy": ("Reentrancy", "A bug where a contract is called back before it finishes updating its state, letting an attacker repeat a withdrawal. Bytecode simulation looks for unexpected external calls like this."),
    "rug pull": ("Rug pull", "When insiders drain funds they control. DAOGuard's guard limits this for the treasury: only the exact approved actions can run, once."),
    "musdc": ("mUSDC", "The demo's fictional stablecoin (6 decimals) held by the Atlas treasury. It has no value."),
    "atlas token": ("ATLAS", "The demo DAO's fictional governance token; voting power is ATLAS delegated at each proposal's snapshot block."),
    "treasury": ("Treasury", "The DAO's shared funds. In the demo the ExecutionGuard itself holds the mUSDC, so nothing leaves it except an approved manifest."),
    "runway": ("Runway", "How many months the available balance lasts at the net monthly burn. DAOGuard subtracts pending approvals, other commitments and payouts before projecting it."),
    "hash": ("Hash", "A fixed-length fingerprint of data; any change gives a different hash. DAOGuard chains every ledger event's hash to the previous one, so editing history breaks the chain."),
    "prompt injection": ("Prompt injection", "Text in a document that tries to give instructions to an AI reviewer, such as “ignore previous instructions”. DAOGuard flags it (INJ-R001) and treats document text strictly as data."),
    "token weighted": ("Token-weighted voting", "Each vote counts in proportion to voting power, so large holders weigh more. DAOGuard measures concentration with the Nakamoto coefficient, Gini and HHI."),
}


def h_concept(db, t: Turn, ctx, emit) -> Reply:
    term = offline._term(t.text)
    if term:
        return _r(term)
    low = t.text.lower()
    hit = max((k for k in GENERAL_TERMS if re.search(rf"\b{re.escape(k)}(?:s|e|es|ed|ing|ion|ions)?\b", low)), key=len, default=None)
    if hit:
        name, definition = GENERAL_TERMS[hit]
        return Reply(f"### {name}\n\n{definition}", [], [f"term: {name}"], engine="guide")
    hits = semantic.search(t.text, k=3)
    if hits and hits[0][0] >= (0.62 if local_llm.status()["chat"] else 0.45):
        return _guide_reply(hits[0][1], related=[s.title for sc, s in hits[1:] if sc >= hits[0][0] * 0.7])
    return llm_or_fallback(db, t, ctx, emit, hits)


def h_how_to(db, t: Turn, ctx, emit) -> Reply:
    hits = semantic.search(t.text, k=3)
    if hits and hits[0][0] >= 0.42:
        return _guide_reply(hits[0][1], related=[s.title for sc, s in hits[1:] if sc >= hits[0][0] * 0.75])
    if re.search(r"\b(this|here)\b", t.text, re.I):
        return h_page_help(db, t, ctx, emit)
    return llm_or_fallback(db, t, ctx, emit, hits)


def h_emergency(db, t: Turn, ctx, emit) -> Reply:
    if not t.pid:
        return Reply("Name the proposal you want to stop. I can't halt anything myself (I'm read-only), but I'll tell you whether a halt is possible and where to do it.", [_link("Risk escalation", "/escalation")], [])
    x = tools.get_execution_status(db, t.pid)
    g = x["guard"]["status"]
    what = {"approved": f"**A halt is possible.** {t.pid} has an approval on the ExecutionGuard. A guardian can block it permanently: open its alert on the Risk escalation page → Emergency actions → Force halt, type {t.pid} to confirm.",
            "halted": f"**{t.pid} is already halted** on-chain. Execution fails with ProposalIsHalted; only a new version approved by a new vote can run.",
            "executed": f"**{t.pid} already executed**, so there is nothing left to halt. You can still file a cryptographic dispute from Emergency actions.",
            "none": f"**There is nothing to halt yet:** {t.pid} has no approval on the guard, so any execution attempt reverts with NotApproved. You can file a dispute or notify delegates from Emergency actions."}
    lines = [f"### Stopping {t.pid}", "", what.get(g, f"Guard status: {g}."), "", "I can only read data. Guardians can block an approval but never approve, alter or execute one."]
    return Reply("\n".join(lines), [_link("Risk escalation", f"/escalation?p={t.pid}")], ["get_execution_status"])


def h_report(db, t: Turn, ctx, emit) -> Reply:
    if re.search(r"\b(what|mean|means|meaning|explain|how is|how are|why)\b", t.text, re.I):  # "what does the readiness score mean"
        hits = semantic.search(t.text, k=2)
        if hits and hits[0][0] >= 0.45:
            return _guide_reply(hits[0][1])
    n = db.scalar(select(func.count(Report.id)))
    sec = _guide("Reports and export")
    lines = ["### Audit and compliance reports", "", "On the Compliance page, use the report builder: pick " + (f"**{t.pid}**" if t.pid else "a proposal") + ", a format (PDF, JSON or CSV) and the sections to include, then Generate & download.",
             "", f"{n} report(s) generated so far. Each file's SHA-256 goes into the audit ledger, so a copy can be checked later.", "",
             "Reports include evidence labels (chain-confirmed or off-chain), a demo-data notice, chain and block context, and the limits of every method."]
    return Reply("\n".join(lines), [_link("Report builder", "/reports")], [f"guide: {sec.title}"] if sec else [])


def h_settings(db, t: Turn, ctx, emit) -> Reply:
    p = tools.get_policy(db)
    lrs = p["likelihood_ratios"] or {}
    lines = ["### Policy and risk model", "", f"- Auto-halt on a BLOCK simulation verdict: **{'on' if p['auto_halt_on_block_verdict'] else 'off'}**",
             "- Stage priors: " + ", ".join(f"{k} {round(v * 100)}%" for k, v in (p["priors"] or {}).items()), "",
             "**Strongest likelihood ratios**"] + [f"- {k}: ×{v}" for k, v in sorted(lrs.items(), key=lambda kv: -kv[1])[:6]]
    lines += ["", _short(p["description"] or "", 300), "", "Change them on the Settings page; every change is recorded in the ledger."]
    return Reply("\n".join(lines), [_link("Settings", "/settings")], ["get_policy"])


def h_greeting(db, t: Turn, ctx, emit) -> Reply:
    hello = random.choice(["Hi!", "Hello!", "Hey there!"])
    where = f" You're on **{t.pid}**, so I can start there." if t.pid and t.pid_from == "page" else ""
    return Reply(f"{hello} I'm the DAOGuard assistant. I read this prototype's live data: proposals, risks, votes, the treasury, execution checks and the audit ledger.{where}\n\nAsk in your own words, even briefly: “risk?”, “who gets the money”, “votes on 43”, “why?”.", [], ["assistant"])


def h_thanks(db, t: Turn, ctx, emit) -> Reply:
    return Reply(random.choice(["Glad that helped.", "Any time.", "You're welcome."]) + " Anything else you'd like to check?", [], [])


def h_goodbye(db, t: Turn, ctx, emit) -> Reply:
    return Reply("Bye for now. Press **Ctrl+J** any time to open me again.", [], [])


def h_capabilities(db, t: Turn, ctx, emit) -> Reply:
    return Reply(offline.CAPABILITIES + "\n\nShort questions work too: I use the page you're on and our conversation for context, and “why?” or “and 43?” continue the last answer.", [], ["assistant"])


def h_identity(db, t: Turn, ctx, emit) -> Reply:
    st = local_llm.status()
    rep = nlu.model().report
    llm = f" Open-ended questions go to **{st['chat_model']}**, an open-source model running in Ollama on this computer." if st["chat"] else ""
    emb = f" Meaning-based search uses **{st['embed_model']}**, also local." if st["embed"] else ""
    return Reply(f"### About me\n\nI'm DAOGuard's built-in assistant, and I run entirely on this machine. A **locally trained intent model** ({rep.get('intents', '?')} intents, {rep.get('training_samples', '?')} training samples) understands the question, and focused composers answer from the app's live data.{emb}{llm}\n\nNothing you type leaves this computer. I'm read-only: I never vote, execute, halt or change settings.", [], ["assistant"])


HANDLERS: dict[str, Callable[..., Reply]] = {
    "greeting": h_greeting, "thanks": h_thanks, "goodbye": h_goodbye, "capabilities": h_capabilities, "identity": h_identity,
    "proposal_overview": h_overview, "proposal_amount": h_amount, "proposal_recipient": h_recipient, "proposal_proposer": h_proposer,
    "proposal_status": h_status, "proposal_purpose": h_purpose, "proposal_payouts": h_payouts, "risk_evaluation": h_risk, "findings": h_findings,
    "execution_safety": h_execution, "treasury_impact": h_treasury, "conflicts": h_conflicts, "versions_changes": h_versions, "evidence_docs": h_evidence,
    "qa_status": h_qa, "vote_result": h_votes, "vote_advice": h_vote_advice, "voting_power": h_voting_power, "actor_lookup": h_actor,
    "ranking": h_ranking, "compare": h_compare, "list_proposals": h_list, "treasury_overview": h_treasury_overview, "alerts": h_alerts,
    "recent_activity": h_activity, "proposal_timeline": h_timeline, "ledger_integrity": h_ledger_integrity, "ledger_connection": h_ledger_connection,
    "page_help": h_page_help, "concept": h_concept, "how_to": h_how_to, "emergency_action": h_emergency, "report_generate": h_report,
    "settings_policy": h_settings,
}


# --------------------------------------------------------------------------- local LLM
SYSTEM_LLM = (
    "You are the DAOGuard assistant, running offline on this computer as an open-source model. DAOGuard is a governance-intelligence and "
    "execution-assurance prototype for DAO proposals; all its data is fictional demo data (Atlas DAO, ATLAS votes, mUSDC treasury). "
    "Answer in friendly, clear markdown in at most 160 words. For anything about DAOGuard use only the CONTEXT and never invent DAOGuard numbers, ids or outcomes. "
    "For general questions answer briefly from general knowledge; you have no internet, so never present prices, news, weather or dates as current. "
    "You are read-only: never claim to vote, execute, halt or change anything. If unsure, say so."
)
_NUM = re.compile(r"\d+(?:[.,]\d+)*")


def llm_answer(t: Turn, emit: Emit, hits: list[tuple[float, kb.Section]] | None = None) -> Reply | None:
    st = local_llm.status()
    if not st["chat"]:
        return None
    ctx = "\n\n".join(f"[{s.title}] {_short(s.body, 520)}" for sc, s in (hits or [])[:2] if sc >= 0.25)
    msgs: list[dict[str, str]] = [{"role": "system", "content": SYSTEM_LLM}]
    prior = [m for m in t.history[:-1]][-2:]
    msgs += [{"role": m["role"], "content": _short(m["content"], 320)} for m in prior]
    msgs.append({"role": "user", "content": f"CONTEXT:\n{ctx}\n\nQUESTION: {t.text}" if ctx else t.text})
    emit("status", {"text": f"Thinking with the local model ({st['chat_model']})…"})
    text = local_llm.chat_stream(msgs, lambda tok: emit("delta", {"text": tok}))
    if not text:
        return None
    known = set(_NUM.findall(ctx + " " + t.text))
    loose = [n for n in _NUM.findall(text) if n not in known and len(n.replace(",", "").replace(".", "")) >= 2]
    note = ""
    if loose and ctx:
        note = "\n\n_Figures above come from a local language model, not from DAOGuard's data; check them in the app._"
    note += f"\n\n_Answered by {st['chat_model']} running locally{' with the product guide' if ctx else ''}._"
    emit("delta", {"text": note})
    return Reply(text + note, [_link(f"Open {s.link}", s.link) for sc, s in (hits or [])[:1] if sc >= 0.25 and s.link], ["local-llm"] + [f"guide: {s.title}" for sc, s in (hits or [])[:2] if sc >= 0.25], streamed=True, engine="local-llm")


def llm_or_fallback(db, t: Turn, ctx, emit, hits=None) -> Reply:
    r = llm_answer(t, emit, hits if hits is not None else semantic.search(t.text, k=2))
    if r:
        return r
    guesses = [LABEL.get(i, i) for i, p in [(t.intent, t.confidence), *t.alternatives] if p >= 0.08 and i not in META][:3]
    lines = ["I couldn't match that to DAOGuard's data or guide." + (" The local language model isn't running, so I can't answer open-ended questions right now." if not local_llm.status()["chat"] else "")]
    if guesses:
        lines += ["", "Did you mean one of these? " + " · ".join(f"**{g}**" for g in guesses)]
    lines += ["", "Try naming a proposal (an id, number or name) or a topic: risk, votes, treasury, conflicts, execution, ledger."]
    return Reply("\n".join(lines), [], [])


def h_out_of_scope(db, t: Turn, ctx, emit) -> Reply:
    r = llm_answer(t, emit, [])
    if r:
        return r
    return Reply("That's outside DAOGuard, and the local language model that handles general questions isn't running right now. I can tell you anything about this prototype: proposals, risk, votes, the treasury, execution safety and the audit ledger.", [], [])


HANDLERS["out_of_scope"] = h_out_of_scope


def _same(a: str, b: str) -> bool:
    norm = lambda s: re.sub(r"\W+", " ", s or "").strip().lower()[:240]
    return bool(a) and norm(a) == norm(b)


def deep_reply(db, t: Turn, ctx, emit) -> Reply:
    """“Why?” / “tell me more”: the reasoning behind the previous answer, never a repeat of it."""
    i = t.intent
    if i == "ranking":
        top = max(_all(db), key=lambda p: p["combined_estimate_pct"])
        r = _r(offline._evaluation(db, top["id"]))
        r.text = f"**{top['id']} ranks first because of its evaluation chain.** Each stage starts from a prior and every finding multiplies the odds by its likelihood ratio:\n\n" + r.text
    elif i in ("proposal_recipient", "proposal_proposer") and t.pid:
        r = _r(offline._conflicts(db, t.pid))
        r.text = f"**Why the parties of {t.pid} matter:** these are the relationship leads, with the evidence behind each.\n\n" + r.text
    elif i == "proposal_amount" and t.pid:
        r = h_payouts(db, t, ctx, emit)
    elif i == "proposal_status" and t.pid:
        r = h_timeline(db, t, ctx, emit)
    elif i == "proposal_payouts" and t.pid:
        r = _r(offline._treasury(db, t.pid, "0% milestones"))
    else:
        r = HANDLERS.get(i, h_capabilities)(db, t, ctx, emit)
    previous = next((m["content"] for m in reversed(t.history[:-1]) if m["role"] == "assistant"), "")
    sec = _guide(INTENT_GUIDE.get(i, ""))
    if sec and (_same(r.text, previous) or i in ("execution_safety", "treasury_impact", "conflicts", "findings", "vote_result")):
        r.text += f"\n\n**How this is worked out**\n\n{_short(sec.body, 700)}"
        r.sources = [*r.sources, f"guide: {sec.title}"]
    return r


# --------------------------------------------------------------------------- follow-ups
FOLLOW: dict[str, list[str]] = {
    "proposal_overview": ["What's missing from {p}?", "Is {p} safe to execute?", "How did the vote go on {p}?", "Who receives the money?"],
    "proposal_amount": ["Who receives it?", "What if {p} overruns by 30%?", "What are the milestones of {p}?"],
    "proposal_recipient": ["Are the proposer and recipient connected?", "How much does {p} pay?", "Who proposed {p}?"],
    "proposal_proposer": ["Did the proposer publish a disclosure?", "Who receives the money?", "What's missing from {p}?"],
    "proposal_status": ["Is {p} safe to execute?", "How did the vote go?", "What happens next?"],
    "proposal_purpose": ["What are the milestones?", "How risky is {p}?", "What's missing?"],
    "proposal_payouts": ["What if it overruns by 30% with milestones?", "Is there a budget breakdown?", "Who receives the money?"],
    "risk_evaluation": ["Why?", "What's missing from {p}?", "Which proposal is riskiest?"],
    "findings": ["Why?", "Has the proposer answered?", "How risky is {p}?"],
    "execution_safety": ["What does ManifestMismatch mean?", "Can I halt {p}?", "How does the sentinel work?"],
    "treasury_impact": ["What if it overruns by 50%?", "What's the treasury balance?", "How is runway calculated?"],
    "conflicts": ["Does a transfer prove common ownership?", "Who is the recipient?", "Who voted on {p}?"],
    "versions_changes": ["Is {p} safe to execute?", "What evidence is attached?", "Timeline of {p}"],
    "evidence_docs": ["Is the evidence verified?", "What's missing from {p}?", "What is prompt injection?"],
    "qa_status": ["What's missing from {p}?", "How does proposer Q&A work?", "How risky is {p}?"],
    "vote_result": ["Who are the whales?", "Did the recipient's power vote?", "Why?"],
    "vote_advice": ["What's missing from {p}?", "How risky is {p}?", "Who voted on {p}?"],
    "voting_power": ["What is the Nakamoto coefficient?", "Votes on GOV-043", "Who is Kestrel?"],
    "actor_lookup": ["Which proposal is riskiest?", "Who are the whales?", "Conflicts on GOV-042"],
    "ranking": ["Why is {p} the riskiest?", "Compare GOV-042 and GOV-043", "Any alerts?"],
    "compare": ["Which proposal is riskiest?", "What's missing from {p}?", "Votes on {p}"],
    "list_proposals": ["Which proposal is riskiest?", "Summarise GOV-042", "Any alerts?"],
    "treasury_overview": ["Runway impact of GOV-042 with a 30% overrun", "Pending payouts?", "How is runway calculated?"],
    "alerts": ["Which proposal is riskiest?", "Is the ledger intact?", "Can I halt GOV-043?"],
    "recent_activity": ["Any alerts?", "Is the ledger intact?", "Timeline of GOV-043"],
    "ledger_integrity": ["How are #5 and #18 connected?", "What happened recently?", "What does chain-confirmed mean?"],
    "ledger_connection": ["Is the whole ledger intact?", "What does chain-confirmed mean?", "What happened recently?"],
    "concept": ["Which proposal is riskiest?", "Explain this page", "How do I demo DAOGuard?"],
    "how_to": ["Explain this page", "Which proposal is riskiest?", "What can you do?"],
}
DEFAULT_FOLLOW = ["Which proposal is riskiest right now?", "Summarise GOV-042", "Is GOV-043's upgrade safe?", "Any alerts?"]


def follow_ups(t: Turn, context: dict[str, Any]) -> list[str]:
    pid = t.pid or (context or {}).get("proposal_id") or "GOV-042"
    if t.intent in FOLLOW:
        out = [s.replace("{p}", pid) for s in FOLLOW[t.intent]]
    else:
        out = offline.suggestions(context, pid)
    return [s for s in out if s.lower().rstrip("?") != t.text.lower().rstrip("?")][:4]


# --------------------------------------------------------------------------- entry point
def respond(db: Session, messages: list[dict[str, str]], context: dict[str, Any], emit: Emit, delay: float = 0.006) -> dict[str, Any]:
    emit("status", {"text": "Understanding your question…"})
    t = understand(db, messages, context)
    domainish = bool(t.ent.proposals or t.ent.actors or t.ent.rules or t.ent.terms or t.ent.seqs)
    if t.intent not in META:
        emit("status", {"text": f"{LABEL.get(t.intent, 'Answering')}{' · ' + t.pid if t.pid and _scope(t.intent) == 'proposal' else ''}: reading live data…"})
    try:
        if t.deep:
            r = deep_reply(db, t, context, emit)
        elif t.confidence >= LOW or t.intent in META or (domainish and t.confidence >= VERY_LOW):
            r = HANDLERS.get(t.intent, llm_or_fallback)(db, t, context, emit)
            if t.confidence < LOW and not t.deep and t.intent not in META and not r.streamed:
                r.text = f"_I read this as **{LABEL.get(t.intent, t.intent).lower()}**{' for ' + t.pid if t.pid else ''}. Rephrase if you meant something else._\n\n" + r.text
        else:
            hits = semantic.search(t.text, k=3)
            # With the local LLM available, only a strong guide match wins; weaker matches become its context.
            if hits and hits[0][0] >= (0.72 if local_llm.status()["chat"] else 0.5):
                r = _guide_reply(hits[0][1], related=[s.title for sc, s in hits[1:] if sc >= hits[0][0] * 0.75])
            else:
                r = llm_answer(t, emit, hits) or (HANDLERS[t.intent](db, t, context, emit) if t.confidence >= VERY_LOW and t.intent in HANDLERS else llm_or_fallback(db, t, context, emit, hits))
    except DomainError as exc:
        known = ", ".join(db.scalars(select(Proposal.id).order_by(Proposal.id))) if db is not None else ""
        r = Reply(f"{exc.message}" + (f" The proposals in this demo are {known}." if known and "roposal" in exc.message else ""), [_link("All proposals", "/proposals")], [])
    except Exception as exc:  # live data unavailable (e.g. the chain restarting)
        log.exception("assistant engine failed")
        r = Reply(f"I couldn't read the live data just now ({type(exc).__name__}). The chain may be restarting; please try again in a moment.")
    if not r.streamed:
        for chunk in re.findall(r"\S+\s*", r.text):
            emit("delta", {"text": chunk})
            if delay:
                time.sleep(delay)
    scoped = _scope(t.intent) == "proposal"  # global answers (ranking, treasury) are not about the page's proposal
    understanding = {"intent": t.intent, "label": LABEL.get(t.intent, t.intent), "confidence": round(t.confidence, 2),
                     "proposal": t.pid if scoped else None, "proposal_from": t.pid_from if scoped else None, "engine": r.engine}
    return {"text": r.text, "links": r.links[:4], "sources": r.sources, "suggestions": follow_ups(t, context), "understanding": understanding}


def mode() -> dict[str, Any]:
    st = local_llm.status()
    parts = ["trained intent model"]
    if st["embed"]:
        parts.append(st["embed_model"])
    if st["chat"]:
        parts.append(st["chat_model"])
    return {"mode": "local", "local_llm": st, "label": "Local AI · " + " + ".join(parts), "training": nlu.model().report}
