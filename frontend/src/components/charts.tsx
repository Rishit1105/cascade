import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { cx } from "../lib/format";

/** Semicircle gauge (0–100). Used for the connection index, never as an opaque "risk score". */
export function Gauge({ value, label, sublabel, size = 180, higherIsBetter }: { value: number; label: string; sublabel?: string; size?: number; higherIsBetter?: boolean }) {
  const v = Math.max(0, Math.min(100, value));
  const r = size / 2 - 14;
  const cx0 = size / 2;
  const cy0 = size / 2;
  const angle = Math.PI * (1 - v / 100);
  const nx = cx0 + r * 0.82 * Math.cos(angle);
  const ny = cy0 - r * 0.82 * Math.sin(angle);
  const arc = (from: number, to: number) => {
    const a0 = Math.PI * (1 - from / 100);
    const a1 = Math.PI * (1 - to / 100);
    return `M ${cx0 + r * Math.cos(a0)} ${cy0 - r * Math.sin(a0)} A ${r} ${r} 0 0 1 ${cx0 + r * Math.cos(a1)} ${cy0 - r * Math.sin(a1)}`;
  };
  const [low, high] = higherIsBetter ? ["danger", "primary"] : ["primary", "danger"];
  const risk = higherIsBetter ? 100 - v : v;
  const tone = risk >= 60 ? "text-danger" : risk >= 30 ? "text-warning" : "text-primary";
  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size / 2 + 18} viewBox={`0 0 ${size} ${size / 2 + 18}`} role="img" aria-label={`${label}: ${v} of 100`}>
        <path d={arc(0, 33)} stroke={`rgb(var(--${low}))`} strokeWidth={12} fill="none" strokeLinecap="round" opacity={0.85} />
        <path d={arc(35, 63)} stroke="rgb(var(--warning))" strokeWidth={12} fill="none" opacity={0.85} />
        <path d={arc(65, 100)} stroke={`rgb(var(--${high}))`} strokeWidth={12} fill="none" strokeLinecap="round" opacity={0.85} />
        <line x1={cx0} y1={cy0} x2={nx} y2={ny} stroke="rgb(var(--fg))" strokeWidth={3} strokeLinecap="round" />
        <circle cx={cx0} cy={cy0} r={6} fill="rgb(var(--fg))" />
        <text x={14} y={cy0 + 16} className="fill-muted text-[10px]">0</text>
        <text x={size - 14} y={cy0 + 16} textAnchor="end" className="fill-muted text-[10px]">100</text>
      </svg>
      <p className={cx("-mt-1 text-[22px] font-semibold leading-none", tone)}>{v}</p>
      <p className="mt-1 text-xs font-medium text-fg">{label}</p>
      {sublabel && <p className="text-2xs text-muted">{sublabel}</p>}
    </div>
  );
}

export const VOTE_COLORS = { for: "rgb(var(--primary))", against: "rgb(var(--danger))", abstain: "rgb(var(--faint))" } as const;

export function Donut({ data, center, sub, height = 200, half }: { data: Array<{ name: string; value: number; color: string }>; center?: string; sub?: string; height?: number; half?: boolean }) {
  const total = data.reduce((a, b) => a + b.value, 0);
  return (
    <div className="relative" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={total ? data : [{ name: "none", value: 1, color: "rgb(var(--subtle))" }]}
            dataKey="value"
            innerRadius={half ? "62%" : "64%"}
            outerRadius={half ? "100%" : "92%"}
            startAngle={half ? 180 : 90}
            endAngle={half ? 0 : -270}
            cy={half ? "85%" : "50%"}
            stroke="rgb(var(--surface))"
            strokeWidth={2}
            isAnimationActive={false}
          >
            {(total ? data : [{ color: "rgb(var(--subtle))" }]).map((d, i) => (
              <Cell key={i} fill={d.color} />
            ))}
          </Pie>
          {total > 0 && <Tooltip formatter={(v: number, n: string) => [`${((v / total) * 100).toFixed(1)}%`, n]} />}
        </PieChart>
      </ResponsiveContainer>
      {center && (
        <div className={cx("pointer-events-none absolute inset-x-0 flex flex-col items-center", half ? "bottom-[12%]" : "top-1/2 -translate-y-1/2")}>
          <span className="text-lg font-semibold text-fg">{center}</span>
          {sub && <span className="text-2xs text-muted">{sub}</span>}
        </div>
      )}
    </div>
  );
}
