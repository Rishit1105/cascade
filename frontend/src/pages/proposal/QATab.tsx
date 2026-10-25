import { useEffect, useMemo, useState } from "react";
import { BadgeCheck, CircleHelp, FileText, MessageSquarePlus, MessagesSquare, PenLine, ShieldAlert, Undo2 } from "lucide-react";
import { api, type ProposalDetail, type QAEntry, type Question, type QuestionStatus, type QuestionSuggestion } from "../../lib/api";
import { useApp } from "../../lib/app";
import { cx, dateTime, shortAddr, timeAgo } from "../../lib/format";
import { useAction, useQuestions } from "../../lib/queries";
import { Modal } from "../../components/overlays";
import { Badge, Button, Callout, EmptyState, ErrorState, Field, LoadingBlock, Segmented, SeverityBadge } from "../../components/ui";

export const QA_STATUS: Record<QuestionStatus, { label: string; tone: "info" | "warning" | "success" | "neutral" }> = {
  open: { label: "Awaiting proposer", tone: "info" },
  needs_more: { label: "Follow-up requested", tone: "warning" },
  answered: { label: "Awaiting review", tone: "warning" },
  accepted: { label: "Accepted", tone: "success" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};

/** Ask the proposer a question, optionally tied to the finding it should resolve. */
export function AskQuestionDialog({ p, open, onClose, suggestion }: { p: ProposalDetail; open: boolean; onClose: () => void; suggestion?: QuestionSuggestion | null }) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (open) setText(suggestion?.question ?? "");
  }, [open, suggestion]);
  const ask = useAction(() => api.post<Question>(`/proposals/${p.id}/questions`, { text: text.trim(), finding_id: suggestion?.finding_id ?? null }), {
    success: (q: Question) => `${q.id} sent to the proposer`,
    onSuccess: onClose,
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ask the proposer"
      subtitle={suggestion ? `Resolves: ${suggestion.title} (${suggestion.rule_id})` : "A free-form question, not tied to a finding."}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={text.trim().length < 10} loading={ask.isPending} onClick={() => ask.mutate(undefined)}>
            Send question
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Question" hint="Recorded in the audit ledger under your name. The proposer answers with a signed statement.">
          <textarea className="textarea min-h-[110px]" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </Field>
        {suggestion && <p className="text-2xs text-muted">If a reviewer accepts the answer, the finding is marked resolved and stops counting in the evaluation chain.</p>}
      </div>
    </Modal>
  );
}

function Entry({ e, proposalId }: { e: QAEntry; proposalId: string }) {
  const { inspect } = useApp();
  const proposer = e.role === "proposer";
  const label = { question: "asked", answer: "answered", follow_up: "asked for more", accepted: "accepted the answer", withdrawn: "withdrew the question" }[e.kind];
  return (
    <li className={cx("flex", proposer ? "justify-end" : "justify-start")}>
      <div className={cx("max-w-[92%] rounded-xl border px-3 py-2", proposer ? "border-primary/25 bg-primary/[0.05]" : e.kind === "accepted" ? "border-primary/25 bg-surface" : "border-line bg-subtle/60")}>
        <p className="text-2xs text-muted">
          <span className="font-semibold text-fg">{e.author}</span> {label} · <span title={dateTime(e.at)}>{timeAgo(e.at)}</span>
          {e.entered_by && e.entered_by !== e.author && <span className="text-faint"> · entered by {e.entered_by}</span>}
        </p>
        <p className="mt-1 whitespace-pre-wrap text-sm text-fg">{e.text}</p>
        {e.kind === "answer" && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge
              tone={e.signature_valid ? "success" : "danger"}
              icon={e.signature_valid ? <BadgeCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
              title={`EIP-712 ProposerAnswer signature ${e.signature}\nanswer hash ${e.answer_hash}`}
            >
              {e.signature_valid ? `Signed by proposer ${shortAddr(e.signer)}` : "Signature does not verify"}
            </Badge>
            {e.evidence_id && (
              <button className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-[1px] text-2xs font-medium text-info hover:underline" onClick={() => inspect({ kind: "evidence", proposalId, docId: e.evidence_id! })}>
                <FileText className="h-3 w-3" /> {e.evidence_name}
              </button>
            )}
            <span className="font-mono text-2xs text-faint">round {e.round}</span>
          </div>
        )}
      </div>
    </li>
  );
}

