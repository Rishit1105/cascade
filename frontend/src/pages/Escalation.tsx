import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { motion } from "motion/react";
import { AlertOctagon, ArrowRight, BellRing, ChevronDown, ChevronRight, Eye, FileWarning, Gavel, Lightbulb, ListChecks, Lock, Megaphone, OctagonX, Radar, ScrollText, ShieldAlert, ShieldCheck, ShieldX, Siren, Timer, UserRound, X } from "lucide-react";
import { api, type Alert, type ExecutionAttempt, type Finding } from "../lib/api";
import { cx, dateTime, pct, timeAgo, titleCase } from "../lib/format";
import { useAction, useAlerts, useAttempts, useEvaluation, useFindings, useGovernance, useSimulations } from "../lib/queries";
import { AnimatedNumber, EASE } from "../lib/motion";
import { Modal } from "../components/overlays";
import { LiveIndicator, SentinelActivity } from "../components/SentinelActivity";
import { DonutChart, HeatGrid, Legend, RingGauge, RiskRadar, Stepper, riskTone, toneColor, type StepState, type Tone } from "../components/riskviz";
import { Badge, Button, Callout, EmptyState, ErrorState, Field, LoadingBlock, Panel, ProgressBar, Segmented, SeverityBadge, StatusBadge, TxLink } from "../components/ui";

const RATING = (p: number) => (p < 0.1 ? "A" : p < 0.2 ? "B" : p < 0.35 ? "C" : p < 0.5 ? "D" : p < 0.7 ? "E" : "F");
const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
const SHORT_STAGE: Record<string, string> = { claims: "Claims", conflict: "Conflicts", vote: "Voting", execution: "Execution" };
const SEV_TONE: Record<string, Tone> = { critical: "danger", high: "danger", medium: "warning", low: "info", info: "faint" };
const SEV_COLOR: Record<string, string> = { critical: "rgb(var(--danger))", high: "rgb(var(--danger) / 0.6)", medium: "rgb(var(--warning))", low: "rgb(var(--info))", info: "rgb(var(--faint))" };
const KINDS = [
  { id: "analysis", label: "Claims" },
  { id: "missing_info", label: "Missing info" },
  { id: "conflict", label: "Conflict" },
  { id: "version", label: "Version" },
  { id: "simulation", label: "Simulation" },
  { id: "injection", label: "Injection" },
  { id: "execution", label: "Execution" },
];
const SOURCE_LABEL: Record<string, string> = { missing_info: "Missing information", conflict: "Conflict of interest", version: "Version change", simulation: "Simulation", injection: "Prompt injection", execution: "Execution guard", sentinel: "Sentinel", manual: "Manual report" };

/** Plain-language reading of an alert: what happened, why it matters and what to do next. */
function explain(a: Alert, guard: string | undefined, verdict: string | undefined): { what: string; why: string; next: string } {
  const title = a.title.replace(/\.$/, "");
  switch (a.source) {
    case "conflict":
      return { what: `DAOGuard found a relationship nobody disclosed: ${title.toLowerCase()}.`, why: "Voters may be approving money for a connected party without knowing it. A transfer shows that value moved between addresses; it does not prove common ownership.", next: "Ask the proposer to disclose or explain the link in Q&A. Resolve only with their answer or counter-evidence attached." };
    case "missing_info":
      return { what: `Something voters need is missing: ${title.toLowerCase()}.`, why: "Without it, voters cannot judge the request. A missing item is a reason to ask, not evidence of wrongdoing.", next: "Ask the proposer for it through Q&A. Resolve once the evidence is published and accepted." };
    case "version":
      return { what: "What would execute changed between proposal versions.", why: "Earlier reviews, audits and votes may not cover the new payload.", next: "Re-run the simulation on the latest version and require a fresh review before any approval." };
    case "injection":
      return { what: "A document contains instruction-like text aimed at AI reviewers.", why: "It tries to steer automated analysis. DAOGuard ignores it, but the author's intent needs a human look.", next: "Open the evidence, check the flagged passage and ask the proposer to remove or explain it." };
    case "execution":
      return { what: `The ExecutionGuard refused a payload: ${title.toLowerCase()}.`, why: "Someone tried to execute something other than what governance approved. Nothing moved; the revert is recorded on-chain.", next: "Identify who submitted it, keep the transaction as evidence and resolve with a justification." };
    case "simulation":
    case "sentinel":
      return {
        what: verdict === "block" ? "Simulation shows behaviour that contradicts what voters were told." : `The sentinel flagged this approval: ${title.toLowerCase()}.`,
        why: "Executing could move funds or change control in ways the vote never approved.",
        next: guard === "approved" ? "Halt it during the review window with Emergency actions. A guardian can block an approval but never approve or execute one." : guard === "halted" ? "It is already halted on-chain. Only a new version approved by a new vote can proceed." : "Keep it blocked until the payload is fixed and re-simulated.",
      };
    default:
      return { what: a.description || title, why: "A reviewer raised this manually for attention.", next: "Triage it, assign an owner and record the outcome with a justification." };
  }
}

