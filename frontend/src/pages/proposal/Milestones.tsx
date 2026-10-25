import { useState } from "react";
import { Flag } from "lucide-react";
import { api, type ProposalDetail } from "../../lib/api";
import { dateTime, usdc } from "../../lib/format";
import { useAction } from "../../lib/queries";
import { Modal } from "../../components/overlays";
import { Badge, Button, Callout, EmptyState, Field, StatusBadge } from "../../components/ui";

export function MilestonesTab({ p }: { p: ProposalDetail }) {
  const [edit, setEdit] = useState<number | null>(null);
  const [status, setStatus] = useState("completed");
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState("");
  const update = useAction(() => api.patch(`/proposals/${p.id}/milestones/${edit}`, { status, note, evidence: evidence || null }), {
    success: "Milestone updated",
    onSuccess: () => setEdit(null),
  });
  if (p.milestones.length === 0) return <EmptyState icon={<Flag className="h-5 w-5" />} title="No milestones" body="This proposal defines no delivery milestones. That is flagged as missing information for payouts." />;
  return (
    <div className="space-y-3">
      {p.status !== "executed" ? (
        <Callout tone="info">Delivery is tracked after execution. Until then milestones are commitments in the proposal text.</Callout>
      ) : (
        <Callout tone="warning">Delivery claims are unverified unless backed by evidence. A transaction hash is checked against the chain; anything else is recorded as unverified evidence.</Callout>
      )}
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="table-base">
          <thead>
            <tr>
              <th>Milestone</th>
              <th>Due</th>
              <th>Tranche</th>
              <th>Status</th>
              <th>Verification</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {p.milestones.map((m, i) => (
              <tr key={i}>
                <td>
                  <p className="font-medium">{m.title}</p>
                  {m.deliverable && <p className="text-2xs text-muted">{m.deliverable}</p>}
                  {m.tracking?.note && <p className="mt-0.5 text-2xs text-muted">“{m.tracking.note}”</p>}
                </td>
                <td className="text-xs">{m.month !== undefined ? `Month ${m.month}` : "—"}</td>
                <td className="text-xs">{m.amount_base ? usdc(m.amount_base) : "—"}</td>
                <td><StatusBadge status={m.tracking?.status ?? "pending"} /></td>
                <td className="text-xs">
                  <Badge tone={m.tracking?.verification === "chain-verified transaction" ? "success" : "neutral"}>{m.tracking?.verification ?? "not tracked"}</Badge>
                  {m.tracking?.updated_at && <p className="mt-0.5 text-2xs text-muted">{dateTime(m.tracking.updated_at)} · {m.tracking.updated_by}</p>}
                </td>
                <td>
                  <Button size="sm" disabled={p.status !== "executed"} onClick={() => { setEdit(i); setStatus(m.tracking?.status === "completed" ? "disputed" : "completed"); setNote(""); setEvidence(""); }}>
                    Update
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal
        open={edit !== null}
        onClose={() => setEdit(null)}
        title="Update milestone"
        subtitle={edit !== null ? p.milestones[edit]?.title : ""}
        footer={
          <>
            <Button onClick={() => setEdit(null)}>Cancel</Button>
            <Button variant="primary" loading={update.isPending} onClick={() => update.mutate(undefined)}>Save</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Status">
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              {["pending", "completed", "overdue", "disputed"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Note">
            <textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Field label="Evidence" hint="Transaction hash (verified against the chain) or a document / URL reference (unverified).">
            <input className="input font-mono" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
