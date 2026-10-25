import { useEffect, useMemo, useState } from "react";
import { GrowBar } from "../lib/motion";
import { useSearchParams } from "react-router-dom";
import { AlertOctagon, BellRing, ChevronRight, FileWarning, Gavel, Megaphone, OctagonX, Radar, ShieldAlert, ShieldX, X } from "lucide-react";
import { api, type Alert } from "../lib/api";
import { cx, dateTime, pct, timeAgo, titleCase } from "../lib/format";
import { useAction, useAlerts, useAttempts, useEvaluation, useFindings, useGovernance, useSimulations } from "../lib/queries";
import { Modal } from "../components/overlays";
import { LiveIndicator, SentinelActivity } from "../components/SentinelActivity";
import { Badge, Button, Callout, EmptyState, ErrorState, Field, LoadingBlock, Panel, ProgressBar, Segmented, SeverityBadge, StatusBadge, TxLink } from "../components/ui";

const RATING = (p: number) => (p < 0.1 ? "A" : p < 0.2 ? "B" : p < 0.35 ? "C" : p < 0.5 ? "D" : p < 0.7 ? "E" : "F");

export default function Escalation() {
  const [params] = useSearchParams();
  const [filter, setFilter] = useState<"open" | "all">("open");
  const alerts = useAlerts(filter === "open" ? { status: "open", proposal: params.get("p") ?? undefined } : { proposal: params.get("p") ?? undefined });
  const [selectedId, setSelectedId] = useState<string | null>(params.get("alert"));
  const items = alerts.data?.items ?? [];
  const selected = items.find((a) => a.id === selectedId) ?? items[0] ?? null;
  const pid = selected?.proposal_id ?? undefined;
  const evaluation = useEvaluation(pid);
  const findings = useFindings(pid);
  const attempts = useAttempts(pid);
  const [emergency, setEmergency] = useState(false);

  const groups = useMemo(() => {
    const order = ["critical", "high", "medium", "low", "info"];
    return order.map((s) => ({ s, items: items.filter((a) => a.severity === s) })).filter((g) => g.items.length);
  }, [items]);
  const overall = evaluation.data?.overall ?? 0;

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
        <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)_320px]">
          <div className="flex flex-col gap-4">
            <section className="rounded-xl border border-ink bg-ink p-4 text-white shadow-card dark:border-line">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-semibold">Escalated risk profile</p>
                  <p className="text-2xs text-white/60">{pid ?? "No proposal"} · evaluation chain</p>
                </div>
                {selected.severity === "critical" && selected.status !== "resolved" && <Badge tone="danger" className="!border-danger !bg-danger !text-white">Escalated</Badge>}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div>
                  <p className="text-2xs text-white/60">Combined estimate</p>
                  <p className="text-[28px] font-semibold leading-tight">{evaluation.data ? pct(overall, 0) : "—"}</p>
                </div>
                <div>
                  <p className="text-2xs text-white/60">Assurance rating</p>
                  <p className={cx("text-[28px] font-semibold leading-tight", overall >= 0.5 ? "text-[#F0606E]" : overall >= 0.2 ? "text-[#E0A43A]" : "text-[#2BB39A]")}>
                    {evaluation.data ? RATING(overall) : "—"}
                  </p>
                </div>
              </div>
              <div className="mt-3 space-y-1.5">
                {evaluation.data?.stages.map((s) => (
                  <div key={s.key} className="flex items-center gap-2 text-2xs">
                    <span className="w-28 truncate text-white/70">{s.name}</span>
                    <div className="h-1 flex-1 rounded-full bg-white/10"><GrowBar pct={Math.max(3, s.posterior * 100)} className={cx("h-full rounded-full", s.band === "high" ? "bg-[#F0606E]" : s.band === "elevated" ? "bg-[#E0A43A]" : "bg-[#2BB39A]")} /></div>
                    <span className="w-10 text-right font-mono text-white/80">{pct(s.posterior)}</span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[10.5px] text-white/50">Model estimate from listed evidence; not a probability of fraud.</p>
            </section>

            <Panel title="Impact summary & response log">
              <ol className="relative space-y-3 border-l border-line pl-4">
                {[...selected.history].reverse().map((h, i) => (
                  <li key={i} className="relative">
                    <span className={cx("absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-surface", h.action === "halted" ? "bg-danger" : h.action === "resolve" ? "bg-primary" : "bg-line-strong")} />
                    <p className="text-xs font-semibold">{titleCase(h.action)}</p>
                    <p className="text-2xs text-muted">{h.by} · {dateTime(h.at)}</p>
                    {h.note && <p className="mt-0.5 text-2xs">{h.note}</p>}
                    {h.data?.tx_hash && <div className="mt-0.5"><TxLink hash={h.data.tx_hash} block={h.data.block_number} /></div>}
                  </li>
                ))}
              </ol>
            </Panel>

            <Panel className="flex-1" title="Live sentinel activity" icon={<Radar className="h-4 w-4 text-primary" />} actions={<LiveIndicator />} subtitle="Reviews of this proposal, streamed as they run.">
              <SentinelActivity proposalId={pid} limit={2} empty="No sentinel review or simulation of this proposal in this session yet." />
            </Panel>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <Panel title="Actionable security alerts" subtitle={`${items.length} alert(s) · grouped by severity`}>
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
                <div className="max-h-[520px] space-y-3 overflow-y-auto pr-1 scroll-thin">
                  {groups.map((g) => (
                    <div key={g.s}>
                      <p className="label mb-1.5">{g.s} · {g.items.length}</p>
                      <ul className="space-y-1.5">
                        {g.items.map((a) => (
                          <li key={a.id}>
                            <button onClick={() => setSelectedId(a.id)} className={cx("flex w-full items-start gap-2 rounded-lg border p-2.5 text-left transition-colors", a.id === selected.id ? "border-fg bg-subtle" : "border-line hover:bg-subtle")}>
                              {a.severity === "critical" ? <OctagonX className="mt-0.5 h-4 w-4 shrink-0 text-danger" /> : a.severity === "high" ? <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" /> : <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
                              <span className="min-w-0 flex-1">
                                <span className="line-clamp-2 text-xs font-medium">{a.title}</span>
                                <span className="mt-0.5 flex items-center gap-1.5 text-2xs text-muted">{a.proposal_id ?? "—"} · {a.source} · {timeAgo(a.created_at)}</span>
                              </span>
                              <StatusBadge status={a.status} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
                <AlertDetail a={selected} reviewers={alerts.data?.reviewers ?? []} onEmergency={() => setEmergency(true)} />
              </div>
            </Panel>

            <Panel className="flex-1" title="Risk mitigation metrics" subtitle="Execution attempts against the guard for this proposal" bodyClassName="px-0">
              {(attempts.data ?? []).length === 0 && <p className="px-4 text-xs text-muted">No execution attempts recorded.</p>}
              {(attempts.data ?? []).length > 0 && (
                <div className="overflow-x-auto">
                  <table className="table-base">
                    <thead><tr><th>Attempt</th><th>Transaction key</th><th>Network response</th><th>Enforcement</th></tr></thead>
                    <tbody>
                      {(attempts.data ?? []).map((a) => (
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
              )}
            </Panel>
          </div>

          <Panel className="h-full" title="Vulnerability & threat details" subtitle={pid ? `Open findings for ${pid}` : undefined}>
            <ul className="space-y-2">
              {(findings.data ?? []).filter((f) => f.status === "open" || f.status === "challenged").slice(0, 8).map((f) => (
                <li key={f.id} className="rounded-lg border border-line p-2.5">
                  <div className="flex items-center gap-1.5"><SeverityBadge severity={f.severity} /><span className="font-mono text-2xs text-faint">{f.rule_id}</span></div>
                  <p className="mt-1 text-xs font-semibold">{f.title}</p>
                  <p className="mt-0.5 line-clamp-3 text-2xs text-muted">{f.explanation}</p>
                </li>
              ))}
              {(findings.data ?? []).length === 0 && <p className="text-xs text-muted">No findings.</p>}
            </ul>
          </Panel>
        </div>
      )}
      {selected && <EmergencyModal open={emergency} onClose={() => setEmergency(false)} alert={selected} />}
    </div>
  );
}

function AlertDetail({ a, reviewers, onEmergency }: { a: Alert; reviewers: string[]; onEmergency: () => void }) {
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
    <div className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <SeverityBadge severity={a.severity} />
        <StatusBadge status={a.status} />
        <Badge>{a.source}</Badge>
      </div>
      <p className="mt-2 text-sm font-semibold">{a.title}</p>
      <p className="mt-1 text-xs text-muted">{a.description}</p>
      {a.data?.tx_hash && <div className="mt-1.5"><TxLink hash={a.data.tx_hash} block={a.data.block_number} /></div>}
      {a.resolution && <Callout tone="success" title="Resolution">{a.resolution}</Callout>}
      <div className="mt-3 space-y-2">
        <Field label="Assignee">
          <div className="flex gap-1.5">
            <select className="input" value={assignee} onChange={(e) => setAssignee(e.target.value)} disabled={closed}>
              <option value="">Unassigned</option>
              {reviewers.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <Button size="md" disabled={!assignee || closed || assignee === a.assignee} loading={act.isPending && act.variables === "assign"} onClick={() => act.mutate("assign")}>Assign</Button>
          </div>
        </Field>
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
        {a.proposal_id && !closed && (
          <Button variant="danger" className="w-full" icon={<AlertOctagon className="h-4 w-4" />} onClick={onEmergency}>
            Emergency actions
          </Button>
        )}
      </div>
    </div>
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
    { id: "halt" as const, icon: OctagonX, title: "Force halt transaction payload", body: guardApproved ? "Calls ExecutionGuard.halt() as the guardian. Blocks this approval permanently." : `Unavailable: the guard has no pending approval for ${pid} (status: ${gov.data?.guard.status ?? "…"}).`, disabled: !guardApproved, danger: true },
    { id: "dispute" as const, icon: Gavel, title: "Submit cryptographic dispute", body: "Records the hash of your statement in ProposalRegistry.fileDispute().", disabled: false, danger: false },
    { id: "notify" as const, icon: Megaphone, title: "Notify delegate multisig", body: "Sends an in-app notification to all demo delegates (no external messages).", disabled: false, danger: false },
  ];
  const valid = reason.trim().length >= 8 && (action !== "halt" || confirm.trim() === pid);
  return (
    <Modal open={open} onClose={onClose} title="Emergency actions" subtitle={`${pid} · ${alert.title}`} width="max-w-3xl"
      footer={<><Button onClick={onClose} icon={<X className="h-3.5 w-3.5" />}>Cancel</Button><Button variant={action === "halt" ? "danger" : "primary"} disabled={!valid} loading={run.isPending} onClick={() => run.mutate(undefined)}>Confirm</Button></>}>
      <div className="grid gap-4 md:grid-cols-[1fr_260px]">
        <div className="space-y-2">
          {options.map((o) => (
            <button key={o.id} disabled={o.disabled} onClick={() => setAction(o.id)} className={cx("flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50", action === o.id ? (o.danger ? "border-danger bg-danger/5" : "border-fg bg-subtle") : "border-line hover:bg-subtle")}>
              <o.icon className={cx("mt-0.5 h-5 w-5 shrink-0", o.danger ? "text-danger" : "text-muted")} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{o.title}</span>
                <span className="block text-xs text-muted">{o.body}</span>
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
          <div className="mt-2"><ProgressBar value={latestSim?.verdict === "block" ? 92 : latestSim?.verdict === "flag" ? 55 : 15} tone={latestSim?.verdict === "block" ? "danger" : latestSim?.verdict === "flag" ? "warning" : "primary"} /></div>
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