/** Lifecycle of the selected alert, derived from its history and the guard. */
function lifecycle(a: Alert, guard: string | undefined): Array<{ label: string; sub?: string; state: StepState }> {
  const has = (x: string) => a.history.some((h) => h.action === x);
  const closed = a.status === "resolved" || a.status === "dismissed";
  const contained = guard === "halted" || has("halted") || a.source === "execution" || closed;
  return [
    { label: "Detected", sub: `${SOURCE_LABEL[a.source] ?? a.source} · ${timeAgo(a.created_at)}`, state: "done" },
    { label: "Triaged", sub: a.assignee ? a.assignee.split("·")[0].trim() : a.status === "new" ? "Waiting for a reviewer" : "Acknowledged", state: a.status === "new" ? "current" : "done" },
    { label: a.status === "escalated" ? "Escalated" : "Contained", sub: guard === "halted" ? "Halted on-chain" : a.source === "execution" ? "Guard reverted" : contained ? "No funds at risk" : "Not yet contained", state: contained ? "done" : a.status === "new" ? "todo" : "current" },
    { label: a.status === "dismissed" ? "Dismissed" : "Resolved", sub: closed ? (a.resolution ?? "Closed with justification") : "Needs a justification", state: closed ? "done" : "todo" },
  ];
}

