/* Global inspector drawers: local-chain transaction explorer, address detail, evidence viewer. */
import { useQuery } from "@tanstack/react-query";
import { FileText, Link2, ShieldCheck } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { dateTime, titleCase } from "../lib/format";
import { Drawer } from "./overlays";
import { AddressChip, Badge, Callout, ErrorState, EvidenceLevelBadge, Hash, KeyValue, LoadingBlock, TxLink, VerificationBadge } from "./ui";

export function Inspectors() {
  const { inspector, inspect } = useApp();
  const close = () => inspect(null);
  if (!inspector) return null;
  if (inspector.kind === "tx") return <TxDrawer hash={inspector.value} onClose={close} />;
  if (inspector.kind === "address") return <AddressDrawer address={inspector.value} onClose={close} />;
  return <EvidenceDrawer proposalId={inspector.proposalId} docId={inspector.docId} quote={inspector.quote} page={inspector.page} onClose={close} />;
}

function TxDrawer({ hash, onClose }: { hash: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["tx", hash], queryFn: () => api.get<any>(`/chain/tx/${hash}`) });
  const d = q.data;
  return (
    <Drawer open onClose={onClose} title="Transaction" subtitle={<Hash value={hash} head={14} tail={10} />} width="sm:w-[520px]">
      {q.isLoading && <LoadingBlock rows={6} />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {d && !d.found && <Callout tone="warning" title="Not found">This transaction is not on the connected local chain.</Callout>}
      {d && d.found && (
        <div className="space-y-4">
          <KeyValue
            rows={[
              ["Status", <Badge key="s" tone={d.status === "success" ? "success" : "danger"}>{d.status === "success" ? "Success" : "Reverted"}</Badge>],
              ["Block", `#${d.block_number}`],
              ["Timestamp", dateTime(d.timestamp)],
              ["From", <AddressChip key="f" address={d.from} label={d.from_label} />],
              ["To", <AddressChip key="t" address={d.to} label={d.to_label} />],
              ["Function", <span key="fn" className="font-mono text-xs">{d.decoded_input?.signature ?? d.decoded_input?.selector ?? "—"}</span>],
            ]}
          />
          {d.decoded_input?.args?.length > 0 && (
            <div>
              <p className="label mb-1.5">Decoded arguments</p>
              <div className="space-y-1 rounded-lg border border-line bg-subtle/50 p-2.5">
                {d.decoded_input.args.map((a: any) => (
                  <div key={a.name} className="flex items-start justify-between gap-3 text-xs">
                    <span className="text-muted">
                      {a.name} <span className="text-faint">({a.type})</span>
                    </span>
                    <span className="break-all text-right font-mono">{typeof a.value === "object" ? JSON.stringify(a.value) : String(a.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div>
            <p className="label mb-1.5">Events emitted ({d.events.length})</p>
            <div className="space-y-1.5">
              {d.events.length === 0 && <p className="text-xs text-muted">No events (a reverted transaction emits none).</p>}
              {d.events.map((e: any, i: number) => (
                <div key={i} className="rounded-lg border border-line p-2.5">
                  <p className="text-xs font-semibold">{e.event ?? "Unknown event"}</p>
                  <div className="mt-1 space-y-0.5">
                    {Object.entries(e.args ?? {}).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3 text-2xs">
                        <span className="text-muted">{k}</span>
                        <span className="break-all text-right font-mono">{String(v)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {d.audit_events?.length > 0 && (
            <div>
              <p className="label mb-1.5">Audit ledger entries</p>
              {d.audit_events.map((e: any) => (
                <div key={e.id} className="mb-1.5 rounded-lg border border-line p-2.5 text-xs">
                  <p className="font-medium">{e.summary}</p>
                  <p className="mt-1 text-2xs text-muted">
                    {e.event_type} · seq {e.seq} · <Hash value={e.event_hash} />
                  </p>
                </div>
              ))}
            </div>
          )}
          <Callout tone="info" icon={<ShieldCheck className="h-4 w-4" />}>
            {d.explorer_note} Verified at block {d.verified_at_block}.
          </Callout>
        </div>
      )}
    </Drawer>
  );
}

function AddressDrawer({ address, onClose }: { address: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["address", address], queryFn: () => api.get<any>(`/chain/address/${address}`) });
  const d = q.data;
  return (
    <Drawer open onClose={onClose} title={d?.label ?? "Address"} subtitle={<Hash value={address} head={12} tail={8} />}>
      {q.isLoading && <LoadingBlock rows={6} />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {d && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {d.kind && <Badge>{titleCase(d.kind)}</Badge>}
            {d.role && <Badge tone="info">{d.role}</Badge>}
            <Badge tone={d.is_contract ? "dark" : "neutral"}>{d.is_contract ? `Contract · ${d.code_size} bytes` : "Externally owned account"}</Badge>
          </div>
          <KeyValue
            rows={[
              ["mUSDC balance", d.balances.mUSDC],
              ["ATLAS balance", d.balances.ATLAS],
              ["Voting power", `${d.voting_power} ATLAS`],
              ["ETH (gas)", d.balances.ETH],
            ]}
          />
          <div>
            <p className="label mb-1.5">Relationships ({d.relationships.length})</p>
            <div className="space-y-1.5">
              {d.relationships.slice(0, 30).map((e: any) => (
                <div key={e.id} className="rounded-lg border border-line p-2.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{titleCase(e.type)}</span>
                    <EvidenceLevelBadge level={e.evidence_level} />
                  </div>
                  <p className="mt-1 text-muted">{e.label}</p>
                  {e.provenance?.tx_hash && (
                    <div className="mt-1">
                      <TxLink hash={e.provenance.tx_hash} block={e.provenance.block_number} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          <Callout tone="warning">{d.note}</Callout>
        </div>
      )}
    </Drawer>
  );
}

function highlight(text: string, quote?: string) {
  if (!quote) return text;
  const idx = text.toLowerCase().indexOf(quote.toLowerCase().slice(0, 60));
  if (idx < 0) return text;
  const end = Math.min(text.length, idx + quote.length);
  return (
    <>
      {text.slice(0, idx)}
      <mark className="mark-intent" id="evidence-hit">
        {text.slice(idx, end)}
      </mark>
      {text.slice(end)}
    </>
  );
}

function EvidenceDrawer({ proposalId, docId, quote, page, onClose }: { proposalId: string; docId: string; quote?: string; page?: number; onClose: () => void }) {
  const isProposalText = docId.startsWith("proposal:");
  const q = useQuery({
    queryKey: ["evidence", proposalId, docId],
    queryFn: () => (isProposalText ? api.get<any>(`/proposals/${proposalId}`).then((p) => ({ name: `${p.id} proposal text`, source_type: "proposal", pages: [{ page: 1, section: "Proposal", text: p.body }], content_hash: null, verification_status: "proposal record", injection_flags: [] })) : api.get<any>(`/proposals/${proposalId}/evidence/${docId}`)),
  });
  const proof = useQuery({ queryKey: ["proof", proposalId, docId], queryFn: () => api.get<any>(`/proposals/${proposalId}/evidence/${docId}/proof`), enabled: !isProposalText, retry: false });
  const d = q.data;
  return (
    <Drawer open onClose={onClose} title={d?.name ?? "Evidence"} subtitle={d ? `${titleCase(d.source_type)} · ${d.pages?.length ?? 0} page(s)` : undefined} width="sm:w-[560px]">
      {q.isLoading && <LoadingBlock rows={8} />}
      {q.error && <ErrorState error={q.error} />}
      {d && (
        <div className="space-y-4">
          {d.content_hash && (
            <div className="rounded-lg border border-line bg-subtle/50 p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted">Content hash</span>
                <Hash value={d.content_hash} head={16} tail={8} />
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-muted">Verification</span>
                <VerificationBadge value={d.verification_status === "chain-verified" ? "chain-confirmed" : "off-chain"} />
              </div>
              {proof.data && (
                <div className="mt-1.5 flex items-start justify-between gap-2">
                  <span className="text-muted">On-chain evidence root</span>
                  <span className="text-right">
                    {proof.data.included ? (
                      <Badge tone={proof.data.verified ? "success" : "danger"} icon={<Link2 className="h-3 w-3" />}>
                        {proof.data.verified ? `Merkle proof valid for v${proof.data.version}` : "Proof INVALID"}
                      </Badge>
                    ) : (
                      <span className="text-2xs text-muted">{proof.data.note}</span>
                    )}
                  </span>
                </div>
              )}
            </div>
          )}
          {d.injection_flags?.length > 0 && (
            <Callout tone="warning" title="Instruction-like text detected">
              This document contains text aimed at automated reviewers. It was treated as data and did not change any rule or finding.
            </Callout>
          )}
          {(d.pages ?? []).map((p: any) => (
            <div key={p.page} className={page === p.page ? "rounded-lg ring-2 ring-warning/30" : ""}>
              <p className="label mb-1 flex items-center gap-1.5">
                <FileText className="h-3 w-3" />
                {d.source_type === "pdf" ? `Page ${p.page}` : p.section ?? `Section ${p.page}`}
              </p>
              <pre className="whitespace-pre-wrap rounded-lg border border-line bg-surface p-3 font-sans text-sm leading-relaxed text-fg">{highlight(p.text, quote)}</pre>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}
