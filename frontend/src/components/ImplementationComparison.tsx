/* Submitted vs reviewed implementation, simulated side by side from the same block with the same
   probe callers (POST /simulations/compare). The vault → call → destination diagram only shows a
   fund movement when the run recorded a Transfer for that probe call; replay is purely visual. */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, CheckCircle2, FlaskConical, GitCompareArrows, Landmark, Loader2, PhoneOutgoing, RotateCcw, TriangleAlert, Wallet, XCircle } from "lucide-react";
import { api } from "../lib/api";
import { cx, shortAddr } from "../lib/format";
import { useAction } from "../lib/queries";
import { useMedia } from "../lib/useMedia";
import { Badge, Button, Hash, SeverityBadge } from "./ui";

interface Probe {
  function: string;
  caller: string;
  caller_role: string;
  caller_label: string | null;
  status: string;
  revert: string | null;
  outflows: Array<{ token: string; from: string; to: string; amount: string; display: string }>;
  control_changed: boolean;
}
interface Side {
  simulation_id: string;
  status: string;
  verdict: "pass" | "flag" | "block" | "error";
  error: string | null;
  start_block: number | null;
  summary: string | null;
  implementation: string | null;
  implementation_label: string | null;
  codehash: string | null;
  code_size: number | null;
  embedded_unknown: string[];
  upgrade_status: string | null;
  callers: Array<{ role: string; address: string; label: string | null }>;
  probes: Probe[];
  fund_moving_probes: Probe[];
  control_probes: Probe[];
  findings: Array<{ rule_id: string; severity: string; title: string; explanation: string }>;
  limitations: string[];
}
interface Comparison {
  proposal_id: string;
  basis_version: number;
  same_start_block: boolean;
  start_block: number | null;
  vault: string | null;
  vault_label: string | null;
  vault_balance_start_display: string | null;
  submitted: Side;
  reviewed: Side;
  divergence: { kind: string; function: string; caller: string; caller_role: string; caller_label: string | null; submitted: Probe; reviewed: Probe | null } | null;
  note: string;
}

const VERDICT_TONE = { pass: "success", flag: "warning", block: "danger", error: "danger" } as const;
const splitDisplay = (d: string) => {
  const [amount, ...rest] = d.split(" → ");
  return { amount, to: rest.join(" → ") };
};

/** Which call to draw for a side: the divergence call when there is one, otherwise its first fund-moving probe. */
function focusProbe(c: Comparison, which: "submitted" | "reviewed"): Probe | null {
  const side = c[which];
  if (c.divergence) {
    const key = (p: Probe) => p.caller.toLowerCase() === c.divergence!.caller.toLowerCase() && p.function === c.divergence!.function;
    return side.probes.find(key) ?? null;
  }
  return side.fund_moving_probes[0] ?? null;
}