function QuestionCard({ p, q }: { p: ProposalDetail; q: Question }) {
  const [mode, setMode] = useState<"none" | "answer" | "review">("none");
  const [text, setText] = useState("");
  const [attach, setAttach] = useState(false);
  const [evName, setEvName] = useState("");
  const [evText, setEvText] = useState("");
  const [note, setNote] = useState("");
  const reset = () => {
    setMode("none");
    setText("");
    setAttach(false);
    setEvName("");
    setEvText("");
    setNote("");
  };
  const answer = useAction(
    () => api.post<Question>(`/proposals/${p.id}/questions/${q.id}/answer`, { text: text.trim(), evidence_name: attach ? evName.trim() || null : null, evidence_text: attach ? evText : null }),
    { success: "Answer signed by the proposer's demo account and recorded", onSuccess: reset },
  );
  const review = useAction((decision: "accept" | "needs_more") => api.post<Question>(`/proposals/${p.id}/questions/${q.id}/review`, { decision, note: note.trim() }), {
    success: (r: Question) => (r.status === "accepted" ? (r.finding ? `Answer accepted: finding ${r.finding.id} resolved, evaluation updated` : "Answer accepted") : "Follow-up sent to the proposer"),
    onSuccess: reset,
  });
  const withdraw = useAction(() => api.post(`/proposals/${p.id}/questions/${q.id}/withdraw`, { note: "" }), { success: `${q.id} withdrawn` });
  const st = QA_STATUS[q.status];
  const canAnswer = q.status === "open" || q.status === "needs_more";
  return (
    <article id={q.id} data-tour={q.status === "answered" ? "qa-awaiting" : undefined} className={cx("rounded-xl border bg-surface", q.status === "answered" ? "border-warning/40" : "border-line")}>
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-2xs font-semibold text-muted">{q.id}</span>
            <Badge tone={st.tone}>{st.label}</Badge>
            {q.finding && (
              <span className="inline-flex items-center gap-1 text-2xs text-muted">
                about <SeverityBadge severity={q.finding.severity} /> <span className="font-medium text-fg">{q.finding.title}</span>
                <span className="font-mono text-faint">{q.rule_id}</span>
                <Badge tone={q.finding.status === "resolved" || q.finding.superseded ? "success" : "neutral"} title={q.finding.superseded ? "A later analysis no longer reports this gap." : undefined}>
                  {q.finding.superseded ? "gap closed by re-analysis" : `finding ${q.finding.status}`}
                </Badge>
              </span>
            )}
          </div>
          <p className="mt-0.5 text-2xs text-faint">
            Asked by {q.asked_by} · {dateTime(q.asked_at)}{q.version ? ` · against v${q.version}` : " · before the first version"}
          </p>
        </div>
        {q.status !== "accepted" && q.status !== "withdrawn" && (
          <Button size="sm" variant="ghost" icon={<Undo2 className="h-3.5 w-3.5" />} loading={withdraw.isPending} onClick={() => withdraw.mutate(undefined)}>
            Withdraw
          </Button>
        )}
      </header>
      <ol className="space-y-2 px-4 py-3">
        {q.thread.map((e, i) => (
          <Entry key={i} e={e} proposalId={p.id} />
        ))}
      </ol>

      {mode === "none" && (canAnswer || q.status === "answered") && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
          {canAnswer && (
            <Button size="sm" variant="primary" icon={<PenLine className="h-3.5 w-3.5" />} onClick={() => setMode("answer")}>
              Answer as proposer
            </Button>
          )}
          {q.status === "answered" && (
            <Button size="sm" variant="primary" icon={<BadgeCheck className="h-3.5 w-3.5" />} onClick={() => setMode("review")}>
              Review answer
            </Button>
          )}
          <span className="text-2xs text-muted">{canAnswer ? "Waiting on the proposer." : "The proposer replied. A reviewer decides whether it closes the gap."}</span>
        </footer>
      )}

      {mode === "answer" && (
        <footer className="space-y-3 border-t border-line bg-subtle/40 px-4 py-3">
          <Callout tone="info">Demo: the proposer's node account signs this answer (EIP-712 <span className="font-mono">ProposerAnswer</span>), so it cannot be disowned later.</Callout>
          <Field label={`Answer from ${p.proposer_label ?? shortAddr(p.proposer_address)}`}>
            <textarea className="textarea min-h-[100px]" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          </Field>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} /> Attach supporting evidence (hashed and added to the evidence set)
          </label>
          {attach && (
            <div className="grid gap-2">
              <input className="input" placeholder="Document name, e.g. Budget breakdown.md" value={evName} onChange={(e) => setEvName(e.target.value)} />
              <textarea className="textarea min-h-[90px] font-mono text-xs" placeholder="Paste the supporting text" value={evText} onChange={(e) => setEvText(e.target.value)} />
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={reset}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={text.trim().length < 10 || (attach && !evText.trim())} loading={answer.isPending} onClick={() => answer.mutate(undefined)}>
              Sign and submit answer
            </Button>
          </div>
        </footer>
      )}

      {mode === "review" && (
        <footer className="space-y-3 border-t border-line bg-subtle/40 px-4 py-3">
          <Field label="Reviewer note" hint="Required when asking for more: say exactly what is still missing.">
            <textarea className="textarea min-h-[72px]" value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
          </Field>
          <p className="text-2xs text-muted">Accepting records your judgement that the answer closes the gap{q.finding ? `, and resolves finding ${q.finding.id}` : ""}. It does not prove the answer is true.</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" onClick={reset}>Cancel</Button>
            <Button size="sm" variant="outline-danger" disabled={note.trim().length < 10} loading={review.isPending && review.variables === "needs_more"} onClick={() => review.mutate("needs_more")}>
              Ask for more
            </Button>
            <Button size="sm" variant="primary" loading={review.isPending && review.variables === "accept"} onClick={() => review.mutate("accept")}>
              Accept answer
            </Button>
          </div>
        </footer>
      )}
    </article>
  );
}

