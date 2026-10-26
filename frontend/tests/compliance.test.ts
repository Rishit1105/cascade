// Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { coverage, familyOf, perDay, readiness } from "../src/lib/compliance.ts";
import type { AuditEvent } from "../src/lib/api.ts";

let n = 0;
const ev = (event_type: string, over: Partial<AuditEvent> = {}): AuditEvent => ({
  seq: ++n, id: `EV-${n}`, proposal_id: "GOV-042", event_type, actor: "a", source: "seed", verification: "off-chain", status: "info", summary: "",
  occurred_at: "2026-10-01T10:00:00Z", proposal_version: 1, manifest_hash: null, tx_hash: null, block_number: null, details: {}, prev_hash: "", event_hash: "", ...over,
});

test("coverage reads controls from the ledger and marks questions n/a when none were asked", () => {
  const events = [
    ev("disclosure_published"), ev("evidence_attached"), ev("version_committed", { tx_hash: "0x1" }), ev("analysis_completed"),
    ev("governance_proposed"), ev("question_asked"), ev("question_answered"),
    ev("evidence_attached", { proposal_id: "GOV-044" }),
  ];
  const [a, b] = coverage(["GOV-042", "GOV-044"], events, ["GOV-042"]);
  assert.deepEqual(a.cells, { disclosure: "done", evidence: "done", onchain: "done", analysis: "done", vote: "partial", simulation: "missing", questions: "done", report: "done" });
  assert.equal(a.score, 6.5 / 8);
  assert.equal(b.cells.evidence, "partial"); // attached but never committed
  assert.equal(b.cells.questions, "na");
  assert.equal(b.score, 0.5 / 7);
});

test("readiness shows its working and counts an unverified ledger as half", () => {
  const r = readiness({ integrity: "unverified", chainShare: 0.5, openSevere: 2, coverage: 0.75 });
  assert.deepEqual(r.parts.map((p) => [p.id, p.weight, p.value]), [["integrity", 0.3, 0.5], ["chain", 0.2, 0.5], ["escalations", 0.2, 0.7], ["coverage", 0.3, 0.75]]);
  assert.equal(r.score, Math.round((0.15 + 0.1 + 0.14 + 0.225) * 100));
  assert.equal(readiness({ integrity: "intact", chainShare: 1, openSevere: 0, coverage: 1 }).score, 100);
  assert.equal(readiness({ integrity: "broken", chainShare: 0, openSevere: 9, coverage: 0 }).score, 0);
});

test("per-day rows fill quiet days and accumulate", () => {
  const rows = perDay([ev("vote_cast", { occurred_at: "2026-10-01T01:00:00Z", verification: "chain-confirmed" }), ev("vote_cast", { occurred_at: "2026-10-03T01:00:00Z" }), ev("vote_cast", { occurred_at: "2026-10-03T02:00:00Z" })]);
  assert.deepEqual(rows.map((r) => [r.day, r.total, r.cumulative, r.share]), [["2026-10-01", 1, 1, 1], ["2026-10-02", 0, 1, 0], ["2026-10-03", 2, 3, 0]]);
  assert.equal(familyOf("vote_cast"), "governance");
  assert.equal(familyOf("ledger_anchored"), "system");
});
