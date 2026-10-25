import { useEffect, useMemo, useState } from "react";
import { AlertOctagon, CheckCircle2, FileDiff, FilePlus2, FileMinus2, GitCommitHorizontal, PenLine, ShieldCheck, Wallet, XCircle } from "lucide-react";
import { api } from "../lib/api";
import { useSelectedProposal } from "../lib/app";
import type { DiffRow } from "../lib/diff";
import { cx, dateOnly, dateTime, timeAgo } from "../lib/format";
import { useAction, useFindings, useProposal, useVersionDiff } from "../lib/queries";
import { ProposalPicker } from "../components/common";
import { DiffViewer } from "../components/DiffViewer";
import { Badge, Button, Callout, EmptyState, ErrorState, Hash, LoadingBlock, Panel, SeverityBadge, StatusBadge, Toggle, TxLink } from "../components/ui";
import { CommitButton } from "./proposal/VersionsTab";

const CAT_ICON: Record<string, typeof Wallet> = { recipient: Wallet, amount: Wallet, implementation: AlertOctagon, target: AlertOctagon, calldata: AlertOctagon, evidence: FilePlus2, milestones: PenLine, text: FileDiff, disclosure: ShieldCheck };
const CRITICAL = new Set(["recipient", "amount", "implementation", "target", "calldata", "permissions"]);