export default function Escalation() {
  const [params] = useSearchParams();
  const scope = params.get("p") ?? undefined;
  const [filter, setFilter] = useState<"open" | "all">("open");
  const alerts = useAlerts(filter === "open" ? { status: "open", proposal: scope } : { proposal: scope });
  const everything = useAlerts({ proposal: scope });
  const [selectedId, setSelectedId] = useState<string | null>(params.get("alert"));
  const items = alerts.data?.items ?? [];
  const all = everything.data?.items ?? items;
  const selected = items.find((a) => a.id === selectedId) ?? items[0] ?? null;
  const pid = selected?.proposal_id ?? undefined;
  const evaluation = useEvaluation(pid);
  const findings = useFindings(pid);
  const attempts = useAttempts(pid);
  const gov = useGovernance(pid);
  const sims = useSimulations(pid);
  const [emergency, setEmergency] = useState(false);

  const groups = useMemo(() => SEVERITIES.map((s) => ({ s, items: items.filter((a) => a.severity === s) })).filter((g) => g.items.length), [items]);
  const overall = evaluation.data?.overall ?? 0;
  const guard = gov.data?.guard.status;
  const verdict = sims.data?.[0]?.verdict;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Risk escalation & emergency controls</h1>
          <p className="mt-0.5 text-sm text-muted">Urgent response when a simulation fails or the guard rejects a payload. Every action is recorded; on-chain actions only where a contract enforces them.</p>
        </div>
        <Segmented value={filter} onChange={setFilter} options={[{ id: "open", label: "Open alerts" }, { id: "all", label: "All alerts" }]} />
      </div>
      {alerts.error && <ErrorState error={alerts.error} retry={() => alerts.refetch()} />}
      {alerts.isLoading && <LoadingBlock rows={8} />}
      {!alerts.isLoading && items.length === 0 && <EmptyState icon={<BellRing className="h-5 w-5" />} title="No alerts" body="Nothing needs a human decision right now." />}

      {selected && (
        <>
          <CommandStrip all={all} pid={pid} overall={overall} hasEvaluation={!!evaluation.data} guard={guard} reviewWindow={gov.data?.guard.review_window_blocks} executableAt={gov.data?.guard.executable_at_block} block={gov.data?.current_block} verdict={verdict} />

          <div className="mt-4 grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)_340px]">
            <Panel className="xl:sticky xl:top-[72px] xl:self-start" title="Alert queue" subtitle={`${items.length} ${filter === "open" ? "open" : ""} alert(s) by severity`} icon={<Siren className="h-4 w-4 text-danger" />}>
              <div className="max-h-[640px] space-y-3 overflow-y-auto pr-1 scroll-thin">
                {groups.map((g) => (
                  <div key={g.s}>
                    <p className="label mb-1.5 flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: SEV_COLOR[g.s] }} />{g.s} · {g.items.length}</p>
                    <ul className="space-y-1.5">
                      {g.items.map((a) => (
                        <li key={a.id}>
                          <button onClick={() => setSelectedId(a.id)} className={cx("relative flex w-full cursor-pointer items-start gap-2 overflow-hidden rounded-lg border p-2.5 pl-3.5 text-left transition-colors duration-200", a.id === selected.id ? "border-fg bg-subtle" : "border-line hover:bg-subtle")}>
                            <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: SEV_COLOR[a.severity] }} />
                            {a.severity === "critical" ? <OctagonX className="mt-0.5 h-4 w-4 shrink-0 text-danger" /> : a.severity === "high" ? <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" /> : <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
                            <span className="min-w-0 flex-1">
                              <span className="line-clamp-2 text-xs font-medium">{a.title}</span>
                              <span className="mt-0.5 block text-2xs text-muted">{a.proposal_id ?? "—"} · {SOURCE_LABEL[a.source] ?? a.source} · {timeAgo(a.created_at)}</span>
                            </span>
                            <StatusBadge status={a.status} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </Panel>

            <div className="flex min-w-0 flex-col gap-4">
              <IncidentCard a={selected} guard={guard} verdict={verdict} reviewers={alerts.data?.reviewers ?? []} onEmergency={() => setEmergency(true)} />
              <div className="grid gap-4 lg:grid-cols-2">
                <section className="viz rounded-xl p-4 shadow-card">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="flex items-center gap-2 text-[13.5px] font-semibold"><Radar className="h-4 w-4 text-primary" /> Escalated risk profile</p>
                      <p className="text-2xs text-muted">{pid ?? "No proposal"} · evaluation chain</p>
                    </div>
                    <div className="text-right">
                      <p className="text-2xs text-muted">Rating</p>
                      <p className="text-[24px] font-semibold leading-none" style={{ color: toneColor(riskTone(overall * 100)) }}>{evaluation.data ? RATING(overall) : "—"}</p>
                    </div>
                  </div>
                  {evaluation.data ? (
                    <>
                      <div className="mt-1 flex justify-center">
                        <RiskRadar size={236} tone={riskTone(overall * 100)} stages={evaluation.data.stages.map((s) => ({ name: SHORT_STAGE[s.key] ?? s.name, value: s.posterior }))} />
                      </div>
                      <div className="mt-1 flex items-center justify-between rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-2">
                        <span className="text-2xs text-muted">Combined estimate</span>
                        <span className="text-[18px] font-semibold" style={{ color: toneColor(riskTone(overall * 100)) }}>{pct(overall, 0)}</span>
                      </div>
                      <p className="mt-2 text-[10.5px] text-faint">Model estimate from the listed evidence; not a probability of fraud. Each axis is one stage of the chain.</p>
                    </>
                  ) : (
                    <p className="mt-4 text-xs text-muted">No evaluation for this alert.</p>
                  )}
                </section>
                <ResponsePlaybook a={selected} guard={guard} onEmergency={() => setEmergency(true)} />
              </div>
              <AttemptsPanel attempts={attempts.data ?? []} />
            </div>

            <div className="flex flex-col gap-4 xl:sticky xl:top-[72px] xl:self-start">
              <ThreatPanel pid={pid} findings={findings.data ?? []} />
              <Panel title="Live sentinel activity" icon={<Radar className="h-4 w-4 text-primary" />} actions={<LiveIndicator />} subtitle="Reviews of this proposal, streamed as they run.">
                <SentinelActivity proposalId={pid} limit={2} empty="No sentinel review or simulation of this proposal in this session yet." />
              </Panel>
            </div>
          </div>
          <EmergencyModal open={emergency} onClose={() => setEmergency(false)} alert={selected} />
        </>
      )}
    </div>
  );
}

function StripCard({ title, icon, children, className }: { title: string; icon: ReactNode; children: ReactNode; className?: string }) {
  return (
    <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: EASE }} className={cx("panel flex min-w-0 flex-col p-4", className)}>
      <p className="mb-3 flex items-center gap-2 text-[12.5px] font-semibold text-fg">{icon}{title}</p>
      {children}
    </motion.section>
  );
}

function CommandStrip({ all, pid, overall, hasEvaluation, guard, reviewWindow, executableAt, block, verdict }: { all: Alert[]; pid?: string; overall: number; hasEvaluation: boolean; guard?: string; reviewWindow?: number; executableAt?: number | null; block?: number; verdict?: string }) {
  const open = all.filter((a) => a.status !== "resolved" && a.status !== "dismissed");
  const bySev = SEVERITIES.map((s) => ({ label: s, value: open.filter((a) => a.severity === s).length, color: SEV_COLOR[s] })).filter((s) => s.value > 0);
  const stages = [
    { id: "new", label: "New", n: all.filter((a) => a.status === "new").length },
    { id: "triaged", label: "Triaged", n: all.filter((a) => a.status === "triaged").length },
    { id: "escalated", label: "Escalated", n: all.filter((a) => a.status === "escalated").length },
    { id: "closed", label: "Closed", n: all.filter((a) => a.status === "resolved" || a.status === "dismissed").length },
  ];
  const assigned = open.length ? Math.round((open.filter((a) => a.assignee).length / open.length) * 100) : 100;
  const oldest = open.reduce<string | null>((m, a) => (!m || a.created_at < m ? a.created_at : m), null);
  const windowLeft = guard === "approved" && executableAt != null && block != null ? Math.max(0, executableAt - block) : null;
  const layers: Array<{ label: string; state: string; tone: Tone; icon: ReactNode }> = [
    { label: "Governance approval", state: guard === "approved" ? "Approved, awaiting execution" : guard === "executed" ? "Executed once" : guard === "halted" ? "Approval halted" : "No approval pending", tone: guard === "halted" ? "danger" : guard === "approved" ? "warning" : "primary", icon: <Gavel className="h-3.5 w-3.5" /> },
    { label: "Review window", state: windowLeft ? `${windowLeft} of ${reviewWindow ?? 5} blocks left to review` : windowLeft === 0 ? "Window passed: executable now" : `${reviewWindow ?? 5} blocks after each approval`, tone: windowLeft ? "warning" : "info", icon: <Timer className="h-3.5 w-3.5" /> },
    { label: "Sentinel simulation", state: verdict === "block" ? "BLOCK verdict recorded" : verdict === "flag" ? "Flagged for review" : verdict ? "Passed" : "Watching for approvals", tone: verdict === "block" ? "danger" : verdict === "flag" ? "warning" : "primary", icon: <Eye className="h-3.5 w-3.5" /> },
    { label: "ExecutionGuard", state: "Runs only the approved digest", tone: "primary", icon: <Lock className="h-3.5 w-3.5" /> },
  ];
  const tone = riskTone(overall * 100);
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <StripCard title={`Threat posture${pid ? ` · ${pid}` : ""}`} icon={<ShieldAlert className="h-4 w-4 text-danger" />}>
        <div className="flex items-center gap-4">
          <RingGauge value={overall * 100} tone={tone} size={118} center={hasEvaluation ? RATING(overall) : "—"} sub={hasEvaluation ? `${pct(overall, 0)} combined` : "no evaluation"} />
          <div className="min-w-0 text-xs">
            <p className="font-semibold" style={{ color: toneColor(tone) }}>{overall >= 0.5 ? "High concern" : overall >= 0.2 ? "Elevated concern" : "Low concern"}</p>
            <p className="mt-1 text-2xs leading-snug text-muted">Assurance rating A (best) to F from the evaluation chain of the selected alert's proposal.</p>
          </div>
        </div>
      </StripCard>
      <StripCard title="Open alert mix" icon={<BellRing className="h-4 w-4 text-warning" />}>
        <div className="flex items-center gap-4">
          <DonutChart size={118} segments={bySev} center={<AnimatedNumber value={open.length} />} sub="open" />
          <Legend className="min-w-0 flex-1" items={bySev.length ? bySev.map((s) => ({ label: s.label, value: s.value, color: s.color })) : [{ label: "none open", value: 0, color: "rgb(var(--primary))" }]} />
        </div>
      </StripCard>
      <StripCard title="Response pipeline" icon={<ListChecks className="h-4 w-4 text-info" />}>
        <div className="flex items-center justify-between gap-1">
          {stages.map((s, i) => (
            <div key={s.id} className="flex flex-1 items-center gap-1">
              <div className={cx("flex-1 rounded-lg border px-1.5 py-2 text-center", s.n ? (s.id === "new" ? "border-warning/40 bg-warning/10" : s.id === "escalated" ? "border-danger/40 bg-danger/10" : s.id === "closed" ? "border-primary/40 bg-primary/10" : "border-info/40 bg-info/10") : "border-line")}>
                <p className="text-[18px] font-semibold leading-none"><AnimatedNumber value={s.n} /></p>
                <p className="mt-1 text-[10px] font-medium text-muted">{s.label}</p>
              </div>
              {i < stages.length - 1 && <ArrowRight className="h-3 w-3 shrink-0 text-faint" />}
            </div>
          ))}
        </div>
        <div className="mt-3">
          <div className="flex justify-between text-2xs text-muted"><span>Open alerts with an owner</span><span className="font-semibold text-fg">{assigned}%</span></div>
          <div className="mt-1"><ProgressBar value={assigned} tone={assigned >= 80 ? "primary" : assigned >= 40 ? "warning" : "danger"} /></div>
          {oldest && <p className="mt-1.5 text-2xs text-faint">Oldest open alert raised {timeAgo(oldest)}</p>}
        </div>
      </StripCard>
      <StripCard title="Defence layers" icon={<ShieldCheck className="h-4 w-4 text-primary" />}>
        <ul className="space-y-2">
          {layers.map((l, i) => (
            <motion.li key={l.label} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 + i * 0.06, ease: EASE }} className="flex items-center gap-2.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ background: toneColor(l.tone, 0.14), color: toneColor(l.tone) }}>{l.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-semibold">{l.label}</span>
                <span className="block truncate text-2xs text-muted">{l.state}</span>
              </span>
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: toneColor(l.tone), boxShadow: `0 0 0 3px ${toneColor(l.tone, 0.18)}` }} />
            </motion.li>
          ))}
        </ul>
      </StripCard>
    </div>
  );
}

