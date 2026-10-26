/* Scroll choreography of the landing page's "chain forge": how firm each block is and whether each
   link is locked at a scroll progress p (0..1). Shared by the WebGL scene and the HUD so the numbers
   on screen always match the picture. Pure, tested in tests/forge.test.ts. */

export const BLOCKS = 9;

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Block i starts forging a little after block i-1; the first at 8% of the scroll, the last done by 92%. */
export function blockStart(i: number, n = BLOCKS): number {
  return 0.08 + (i * 0.62) / Math.max(1, n - 1);
}

export function blockFirmness(p: number, i: number, n = BLOCKS): number {
  const s = blockStart(i, n);
  return smoothstep(s, s + 0.22, p);
}

/** The link between block i and i+1 locks during the last part of block i+1 settling (it is over 70% firm by then). */
export function linkLock(p: number, i: number, n = BLOCKS): number {
  const s = blockStart(i + 1, n);
  return smoothstep(s + 0.14, s + 0.22, p);
}

export interface ForgeState {
  verified: number;
  links: number;
  integrity: number;
  stage: number;
}

export const STAGES = 5;

export function forgeState(p: number, n = BLOCKS): ForgeState {
  let verified = 0;
  let links = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const f = blockFirmness(p, i, n);
    sum += f;
    if (f > 0.98) verified += 1;
    if (i < n - 1 && linkLock(p, i, n) > 0.98) links += 1;
  }
  return { verified, links, integrity: Math.round((sum / n) * 100), stage: Math.min(STAGES - 1, Math.floor(clamp01(p) * STAGES)) };
}

/** Deterministic pseudo-random numbers (mulberry32) so the scattered layout is the same on every visit. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