export function QATab({ p }: { p: ProposalDetail }) {
  const qa = useQuestions(p.id);
  const [filter, setFilter] = useState<"action" | "all">("action");
  const [asking, setAsking] = useState<{ open: boolean; suggestion: QuestionSuggestion | null }>({ open: false, suggestion: null });
  const shown = useMemo(
    () => (qa.data?.items ?? []).filter((q) => (filter === "action" ? ["open", "needs_more", "answered"].includes(q.status) : true)),
    [qa.data, filter],
  );
  if (qa.isLoading) return <LoadingBlock rows={4} />;
  if (qa.error) return <ErrorState error={qa.error} retry={() => qa.refetch()} />;
  const data = qa.data!;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[640px] text-xs text-muted">
          Close the loop on gaps: ask the proposer, get a <strong className="text-fg">signed</strong> answer (optionally with new evidence), then accept it to resolve the finding, or ask for more.
          Every step is written to the audit ledger.
        </p>
        <Button size="sm" icon={<MessageSquarePlus className="h-3.5 w-3.5" />} onClick={() => setAsking({ open: true, suggestion: null })}>
          Ask a question
        </Button>
      </div>

      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="label">
            Questions · {data.counts.open + data.counts.needs_more} awaiting proposer · {data.counts.answered} awaiting review · {data.counts.accepted} accepted
          </p>
          <Segmented value={filter} onChange={setFilter} size="sm" options={[{ id: "action", label: "Needs action" }, { id: "all", label: "All" }]} />
        </div>
        {shown.length === 0 ? (
          <EmptyState
            icon={<MessagesSquare className="h-5 w-5" />}
            title={filter === "action" ? "Nothing waiting" : "No questions yet"}
            body={data.suggestions.length ? "Pick a gap below to ask the proposer about it." : "Ask the proposer anything the evidence does not answer."}
          />
        ) : (
          <div className="space-y-3">
            {shown.map((q) => (
              <QuestionCard key={q.id} p={p} q={q} />
            ))}
          </div>
        )}
        <p className="mt-2 text-2xs text-muted">{data.note}</p>
      </section>

      {data.suggestions.length > 0 && (
        <section>
          <p className="label mb-2">Gaps nobody has asked about yet · {data.suggestions.length}</p>
          <ul className="space-y-2">
            {data.suggestions.map((s) => (
              <li key={s.finding_id} className="flex flex-wrap items-start gap-2.5 rounded-lg border border-dashed border-line p-3">
                <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <div className="min-w-0 flex-1 basis-[260px]">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <SeverityBadge severity={s.severity} />
                    <span className="text-sm font-semibold">{s.title}</span>
                    <span className="font-mono text-2xs text-faint">{s.rule_id}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted">Suggested: {s.question}</p>
                </div>
                <Button size="sm" variant="primary" onClick={() => setAsking({ open: true, suggestion: s })}>
                  Ask proposer
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <AskQuestionDialog p={p} open={asking.open} suggestion={asking.suggestion} onClose={() => setAsking({ open: false, suggestion: null })} />
    </div>
  );
}