function IncidentCard({ a, guard, verdict, reviewers, onEmergency }: { a: Alert; guard?: string; verdict?: string; reviewers: string[]; onEmergency: () => void }) {
  const e = explain(a, guard, verdict);
  return (
    <Panel title="Selected incident" subtitle={`${a.id} · ${a.proposal_id ?? "no proposal"} · raised ${dateTime(a.created_at)}`} icon={<AlertOctagon className="h-4 w-4 text-danger" />} actions={<div className="flex gap-1.5"><SeverityBadge severity={a.severity} /><StatusBadge status={a.status} /></div>}>
      <p className="text-[15px] font-semibold leading-snug">{a.title}</p>
      <div className="mt-4 rounded-xl border border-line bg-subtle/40 px-2 py-3">
        <Stepper steps={lifecycle(a, guard)} />
      </div>
      <div className="mt-4 grid gap-2 md:grid-cols-3">
        {[
          { icon: <Siren className="h-4 w-4" />, tone: "danger" as Tone, title: "What happened", body: e.what },
          { icon: <Lightbulb className="h-4 w-4" />, tone: "warning" as Tone, title: "Why it matters", body: e.why },
          { icon: <ArrowRight className="h-4 w-4" />, tone: "primary" as Tone, title: "What to do next", body: e.next },
        ].map((x, i) => (
          <motion.div key={x.title} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + i * 0.07, ease: EASE }} className="rounded-xl border border-line p-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: toneColor(x.tone, 0.12), color: toneColor(x.tone) }}>{x.icon}</span>
            <p className="mt-2 text-xs font-semibold">{x.title}</p>
            <p className="mt-1 text-2xs leading-relaxed text-muted">{x.body}</p>
          </motion.div>
        ))}
      </div>
      <details className="group mt-3 rounded-lg border border-line px-3 py-2">
        <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-medium text-muted">
          Original alert text and evidence
          <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
        </summary>
        <p className="mt-2 text-xs">{a.description}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-2xs text-muted">
          <Badge>{SOURCE_LABEL[a.source] ?? a.source}</Badge>
          {a.data?.rule_id && <span className="font-mono">{a.data.rule_id}</span>}
          {a.finding_id && <span className="font-mono">{a.finding_id}</span>}
          {a.data?.tx_hash && <TxLink hash={a.data.tx_hash} block={a.data.block_number} />}
        </div>
      </details>
      <AlertActions a={a} reviewers={reviewers} onEmergency={onEmergency} />
    </Panel>
  );
}

