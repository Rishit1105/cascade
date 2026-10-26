// Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { analyse, describeGap, exampleTies, lanesFor, sharedTraits, suggestions, tieKey } from "../src/lib/ledger.ts";
import type { AuditEvent } from "../src/lib/api.ts";

let n = 0;
const ev = (over: Partial<AuditEvent>): AuditEvent => ({
  seq: ++n, id: `EV-${n}`, proposal_id: "GOV-042", event_type: "vote_cast", actor: "Delegate · Kestrel", source: "seed",
  verification: "off-chain", status: "info", summary: "", occurred_at: "2026-10-01T10:00:00Z", proposal_version: 2,
  manifest_hash: null, tx_hash: null, block_number: null, details: {}, prev_hash: "sha256:0", event_hash: `sha256:${n}`, ...over,
});

test("lanes are one per proposal, sorted, with system events last", () => {
  const lanes = lanesFor([ev({ proposal_id: "GOV-043" }), ev({ proposal_id: null }), ev({}), ev({})]);
  assert.deepEqual(lanes.map((l) => [l.id, l.count]), [["GOV-042", 2], ["GOV-043", 1], ["system", 1]]);
});

test("a shared manifest and record id make a direct link; nothing shared is chain-only", () => {
  const approved = ev({ event_type: "manifest_approved", manifest_hash: "0xabc", tx_hash: "0x1", block_number: 10, occurred_at: "2026-10-01T10:00:00Z" });
  const executed = ev({ event_type: "execution_succeeded", manifest_hash: "0xabc", tx_hash: "0x2", block_number: 16, occurred_at: "2026-10-03T14:30:00Z" });
  const c = analyse(executed, approved); // argument order does not matter
  assert.equal(c.from.id, approved.id);
  assert.equal(c.links, 1);
  assert.equal(c.strength, "direct");
  assert.deepEqual(c.shared.map((t) => t.kind), ["manifest", "version", "proposal", "actor"]);
  assert.match(c.verdict, /2d 4h after/);

  const q = ev({ details: { question_id: "Q-F7606145", rule_id: "MI-R001" } });
  const a = ev({ actor: "Northstar Labs · proposer", details: { question_id: "Q-F7606145" } });
  assert.deepEqual(sharedTraits(q, a).map((t) => t.kind), ["reference", "version", "proposal"]);

  const other = ev({ proposal_id: "GOV-044", actor: "DAOGuard", proposal_version: 1 });
  assert.equal(analyse(approved, other).strength, "chain");
});

test("suggestions rank strong ties first and skip actor-only matches", () => {
  const base = ev({ tx_hash: "0xt", manifest_hash: "0xm" });
  const sameTx = ev({ tx_hash: "0xt" });
  const sameManifest = ev({ manifest_hash: "0xm", proposal_version: 3 });
  const actorOnly = ev({ proposal_id: "GOV-041", proposal_version: 1 });
  const ranked = suggestions(base, [base, actorOnly, sameManifest, sameTx]).map((s) => s.event.id);
  assert.deepEqual(ranked, [sameTx.id, sameManifest.id]);
});

test("gap formatting and tie keys", () => {
  assert.equal(describeGap(0), "same second");
  assert.equal(describeGap(42_000), "42s");
  assert.equal(describeGap(3 * 3600_000 + 12 * 60_000), "3h 12m");
  assert.equal(tieKey("EV-9", "EV-2"), tieKey("EV-2", "EV-9"));
});

test("example strings pick the strongest direct link per proposal", () => {
  const a = ev({ proposal_id: "GOV-041", manifest_hash: "0x41" });
  const b = ev({ proposal_id: "GOV-041", manifest_hash: "0x41" });
  const c = ev({ proposal_id: "GOV-043", details: { simulation_id: "SIM-123456" } });
  const d = ev({ proposal_id: "GOV-043", details: { simulation_id: "SIM-123456" } });
  const ties = exampleTies([a, b, c, d, ev({ proposal_id: null })]);
  assert.deepEqual(ties.map((t) => [t.a, t.b]), [[a.id, b.id], [c.id, d.id]]);
});
