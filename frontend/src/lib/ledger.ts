/* Ledger graph helpers: lane layout and the analysis behind a "string" tied between two audit
   events. Pure functions (no React), so they are unit-tested in tests/ledger.test.ts. */
import type { AuditEvent } from "./api";

export const SYSTEM_LANE = "system";

export interface Lane {
  id: string;
  label: string;
  count: number;
}

/** One lane per proposal (sorted by id), plus a final lane for system-wide events. */
export function lanesFor(events: AuditEvent[]): Lane[] {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.proposal_id ?? SYSTEM_LANE, (counts.get(e.proposal_id ?? SYSTEM_LANE) ?? 0) + 1);
  const ids = [...counts.keys()].filter((k) => k !== SYSTEM_LANE).sort();
  if (counts.has(SYSTEM_LANE)) ids.push(SYSTEM_LANE);
  return ids.map((id) => ({ id, label: id === SYSTEM_LANE ? "System" : id, count: counts.get(id) ?? 0 }));
}

export const laneOf = (e: AuditEvent) => e.proposal_id ?? SYSTEM_LANE;

export type TraitKind = "tx" | "manifest" | "reference" | "version" | "block" | "proposal" | "actor";

export interface Trait {
  kind: TraitKind;
  label: string;
  value: string;
}

/** How strongly each shared trait ties two events together (used for ranking suggestions). */
export const TRAIT_WEIGHT: Record<TraitKind, number> = { tx: 6, manifest: 5, reference: 5, version: 2, block: 2, proposal: 1, actor: 1 };

const REF_KEY = /(^|_)(id|hash)$/;

/** Identifier-like values in an event's details (question_id, finding_id, simulation_id, …). */
function references(e: AuditEvent): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(e.details ?? {})) {
    if (typeof v === "string" && v.length >= 6 && REF_KEY.test(k)) out.set(v, k);
  }
  return out;
}

/** Everything two events have in common, strongest first. */
export function sharedTraits(a: AuditEvent, b: AuditEvent): Trait[] {
  const out: Trait[] = [];
  if (a.tx_hash && a.tx_hash === b.tx_hash) out.push({ kind: "tx", label: "Same transaction", value: a.tx_hash });
  if (a.manifest_hash && a.manifest_hash === b.manifest_hash) out.push({ kind: "manifest", label: "Same approved manifest", value: a.manifest_hash });
  const refsB = references(b);
  for (const [value, key] of references(a)) {
    if (refsB.has(value)) out.push({ kind: "reference", label: `Both reference ${key.replace(/_/g, " ")}`, value });
  }
  if (a.proposal_id && a.proposal_id === b.proposal_id && a.proposal_version && a.proposal_version === b.proposal_version)
    out.push({ kind: "version", label: "Same proposal version", value: `${a.proposal_id} v${a.proposal_version}` });
  if (a.block_number != null && a.block_number === b.block_number && a.tx_hash !== b.tx_hash) out.push({ kind: "block", label: "Same block", value: `#${a.block_number}` });
  if (a.proposal_id && a.proposal_id === b.proposal_id) out.push({ kind: "proposal", label: "Same proposal", value: a.proposal_id });
  if (a.actor === b.actor) out.push({ kind: "actor", label: "Same actor", value: a.actor });
  return out;
}

export function describeGap(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 1) return "same second";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export type Strength = "direct" | "related" | "chain";

export interface Connection {
  from: AuditEvent;
  to: AuditEvent;
  /** Hash links between the two (the later event is this many records after the earlier one). */
  links: number;
  elapsedMs: number;
  shared: Trait[];
  strength: Strength;
  verdict: string;
}

const STRONG: TraitKind[] = ["tx", "manifest", "reference"];

export function analyse(a: AuditEvent, b: AuditEvent): Connection {
  const [from, to] = a.seq <= b.seq ? [a, b] : [b, a];
  const shared = sharedTraits(from, to);
  const strength: Strength = shared.some((t) => STRONG.includes(t.kind)) ? "direct" : shared.length ? "related" : "chain";
  const links = to.seq - from.seq;
  const elapsedMs = Date.parse(to.occurred_at) - Date.parse(from.occurred_at);
  const gap = describeGap(elapsedMs);
  const tie =
    strength === "direct"
      ? `They are directly linked: ${shared.filter((t) => STRONG.includes(t.kind)).map((t) => t.label.toLowerCase()).join(", ")}.`
      : strength === "related"
        ? `They are related through ${shared.map((t) => t.label.toLowerCase()).join(", ")}, but no transaction, manifest or record id joins them.`
        : "Nothing but the hash chain joins them: different proposals, actors and records.";
  const verdict = `#${to.seq} was recorded ${links} ledger link${links === 1 ? "" : "s"} and ${gap} after #${from.seq}. ${tie} Every link in between is a sha256 hash of the previous one, so neither event can be edited without breaking the chain.`;
  return { from, to, links, elapsedMs, shared, strength, verdict };
}

export interface Suggestion {
  event: AuditEvent;
  score: number;
  traits: Trait[];
}

/** Events most worth tying to `e`: shared transactions, manifests and record ids rank first. */
export function suggestions(e: AuditEvent, events: AuditEvent[], limit = 5): Suggestion[] {
  return events
    .filter((o) => o.id !== e.id)
    .map((o) => {
      const traits = sharedTraits(e, o);
      return { event: o, traits, score: traits.reduce((n, t) => n + TRAIT_WEIGHT[t.kind], 0) };
    })
    .filter((s) => s.traits.some((t) => t.kind !== "actor" && t.kind !== "proposal") || s.score >= 2)
    .sort((x, y) => y.score - x.score || Math.abs(x.event.seq - e.seq) - Math.abs(y.event.seq - e.seq))
    .slice(0, limit);
}

export interface StringTie {
  a: string;
  b: string;
  color: number;
}

export const tieKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Starter strings for a first visit: the strongest direct links in the ledger, one per proposal. */
export function exampleTies(events: AuditEvent[], max = 2): StringTie[] {
  const out: StringTie[] = [];
  const used = new Set<string>();
  const pairs: Array<{ a: AuditEvent; b: AuditEvent; score: number }> = [];
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const t = sharedTraits(events[i], events[j]);
      if (!t.some((x) => STRONG.includes(x.kind))) continue;
      pairs.push({ a: events[i], b: events[j], score: t.reduce((n, x) => n + TRAIT_WEIGHT[x.kind], 0) + Math.min(6, Math.abs(events[i].seq - events[j].seq) / 4) });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  for (const p of pairs) {
    const lane = laneOf(p.a);
    if (used.has(lane)) continue;
    used.add(lane);
    out.push({ a: p.a.id, b: p.b.id, color: out.length });
    if (out.length >= max) break;
  }
  return out;
}
