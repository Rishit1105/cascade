/* Execution tunnel: one payload travelling through six checkpoints. Every checkpoint state comes
   from data the page already has (governance, guard approval, the current scenario's simulation,
   the latest preflight check and the latest submitted attempt). The moving packet is decoration
   on top of results that are already shown; replaying it never calls the API. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CheckCircle2, Circle, CircleHelp, FileText, FlaskConical, Landmark, Loader2, MinusCircle, Play, Radar, RotateCcw, ShieldCheck, Stamp, TriangleAlert, Vote, XCircle,
} from "lucide-react";
import type { ExecutionAttempt, ExecutionCheck, GovernanceState, ProposalDetail, Simulation } from "../lib/api";
import { cx, govStateLabel, shortHash, timeAgo } from "../lib/format";
import { useActivityRuns, useLive } from "../lib/live";
import { useSystemStatus } from "../lib/queries";
import { useMedia } from "../lib/useMedia";
import { Badge, Button, TxLink } from "./ui";

type Status = "idle" | "pending" | "passed" | "warning" | "failed" | "skipped" | "unknown";
interface Stage {
  key: string;
  label: string;
  icon: ReactNode;
  status: Status;
  line: string;
  source?: "preflight" | "transaction";
}

const STATUS_WORD: Record<Status, string> = {
  idle: "Idle",
  pending: "Pending",
  passed: "Passed",
  warning: "Warning",
  failed: "Blocked",
  skipped: "Skipped",
  unknown: "Unknown",
};
const STATUS_TONE: Record<Status, string> = {
  idle: "border-line text-muted",
  pending: "border-info/60 text-info",
  passed: "border-primary/70 text-primary",
  warning: "border-warning/70 text-warning",
  failed: "border-danger/80 text-danger",
  skipped: "border-dashed border-line-strong text-faint",
  unknown: "border-dashed border-line-strong text-muted",
};
const GLOW: Partial<Record<Status, string>> = { passed: "rgb(var(--primary) / 0.55)", warning: "rgb(var(--warning) / 0.5)", failed: "rgb(var(--danger) / 0.6)" };
const ICON: Record<Status, ReactNode> = {
  idle: <Circle className="h-4 w-4" />,
  pending: <Loader2 className="h-4 w-4 animate-spin" />,
  passed: <CheckCircle2 className="h-4 w-4" />,
  warning: <TriangleAlert className="h-4 w-4" />,
  failed: <XCircle className="h-4 w-4" />,
  skipped: <MinusCircle className="h-4 w-4" />,
  unknown: <CircleHelp className="h-4 w-4" />,
};

const wordFor = (s: Stage) => (s.source === "preflight" && (s.status === "passed" || s.status === "failed") ? (s.status === "passed" ? "Would pass" : "Would block") : STATUS_WORD[s.status]);

const firstSentence = (s?: string | null) => (s ?? "").split(/(?<=\.)\s/)[0];

function useSize<T extends HTMLElement>(): [React.RefObject<T>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

export interface TunnelProps {
  p?: ProposalDetail;
  gov?: GovernanceState;
  scenario: string;
  scenarioLabel: string;
  check: ExecutionCheck | null;
  attempt: ExecutionAttempt | null;
  sim: Simulation | null;
  checking: boolean;
  executing: boolean;
  simulating: boolean;
}

function buildStages({ p, gov, scenario, check, attempt, sim, checking, executing, simulating }: TunnelProps): Stage[] {
  const guard = gov?.guard;
  const proposal: Stage = p?.current_version
    ? { key: "proposal", label: "Proposal", icon: <FileText className="h-5 w-5" />, status: "passed", line: `v${p.current_version} committed on-chain` }
    : { key: "proposal", label: "Proposal", icon: <FileText className="h-5 w-5" />, status: "idle", line: "No committed version yet" };

  const st = gov?.state;
  const vote: Stage = { key: "vote", label: "Vote", icon: <Vote className="h-5 w-5" />, status: "idle", line: "Not submitted to a vote" };
  if (st && ["Succeeded", "Queued", "Executed"].includes(st)) Object.assign(vote, { status: "passed", line: `${govStateLabel(st)}${gov?.quorum_reached ? " · quorum reached" : ""}` });
  else if (st === "Pending" || st === "Active") Object.assign(vote, { status: "pending", line: `${govStateLabel(st)} · ${gov?.blocks_remaining ?? "?"} block(s) left` });
  else if (st && ["Defeated", "Canceled", "Expired"].includes(st)) Object.assign(vote, { status: "failed", line: govStateLabel(st) });

  const manifest: Stage = { key: "manifest", label: "Approved manifest", icon: <Stamp className="h-5 w-5" />, status: "idle", line: "No approval on the guard" };
  if (guard?.status === "approved") Object.assign(manifest, { status: "passed", line: `v${guard.version} · ${shortHash(guard.manifest_hash, 8, 4)}` });
  else if (guard?.status === "executed") Object.assign(manifest, { status: "passed", line: `v${guard.version} · already executed once` });
  else if (guard?.status === "halted") Object.assign(manifest, { status: "failed", line: `v${guard.version} halted by a guardian` });

  // Only a simulation of this scenario's payload counts; the approved manifest's review is not this payload's.
  const simulation: Stage = { key: "simulation", label: "Simulation", icon: <FlaskConical className="h-5 w-5" />, status: scenario === "safe" ? "unknown" : "skipped",
    line: scenario === "safe" ? "Not simulated in this session" : "This payload was not simulated (optional)" };
  if (simulating) Object.assign(simulation, { status: "pending", line: "Simulating on a snapshot…" });
  else if (sim && sim.status === "completed") {
    const s = sim.verdict === "pass" ? "passed" : sim.verdict === "flag" ? "warning" : "failed";
    Object.assign(simulation, { status: s, line: `${sim.verdict.toUpperCase()} · ${sim.id} (${sim.trigger})` });
  } else if (sim && sim.status === "failed") Object.assign(simulation, { status: "unknown", line: `Simulation failed to run · ${sim.id}` });

  const guardStage: Stage = { key: "guard", label: "Execution guard", icon: <ShieldCheck className="h-5 w-5" />, status: "idle", line: "Run preflight or submit to test it" };
  const treasury: Stage = { key: "treasury", label: "Treasury", icon: <Landmark className="h-5 w-5" />, status: "idle", line: "Nothing submitted" };
  if (executing) {
    Object.assign(guardStage, { status: "pending", line: "Transaction submitted, waiting for the receipt…", source: "transaction" });
  } else if (attempt) {
    if (attempt.outcome === "executed") {
      Object.assign(guardStage, { status: "passed", line: "Accepted on-chain", source: "transaction" });
      Object.assign(treasury, { status: "passed", line: attempt.balance_changes.map((b) => `${b.holder_label ?? "holder"} ${b.display}`).slice(0, 2).join(" · ") || "Executed", source: "transaction" });
    } else if (attempt.outcome === "rejected") {
      Object.assign(guardStage, { status: "failed", line: `Reverted: ${attempt.revert?.name ?? "unknown error"}`, source: "transaction" });
      Object.assign(treasury, { status: "skipped", line: "Untouched: the contract refused, nothing moved", source: "transaction" });
    } else {
      Object.assign(guardStage, { status: "skipped", line: "Not sent: the gateway refused before any transaction", source: "transaction" });
      Object.assign(treasury, { status: "skipped", line: "Untouched: nothing was sent" });
    }
  } else if (checking) {
    Object.assign(guardStage, { status: "pending", line: "Asking ExecutionGuard.preflight()…", source: "preflight" });
  } else if (check) {
    const pf = check.preflight;
    if (!pf.performed) Object.assign(guardStage, { status: "unknown", line: `Preflight not performed: ${pf.reason ?? "no reason given"}`, source: "preflight" });
    else if (pf.would_execute) {
      Object.assign(guardStage, { status: "passed", line: "Preflight: would execute", source: "preflight" });
      Object.assign(treasury, { status: "idle", line: "Awaiting your explicit submission" });
    } else {
      Object.assign(guardStage, { status: "failed", line: `Preflight: would revert ${pf.revert?.name ?? ""}`, source: "preflight" });
      Object.assign(treasury, { status: "skipped", line: "Nothing would move" });
    }
  }
  return [proposal, vote, manifest, simulation, guardStage, treasury];
}

/** Where the packet stops: in front of a refusing guard, at the guard for a prediction, at the treasury when executed. */
function terminalOf(stages: Stage[]): { at: number; blocked: boolean } {
  const g = stages[4];
  if (g.status === "failed") return { at: 3.38, blocked: true }; // stops in front of the barrier
  if (g.status === "skipped") return { at: 3.3, blocked: false };
  if (stages[5].status === "passed") return { at: 5, blocked: false };
  if (g.status === "passed") return { at: 4, blocked: false };
  let at = 0;
  for (let i = 0; i < 4 && (stages[i].status === "passed" || stages[i].status === "warning" || stages[i].status === "skipped" || (i === 3 && stages[i].status === "unknown")); i++) at = i;
  return { at, blocked: false };
}

