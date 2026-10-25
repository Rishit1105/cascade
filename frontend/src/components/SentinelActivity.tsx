/* Live feed of sentinel reviews and simulations, streamed from the backend as they run. */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ChevronDown, Circle, FlaskConical, Loader2, Radar, XCircle } from "lucide-react";
import { cx, timeAgo } from "../lib/format";
import { useActivityRuns, useLive, type ActivityRun, type ActivityStatus } from "../lib/live";
import { Badge, TxLink } from "./ui";

const STEP_ICON: Record<ActivityStatus, JSX.Element> = {
  info: <Circle className="h-3 w-3 text-faint" strokeWidth={3} />,
  success: <CheckCircle2 className="h-3.5 w-3.5 text-primary" />,
  warning: <AlertTriangle className="h-3.5 w-3.5 text-warning" />,
  failure: <XCircle className="h-3.5 w-3.5 text-danger" />,
};

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function LiveIndicator({ className }: { className?: string }) {
  const { connected } = useLive();
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-2xs font-medium", connected ? "text-primary" : "text-warning", className)} title={connected ? "Receiving live updates from the API" : "Live updates disconnected; reconnecting"}>
      <span className={cx("h-1.5 w-1.5 rounded-full", connected ? "animate-pulse2 bg-primary" : "bg-warning")} />
      {connected ? "Live" : "Reconnecting"}
    </span>
  );
}

/** A run is still in progress if it has no outcome yet and moved recently. */
function useRunning(run: ActivityRun): boolean {
  const done = run.halted || run.items.some((m) => ["halted", "halt_failed", "passed", "flagged", "escalated"].includes(m.stage)) || (run.source === "simulation" && !!run.verdict);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (done) return;
    const t = window.setInterval(() => setNow(Date.now()), 2000);
    return () => window.clearInterval(t);
  }, [done]);
  return !done && now - Date.parse(run.updatedAt) < 30_000;
}

function Outcome({ run, running }: { run: ActivityRun; running: boolean }) {
  if (run.halted) return <Badge tone="danger">Halted on-chain</Badge>;
  if (running) return <Badge tone="info" icon={<Loader2 className="h-3 w-3 animate-spin" />}>Running</Badge>;
  const v = run.verdict;
  if (v === "block") return <Badge tone="danger">BLOCK</Badge>;
  if (v === "flag") return <Badge tone="warning">FLAG</Badge>;
  if (v === "pass") return <Badge tone="success">PASS</Badge>;
  if (v === "error") return <Badge tone="danger">Error</Badge>;
  return <Badge>Stopped</Badge>;
}

function RunCard({ run, defaultOpen, showProposal }: { run: ActivityRun; defaultOpen: boolean; showProposal: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const running = useRunning(run);
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);
  const Icon = run.source === "sentinel" ? Radar : FlaskConical;
  return (
    <li className={cx("rounded-lg border bg-surface", running ? "border-info/40" : run.halted || run.verdict === "block" ? "border-danger/30" : "border-line")}>
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon className={cx("h-3.5 w-3.5 shrink-0", run.source === "sentinel" ? "text-primary" : "text-info")} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-xs font-semibold text-fg">{run.source === "sentinel" ? "Sentinel review" : "Simulation"}</span>
            {showProposal && run.proposalId && (
              <Link to={`/proposals/${run.proposalId}`} onClick={(e) => e.stopPropagation()} className="font-mono text-2xs font-semibold text-primary hover:underline">
                {run.proposalId}
              </Link>
            )}
            {run.simulationId && <span className="font-mono text-2xs text-faint">{run.simulationId}</span>}
          </span>
          <span className="block text-2xs text-faint" title={run.startedAt}>
            {clock(run.startedAt)} · {timeAgo(run.startedAt)} · {run.items.length} step{run.items.length === 1 ? "" : "s"}
          </span>
        </span>
        <Outcome run={run} running={running} />
        <ChevronDown className={cx("h-3.5 w-3.5 shrink-0 text-faint transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ol className="space-y-1.5 border-t border-line px-3 py-2.5">
          {run.items.map((m, i) => (
            <li key={m.id} className="flex gap-2 text-xs">
              <span className="mt-0.5 flex w-3.5 shrink-0 justify-center">
                {running && i === run.items.length - 1 ? <Loader2 className="h-3.5 w-3.5 animate-spin text-info" /> : STEP_ICON[m.status] ?? STEP_ICON.info}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cx("text-fg", m.status === "failure" && "text-danger")}>{m.message}</span>
                {m.tx_hash && (
                  <span className="ml-1.5 inline-flex">
                    <TxLink hash={m.tx_hash} block={m.block_number} />
                  </span>
                )}
              </span>
              <span className="shrink-0 font-mono text-2xs text-faint">{clock(m.at)}</span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

export function SentinelActivity({ proposalId, limit = 5, empty, className }: { proposalId?: string; limit?: number; empty?: string; className?: string }) {
  const runs = useActivityRuns(proposalId, limit);
  if (runs.length === 0) {
    return (
      <p className={cx("rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-muted", className)}>
        {empty ?? "No reviews yet in this session. Finalize a vote or run a simulation and every step appears here as it happens."}
      </p>
    );
  }
  return (
    <ul className={cx("space-y-2", className)}>
      {runs.map((r, i) => (
        <RunCard key={r.key} run={r} defaultOpen={i === 0} showProposal={!proposalId} />
      ))}
    </ul>
  );
}
