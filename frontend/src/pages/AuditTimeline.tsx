import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Anchor, CheckCircle2, Download, Fingerprint, Link2, ShieldCheck, XCircle } from "lucide-react";
import { api, type AuditEvent } from "../lib/api";
import { useApp } from "../lib/app";
import { cx, dateTime, timeAgo, titleCase } from "../lib/format";
import { useAction, useAnchors, useAuditEvents, useProposals } from "../lib/queries";
import { Modal } from "../components/overlays";
import { Badge, Button, Callout, EmptyState, ErrorState, Hash, LoadingBlock, Panel, Tabs, TxLink, VerificationBadge } from "../components/ui";

const DOT: Record<string, string> = { success: "bg-primary", failure: "bg-danger", warning: "bg-warning", info: "bg-info" };
const RING: Record<string, string> = { success: "border-primary", failure: "border-danger", warning: "border-warning", info: "border-info" };

export default function AuditTimeline() {
  const [params, setParams] = useSearchParams();
  const { inspect } = useApp();
  const [proposal, setProposal] = useState(params.get("proposal") ?? params.get("p") ?? "");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [verification, setVerification] = useState("");
  const [tab, setTab] = useState<"timeline" | "ledger">("timeline");
  const [selected, setSelected] = useState<string | null>(params.get("event"));
  const [verifyResult, setVerifyResult] = useState<any>(null);
  const list = useProposals();
  const events = useAuditEvents({ proposal: proposal || undefined, type: type || undefined, status: status || undefined, verification: verification || undefined, limit: 400 });
  const anchors = useAnchors();
  const verify = useAction(() => api.post<any>("/audit/verify"), { quiet: true, onSuccess: setVerifyResult, invalidate: [["audit"]] });
  const anchor = useAction(() => api.post<any>("/audit/anchor"), { success: (r: any) => `Ledger head #${r.seq_upto} anchored in block ${r.block_number}`, invalidate: [["audit"], ["anchors"]] });

  useEffect(() => {
    const tx = params.get("tx");
    if (tx) {
      inspect({ kind: "tx", value: tx });
      const n = new URLSearchParams(params);
      n.delete("tx");
      setParams(n, { replace: true });
    }
  }, [params, inspect, setParams]);

  const items = events.data?.items ?? [];
  const chrono = useMemo(() => [...items].reverse(), [items]);
  const current = items.find((e) => e.id === selected) ?? null;
  const trackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (trackRef.current && !selected) trackRef.current.scrollLeft = trackRef.current.scrollWidth;
  }, [chrono.length, selected]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Audit trail timeline</h1>
          <p className="mt-0.5 text-sm text-muted">Append-only, hash-chained ledger. Off-chain records are labelled; chain-confirmed events link to receipts.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select className="input h-9 w-auto" value={proposal} onChange={(e) => setProposal(e.target.value)} aria-label="Proposal filter">
            <option value="">All proposals</option>
            {(list.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
          </select>
          <select className="input h-9 w-auto" value={type} onChange={(e) => setType(e.target.value)} aria-label="Event type filter">
            <option value="">All event types</option>
            {(events.data?.event_types ?? []).map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
          </select>
          <select className="input h-9 w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
            <option value="">Any status</option>
            {["success", "failure", "warning", "info"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="input h-9 w-auto" value={verification} onChange={(e) => setVerification(e.target.value)} aria-label="Verification filter">
            <option value="">Any verification</option>
            <option value="chain-confirmed">Chain-confirmed</option>
            <option value="off-chain">Off-chain</option>
          </select>
        </div>
      </div>
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ id: "timeline", label: "Historical timeline" }, { id: "ledger", label: "Ledger", count: items.length }]} />
      {events.error && <ErrorState error={events.error} retry={() => events.refetch()} />}
      {events.isLoading && <LoadingBlock rows={8} />}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0">
          {tab === "timeline" && (
            <Panel title="Audit trail timeline" subtitle={`${items.length} event(s) · oldest on the left · click a node to drill in`} bodyClassName="px-0">
              {items.length === 0 && !events.isLoading && <EmptyState title="No events match the filters" />}
              <div ref={trackRef} className="overflow-x-auto px-4 pb-4 scroll-thin">
                <div className="relative flex min-h-[230px] items-center gap-0 py-6" style={{ width: Math.max(chrono.length * 132, 600) }}>
                  <div className="absolute left-0 right-0 top-1/2 h-[2px] -translate-y-1/2 bg-line-strong" />
                  {chrono.map((e, i) => {
                    const up = i % 2 === 0;
                    const active = e.id === selected;
                    return (
                      <div key={e.id} className="relative flex w-[132px] shrink-0 justify-center">
                        <button
                          onClick={() => setSelected(active ? null : e.id)}
                          className={cx("absolute w-[124px] rounded-lg border bg-surface p-2 text-left shadow-card transition-colors", up ? "bottom-[18px]" : "top-[18px]", active ? "border-fg ring-1 ring-fg/20" : "border-line hover:border-line-strong", e.status === "failure" && !active && "border-danger/40")}
                        >
                          <p className={cx("line-clamp-2 text-[11px] font-semibold leading-tight", e.status === "failure" ? "text-danger" : "text-fg")}>{titleCase(e.event_type)}</p>
                          <p className="mt-0.5 truncate text-[10px] text-muted">{e.proposal_id ?? "system"}{e.tx_hash ? ` · #${e.block_number}` : ""}</p>
                          <p className="truncate text-[10px] text-faint">{timeAgo(e.occurred_at)}</p>
                        </button>
                        <span className={cx("relative z-10 h-3.5 w-3.5 rounded-full border-[3px] bg-surface", RING[e.status], active && "scale-125")} />
                        {e.verification === "chain-confirmed" && <Link2 className="absolute top-1/2 ml-6 h-3 w-3 -translate-y-1/2 text-primary" />}
                      </div>
                    );
                  })}
                </div>
              </div>
              {current && (
                <div className="mx-4 rounded-xl border border-line bg-subtle/40 p-4 animate-fade-in">
                  <EventDetail e={current} />
                </div>
              )}
            </Panel>
          )}
          {tab === "ledger" && (
            <Panel title="Ledger" bodyClassName="px-0">
              <div className="max-h-[720px] overflow-auto scroll-thin">
                <table className="table-base">
                  <thead><tr><th>#</th><th>When</th><th>Event</th><th>Actor / source</th><th>Verification</th><th>Event hash</th><th>Tx</th></tr></thead>
                  <tbody>
                    {items.map((e) => (
                      <tr key={e.id} className={cx("cursor-pointer hover:bg-subtle/60", e.id === selected && "bg-subtle")} onClick={() => setSelected(e.id)}>
                        <td className="font-mono text-2xs text-muted">{e.seq}</td>
                        <td className="whitespace-nowrap text-2xs text-muted">{dateTime(e.occurred_at)}</td>
                        <td className="max-w-[380px]"><span className={cx("mr-1.5 inline-block h-2 w-2 rounded-full", DOT[e.status])} /><span className="text-xs">{e.summary}</span></td>
                        <td className="text-2xs">{e.actor}<span className="block text-faint">{e.source}</span></td>
                        <td><VerificationBadge value={e.verification} /></td>
                        <td onClick={(ev) => ev.stopPropagation()}><Hash value={e.event_hash} head={8} tail={4} /></td>
                        <td onClick={(ev) => ev.stopPropagation()}><TxLink hash={e.tx_hash} block={e.block_number} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {current && <div className="m-4 rounded-xl border border-line bg-subtle/40 p-4"><EventDetail e={current} /></div>}
            </Panel>
          )}
        </div>

        <Panel title="Event logs & evidence ledger" subtitle="event_hash = sha256(canonical(event) ‖ prev_hash)">
          <div className="mb-3 grid grid-cols-2 gap-2">
            <a className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-line text-sm font-medium hover:bg-subtle" href={`/api/audit/export?format=json${proposal ? `&proposal=${proposal}` : ""}`} download>
              <Download className="h-3.5 w-3.5" /> Export JSON
            </a>
            <a className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-line text-sm font-medium hover:bg-subtle" href={`/api/audit/export?format=csv${proposal ? `&proposal=${proposal}` : ""}`} download>
              <Download className="h-3.5 w-3.5" /> Export CSV
            </a>
            <Button variant="dark" icon={<ShieldCheck className="h-3.5 w-3.5" />} loading={verify.isPending} onClick={() => verify.mutate(undefined)}>Verify on-chain</Button>
            <Button icon={<Anchor className="h-3.5 w-3.5" />} loading={anchor.isPending} onClick={() => anchor.mutate(undefined)}>Anchor head</Button>
          </div>
          <div className="max-h-[540px] space-y-2 overflow-y-auto pr-1 scroll-thin">
            {items.slice(0, 40).map((e) => (
              <button key={e.id} onClick={() => setSelected(e.id)} className={cx("block w-full rounded-lg border p-2.5 text-left", e.id === selected ? "border-fg" : "border-line hover:bg-subtle")}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-semibold">{titleCase(e.event_type)}</span>
                  <span className="font-mono text-2xs text-faint">#{e.seq}</span>
                </div>
                <p className="mt-1 break-all font-mono text-[10.5px] text-muted">{e.event_hash.slice(0, 44)}…</p>
                {e.tx_hash && <p className="mt-0.5 break-all font-mono text-[10.5px] text-primary">tx {e.tx_hash.slice(0, 30)}… #{e.block_number}</p>}
              </button>
            ))}
          </div>
          <div className="mt-3 border-t border-line pt-3">
            <p className="label mb-1.5">On-chain anchors</p>
            {(anchors.data ?? []).slice(0, 4).map((a) => (
              <div key={a.tx_hash} className="flex items-center justify-between text-xs">
                <span>up to #{a.seq_upto}</span>
                <TxLink hash={a.tx_hash} block={a.block_number} />
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Modal open={!!verifyResult} onClose={() => setVerifyResult(null)} title="Ledger verification" subtitle={verifyResult?.note}>
        {verifyResult && (
          <div className="space-y-3 text-sm">
            <Callout tone={verifyResult.ok ? "success" : "danger"} title={verifyResult.ok ? "Ledger intact" : "Integrity problem found"}>
              {verifyResult.event_count} events re-hashed in order. Head {verifyResult.head.slice(0, 22)}…
            </Callout>
            <Row ok={verifyResult.breaks.length === 0} label={`Hash chain: ${verifyResult.breaks.length} broken link(s)`} />
            <Row ok={verifyResult.chain_receipts.mismatched.length === 0} label={`Chain receipts: ${verifyResult.chain_receipts.confirmed}/${verifyResult.chain_receipts.checked} transactions re-confirmed on the node`} />
            {verifyResult.anchors.map((a: any) => (
              <Row key={a.tx_hash} ok={a.found_on_chain && a.matches_recomputed_ledger} label={`Anchor up to #${a.seq_upto}: ${a.found_on_chain ? "found in ProposalRegistry" : "missing on-chain"}, ${a.matches_recomputed_ledger ? "matches recomputed head" : "does NOT match"}`} />
            ))}
            {verifyResult.breaks.map((b: any) => <p key={b.seq} className="text-xs text-danger">#{b.seq}: {b.problem}</p>)}
          </div>
        )}
      </Modal>
    </div>
  );
}

function Row({ ok, label }: { ok: boolean; label: string }) {
  return (
    <p className="flex items-center gap-2 text-xs">
      {ok ? <CheckCircle2 className="h-4 w-4 text-primary" /> : <XCircle className="h-4 w-4 text-danger" />}
      {label}
    </p>
  );
}

function EventDetail({ e }: { e: AuditEvent }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className={cx("text-sm font-semibold", e.status === "failure" && "text-danger")}>{e.summary}</p>
          <p className="mt-0.5 text-xs text-muted">{dateTime(e.occurred_at)} · {e.actor} · source: {e.source}{e.proposal_version ? ` · v${e.proposal_version}` : ""}</p>
        </div>
        <div className="flex gap-1.5">
          <VerificationBadge value={e.verification} />
          <Badge tone={e.status === "failure" ? "danger" : e.status === "success" ? "success" : e.status === "warning" ? "warning" : "info"}>{e.status}</Badge>
        </div>
      </div>
      <div className="grid gap-2 text-xs md:grid-cols-2">
        <div className="rounded-lg border border-line bg-surface p-2.5">
          <p className="label mb-1">On-chain transaction</p>
          {e.tx_hash ? <TxLink hash={e.tx_hash} block={e.block_number} /> : <p className="text-muted">Off-chain record: not blockchain-verified.</p>}
          {e.manifest_hash && <div className="mt-1.5"><p className="text-2xs text-muted">Manifest</p><Hash value={e.manifest_hash} /></div>}
        </div>
        <div className="rounded-lg border border-line bg-surface p-2.5">
          <p className="label mb-1 flex items-center gap-1"><Fingerprint className="h-3 w-3" /> Ledger hashes</p>
          <p className="text-2xs text-muted">event</p><Hash value={e.event_hash} head={14} tail={8} />
          <p className="mt-1 text-2xs text-muted">previous</p><Hash value={e.prev_hash} head={14} tail={8} />
        </div>
      </div>
      {Object.keys(e.details ?? {}).length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs font-medium text-muted">Details</summary>
          <pre className="mt-1.5 max-h-[220px] overflow-auto rounded-lg bg-ink p-3 font-mono text-[11px] text-[#C9D6E2] scroll-thin">{JSON.stringify(e.details, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
