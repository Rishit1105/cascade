import { useEffect, useState } from "react";
import { Fingerprint, Plus, Trash2 } from "lucide-react";
import { api, type ProposalDetail } from "../../lib/api";
import { dateTime } from "../../lib/format";
import { useAction, useConflicts } from "../../lib/queries";
import { Badge, Button, Callout, Field, Hash, SeverityBadge, Toggle } from "../../components/ui";

interface Rel {
  party: string;
  address: string;
  relationship: string;
  details: string;
}

export function DisclosureTab({ p }: { p: ProposalDetail }) {
  const st = p.disclosure?.statement;
  const coi = useConflicts(p.id);
  const [noConflicts, setNoConflicts] = useState<boolean>(st?.no_conflicts ?? false);
  const [rels, setRels] = useState<Rel[]>(st?.relationships?.map((r: any) => ({ party: r.party, address: r.address ?? "", relationship: r.relationship, details: r.details ?? "" })) ?? []);
  const [holdings, setHoldings] = useState(st?.holdings ?? "");
  const [comp, setComp] = useState(st?.compensation ?? "");
  useEffect(() => {
    setNoConflicts(st?.no_conflicts ?? false);
    setRels(st?.relationships?.map((r: any) => ({ party: r.party, address: r.address ?? "", relationship: r.relationship, details: r.details ?? "" })) ?? []);
    setHoldings(st?.holdings ?? "");
    setComp(st?.compensation ?? "");
  }, [p.id, p.disclosure?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useAction(
    () =>
      api.put(`/proposals/${p.id}/disclosure`, {
        no_conflicts: noConflicts,
        relationships: noConflicts ? [] : rels.map((r) => ({ party: r.party, address: r.address || null, relationship: r.relationship, details: r.details })),
        holdings,
        compensation: comp,
      }),
    { success: "Disclosure published. It will be signed with the next committed version." },
  );
  const latest = p.versions[p.versions.length - 1];
  const signedInLatest = latest && p.disclosure && latest.disclosure_hash === p.disclosure.disclosure_hash;
  const undisclosed = (coi.data?.findings ?? []).filter((f: any) => f.rule_id === "COI-R001" || f.rule_id === "COI-R004");
  const valid = noConflicts ? rels.length === 0 : rels.length > 0 && rels.every((r) => r.party.trim() && r.relationship.trim() && (!r.address || /^0x[0-9a-fA-F]{40}$/.test(r.address)));

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-4">
        <Callout tone="info" icon={<Fingerprint className="h-4 w-4" />} title="Verifiable disclosure">
          The proposer's key signs (proposal key, version, content hash, disclosure hash) as EIP-712 typed data when a version is committed. ProposalRegistry
          rejects the commit unless the signature recovers to the proposer, so the disclosure is attributable and cannot be swapped afterwards.
        </Callout>
        <div className="flex items-center justify-between rounded-lg border border-line p-3">
          <div>
            <p className="text-sm font-semibold">I have no relationships to disclose</p>
            <p className="text-xs text-muted">Attest that the proposer has no financial or organisational ties to the recipient or delegates.</p>
          </div>
          <Toggle checked={noConflicts} onChange={(v) => { setNoConflicts(v); if (v) setRels([]); }} label="No conflicts" />
        </div>
        {!noConflicts && (
          <div className="space-y-2">
            {rels.map((r, i) => (
              <div key={i} className="grid gap-2 rounded-lg border border-line p-3 md:grid-cols-2">
                <Field label="Party">
                  <input className="input" value={r.party} onChange={(e) => setRels(rels.map((x, j) => (j === i ? { ...x, party: e.target.value } : x)))} />
                </Field>
                <Field label="Address (optional)" error={r.address && !/^0x[0-9a-fA-F]{40}$/.test(r.address) ? "Must be a 0x address" : undefined}>
                  <input className="input font-mono" value={r.address} onChange={(e) => setRels(rels.map((x, j) => (j === i ? { ...x, address: e.target.value.trim() } : x)))} />
                </Field>
                <Field label="Relationship">
                  <input className="input" value={r.relationship} placeholder="e.g. proposer is a multisig signer" onChange={(e) => setRels(rels.map((x, j) => (j === i ? { ...x, relationship: e.target.value } : x)))} />
                </Field>
                <div className="flex items-end gap-2">
                  <Field label="Details">
                    <input className="input" value={r.details} onChange={(e) => setRels(rels.map((x, j) => (j === i ? { ...x, details: e.target.value } : x)))} />
                  </Field>
                  <Button size="sm" variant="ghost" aria-label="Remove relationship" onClick={() => setRels(rels.filter((_, j) => j !== i))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
            <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setRels([...rels, { party: "", address: "", relationship: "", details: "" }])}>
              Add relationship
            </Button>
          </div>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Token holdings">
            <input className="input" value={holdings} onChange={(e) => setHoldings(e.target.value)} />
          </Field>
          <Field label="Compensation from this proposal">
            <input className="input" value={comp} onChange={(e) => setComp(e.target.value)} />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Publish disclosure
          </Button>
        </div>
      </div>
      <div className="space-y-3">
        <div className="rounded-lg border border-line p-3">
          <p className="label mb-2">Current disclosure</p>
          {p.disclosure ? (
            <div className="space-y-1.5 text-xs">
              <p>
                {p.disclosure.statement.no_conflicts ? <Badge tone="info">Attests no conflicts</Badge> : <Badge tone="info">{p.disclosure.statement.relationships.length} relationship(s) disclosed</Badge>}
              </p>
              <p className="text-muted">Published {dateTime(p.disclosure.created_at)}</p>
              <div className="flex items-center justify-between"><span className="text-muted">Hash</span><Hash value={p.disclosure.disclosure_hash} /></div>
              <div className="flex items-center justify-between">
                <span className="text-muted">Signed in a version</span>
                {signedInLatest ? <Badge tone="success">v{latest.version}</Badge> : <Badge tone="warning">Not yet: commit a version</Badge>}
              </div>
            </div>
          ) : (
            <p className="text-xs text-danger">No disclosure. Committing a version is blocked until one is published.</p>
          )}
        </div>
        <div className="rounded-lg border border-line p-3">
          <p className="label mb-2">Observed vs disclosed</p>
          {undisclosed.length === 0 && <p className="text-xs text-muted">No observed on-chain relationship contradicts the disclosure.</p>}
          {undisclosed.map((f: any) => (
            <div key={f.key ?? f.title} className="mb-2 text-xs">
              <SeverityBadge severity={f.severity} />
              <p className="mt-1 font-medium">{f.title}</p>
            </div>
          ))}
          <p className="mt-1 text-2xs text-muted">Transfers show value moved; they do not show common ownership.</p>
        </div>
      </div>
    </div>
  );
}
