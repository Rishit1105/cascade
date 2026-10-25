/* Formatting helpers. Token amounts arrive as base-unit strings and are formatted with BigInt,
   never through floating point. */

export function formatUnits(base: string | number | bigint | null | undefined, decimals = 6, places = 2): string {
  if (base === null || base === undefined || base === "") return "—";
  let v: bigint;
  try {
    v = BigInt(base);
  } catch {
    return String(base);
  }
  const neg = v < 0n;
  if (neg) v = -v;
  const scale = 10n ** BigInt(decimals);
  let whole = v / scale;
  const frac = v % scale;
  let fracStr = "";
  if (places > 0) {
    // Round the fractional part to `places` digits, half-up.
    let scaled = decimals > places ? (frac + 10n ** BigInt(decimals - places) / 2n) / 10n ** BigInt(decimals - places) : frac * 10n ** BigInt(places - decimals);
    const limit = 10n ** BigInt(places);
    if (scaled >= limit) {
      whole += 1n;
      scaled -= limit;
    }
    fracStr = scaled.toString().padStart(places, "0").replace(/0+$/, "");
  } else if (frac * 2n >= scale) {
    whole += 1n;
  }
  return `${neg ? "−" : ""}${whole.toLocaleString("en-US")}${fracStr ? "." + fracStr : ""}`;
}

export const usdc = (base: string | number | bigint | null | undefined, places = 0) => `${formatUnits(base, 6, places)} mUSDC`;
export const atlas = (base: string | number | bigint | null | undefined) => `${formatUnits(base, 18, 0)} ATLAS`;

export function compactUsdc(base: string | null | undefined): string {
  if (!base) return "—";
  const v = Number(BigInt(base) / 1_000_000n);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
  return v.toLocaleString("en-US");
}

export function shortAddr(a?: string | null): string {
  if (!a) return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function shortHash(h?: string | null, head = 10, tail = 6): string {
  if (!h) return "—";
  const clean = h.startsWith("sha256:") ? h.slice(7) : h;
  const prefix = h.startsWith("sha256:") ? "sha256:" : "";
  if (clean.length <= head + tail + 1) return h;
  return `${prefix}${clean.slice(0, head)}…${clean.slice(-tail)}`;
}

export function timeAgo(iso?: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  const m = 60_000;
  const h = 60 * m;
  const d = 24 * h;
  const fmt = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  let s: string;
  if (abs < m) s = "just now";
  else if (abs < h) s = fmt(Math.round(abs / m), "min");
  else if (abs < d) s = fmt(Math.round(abs / h), "hour");
  else s = fmt(Math.round(abs / d), "day");
  if (s === "just now") return s;
  return diff >= 0 ? `${s} ago` : `in ${s}`;
}

export function dateTime(iso?: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function dateOnly(iso?: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function pct(v: number, digits = 0): string {
  return `${(v * 100).toFixed(digits)}%`;
}

export function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  in_review: "In review",
  committed: "Committed",
  voting: "Voting",
  approved: "Approved",
  executed: "Executed",
  halted: "Halted",
  defeated: "Defeated",
};

/** The OpenZeppelin Governor calls a proposal "Executed" once its action ran, which here only
    records the manifest approval on the guard. Say that, so it is not read as funds moving. */
export function govStateLabel(state?: string): string {
  if (state === "Executed") return "Passed · approval recorded";
  if (state === "Succeeded") return "Passed · awaiting finalization";
  return state ?? "—";
}
