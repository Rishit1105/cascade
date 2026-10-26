import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { motion } from "motion/react";
import { AlertTriangle, BadgeCheck, Blocks, CheckCircle2, CircleDashed, Clock3, Download, FileCheck2, FileJson, FileSpreadsheet, FileText, Fingerprint, Info, Minus, Plus, ScrollText, ShieldCheck, Sparkles, Stamp, Tag, XCircle } from "lucide-react";
import { api } from "../lib/api";
import { useSelectedProposal } from "../lib/app";
import { CONTROLS, FAMILIES, coverage, familyOf, perDay, readiness, type ControlState } from "../lib/compliance";
import { cx, dateTime, timeAgo } from "../lib/format";
import { AnimatedNumber, EASE, GrowBar } from "../lib/motion";
import { useAction, useAlerts, useAuditEvents, useProposals, useReports } from "../lib/queries";
import { ProposalPicker } from "../components/common";
import { DonutChart, Legend, RingGauge, Sparkline, toneColor, type Tone } from "../components/riskviz";
import { Badge, Button, Hash, LoadingBlock, Panel, Segmented } from "../components/ui";

const FORMAT = {
  pdf: { icon: FileText, color: "#E5484D", label: "PDF" },
  json: { icon: FileJson, color: "#3E8EDE", label: "JSON" },
  csv: { icon: FileSpreadsheet, color: "#22A06B", label: "CSV" },
} as const;
const FAMILY_COLOR: Record<string, string> = { governance: "rgb(var(--info))", evidence: "rgb(var(--primary))", review: "#B48CFA", security: "rgb(var(--danger))", system: "rgb(var(--faint))" };
const CELL: Record<ControlState, { icon: typeof CheckCircle2; tone: Tone; label: string }> = {
  done: { icon: CheckCircle2, tone: "primary", label: "evidenced" },
  partial: { icon: CircleDashed, tone: "warning", label: "partial" },
  missing: { icon: XCircle, tone: "danger", label: "missing" },
  na: { icon: Minus, tone: "faint", label: "not applicable" },
};
const shortDay = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export default function Reports() {
  const reports = useReports();
  const events = useAuditEvents({ limit: 1000 });
  const alerts = useAlerts({ status: "open" });
  const proposals = useProposals();
  const [verify, setVerify] = useState<any>(null);
  const [range, setRange] = useState<"30" | "7">("30");
  const builderRef = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);
  const runVerify = useAction(() => api.post<any>("/audit/verify"), { quiet: true, onSuccess: setVerify, invalidate: [["audit"]] });

  const items = events.data?.items ?? [];
  const reportItems = reports.data?.items ?? [];
  const days = useMemo(() => perDay(items), [items]);
  const shownDays = range === "7" ? days.slice(-7) : days.slice(-30);
  const chainShare = items.length ? items.filter((e) => e.verification === "chain-confirmed").length / items.length : 0;
  const openAlerts = alerts.data?.items ?? [];
  const severe = openAlerts.filter((a) => a.severity === "critical" || a.severity === "high").length;
  const pids = useMemo(() => (proposals.data ?? []).map((p) => p.id).sort(), [proposals.data]);
  const rows = useMemo(() => coverage(pids, items, reportItems.map((r: any) => r.proposal_id)), [pids, items, reportItems]);
  const coverageAvg = rows.length ? rows.reduce((a, r) => a + r.score, 0) / rows.length : 0;
  const integrity: "intact" | "broken" | "unverified" = verify ? (verify.ok ? "intact" : "broken") : "unverified";
  const ready = readiness({ integrity, chainShare, openSevere: severe, coverage: coverageAvg });
  const readyTone: Tone = ready.score >= 75 ? "primary" : ready.score >= 50 ? "warning" : "danger";
  const families = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of items) m.set(familyOf(e.event_type), (m.get(familyOf(e.event_type)) ?? 0) + 1);
    return [...FAMILIES.map((f) => ({ id: f.id, label: f.label })), { id: "system", label: "Ledger & system" }].map((f) => ({ label: f.label, value: m.get(f.id) ?? 0, color: FAMILY_COLOR[f.id] }));
  }, [items]);
  const goBuild = () => {
    builderRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlash(true);
    window.setTimeout(() => setFlash(false), 1400);
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Compliance & audit export</h1>
          <p className="mt-0.5 text-sm text-muted">Human-readable and machine-readable reports that keep evidence labels and limitations attached.</p>
        </div>
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={goBuild}>Generate audit report</Button>
      </div>

      <Scorecard
        score={ready.score}
        tone={readyTone}
        parts={ready.parts}
        verify={verify}
        verifying={runVerify.isPending}
        onVerify={() => runVerify.mutate(undefined)}
        tiles={[
          { label: "Ledger integrity", value: integrity === "intact" ? "Intact" : integrity === "broken" ? "Broken" : "Unverified", sub: verify ? `${verify.event_count} events · ${verify.chain_receipts.confirmed}/${verify.chain_receipts.checked} receipts` : "Run a verification to confirm", tone: integrity === "intact" ? "primary" : integrity === "broken" ? "danger" : "warning", icon: <Fingerprint className="h-4 w-4" /> },
          { label: "Chain-confirmed", value: `${Math.round(chainShare * 100)}%`, sub: "daily share, last 14 days", tone: "primary", icon: <Blocks className="h-4 w-4" />, spark: days.slice(-14).map((d) => d.share) },
          { label: "Open severe alerts", value: String(severe), sub: `${openAlerts.length} open in total`, tone: severe ? "danger" : "primary", icon: <AlertTriangle className="h-4 w-4" /> },
          { label: "Reports generated", value: String(reportItems.length), sub: reportItems[0] ? `last ${timeAgo(reportItems[0].generated_at)}` : "none yet", tone: "info", icon: <FileCheck2 className="h-4 w-4" />, spark: days.slice(-14).map((d) => d.cumulative) },
        ]}
      />

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel
            title="Historical logs"
            subtitle="Audit events per day by verification, with cumulative ledger growth"
            icon={<ScrollText className="h-4 w-4 text-primary" />}
            actions={<Segmented size="sm" value={range} onChange={setRange} options={[{ id: "30", label: "30 days" }, { id: "7", label: "7 days" }]} />}
          >
            {events.isLoading ? <LoadingBlock rows={5} /> : <LogsChart days={shownDays} />}
          </Panel>

          <CoverageMatrix rows={rows} />

          <div ref={builderRef} className={cx("rounded-xl transition-shadow duration-500", flash && "shadow-[0_0_0_3px_rgb(var(--primary)/0.45)]")}>
            <ReportBuilder sections={reports.data?.sections ?? {}} />
          </div>

          <Panel title="Generated reports" subtitle="Each file's SHA-256 is recorded in the audit ledger" icon={<Stamp className="h-4 w-4 text-info" />}>
            {reports.isLoading && <LoadingBlock rows={3} />}
            {!reports.isLoading && reportItems.length === 0 && (
              <div className="flex items-center gap-3 rounded-lg border border-dashed border-line px-3 py-3">
                <FileCheck2 className="h-5 w-5 shrink-0 text-faint" />
                <p className="text-xs text-muted"><span className="font-semibold text-fg">No reports yet.</span> Generate one with the report builder above; it appears here with its SHA-256 and a download link.</p>
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-2">
              {reportItems.map((r: any, i: number) => {
                const f = FORMAT[r.format as keyof typeof FORMAT] ?? FORMAT.pdf;
                const total = Object.keys(reports.data?.sections ?? {}).length || r.sections.length;
                return (
                  <motion.div key={r.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05, ease: EASE }} className="group relative overflow-hidden rounded-xl border border-line p-3.5 transition-shadow hover:shadow-card">
                    <span className="absolute inset-y-0 left-0 w-1" style={{ background: f.color }} />
                    <div className="flex items-start gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ background: `${f.color}18`, color: f.color }}><f.icon className="h-5 w-5" /></span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold">{r.file_name}</p>
                        <p className="mt-0.5 text-2xs text-muted">{r.proposal_id} · {dateTime(r.generated_at)} · {r.generated_by}</p>
                      </div>
                      <Badge>{f.label}</Badge>
                    </div>
                    <div className="mt-3 flex items-center gap-2 text-2xs text-muted">
                      <span className="whitespace-nowrap">{r.sections.length}/{total} sections</span>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-subtle"><GrowBar pct={(r.sections.length / total) * 100} className="h-full rounded-full bg-primary/70" /></div>
                      <span className="whitespace-nowrap">{(r.size_bytes / 1024).toFixed(1)} KB</span>
                    </div>
                    <div className="mt-2.5 flex items-center justify-between gap-2">
                      <Hash value={r.sha256} head={12} tail={4} />
                      <a className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-ink px-2.5 text-xs font-medium text-white transition-opacity hover:opacity-90 dark:bg-fg dark:text-ink" href={`/api/reports/${r.id}/download`} download><Download className="h-3.5 w-3.5" />Download</a>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </Panel>
        </div>

        <div className="flex flex-col gap-4 xl:sticky xl:top-[72px] xl:self-start">
          <Panel title="Ledger composition" subtitle={`${items.length} events by family`} icon={<Blocks className="h-4 w-4 text-info" />}>
            <div className="flex items-center gap-4">
              <DonutChart size={124} segments={families} center={<AnimatedNumber value={items.length} />} sub="events" />
              <Legend className="min-w-0 flex-1" items={families.map((f) => ({ label: f.label, value: f.value, color: f.color }))} />
            </div>
          </Panel>
          <Panel title="Regulatory-style disclosures" subtitle="Open alerts a report would disclose" icon={<AlertTriangle className="h-4 w-4 text-warning" />}>
            {openAlerts.length === 0 && <p className="text-xs text-muted">No open alerts to disclose.</p>}
            <ul className="space-y-1.5">
              {openAlerts.slice(0, 6).map((a) => (
                <li key={a.id} className="relative overflow-hidden rounded-lg border border-line py-2 pl-3.5 pr-2.5">
                  <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: a.severity === "critical" || a.severity === "high" ? "rgb(var(--danger))" : "rgb(var(--warning))" }} />
                  <div className="flex items-start justify-between gap-2">
                    <span className="line-clamp-2 text-xs font-medium">{a.title}</span>
                    <Badge tone={a.severity === "critical" || a.severity === "high" ? "danger" : "warning"}>{a.severity}</Badge>
                  </div>
                  <p className="mt-0.5 text-2xs text-muted">{a.proposal_id ?? "system"} · {a.source.replace(/_/g, " ")} · {timeAgo(a.created_at)}</p>
                </li>
              ))}
            </ul>
            {openAlerts.length > 6 && <p className="mt-2 text-2xs text-faint">+{openAlerts.length - 6} more in Risk escalation</p>}
          </Panel>
          <Panel title="What every report includes" icon={<ShieldCheck className="h-4 w-4 text-primary" />}>
            <ul className="space-y-2.5">
              {[
                [Tag, "Evidence labels", "Chain-confirmed or off-chain; verified or heuristic, on every claim."],
                [Info, "Demo-data notice", "States plainly that the DAO and its data are fictional."],
                [Clock3, "Generation context", "Time, chain id, block number and the generating actor."],
                [Sparkles, "Method limits", "What each check can and cannot prove. Heuristics are never presented as facts."],
              ].map(([Icon, t, b]) => {
                const I = Icon as typeof Tag;
                return (
                  <li key={t as string} className="flex gap-2.5">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><I className="h-3.5 w-3.5" /></span>
                    <span><span className="block text-xs font-semibold">{t as string}</span><span className="block text-2xs leading-snug text-muted">{b as string}</span></span>
                  </li>
                );
              })}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

interface Tile {
  label: string;
  value: string;
  sub: string;
  tone: Tone;
  icon: ReactNode;
  spark?: number[];
}

function Scorecard({ score, tone, parts, tiles, verify, verifying, onVerify }: { score: number; tone: Tone; parts: ReturnType<typeof readiness>["parts"]; tiles: Tile[]; verify: any; verifying: boolean; onVerify: () => void }) {
  const band = score >= 75 ? "Audit-ready" : score >= 50 ? "Needs attention" : "At risk";
  return (
    <section className="viz grid gap-5 rounded-xl p-5 shadow-card lg:grid-cols-[auto_minmax(0,1fr)] 2xl:grid-cols-[auto_minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col items-center justify-center gap-2 lg:pr-2">
        <RingGauge value={score} tone={tone} size={150} stroke={12} track="rgb(255 255 255 / 0.08)" center={<AnimatedNumber value={score} />} sub="readiness score" />
        <span className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold" style={{ background: toneColor(tone, 0.16), color: toneColor(tone) }}>{band}</span>
        <p className="max-w-[180px] text-center text-[10.5px] leading-snug text-faint">Composite of the four measures shown, with their weights. Not a certification.</p>
      </div>
      <div className="min-w-0">
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-[13.5px] font-semibold"><BadgeCheck className="h-4 w-4 text-primary" /> How the score is made</p>
          <button onClick={onVerify} disabled={verifying} className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 text-[11px] font-semibold text-[#06231b] transition-opacity hover:opacity-90 disabled:opacity-60">
            <ShieldCheck className="h-3.5 w-3.5" /> {verifying ? "Verifying…" : verify ? "Verify again" : "Verify ledger"}
          </button>
        </div>
        <ul className="space-y-3">
          {parts.map((p, i) => {
            const t: Tone = p.value >= 0.75 ? "primary" : p.value >= 0.45 ? "warning" : "danger";
            return (
              <motion.li key={p.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 + i * 0.07, ease: EASE }}>
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="flex items-center gap-2 font-semibold">{p.label}<span className="rounded bg-white/[0.07] px-1.5 py-px text-[10px] font-semibold text-muted">{Math.round(p.weight * 100)}%</span></span>
                  <span className="font-mono text-[11px]" style={{ color: toneColor(t) }}>+{Math.round(p.weight * p.value * 100)} pts</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.07]"><GrowBar pct={p.value * 100} className={cx("h-full rounded-full", t === "primary" ? "bg-primary" : t === "warning" ? "bg-warning" : "bg-danger")} /></div>
                <p className="mt-1 text-[10.5px] text-muted">{p.detail}</p>
              </motion.li>
            );
          })}
        </ul>
      </div>
      <div className="grid grid-cols-2 gap-2.5 lg:col-span-2 lg:grid-cols-4 2xl:col-span-1 2xl:grid-cols-2">
        {tiles.map((t, i) => (
          <motion.div key={t.label} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + i * 0.06, ease: EASE }} className="flex flex-col justify-between rounded-xl border border-white/[0.07] bg-white/[0.03] p-3">
            <div className="flex items-center justify-between">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: toneColor(t.tone, 0.16), color: toneColor(t.tone) }}>{t.icon}</span>
              {t.spark && <Sparkline values={t.spark} tone={t.tone} width={84} height={26} />}
            </div>
            <div className="mt-2">
              <p className="text-[20px] font-semibold leading-tight" style={{ color: toneColor(t.tone) }}><AnimatedNumber value={t.value} /></p>
              <p className="text-[11px] font-semibold">{t.label}</p>
              <p className="truncate text-[10.5px] text-faint">{t.sub}</p>
            </div>
          </motion.div>
        ))}
      </div>
    </section>
  );
}

function ChartTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="rounded-lg border border-line bg-surface/95 px-3 py-2 text-xs shadow-card backdrop-blur">
      <p className="font-semibold">{shortDay(label)}</p>
      <p className="mt-1 flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-primary" />{row.chain} chain-confirmed</p>
      <p className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-info" />{row.offchain} off-chain</p>
      <p className="mt-1 border-t border-line pt-1 text-muted">{row.cumulative} events in the ledger so far</p>
    </div>
  );
}

function LogsChart({ days }: { days: ReturnType<typeof perDay> }) {
  const total = days.reduce((a, d) => a + d.total, 0);
  const peak = days.reduce((m, d) => (d.total > m.total ? d : m), days[0] ?? { day: "", total: 0 } as any);
  const avg = days.length ? total / days.length : 0;
  const active = days.filter((d) => d.total > 0).length;
  const stats: Array<[string, string, Tone]> = [
    ["Events in range", String(total), "info"],
    ["Peak day", peak?.day ? `${peak.total} · ${shortDay(peak.day)}` : "—", "warning"],
    ["Average per day", avg.toFixed(1), "primary"],
    ["Active days", `${active}/${days.length}`, "faint"],
  ];
  return (
    <div>
      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        {stats.map(([k, v, t]) => (
          <div key={k} className="rounded-lg border border-line px-3 py-2">
            <p className="text-2xs text-muted">{k}</p>
            <p className="mt-0.5 text-[15px] font-semibold" style={{ color: t === "faint" ? undefined : toneColor(t) }}>{v}</p>
          </div>
        ))}
      </div>
      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={days} margin={{ top: 10, right: 4, left: -14, bottom: 0 }}>
            <defs>
              <linearGradient id="dg-chain" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="rgb(var(--primary))" stopOpacity={0.55} />
                <stop offset="100%" stopColor="rgb(var(--primary))" stopOpacity={0.04} />
              </linearGradient>
              <linearGradient id="dg-off" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="rgb(var(--info))" stopOpacity={0.45} />
                <stop offset="100%" stopColor="rgb(var(--info))" stopOpacity={0.03} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 4" vertical={false} />
            <XAxis dataKey="day" tickLine={false} axisLine={false} tickFormatter={shortDay} minTickGap={24} tick={{ fontSize: 11, fill: "rgb(var(--muted))" }} />
            <YAxis yAxisId="l" tickLine={false} axisLine={false} allowDecimals={false} tick={{ fontSize: 11, fill: "rgb(var(--muted))" }} />
            <YAxis yAxisId="r" orientation="right" tickLine={false} axisLine={false} allowDecimals={false} tick={{ fontSize: 10, fill: "rgb(var(--faint))" }} width={34} />
            <Tooltip content={<ChartTip />} cursor={{ stroke: "rgb(var(--line-strong))", strokeDasharray: "3 3" }} />
            <ReferenceLine yAxisId="l" y={avg} stroke="rgb(var(--warning))" strokeDasharray="4 4" strokeOpacity={0.8} label={{ value: `avg ${avg.toFixed(1)}`, position: "insideTopLeft", fontSize: 10, fill: "rgb(var(--warning))" }} />
            <Area yAxisId="l" type="monotone" dataKey="chain" stackId="v" name="chain-confirmed" stroke="rgb(var(--primary))" strokeWidth={2} fill="url(#dg-chain)" animationDuration={900} />
            <Area yAxisId="l" type="monotone" dataKey="offchain" stackId="v" name="off-chain" stroke="rgb(var(--info))" strokeWidth={2} fill="url(#dg-off)" animationDuration={900} />
            <Line yAxisId="r" type="monotone" dataKey="cumulative" name="cumulative" stroke="rgb(var(--fg) / 0.55)" strokeWidth={1.5} strokeDasharray="5 4" dot={false} animationDuration={1100} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex flex-wrap gap-4 text-2xs text-muted">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-primary/70" />chain-confirmed (transaction receipt)</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-info/60" />off-chain record (hash-chained only)</span>
        <span className="flex items-center gap-1.5"><span className="h-[2px] w-4 border-t-2 border-dashed border-fg/50" />cumulative ledger size (right axis)</span>
      </div>
    </div>
  );
}

