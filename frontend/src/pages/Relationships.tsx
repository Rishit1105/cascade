import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Eye, Filter, Flag, Link2, Plus, RefreshCw, Search, Tags, XCircle } from "lucide-react";
import { api, type GraphEdge, type GraphNode } from "../lib/api";
import { useApp, useSelectedProposal } from "../lib/app";
import { cx, dateTime, shortAddr, titleCase } from "../lib/format";
import { useAction, useConflicts, useGraph } from "../lib/queries";
import { ProposalPicker } from "../components/common";
import { Gauge } from "../components/charts";
import { Modal } from "../components/overlays";
import { GraphLegend, NODE_TYPES, RelationshipGraph } from "../components/RelationshipGraph";
import { Badge, Button, Callout, ConfidenceBadge, EmptyState, ErrorState, EvidenceLevelBadge, Field, Hash, LoadingBlock, Panel, SeverityBadge, Tabs, Toggle, TxLink } from "../components/ui";

const LEVELS = ["verified_observation", "disclosed", "record", "unverified_lead"] as const;

export default function Relationships() {
  const [pid, setPid] = useSelectedProposal("GOV-042");
  const [params] = useSearchParams();
  const graph = useGraph();
  const coi = useConflicts(pid);
  const { inspect } = useApp();
  const [view, setView] = useState<"graph" | "table">("graph");
  const [q, setQ] = useState("");
  const [types, setTypes] = useState<Set<string>>(new Set(["dao", "proposal", "wallet", "delegate", "treasury", "contract", "transaction"]));
  const [levels, setLevels] = useState<Set<string>>(new Set(LEVELS));
  const [labels, setLabels] = useState(true);
  const [node, setNode] = useState<GraphNode | null>(null);
  const [edge, setEdge] = useState<GraphEdge | null>(null);
  const [annotating, setAnnotating] = useState(false);

  useEffect(() => {
    const focus = params.get("focus");
    if (focus && graph.data) {
      const n = graph.data.nodes.find((x) => x.id === focus || x.address?.toLowerCase() === focus.toLowerCase());
      if (n) setNode(n);
    }
  }, [params, graph.data]);

  const { nodes, edges } = useMemo(() => {
    if (!graph.data) return { nodes: [], edges: [] };
    const ns = graph.data.nodes.filter((n) => types.has(n.type));
    const ids = new Set(ns.map((n) => n.id));
    const es = graph.data.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && levels.has(e.evidence_level));
    return { nodes: ns, edges: es };
  }, [graph.data, types, levels]);

  const highlight = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (term.length < 2) return null;
    return new Set(nodes.filter((n) => n.label.toLowerCase().includes(term) || n.address?.toLowerCase().includes(term) || n.subtitle?.toLowerCase().includes(term)).map((n) => n.id));
  }, [q, nodes]);

  const flagged = useMemo(() => {
    const s = new Set<string>();
    const c = coi.data;
    if (!c || !graph.data) return s;
    const hot = (c.findings ?? []).filter((f: any) => ["high", "medium", "critical"].includes(f.severity));
    if (hot.length) {
      c.parties.forEach((p: any) => s.add(p.address.toLowerCase()));
      const txs = new Set((c.transactions ?? []).map((t: any) => t.tx_hash));
      graph.data.edges.forEach((e) => {
        const ptx = e.provenance?.transactions?.map((t: any) => t.tx_hash) ?? [e.provenance?.tx_hash];
        if (e.type === "transfer" && ptx.some((h: string) => txs.has(h))) s.add(e.id);
      });
    }
    return s;
  }, [coi.data, graph.data]);

  const toggle = (set: Set<string>, v: string, setter: (s: Set<string>) => void) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    setter(n);
  };

  const refresh = useAction(() => api.post(`/proposals/${pid}/conflicts/refresh`), { success: "Conflict review re-run; findings updated" });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Conflict of interest audit</h1>
          <p className="mt-0.5 text-sm text-muted">Wallet relationship mapping from local-chain events, signed disclosures and labelled annotations.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ProposalPicker value={pid} onChange={setPid} />
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setAnnotating(true)}>Add annotation</Button>
          <Button variant="dark" icon={<RefreshCw className="h-4 w-4" />} loading={refresh.isPending} onClick={() => refresh.mutate(undefined)}>Run conflict review</Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel
          title={view === "graph" ? "Wallet relationship mapping" : "Relationships (table)"}
          bodyClassName="px-0 pb-0"
          actions={<Tabs value={view} onChange={setView} className="border-0" tabs={[{ id: "graph", label: "Graph" }, { id: "table", label: "Table" }]} />}
        >
          <div className="flex flex-wrap items-center gap-2 border-y border-line px-4 py-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
              <input className="input h-7 w-[200px] pl-8 text-xs" placeholder="Find wallet, delegate, proposal…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search graph" />
            </div>
            <Filter className="ml-1 h-3.5 w-3.5 text-faint" />
            {NODE_TYPES.map((t) => (
              <button key={t.id} onClick={() => toggle(types, t.id, setTypes)} className={cx("rounded-md border px-1.5 py-0.5 text-2xs font-medium", types.has(t.id) ? "border-fg/60 text-fg" : "border-line text-faint line-through")}>
                {t.label}
              </button>
            ))}
            <span className="h-4 w-px bg-line" />
            {LEVELS.map((l) => (
              <button key={l} onClick={() => toggle(levels, l, setLevels)} className={cx("rounded-md border px-1.5 py-0.5 text-2xs font-medium", levels.has(l) ? "border-fg/60 text-fg" : "border-line text-faint line-through")}>
                {titleCase(l)}
              </button>
            ))}
            <span className="ml-auto flex items-center gap-1.5 text-2xs text-muted">
              <Tags className="h-3.5 w-3.5" /> Labels <Toggle checked={labels} onChange={setLabels} label="Toggle labels" />
            </span>
          </div>
          {graph.isLoading && <div className="p-4"><LoadingBlock rows={10} /></div>}
          {graph.error && <div className="p-4"><ErrorState error={graph.error} retry={() => graph.refetch()} /></div>}
          {graph.data && view === "graph" && (
            <RelationshipGraph
              nodes={nodes}
              edges={edges}
              selectedNode={node?.id}
              selectedEdge={edge?.id}
              onSelectNode={(n) => { setNode(n); setEdge(null); }}
              onSelectEdge={(e) => { setEdge(e); setNode(null); }}
              highlight={highlight}
              flagged={flagged}
              showLabels={labels}
              height={600}
            />
          )}
          {graph.data && view === "table" && (
            <div className="max-h-[640px] overflow-auto scroll-thin">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>From</th>
                    <th>Relationship</th>
                    <th>To</th>
                    <th>Evidence</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {edges.map((e) => {
                    const s = graph.data!.nodes.find((n) => n.id === e.source);
                    const t = graph.data!.nodes.find((n) => n.id === e.target);
                    return (
                      <tr key={e.id} className="cursor-pointer hover:bg-subtle/60" onClick={() => { setEdge(e); setNode(null); }}>
                        <td className="text-xs font-medium">{s?.label}</td>
                        <td className="text-xs">{titleCase(e.type)}<span className="block text-2xs text-muted">{e.label}</span></td>
                        <td className="text-xs font-medium">{t?.label}</td>
                        <td><EvidenceLevelBadge level={e.evidence_level} /></td>
                        <td className="text-2xs text-muted">{e.provenance?.tx_hash ? <TxLink hash={e.provenance.tx_hash} block={e.provenance.block_number} /> : e.provenance?.kind}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="border-t border-line px-4 py-2.5">
            <GraphLegend />
            <p className="mt-1.5 text-2xs text-muted">{graph.data?.note} {graph.data?.data_label}</p>
          </div>
        </Panel>

        <div className="flex flex-col gap-4">
          {edge && <EdgeDetail edge={edge} graphNodes={graph.data?.nodes ?? []} proposalId={pid} onClose={() => setEdge(null)} />}
          {node && !edge && <NodeDetail node={node} edges={graph.data?.edges ?? []} nodes={graph.data?.nodes ?? []} onClose={() => setNode(null)} onSelectEdge={setEdge} />}
          {!edge && !node && (
            <Panel title="Wallet interconnectivity metrics" subtitle={pid ? `${pid}: proposer ↔ counterparties` : undefined}>
              {coi.isLoading && <LoadingBlock rows={6} />}
              {coi.error && <ErrorState error={coi.error} />}
              {coi.data && (
                <div className="space-y-4">
                  {coi.data.connection_index.length === 0 && <p className="text-xs text-muted">This proposal has no counterparty (no recipient or embedded address) to map against the proposer.</p>}
                  {coi.data.connection_index.map((c: any) => (
                    <div key={c.address} className="rounded-lg border border-line p-3">
                      <Gauge value={c.index} label={`Connection index · ${c.counterparty_role}`} sublabel={`${c.paths} path(s) within 3 hops · ${shortAddr(c.address)}`} />
                    </div>
                  ))}
                  <p className="text-2xs leading-relaxed text-muted">{coi.data.connection_index_method}</p>
                  <div>
                    <p className="label mb-1.5">Disclosure</p>
                    {coi.data.disclosure.present ? (
                      <p className="text-xs">
                        {coi.data.disclosure.statement.no_conflicts ? "Proposer attests no conflicts" : `${coi.data.disclosure.statement.relationships.length} relationship(s) disclosed`}
                        {coi.data.disclosure.signed_in_version ? <Badge tone="success" className="ml-1.5">signed in v{coi.data.disclosure.signed_in_version}</Badge> : <Badge tone="warning" className="ml-1.5">not yet signed</Badge>}
                      </p>
                    ) : (
                      <p className="text-xs text-danger">No disclosure published.</p>
                    )}
                  </div>
                  <div>
                    <p className="label mb-1.5">Automatic flag alerts</p>
                    {coi.data.findings.length === 0 && <p className="text-xs text-muted">No relationship findings.</p>}
                    <ul className="space-y-2">
                      {coi.data.findings.map((f: any) => (
                        <li key={f.key} className="rounded-lg border border-line p-2.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <SeverityBadge severity={f.severity} />
                            <ConfidenceBadge confidence={f.confidence} />
                          </div>
                          <p className="mt-1 text-xs font-semibold">{f.title}</p>
                          <p className="mt-0.5 line-clamp-3 text-2xs text-muted" title={f.explanation}>{f.explanation}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </Panel>
          )}
        </div>
      </div>

      <Panel className="mt-4" title="Suspected transaction chains" subtitle="Transfers on relationship paths between the proposer and counterparties. Re-verify any row directly against the node." bodyClassName="px-0">
        {coi.data && coi.data.transactions.length === 0 && <EmptyState title="No transfers on proposer ↔ counterparty paths" />}
        {coi.data && coi.data.transactions.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Transaction hash</th>
                  <th>From → To</th>
                  <th>Amount</th>
                  <th>Block</th>
                  <th>Relational tags</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {coi.data.transactions.map((t: any) => (
                  <TxRow key={t.tx_hash} t={t} onExplore={() => inspect({ kind: "tx", value: t.tx_hash })} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <AnnotationModal open={annotating} onClose={() => setAnnotating(false)} nodes={graph.data?.nodes ?? []} />
    </div>
  );
}

function TxRow({ t, onExplore }: { t: any; onExplore: () => void }) {
  const [result, setResult] = useState<any>(null);
  const verify = useAction(() => api.post<any>("/graph/verify-tx", { tx_hash: t.tx_hash }), { quiet: true, onSuccess: setResult, invalidate: [["audit"]] });
  const transfer = result?.events?.find((e: any) => e.event === "Transfer");
  const matches = transfer && String(transfer.args.value) === String(t.amount_base) && transfer.args.from.toLowerCase() === t.from?.toLowerCase();
  return (
    <tr>
      <td><Hash value={t.tx_hash} head={12} tail={6} /></td>
      <td className="text-xs">{t.from_label} <span className="text-faint">→</span> {t.to_label}<span className="block text-2xs text-muted">{dateTime(t.timestamp)}</span></td>
      <td className="whitespace-nowrap text-xs font-semibold">{t.amount_display}</td>
      <td className="font-mono text-xs">#{t.block_number}</td>
      <td><div className="flex flex-wrap gap-1">{t.tags.map((g: string) => <Badge key={g}>{g}</Badge>)}</div></td>
      <td>
        <div className="flex items-center justify-end gap-1.5">
          {result && (matches ? <Badge tone="success" icon={<CheckCircle2 className="h-3 w-3" />}>Verified #{result.verified_at_block}</Badge> : <Badge tone="danger" icon={<XCircle className="h-3 w-3" />}>Mismatch</Badge>)}
          <Button size="sm" variant="dark" loading={verify.isPending} onClick={() => verify.mutate(undefined)}>Verify ledger</Button>
          <Button size="sm" onClick={onExplore}>View on explorer</Button>
        </div>
      </td>
    </tr>
  );
}

function NodeDetail({ node, edges, nodes, onClose, onSelectEdge }: { node: GraphNode; edges: GraphEdge[]; nodes: GraphNode[]; onClose: () => void; onSelectEdge: (e: GraphEdge) => void }) {
  const { inspect } = useApp();
  const detail = useQuery({ queryKey: ["address", node.address], queryFn: () => api.get<any>(`/chain/address/${node.address}`), enabled: !!node.address });
  const mine = edges.filter((e) => e.source === node.id || e.target === node.id);
  const name = (id: string) => nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <Panel title={node.label} subtitle={`${titleCase(node.type)}${node.subtitle ? ` · ${node.subtitle}` : ""}`} actions={<Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}>
      <div className="space-y-3">
        {node.address && (
          <div className="flex items-center justify-between rounded-lg bg-subtle px-2.5 py-1.5">
            <Hash value={node.address} head={14} tail={8} />
            <Button size="sm" variant="ghost" icon={<Eye className="h-3.5 w-3.5" />} onClick={() => inspect({ kind: "address", value: node.address! })}>Explorer</Button>
          </div>
        )}
        {detail.data && (
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg border border-line p-2"><p className="text-2xs text-muted">mUSDC</p><p className="text-xs font-semibold">{detail.data.balances.mUSDC}</p></div>
            <div className="rounded-lg border border-line p-2"><p className="text-2xs text-muted">ATLAS</p><p className="text-xs font-semibold">{detail.data.balances.ATLAS}</p></div>
            <div className="rounded-lg border border-line p-2"><p className="text-2xs text-muted">Votes</p><p className="text-xs font-semibold">{detail.data.voting_power}</p></div>
          </div>
        )}
        <div>
          <p className="label mb-1.5">Relationships ({mine.length})</p>
          <ul className="max-h-[420px] space-y-1.5 overflow-y-auto scroll-thin">
            {mine.map((e) => (
              <li key={e.id}>
                <button onClick={() => onSelectEdge(e)} className="w-full rounded-lg border border-line p-2 text-left hover:bg-subtle">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium">{e.source === node.id ? `→ ${name(e.target)}` : `← ${name(e.source)}`}</span>
                    <EvidenceLevelBadge level={e.evidence_level} />
                  </div>
                  <p className="mt-0.5 truncate text-2xs text-muted">{titleCase(e.type)} · {e.label}</p>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-2xs text-muted">Labels are demo annotations, not identity claims.</p>
      </div>
    </Panel>
  );
}

function EdgeDetail({ edge, graphNodes, proposalId, onClose }: { edge: GraphEdge; graphNodes: GraphNode[]; proposalId?: string; onClose: () => void }) {
  const [result, setResult] = useState<any>(null);
  const verify = useAction((h: string) => api.post<any>("/graph/verify-tx", { tx_hash: h }), { quiet: true, onSuccess: setResult, invalidate: [["audit"]] });
  const s = graphNodes.find((n) => n.id === edge.source);
  const t = graphNodes.find((n) => n.id === edge.target);
  const mark = useAction(
    () => api.post("/alerts", { proposal_id: proposalId ?? null, severity: edge.evidence_level === "unverified_lead" ? "low" : "medium", title: `Relationship flagged for review: ${s?.label} ↔ ${t?.label}`, description: `${titleCase(edge.type)} (${edge.label}); evidence: ${edge.evidence_level.replace(/_/g, " ")}.`, data: { edge_id: edge.id, tx_hash: edge.provenance?.tx_hash ?? null } }),
    { success: "Flagged for review in the escalation inbox" },
  );
  useEffect(() => {
    setResult(null);
  }, [edge.id]);
  const txs: any[] = edge.provenance?.transactions ?? (edge.provenance?.tx_hash ? [{ tx_hash: edge.provenance.tx_hash, block_number: edge.provenance.block_number, timestamp: edge.provenance.timestamp }] : []);
  return (
    <Panel title="Relationship evidence" subtitle={`${s?.label} ${edge.directed ? "→" : "↔"} ${t?.label}`} actions={<Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}>
      <div className="space-y-3 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="dark">{titleCase(edge.type)}</Badge>
          <EvidenceLevelBadge level={edge.evidence_level} />
        </div>
        <p className="text-sm font-medium">{edge.label}</p>
        {edge.note && <p className="text-muted">“{edge.note}”</p>}
        <div className="rounded-lg border border-line p-2.5">
          <p className="label mb-1">Why this edge is shown</p>
          <p>{edge.provenance?.kind}</p>
          {edge.provenance?.created_by && <p className="text-muted">by {edge.provenance.created_by} · {dateTime(edge.provenance.created_at)}</p>}
          {edge.provenance?.manifest_hash && <div className="mt-1"><Hash value={edge.provenance.manifest_hash} /></div>}
        </div>
        {txs.length > 0 && (
          <div>
            <p className="label mb-1">Transactions ({txs.length})</p>
            <ul className="space-y-1">
              {txs.slice(0, 8).map((x) => (
                <li key={x.tx_hash} className="flex items-center justify-between gap-2">
                  <TxLink hash={x.tx_hash} block={x.block_number} />
                  <span className="text-2xs text-muted">{dateTime(x.timestamp)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {result && (
          <Callout tone={result.found ? "success" : "danger"} title={result.found ? `Re-read from the node at block #${result.verified_at_block}` : "Not found on chain"}>
            {result.found ? `${result.status} · block ${result.block_number} · ${result.events.length} event(s)` : "The transaction could not be found on the connected node."}
          </Callout>
        )}
        {edge.evidence_level === "unverified_lead" && <Callout tone="warning">This is an unverified lead: a statement or heuristic without supporting evidence. It must not be treated as a fact.</Callout>}
        {edge.type === "transfer" && <Callout tone="info">A transfer shows value moved. It does not show common ownership, control or misconduct.</Callout>}
        <div className="flex flex-wrap gap-1.5">
          {txs[0] && <Button size="sm" variant="dark" icon={<Link2 className="h-3.5 w-3.5" />} loading={verify.isPending} onClick={() => verify.mutate(txs[0].tx_hash)}>Verify on-chain</Button>}
          <Button size="sm" icon={<Flag className="h-3.5 w-3.5" />} loading={mark.isPending} onClick={() => mark.mutate(undefined)}>Mark for review</Button>
        </div>
        <p className="text-2xs text-muted">To dispute a finding built on this edge, open the proposal's Findings tab and add counter-evidence.</p>
      </div>
    </Panel>
  );
}

function AnnotationModal({ open, onClose, nodes }: { open: boolean; onClose: () => void; nodes: GraphNode[] }) {
  const wallets = nodes.filter((n) => n.address && ["wallet", "delegate", "treasury"].includes(n.type));
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [relation, setRelation] = useState("");
  const [note, setNote] = useState("");
  const save = useAction(() => api.post("/graph/annotations", { source_address: a, target_address: b, relation, note }), {
    success: "Annotation added as an unverified lead",
    onSuccess: () => { onClose(); setRelation(""); setNote(""); },
  });
  return (
    <Modal open={open} onClose={onClose} title="Add a manual annotation" subtitle="Annotations are always displayed as unverified leads, never as observations."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!a || !b || a === b || relation.trim().length < 2} loading={save.isPending} onClick={() => save.mutate(undefined)}>Add annotation</Button></>}>
      <div className="space-y-3">
        <Field label="From">
          <select className="input" value={a} onChange={(e) => setA(e.target.value)}>
            <option value="">Choose…</option>
            {wallets.map((w) => <option key={w.id} value={w.address!}>{w.label}</option>)}
          </select>
        </Field>
        <Field label="To">
          <select className="input" value={b} onChange={(e) => setB(e.target.value)}>
            <option value="">Choose…</option>
            {wallets.map((w) => <option key={w.id} value={w.address!}>{w.label}</option>)}
          </select>
        </Field>
        <Field label="Relationship"><input className="input" value={relation} onChange={(e) => setRelation(e.target.value)} placeholder="e.g. claimed shared signer" /></Field>
        <Field label="Note / source"><textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
