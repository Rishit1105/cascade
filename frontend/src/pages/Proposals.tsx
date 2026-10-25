import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowRight, FilePlus2, Pencil, Search } from "lucide-react";
import type { ProposalItem } from "../lib/api";
import { cx, timeAgo } from "../lib/format";
import { useProposal, useProposals, useQuestions } from "../lib/queries";
import { Badge, Button, DemoBadge, EmptyState, ErrorState, LoadingBlock, StatusBadge, Tabs } from "../components/ui";
import { BriefTab } from "./proposal/Brief";
import { EvidenceTab } from "./proposal/Evidence";
import { DisclosureTab } from "./proposal/Disclosure";
import { VersionsTab } from "./proposal/VersionsTab";
import { MilestonesTab } from "./proposal/Milestones";
import { FindingsTab } from "./proposal/FindingsTab";
import { QATab } from "./proposal/QATab";
import { DecisionPanel } from "./proposal/DecisionPanel";
import { CreateProposal, EditDraft } from "./proposal/Forms";

type Tab = "brief" | "evidence" | "disclosure" | "versions" | "milestones" | "findings" | "qa";
const STATUS_FILTERS = [
  { id: "", label: "All" },
  { id: "in_review", label: "Draft" },
  { id: "voting", label: "Voting" },
  { id: "approved", label: "Approved" },
  { id: "executed", label: "Executed" },
  { id: "halted", label: "Halted" },
];

function ProposalCard({ p, active, onClick }: { p: ProposalItem; active: boolean; onClick: () => void }) {
  const high = (p.open_findings.critical ?? 0) + (p.open_findings.high ?? 0);
  return (
    <button onClick={onClick} className={cx("w-full rounded-lg border p-3 text-left transition-colors", active ? "border-fg/70 bg-surface shadow-card ring-1 ring-fg/10" : "border-line bg-surface hover:border-line-strong")}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs font-semibold text-muted">{p.id}</span>
        <StatusBadge status={p.status} />
      </div>
      <p className="mt-1 line-clamp-2 text-sm font-semibold leading-snug text-fg">{p.title}</p>
      <p className="mt-1 truncate text-2xs text-muted">{p.proposer_label}</p>
      <div className="mt-2 flex items-center justify-between text-2xs">
        <span className="font-semibold text-fg">{p.requested_display}</span>
        <span className="flex items-center gap-1.5 text-muted">
          {high > 0 && <Badge tone="danger">{high} high</Badge>}
          {timeAgo(p.updated_at)}
        </span>
      </div>
    </button>
  );
}