function CoverageMatrix({ rows }: { rows: ReturnType<typeof coverage> }) {
  const [hover, setHover] = useState<string | null>(null);
  const evidenced = rows.flatMap((r) => Object.values(r.cells)).filter((c) => c === "done").length;
  const applicable = rows.flatMap((r) => Object.values(r.cells)).filter((c) => c !== "na").length;
  return (
    <Panel title="Control coverage" subtitle={`${evidenced} of ${applicable} applicable controls evidenced in the ledger`} icon={<BadgeCheck className="h-4 w-4 text-primary" />}>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-y-1.5 text-xs">
          <thead>
            <tr>
              <th className="pb-1 pr-3 text-left text-2xs font-semibold text-muted">Proposal</th>
              {CONTROLS.map((c) => (
                <th key={c.id} title={c.hint} className={cx("px-1 pb-1 text-center text-2xs font-semibold transition-colors", hover === c.id ? "text-fg" : "text-muted")}>{c.label}</th>
              ))}
              <th className="pb-1 pl-3 text-right text-2xs font-semibold text-muted">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <motion.tr key={r.proposal} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: ri * 0.06, ease: EASE }}>
                <td className="rounded-l-lg border-y border-l border-line bg-subtle/40 py-2 pl-3 pr-3 font-mono text-[11.5px] font-semibold">{r.proposal}</td>
                {CONTROLS.map((c) => {
                  const s = r.cells[c.id];
                  const cfg = CELL[s];
                  return (
                    <td key={c.id} className="border-y border-line bg-subtle/40 px-1 py-2 text-center" onMouseEnter={() => setHover(c.id)} onMouseLeave={() => setHover(null)} title={`${c.label}: ${cfg.label} — ${c.hint}`}>
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: toneColor(cfg.tone, s === "na" ? 0.08 : 0.14), color: toneColor(cfg.tone) }}>
                        <cfg.icon className="h-4 w-4" aria-label={cfg.label} />
                      </span>
                    </td>
                  );
                })}
                <td className="rounded-r-lg border-y border-r border-line bg-subtle/40 py-2 pl-3 pr-3">
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-line"><GrowBar pct={r.score * 100} className={cx("h-full rounded-full", r.score >= 0.75 ? "bg-primary" : r.score >= 0.45 ? "bg-warning" : "bg-danger")} /></div>
                    <span className="w-9 text-right font-mono text-[11px] font-semibold">{Math.round(r.score * 100)}%</span>
                  </div>
                </td>
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap gap-4 text-2xs text-muted">
        {(Object.keys(CELL) as ControlState[]).map((k) => {
          const cfg = CELL[k];
          return <span key={k} className="flex items-center gap-1.5"><cfg.icon className="h-3.5 w-3.5" style={{ color: toneColor(cfg.tone) }} />{cfg.label}</span>;
        })}
        <span className="text-faint">Read from the audit ledger; hover a column for what it checks.</span>
      </div>
    </Panel>
  );
}

