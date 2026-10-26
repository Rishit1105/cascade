/* Compliance page helpers: which controls each proposal has evidence for in the audit ledger, a
   transparent readiness score, and ledger composition. Pure functions, tested in
   tests/compliance.test.ts. */
import type { AuditEvent } from "./api";

export type ControlState = "done" | "partial" | "missing" | "na";

export interface Control {
  id: string;
  label: string;
  hint: string;
}

export const CONTROLS: Control[] = [
  { id: "disclosure", label: "Disclosure", hint: "Proposer published a signed conflict-of-interest disclosure" },
  { id: "evidence", label: "Evidence", hint: "Evidence attached and committed in a version (Merkle root)" },
  { id: "onchain", label: "On-chain version", hint: "A version commitment was mined on the ProposalRegistry" },
  { id: "analysis", label: "Brief", hint: "Cited brief and information-gap analysis completed" },
  { id: "vote", label: "Vote", hint: "Votes cast on the governor (partial: proposed, no votes yet)" },
  { id: "simulation", label: "Simulation", hint: "Payload simulated before execution" },
  { id: "questions", label: "Q&A closed", hint: "Every reviewer question answered (n/a when none were asked)" },
  { id: "report", label: "Report", hint: "An audit report was generated for this proposal" },
];

export interface CoverageRow {
  proposal: string;
  cells: Record<string, ControlState>;
  score: number;
}

const has = (evs: AuditEvent[], ...types: string[]) => evs.some((e) => types.includes(e.event_type));
const count = (evs: AuditEvent[], ...types: string[]) => evs.filter((e) => types.includes(e.event_type)).length;

export const cellValue = (s: ControlState) => (s === "done" ? 1 : s === "partial" ? 0.5 : 0);

export function coverage(proposalIds: string[], events: AuditEvent[], reportProposals: string[] = []): CoverageRow[] {
  return proposalIds.map((pid) => {
    const evs = events.filter((e) => e.proposal_id === pid);
    const asked = count(evs, "question_asked");
    const answered = count(evs, "question_answered", "answer_accepted", "question_withdrawn");
    const committed = evs.filter((e) => e.event_type === "version_committed");
    const cells: Record<string, ControlState> = {
      disclosure: has(evs, "disclosure_published") ? "done" : "missing",
      evidence: has(evs, "evidence_attached") ? (committed.length ? "done" : "partial") : "missing",
      onchain: committed.some((e) => e.tx_hash) ? "done" : committed.length ? "partial" : "missing",
      analysis: has(evs, "analysis_completed") ? "done" : "missing",
      vote: has(evs, "vote_cast", "vote_finalized") ? "done" : has(evs, "governance_proposed") ? "partial" : "missing",
      simulation: has(evs, "simulation_completed", "simulation_comparison", "sentinel_review_started") ? "done" : "missing",
      questions: asked === 0 ? "na" : answered >= asked ? "done" : answered > 0 ? "partial" : "missing",
      report: reportProposals.includes(pid) || has(evs, "report_generated") ? "done" : "missing",
    };
    const scored = Object.values(cells).filter((c) => c !== "na");
    return { proposal: pid, cells, score: scored.length ? scored.reduce((a, c) => a + cellValue(c), 0) / scored.length : 0 };
  });
}

export interface ReadinessPart {
  id: string;
  label: string;
  weight: number;
  value: number;
  detail: string;
}

/** Weighted composite of four measures. Every part and weight is returned so the page can show its working. */
export function readiness(input: { integrity: "intact" | "broken" | "unverified"; chainShare: number; openSevere: number; coverage: number }): { score: number; parts: ReadinessPart[] } {
  const parts: ReadinessPart[] = [
    { id: "integrity", label: "Ledger integrity", weight: 0.3, value: input.integrity === "intact" ? 1 : input.integrity === "broken" ? 0 : 0.5, detail: input.integrity === "intact" ? "Re-hashed and intact" : input.integrity === "broken" ? "Broken links found" : "Not verified in this session (counts half)" },
    { id: "chain", label: "Chain-confirmed events", weight: 0.2, value: Math.max(0, Math.min(1, input.chainShare)), detail: `${Math.round(input.chainShare * 100)}% backed by a transaction receipt` },
    { id: "escalations", label: "Open severe alerts", weight: 0.2, value: Math.max(0, 1 - 0.15 * input.openSevere), detail: `${input.openSevere} critical/high alert(s) open, −15 points each` },
    { id: "coverage", label: "Control coverage", weight: 0.3, value: Math.max(0, Math.min(1, input.coverage)), detail: `${Math.round(input.coverage * 100)}% of applicable controls evidenced` },
  ];
  return { score: Math.round(parts.reduce((a, p) => a + p.weight * p.value, 0) * 100), parts };
}

export const FAMILIES: Array<{ id: string; label: string; types: string[] }> = [
  { id: "governance", label: "Governance", types: ["proposal_created", "proposal_draft_updated", "governance_proposed", "vote_cast", "vote_finalized", "manifest_approved", "version_committed", "milestone_updated"] },
  { id: "evidence", label: "Evidence & disclosure", types: ["evidence_attached", "evidence_duplicate_rejected", "disclosure_published", "version_verified"] },
  { id: "review", label: "Review & Q&A", types: ["analysis_completed", "question_asked", "question_answered", "question_withdrawn", "answer_accepted", "challenge_filed", "challenge_answered", "finding_status_changed", "conflict_review_run", "graph_annotation_added"] },
  { id: "security", label: "Execution & security", types: ["execution_check", "execution_not_sent", "execution_rejected", "execution_succeeded", "simulation_completed", "simulation_comparison", "sentinel_review_started", "proposal_halted", "alert_raised", "dispute_filed", "delegates_notified", "auto_halt_failed"] },
];

export function familyOf(type: string): string {
  return FAMILIES.find((f) => f.types.includes(type))?.id ?? "system";
}

export interface DayRow {
  day: string;
  chain: number;
  offchain: number;
  total: number;
  cumulative: number;
  share: number;
}

/** One row per calendar day between the first and last event (quiet days are zero). */
export function perDay(events: AuditEvent[]): DayRow[] {
  if (events.length === 0) return [];
  const m = new Map<string, { chain: number; offchain: number }>();
  for (const e of events) {
    const d = e.occurred_at.slice(0, 10);
    const row = m.get(d) ?? { chain: 0, offchain: 0 };
    if (e.verification === "chain-confirmed") row.chain += 1;
    else row.offchain += 1;
    m.set(d, row);
  }
  const days = [...m.keys()].sort();
  const out: DayRow[] = [];
  let cumulative = 0;
  for (let d = new Date(days[0] + "T00:00:00Z"); d <= new Date(days[days.length - 1] + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const r = m.get(key) ?? { chain: 0, offchain: 0 };
    const total = r.chain + r.offchain;
    cumulative += total;
    out.push({ day: key, ...r, total, cumulative, share: total ? r.chain / total : 0 });
  }
  return out;
}
