/* The landing page's Merkle evidence tree: real sha256 hashing (SubtleCrypto in the browser, the same
   API in Node for tests) and the scroll choreography of each stage. Pure, tested in tests/merkle.test.ts. */
// Local copy of forge.ts's smoothstep: Node's test runner needs explicit .ts extensions for runtime imports.
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export const LEAVES = 8;
export const DEPTH = 3; // 8 leaves → 4 → 2 → root
export const TAMPERED = 5; // the document that gets edited in the last stage

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** levels[0] are the leaf hashes, the last level is [root]. An odd node is paired with itself. */
export async function buildTree(leaves: string[], hash: (s: string) => Promise<string> = sha256Hex): Promise<string[][]> {
  let level = await Promise.all(leaves.map((l) => hash(`leaf:${l}`)));
  const levels = [level];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(await hash(`node:${level[i]}${level[i + 1] ?? level[i]}`));
    levels.push(next);
    level = next;
  }
  return levels;
}

/** Index of the node on each level (leaf first, root last) on the way from leaf i to the root. */
export function pathToRoot(i: number, depth = DEPTH): number[] {
  const out: number[] = [];
  for (let d = 0, k = i; d <= depth; d++, k = Math.floor(k / 2)) out.push(k);
  return out;
}

/* Scroll choreography, p in 0..1: documents land and hash, pairs combine level by level, the root is
   anchored on-chain, then one document is edited and its path turns red up to a root that no longer matches. */
export const leafT = (p: number, i: number) => smoothstep(0.03 + i * 0.035, 0.13 + i * 0.035, p);
export function nodeT(p: number, level: number, i: number): number {
  const start = level === 1 ? 0.34 + i * 0.03 : level === 2 ? 0.52 + i * 0.04 : 0.645;
  return smoothstep(start, start + 0.08, p);
}
export const anchorT = (p: number) => smoothstep(0.73, 0.81, p);
export const tamperT = (p: number) => smoothstep(0.86, 0.93, p);

export const STAGES = ["Documents are fingerprinted", "Pairs hash upward", "One root for all evidence", "The root is anchored on-chain", "Edit one byte, break the root"];

export function stage(p: number): number {
  return p < 0.34 ? 0 : p < 0.645 ? 1 : p < 0.73 ? 2 : p < 0.85 ? 3 : 4;
}