export default function Versions() {
  const [pid, setPid] = useSelectedProposal("GOV-043");
  const proposal = useProposal(pid);
  const findings = useFindings(pid);
  const p = proposal.data;
  const versions = p?.versions ?? [];
  const [from, setFrom] = useState<number | undefined>();
  const [to, setTo] = useState<string>("draft");
  const [changesOnly, setChangesOnly] = useState(false);
  const [verifyResult, setVerifyResult] = useState<any>(null);
  useEffect(() => {
    if (!p) return;
    if (p.versions.length >= 2) {
      setFrom(p.versions[p.versions.length - 2].version);
      setTo(String(p.versions[p.versions.length - 1].version));
    } else if (p.versions.length === 1) {
      setFrom(1);
      setTo("draft");
    } else setFrom(undefined);
  }, [p?.id, p?.versions.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const diff = useVersionDiff(pid, from, to);
  const verify = useAction((v: number) => api.post<any>(`/proposals/${pid}/versions/${v}/verify`), { quiet: true, onSuccess: setVerifyResult, invalidate: [["audit"]] });
  const versionFindings = (findings.data ?? []).filter((f) => f.kind === "version" || f.rule_id === "MI-R011");
  const bodyRows: DiffRow[] = useMemo(() => (diff.data?.text_diffs?.body ?? []) as DiffRow[], [diff.data]);

  const toVersion = versions.find((v) => String(v.version) === to);
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Proposal history & versioning</h1>
          <p className="mt-0.5 text-sm text-muted">Every committed version is canonicalised, hashed and anchored in ProposalRegistry. Compare any two.</p>
        </div>
        <div className="flex items-center gap-2">
          <ProposalPicker value={pid} onChange={setPid} />
          {p && !["executed", "voting", "approved"].includes(p.status) && <CommitButton p={p} />}
        </div>
      </div>
      {proposal.isLoading && <LoadingBlock rows={8} />}
      {proposal.error && <ErrorState error={proposal.error} />}
      {p && versions.length === 0 && <EmptyState icon={<GitCommitHorizontal className="h-5 w-5" />} title="No committed versions yet" body="Commit the reviewed draft to start a tamper-evident history." action={<CommitButton p={p} />} />}

      {p && versions.length > 0 && (
        <>
          <div className="panel mb-4 overflow-x-auto px-5 py-4 scroll-thin">
            <div className="relative flex min-w-[560px] items-start justify-between">
              <div className="absolute left-3 right-3 top-[9px] h-[2px] bg-line" />
              {[...versions.map((v) => ({ key: String(v.version), title: `${p.id} v${v.version}`, sub: dateTime(v.committed_at), ago: timeAgo(v.committed_at), status: v.governance_status })), { key: "draft", title: "Working draft", sub: p.status === "executed" ? "closed" : "uncommitted edits", ago: "", status: "draft" }].map((node) => {
                const selected = node.key === to || (from !== undefined && node.key === String(from));
                return (
                  <button key={node.key} onClick={() => setTo(node.key)} className="relative z-10 flex flex-col items-center text-center" title="Compare against this version">
                    <span className={cx("h-[20px] w-[20px] rounded-full border-[3px] bg-surface", selected ? "border-fg" : node.status === "halted" ? "border-danger" : node.status === "executed" || node.status === "approved" ? "border-primary" : "border-line-strong")} />
                    <span className="mt-1.5 text-xs font-semibold">{node.title}</span>
                    <span className="text-2xs text-muted">{node.sub}</span>
                    {node.status !== "draft" && <StatusBadge status={node.status === "not_submitted" ? "committed" : node.status} className="mt-1" />}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
            <Panel
              title="Visual difference highlighting"
              actions={
                <div className="flex items-center gap-2 text-xs">
                  <select className="input h-7 w-auto text-xs" value={from} onChange={(e) => setFrom(Number(e.target.value))} aria-label="Compare from">
                    {versions.map((v) => <option key={v.version} value={v.version}>v{v.version}</option>)}
                  </select>
                  <span className="text-muted">→</span>
                  <select className="input h-7 w-auto text-xs" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Compare to">
                    {versions.map((v) => <option key={v.version} value={String(v.version)}>v{v.version}</option>)}
                    <option value="draft">draft</option>
                  </select>
                  <span className="ml-2 flex items-center gap-1.5 text-muted">Changes only <Toggle checked={changesOnly} onChange={setChangesOnly} label="Show changes only" /></span>
                </div>
              }
            >
              {diff.isLoading && <LoadingBlock rows={8} />}
              {diff.error && <ErrorState error={diff.error} />}
              {diff.data && (
                <div className="grid gap-3 2xl:grid-cols-[minmax(0,1fr)_220px]">
                  <div className="min-w-0 space-y-3">
                    {diff.data.identical ? (
                      <Callout tone="success" title="Identical">{diff.data.identical_note}</Callout>
                    ) : bodyRows.length > 0 ? (
                      <DiffViewer rows={bodyRows} leftTitle={`Original · v${diff.data.from.version} · ${dateOnly(diff.data.from.committed_at)}`} rightTitle={`${diff.data.to.version === "draft" ? "Working draft" : `Active · v${diff.data.to.version}`}`} rightTone="success" changesOnly={changesOnly} mono={false} />
                    ) : (
                      <p className="text-xs text-muted">The proposal text is unchanged; see the structured changes.</p>
                    )}
                    {diff.data.highlights.length > 0 && (
                      <div className="overflow-x-auto rounded-lg border border-line">
                        <table className="table-base">
                          <thead>
                            <tr><th>Field</th><th>Before</th><th>After</th></tr>
                          </thead>
                          <tbody>
                            {diff.data.highlights.map((c: any) => (
                              <tr key={c.path} className={CRITICAL.has(c.category) ? "bg-danger/[0.04]" : ""}>
                                <td className="text-xs"><span className="font-mono text-2xs">{c.path}</span><p className="text-2xs text-muted">{c.summary}</p></td>
                                <td className="max-w-[240px] break-all font-mono text-2xs text-danger">{typeof c.before === "object" ? JSON.stringify(c.before) : String(c.before ?? "—")}</td>
                                <td className="max-w-[240px] break-all font-mono text-2xs text-primary">{typeof c.after === "object" ? JSON.stringify(c.after) : String(c.after ?? "—")}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <p className="label mb-1">Change list</p>
                    {diff.data.changes.length === 0 && <p className="text-xs text-muted">No changes.</p>}
                    {Object.entries(
                      diff.data.changes.reduce((acc: Record<string, number>, c: any) => ({ ...acc, [c.category]: (acc[c.category] ?? 0) + 1 }), {}),
                    ).map(([cat, n]) => {
                      const Icon = CAT_ICON[cat] ?? FileDiff;
                      return (
                        <div key={cat} className={cx("flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs", CRITICAL.has(cat) ? "border-danger/30 bg-danger/[0.04]" : "border-line")}>
                          <Icon className={cx("h-3.5 w-3.5", CRITICAL.has(cat) ? "text-danger" : "text-muted")} />
                          <span className="flex-1 font-medium capitalize">{cat === "implementation" ? "New implementation address" : cat === "evidence" ? "Evidence set" : `${cat} changed`}</span>
                          <Badge>{n as number}</Badge>
                        </div>
                      );
                    })}
                    {diff.data.evidence.added.map((e: any) => <p key={e.id} className="flex items-center gap-1 text-2xs text-primary"><FilePlus2 className="h-3 w-3" /> {e.name}</p>)}
                    {diff.data.evidence.removed.map((e: any) => <p key={e.id} className="flex items-center gap-1 text-2xs text-danger"><FileMinus2 className="h-3 w-3" /> {e.name}</p>)}
                  </div>
                </div>
              )}
            </Panel>

            <div className="flex flex-col gap-4">
              <Panel title="Change impact analysis">
                <div className="space-y-3 text-xs">
                  <div>
                    <p className="label mb-1.5">Automated severity alerts</p>
                    {versionFindings.length === 0 && <p className="text-muted">No version-integrity alerts.</p>}
                    {versionFindings.map((f) => (
                      <div key={f.id} className="mb-2 rounded-lg border border-danger/25 bg-danger/[0.03] p-2.5">
                        <SeverityBadge severity={f.severity} />
                        <p className="mt-1 font-semibold">{f.title}</p>
                        <p className="mt-0.5 line-clamp-4 text-2xs text-muted">{f.explanation}</p>
                      </div>
                    ))}
                  </div>
                  <div>
                    <p className="label mb-1.5">Author commits</p>
                    {versions.map((v) => (
                      <div key={v.version} className="flex items-start justify-between gap-2 border-b border-line py-1.5 last:border-0">
                        <span><span className="font-semibold">v{v.version}</span> · {v.author}<span className="block text-2xs text-muted">{v.change_note || "No change note"}</span></span>
                        <span className="shrink-0 text-2xs text-muted">{timeAgo(v.committed_at)}</span>
                      </div>
                    ))}
                  </div>
                  <div>
                    <p className="label mb-1.5">Tamper evidence</p>
                    <p className="mb-2 text-2xs text-muted">Recompute every hash from stored data and compare with the on-chain registry and the proposer's signature.</p>
                    <div className="flex flex-wrap gap-1.5">
                      {versions.map((v) => (
                        <Button key={v.version} size="sm" icon={<ShieldCheck className="h-3.5 w-3.5" />} loading={verify.isPending && verify.variables === v.version} onClick={() => verify.mutate(v.version)}>
                          Verify v{v.version}
                        </Button>
                      ))}
                    </div>
                    {verifyResult && (
                      <div className="mt-2 space-y-1">
                        <Badge tone={verifyResult.ok ? "success" : "danger"}>v{verifyResult.version}: {verifyResult.ok ? "all checks passed" : "mismatch"}</Badge>
                        {verifyResult.checks.map((c: any) => (
                          <p key={c.check} className="flex items-center gap-1.5 text-2xs">
                            {c.ok ? <CheckCircle2 className="h-3 w-3 text-primary" /> : <XCircle className="h-3 w-3 text-danger" />}
                            {c.check}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </Panel>
              {toVersion && (
                <Panel title={`v${toVersion.version} commitment`}>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex items-center justify-between"><span className="text-muted">Content</span><Hash value={toVersion.content_hash} /></div>
                    <div className="flex items-center justify-between"><span className="text-muted">Manifest</span><Hash value={toVersion.manifest_hash} /></div>
                    <div className="flex items-center justify-between"><span className="text-muted">Evidence root</span><Hash value={toVersion.evidence_root} /></div>
                    <div className="flex items-center justify-between"><span className="text-muted">Registry tx</span><TxLink hash={toVersion.tx_hash} block={toVersion.block_number} /></div>
                  </div>
                </Panel>
              )}
            </div>
          </div>

          <section className="mt-4 overflow-hidden rounded-xl border border-ink bg-ink text-white shadow-card dark:border-line">
            <div className="flex items-center justify-between px-4 py-3">
              <h2 className="text-[13.5px] font-semibold">Commit ledger</h2>
              <span className="text-2xs text-white/60">ProposalRegistry · proposer-signed EIP-712 disclosures</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-2xs uppercase tracking-[0.05em] text-white/50">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Date</th>
                    <th className="px-4 py-2 font-semibold">Contributor</th>
                    <th className="px-4 py-2 font-semibold">Content hash</th>
                    <th className="px-4 py-2 font-semibold">Manifest digest</th>
                    <th className="px-4 py-2 font-semibold">Registry transaction</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.version} className="border-t border-white/10">
                      <td className="px-4 py-2.5 text-white/80">{dateTime(v.committed_at)} · v{v.version}</td>
                      <td className="px-4 py-2.5">{v.author}</td>
                      <td className="px-4 py-2.5 font-mono text-white/80">{v.content_hash.slice(0, 26)}…</td>
                      <td className="px-4 py-2.5 font-mono text-white/80">{v.manifest_hash.slice(0, 26)}…</td>
                      <td className="px-4 py-2.5 font-mono text-[#7FD4C3]">{v.tx_hash?.slice(0, 22)}… #{v.block_number}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