export default function Proposals() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const list = useProposals({ status: status === "in_review" ? undefined : status || undefined, q: q || undefined, category: category || undefined, min_amount: minAmount ? String(BigInt(Math.round(Number(minAmount))) * 1_000_000n) : undefined });
  const items = (list.data ?? []).filter((p) => (status === "in_review" ? ["draft", "in_review", "committed"].includes(p.status) : true));
  const tab = (params.get("tab") as Tab) || "brief";
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    next.set("tab", t);
    setParams(next, { replace: true });
  };
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!id && list.data && list.data.length) navigate(`/proposals/${list.data.find((p) => p.id === "GOV-042")?.id ?? list.data[0].id}`, { replace: true });
  }, [id, list.data, navigate]);

  const detail = useProposal(id);
  const p = detail.data;
  const qa = useQuestions(id);
  const qaPending = qa.data ? qa.data.counts.open + qa.data.counts.needs_more + qa.data.counts.answered : undefined;

  return (
    <div className="grid gap-4 xl:grid-cols-[290px_minmax(0,1fr)_340px]">
      <aside className="flex flex-col gap-3 xl:sticky xl:top-[72px] xl:-mx-1 xl:max-h-[calc(100vh-88px)] xl:self-start xl:overflow-y-auto xl:px-1 xl:pb-1">
        <div className="flex items-center justify-between">
          <h1 className="text-[17px] font-semibold">Proposals</h1>
          <Button size="sm" variant="primary" icon={<FilePlus2 className="h-3.5 w-3.5" />} onClick={() => setCreating(true)}>
            New
          </Button>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
          <input className="input pl-8" placeholder="Search proposals" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search proposals" />
        </div>
        <div className="flex flex-wrap gap-1">
          {STATUS_FILTERS.map((s) => (
            <button key={s.id} onClick={() => setStatus(s.id)} className={cx("cursor-pointer rounded-md border px-2 py-0.5 text-2xs font-semibold transition-colors duration-200", status === s.id ? "border-fg bg-fg text-surface" : "border-line text-muted hover:text-fg")}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            <option value="">All categories</option>
            {["grant", "upgrade", "budget", "retainer", "parameter"].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <input className="input" inputMode="numeric" placeholder="Min mUSDC" value={minAmount} onChange={(e) => setMinAmount(e.target.value.replace(/[^\d]/g, ""))} aria-label="Minimum amount" />
        </div>
        <div className="flex flex-col gap-2">
          {list.isLoading && <LoadingBlock rows={6} />}
          {list.error && <ErrorState error={list.error} retry={() => list.refetch()} />}
          {items.length === 0 && !list.isLoading && <EmptyState title="No proposals match" body="Clear the filters or create a new proposal." />}
          {items.map((it) => (
            <ProposalCard key={it.id} p={it} active={it.id === id} onClick={() => navigate(`/proposals/${it.id}?tab=${tab}`)} />
          ))}
        </div>
      </aside>

      <section className="min-w-0">
        {detail.isLoading && <LoadingBlock rows={10} />}
        {detail.error && <ErrorState error={detail.error} retry={() => detail.refetch()} />}
        {p && (
          <div className="panel">
            <div className="px-5 pt-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-muted">{p.id}</span>
                    <StatusBadge status={p.status} />
                    <Badge>{p.category}</Badge>
                    <Badge tone="info">{p.current_version ? `v${p.current_version} committed` : "uncommitted draft"}</Badge>
                    {p.is_demo && <DemoBadge />}
                  </div>
                  <h2 className="mt-1.5 text-[19px] font-semibold leading-snug tracking-[-0.01em]">{p.title}</h2>
                  <p className="mt-1 text-sm text-muted">{p.summary}</p>
                  <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <span className="font-medium text-fg">{p.proposer_label}</span>
                    {p.recipient_address && (
                      <>
                        <ArrowRight className="h-3 w-3" />
                        <span className="font-medium text-fg">{p.recipient_label ?? p.recipient_address}</span>
                      </>
                    )}
                    <span>· {p.requested_display}</span>
                  </p>
                </div>
                {p.status !== "executed" && (
                  <Button size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(true)}>
                    Edit draft
                  </Button>
                )}
              </div>
              <Tabs<Tab>
                className="mt-3"
                value={tab}
                onChange={setTab}
                tabs={[
                  { id: "brief", label: "Brief" },
                  { id: "evidence", label: "Evidence", count: p.evidence.length },
                  { id: "disclosure", label: "Disclosure" },
                  { id: "versions", label: "Versions", count: p.versions.length },
                  { id: "milestones", label: "Milestones", count: p.milestones.length },
                  { id: "findings", label: "Findings", count: p.findings.filter((f) => f.status === "open" || f.status === "challenged").length },
                  { id: "qa", label: "Q&A", count: qaPending },
                ]}
              />
            </div>
            <div className="p-5">
              {tab === "brief" && <BriefTab p={p} />}
              {tab === "evidence" && <EvidenceTab p={p} />}
              {tab === "disclosure" && <DisclosureTab p={p} />}
              {tab === "versions" && <VersionsTab p={p} />}
              {tab === "milestones" && <MilestonesTab p={p} />}
              {tab === "findings" && <FindingsTab p={p} />}
              {tab === "qa" && <QATab p={p} />}
            </div>
          </div>
        )}
      </section>

      <aside className="min-w-0">{p && <DecisionPanel p={p} />}</aside>

      <CreateProposal open={creating} onClose={() => setCreating(false)} />
      {p && <EditDraft open={editing} onClose={() => setEditing(false)} p={p} />}
    </div>
  );
}
