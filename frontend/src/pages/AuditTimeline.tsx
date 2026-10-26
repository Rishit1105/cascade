import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Anchor, ArrowRight, CheckCircle2, Download, Fingerprint, Link2, ShieldCheck, XCircle } from "lucide-react";
import { api, type AuditEvent } from "../lib/api";
import { useApp } from "../lib/app";
import { cx, dateTime, titleCase } from "../lib/format";
import { useAction, useAnchors, useAuditEvents, useProposals } from "../lib/queries";
import { Modal } from "../components/overlays";
import { Badge, Button, Callout, EmptyState, ErrorState, Hash, LoadingBlock, Panel, Tabs, TxLink, VerificationBadge } from "../components/ui";
import { AnimatedNumber, GrowBar } from "../lib/motion";
import { LedgerGraph } from "../components/LedgerGraph";
import { suggestions } from "../lib/ledger";

const DOT: Record<string, string> = { success: "bg-primary", failure: "bg-danger", warning: "bg-warning", info: "bg-info" };

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
  const current = items.find((e) => e.id === selected) ?? null;

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
        <div className="flex min-w-0 flex-col gap-4">
          {tab === "timeline" && items.length === 0 && !events.isLoading && <EmptyState title="No events match the filters" />}
          {tab === "timeline" && items.length > 0 && <LedgerGraph events={items} selected={selected} onSelect={setSelected} />}
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
          {tab === "timeline" && items.length > 0 && <LedgerAnalytics items={items} onPick={setSelected} selected={current} />}
        </div>

        {/* On wide screens the panel is pinned to the row's height (set by the left column) and its list
            scrolls inside, so the column always ends level with the graph and analytics: no blank tail. */}
        <div className="relative min-w-0 xl:min-h-[640px]">
        <Panel className="xl:absolute xl:inset-0" bodyClassName="flex min-h-0 flex-1 flex-col" title="Event logs & evidence ledger" subtitle="event_hash = sha256(canonical(event) ‖ prev_hash)">
          <div className="mb-3 grid shrink-0 grid-cols-2 gap-2">
            <a className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-line text-sm font-medium hover:bg-subtle" href={`/api/audit/export?format=json${proposal ? `&proposal=${proposal}` : ""}`} download>
              <Download className="h-3.5 w-3.5" /> Export JSON
            </a>
            <a className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-line text-sm font-medium hover:bg-subtle" href={`/api/audit/export?format=csv${proposal ? `&proposal=${proposal}` : ""}`} download>
              <Download className="h-3.5 w-3.5" /> Export CSV
            </a>
            <Button variant="dark" data-tour="verify-ledger" icon={<ShieldCheck className="h-3.5 w-3.5" />} loading={verify.isPending} onClick={() => verify.mutate(undefined)}>Verify on-chain</Button>
            <Button icon={<Anchor className="h-3.5 w-3.5" />} loading={anchor.isPending} onClick={() => anchor.mutate(undefined)}>Anchor head</Button>
          </div>
          <div className="max-h-[540px] min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 scroll-thin xl:max-h-none">
            {items.map((e) => (
              <button key={e.id} onClick={() => setSelected(e.id)} className={cx("block w-full min-w-0 cursor-pointer rounded-lg border p-2.5 text-left transition-colors", e.id === selected ? "border-fg" : "border-line hover:bg-subtle")}>
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 truncate text-xs font-semibold"><span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", DOT[e.status])} />{titleCase(e.event_type)}</span>
                  <span className="shrink-0 font-mono text-2xs text-faint">#{e.seq}</span>
                </div>
                <p className="mt-1 truncate font-mono text-[10.5px] text-muted" title={e.event_hash}>{e.event_hash}</p>
                {e.tx_hash && <p className="mt-0.5 truncate font-mono text-[10.5px] text-primary" title={e.tx_hash}>tx {e.tx_hash} · #{e.block_number}</p>}
              </button>
            ))}
          </div>
          <div className="mt-3 shrink-0 border-t border-line pt-3">
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

