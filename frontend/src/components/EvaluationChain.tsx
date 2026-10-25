import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, FileSearch, GitBranch, Network, ShieldCheck, Sigma, Vote } from "lucide-react";
import type { EvaluationChain as Chain } from "../lib/api";
import { cx, pct } from "../lib/format";
import { Modal } from "./overlays";
import { Badge, Button } from "./ui";

const STAGE_ICON: Record<string, typeof FileSearch> = { claims: FileSearch, conflict: Network, vote: Vote, execution: ShieldCheck };
const BAND = {
  low: { text: "text-primary", bar: "bg-primary", ring: "border-primary/30", label: "Low" },
  elevated: { text: "text-warning", bar: "bg-warning", ring: "border-warning/40", label: "Elevated" },
  high: { text: "text-danger", bar: "bg-danger", ring: "border-danger/40", label: "High" },
};
const STATUS_LABEL: Record<string, string> = { complete: "Evaluated", in_progress: "In progress", not_started: "Not started", contained: "Contained" };

function metricLine(key: string, m: Record<string, any>): string {
  if (key === "claims") return m.coverage_pct !== undefined ? `${m.coverage_pct}% claims cited · ${m.gaps} gap(s)` : "No brief yet";
  if (key === "conflict") return `${m.leads ?? 0} lead(s) · disclosure ${m.disclosure ?? "—"}`;
  if (key === "vote") return m.state === "not submitted" ? "No on-chain vote yet" : `${m.state} · ${m.for_pct ?? 0}% for · ${m.participation_pct ?? "—"}% turnout`;
  return `guard ${m.guard ?? "—"} · sim ${m.simulation ?? "—"}${m.blocked_attempts ? ` · ${m.blocked_attempts} blocked` : ""}`;
}

export function EvaluationChainView({ chain, proposalId, compact }: { chain: Chain; proposalId: string; compact?: boolean }) {
  const navigate = useNavigate();
  const [explain, setExplain] = useState(false);
  return (
    <div>
      <div className="relative">
        <div className="absolute left-[6%] right-[6%] top-[22px] hidden h-[3px] rounded-full bg-gradient-to-r from-primary/40 via-line-strong to-primary/40 lg:block" aria-hidden />
        <ol className="relative grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {chain.stages.map((s, i) => {
            const Icon = STAGE_ICON[s.key] ?? GitBranch;
            const band = BAND[s.band];
            const top = [...s.items].sort((a, b) => Math.abs(Math.log(b.lr)) - Math.abs(Math.log(a.lr))).slice(0, compact ? 1 : 2);
            return (
              <li key={s.key} className="flex min-w-0 flex-col items-center">
                <div className={cx("z-10 mb-2 flex h-11 w-11 items-center justify-center rounded-full border-2 bg-surface shadow-card", band.ring)}>
                  <Icon className={cx("h-5 w-5", band.text)} />
                </div>
                <button
                  onClick={() => navigate(`${s.link}?p=${proposalId}`)}
                  className={cx("group w-full rounded-xl border bg-surface p-3 text-left shadow-card transition-colors hover:border-line-strong", s.status === "contained" ? "border-primary/40" : "border-line")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted">
                      {i + 1}. {s.name}
                    </span>
                    <ArrowRight className="h-3.5 w-3.5 text-faint transition-transform group-hover:translate-x-0.5" />
                  </div>
                  <div className="mt-2 flex items-end justify-between gap-2">
                    <span className={cx("text-[22px] font-semibold leading-none tracking-[-0.02em]", band.text)}>{pct(s.posterior, s.posterior < 0.1 ? 1 : 0)}</span>
                    <Badge tone={s.status === "contained" ? "success" : s.status === "not_started" ? "neutral" : s.band === "high" ? "danger" : s.band === "elevated" ? "warning" : "success"}>
                      {s.status === "contained" ? "Contained" : s.status === "not_started" ? "Not started" : band.label}
                    </Badge>
                  </div>
                  <div className="relative mt-2 h-1.5 rounded-full bg-subtle" title={`prior ${pct(s.prior)} → posterior ${pct(s.posterior, 1)}`}>
                    <div className={cx("absolute inset-y-0 left-0 rounded-full", band.bar)} style={{ width: `${Math.max(2, s.posterior * 100)}%` }} />
                    <div className="absolute -top-0.5 h-2.5 w-0.5 rounded bg-fg/60" style={{ left: `${s.prior * 100}%` }} />
                  </div>
                  <p className="mt-1.5 text-2xs text-muted">{STATUS_LABEL[s.status] ?? s.status} · prior {pct(s.prior)}</p>
                  {!compact && <p className="mt-1.5 truncate text-xs text-fg">{metricLine(s.key, s.metrics)}</p>}
                  <ul className="mt-1.5 space-y-0.5">
                    {top.map((f) => (
                      <li key={f.key + f.label} className="flex items-center gap-1.5 text-2xs text-muted">
                        <span className={cx("font-mono font-semibold", f.lr > 1 ? "text-danger" : "text-primary")}>×{f.lr}</span>
                        <span className="truncate">{f.label}</span>
                      </li>
                    ))}
                    {top.length === 0 && <li className="text-2xs text-faint">No evidence yet: prior applies.</li>}
                  </ul>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <Sigma className="h-3.5 w-3.5" />
          Combined estimate that the decision is not well-informed or not faithfully executed:
          <strong className="text-fg">{pct(chain.overall, 1)}</strong>
          <span className="text-faint">· {chain.label}</span>
        </span>
        <Button size="sm" variant="ghost" onClick={() => setExplain(true)}>
          How is this computed?
        </Button>
      </div>
      <Modal open={explain} onClose={() => setExplain(false)} title="Probabilistic evaluation chain" subtitle={chain.formula} width="max-w-2xl">
        <p className="mb-4 text-sm text-muted">{chain.method}</p>
        <div className="space-y-4">
          {chain.stages.map((s) => (
            <div key={s.key}>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-sm font-semibold">{s.name}</p>
                <p className="font-mono text-xs text-muted">
                  prior {pct(s.prior)} → posterior {pct(s.posterior, 1)}
                </p>
              </div>
              <table className="table-base rounded-lg border border-line">
                <thead>
                  <tr>
                    <th>Evidence</th>
                    <th className="w-24 text-right">Likelihood ratio</th>
                  </tr>
                </thead>
                <tbody>
                  {s.items.length === 0 && (
                    <tr>
                      <td colSpan={2} className="text-muted">No evidence recorded yet.</td>
                    </tr>
                  )}
                  {s.items.map((it, i) => (
                    <tr key={i}>
                      <td>
                        {it.label}
                        <span className="ml-1.5 font-mono text-2xs text-faint">{it.key}</span>
                      </td>
                      <td className={cx("text-right font-mono", it.lr > 1 ? "text-danger" : it.lr < 1 ? "text-primary" : "text-muted")}>×{it.lr}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {s.notes.map((n) => (
                <p key={n} className="mt-1 text-2xs text-muted">{n}</p>
              ))}
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-muted">Priors and likelihood ratios are editable in Settings → Risk model.</p>
      </Modal>
    </div>
  );
}