function ReportBuilder({ sections }: { sections: Record<string, string> }) {
  const [pid, setPid] = useSelectedProposal("GOV-042");
  const [format, setFormat] = useState<"pdf" | "json" | "csv">("pdf");
  const keys = Object.keys(sections);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  useEffect(() => setChosen(new Set(Object.keys(sections))), [sections]);
  const gen = useAction(() => api.post<any>("/reports", { proposal_id: pid, format, sections: keys.filter((k) => chosen.has(k)) }), {
    success: (r: any) => `${r.file_name} generated`,
    onSuccess: (r: any) => window.location.assign(`/api/reports/${r.id}/download`),
    invalidate: [["reports"], ["audit"]],
  });
  const toggle = (k: string) => setChosen((prev) => {
    const n = new Set(prev);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    return n;
  });
  const F = FORMAT[format];
  return (
    <Panel title="Report builder" subtitle="Pick the proposal, the format and what to include" icon={<FileCheck2 className="h-4 w-4 text-primary" />} bodyClassName="pb-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_230px]">
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div>
              <p className="mb-1 text-xs font-medium">Proposal</p>
              <ProposalPicker value={pid} onChange={setPid} />
            </div>
            <div>
              <p className="mb-1 text-xs font-medium">Format</p>
              <Segmented value={format} onChange={setFormat} options={(["pdf", "json", "csv"] as const).map((f) => ({ id: f, label: FORMAT[f].label }))} />
            </div>
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-xs font-medium">Sections · {chosen.size}/{keys.length}</p>
              <button className="cursor-pointer text-2xs font-medium text-primary hover:underline" onClick={() => setChosen(chosen.size === keys.length ? new Set() : new Set(keys))}>{chosen.size === keys.length ? "Clear all" : "Select all"}</button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {keys.map((k) => {
                const on = chosen.has(k);
                return (
                  <button key={k} onClick={() => toggle(k)} aria-pressed={on} className={cx("inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors duration-200", on ? "border-primary/50 bg-primary/10 text-fg" : "border-line text-muted hover:text-fg")}>
                    {on ? <CheckCircle2 className="h-3 w-3 text-primary" /> : <Plus className="h-3 w-3" />}
                    {sections[k]}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" icon={<Download className="h-4 w-4" />} disabled={!pid || chosen.size === 0} loading={gen.isPending} onClick={() => gen.mutate(undefined)}>Generate & download</Button>
            <p className="text-2xs text-muted">The report's SHA-256 is recorded in the audit ledger, so a copy can later be checked against what was generated.</p>
          </div>
        </div>
        <div className="relative mx-auto w-full max-w-[230px]" aria-hidden>
          <div className="absolute inset-0 translate-x-2 translate-y-2 rounded-lg border border-line bg-subtle" />
          <motion.div key={format} initial={{ rotate: -2, opacity: 0.6 }} animate={{ rotate: 0, opacity: 1 }} transition={{ duration: 0.3, ease: EASE }} className="relative rounded-lg border border-line bg-surface p-3 shadow-card">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[10px] font-bold" style={{ color: F.color }}><F.icon className="h-3.5 w-3.5" />{F.label}</span>
              <span className="font-mono text-[9px] text-faint">{pid ?? "GOV-…"}</span>
            </div>
            <div className="mt-2 h-2 w-3/4 rounded bg-fg/80" />
            <div className="mt-1 h-1.5 w-1/2 rounded bg-line-strong" />
            <ul className="mt-2.5 space-y-[3px]">
              {keys.map((k) => (
                <li key={k} className={cx("flex items-center gap-1.5 leading-tight transition-opacity", !chosen.has(k) && "opacity-25")}>
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                  <span className="truncate text-[9.5px] text-muted">{sections[k]}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-center gap-1 border-t border-line pt-2 font-mono text-[8.5px] text-faint"><Fingerprint className="h-2.5 w-2.5" />sha256 recorded on generation</div>
          </motion.div>
        </div>
      </div>
    </Panel>
  );
}
