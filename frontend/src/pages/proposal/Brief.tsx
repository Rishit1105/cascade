import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, Bot, CheckCircle2, CircleHelp, FileWarning, MessageSquarePlus, RefreshCw, ShieldAlert, Sparkles } from "lucide-react";
import { api, type ProposalDetail, type QuestionSuggestion } from "../../lib/api";
import { cx, dateTime } from "../../lib/format";
import { useAction, useQuestions } from "../../lib/queries";
import { AskQuestionDialog, QA_STATUS } from "./QATab";
import { CitationChip, NotEvidenced } from "../../components/common";
import { Badge, Button, Callout, EmptyState, ProgressBar, SeverityBadge } from "../../components/ui";

const CATEGORIES: Array<{ key: string; label: string }> = [
  { key: "benefits", label: "Expected benefits" },
  { key: "risks", label: "Risks" },
  { key: "assumptions", label: "Assumptions" },
  { key: "dependencies", label: "Dependencies" },
];

export function BriefTab({ p }: { p: ProposalDetail }) {
  const analyze = useAction(() => api.post(`/proposals/${p.id}/analyze`), { success: "Brief regenerated from the current evidence" });
  const qa = useQuestions(p.id);
  const [asking, setAsking] = useState<QuestionSuggestion | null>(null);
  const [params, setParams] = useSearchParams();
  const openQA = () => {
    const next = new URLSearchParams(params);
    next.set("tab", "qa");
    setParams(next, { replace: true });
  };
  const brief = p.analysis?.brief;
  if (!brief) {
    return (
      <EmptyState
        icon={<Sparkles className="h-5 w-5" />}
        title="No brief yet"
        body="Generate an evidence-backed brief. Every claim links to the sentence it came from."
        action={<Button variant="primary" loading={analyze.isPending} onClick={() => analyze.mutate(undefined)}>Generate brief</Button>}
      />
    );
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-subtle/50 px-3 py-2">
        <div className="flex items-center gap-2 text-xs">
          <Bot className="h-4 w-4 text-muted" />
          <span className="font-medium">{brief.mode_label}</span>
          {brief.is_demo_analysis && <Badge tone="warning">Demo analysis</Badge>}
          <span className="text-muted">· generated {dateTime(p.analysis?.created_at)}</span>
        </div>
        <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={analyze.isPending} onClick={() => analyze.mutate(undefined)}>
          Regenerate
        </Button>
      </div>
      {p.analysis?.error && <Callout tone="warning" title="AI model unavailable">{p.analysis.error}. The deterministic brief below is unaffected.</Callout>}

      <section>
        <p className="label mb-2">Plain-language summary</p>
        <ul className="space-y-2">
          {brief.summary.map((s, i) => (
            <li key={i} className="flex gap-2.5 text-sm leading-relaxed">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span className="min-w-0">
                {s.text}{" "}
                <span className="ml-1 inline-flex max-w-full flex-wrap gap-1 align-middle">
                  {s.citations.slice(0, 2).map((c, j) => (
                    <CitationChip key={j} proposalId={p.id} c={c} />
                  ))}
                  {s.citations.length === 0 && <span className="text-2xs text-faint">({s.basis})</span>}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-line p-3">
          <p className="label mb-1.5">Requested decision</p>
          <p className="text-sm leading-relaxed">{brief.requested_decision}</p>
        </div>
        <div className="rounded-lg border border-line p-3">
          <p className="label mb-1.5">Evidence coverage</p>
          <div className="flex items-end justify-between">
            <span className="text-xl font-semibold">{brief.coverage.pct}%</span>
            <span className="text-xs text-muted">{brief.coverage.claims_cited} of {brief.coverage.claims_total} claims quote a source</span>
          </div>
          <div className="mt-2">
            <ProgressBar value={brief.coverage.pct} tone={brief.coverage.pct >= 70 ? "primary" : "warning"} />
          </div>
          <p className="mt-2 text-2xs text-muted">Sources: {brief.sources.map((s) => s.name).join(" · ")}</p>
        </div>
      </section>

      {Object.keys(brief.facts).length > 0 && (
        <section>
          <p className="label mb-2">Key facts</p>
          <div className="grid gap-2 md:grid-cols-2">
            {Object.entries(brief.facts).map(([k, f]) => (
              <div key={k} className="rounded-lg border border-line p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted">{k === "requested_amount" ? "Requested amount" : "Recipient"}</span>
                  {f.status === "source-quoted" ? <Badge tone="success" icon={<CheckCircle2 className="h-3 w-3" />}>Source-quoted</Badge> : <NotEvidenced note={f.note} />}
                </div>
                <p className="mt-1 break-all text-sm font-semibold">{f.display ?? f.label ?? f.value}</p>
                {f.label && f.value && <p className="break-all font-mono text-2xs text-muted">{f.value}</p>}
                <div className="mt-2 flex flex-wrap gap-1">
                  {f.citations.map((c, i) => (
                    <CitationChip key={i} proposalId={p.id} c={c} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {(brief.contradictions.length > 0 || brief.injection_flags.length > 0) && (
        <section className="space-y-2">
          {brief.contradictions.map((c, i) => (
            <Callout key={i} tone="warning" icon={<AlertTriangle className="h-4 w-4" />} title="Sources disagree">
              {c.text}
              <span className="ml-1 inline-flex gap-1 align-middle">
                {c.citations.map((ci, j) => (
                  <CitationChip key={j} proposalId={p.id} c={ci} />
                ))}
              </span>
            </Callout>
          ))}
          {brief.injection_flags.map((f, i) => (
            <Callout key={i} tone="danger" icon={<ShieldAlert className="h-4 w-4" />} title={f.title}>
              {f.explanation}
            </Callout>
          ))}
        </section>
      )}

      <section className="grid gap-3 lg:grid-cols-2">
        {CATEGORIES.map(({ key, label }) => {
          const claims = brief.claims[key] ?? [];
          return (
            <div key={key} className="rounded-lg border border-line">
              <div className="flex items-center justify-between border-b border-line px-3 py-2">
                <p className="text-xs font-semibold">{label}</p>
                <span className="text-2xs text-muted">{claims.length}</span>
              </div>
              <ul className="divide-y divide-line">
                {claims.length === 0 && (
                  <li className="flex items-center gap-1.5 px-3 py-2.5 text-xs text-muted">
                    <FileWarning className="h-3.5 w-3.5 text-warning" /> Nothing in the supplied material.
                  </li>
                )}
                {claims.map((c, i) => (
                  <li key={i} className="px-3 py-2.5">
                    <p className={cx("text-xs leading-relaxed", c.status !== "source-quoted" && "text-muted")}>{c.text}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {c.citations.map((ci, j) => (
                        <CitationChip key={j} proposalId={p.id} c={ci} />
                      ))}
                      {c.status !== "source-quoted" && <NotEvidenced note={c.note} />}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </section>

      <section data-tour="brief-missing">
        <p className="label mb-2">Missing information: questions voters should ask</p>
        {brief.missing_information.length === 0 && <p className="text-xs text-muted">No gaps found by the missing-information rules.</p>}
        <ul className="space-y-2">
          {brief.missing_information.map((m) => (
            <li key={m.rule_id + m.title} className="flex gap-2.5 rounded-lg border border-line p-3">
              <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <SeverityBadge severity={m.severity} />
                  <span className="text-sm font-semibold">{m.title}</span>
                  <span className="font-mono text-2xs text-faint">{m.rule_id}</span>
                </div>
                <p className="mt-1 text-xs text-muted">{m.explanation}</p>
                <p className="mt-1 text-xs font-medium text-fg">Ask: {m.remediation}</p>
                {(() => {
                  const q = qa.data?.items.find((x) => x.rule_id === m.rule_id && x.status !== "withdrawn");
                  const s = qa.data?.suggestions.find((x) => x.rule_id === m.rule_id);
                  if (q)
                    return (
                      <button className="mt-2 inline-flex items-center gap-1.5 text-2xs font-medium text-primary hover:underline" onClick={openQA}>
                        <Badge tone={QA_STATUS[q.status].tone}>{QA_STATUS[q.status].label}</Badge> {q.id} · view thread
                      </button>
                    );
                  if (s)
                    return (
                      <Button size="sm" className="mt-2" icon={<MessageSquarePlus className="h-3.5 w-3.5" />} onClick={() => setAsking(s)}>
                        Ask proposer
                      </Button>
                    );
                  return null;
                })()}
              </div>
            </li>
          ))}
        </ul>
        <AskQuestionDialog p={p} open={!!asking} suggestion={asking} onClose={() => setAsking(null)} />
        <p className="mt-2 text-2xs text-muted">A missing item is a reason to ask, never evidence of wrongdoing on its own.</p>
      </section>
    </div>
  );
}