function Diagram({ c, which, step }: { c: Comparison; which: "submitted" | "reviewed"; step: number }) {
  const side = c[which];
  const probe = focusProbe(c, which);
  const moved = probe?.outflows?.[0];
  const toneOf = moved ? "danger" : probe ? (probe.status === "success" ? "primary" : "warning") : "muted";
  const nodes = [
    { key: "vault", icon: <Landmark className="h-4 w-4" />, title: c.vault_label ?? "Vault", line: c.vault_balance_start_display ? `Start balance ${c.vault_balance_start_display}` : shortAddr(c.vault), tone: "fg" },
    {
      key: "call",
      icon: <PhoneOutgoing className="h-4 w-4" />,
      title: probe ? probe.function : "No matching call",
      line: probe ? `by ${probe.caller_role}${probe.caller_label ? ` · ${probe.caller_label}` : ""} (${shortAddr(probe.caller)}) · ${probe.status}${probe.revert ? ` (${probe.revert})` : ""}` : "This call was not probed on this side",
      tone: probe ? (probe.status === "success" ? "fg" : "warning") : "muted",
    },
    {
      key: "dest",
      icon: <Wallet className="h-4 w-4" />,
      title: moved ? splitDisplay(moved.display).to || shortAddr(moved.to) : "No transfer observed",
      line: moved ? `${splitDisplay(moved.display).amount} moved (Transfer event in the probe call)` : probe ? "The probe call recorded no Transfer from the vault" : "—",
      tone: moved ? "danger" : "muted",
    },
  ];
  return (
    <ol className="relative space-y-3" aria-label={`${which} implementation: ${moved ? `${probe?.function} moved ${moved.display}` : "no fund movement observed for this call"}`}>
      {nodes.map((n, i) => {
        const reached = step >= i;
        const red = i === 2 && moved;
        return (
          <li key={n.key} className="relative">
            {i > 0 && (
              <span aria-hidden className="absolute -top-3 left-6 flex h-3 w-px justify-center">
                <span className={cx("h-full w-[2px] rounded transition-colors duration-300", reached ? (i === 2 && !moved ? "bg-line-strong" : toneOf === "danger" ? "bg-danger" : "bg-primary") : "bg-line")} />
              </span>
            )}
            <div
              className={cx(
                "viz-gate flex items-start gap-2.5 rounded-xl border-2 bg-surface/95 px-3 py-2",
                red && reached ? "border-danger/80" : reached && i < 2 ? "border-primary/50" : "border-line",
                i === 2 && !moved && "border-dashed",
              )}
              data-lift={reached ? "true" : "false"}
              style={{ ["--gate-glow" as string]: red ? "rgb(var(--danger) / 0.6)" : "rgb(var(--primary) / 0.35)" }}
            >
              <span className={cx("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-subtle", red ? "border-danger/60 text-danger" : n.tone === "warning" ? "border-warning/60 text-warning" : "border-line text-fg")}>{n.icon}</span>
              <span className="min-w-0">
                <span className={cx("block break-words font-mono text-sm font-semibold", red ? "text-danger" : "text-fg")}>{n.title}</span>
                <span className="mt-0.5 block text-xs text-muted">{n.line}</span>
              </span>
            </div>
            {i === 1 && moved && (
              <span aria-hidden className={cx("pointer-events-none absolute left-[18px] z-20 h-4 w-4 rounded-full bg-danger transition-all duration-500", step >= 2 ? "top-[calc(100%-2px)] opacity-100" : "top-1/2 opacity-0")} style={{ boxShadow: "0 0 0 4px rgb(var(--danger) / 0.25), 0 0 18px rgb(var(--danger) / 0.9)" }} />
            )}
          </li>
        );
      })}
      {side.status === "completed" && !moved && probe && (
        <li className="flex items-center gap-1.5 pl-1 text-xs font-medium text-primary">
          <ArrowDown className="h-3.5 w-3.5" /> Funds stayed in the vault for this call.
        </li>
      )}
    </ol>
  );
}

