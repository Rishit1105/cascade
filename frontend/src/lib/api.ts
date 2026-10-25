/* Typed client for the DAOGuard API. Errors surface the server's {error: {code, message}} body. */

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let actorName = "Demo reviewer";
export function setActor(name: string) {
  actorName = name || "Demo reviewer";
}

async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "X-DAOGuard-Actor": actorName };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload, ...init });
  } catch {
    throw new ApiError(0, "network_error", "The DAOGuard API is not reachable. Is the backend running on port 8000?");
  }
  if (!res.ok) {
    let code = "http_error";
    let message = `${res.status} ${res.statusText}`;
    let details: unknown;
    try {
      const data = await res.json();
      code = data?.error?.code ?? code;
      message = data?.error?.message ?? message;
      details = data?.error?.details;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, code, message, details);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T,>(path: string) => request<T>("GET", path),
  post: <T,>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T,>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T,>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  upload: <T,>(path: string, form: FormData) => request<T>("POST", path, form),
};

export function qs(params: Record<string, string | number | undefined | null | boolean>): string {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  });
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/* ------------------------------------------------------------------ types */
export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface Health {
  status: string;
  version: string;
  state: { phase: string; message: string; error: string | null };
  chain: { connected: boolean; chain_id?: number; block?: number; client?: string };
  ai: { provider: string | null; model: string | null; mode: string; label: string };
}

export interface ProposalItem {
  id: string;
  title: string;
  summary: string;
  category: string;
  status: string;
  proposer_address: string;
  proposer_label: string;
  recipient_address: string | null;
  recipient_label: string | null;
  requested_amount_base: string;
  requested_display: string;
  token_symbol: string;
  current_version: number;
  governance_status: string;
  guard_status: string;
  evidence_count: number;
  open_findings: Partial<Record<Severity, number>>;
  created_at: string;
  updated_at: string;
  is_demo: boolean;
}

export interface Citation {
  doc_id: string;
  doc_name: string;
  page: number;
  section: string | null;
  quote: string;
  char_start: number | null;
  char_end: number | null;
}

export interface Claim {
  category: string;
  text: string;
  status: "source-quoted" | "not_evidenced";
  confidence: string;
  citations: Citation[];
  note?: string;
}

export interface Finding {
  id: string;
  proposal_id: string;
  kind: string;
  rule_id: string;
  severity: Severity;
  confidence: string;
  title: string;
  explanation: string;
  remediation: string | null;
  evidence_refs: Array<Record<string, any>>;
  data: Record<string, any>;
  status: string;
  status_history: Array<{ status: string; at: string; by: string; note: string }>;
  source_ref: string | null;
  created_at: string;
  superseded: boolean;
}

export interface EvidenceDoc {
  id: string;
  proposal_id: string;
  source_type: string;
  name: string;
  location: string | null;
  content_hash: string;
  verification_status: string;
  injection_flags: Array<{ pattern: string; page: number; quote: string }>;
  page_count: number;
  excerpt: string;
  added_by: string;
  added_at: string;
  is_demo: boolean;
  pages?: Array<{ page: number; section: string | null; text: string }>;
}

export interface DecodedAction {
  index?: number;
  target: string;
  target_label: string | null;
  value: string;
  data: string;
  operation: number;
  selector: string | null;
  function: string | null;
  args: Array<{ name: string; type: string; value: any }>;
  decoded: boolean;
  privileged: string | null;
  kind: string;
  token_address: string | null;
  token_symbol: string | null;
  expected_recipient: string | null;
  expected_amount_base: string | null;
  human_readable: string;
  upgrade?: { proxy: string; implementation: string; call_data: string };
}

export interface VersionSummary {
  version: number;
  content_hash: string;
  manifest_hash: string;
  evidence_root: string;
  disclosure_hash: string;
  committed_at: string;
  author: string;
  tx_hash: string | null;
  block_number: number | null;
  governance_status: string;
  governor_proposal_id: string | null;
  changed_fields: string[];
  change_note: string;
}

