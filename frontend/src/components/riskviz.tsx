/* Small SVG visuals for the escalation and compliance pages: ring gauge, donut, risk radar,
   incident stepper, severity heat grid and execution-attempt track. Colours come from the theme
   tokens (via style, since SVG presentation attributes cannot read CSS variables). */
import { motion } from "motion/react";
import { Check, Circle, OctagonX } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/format";
import { EASE } from "../lib/motion";

export type Tone = "primary" | "warning" | "danger" | "info" | "faint";
export const toneColor = (t: Tone, alpha = 1) => `rgb(var(--${t}) / ${alpha})`;
export const riskTone = (pct: number): Tone => (pct >= 50 ? "danger" : pct >= 20 ? "warning" : "primary");

/** Circular progress with a big centre value. `value` is 0–100. */
export function RingGauge({ value, size = 132, stroke = 11, tone, center, sub, track = "rgb(var(--line) / 0.7)" }: { value: number; size?: number; stroke?: number; tone: Tone; center: ReactNode; sub?: ReactNode; track?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} style={{ stroke: track }} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - v / 100) }}
          transition={{ duration: 1, ease: EASE }}
          style={{ stroke: toneColor(tone), filter: `drop-shadow(0 0 6px ${toneColor(tone, 0.35)})` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <div className="text-[26px] font-semibold leading-none tracking-[-0.02em]" style={{ color: toneColor(tone) }}>{center}</div>
        {sub && <div className="mt-1 text-[10.5px] font-medium text-muted">{sub}</div>}
      </div>
    </div>
  );
}

export interface Segment {
  label: string;
  value: number;
  color: string;
}

/** Donut of segments with small gaps between them. */
export function DonutChart({ segments, size = 132, stroke = 16, center, sub }: { segments: Segment[]; size?: number; stroke?: number; center?: ReactNode; sub?: ReactNode }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const gap = total > 0 && segments.filter((s) => s.value > 0).length > 1 ? 3 : 0;
  let offset = 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} style={{ stroke: "rgb(var(--line) / 0.55)" }} />
        {total > 0 &&
          segments.map((s, i) => {
            if (s.value <= 0) return null;
            const len = (s.value / total) * c;
            const dash = Math.max(0, len - gap);
            const el = (
              <motion.circle
                key={s.label}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                strokeWidth={stroke}
                strokeDashoffset={-offset}
                initial={{ strokeDasharray: `0 ${c}` }}
                animate={{ strokeDasharray: `${dash} ${c - dash}` }}
                transition={{ duration: 0.8, delay: i * 0.08, ease: EASE }}
                style={{ stroke: s.color }}
              />
            );
            offset += len;
            return el;
          })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <div className="text-[24px] font-semibold leading-none tracking-[-0.02em] text-fg">{center ?? total}</div>
        {sub && <div className="mt-1 text-[10.5px] font-medium text-muted">{sub}</div>}
      </div>
    </div>
  );
}

