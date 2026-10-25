/* Domain components shared by several pages. */
import { useState } from "react";
import { ChevronDown, ExternalLink, MessageSquareWarning, Quote } from "lucide-react";
import { api, type Citation, type Finding, type ProposalItem } from "../lib/api";
import { useApp } from "../lib/app";
import { cx, dateTime, formatUnits } from "../lib/format";
import { useAction, useProposals } from "../lib/queries";
import { Modal } from "./overlays";
import { Badge, Button, ConfidenceBadge, Field, SeverityBadge, StatusBadge } from "./ui";

export function ProposalPicker({ value, onChange, className }: { value?: string; onChange: (id: string) => void; className?: string }) {
  const list = useProposals();
  return (
    <div className={cx("relative", className)}>
      <select
        aria-label="Select proposal"
        className="input h-9 min-w-[260px] appearance-none pr-8 font-medium"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
      >
        {!value && <option value="">Select a proposal…</option>}
        {(list.data ?? []).map((p: ProposalItem) => (
          <option key={p.id} value={p.id}>
            {p.id} · {p.title.length > 46 ? p.title.slice(0, 44) + "…" : p.title} ({p.status})
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
    </div>
  );
}

export function CitationChip({ proposalId, c }: { proposalId: string; c: Citation }) {
  const { inspect } = useApp();
  return (
    <button
      onClick={() => inspect({ kind: "evidence", proposalId, docId: c.doc_id, quote: c.quote, page: c.page })}
      className="inline-flex max-w-[min(100%,260px)] items-center gap-1 rounded-md border border-info/25 bg-info/5 px-1.5 py-0.5 text-2xs font-medium text-info hover:bg-info/10"
      title={`“${c.quote}”`}
    >
      <Quote className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">
        {c.doc_name}
        {c.section ? ` · ${c.section}` : c.page ? ` · p.${c.page}` : ""}
      </span>
    </button>
  );
}

export function NotEvidenced({ note }: { note?: string | null }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-dashed border-warning/40 px-1.5 py-0.5 text-2xs font-medium text-warning" title={note ?? ""}>
      Not evidenced in supplied material
    </span>
  );
}

export function FindingCard({ f, proposalId, challenges = [] }: { f: Finding; proposalId: string; challenges?: any[] }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<null | "challenge" | "resolve" | "dismiss">(null);
  const [text, setText] = useState("");
  const [evidence, setEvidence] = useState("");
  const { inspect } = useApp();
  const challenge = useAction(
    () => api.post(`/proposals/${proposalId}/challenges`, { finding_id: f.id, statement: text, counter_evidence: evidence ? [{ type: "reference", value: evidence }] : [] }),
    { success: "Challenge filed. The original finding is preserved.", onSuccess: () => setMode(null) },
  );
  const status = useAction(
    (s: string) => api.post(`/proposals/${proposalId}/findings/${f.id}/status`, { status: s, note: text }),
    { success: "Finding status updated", onSuccess: () => setMode(null) },
  );
  const mine = challenges.filter((c) => c.finding_id === f.id);
  return (
    <div className={cx("rounded-lg border bg-surface p-3", f.severity === "critical" || f.severity === "high" ? "border-danger/25" : f.severity === "medium" ? "border-warning/30" : "border-line")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <SeverityBadge severity={f.severity} />
            <ConfidenceBadge confidence={f.confidence} />
            <span className="font-mono text-2xs text-faint">{f.rule_id}</span>
            {f.status !== "open" && <StatusBadge status={f.status} />}
          </div>
          <p className="mt-1.5 text-sm font-semibold text-fg">{f.title}</p>
        </div>
        <button onClick={() => setOpen((o) => !o)} className="shrink-0 text-xs font-medium text-muted hover:text-fg" aria-expanded={open}>
          {open ? "Less" : "Details"}
        </button>
      </div>
      <p className={cx("mt-1 text-xs leading-relaxed text-muted", !open && "line-clamp-2")}>{f.explanation}</p>
      {f.remediation && (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-fg">
          <MessageSquareWarning className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <span>
            <span className="font-medium">Ask:</span> {f.remediation}
          </span>
        </p>
      )}
      {open && (
        <div className="mt-2 space-y-2 border-t border-line pt-2">
          {f.evidence_refs.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {f.evidence_refs.map((r, i) =>
                r.tx_hash ? (
                  <button key={i} onClick={() => inspect({ kind: "tx", value: r.tx_hash })} className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 font-mono text-2xs text-info hover:bg-subtle">
                    tx {String(r.tx_hash).slice(0, 10)}… <ExternalLink className="h-2.5 w-2.5" />
                  </button>
                ) : r.doc_id ? (
                  <CitationChip key={i} proposalId={proposalId} c={r as Citation} />
                ) : (
                  <Badge key={i}>{r.description ?? r.type}</Badge>
                ),
              )}
            </div>
          )}
          <div className="text-2xs text-muted">
            History:{" "}
            {f.status_history.map((h, i) => (
              <span key={i}>
                {i > 0 && " → "}
                {h.status} ({h.by}, {dateTime(h.at)})
              </span>
            ))}
          </div>
          {mine.map((c) => (
            <div key={c.id} className="rounded-md border border-info/25 bg-info/5 p-2 text-xs">
              <p>
                <span className="font-semibold">Challenge by {c.author}:</span> {c.statement}
              </p>
              <p className="mt-0.5 text-2xs text-muted">
                {c.status === "open" ? "Awaiting reviewer response" : `${c.status} by ${c.reviewer}: ${c.response}`}
              </p>
              {c.status === "open" && <ChallengeResponse challengeId={c.id} />}
            </div>
          ))}
          <div className="flex flex-wrap gap-1.5">
            {f.status === "open" && (
              <>
                <Button size="sm" onClick={() => setMode("challenge")}>Challenge with counter-evidence</Button>
                <Button size="sm" variant="ghost" onClick={() => setMode("resolve")}>Mark resolved</Button>
                <Button size="sm" variant="ghost" onClick={() => setMode("dismiss")}>Dismiss</Button>
              </>
            )}
            {(f.status === "resolved" || f.status === "dismissed") && <Button size="sm" variant="ghost" onClick={() => setMode("resolve")}>Reopen</Button>}
          </div>
        </div>
      )}
      <Modal
        open={mode !== null}
        onClose={() => setMode(null)}
        title={mode === "challenge" ? "Challenge this finding" : mode === "dismiss" ? "Dismiss finding" : f.status === "open" ? "Mark finding resolved" : "Reopen finding"}
        subtitle={f.title}
        footer={
          <>
            <Button onClick={() => setMode(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={text.trim().length < (mode === "challenge" ? 10 : 8)}
              loading={challenge.isPending || status.isPending}
              onClick={() => (mode === "challenge" ? challenge.mutate(undefined) : status.mutate(f.status === "open" ? (mode === "dismiss" ? "dismissed" : "resolved") : "open"))}
            >
              {mode === "challenge" ? "File challenge" : "Save"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={mode === "challenge" ? "Counter-statement" : "Justification"} hint="Recorded in the audit ledger; the original finding text is never overwritten.">
            <textarea className="textarea min-h-[90px]" value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          {mode === "challenge" && (
            <Field label="Counter-evidence reference (optional)" hint="A transaction hash, document name or URL.">
              <input className="input" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
            </Field>
          )}
        </div>
      </Modal>
    </div>
  );
}

function ChallengeResponse({ challengeId }: { challengeId: string }) {
  const [text, setText] = useState("");
  const respond = useAction((decision: "upheld" | "rejected") => api.post(`/challenges/${challengeId}/respond`, { decision, response: text }), { success: "Response recorded" });
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <input className="input h-7 flex-1 text-xs" placeholder="Reviewer response (8+ chars)" value={text} onChange={(e) => setText(e.target.value)} />
      <Button size="sm" disabled={text.trim().length < 8} onClick={() => respond.mutate("upheld")}>Uphold</Button>
      <Button size="sm" disabled={text.trim().length < 8} onClick={() => respond.mutate("rejected")}>Reject</Button>
    </div>
  );
}

export function VoteBar({ votes }: { votes?: { for: string; against: string; abstain: string } }) {
  if (!votes) return null;
  const f = BigInt(votes.for), a = BigInt(votes.against), ab = BigInt(votes.abstain);
  const total = f + a + ab;
  const share = (x: bigint) => (total === 0n ? 0 : Number((x * 10000n) / total) / 100);
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-subtle">
        <div className="bg-primary" style={{ width: `${share(f)}%` }} />
        <div className="bg-danger" style={{ width: `${share(a)}%` }} />
        <div className="bg-faint" style={{ width: `${share(ab)}%` }} />
      </div>
      <div className="mt-1.5 flex justify-between text-2xs text-muted">
        <span><span className="font-semibold text-primary">For</span> {formatUnits(votes.for, 18, 0)} ({share(f).toFixed(1)}%)</span>
        <span><span className="font-semibold text-danger">Against</span> {formatUnits(votes.against, 18, 0)}</span>
        <span><span className="font-semibold">Abstain</span> {formatUnits(votes.abstain, 18, 0)}</span>
      </div>
    </div>
  );
}