export interface GuardInfo {
  status: "none" | "approved" | "executed" | "halted";
  manifest_hash: string | null;
  version: number | null;
  approved_at_block: number | null;
  executable_at_block: number | null;
  halt_reason: string | null;
  review_window_blocks: number;
}

export interface Vote {
  voter: string;
  voter_label?: string | null;
  support: "for" | "against" | "abstain";
  weight: string;
  reason: string;
  tx_hash: string;
  block_number: number;
  timestamp: string;
}

export interface GovernanceState {
  proposal_id: string;
  current_block: number;
  guard: GuardInfo;
  version: number | null;
  state: string;
  governance_status: string;
  governor_proposal_id?: string;
  snapshot_block?: number;
  deadline_block?: number;
  blocks_remaining?: number;
  votes?: { for: string; against: string; abstain: string };
  votes_display?: { for: string; against: string; abstain: string };
  quorum?: string | null;
  quorum_reached?: boolean;
  total_supply?: string;
  participation_pct?: string;
  voters?: Vote[];
  voting_mode?: string;
  voters_available?: Array<{ role: string; address: string; label: string; voting_power: string; is_delegate: boolean }>;
}

export interface ProposalDetail extends ProposalItem {
  key: string;
  token_address: string;
  token_decimals: number;
  treasury_address: string;
  purpose: string;
  body: string;
  milestones: Array<{ title: string; deliverable?: string; month?: number; amount_base?: string; tracking: any | null }>;
  risks: string[];
  assumptions: string[];
  benefits: string[];
  budget_breakdown: Array<{ item: string; amount_base: string }>;
  draft_actions: Array<Record<string, any>>;
  draft_decoded: DecodedAction[];
  draft_error: string | null;
  versions: VersionSummary[];
  evidence: EvidenceDoc[];
  disclosure: { id: string; statement: any; disclosure_hash: string; signer: string; created_at: string } | null;
  analysis: { id: string; mode: string; status: string; error: string | null; created_at: string; brief: Brief } | null;
  findings: Finding[];
  challenges: Array<{ id: string; finding_id: string; author: string; statement: string; counter_evidence: any[]; status: string; reviewer: string | null; response: string | null; created_at: string; responded_at: string | null }>;
  simulations: Array<{ id: string; version: number | null; verdict: string; trigger: string; scenario: string | null; finished_at: string; summary: string | null }>;
  governance: GovernanceState;
}

export interface Brief {
  summary: Array<{ text: string; basis: string; citations: Citation[] }>;
  requested_decision: string;
  facts: Record<string, { value?: string; value_base?: string; display?: string; label?: string | null; status: string; citations: Citation[]; note: string | null }>;
  claims: Record<string, Claim[]>;
  contradictions: Array<{ kind: string; text: string; citations: Citation[]; severity: Severity }>;
  coverage: { claims_total: number; claims_cited: number; pct: number };
  sources: Array<{ id: string; name: string; source_type: string; pages: number }>;
  missing_information: Array<{ rule_id: string; severity: Severity; title: string; explanation: string; remediation: string }>;
  questions: string[];
  injection_flags: Array<{ title: string; explanation: string }>;
  mode_label: string;
  is_demo_analysis: boolean;
  unknowns?: string[];
}

export interface AuditEvent {
  seq: number;
  id: string;
  proposal_id: string | null;
  event_type: string;
  actor: string;
  source: string;
  verification: "chain-confirmed" | "off-chain";
  status: "success" | "failure" | "warning" | "info";
  summary: string;
  occurred_at: string;
  proposal_version: number | null;
  manifest_hash: string | null;
  tx_hash: string | null;
  block_number: number | null;
  details: Record<string, any>;
  prev_hash: string;
  event_hash: string;
}

