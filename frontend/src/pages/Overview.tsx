import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight, BellRing, CircleCheck, FileText, Landmark, PlayCircle, Radar, ShieldCheck, ShieldX } from "lucide-react";
import type { EvaluationChain } from "../lib/api";
import { cx, dateTime, formatUnits, timeAgo, usdc } from "../lib/format";
import { useGraph, useOverview } from "../lib/queries";
import { EvaluationChainView } from "../components/EvaluationChain";
import { GraphLegend, RelationshipGraph } from "../components/RelationshipGraph";
import { Badge, Button, DemoBadge, EmptyState, ErrorState, LoadingBlock, MetricCard, PageHeader, Panel, ProgressBar, SeverityBadge, StatusBadge, TxLink, VerificationBadge } from "../components/ui";

export default function Overview() {
  const ov = useOverview();
  const graph = useGraph();
  const navigate = useNavigate();
  const pipeline: Array<{ proposal: any; evaluation: EvaluationChain }> = ov.data?.pipeline ?? [];
  const defaultId = useMemo(() => pipeline.find((p) => p.proposal.id === "GOV-043")?.proposal.id ?? pipeline[0]?.proposal.id, [pipeline]);
  const [selected, setSelected] = useState<string | undefined>();
  const current = pipeline.find((p) => p.proposal.id === (selected ?? defaultId));

  if (ov.error) return <ErrorState error={ov.error} retry={() => ov.refetch()} />;
  const m = ov.data?.metrics;

  return (
    <div>
      <PageHeader
        title="Governance overview"
        subtitle="Understand the decision. Verify the execution. Preserve the evidence."
        actions={
          <>
            <DemoBadge />
            <Button icon={<PlayCircle className="h-4 w-4" />} onClick={() => navigate("/guardian?p=GOV-042")}>
              Run execution demo
            </Button>
            <Button variant="primary" icon={<FileText className="h-4 w-4" />} onClick={() => navigate("/proposals/GOV-043")}>
              Review proposal
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Active proposals" value={m ? String(m.active_proposals).padStart(2, "0") : "—"} icon={<FileText className="h-4 w-4" />} sub="Drafts, votes and approvals not yet executed" />
        <MetricCard
          label="Needing review"
          value={m ? String(m.needing_review).padStart(2, "0") : "—"}
          tone={m?.needing_review ? "warning" : undefined}
          icon={<BellRing className="h-4 w-4" />}
          sub={m ? `${m.needing_review_ids.join(", ") || "none"} · open high/critical findings or drafts` : ""}
        />
        <MetricCard
          label="Execution assurance"
          value={m ? <span>{m.executions_succeeded}<span className="text-base font-medium text-muted"> executed · </span><span className="text-danger">{m.executions_blocked}</span><span className="text-base font-medium text-muted"> blocked</span></span> : "—"}
          icon={<ShieldCheck className="h-4 w-4" />}
          tone="success"
          sub={m ? `${m.checks_passed} matching checks · ${m.checks_mismatched} mismatches (all contract-enforced)` : ""}
        />
        <MetricCard
          label="Allocation under review"
          value={m ? usdc(m.allocation_under_review_base) : "—"}
          icon={<Landmark className="h-4 w-4" />}
          sub={m ? `${m.allocation_share_pct}% of the ${formatUnits(m.treasury_balance_base, 6, 0)} mUSDC treasury (on-chain balance)` : ""}
        />
      </div>

      <Panel
        className="mt-4"
        title="Probabilistic evaluation chain"
        subtitle="Proposal claims → conflict-of-interest risk → on-chain voting → execution discrepancy. Every factor is listed; nothing is a black-box score."
        actions={
          <div className="flex flex-wrap gap-1">
            {pipeline.map((p) => (
              <button
                key={p.proposal.id}
                onClick={() => setSelected(p.proposal.id)}
                className={cx("rounded-md border px-2 py-1 text-xs font-semibold transition-colors", (selected ?? defaultId) === p.proposal.id ? "border-fg bg-fg text-surface" : "border-line text-muted hover:text-fg")}
              >
                {p.proposal.id}
              </button>
            ))}
          </div>
        }
      >
        {ov.isLoading && <LoadingBlock rows={4} />}
        {current && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold">{current.proposal.title}</span>
              <StatusBadge status={current.proposal.status} />
              <span className="text-xs text-muted">· {current.proposal.requested_display}</span>
            </div>
            <EvaluationChainView chain={current.evaluation} proposalId={current.proposal.id} />
          </>
        )}
      </Panel>

      <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel
          title="Governance relationship map"
          subtitle="Proposals, wallets, delegates, treasury and contracts. Edges carry their evidence source."
          actions={
            <Button size="sm" icon={<ArrowUpRight className="h-3.5 w-3.5" />} onClick={() => navigate("/relationships")}>
              Open explorer
            </Button>
          }
          bodyClassName="px-0 pb-0"
        >
          <div className="border-t border-line">
            {graph.isLoading && <div className="p-4"><LoadingBlock rows={6} /></div>}
            {graph.data && (
              <RelationshipGraph
                nodes={graph.data.nodes.filter((n) => ["proposal", "wallet", "delegate", "treasury", "dao"].includes(n.type) && n.role !== "fee_payer")}
                edges={graph.data.edges.filter((e) => !["references_evidence", "execution_attempt", "governs", "executes_contract", "embedded_in_bytecode"].includes(e.type))}
                height={560}
                compact
                showLabels
                onSelectNode={(n) => n && navigate(`/relationships?focus=${encodeURIComponent(n.id)}`)}
              />
            )}
          </div>
          <div className="border-t border-line px-4 py-2.5">
            <GraphLegend />
          </div>
        </Panel>

        <div className="flex flex-col gap-4">
          {current && (
            <Panel title="In focus" actions={<StatusBadge status={current.proposal.status} />}>
              <p className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted">
                {current.proposal.id} · {current.proposal.category}
              </p>
              <p className="mt-1 text-[16px] font-semibold leading-snug">{current.proposal.title}</p>
              <p className="mt-1.5 line-clamp-3 text-xs text-muted">{current.proposal.summary}</p>
              <div className="mt-3 flex items-end justify-between">
                <div>
                  <p className="text-2xs text-muted">Requested allocation</p>
                  <p className="text-xl font-semibold">{current.proposal.requested_display}</p>
                </div>
                <Badge tone={current.proposal.guard_status === "halted" ? "danger" : current.proposal.guard_status === "approved" ? "success" : "neutral"}>
                  Guard: {current.proposal.guard_status}
                </Badge>
              </div>
              <div className="mt-3">
                <div className="mb-1 flex justify-between text-2xs text-muted">
                  <span>Evidence attached</span>
                  <span>{current.proposal.evidence_count} sources</span>
                </div>
                <ProgressBar value={Math.min(100, current.proposal.evidence_count * 25)} />
              </div>
              <Button variant="dark" className="mt-4 w-full" onClick={() => navigate(`/proposals/${current.proposal.id}`)}>
                Review proposal
              </Button>
            </Panel>
          )}
          <Panel title="Open alerts" actions={<Link to="/escalation" className="text-xs font-semibold text-primary hover:underline">Escalation inbox</Link>}>
            {(ov.data?.alerts ?? []).length === 0 && <EmptyState icon={<CircleCheck className="h-5 w-5" />} title="No open alerts" />}
            <ul className="space-y-2">
              {(ov.data?.alerts ?? []).map((a: any) => (
                <li key={a.id}>
                  <Link to={`/escalation?alert=${a.id}`} className="flex items-start gap-2 rounded-lg border border-line p-2.5 hover:bg-subtle">
                    {a.severity === "critical" ? <ShieldX className="mt-0.5 h-4 w-4 shrink-0 text-danger" /> : <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
                    <span className="min-w-0">
                      <span className="line-clamp-2 text-xs font-medium text-fg">{a.title}</span>
                      <span className="mt-1 flex items-center gap-1.5 text-2xs text-muted">
                        <SeverityBadge severity={a.severity} /> {a.proposal_id} · {timeAgo(a.created_at)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel title="Recent audit events" subtitle="Hash-chained ledger. Chain-confirmed events link to their transaction." actions={<Link to="/audit" className="text-xs font-semibold text-primary hover:underline">Full timeline</Link>} bodyClassName="px-0">
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>Proposal</th>
                  <th>Source</th>
                  <th>Transaction</th>
                </tr>
              </thead>
              <tbody>
                {(ov.data?.recent_events ?? []).map((e: any) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap text-xs text-muted">{dateTime(e.occurred_at)}</td>
                    <td className="max-w-[460px]">
                      <span className={cx("mr-1.5 inline-block h-2 w-2 rounded-full", { success: "bg-primary", failure: "bg-danger", warning: "bg-warning", info: "bg-info" }[e.status as string])} />
                      <span className="text-xs">{e.summary}</span>
                    </td>
                    <td className="text-xs font-medium">{e.proposal_id ?? "—"}</td>
                    <td><VerificationBadge value={e.verification} /></td>
                    <td><TxLink hash={e.tx_hash} block={e.block_number} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="Sentinel" icon={<Radar className="h-4 w-4 text-primary" />} subtitle="Watches every ManifestApproved event, simulates the approved payload and can halt it on-chain during the review window.">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-muted">Status</span><Badge tone={ov.data?.sentinel?.running ? "success" : "danger"}>{ov.data?.sentinel?.running ? "Watching" : "Stopped"}</Badge></div>
            <div className="flex justify-between"><span className="text-muted">Last checked block</span><span className="font-mono text-xs">#{ov.data?.sentinel?.last_block ?? "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted">Reviews this session</span><span className="font-medium">{ov.data?.sentinel?.reviews ?? 0}</span></div>
            <div className="flex justify-between"><span className="text-muted">Last tick</span><span className="text-xs">{timeAgo(ov.data?.sentinel?.last_tick)}</span></div>
            {ov.data?.sentinel?.last_error && <p className="rounded bg-danger/5 p-2 text-2xs text-danger">{ov.data.sentinel.last_error}</p>}
            <p className="pt-1 text-2xs text-muted">The guardian role can only block an approval. It can never approve, alter or execute anything.</p>
          </div>
        </Panel>
      </div>
    </div>
  );
}