/** Ledger at a glance, computed from the events already loaded; the inspector shows the chosen (or newest) event. */
function LedgerAnalytics({ items, selected, onPick }: { items: AuditEvent[]; selected: AuditEvent | null; onPick: (id: string) => void }) {
  const stats = useMemo(() => {
    const chain = items.filter((e) => e.verification === "chain-confirmed").length;
    const byStatus = { success: 0, warning: 0, failure: 0, info: 0 } as Record<string, number>;
    const byType = new Map<string, number>();
    const byDay = new Map<string, { chain: number; off: number }>();
    for (const e of items) {
      byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
      byType.set(e.event_type, (byType.get(e.event_type) ?? 0) + 1);
      const day = e.occurred_at.slice(5, 10);
      const d = byDay.get(day) ?? { chain: 0, off: 0 };
      if (e.verification === "chain-confirmed") d.chain += 1;
      else d.off += 1;
      byDay.set(day, d);
    }
    const types = [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-14);
    return { chain, byStatus, types, days, actors: new Set(items.map((e) => e.actor)).size };
  }, [items]);
  const focus = selected ?? items[0];
  const maxDay = Math.max(1, ...stats.days.map(([, d]) => d.chain + d.off));
  const maxType = Math.max(1, ...stats.types.map(([, n]) => n));
  const tiles: Array<[string, string, string]> = [
    ["Events", String(items.length), "text-fg"],
    ["Chain-confirmed", `${Math.round((stats.chain / items.length) * 100)}%`, "text-primary"],
    ["Failures & warnings", String(stats.byStatus.failure + stats.byStatus.warning), "text-danger"],
    ["Distinct actors", String(stats.actors), "text-info"],
  ];
  return (
    <div className="grid flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <Panel title="Ledger at a glance" subtitle="Computed from the events matching the current filters">
        <div className="grid grid-cols-2 gap-2">
          {tiles.map(([k, v, c]) => (
            <div key={k} className="rounded-lg border border-line bg-subtle/40 px-3 py-2.5">
              <p className="text-2xs font-medium text-muted">{k}</p>
              <p className={cx("mt-0.5 text-[22px] font-semibold leading-tight tracking-[-0.02em]", c)}><AnimatedNumber value={v} /></p>
            </div>
          ))}
        </div>
        <p className="label mb-1.5 mt-4">Activity by day</p>
        <div className="flex h-[72px] items-end gap-1" aria-label="Events per day">
          {stats.days.map(([day, d]) => (
            <div key={day} className="flex flex-1 flex-col justify-end gap-[2px]" title={`${day}: ${d.chain} chain-confirmed, ${d.off} off-chain`}>
              <div className="rounded-t-sm bg-info/45" style={{ height: `${(d.off / maxDay) * 64}px` }} />
              <div className="rounded-b-sm bg-primary" style={{ height: `${(d.chain / maxDay) * 64}px` }} />
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-faint"><span>{stats.days[0]?.[0]}</span><span>{stats.days[stats.days.length - 1]?.[0]}</span></div>
        <p className="label mb-1.5 mt-4">Most frequent events</p>
        <ul className="space-y-1.5">
          {stats.types.map(([type, n]) => (
            <li key={type} className="text-xs">
              <div className="flex justify-between"><span className="truncate text-fg">{titleCase(type)}</span><span className="font-mono text-muted">{n}</span></div>
              <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-subtle"><GrowBar pct={(n / maxType) * 100} className="h-full rounded-full bg-primary/70" /></div>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title={selected ? "Event inspector" : "Newest event"} subtitle={selected ? "Selected on the timeline" : "Click any node on the timeline to inspect it"}>
        {focus && <EventDetail e={focus} />}
        {focus && <ChainNeighbours e={focus} items={items} onPick={onPick} />}
        {focus && <RelatedEvents e={focus} items={items} onPick={onPick} />}
      </Panel>
    </div>
  );
}

/** The selected event between its neighbours, with the hash links that bind them checked in place. */
function ChainNeighbours({ e, items, onPick }: { e: AuditEvent; items: AuditEvent[]; onPick: (id: string) => void }) {
  const bySeq = new Map(items.map((x) => [x.seq, x]));
  const prev = bySeq.get(e.seq - 1);
  const next = bySeq.get(e.seq + 1);
  const cell = (x: AuditEvent | undefined, label: string, here = false) =>
    x ? (
      <button onClick={() => !here && onPick(x.id)} disabled={here} className={cx("min-w-0 flex-1 rounded-lg border p-2 text-left transition-colors", here ? "border-primary/50 bg-primary/[0.06]" : "cursor-pointer border-line hover:bg-subtle")}>
        <span className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-faint">{label} · #{x.seq}</span>
        <span className="mt-0.5 block truncate text-[11.5px] font-semibold">{titleCase(x.event_type)}</span>
        <span className="block truncate font-mono text-[10px] text-muted" title={x.event_hash}>…{x.event_hash.slice(-10)}</span>
      </button>
    ) : (
      <span className="flex min-w-0 flex-1 items-center justify-center rounded-lg border border-dashed border-line p-2 text-center text-[10.5px] text-faint">{label === "Next" ? "Ledger head" : "Hidden by filters or genesis"}</span>
    );
  const link = (ok: boolean | null) => (
    <span className={cx("flex shrink-0 flex-col items-center text-[9px] font-semibold", ok ? "text-primary" : ok === false ? "text-danger" : "text-faint")} title={ok ? "prev_hash matches the event before it" : ok === false ? "prev_hash does not match" : "neighbour not loaded"}>
      <Link2 className="h-3.5 w-3.5" />
      {ok ? "✓" : ok === false ? "✗" : "·"}
    </span>
  );
  return (
    <div className="mt-4">
      <p className="label mb-1.5">Hash-chain neighbourhood</p>
      <div className="flex items-center gap-1.5">
        {cell(prev, "Previous")}
        {link(prev ? e.prev_hash === prev.event_hash : null)}
        {cell(e, "This event", true)}
        {link(next ? next.prev_hash === e.event_hash : null)}
        {cell(next, "Next")}
      </div>
      <p className="mt-1.5 text-[10.5px] text-faint">Each event stores the hash of the one before it, so changing any event breaks the ✓ on both sides.</p>
    </div>
  );
}

/** Events that share a transaction, manifest or record id with the selected one. */
function RelatedEvents({ e, items, onPick }: { e: AuditEvent; items: AuditEvent[]; onPick: (id: string) => void }) {
  const strong = suggestions(e, items, 4);
  // Nothing shares an id: fall back to the nearest events in the same lane, so the panel stays useful.
  const lane = items
    .filter((x) => x.id !== e.id && x.proposal_id === e.proposal_id)
    .sort((a, b) => Math.abs(a.seq - e.seq) - Math.abs(b.seq - e.seq))
    .slice(0, 3)
    .map((x) => ({ event: x, traits: [{ kind: "proposal" as const, label: e.proposal_id ? `Same proposal ${e.proposal_id}` : "Also a system event", value: "" }], score: 0 }));
  const related = strong.length ? strong : lane;
  return (
    <div className="mt-4">
      <p className="label mb-1.5">{strong.length ? `Related events · ${strong.length}` : "Nearest in the same lane"}</p>
      {related.length === 0 && <p className="text-xs text-muted">No other event shares a transaction, manifest or record id with this one.</p>}
      <ul className="space-y-1.5">
        {related.map((s) => (
          <li key={s.event.id}>
            <button onClick={() => onPick(s.event.id)} className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-left transition-colors hover:bg-subtle">
              <span className={cx("h-2 w-2 shrink-0 rounded-full", DOT[s.event.status])} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">#{s.event.seq} {titleCase(s.event.event_type)}</span>
                <span className="block truncate text-[10.5px] text-muted">{s.traits.slice(0, 2).map((t) => t.label).join(" · ")}</span>
              </span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-faint" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
