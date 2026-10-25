import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle, Calculator, CheckCircle2, Clock, Play, Plus, Trash2, XCircle } from "lucide-react";
import { api } from "../lib/api";
import { useSelectedProposal } from "../lib/app";
import { compactUsdc, cx, dateTime, formatUnits, shortAddr, usdc } from "../lib/format";
import { useAction, useDependencies, useFindings, useManifest, useTreasury, useTreasuryOverview } from "../lib/queries";
import { ProposalPicker } from "../components/common";
import { Badge, Button, Callout, DemoBadge, ErrorState, LoadingBlock, Panel, Segmented, SeverityBadge, Tabs } from "../components/ui";
import { toBase } from "./proposal/Forms";
import { TreasuryExplorer } from "../components/TreasuryExplorer";

type Tab = "impact" | "inputs";

export default function Financial() {
  const [pid, setPid] = useSelectedProposal("GOV-042");
  const [tab, setTab] = useState<Tab>("impact");
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Financial impact assessment</h1>
          <p className="mt-0.5 text-sm text-muted">Integer base-unit arithmetic on the live treasury balance. Inputs and formulas are shown; nothing is invented.</p>
        </div>
        <div className="flex items-center gap-2">
          <DemoBadge />
          <ProposalPicker value={pid} onChange={setPid} />
        </div>
      </div>
      <Tabs<Tab> className="mb-4" value={tab} onChange={setTab} tabs={[{ id: "impact", label: "Treasury impact" }, { id: "inputs", label: "Treasury inputs" }]} />
      {tab === "impact" ? pid && <Impact pid={pid} /> : <Inputs />}
    </div>
  );
}

