import { useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, GitCommitHorizontal, ShieldCheck, XCircle } from "lucide-react";
import { api, type ProposalDetail } from "../../lib/api";
import { dateTime } from "../../lib/format";
import { useAction } from "../../lib/queries";
import { Modal } from "../../components/overlays";
import { Badge, Button, Callout, EmptyState, Field, Hash, StatusBadge, TxLink } from "../../components/ui";

export function CommitButton({ p, size = "md" }: { p: ProposalDetail; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const commit = useAction(() => api.post<any>(`/proposals/${p.id}/versions/commit`, { change_note: note }), {
    success: (r: any) => `v${r.version} committed on-chain (block ${r.block_number})`,
    onSuccess: () => {
      setOpen(false);
      setNote("");
    },
  });
  return (
    <>
      <Button size={size} variant="primary" icon={<GitCommitHorizontal className="h-4 w-4" />} onClick={() => setOpen(true)}>
        Commit reviewed version
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Commit ${p.id} v${p.current_version + 1}`}
        subtitle="Canonicalises the draft, hashes it, and records the hashes on-chain in ProposalRegistry."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={commit.isPending} disabled={!p.disclosure} onClick={() => commit.mutate(undefined)}>
              Sign & commit on-chain
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {!p.disclosure && <Callout tone="danger" title="Disclosure required">Publish a conflict-of-interest disclosure first (Disclosure tab).</Callout>}
          <ul className="space-y-1.5 text-xs text-muted">
            <li>• Content hash: keccak256 of the canonical (dg-canon-1) proposal document.</li>
            <li>• Manifest hash: EIP-712 digest of the executable actions, bound to chain 31337, the ExecutionGuard address and this version.</li>
            <li>• Evidence root: Merkle root over the SHA-256 of {p.evidence.length} attached source(s).</li>
            <li>• The proposer's demo key signs the disclosure + content hash (EIP-712); the registry verifies the signature.</li>
          </ul>
          <Field label="Change note" hint="Shown in the version history and audit ledger.">
            <textarea className="textarea min-h-[70px]" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed since the last version?" />
          </Field>
        </div>
      </Modal>
    </>
  );
}

export function VersionsTab({ p }: { p: ProposalDetail }) {
  const [result, setResult] = useState<any>(null);
  const verify = useAction((v: number) => api.post<any>(`/proposals/${p.id}/versions/${v}/verify`), { quiet: true, onSuccess: setResult, invalidate: [["audit"]] });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">Committed versions are immutable. Editing the draft never changes them; it only prepares the next version.</p>
        <div className="flex gap-2">
          {p.versions.length > 0 && (
            <Link to={`/versions?p=${p.id}`} className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-sm font-medium hover:bg-subtle">
              Compare versions
            </Link>
          )}
          {!["executed", "voting", "approved"].includes(p.status) && <CommitButton p={p} />}
        </div>
      </div>
      {p.versions.length === 0 && <EmptyState title="No committed versions" body="Commit the reviewed draft to create a tamper-evident, on-chain record." />}
      <div className="space-y-3">
        {[...p.versions].reverse().map((v) => (
          <div key={v.version} className="rounded-lg border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-ink px-2 py-0.5 text-xs font-bold text-white dark:bg-fg dark:text-ink">v{v.version}</span>
                <StatusBadge status={v.governance_status === "not_submitted" ? "committed" : v.governance_status} />
                <span className="text-xs text-muted">{dateTime(v.committed_at)} · {v.author}</span>
              </div>
              <Button size="sm" icon={<ShieldCheck className="h-3.5 w-3.5" />} loading={verify.isPending && verify.variables === v.version} onClick={() => verify.mutate(v.version)}>
                Verify integrity
              </Button>
            </div>
            {v.change_note && <p className="mt-2 text-sm">{v.change_note}</p>}
            {v.changed_fields.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {v.changed_fields.slice(0, 12).map((f) => (
                  <Badge key={f} tone={/recipient|amount|target|data|implementation/.test(f) ? "danger" : "neutral"}>{f}</Badge>
                ))}
                {v.changed_fields.length > 12 && <Badge>+{v.changed_fields.length - 12} more</Badge>}
              </div>
            )}
            <div className="mt-3 grid gap-x-6 gap-y-1.5 text-xs md:grid-cols-2">
              <div className="flex items-center justify-between gap-2"><span className="text-muted">Content hash</span><Hash value={v.content_hash} /></div>
              <div className="flex items-center justify-between gap-2"><span className="text-muted">Manifest digest</span><Hash value={v.manifest_hash} /></div>
              <div className="flex items-center justify-between gap-2"><span className="text-muted">Evidence root</span><Hash value={v.evidence_root} /></div>
              <div className="flex items-center justify-between gap-2"><span className="text-muted">Disclosure hash</span><Hash value={v.disclosure_hash} /></div>
              <div className="flex items-center justify-between gap-2"><span className="text-muted">Registry commit</span><TxLink hash={v.tx_hash} block={v.block_number} /></div>
              <div className="flex items-center justify-between gap-2"><span className="text-muted">Governor proposal</span><span className="font-mono text-2xs">{v.governor_proposal_id ? `${v.governor_proposal_id.slice(0, 10)}…` : "—"}</span></div>
            </div>
          </div>
        ))}
      </div>
      <Modal open={!!result} onClose={() => setResult(null)} title={`Integrity check · v${result?.version}`} subtitle={result?.note}>
        {result && (
          <div className="space-y-2">
            <Callout tone={result.ok ? "success" : "danger"} title={result.ok ? "All checks passed" : "Mismatch detected"}>
              Hashes were recomputed from the stored snapshot and compared with ProposalRegistry on the local chain.
            </Callout>
            {result.checks.map((c: any) => (
              <div key={c.check} className="flex items-start gap-2 text-sm">
                {c.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-primary" /> : <XCircle className="mt-0.5 h-4 w-4 text-danger" />}
                <div className="min-w-0">
                  <p className="font-medium">{c.check}</p>
                  <p className="break-all font-mono text-2xs text-muted">{c.detail}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
