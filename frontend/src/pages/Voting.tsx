import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle, CheckCircle2, Info, Search, ShieldAlert, UserRound } from "lucide-react";
import { useSelectedProposal } from "../lib/app";
import { cx, dateTime, formatUnits, govStateLabel, timeAgo } from "../lib/format";
import { useDelegates, useVoting } from "../lib/queries";
import { ProposalPicker } from "../components/common";
import { Donut, VOTE_COLORS } from "../components/charts";
import { AddressChip, Badge, DemoBadge, EmptyState, ErrorState, LoadingBlock, Panel, ProgressBar, Segmented, Tabs, TxLink } from "../components/ui";

type Tab = "participation" | "delegates";

export default function Voting() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "participation";
  const setTab = (t: Tab) => {
    const n = new URLSearchParams(params);
    n.set("tab", t);
    setParams(n, { replace: true });
  };
  const [pid, setPid] = useSelectedProposal("GOV-042");
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Voting & participation</h1>
          <p className="mt-0.5 text-sm text-muted">Token-weighted Governor votes on the local chain. Concentration is a governance indicator, not proof of manipulation.</p>
        </div>
        <div className="flex items-center gap-2">
          <DemoBadge />
          {tab === "participation" && <ProposalPicker value={pid} onChange={setPid} />}
        </div>
      </div>
      <Tabs<Tab> className="mb-4" value={tab} onChange={setTab} tabs={[{ id: "participation", label: "Participation" }, { id: "delegates", label: "Delegates & voters" }]} />
      {tab === "participation" ? <Participation pid={pid} /> : <Delegates />}
    </div>
  );
}

