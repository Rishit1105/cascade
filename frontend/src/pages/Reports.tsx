import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Download, FileJson, FileSpreadsheet, FileText, Plus, ShieldCheck } from "lucide-react";
import { api } from "../lib/api";
import { useSelectedProposal } from "../lib/app";
import { cx, dateTime } from "../lib/format";
import { useAction, useAlerts, useAuditEvents, useReports } from "../lib/queries";
import { ProposalPicker } from "../components/common";
import { Gauge } from "../components/charts";
import { Modal } from "../components/overlays";
import { Badge, Button, Callout, EmptyState, Hash, LoadingBlock, Panel } from "../components/ui";

const FORMAT_ICON = { pdf: FileText, json: FileJson, csv: FileSpreadsheet } as const;

export default function Reports() {
  const reports = useReports();
  const events = useAuditEvents({ limit: 1000 });
  const alerts = useAlerts({ status: "open" });
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [verify, setVerify] = useState<any>(null);
  const runVerify = useAction(() => api.post<any>("/audit/verify"), { quiet: true, onSuccess: setVerify, invalidate: [["audit"]] });

  const items = events.data?.items ?? [];
  const perDay = useMemo(() => {
    if (items.length === 0) return [];
    const m = new Map<string, { day: string; offchain: number; chain: number }>();
    items.forEach((e) => {
      const day = e.occurred_at.slice(0, 10);
      const row = m.get(day) ?? { day, offchain: 0, chain: 0 };
      if (e.verification === "chain-confirmed") row.chain += 1;
      else row.offchain += 1;
      m.set(day, row);
    });
    // Every calendar day between the first and last event, so quiet days show as zero.
    const days = [...m.keys()].sort();
    const out = [];
    for (let d = new Date(days[0] + "T00:00:00Z"); d <= new Date(days[days.length - 1] + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      out.push(m.get(key) ?? { day: key, offchain: 0, chain: 0 });
    }
    return out;
  }, [items]);
  const chainShare = items.length ? Math.round((items.filter((e) => e.verification === "chain-confirmed").length / items.length) * 100) : 0;
  const escalations = (alerts.data?.items ?? []).filter((a) => a.status === "escalated" || a.severity === "critical").length;
  const shown = (reports.data?.items ?? []).filter((r) => !q || `${r.file_name} ${r.proposal_id} ${r.generated_by}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Compliance & audit export</h1>
          <p className="mt-0.5 text-sm text-muted">Human-readable and machine-readable reports that keep evidence labels and limitations attached.</p>
        </div>
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>Generate audit report</Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Compliance status overview" actions={<Button size="sm" icon={<ShieldCheck className="h-3.5 w-3.5" />} loading={runVerify.isPending} onClick={() => runVerify.mutate(undefined)}>Verify ledger</Button>}>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <div><p className="text-xs text-muted">Ledger integrity</p><p className={cx("text-lg font-semibold", verify ? (verify.ok ? "text-primary" : "text-danger") : "text-fg")}>{verify ? (verify.ok ? "Intact" : "Broken") : "Not verified"}</p></div>
              <div><p className="text-xs text-muted">Chain-confirmed events</p><p className="text-lg font-semibold">{chainShare}%</p></div>
              <div><p className="text-xs text-muted">Escalations open</p><p className={cx("text-lg font-semibold", escalations > 0 && "text-danger")}>{escalations}</p></div>
              <div><p className="text-xs text-muted">Reports generated</p><p className="text-lg font-semibold">{reports.data?.items.length ?? "—"}</p></div>
            </div>
            {verify && <p className="mt-2 text-2xs text-muted">{verify.event_count} events re-hashed · {verify.chain_receipts.confirmed}/{verify.chain_receipts.checked} receipts re-confirmed · {verify.anchors.length} anchor(s) checked</p>}
          </Panel>

          <Panel title="Historical logs" subtitle="Audit events per day: chain-confirmed vs off-chain records">
            <div className="h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={perDay} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="day" tickLine={false} axisLine={false} tickFormatter={(d) => d.slice(5)} minTickGap={18} />
                  <YAxis tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip cursor={{ fill: "rgb(var(--subtle))" }} />
                  <Bar dataKey="chain" stackId="a" name="chain-confirmed" fill="rgb(var(--primary))" isAnimationActive={false} />
                  <Bar dataKey="offchain" stackId="a" name="off-chain record" fill="rgb(var(--info) / 0.45)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <Panel title="Past generated reports" actions={<input className="input h-7 w-[200px] text-xs" placeholder="Search reports" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search reports" />} bodyClassName="px-0">
            {reports.isLoading && <div className="px-4"><LoadingBlock rows={4} /></div>}
            {shown.length === 0 && !reports.isLoading && <EmptyState title="No reports yet" body="Generate a PDF, JSON or CSV report for any proposal." />}
            {shown.length > 0 && (
              <div className="overflow-x-auto">
                <table className="table-base">
                  <thead><tr><th>File</th><th>Timestamp</th><th>Generated by</th><th>SHA-256</th><th /></tr></thead>
                  <tbody>
                    {shown.map((r) => {
                      const Icon = FORMAT_ICON[r.format as keyof typeof FORMAT_ICON] ?? FileText;
                      return (
                        <tr key={r.id}>
                          <td><span className="flex items-center gap-2 text-xs font-medium"><Icon className="h-4 w-4 text-muted" />{r.file_name}</span><span className="text-2xs text-muted">{r.sections.length} sections · {(r.size_bytes / 1024).toFixed(1)} KB</span></td>
                          <td className="whitespace-nowrap text-xs text-muted">{dateTime(r.generated_at)}</td>
                          <td className="text-xs">{r.generated_by}</td>
                          <td><Hash value={r.sha256} head={14} tail={4} /></td>
                          <td><a className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-ink px-2.5 text-xs font-medium text-white dark:bg-fg dark:text-ink" href={`/api/reports/${r.id}/download`} download><Download className="h-3.5 w-3.5" />Download</a></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        <div className="flex flex-col gap-4">
          <Panel title="Key compliance metrics">
            <Gauge value={chainShare} higherIsBetter label="Chain-confirmed share" sublabel="of ledger events backed by a transaction receipt" />
            <Callout tone="info" title="What reports include">
              Evidence labels (chain-confirmed / off-chain, verified / heuristic), demo-data notice, generation time, chain id and block, and the limitations of every method. Heuristics are never presented as facts.
            </Callout>
          </Panel>
          <Panel title="Regulatory-style alerts" subtitle="Open alerts that a report would disclose">
            <ul className="space-y-1.5">
              {(alerts.data?.items ?? []).slice(0, 6).map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-2 text-xs">
                  <span className="line-clamp-2">{a.title}</span>
                  <Badge tone={a.severity === "critical" || a.severity === "high" ? "danger" : "warning"}>{a.severity}</Badge>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
      <GenerateModal open={open} onClose={() => setOpen(false)} sections={reports.data?.sections ?? {}} />
    </div>
  );
}

function GenerateModal({ open, onClose, sections }: { open: boolean; onClose: () => void; sections: Record<string, string> }) {
  const [pid, setPid] = useSelectedProposal("GOV-042");
  const [format, setFormat] = useState<"pdf" | "json" | "csv">("pdf");
  const [chosen, setChosen] = useState<Set<string>>(new Set(Object.keys(sections)));
  const allKeys = Object.keys(sections);
  useEffect(() => {
    if (open) setChosen(new Set(Object.keys(sections)));
  }, [open, sections]);
  const gen = useAction(() => api.post<any>("/reports", { proposal_id: pid, format, sections: allKeys.filter((k) => chosen.size === 0 || chosen.has(k)) }), {
    success: (r: any) => `${r.file_name} generated`,
    onSuccess: (r: any) => {
      onClose();
      window.location.assign(`/api/reports/${r.id}/download`);
    },
    invalidate: [["reports"], ["audit"]],
  });
  return (
    <Modal open={open} onClose={onClose} title="Generate audit report" width="max-w-xl"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!pid || chosen.size === 0} loading={gen.isPending} onClick={() => gen.mutate(undefined)}>Generate</Button></>}>
      <div className="space-y-4">
        <div>
          <p className="mb-1 text-xs font-medium">Proposal</p>
          <ProposalPicker value={pid} onChange={setPid} />
        </div>
        <div className="grid gap-4 md:grid-cols-[140px_1fr]">
          <div>
            <p className="mb-1.5 text-xs font-medium">Download format</p>
            {(["pdf", "json", "csv"] as const).map((f) => (
              <label key={f} className="mb-1 flex items-center gap-2 text-sm">
                <input type="radio" name="fmt" checked={format === f} onChange={() => setFormat(f)} className="accent-[rgb(var(--primary))]" />
                {f.toUpperCase()}
              </label>
            ))}
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium">Include in report</p>
            <div className="grid grid-cols-2 gap-x-3">
              {allKeys.map((k) => (
                <label key={k} className="mb-1 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={chosen.has(k)} onChange={() => { const n = new Set(chosen); if (n.has(k)) n.delete(k); else n.add(k); setChosen(n); }} className="accent-[rgb(var(--primary))]" />
                  {sections[k]}
                </label>
              ))}
            </div>
          </div>
        </div>
        <p className="text-2xs text-muted">The report's SHA-256 is recorded in the audit ledger, so a copy can later be checked against what was generated.</p>
      </div>
    </Modal>
  );
}