export function Legend({ items, className }: { items: Array<{ label: string; value: ReactNode; color: string }>; className?: string }) {
  return (
    <ul className={cx("space-y-1.5", className)}>
      {items.map((it) => (
        <li key={it.label} className="flex items-center justify-between gap-3 text-xs">
          <span className="flex min-w-0 items-center gap-2"><span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: it.color }} /><span className="truncate text-muted">{it.label}</span></span>
          <span className="font-semibold tabular-nums text-fg">{it.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** Spider chart of evaluation-chain stages (values 0–1). Works on light and dark surfaces. */
export function RiskRadar({ stages, size = 220, tone }: { stages: Array<{ name: string; value: number }>; size?: number; tone: Tone }) {
  const n = Math.max(3, stages.length);
  const W = size + 110; // side margins keep left/right axis labels inside the canvas
  const cxy = W / 2;
  const cyy = size / 2;
  const R = size / 2 - 40;
  const pt = (i: number, f: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [cxy + Math.cos(a) * R * f, cyy + Math.sin(a) * R * f] as const;
  };
  const ring = (f: number) => stages.map((_, i) => pt(i, f).join(",")).join(" ");
  const shape = stages.map((s, i) => pt(i, Math.max(0.04, Math.min(1, s.value))).join(",")).join(" ");
  return (
    <svg width={W} height={size} viewBox={`0 0 ${W} ${size}`} className="max-w-full" role="img" aria-label={`Risk by stage: ${stages.map((s) => `${s.name} ${Math.round(s.value * 100)}%`).join(", ")}`}>
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <polygon key={f} points={ring(f)} fill="none" style={{ stroke: "rgb(var(--line-strong) / 0.55)" }} strokeDasharray={f === 1 ? undefined : "2 4"} />
      ))}
      {stages.map((_, i) => {
        const [x, y] = pt(i, 1);
        return <line key={i} x1={cxy} y1={cyy} x2={x} y2={y} style={{ stroke: "rgb(var(--line-strong) / 0.45)" }} />;
      })}
      <motion.polygon
        points={shape}
        initial={{ opacity: 0, scale: 0.4 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.7, ease: EASE }}
        style={{ fill: toneColor(tone, 0.22), stroke: toneColor(tone), strokeWidth: 2, transformOrigin: `${cxy}px ${cyy}px`, filter: `drop-shadow(0 0 8px ${toneColor(tone, 0.35)})` }}
      />
      {stages.map((s, i) => {
        const [x, y] = pt(i, Math.max(0.04, Math.min(1, s.value)));
        const [lx, ly0] = pt(i, 1.18);
        const vertical = Math.abs(lx - cxy) < 8;
        const ly = vertical ? (ly0 > cyy ? ly0 + 2 : ly0 - 12) : ly0 - 6;
        const anchor = Math.abs(lx - cxy) < 8 ? "middle" : lx > cxy ? "start" : "end";
        return (
          <g key={s.name}>
            <circle cx={x} cy={y} r={3.5} style={{ fill: toneColor(s.value >= 0.5 ? "danger" : s.value >= 0.2 ? "warning" : "primary"), stroke: "rgb(var(--surface))" }} strokeWidth={1.5} />
            <text x={lx} y={ly} textAnchor={anchor} dominantBaseline="middle" style={{ fill: "rgb(var(--muted))", fontSize: 10, fontWeight: 600 }}>
              {s.name}
            </text>
            <text x={lx} y={ly + 12} textAnchor={anchor} dominantBaseline="middle" style={{ fill: "rgb(var(--fg))", fontSize: 10.5, fontWeight: 700 }}>{Math.round(s.value * 100)}%</text>
          </g>
        );
      })}
    </svg>
  );
}

export type StepState = "done" | "current" | "todo" | "blocked";

/** Horizontal lifecycle with animated connectors. */
export function Stepper({ steps }: { steps: Array<{ label: string; sub?: string; state: StepState }> }) {
  return (
    <ol className="flex items-start">
      {steps.map((s, i) => {
        const color = s.state === "done" ? "primary" : s.state === "blocked" ? "danger" : s.state === "current" ? "warning" : "faint";
        return (
          <li key={s.label} className="relative flex min-w-0 flex-1 flex-col items-center text-center">
            {i > 0 && (
              <span className="absolute right-1/2 top-[13px] h-[2px] w-full -translate-y-1/2 overflow-hidden rounded-full bg-line" aria-hidden>
                <motion.span
                  className="block h-full origin-left"
                  style={{ background: toneColor(steps[i - 1].state === "done" ? (s.state === "todo" ? "faint" : color) : "faint", steps[i - 1].state === "done" ? 1 : 0.4) }}
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: steps[i - 1].state === "done" ? 1 : 0 }}
                  transition={{ duration: 0.5, delay: i * 0.15, ease: EASE }}
                />
              </span>
            )}
            <motion.span
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.3, delay: i * 0.15 }}
              className={cx("relative z-10 flex h-[26px] w-[26px] items-center justify-center rounded-full border-2 bg-surface", s.state === "current" && "shadow-[0_0_0_4px_rgb(var(--warning)/0.15)]")}
              style={{ borderColor: toneColor(color) }}
            >
              {s.state === "done" ? <Check className="h-3.5 w-3.5" style={{ color: toneColor("primary") }} /> : s.state === "blocked" ? <OctagonX className="h-3.5 w-3.5" style={{ color: toneColor("danger") }} /> : <Circle className="h-2 w-2" style={{ color: toneColor(color), fill: s.state === "current" ? toneColor(color) : "none" }} />}
            </motion.span>
            <span className={cx("mt-1.5 text-[11px] font-semibold", s.state === "todo" ? "text-faint" : "text-fg")}>{s.label}</span>
            {s.sub && <span className="mt-0.5 line-clamp-2 px-1 text-[10px] leading-tight text-muted">{s.sub}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** Counts by row × column, with cell intensity proportional to the count. */
export function HeatGrid({ rows, cols, count, onPick, picked }: { rows: Array<{ id: string; label: string; tone: Tone }>; cols: Array<{ id: string; label: string }>; count: (row: string, col: string) => number; onPick?: (row: string, col: string) => void; picked?: string | null }) {
  const max = Math.max(1, ...rows.flatMap((r) => cols.map((c) => count(r.id, c.id))));
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-1 text-[10.5px]">
        <thead>
          <tr>
            <th />
            {cols.map((c) => <th key={c.id} className="px-0.5 pb-0.5 text-center font-semibold text-muted">{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <th className="pr-1.5 text-left font-semibold capitalize text-muted">{r.label}</th>
              {cols.map((c) => {
                const v = count(r.id, c.id);
                const key = `${r.id}:${c.id}`;
                return (
                  <td key={c.id} className="p-0">
                    <button
                      disabled={!v || !onPick}
                      onClick={() => onPick?.(r.id, c.id)}
                      aria-label={`${v} ${r.label} ${c.label}`}
                      className={cx("flex h-8 w-full min-w-[34px] items-center justify-center rounded-md text-[11px] font-bold transition-transform duration-200", v ? "cursor-pointer hover:scale-[1.06]" : "cursor-default", picked === key && "ring-2 ring-fg")}
                      style={{ background: v ? toneColor(r.tone, 0.18 + 0.62 * (v / max)) : "rgb(var(--subtle))", color: v ? (v / max > 0.55 ? "white" : toneColor(r.tone)) : "rgb(var(--faint))" }}
                    >
                      {v || "·"}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Tiny trend line with a soft area fill. */
export function Sparkline({ values, tone, width = 96, height = 30 }: { values: number[]; tone: Tone; width?: number; height?: number }) {
  if (values.length < 2) return <span className="inline-block" style={{ width, height }} />;
  const max = Math.max(...values, 1e-9);
  const min = Math.min(...values, 0);
  const x = (i: number) => (i / (values.length - 1)) * (width - 4) + 2;
  const y = (v: number) => height - 3 - ((v - min) / (max - min || 1)) * (height - 6);
  const line = values.map((v, i) => `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} aria-hidden className="overflow-visible">
      <path d={`${line} L ${x(values.length - 1)} ${height} L ${x(0)} ${height} Z`} style={{ fill: toneColor(tone, 0.14) }} />
      <motion.path d={line} fill="none" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.9, ease: EASE }} style={{ stroke: toneColor(tone) }} />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={2.4} style={{ fill: toneColor(tone) }} />
    </svg>
  );
}