export interface Alert {
  id: string;
  proposal_id: string | null;
  finding_id: string | null;
  source: string;
  severity: Severity;
  title: string;
  description: string;
  status: "new" | "triaged" | "escalated" | "resolved" | "dismissed";
  assignee: string | null;
  resolution: string | null;
  history: Array<{ action: string; by: string; at: string; note: string; data?: any; assignee?: string | null }>;
  data: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface Discrepancy {
  rule_id: string;
  title: string;
  severity: Severity;
  field_path: string;
  approved_value: any;
  submitted_value: any;
  approved_display?: string;
  submitted_display?: string;
  explanation: string;
  approved_index?: number;
  submitted_index?: number;
}

export interface ExecutionCheck {
  id: string;
  proposal_id: string;
  version: number | null;
  scenario: string | null;
  status: "MATCH" | "MISMATCH" | "UNKNOWN";
  approved_manifest_hash: string | null;
  submitted_manifest_hash: string | null;
  approved_manifest: any;
  submitted_payload: any;
  submitted_decoded: DecodedAction[];
  discrepancies: Discrepancy[];
  preflight: {
    performed: boolean;
    reason?: string;
    would_execute?: boolean;
    revert?: { name: string; explanation: string; args: Record<string, any> } | null;
    note?: string;
    alignment?: Array<{ approved_index: number | null; submitted_index: number | null; status: string }>;
    summary?: string;
    approved_decoded?: DecodedAction[];
  };
  actor: string;
  checked_at: string;
}

export interface ExecutionAttempt {
  id: string;
  proposal_id: string;
  version: number | null;
  check_id: string | null;
  scenario: string | null;
  submitted_manifest_hash: string | null;
  outcome: "executed" | "rejected" | "not_sent";
  tx_hash: string | null;
  block_number: number | null;
  revert: { name: string; explanation: string; args?: Record<string, any> } | null;
  balance_changes: Array<{ holder: string; holder_label: string | null; display: string; delta: string }>;
  actor: string;
  created_at: string;
  enforcement: string;
}

export interface Simulation {
  id: string;
  proposal_id: string;
  version: number | null;
  scenario: string | null;
  trigger: string;
  manifest_hash: string | null;
  status: string;
  verdict: "pass" | "flag" | "block" | "error";
  chain_block: number | null;
  started_at: string;
  finished_at: string;
  report: any;
}

export interface GraphNode {
  id: string;
  type: "dao" | "proposal" | "wallet" | "delegate" | "treasury" | "contract" | "evidence" | "transaction";
  label: string;
  subtitle?: string;
  address?: string | null;
  role?: string | null;
  status?: string;
  proposal_id?: string;
  degree: number;
  tags: string[];
  [k: string]: any;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  label: string;
  evidence_level: "verified_observation" | "disclosed" | "record" | "unverified_lead";
  provenance: Record<string, any>;
  directed: boolean;
  value_base?: string;
  count?: number;
  support?: string;
  note?: string;
}

export interface EvaluationChain {
  proposal_id: string;
  stages: Array<{
    key: string;
    name: string;
    question: string;
    link: string;
    status: string;
    prior: number;
    posterior: number;
    band: "low" | "elevated" | "high";
    items: Array<{ key: string; label: string; lr: number; direction: string; source: string | null }>;
    metrics: Record<string, any>;
    notes: string[];
  }>;
  overall: number;
  method: string;
  formula: string;
  label: string;
}

export interface QAEntry {
  kind: "question" | "answer" | "follow_up" | "accepted" | "withdrawn";
  author: string;
  role: "reviewer" | "proposer";
  at: string;
  text: string;
  entered_by?: string;
  round?: number;
  answer_hash?: string;
  signature?: string;
  signer?: string;
  signature_valid?: boolean;
  evidence_id?: string | null;
  evidence_name?: string | null;
  evidence_hash?: string | null;
}

export type QuestionStatus = "open" | "answered" | "needs_more" | "accepted" | "withdrawn";

export interface Question {
  id: string;
  proposal_id: string;
  finding: { id: string; title: string; severity: Severity; status: string; kind: string; superseded?: boolean } | null;
  rule_id: string | null;
  version: number;
  text: string;
  status: QuestionStatus;
  asked_by: string;
  asked_at: string;
  updated_at: string;
  thread: QAEntry[];
}

export interface QuestionSuggestion {
  finding_id: string;
  rule_id: string;
  severity: Severity;
  title: string;
  kind: string;
  question: string;
}

export interface QuestionsOverview {
  items: Question[];
  suggestions: QuestionSuggestion[];
  counts: Record<QuestionStatus, number>;
  note: string;
}