function Impact({ pid }: { pid: string }) {
  const [amount, setAmount] = useState<string | undefined>();
  const [overrun, setOverrun] = useState(0);
  const [release, setRelease] = useState<"lump" | "milestones">("lump");
  const [horizon, setHorizon] = useState(18);
  const [view, setView] = useState<"2d" | "3d">("2d");
  const [noWebgl, setNoWebgl] = useState<string | null>(null);
  const [debounced, setDebounced] = useState({ amount, overrun });
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced({ amount, overrun }), 180);
    return () => window.clearTimeout(t);
  }, [amount, overrun]);
  useEffect(() => {
    setAmount(undefined);
    setOverrun(0);
  }, [pid]);
  const q = useTreasury(pid, { amount: debounced.amount, overrun_pct: debounced.overrun, release, horizon });
  const deps = useDependencies(pid);
  const manifest = useManifest(pid);
  const findings = useFindings(pid);
  const d = q.data;
  const requested = d ? BigInt(d.requested_base) : 0n;
  const sliderMax = d ? Number((BigInt(d.balance_base) / 1_000_000n) / 2n) : 1_000_000;
  const amountUnits = d ? Number(BigInt(amount ?? d.requested_base) / 1_000_000n) : 0;
  const chart = useMemo(
    () => (d?.series ?? []).map((s: any) => ({ month: s.month, before: Number(BigInt(s.before_base) / 1_000_000n), after: Number(BigInt(s.after_base) / 1_000_000n) })),
    [d],
  );
  const runwayDrop = d?.runway_change_pct ? Number(d.runway_change_pct) : 0;

  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!d) return <LoadingBlock rows={10} />;
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className={cx("grid gap-4", view === "2d" && "lg:grid-cols-[minmax(0,1fr)_300px]")}>
          <Panel
            title={view === "3d" ? "Treasury balance projection" : "Treasury impact projection"}
            subtitle={view === "3d" ? `Available mUSDC after commitments across time and cost-overrun scenarios, ${horizon} months.` : `Available mUSDC after commitments, ${horizon} months. Before vs after this proposal.`}
            actions={
              <Segmented
                size="sm"
                value={view}
                onChange={(v) => {
                  setView(v);
                  if (v === "3d") setNoWebgl(null);
                }}
                options={[{ id: "2d", label: "2D" }, { id: "3d", label: "3D" }]}
              />
            }
          >
            {noWebgl && view === "2d" && <div className="mb-3"><Callout tone="warning" title="3D view unavailable">{noWebgl} Showing the 2D chart instead.</Callout></div>}
            {view === "3d" ? (
              <TreasuryExplorer
                pid={pid}
                amount={debounced.amount}
                overrun={debounced.overrun}
                release={release}
                horizon={horizon}
                requestedBase={d.requested_base}
                runwayBefore={d.runway_before_months}
                runwayAfter={d.runway_after_months}
                onUnavailable={(reason) => {
                  setNoWebgl(reason);
                  setView("2d");
                }}
              />
            ) : (
            <div className="h-[290px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chart} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gBefore" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="rgb(var(--faint))" stopOpacity={0.35} /><stop offset="100%" stopColor="rgb(var(--faint))" stopOpacity={0.02} /></linearGradient>
                    <linearGradient id="gAfter" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="rgb(var(--primary))" stopOpacity={0.35} /><stop offset="100%" stopColor="rgb(var(--primary))" stopOpacity={0.03} /></linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} tickFormatter={(m) => `M${m}`} />
                  <YAxis tickLine={false} axisLine={false} width={52} tickFormatter={(v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1000)}k`)} />
                  <Tooltip formatter={(v: number, n: string) => [`${v.toLocaleString("en-US")} mUSDC`, n === "before" ? "Without proposal" : "With proposal"]} labelFormatter={(m) => `Month ${m}`} />
                  <ReferenceLine y={0} stroke="rgb(var(--danger))" strokeDasharray="4 4" />
                  {d.schedule.map((s: any, i: number) => (
                    <ReferenceLine key={i} x={s.month} stroke="rgb(var(--fg))" strokeDasharray="2 3" label={{ value: `${compactUsdc(s.amount_base)} payout`, position: "insideTopRight", fontSize: 10, fill: "rgb(var(--muted))" }} />
                  ))}
                  <Area type="monotone" dataKey="before" stroke="rgb(var(--faint))" fill="url(#gBefore)" strokeWidth={2} isAnimationActive={false} />
                  <Area type="monotone" dataKey="after" stroke="rgb(var(--primary))" fill="url(#gAfter)" strokeWidth={2} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            )}
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div>
                <div className="mb-1 flex justify-between text-xs"><span className="font-medium">Grant amount</span><span className="font-mono">{amountUnits.toLocaleString("en-US")} mUSDC</span></div>
                <input type="range" className="w-full accent-[rgb(var(--primary))]" min={0} max={Math.max(sliderMax, Number(requested / 1_000_000n) * 2)} step={5000} value={amountUnits} onChange={(e) => setAmount(String(BigInt(e.target.value) * 1_000_000n))} aria-label="Grant amount" />
                <button className="text-2xs text-primary hover:underline" onClick={() => setAmount(undefined)}>Reset to requested ({usdc(d.requested_base)})</button>
              </div>
              <div>
                <div className="mb-1 flex justify-between text-xs"><span className="font-medium">Cost overrun</span><span className="font-mono">{overrun}%</span></div>
                <input type="range" className="w-full accent-[rgb(var(--primary))]" min={0} max={60} step={5} value={overrun} onChange={(e) => setOverrun(Number(e.target.value))} aria-label="Cost overrun" />
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="font-medium">Release</span>
                <Segmented size="sm" value={release} onChange={setRelease} options={[{ id: "lump", label: "Lump sum" }, { id: "milestones", label: "Milestone tranches" }]} />
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="font-medium">Horizon</span>
                <Segmented size="sm" value={String(horizon) as "12" | "18" | "24"} onChange={(v) => setHorizon(Number(v))} options={[{ id: "12", label: "12m" }, { id: "18", label: "18m" }, { id: "24", label: "24m" }]} />
              </div>
            </div>
          </Panel>

          <Panel title="Impact summary" subtitle={`Block #${d.block_number} · ${dateTime(d.as_of)}`}>
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between"><span className="text-muted">Treasury balance</span><span className="font-semibold">{usdc(d.balance_base)}</span></div>
              <div className="flex justify-between"><span className="text-muted">This proposal</span><span className="font-semibold">{usdc(d.active_amount_base)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Share of treasury</span><span className="font-semibold">{d.share_of_treasury_pct}%</span></div>
              <div className="flex justify-between"><span className="text-muted">Pending approvals</span><span>{usdc(d.pending_total_base)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Other commitments</span><span>{usdc(d.other_commitments_base)}</span></div>
              <div className="flex justify-between border-t border-line pt-2"><span className="text-muted">Liquidity buffer after</span><span className={cx("font-semibold", BigInt(d.available_after_base) < 0n && "text-danger")}>{usdc(d.available_after_base)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Annual net burn</span><span>{usdc((BigInt(d.net_monthly_burn_base) * 12n).toString())}</span></div>
              <div className="flex justify-between"><span className="text-muted">Runway</span><span className="font-semibold">{d.runway_before_months ?? "—"} → {d.runway_after_months ?? "—"} months</span></div>
              {d.runway_change_pct && (
                <div className={cx("flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-semibold", runwayDrop <= -15 ? "bg-warning/12 text-warning" : "bg-subtle text-muted")}>
                  {runwayDrop <= -15 && <AlertTriangle className="h-3.5 w-3.5" />}
                  {d.runway_change_pct}% runway {runwayDrop < 0 ? "drop" : "change"}
                </div>
              )}
              {d.runway_note && <p className="text-2xs text-muted">{d.runway_note}</p>}
              <p className="text-2xs text-muted">{d.data_label}</p>
            </div>
          </Panel>
        </div>

        <Panel title="Scenarios" icon={<Calculator className="h-4 w-4 text-muted" />} bodyClassName="px-0">
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Scenario</th><th>Amount</th><th>Share</th><th>Remaining balance</th><th>Available after commitments</th><th>Runway</th></tr></thead>
              <tbody>
                {d.scenarios.map((s: any) => (
                  <tr key={s.label}>
                    <td className="font-medium">{s.label}</td>
                    <td>{usdc(s.amount_base)}</td>
                    <td>{s.share_of_treasury_pct}%</td>
                    <td>{usdc(s.remaining_balance_base)}</td>
                    <td className={cx(!s.covered && "font-semibold text-danger")}>{usdc(s.available_after_commitments_base)}</td>
                    <td>{s.runway_months ? `${s.runway_months} mo` : "insufficient data"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Dependency checklist" subtitle="Live on-chain prerequisites for executing this proposal's manifest." bodyClassName="px-0">
          {deps.isLoading && <div className="px-4"><LoadingBlock rows={4} /></div>}
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Check</th><th>Contract</th><th>Category</th><th>Status</th><th>Detail</th><th /></tr></thead>
              <tbody>
                {(deps.data ?? []).map((c) => <DepRow key={c.id} pid={pid} c={c} />)}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Formulas & assumptions">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="overflow-x-auto rounded-lg border border-line"><table className="table-base">
              <thead><tr><th>Measure</th><th>Formula</th><th className="text-right">Value</th></tr></thead>
              <tbody>
                {d.formulas.map((f: any) => (
                  <tr key={f.name}><td className="text-xs font-medium">{f.name}</td><td className="font-mono text-2xs text-muted">{f.formula}</td><td className="whitespace-nowrap text-right text-xs">{f.value}</td></tr>
                ))}
              </tbody>
            </table></div>
            <ul className="space-y-1.5 text-xs text-muted">
              {d.assumptions.map((a: string) => <li key={a} className="flex gap-2"><span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-faint" />{a}</li>)}
              <li className="flex gap-2"><span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-faint" />Fee inflow source: {d.monthly_inflow.source} ({d.monthly_inflow.events} events = {usdc(d.monthly_inflow.monthly_base)}).</li>
            </ul>
          </div>
        </Panel>
      </div>

      <div className="flex flex-col gap-4 xl:sticky xl:top-[72px] xl:self-start">
        <Panel title="On-chain audit details" subtitle="What will execute, read from the committed manifest.">
          {manifest.data?.manifest ? (
            <div className="space-y-2">
              <p className="label">Code dependencies</p>
              <pre className="max-h-[260px] overflow-auto rounded-lg bg-ink p-3 font-mono text-[11px] leading-relaxed text-[#C9D6E2] scroll-thin">
                {JSON.stringify(manifest.data.manifest.actions.map((a: any) => ({ call: a.function, target: a.target, args: Object.fromEntries((a.args ?? []).map((x: any) => [x.name, x.value])) })), null, 2)}
              </pre>
              <p className="text-2xs text-muted">Manifest v{manifest.data.version} · digest {manifest.data.manifest.manifest_hash.slice(0, 14)}…</p>
            </div>
          ) : (
            <p className="text-xs text-muted">No committed manifest yet.</p>
          )}
        </Panel>
        <Panel title="Financial risks">
          <ul className="space-y-2">
            {(findings.data ?? []).filter((f) => ["MI-R001", "MI-R010", "MI-R012", "MI-R002"].includes(f.rule_id)).map((f) => (
              <li key={f.id} className="rounded-lg border border-line p-2.5">
                <SeverityBadge severity={f.severity} />
                <p className="mt-1 text-xs font-semibold">{f.title}</p>
                <p className="mt-0.5 line-clamp-3 text-2xs text-muted">{f.explanation}</p>
              </li>
            ))}
            {(findings.data ?? []).filter((f) => ["MI-R001", "MI-R010", "MI-R012", "MI-R002"].includes(f.rule_id)).length === 0 && <p className="text-xs text-muted">No financial information gaps flagged.</p>}
          </ul>
        </Panel>
        {d.pending_approvals.length > 0 && (
          <Panel title="Pending approvals (committed)">
            {d.pending_approvals.map((x: any) => (
              <div key={x.proposal_id} className="flex justify-between text-xs"><span>{x.proposal_id} v{x.version}</span><span className="font-semibold">{usdc(x.amount_base)}</span></div>
            ))}
          </Panel>
        )}
      </div>
    </div>
  );
}

function DepRow({ pid, c }: { pid: string; c: any }) {
  const [row, setRow] = useState(c);
  useEffect(() => {
    setRow(c);
  }, [c]);
  const run = useAction(() => api.post<any>(`/proposals/${pid}/dependencies/${c.id}/run`), { quiet: true, onSuccess: setRow, invalidate: [] });
  const icon = row.status === "pass" ? <CheckCircle2 className="h-3.5 w-3.5" /> : row.status === "fail" ? <XCircle className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />;
  return (
    <tr>
      <td className="text-xs font-medium">{row.label}</td>
      <td className="font-mono text-2xs text-muted">{row.contract ? shortAddr(row.contract) : "—"}</td>
      <td className="text-xs">{row.category}</td>
      <td><Badge tone={row.status === "pass" ? "success" : row.status === "fail" ? "danger" : row.status === "info" ? "info" : "warning"} icon={icon}>{row.status.toUpperCase()}</Badge></td>
      <td className="max-w-[320px] text-2xs text-muted">{row.detail}<span className="block text-faint">block #{row.block}</span></td>
      <td><Button size="sm" icon={<Play className="h-3 w-3" />} loading={run.isPending} onClick={() => run.mutate(undefined)}>Execute check</Button></td>
    </tr>
  );
}

function Inputs() {
  const ov = useTreasuryOverview();
  const [burn, setBurn] = useState<Array<{ label: string; amount: string }>>([]);
  const [commit, setCommit] = useState<Array<{ label: string; amount: string }>>([]);
  useEffect(() => {
    if (!ov.data) return;
    setBurn(ov.data.inputs.burn_items.map((b: any) => ({ label: b.label, amount: formatUnits(b.monthly_base, 6, 6).replace(/,/g, "") })));
    setCommit(ov.data.inputs.other_commitments.map((b: any) => ({ label: b.label, amount: formatUnits(b.amount_base, 6, 6).replace(/,/g, "") })));
  }, [ov.data]);
  const save = useAction(
    () => api.put("/treasury/inputs", {
      burn_items: burn.map((b) => ({ label: b.label, monthly_base: toBase(b.amount) ?? "0" })),
      other_commitments: commit.map((b) => ({ label: b.label, amount_base: toBase(b.amount) ?? "0" })),
      source: "Edited by a reviewer in the Financial impact page",
    }),
    { success: "Treasury inputs saved", invalidate: [["treasury"], ["treasury-overview"]] },
  );
  const valid = [...burn, ...commit].every((x) => x.label.trim() && toBase(x.amount) !== null);
  if (!ov.data) return <LoadingBlock rows={6} />;
  const Editor = ({ rows, setRows, unit }: { rows: Array<{ label: string; amount: string }>; setRows: (r: Array<{ label: string; amount: string }>) => void; unit: string }) => (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_160px_32px] gap-1.5">
          <input className="input" value={r.label} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} aria-label="Label" />
          <input className="input" value={r.amount} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} aria-label={unit} />
          <Button size="sm" variant="ghost" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      ))}
      <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setRows([...rows, { label: "", amount: "0" }])}>Add</Button>
    </div>
  );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Monthly burn (manual inputs)" subtitle="mUSDC per month">
        {Editor({ rows: burn, setRows: setBurn, unit: "mUSDC per month" })}
      </Panel>
      <Panel title="Other commitments (manual inputs)" subtitle="One-off mUSDC obligations not yet on-chain">
        {Editor({ rows: commit, setRows: setCommit, unit: "mUSDC" })}
      </Panel>
      <div className="lg:col-span-2">
        <Callout tone="info">
          Chain-derived values are not editable: the treasury balance ({usdc(ov.data.balance_base)} at block #{ov.data.as_of_block}), approved-but-unexecuted payouts ({usdc(ov.data.pending_total_base)}) and fee inflows ({usdc(ov.data.monthly_inflow.monthly_base)} over 30 days).
        </Callout>
        <div className="mt-3 flex items-center justify-end gap-3">
          <span className="text-2xs text-muted">{ov.data.inputs.source}</span>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save inputs</Button>
        </div>
      </div>
    </div>
  );
}