function AlertActions({ a, reviewers, onEmergency }: { a: Alert; reviewers: string[]; onEmergency: () => void }) {
  const [assignee, setAssignee] = useState(a.assignee ?? "");
  const [note, setNote] = useState("");
  useEffect(() => {
    setAssignee(a.assignee ?? "");
    setNote("");
  }, [a.id, a.assignee]);
  const act = useAction((action: string) => api.post(`/alerts/${a.id}/${action}`, { note, assignee: action === "assign" ? assignee : null }), {
    success: "Alert updated",
    onSuccess: () => setNote(""),
    invalidate: [["alerts"], ["audit"], ["overview"]],
  });
  const closed = a.status === "resolved" || a.status === "dismissed";
  return (
    <div className="mt-4 grid gap-3 border-t border-line pt-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <div className="space-y-2">
        {a.resolution && <Callout tone="success" title="Resolution">{a.resolution}</Callout>}
        <Field label="Owner">
          <div className="flex gap-1.5">
            <div className="relative flex-1">
              <UserRound className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
              <select className="input pl-8" value={assignee} onChange={(e) => setAssignee(e.target.value)} disabled={closed} aria-label="Assignee">
                <option value="">Unassigned</option>
                {reviewers.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <Button size="md" disabled={!assignee || closed || assignee === a.assignee} loading={act.isPending && act.variables === "assign"} onClick={() => act.mutate("assign")}>Assign</Button>
          </div>
        </Field>
        {a.proposal_id && !closed && (
          <Button variant="danger" className="w-full" icon={<AlertOctagon className="h-4 w-4" />} onClick={onEmergency}>
            Emergency actions
          </Button>
        )}
      </div>
      <div className="space-y-2">
        <Field label="Justification" hint="Required to escalate, resolve or dismiss. Recorded in the audit ledger.">
          <textarea className="textarea min-h-[64px]" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-1.5">
          {a.status === "new" && <Button size="sm" onClick={() => act.mutate("triage")}>Acknowledge</Button>}
          {!closed && a.status !== "escalated" && <Button size="sm" disabled={note.trim().length < 8} onClick={() => act.mutate("escalate")}>Escalate</Button>}
          {!closed && <Button size="sm" variant="primary" disabled={note.trim().length < 8} onClick={() => act.mutate("resolve")}>Resolve</Button>}
          {!closed && <Button size="sm" variant="ghost" disabled={note.trim().length < 8} onClick={() => act.mutate("dismiss")}>Dismiss</Button>}
          {closed && <Button size="sm" onClick={() => act.mutate("reopen")}>Reopen</Button>}
        </div>
      </div>
    </div>
  );
}

function ThreatPanel({ pid, findings }: { pid?: string; findings: Finding[] }) {
  const open = findings.filter((f) => f.status === "open" || f.status === "challenged");
  const [picked, setPicked] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => setPicked(null), [pid]);
  const cols = [...new Set(open.map((f) => f.kind))].map((id) => ({ id, label: KINDS.find((k) => k.id === id)?.label ?? titleCase(id) })).sort((a, b) => KINDS.findIndex((k) => k.id === a.id) - KINDS.findIndex((k) => k.id === b.id));
  const rows = SEVERITIES.filter((s) => open.some((f) => f.severity === s)).map((s) => ({ id: s, label: s, tone: SEV_TONE[s] }));
  const shown = picked ? open.filter((f) => `${f.severity}:${f.kind}` === picked) : open;
  return (
    <Panel title="Vulnerability & threat details" subtitle={pid ? `${open.length} open finding(s) for ${pid}` : undefined} icon={<ShieldX className="h-4 w-4 text-danger" />}>
      {open.length === 0 ? (
        <p className="text-xs text-muted">No open findings.</p>
      ) : (
        <>
          <p className="label mb-1">Threat matrix · severity × type</p>
          <HeatGrid rows={rows} cols={cols} count={(r, c) => open.filter((f) => f.severity === r && f.kind === c).length} picked={picked} onPick={(r, c) => setPicked((p) => (p === `${r}:${c}` ? null : `${r}:${c}`))} />
          {picked && <button className="mt-1 cursor-pointer text-2xs font-medium text-primary hover:underline" onClick={() => setPicked(null)}>Show all {open.length} findings</button>}
          <ul className="mt-3 space-y-1.5">
            {shown.slice(0, 10).map((f) => {
              const on = expanded === f.id;
              return (
                <li key={f.id} className="overflow-hidden rounded-lg border border-line">
                  <button className="flex w-full cursor-pointer items-start gap-2 p-2.5 text-left transition-colors hover:bg-subtle/60" onClick={() => setExpanded(on ? null : f.id)} aria-expanded={on}>
                    <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: SEV_COLOR[f.severity] }} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-semibold">{f.title}</span>
                      <span className="mt-0.5 block text-2xs text-muted"><span className="whitespace-nowrap font-mono">{f.rule_id}</span> · {KINDS.find((k) => k.id === f.kind)?.label ?? titleCase(f.kind)} · {f.confidence} confidence</span>
                    </span>
                    <ChevronRight className={cx("mt-0.5 h-3.5 w-3.5 shrink-0 text-faint transition-transform", on && "rotate-90")} />
                  </button>
                  {on && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} className="border-t border-line bg-subtle/40 px-3 py-2.5 text-2xs leading-relaxed">
                      <p className="text-fg">{f.explanation}</p>
                      {f.remediation && <p className="mt-1.5 text-muted"><span className="font-semibold text-fg">Remediation: </span>{f.remediation}</p>}
                    </motion.div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Panel>
  );
}

function AttemptsPanel({ attempts }: { attempts: ExecutionAttempt[] }) {
  const executed = attempts.filter((a) => a.outcome === "executed").length;
  const rejected = attempts.filter((a) => a.outcome === "rejected").length;
  const notSent = attempts.length - executed - rejected;
  const chrono = [...attempts].reverse();
  return (
    <Panel title="Risk mitigation metrics" subtitle="Execution attempts against the guard for this proposal" icon={<ShieldCheck className="h-4 w-4 text-primary" />}>
      {attempts.length === 0 ? (
        <div className="flex items-center gap-3 rounded-lg border border-dashed border-line p-3">
          <ShieldCheck className="h-5 w-5 shrink-0 text-primary" />
          <p className="text-xs text-muted">No execution attempts recorded. Try a tampered payload in the Execution guardian to see the guard reject it here.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            {[["Blocked by the guard", rejected, "danger"], ["Executed as approved", executed, "primary"], ["Stopped before sending", notSent, "warning"]].map(([k, v, t]) => (
              <div key={k as string} className="rounded-lg border border-line px-3 py-2">
                <p className="text-[20px] font-semibold leading-none" style={{ color: toneColor(t as Tone) }}><AnimatedNumber value={v as number} /></p>
                <p className="mt-1 text-2xs text-muted">{k as string}</p>
              </div>
            ))}
          </div>
          <p className="label mb-1.5 mt-4">Attempt track · oldest to newest</p>
          <div className="relative flex items-center gap-2 overflow-x-auto pb-1 scroll-thin">
            <span className="absolute left-0 right-0 top-1/2 h-px bg-line" aria-hidden />
            {chrono.map((a, i) => {
              const tone: Tone = a.outcome === "executed" ? "primary" : a.outcome === "rejected" ? "danger" : "warning";
              return (
                <motion.span key={a.id} initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: i * 0.05 }} title={`${a.id} · ${titleCase(a.scenario ?? "custom")} · ${a.outcome}${a.revert ? ` (${a.revert.name})` : ""}`} className="relative z-10 inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-surface px-2.5 py-1 text-[10.5px] font-semibold" style={{ borderColor: toneColor(tone, 0.5), color: toneColor(tone) }}>
                  {a.outcome === "executed" ? <ShieldCheck className="h-3 w-3" /> : a.outcome === "rejected" ? <OctagonX className="h-3 w-3" /> : <X className="h-3 w-3" />}
                  {a.outcome === "rejected" ? a.revert?.name ?? "Rejected" : a.outcome === "executed" ? "Executed" : "Not sent"}
                </motion.span>
              );
            })}
          </div>
          <details className="group mt-3">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted">
              <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" /> Transaction details ({attempts.length})
            </summary>
            <div className="mt-2 overflow-x-auto">
              <table className="table-base">
                <thead><tr><th>Attempt</th><th>Transaction key</th><th>Network response</th><th>Enforcement</th></tr></thead>
                <tbody>
                  {attempts.map((a) => (
                    <tr key={a.id}>
                      <td className="text-xs">{a.id}<span className="block text-2xs text-muted">{titleCase(a.scenario ?? "custom")} · {timeAgo(a.created_at)}</span></td>
                      <td><TxLink hash={a.tx_hash} block={a.block_number} /></td>
                      <td className="text-xs">{a.outcome === "executed" ? <span className="text-primary">status 1: executed</span> : a.outcome === "rejected" ? <span className="text-danger">status 0: {a.revert?.name}</span> : <span className="text-warning">not sent</span>}</td>
                      <td className="text-2xs text-muted">{a.enforcement}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </Panel>
  );
}

function EmergencyModal({ open, onClose, alert }: { open: boolean; onClose: () => void; alert: Alert }) {
  const pid = alert.proposal_id!;
  const gov = useGovernance(pid);
  const sims = useSimulations(pid);
  const [action, setAction] = useState<"halt" | "dispute" | "notify">("notify");
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const guardApproved = gov.data?.guard.status === "approved";
  useEffect(() => {
    if (open) {
      setAction(guardApproved ? "halt" : "notify");
      setReason("");
      setConfirm("");
    }
  }, [open, guardApproved]);
  const run = useAction(() => api.post<any>(`/alerts/${alert.id}/emergency`, { action, reason, confirm: confirm || null }), {
    success: action === "halt" ? "Guardian halt recorded on-chain" : action === "dispute" ? "Dispute filed on-chain" : "Delegates notified (in-app)",
    onSuccess: onClose,
  });
  const latestSim = sims.data?.[0];
  const options = [
    { id: "halt" as const, icon: OctagonX, title: "Force halt transaction payload", body: guardApproved ? "Calls ExecutionGuard.halt() as the guardian. Blocks this approval permanently." : `Unavailable: the guard has no pending approval for ${pid} (status: ${gov.data?.guard.status ?? "…"}).`, disabled: !guardApproved, danger: true, effect: "On-chain · irreversible for this approval" },
    { id: "dispute" as const, icon: Gavel, title: "Submit cryptographic dispute", body: "Records the hash of your statement in ProposalRegistry.fileDispute().", disabled: false, danger: false, effect: "On-chain · statement hash only" },
    { id: "notify" as const, icon: Megaphone, title: "Notify delegate multisig", body: "Sends an in-app notification to all demo delegates (no external messages).", disabled: false, danger: false, effect: "Off-chain · in-app only" },
  ];
  const valid = reason.trim().length >= 8 && (action !== "halt" || confirm.trim() === pid);
  return (
    <Modal open={open} onClose={onClose} title="Emergency actions" subtitle={`${pid} · ${alert.title}`} width="max-w-3xl"
      footer={<><Button onClick={onClose} icon={<X className="h-3.5 w-3.5" />}>Cancel</Button><Button variant={action === "halt" ? "danger" : "primary"} disabled={!valid} loading={run.isPending} onClick={() => run.mutate(undefined)}>Confirm</Button></>}>
      <div className="grid gap-4 md:grid-cols-[1fr_260px]">
        <div className="space-y-2">
          {options.map((o) => (
            <button key={o.id} disabled={o.disabled} onClick={() => setAction(o.id)} className={cx("flex w-full cursor-pointer items-start gap-3 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50", action === o.id ? (o.danger ? "border-danger bg-danger/5" : "border-fg bg-subtle") : "border-line hover:bg-subtle")}>
              <o.icon className={cx("mt-0.5 h-5 w-5 shrink-0", o.danger ? "text-danger" : "text-muted")} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{o.title}</span>
                <span className="block text-xs text-muted">{o.body}</span>
                <span className="mt-1 inline-block rounded-full bg-subtle px-2 py-0.5 text-[10px] font-semibold text-muted">{o.effect}</span>
              </span>
              <ChevronRight className="h-4 w-4 text-faint" />
            </button>
          ))}
          <Field label={action === "dispute" ? "Dispute statement" : action === "halt" ? "Halt reason" : "Message to delegates"}>
            <textarea className="textarea min-h-[80px]" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="At least 8 characters" />
          </Field>
          {action === "halt" && (
            <Field label={`Type ${pid} to confirm`}>
              <input className="input font-mono" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
            </Field>
          )}
        </div>
        <div className="rounded-lg border border-line p-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold"><ShieldX className="h-4 w-4 text-danger" /> Security status</p>
          <div className="mt-3 flex justify-center">
            <RingGauge size={110} value={latestSim?.verdict === "block" ? 92 : latestSim?.verdict === "flag" ? 55 : 15} tone={latestSim?.verdict === "block" ? "danger" : latestSim?.verdict === "flag" ? "warning" : "primary"} center={latestSim ? latestSim.verdict.toUpperCase() : "—"} sub="latest simulation" />
          </div>
          {latestSim ? (
            <>
              <p className="mt-2 text-xs font-semibold uppercase tracking-[0.04em]">{latestSim.verdict === "block" ? "Deviation confirmed in simulation" : latestSim.verdict === "flag" ? "Simulation flagged issues" : "Simulation passed"}</p>
              <p className="mt-1 text-2xs text-muted">{(latestSim as any).summary}</p>
              <p className="mt-1 text-2xs text-faint">{latestSim.id} · {timeAgo(latestSim.finished_at)}</p>
            </>
          ) : (
            <p className="mt-2 text-xs text-muted">No simulation recorded for this proposal.</p>
          )}
          <p className="mt-3 text-2xs text-muted">Guard status: <b>{gov.data?.guard.status ?? "…"}</b>. Guardians can block an approval; they can never approve, alter or execute it.</p>
        </div>
      </div>
    </Modal>
  );
}

interface PlayStep {
  label: string;
  hint: string;
  done: boolean;
  to?: string;
  action?: () => void;
}

/** Standard response for this kind of alert, ticked off from the alert's own history. */
function playbook(a: Alert, guard: string | undefined, onEmergency: () => void): PlayStep[] {
  const pid = a.proposal_id;
  const closed = a.status === "resolved" || a.status === "dismissed";
  const bySource: Record<string, PlayStep[]> = pid
    ? {
        conflict: [
          { label: "Trace the relationship", hint: "See the transfer and who is connected.", done: closed, to: `/relationships?p=${pid}` },
          { label: "Ask the proposer to explain", hint: "A signed answer goes on the record.", done: closed, to: `/proposals/${pid}?tab=qa` },
        ],
        missing_info: [{ label: "Request the missing evidence", hint: "Ask through proposer Q&A.", done: closed, to: `/proposals/${pid}?tab=qa` }],
        version: [
          { label: "Compare the versions", hint: "What changed in the payload.", done: closed, to: `/versions?p=${pid}` },
          { label: "Re-run the simulation", hint: "Check the new code before approval.", done: closed, to: `/guardian?p=${pid}&view=bytecode` },
        ],
        simulation: [
          { label: "Inspect the simulation", hint: "Where behaviour diverged.", done: closed, to: `/guardian?p=${pid}&view=bytecode` },
          { label: "Halt within the review window", hint: guard === "approved" ? "Guardian halt on-chain." : `Guard status: ${guard ?? "none"}.`, done: guard === "halted", action: guard === "approved" ? onEmergency : undefined },
        ],
        sentinel: [
          { label: "Inspect the simulation", hint: "Where behaviour diverged.", done: closed, to: `/guardian?p=${pid}&view=bytecode` },
          { label: "Confirm the halt", hint: "The sentinel blocks on a BLOCK verdict.", done: guard === "halted", to: `/proposals/${pid}` },
        ],
        execution: [{ label: "Inspect the rejected payload", hint: "Compare it with the approved manifest.", done: closed, to: `/guardian?p=${pid}` }],
        injection: [{ label: "Open the flagged document", hint: "Check the instruction-like passage.", done: closed, to: `/proposals/${pid}?tab=evidence` }],
      }
    : {};
  const investigate = bySource[a.source] ?? [{ label: "Investigate", hint: "Review the proposal and its evidence.", done: closed, to: pid ? `/proposals/${pid}` : undefined }];
  return [
    { label: "Acknowledge", hint: "Tell the team someone is on it.", done: a.status !== "new" },
    { label: "Assign an owner", hint: a.assignee ?? "Pick a reviewer in the incident card.", done: !!a.assignee },
    ...investigate,
    { label: "Record the outcome", hint: "Resolve or dismiss with a justification.", done: closed },
  ];
}

function ResponsePlaybook({ a, guard, onEmergency }: { a: Alert; guard?: string; onEmergency: () => void }) {
  const steps = playbook(a, guard, onEmergency);
  const done = steps.filter((s) => s.done).length;
  const progress = Math.round((done / steps.length) * 100);
  return (
    <Panel title="Response playbook" icon={<ListChecks className="h-4 w-4 text-primary" />} subtitle={`${SOURCE_LABEL[a.source] ?? a.source} · ${done} of ${steps.length} steps done`}>
      <div className="flex items-center gap-3">
        <RingGauge size={64} stroke={7} value={progress} tone={progress === 100 ? "primary" : progress >= 40 ? "warning" : "danger"} center={<span className="text-[13px]">{progress}%</span>} />
        <p className="text-2xs leading-snug text-muted">The standard response for this kind of alert. Steps tick off from the alert's history; links open the page where each step is done.</p>
      </div>
      <ol className="mt-3 space-y-1">
        {steps.map((s, i) => {
          const body = (
            <>
              <span className={cx("flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold", s.done ? "border-primary bg-primary text-white" : "border-line-strong text-muted")}>{s.done ? "✓" : i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className={cx("block text-xs font-semibold", s.done && "text-muted line-through decoration-primary/50")}>{s.label}</span>
                <span className="block truncate text-2xs text-muted">{s.hint}</span>
              </span>
              {(s.to || s.action) && !s.done && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-faint" />}
            </>
          );
          const cls = "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors";
          return (
            <motion.li key={s.label} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05, ease: EASE }}>
              {s.to && !s.done ? (
                <Link to={s.to} className={cx(cls, "hover:bg-subtle")}>{body}</Link>
              ) : s.action && !s.done ? (
                <button onClick={s.action} className={cx(cls, "cursor-pointer hover:bg-subtle")}>{body}</button>
              ) : (
                <div className={cls}>{body}</div>
              )}
            </motion.li>
          );
        })}
      </ol>
      <p className="label mb-2 mt-4 flex items-center gap-1.5"><ScrollText className="h-3 w-3" /> Response log · newest first</p>
      <ol className="relative space-y-3 border-l border-line pl-5">
        {[...a.history].reverse().map((h, i) => (
          <motion.li key={i} className="relative" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05, ease: EASE }}>
            <span className={cx("absolute -left-[27px] top-0 flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-surface", h.action === "halted" ? "bg-danger" : h.action === "resolve" || h.action === "resolved" ? "bg-primary" : h.action === "created" ? "bg-warning" : "bg-line-strong")}>
              <span className="h-1.5 w-1.5 rounded-full bg-white" />
            </span>
            <p className="text-xs font-semibold">{titleCase(h.action)}</p>
            <p className="text-2xs text-muted">{h.by} · {dateTime(h.at)}</p>
            {h.note && <p className="mt-0.5 rounded-md bg-subtle px-2 py-1 text-2xs">{h.note}</p>}
            {h.data?.tx_hash && <div className="mt-0.5"><TxLink hash={h.data.tx_hash} block={h.data.block_number} /></div>}
          </motion.li>
        ))}
      </ol>
    </Panel>
  );
}