function SideCard({ c, which, step }: { c: Comparison; which: "submitted" | "reviewed"; step: number }) {
  const side = c[which];
  const failed = side.status !== "completed";
  const border = failed ? "border-danger/60" : side.verdict === "block" ? "border-danger/50" : side.verdict === "flag" ? "border-warning/50" : "border-primary/50";
  return (
    <article className={cx("min-w-0 rounded-xl border-2 bg-surface/60 p-3.5", border)}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="label">{which === "submitted" ? "Submitted implementation" : "Reviewed implementation"}</p>
          <p className="mt-0.5 text-base font-semibold text-fg">{side.implementation_label ?? "Unlabelled implementation"}</p>
          {side.implementation && <Hash value={side.implementation} head={10} tail={6} />}
          <p className="mt-0.5 text-2xs text-muted">
            codehash <span className="font-mono">{side.codehash?.slice(0, 14) ?? "—"}…</span>
            {side.code_size ? ` · ${side.code_size} bytes` : ""}
            {side.embedded_unknown.length > 0 && <span className="text-danger"> · hard-codes {side.embedded_unknown.map((a) => shortAddr(a)).join(", ")}</span>}
          </p>
        </div>
        <div className="text-right">
          <Badge tone={failed ? "danger" : VERDICT_TONE[side.verdict]} className="px-2 py-0.5 text-xs">
            {failed ? "Simulation failed" : `Simulated ${side.verdict.toUpperCase()}`}
          </Badge>
          <p className="mt-1 font-mono text-2xs text-faint">{side.simulation_id}</p>
        </div>
      </header>

      {failed ? (
        <p className="mt-3 rounded-lg border border-danger/40 bg-danger/10 p-2.5 text-sm text-danger">This side did not complete: {side.error ?? "no error message"}. The other side's result stands on its own.</p>
      ) : (
        <>
          <div className="mt-3">
            <Diagram c={c} which={which} step={step} />
          </div>
          <p className="mt-3 text-xs text-muted">
            {side.probes.length} probe call(s) by {side.callers.length} caller(s) ·{" "}
            <span className={side.fund_moving_probes.length ? "font-semibold text-danger" : "text-primary"}>{side.fund_moving_probes.length} moved funds</span> ·{" "}
            <span className={side.control_probes.length ? "font-semibold text-danger" : ""}>{side.control_probes.length} changed control</span>
          </p>
          {side.findings.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {side.findings.slice(0, 2).map((f, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs">
                  <SeverityBadge severity={f.severity} />
                  <span className="min-w-0 text-fg">{f.title}</span>
                </li>
              ))}
              {side.findings.length > 2 && <li className="text-2xs text-muted">+{side.findings.length - 2} more in technical details</li>}
            </ul>
          ) : (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-primary"><CheckCircle2 className="h-3.5 w-3.5" /> No issue observed under these probes (not a proof of safety).</p>
          )}
        </>
      )}

      <details className="mt-3 rounded-lg border border-line text-xs">
        <summary className="cursor-pointer px-2.5 py-1.5 font-medium text-fg">Technical details</summary>
        <div className="space-y-2 border-t border-line p-2.5">
          <div className="max-h-[220px] overflow-auto scroll-thin">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Caller</th>
                  <th>Function</th>
                  <th>Observed</th>
                </tr>
              </thead>
              <tbody>
                {side.probes.map((pr, i) => (
                  <tr key={i} className={pr.outflows.length ? "bg-danger/10" : ""}>
                    <td className="text-2xs">{pr.caller_role}<span className="block font-mono text-faint">{shortAddr(pr.caller)}</span></td>
                    <td className="font-mono text-2xs">{pr.function}</td>
                    <td className="text-2xs">{pr.outflows.length ? <span className="font-semibold text-danger">moved {pr.outflows.map((o) => o.display).join(", ")}</span> : pr.status === "success" ? "ok · no funds moved" : `reverted (${pr.revert ?? "?"})`}{pr.control_changed && <span className="text-danger"> · control changed</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {side.findings.map((f, i) => (
            <p key={i} className="text-2xs text-muted"><span className="font-mono text-faint">{f.rule_id}</span> {f.title}: {f.explanation}</p>
          ))}
          {side.summary && <p className="text-2xs text-muted">{side.summary}</p>}
        </div>
      </details>
    </article>
  );
}

export function ImplementationComparison({ proposalId }: { proposalId: string }) {
  const qc = useQueryClient();
  const key = ["comparison", proposalId];
  // Cached so switching tabs keeps the last result; it is only ever fetched by the explicit button.
  const cached = useQuery<Comparison | null>({ queryKey: key, queryFn: () => null, enabled: false, staleTime: Infinity, gcTime: Infinity });
  const run = useAction(() => api.post<Comparison>(`/proposals/${proposalId}/simulations/compare`), {
    success: (r) => `Comparison complete: ${r.submitted.verdict.toUpperCase()} vs ${r.reviewed.verdict.toUpperCase()}`,
    tone: (r) => (r.divergence ? "warning" : "success"),
    invalidate: [["simulations"], ["audit"]],
    onSuccess: (r) => {
      qc.setQueryData<Comparison>(key, r);
    },
  });
  const c = cached.data ?? null;
  const reduced = useMedia("(prefers-reduced-motion: reduce)");
  const [step, setStep] = useState(2);
  const [replay, setReplay] = useState(0);

  useEffect(() => {
    if (!c) return;
    if (reduced) {
      setStep(2);
      return;
    }
    setStep(-1);
    const timers = [0, 1, 2].map((s) => window.setTimeout(() => setStep(s), 150 + s * 420));
    return () => timers.forEach(window.clearTimeout);
  }, [c, replay, reduced]);

  const d = c?.divergence;
  return (
    <section className="viz relative mb-3 overflow-hidden rounded-2xl p-4" aria-label="Attack simulation comparison">
      <div className="viz-depth pointer-events-none absolute inset-0" aria-hidden>
        <div className="viz-floor opacity-60" />
      </div>
      <div className="relative z-10">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-base font-semibold">
              <GitCompareArrows className="h-4 w-4 text-primary" /> Attack simulation: submitted vs reviewed
            </h3>
            <p className="mt-0.5 text-xs text-muted">Simulation only. Both implementations run on separate snapshots of the same state with the same probe callers; the chain is reverted after each.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" icon={<FlaskConical className="h-3.5 w-3.5" />} loading={run.isPending} onClick={() => run.mutate(undefined)}>
              {c ? "Run comparison again" : "Run comparison"}
            </Button>
            <Button size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} disabled={!c || run.isPending} onClick={() => setReplay((n) => n + 1)} title="Replays the diagram of the last result. Runs nothing.">
              Replay
            </Button>
          </div>
        </div>

        {run.isPending && (
          <p className="mt-4 flex items-center gap-2 text-sm text-info"><Loader2 className="h-4 w-4 animate-spin" /> Simulating both implementations on snapshots…</p>
        )}
        {!c && !run.isPending && (
          <p className="mt-4 rounded-lg border border-dashed border-line px-3 py-4 text-center text-sm text-muted">
            Run the comparison to simulate the submitted upgrade and the implementation reviewers approved, probing both with the same calls.
          </p>
        )}

        {c && !run.isPending && (
          <div className="mt-3 space-y-3">
            <p className={cx("text-xs", c.same_start_block ? "text-muted" : "text-warning")}>
              {c.same_start_block ? `Both started from block #${c.start_block}` : "Warning: the two runs started from different blocks"} · vault {c.vault_label ?? shortAddr(c.vault)}
              {c.vault_balance_start_display ? ` held ${c.vault_balance_start_display} at the start (observed)` : ""}
            </p>
            {d ? (
              <div className="rounded-xl border-2 border-danger/60 bg-danger/10 px-3.5 py-2.5">
                <p className="flex flex-wrap items-center gap-x-2 text-sm font-semibold text-danger">
                  <XCircle className="h-4 w-4" /> First divergence: <span className="font-mono">{d.function}</span>
                  <span className="font-normal text-fg">called by {d.caller_role}{d.caller_label ? ` · ${d.caller_label}` : ""} ({shortAddr(d.caller)})</span>
                </p>
                <p className="mt-1 text-sm text-fg">
                  Submitted: {d.submitted.outflows.length ? <span className="font-semibold text-danger">moved {d.submitted.outflows.map((o) => o.display).join(", ")}</span> : `${d.submitted.status}${d.submitted.control_changed ? ", changed control" : ""}`}.{" "}
                  Reviewed: {d.reviewed ? (d.reviewed.outflows.length ? `moved ${d.reviewed.outflows.map((o) => o.display).join(", ")}` : <span className="font-semibold text-primary">{d.reviewed.status}, no funds moved</span>) : "this function does not exist in the reviewed code"}.
                </p>
              </div>
            ) : (
              c.submitted.status === "completed" && c.reviewed.status === "completed" && (
                <p className="flex items-center gap-1.5 rounded-xl border border-primary/40 bg-primary/10 px-3.5 py-2.5 text-sm text-primary">
                  <CheckCircle2 className="h-4 w-4" /> No divergence observed between the two implementations under these probes.
                </p>
              )
            )}
            <div className="grid gap-3 md:grid-cols-2">
              <SideCard c={c} which="submitted" step={step} />
              <SideCard c={c} which="reviewed" step={step} />
            </div>
            <p className="flex items-start gap-1.5 text-2xs text-muted"><TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" /> {c.note}</p>
          </div>
        )}
      </div>
    </section>
  );
}
