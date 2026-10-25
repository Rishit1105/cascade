/* Adapter from the treasury surface API (base-unit strings) to what the 3D view needs.
   Comparisons and differences stay in BigInt base units; numbers are produced only for
   placing geometry. No dependencies, so it can be tested directly with Node. */

export interface SurfaceRow {
  overrun_pct: number;
  amount_base: string;
  after_base: string[];
}

export interface SurfaceData {
  months: number[];
  before_base: string[];
  rows: SurfaceRow[];
  params: { amount_base: string; release: string; horizon: number };
  balance_base: string;
  available_before_base: string;
  net_monthly_burn_base: string;
  schedule_issues: string[];
  value_label: string;
  overrun_note: string;
  block_number: number;
  as_of: string;
}

const UNIT = 1_000_000; // mUSDC has 6 decimals

/** Base units to token units, for geometry only (exact for any realistic treasury size). */
export const toUnits = (base: string | bigint): number => Number(BigInt(base)) / UNIT;

/** Token units typed by a person ("250000", "1,500.5") to base units; null when invalid. */
export function unitsToBase(input: string): bigint | null {
  const clean = input.replace(/[,_\s]/g, "");
  const m = /^(-?)(\d+)(?:\.(\d{0,6}))?$/.exec(clean);
  if (!m) return null;
  const v = BigInt(m[2]) * BigInt(UNIT) + BigInt((m[3] ?? "").padEnd(6, "0") || "0");
  return m[1] ? -v : v;
}

/** First month whose projected balance is strictly below the threshold, or null within the horizon. */
export function firstBelow(values: string[], months: number[], thresholdBase: bigint): number | null {
  for (let i = 0; i < values.length; i++) if (BigInt(values[i]) < thresholdBase) return months[i];
  return null;
}

export function rowFor(data: SurfaceData, overrunPct: number): SurfaceRow | undefined {
  return data.rows.find((r) => r.overrun_pct === overrunPct);
}

export interface MonthDetail {
  month: number;
  overrunPct: number;
  afterBase: string;
  beforeBase: string;
  /** with-proposal minus without-proposal: the payouts made by this month under the model */
  differenceBase: string;
  belowThreshold: boolean;
}

export function monthDetail(data: SurfaceData, overrunPct: number, month: number, thresholdBase: bigint): MonthDetail | null {
  const row = rowFor(data, overrunPct);
  const i = data.months.indexOf(month);
  if (!row || i < 0) return null;
  const after = BigInt(row.after_base[i]);
  const before = BigInt(data.before_base[i]);
  return { month, overrunPct, afterBase: after.toString(), beforeBase: before.toString(), differenceBase: (after - before).toString(), belowThreshold: after < thresholdBase };
}

/** True when the surface was calculated for exactly these inputs (guards against showing a stale result). */
export function isCurrent(data: SurfaceData | undefined, wanted: { amountBase: string; release: string; horizon: number }): boolean {
  return !!data && data.params.amount_base === wanted.amountBase && data.params.release === wanted.release && data.params.horizon === wanted.horizon;
}

/** Round tick values covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

export const compactUnits = (v: number): string => {
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 1e6) return `${sign}${Number((a / 1e6).toFixed(2))}M`;
  if (a >= 1e3) return `${sign}${Math.round(a / 1e3)}k`;
  return `${sign}${Math.round(a)}`;
};