function SentinelStrip({ proposalId }: { proposalId?: string }) {
  const { connected } = useLive();
  const sys = useSystemStatus();
  const [run] = useActivityRuns(proposalId, 1);
  const running = sys.data?.sentinel?.running;
  const last = run?.items[run.items.length - 1];
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-subtle/70 px-3 py-1.5 text-xs" aria-live="polite">
      <span className="inline-flex items-center gap-1.5 font-semibold">
        <Radar className={cx("h-3.5 w-3.5", running ? "text-primary" : "text-faint")} /> Sentinel {running ? "watching" : sys.isLoading ? "…" : "off"}
      </span>
      <span className={cx("inline-flex items-center gap-1", connected ? "text-primary" : "text-warning")}>
        <span className={cx("h-1.5 w-1.5 rounded-full", connected ? "animate-pulse2 bg-primary" : "bg-warning")} /> {connected ? "live" : "reconnecting"}
      </span>
      <span className="min-w-0 truncate text-muted">
        {last ? (
          <>
            {run.simulationId ?? run.source} · {last.message} · {timeAgo(last.at)}
          </>
        ) : (
          "No review of this proposal in this session"
        )}
      </span>
    </div>
  );
}

export function ExecutionTunnel(props: TunnelProps) {
  const { check, attempt, scenarioLabel, p } = props;
  const stages = useMemo(() => buildStages(props), [props]);
  const { at, blocked } = terminalOf(stages);
  const wide = useMedia("(min-width: 900px)");
  const reduced = useMedia("(prefers-reduced-motion: reduce)");
  const [pos, setPos] = useState(at);
  const [trackRef, { w: W, h: H }] = useSize<HTMLDivElement>();
  const GAP = 24;
  const RAIL = 18; // the packet runs on a rail under the gates, never over their labels
  const railY = H - RAIL;
  const center = (x: number) => ((W - 5 * GAP) * (x + 0.5)) / 6 + x * GAP; // exact gate centres, fractional x interpolates
  const [replay, setReplay] = useState(0);
  const resultKey = `${check?.id ?? "-"}|${attempt?.id ?? "-"}|${stages[4].status}|${stages[5].status}|${at}`;

  useEffect(() => {
    // Purely visual: walk the packet to where the recorded result already is.
    if (reduced) {
      setPos(at);
      return;
    }
    const hops: number[] = [];
    for (let i = 0; i <= Math.floor(at); i++) hops.push(i);
    if (at !== Math.floor(at)) hops.push(at);
    let i = 0;
    setPos(0);
    let t = window.setTimeout(function step() {
      i += 1;
      if (i < hops.length) {
        setPos(hops[i]);
        t = window.setTimeout(step, 300);
      }
    }, 160);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultKey, replay, reduced]);

  const arrived = Math.abs(pos - at) < 0.001;
  const guard = stages[4];
  const packetTone = blocked && arrived ? "danger" : guard.status === "skipped" && arrived ? "warning" : "primary";
  const predicted = guard.source === "preflight";
  const ROW = 112; // vertical (narrow) layout: fixed row pitch so the packet can be placed exactly
  const diffs = (check?.discrepancies ?? []).filter((d) => d.rule_id !== "DG-R000");
  const digest = check?.discrepancies.find((d) => d.rule_id === "DG-R000");
  const hasResult = !!check || !!attempt;

  return (
    <section className="viz relative mb-4 overflow-hidden rounded-2xl p-4 shadow-pop md:p-5" aria-label="Execution tunnel">
      <div className="relative z-10 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-[-0.01em]">Execution tunnel</h2>
          <p className="mt-0.5 text-sm text-muted">
            {p?.id} · <span className="font-medium text-fg">{scenarioLabel}</span> · mint passed, amber warning, coral blocked, dashed = preflight prediction
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <SentinelStrip proposalId={p?.id} />
          <Button size="sm" variant="secondary" icon={<RotateCcw className="h-3.5 w-3.5" />} disabled={!hasResult} onClick={() => setReplay((n) => n + 1)} title="Replays the animation of the latest recorded result. Sends nothing.">
            Replay animation
          </Button>
        </div>
      </div>

      {/* The track: perspective floor (3D effect 1), gates (effect 2), barrier (effect 3), packet. */}
      <div ref={trackRef} className="viz-depth relative mt-4">
        <div className="viz-floor" aria-hidden />
        <ol className={cx("relative grid", wide ? "grid-cols-6 gap-6 pb-10" : "grid-cols-1 gap-3")} style={wide ? undefined : { gridAutoRows: `${ROW - 12}px` }}>
          {stages.map((s, i) => {
            const reached = pos >= i - 0.001 || (i === 4 && blocked && arrived);
            return (
              <li
                key={s.key}
                aria-label={`${s.label}: ${wordFor(s)}. ${s.line}${s.source === "preflight" ? " (preflight prediction)" : s.source === "transaction" ? " (submitted transaction)" : ""}`}
                className={cx("viz-gate relative z-10 flex min-w-0 rounded-xl border-2 bg-surface/95 px-3 py-2.5", STATUS_TONE[s.status], wide ? "flex-col items-start gap-1.5" : "items-center gap-3 pl-12", s.source === "preflight" && "border-dashed")}
                data-lift={reached && s.status !== "idle" ? "true" : "false"}
                style={{ ["--gate-glow" as string]: GLOW[s.status] ?? "transparent" }}
              >
                <span className="flex items-center gap-2">
                  <span className={cx("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border", STATUS_TONE[s.status], "bg-subtle")}>{s.icon}</span>
                  {wide && <span className="flex items-center gap-1 text-2xs font-bold uppercase tracking-[0.08em]">{ICON[s.status]} {wordFor(s)}</span>}
                </span>
                <span className="min-w-0">
                  <span className="block text-[15px] font-semibold leading-tight text-fg">{s.label}</span>
                  {!wide && <span className="mt-0.5 flex items-center gap-1 text-2xs font-bold uppercase tracking-[0.08em]">{ICON[s.status]} {wordFor(s)}</span>}
                  <span className="mt-0.5 line-clamp-2 text-xs text-muted" title={s.line}>{s.line}</span>
                  {s.source && (
                    <span className={cx("mt-1 inline-block whitespace-nowrap rounded px-1.5 py-[1px] text-[10px] font-bold uppercase tracking-[0.08em]", s.source === "preflight" ? "border border-dashed border-line-strong text-muted" : "bg-fg/10 text-fg")}>
                      {s.source === "preflight" ? "Preflight" : "On-chain tx"}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>

        {/* Connecting line behind the gates. */}
        <svg className="pointer-events-none absolute inset-0 z-0 h-full w-full overflow-visible" aria-hidden>
          {stages.slice(1).map((s, k) => {
            const i = k + 1;
            const color = s.status === "failed" ? "rgb(var(--danger))" : s.status === "warning" ? "rgb(var(--warning))" : s.status === "passed" ? "rgb(var(--primary))" : "rgb(var(--line-strong))";
            const dashed = s.status === "skipped" || s.status === "unknown" || s.status === "idle" || s.source === "preflight";
            const active = pos >= i - 0.001 && !dashed;
            return wide ? (
              <line key={s.key} x1={center(i - 1)} x2={center(i)} y1={railY} y2={railY} stroke={color} strokeWidth={active ? 3 : 2} strokeOpacity={active ? 0.95 : 0.55} strokeDasharray={dashed ? "6 6" : undefined} />
            ) : (
              <line key={s.key} x1="28" x2="28" y1={(i - 1) * ROW + (ROW - 12) / 2} y2={i * ROW + (ROW - 12) / 2} stroke={color} strokeWidth={active ? 3 : 2} strokeOpacity={active ? 0.95 : 0.55} strokeDasharray={dashed ? "6 6" : undefined} />
            );
          })}
          {wide &&
            stages.map((s, i) => {
              const color = s.status === "failed" ? "rgb(var(--danger))" : s.status === "warning" ? "rgb(var(--warning))" : s.status === "passed" ? "rgb(var(--primary))" : "rgb(var(--line-strong))";
              return (
                <g key={s.key}>
                  <line x1={center(i)} x2={center(i)} y1={railY - 22} y2={railY} stroke={color} strokeOpacity={0.6} strokeWidth={1.5} />
                  <circle cx={center(i)} cy={railY} r={5} fill="rgb(18 23 29)" stroke={color} strokeWidth={2} />
                </g>
              );
            })}
        </svg>

        {/* Barrier in front of the guard. */}
        <div
          aria-hidden
          className={cx("viz-barrier pointer-events-none absolute z-20 rounded-md", wide ? "w-2.5" : "h-2.5")}
          data-up={blocked && arrived ? "true" : "false"}
          data-predicted={predicted ? "true" : "false"}
          style={wide ? { left: center(3.5) - 5, top: 4, height: H - 4 } : { top: 4 * ROW - 11, left: 8, right: 8 }}
        />

        {/* Packet. */}
        <div
          aria-hidden
          className={cx("viz-packet pointer-events-none absolute z-30 h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2", predicted && guard.status !== "pending" ? "border-dashed" : "border-solid", props.executing || props.checking ? "animate-pulse2" : "")}
          style={{
            left: wide ? center(pos) : 28,
            top: wide ? railY : pos * ROW + (ROW - 12) / 2,
            backgroundColor: `rgb(var(--${packetTone}))`,
            borderColor: "rgb(255 255 255 / 0.85)",
            boxShadow: `0 0 0 4px rgb(var(--${packetTone}) / 0.25), 0 0 22px rgb(var(--${packetTone}) / 0.8)`,
          }}
        />
      </div>

      {/* Evidence: what differs, what the guard said, what the treasury saw. */}
      <div className="relative z-10 mt-5 grid gap-3 lg:grid-cols-3">
        <div className="rounded-xl border border-line bg-surface/90 p-3.5">
          <p className="label mb-2">Approved vs attempted</p>
          {!check && <p className="text-sm text-muted">Run the preflight check to compare this payload with the approved manifest.</p>}
          {check && check.status === "MATCH" && (
            <p className="flex items-start gap-2 text-sm text-primary">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> Identical to approved manifest v{check.version ?? "?"}: same digest {shortHash(check.submitted_manifest_hash, 8, 4)}.
            </p>
          )}
          {check && check.status !== "MATCH" && (
            <ul className="space-y-2.5">
              {diffs.slice(0, 3).map((d, i) => (
                <li key={i}>
                  <p className="text-xs font-semibold text-fg">
                    {d.title} <span className="font-mono text-2xs font-normal text-faint">{d.field_path}</span>
                  </p>
                  <div className="mt-1 grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-sm">
                    <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-primary">Approved</span>
                    <span className="break-words font-medium text-primary">{d.approved_display ?? String(d.approved_value ?? "—")}</span>
                    <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-danger">Attempted</span>
                    <span className="break-words font-medium text-danger">{d.submitted_display ?? String(d.submitted_value ?? "—")}</span>
                  </div>
                </li>
              ))}
              {digest && (
                <li className="text-2xs text-muted">
                  Digest {shortHash(digest.approved_value, 8, 4)} approved, {shortHash(digest.submitted_value, 8, 4)} attempted.
                </li>
              )}
              {diffs.length === 0 && !digest && <li className="text-sm text-warning">{check.preflight.summary}</li>}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-line bg-surface/90 p-3.5">
          <p className="label mb-2">Guard decision</p>
          <div className="space-y-3 text-sm">
            <div>
              <p className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted">Preflight prediction · eth_call, nothing sent</p>
              {props.checking && <p className="mt-1 flex items-center gap-1.5 text-info"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…</p>}
              {!props.checking && !check && <p className="mt-1 text-muted">Not run for this payload.</p>}
              {!props.checking && check && !check.preflight.performed && <p className="mt-1 text-warning">Not performed: {check.preflight.reason}</p>}
              {!props.checking && check?.preflight.performed && (
                check.preflight.would_execute ? (
                  <p className="mt-1 font-medium text-primary">Would execute.</p>
                ) : (
                  <p className="mt-1 text-danger">
                    <span className="font-mono font-semibold">{check.preflight.revert?.name}</span> <span className="text-muted">{firstSentence(check.preflight.revert?.explanation)}</span>
                  </p>
                )
              )}
            </div>
            <div>
              <p className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted">Submitted transaction · receipt</p>
              {props.executing && <p className="mt-1 flex items-center gap-1.5 text-info"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for the receipt…</p>}
              {!props.executing && !attempt && <p className="mt-1 text-muted">Nothing submitted. Use “Execute guarded demo”; it asks for confirmation.</p>}
              {!props.executing && attempt && (
                <div className="mt-1 space-y-1">
                  <p className={cx("font-semibold", attempt.outcome === "executed" ? "text-primary" : attempt.outcome === "rejected" ? "text-danger" : "text-warning")}>
                    {attempt.outcome === "executed" ? "Executed through the guard" : attempt.outcome === "rejected" ? <>Reverted: <span className="font-mono">{attempt.revert?.name}</span></> : "Not sent: gateway refusal"}
                  </p>
                  {attempt.revert && (
                    <p className="text-xs text-muted">
                      {attempt.revert.name === "AlreadyExecuted" ? "Replay rejected: this manifest already executed once, so the guard refuses to run it again." : firstSentence(attempt.revert.explanation)}
                    </p>
                  )}
                  {attempt.tx_hash && <TxLink hash={attempt.tx_hash} block={attempt.block_number} />}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-line bg-surface/90 p-3.5">
          <p className="label mb-2">Treasury</p>
          {attempt?.outcome === "executed" && attempt.balance_changes.length > 0 ? (
            <ul className="space-y-1.5">
              {attempt.balance_changes.map((b, i) => (
                <li key={i} className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate text-fg" title={b.holder}>{b.holder_label ?? shortHash(b.holder, 8, 4)}</span>
                  <span className={cx("shrink-0 font-mono font-semibold", b.delta.startsWith("-") ? "text-danger" : "text-primary")}>{b.display}</span>
                </li>
              ))}
              <li className="pt-1 text-2xs text-muted">Balances read from the chain after the confirmed transaction.</li>
            </ul>
          ) : (
            <p className={cx("text-sm", stages[5].status === "skipped" ? "text-fg" : "text-muted")}>
              {stages[5].status === "skipped" ? <>{blocked ? <XCircle className="mr-1 inline h-4 w-4 text-danger" /> : null}{stages[5].line}.</> : stages[5].line}
            </p>
          )}
          {!attempt && check?.preflight.would_execute && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
              <Play className="h-3.5 w-3.5" /> The preflight is a prediction. Funds move only after you confirm a submission.
            </p>
          )}
          {attempt && <Badge className="mt-2" tone={attempt.outcome === "executed" ? "success" : "neutral"}>{attempt.enforcement}</Badge>}
        </div>
      </div>
    </section>
  );
}