function Participation({ pid }: { pid?: string }) {
  const v = useVoting(pid);
  const [mode, setMode] = useState<"weight" | "count">("weight");
  const sel = v.data?.selected;
  const donut = useMemo(() => {
    if (!sel) return [];
    const src = mode === "weight" ? sel.distribution.by_weight : sel.distribution.by_count;
    const num = (x: string | number) => (mode === "weight" ? Number(BigInt(x) / 10n ** 18n) : Number(x));
    return [
      { name: "For", value: num(src.for), color: VOTE_COLORS.for },
      { name: "Against", value: num(src.against), color: VOTE_COLORS.against },
      { name: "Abstain", value: num(src.abstain), color: VOTE_COLORS.abstain },
    ];
  }, [sel, mode]);
  const trend = useMemo(
    () => (sel?.timeline ?? []).map((t: any) => ({ block: t.block_number, label: t.voter_label ?? t.voter.slice(0, 6), weight: Number(BigInt(t.weight) / 10n ** 18n), for: Number(BigInt(t.cum_for) / 10n ** 18n), against: Number(BigInt(t.cum_against) / 10n ** 18n), abstain: Number(BigInt(t.cum_abstain) / 10n ** 18n) })),
    [sel],
  );
  if (v.error) return <ErrorState error={v.error} retry={() => v.refetch()} />;
  if (!v.data) return <LoadingBlock rows={10} />;
  const c = v.data.concentration;
  const defs = v.data.metric_definitions;
  if (!sel) return <EmptyState icon={<Info className="h-5 w-5" />} title="No on-chain vote for this proposal yet" body="Open a vote from the proposal's decision panel." />;
  const total = donut.reduce((a, b) => a + b.value, 0);
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel title="Participation" actions={<Segmented size="sm" value={mode} onChange={setMode} options={[{ id: "weight", label: "Weight" }, { id: "count", label: "Voters" }]} />}>
            <Donut data={donut} center={mode === "weight" ? `${sel.summary.participation_pct}%` : `${sel.unique_voters}`} sub={mode === "weight" ? "turnout" : `of ${sel.eligible_voters} eligible`} height={190} />
            <div className="mt-2 flex justify-center gap-4 text-2xs">
              {donut.map((d) => (
                <span key={d.name} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: d.color }} />{d.name} {total ? `${((d.value / total) * 100).toFixed(0)}%` : "0%"}</span>
              ))}
            </div>
            <p className="mt-2 text-center text-2xs text-muted">{mode === "weight" ? defs.participation : defs.unique_voters}</p>
          </Panel>
          <Panel title="Voting-power concentration" subtitle="Across all delegates, current block">
            <div className="space-y-2 text-sm">
              {[
                ["Largest delegate", `${c.top1_pct}%`, defs.top_share],
                ["Top three delegates", `${c.top3_pct}%`, defs.top_share],
                ["HHI", `${c.hhi.toLocaleString()} · ${c.hhi_band}`, defs.hhi],
                ["Nakamoto coefficient", c.nakamoto, defs.nakamoto],
                ["Gini", c.gini, defs.gini],
              ].map(([k, val, d]) => (
                <div key={k as string} className="flex items-center justify-between gap-2" title={d as string}>
                  <span className="flex items-center gap-1 text-muted">{k}<Info className="h-3 w-3 text-faint" /></span>
                  <span className="font-semibold">{val}</span>
                </div>
              ))}
              <div className="pt-1"><ProgressBar value={Number(c.top3_pct)} tone={Number(c.top3_pct) > 50 ? "warning" : "primary"} /></div>
              <p className="text-2xs text-muted">{defs.token_weighted}</p>
            </div>
          </Panel>
          <Panel title="Outcome" subtitle={`${sel.proposal_id} v${sel.version} · snapshot #${sel.summary.snapshot_block}`}>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted">State</span><Badge tone={sel.summary.state === "Defeated" ? "danger" : sel.summary.state === "Active" ? "warning" : "success"}>{govStateLabel(sel.summary.state)}</Badge></div>
              <div className="flex justify-between"><span className="text-muted">For</span><span className="font-semibold text-primary">{formatUnits(sel.summary.for, 18, 0)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Against</span><span className="font-semibold text-danger">{formatUnits(sel.summary.against, 18, 0)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Abstain</span><span className="font-semibold">{formatUnits(sel.summary.abstain, 18, 0)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Unique voters</span><span className="font-semibold">{sel.unique_voters}</span></div>
              <p className="pt-1 text-2xs text-muted">{defs.quorum}</p>
            </div>
          </Panel>
        </div>

        <Panel title="Voting trends" subtitle="Cumulative ATLAS by option (lines) and each vote's weight (bars), by block">
          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="block" tickLine={false} axisLine={false} tickFormatter={(b) => `#${b}`} />
                <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(x) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : `${Math.round(x / 1000)}k`)} />
                <Tooltip formatter={(val: number, n: string) => [`${val.toLocaleString("en-US")} ATLAS`, n]} labelFormatter={(b, payload) => `Block #${b} · ${payload?.[0]?.payload?.label ?? ""}`} />
                <Bar dataKey="weight" name="vote weight" fill="rgb(var(--line-strong))" radius={[3, 3, 0, 0]} barSize={14} isAnimationActive={false} />
                <Line type="stepAfter" dataKey="for" name="for (cumulative)" stroke={VOTE_COLORS.for} strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="stepAfter" dataKey="against" name="against (cumulative)" stroke={VOTE_COLORS.against} strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="stepAfter" dataKey="abstain" name="abstain (cumulative)" stroke={VOTE_COLORS.abstain} strokeWidth={2} dot={false} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Top voters" bodyClassName="px-0">
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>#</th><th>Voter</th><th>Support</th><th className="text-right">Votes cast</th><th className="text-right">Power %</th><th>Relationship tags</th><th>Transaction</th></tr></thead>
              <tbody>
                {sel.top_voters.map((t: any, i: number) => (
                  <tr key={t.tx_hash}>
                    <td className="text-xs text-muted">{i + 1}</td>
                    <td><AddressChip address={t.voter} label={t.voter_label} />{t.reason && <p className="mt-0.5 max-w-[260px] text-2xs italic text-muted">“{t.reason}”</p>}</td>
                    <td><Badge tone={t.support === "for" ? "success" : t.support === "against" ? "danger" : "neutral"}>{t.support.toUpperCase()}</Badge></td>
                    <td className="text-right text-xs font-semibold">{formatUnits(t.weight, 18, 0)}</td>
                    <td className="text-right text-xs">{t.power_pct}%</td>
                    <td><div className="flex flex-wrap gap-1">{t.tags.map((g: string) => <Badge key={g} tone={g.includes("recipient") ? "warning" : "neutral"}>{g}</Badge>)}</div></td>
                    <td><TxLink hash={t.tx_hash} block={t.block_number} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <div className="flex flex-col gap-4">
        <Panel title="Voter risk analysis" subtitle="Heuristic signals for review. Neutral language: patterns are not findings of fact.">
          <ul className="space-y-2">
            {sel.risk_signals.map((r: any, i: number) => (
              <li key={i} className={cx("rounded-lg border p-2.5", r.level === "review" ? "border-warning/30 bg-warning/5" : r.level === "heuristic" ? "border-line" : "border-primary/25 bg-primary/5")}>
                <p className="flex items-center gap-1.5 text-xs font-semibold">
                  {r.level === "review" ? <AlertTriangle className="h-3.5 w-3.5 text-warning" /> : r.level === "heuristic" ? <ShieldAlert className="h-3.5 w-3.5 text-muted" /> : <CheckCircle2 className="h-3.5 w-3.5 text-primary" />}
                  {r.title}
                </p>
                <p className="mt-1 text-2xs text-muted">{r.detail}</p>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="All governor votes">
          <ul className="space-y-2">
            {v.data.proposals.map((p: any) => (
              <li key={`${p.proposal_id}-${p.version}`} className="rounded-lg border border-line p-2.5 text-xs">
                <div className="flex items-center justify-between"><span className="font-semibold">{p.proposal_id} v{p.version}</span><Badge tone={p.state === "Defeated" ? "danger" : p.state === "Active" ? "warning" : "success"}>{govStateLabel(p.state)}</Badge></div>
                <p className="mt-0.5 truncate text-muted">{p.title}</p>
                <p className="mt-1 text-2xs text-muted">turnout {p.participation_pct}% · for {formatUnits(p.for, 18, 0)} · against {formatUnits(p.against, 18, 0)}</p>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-2xs text-muted">{v.data.data_label}</p>
        </Panel>
      </div>
    </div>
  );
}

function Delegates() {
  const d = useDelegates();
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<"all" | "review">("all");
  if (d.error) return <ErrorState error={d.error} retry={() => d.refetch()} />;
  if (!d.data) return <LoadingBlock rows={10} />;
  const cards = d.data.delegates.filter((c: any) => (!q || `${c.label} ${c.address}`.toLowerCase().includes(q.toLowerCase())) && (only === "all" || c.coi_check.status === "review"));
  const conc = d.data.concentration;
  const top3 = Number(conc.top3_pct);
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
            <input className="input w-[240px] pl-8" placeholder="Search delegates" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search delegates" />
          </div>
          <Segmented size="sm" value={only} onChange={setOnly} options={[{ id: "all", label: "All" }, { id: "review", label: "Conflict check: review" }]} />
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {cards.map((c: any) => (
            <div key={c.address} className="panel p-3.5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-node text-white"><UserRound className="h-4 w-4" /></span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{c.label}</p>
                    <AddressChip address={c.address} compact />
                  </div>
                </div>
                <Badge tone={c.is_delegate ? "info" : "neutral"}>{c.is_delegate ? "Delegate" : "Voter"}</Badge>
              </div>
              <div className="mt-3 flex items-end justify-between">
                <div><p className="text-2xs text-muted">Voting power</p><p className="text-lg font-semibold">{c.voting_power_display}</p></div>
                <p className="text-xs font-semibold text-muted">{c.power_pct}%</p>
              </div>
              <div className="mt-2"><ProgressBar value={Number(c.power_pct) * 3} /></div>
              <div className="mt-3 grid grid-cols-3 gap-1.5 text-center text-2xs">
                <div className="rounded bg-primary/10 py-1 text-primary"><b>{c.for_count}</b> for</div>
                <div className="rounded bg-danger/10 py-1 text-danger"><b>{c.against_count}</b> against</div>
                <div className="rounded bg-subtle py-1 text-muted"><b>{c.abstain_count}</b> abstain</div>
              </div>
              <div className="mt-2.5 flex items-center justify-between text-2xs text-muted">
                <span>Participation {c.participation_pct}% ({c.votes_cast}/{c.proposals_available})</span>
                <span>{c.last_vote ? `voted ${timeAgo(c.last_vote)}` : "no votes"}</span>
              </div>
              <div className={cx("mt-2.5 flex items-start gap-1.5 rounded-lg px-2 py-1.5 text-2xs", c.coi_check.status === "review" ? "bg-warning/10 text-warning" : "bg-primary/5 text-primary")}>
                {c.coi_check.status === "review" ? <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />}
                <span>Conflict-of-interest check: {c.coi_check.detail}</span>
              </div>
              {c.delegators.length > 0 && <p className="mt-2 text-2xs text-muted">Delegated by: {c.delegators.map((x: any) => x.label ?? x.address.slice(0, 8)).join(", ")}</p>}
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <Panel title="Global voting-power distribution">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><p className="text-2xs text-muted">Total delegated power</p><p className="font-semibold">{formatUnits(d.data.totals.total_power, 18, 0)}</p></div>
            <div><p className="text-2xs text-muted">Active voters</p><p className="font-semibold">{d.data.totals.active_voters}</p></div>
            <div><p className="text-2xs text-muted">Delegates</p><p className="font-semibold">{d.data.totals.delegates}</p></div>
            <div><p className="text-2xs text-muted">Governor votes</p><p className="font-semibold">{d.data.governor_proposals}</p></div>
          </div>
          <p className="mb-1 mt-4 text-xs font-medium">Delegate concentration vs everyone else</p>
          <Donut half height={150} center={`${conc.top3_pct}%`} sub="held by top 3" data={[{ name: "Top 3 delegates", value: top3, color: "rgb(var(--ink))" }, { name: "Everyone else", value: Math.max(0, 100 - top3), color: "rgb(var(--warning))" }]} />
          <p className="mt-2 text-2xs text-muted">Nakamoto coefficient {conc.nakamoto} · HHI {conc.hhi} ({conc.hhi_band}).</p>
        </Panel>
        <Panel title="Recent delegations">
          <ul className="space-y-1.5 text-xs">
            {d.data.delegates.flatMap((c: any) => c.delegators.map((x: any) => ({ ...x, to: c.label }))).map((x: any) => (
              <li key={x.tx_hash} className="flex items-center justify-between gap-2">
                <span className="truncate">{x.label ?? x.address.slice(0, 10)} → {x.to}</span>
                <TxLink hash={x.tx_hash} block={x.block_number} />
              </li>
            ))}
          </ul>
          <p className="mt-2 text-2xs text-muted">{d.data.data_label} Updated at block #{d.data.block_number} · {dateTime(new Date().toISOString())}</p>
        </Panel>
      </div>
    </div>
  );
}
