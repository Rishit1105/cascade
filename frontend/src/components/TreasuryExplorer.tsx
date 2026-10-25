/* 3D treasury impact explorer: HTML controls and numbers around the lazy-loaded WebGL surface.
   All values come from GET /proposals/{id}/treasury/surface, which runs the same model as the
   2D projection for every overrun scenario. Primary information never depends on the canvas. */
import { Component, lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Move3d, RotateCcw } from "lucide-react";
import { api, qs } from "../lib/api";
import { useApp } from "../lib/app";
import { cx, formatUnits } from "../lib/format";
import { firstBelow, isCurrent, monthDetail, rowFor, toUnits, unitsToBase, type SurfaceData } from "../lib/surface";
import { Badge, Button, Callout } from "./ui";

const TreasurySurface3D = lazy(() => import("./TreasurySurface3D"));
const OVERRUNS = Array.from({ length: 13 }, (_, i) => i * 5); // the overrun slider's own values: 0, 5 … 60 %

class SceneBoundary extends Component<{ onError: (m: string) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    this.props.onError(`The 3D view failed to start (${error.message}).`);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const m = (base: string | bigint) => `${formatUnits(base, 6, 0)} mUSDC`;

export interface ExplorerProps {
  pid: string;
  amount: string | undefined;
  overrun: number;
  release: "lump" | "milestones";
  horizon: number;
  requestedBase: string;
  runwayBefore: string | null;
  runwayAfter: string | null;
  onUnavailable: (reason: string) => void;
}

export function TreasuryExplorer({ pid, amount, overrun, release, horizon, requestedBase, runwayBefore, runwayAfter, onUnavailable }: ExplorerProps) {
  const { theme } = useApp();
  const params = { amount, release, horizon, overruns: OVERRUNS.join(",") };
  // Under the "treasury" key so it refreshes with the 2D projection whenever chain data changes.
  const s = useQuery({
    queryKey: ["treasury", pid, "surface", params],
    queryFn: () => api.get<SurfaceData>(`/proposals/${pid}/treasury/surface${qs(params)}`),
    placeholderData: (prev) => prev,
  });
  const current = !s.isPlaceholderData && isCurrent(s.data, { amountBase: amount ?? requestedBase, release, horizon });
  const data = s.data;

  const [month, setMonth] = useState(Math.min(12, horizon));
  useEffect(() => setMonth((x) => Math.min(x, horizon)), [horizon]);
  const [thresholdText, setThresholdText] = useState("0");
  const parsed = unitsToBase(thresholdText);
  const [thresholdBase, setThresholdBase] = useState(0n);
  useEffect(() => {
    if (parsed !== null) setThresholdBase(parsed);
  }, [parsed]);
  const [resetKey, setResetKey] = useState(0);

  const geo = useMemo(
    () =>
      data && {
        months: data.months,
        overruns: data.rows.map((r) => r.overrun_pct),
        after: data.rows.map((r) => r.after_base.map(toUnits)),
        before: data.before_base.map(toUnits),
      },
    [data],
  );
  const row = data ? rowFor(data, overrun) : undefined;
  const selectedRow = data ? data.rows.findIndex((r) => r.overrun_pct === overrun) : -1;
  const monthIndex = data ? Math.max(0, data.months.indexOf(Math.min(month, data.months[data.months.length - 1]))) : 0;
  const detail = data ? monthDetail(data, overrun, data.months[monthIndex], thresholdBase) : null;
  const crossing = row && data ? firstBelow(row.after_base, data.months, thresholdBase) : null;
  const threshold = toUnits(thresholdBase);

  if (s.error) return <Callout tone="danger" title="Projection unavailable">{(s.error as Error).message}</Callout>;
  if (!data || !geo) return <div className="flex h-[440px] items-center justify-center text-sm text-muted"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Calculating scenarios…</div>;
  if (data.schedule_issues.length > 0)
    return (
      <Callout tone="warning" title="Milestone schedule incomplete">
        {data.schedule_issues.join(" ")} The 3D view only plots configured milestone timing and amounts, so it is not shown for this release type. Choose “Lump sum”, or add month and amount to every milestone.
      </Callout>
    );
  if (selectedRow < 0) return <Callout tone="warning">The selected overrun ({overrun}%) is not one of the calculated scenarios.</Callout>;

  return (
    <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0">
        <div className="relative h-[460px] overflow-hidden rounded-xl border border-line bg-gradient-to-b from-subtle/40 to-surface" aria-label="3D projection of available treasury balance by month and cost overrun">
          <SceneBoundary onError={onUnavailable}>
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading 3D view…</div>}>
              <TreasurySurface3D
                months={geo.months}
                overruns={geo.overruns}
                after={geo.after}
                before={geo.before}
                selectedRow={selectedRow}
                monthIndex={monthIndex}
                threshold={threshold}
                crossingIndex={crossing === null ? null : data.months.indexOf(crossing)}
                theme={theme}
                resetKey={resetKey}
                onError={onUnavailable}
              />
            </Suspense>
          </SceneBoundary>
          <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap items-center gap-1.5">
            <Badge tone="info">Projection</Badge>
            <span className="rounded-md bg-surface/80 px-1.5 py-[1px] text-2xs font-medium text-muted">Y: available balance (mUSDC) · X: month · Z: cost overrun</span>
            {!current && <Badge tone="warning" icon={<Loader2 className="h-3 w-3 animate-spin" />}>Updating, showing the previous inputs</Badge>}
          </div>
          <div className="absolute right-3 top-3">
            <Button size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => setResetKey((k) => k + 1)}>Reset camera</Button>
          </div>
          <p className="pointer-events-none absolute bottom-2.5 left-3 flex items-center gap-1.5 text-2xs text-muted"><Move3d className="h-3.5 w-3.5" /> Drag to orbit · scroll to zoom</p>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <label htmlFor="inspect-month" className="shrink-0 text-xs font-medium">Inspect month</label>
          <input id="inspect-month" type="range" className="w-full accent-[rgb(var(--primary))]" min={0} max={horizon} step={1} value={Math.min(month, horizon)} onChange={(e) => setMonth(Number(e.target.value))} aria-valuetext={`Month ${month}`} />
          <span className="w-[72px] shrink-0 text-right font-mono text-sm font-semibold">Month {Math.min(month, horizon)}</span>
        </div>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-2xs text-muted" aria-label="Legend">
          <li className="flex items-center gap-1.5"><span className="h-[3px] w-5 rounded bg-[#0b2fe0] dark:bg-[#b9ccff]" /> With proposal · {overrun}% overrun (selected)</li>
          <li className="flex items-center gap-1.5"><span className="h-[2px] w-5 rounded bg-[#0e1c33] dark:bg-[#efe8d6]" /> Before proposal (reference, same plane)</li>
          <li className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm bg-[#7d9cff]/70" /> Scenario surface (0–60% overrun)</li>
          <li className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm border border-[#d48a12] bg-[#d48a12]/25" /> Exploration threshold</li>
          <li className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm bg-[#e5484d]/70" /> Below threshold</li>
          <li className="flex items-center gap-1.5"><span className="h-2.5 w-1 rounded-sm bg-[#2a52ff]/50" /> Month slice</li>
        </ul>
      </div>

      <aside className="grid min-w-0 content-start gap-3 md:grid-cols-3 2xl:grid-cols-1">
        <div className={cx("rounded-xl border p-3.5", detail?.belowThreshold ? "border-danger/40 bg-danger/[0.04]" : "border-line bg-surface")} aria-live="polite">
          <p className="label">Month {detail?.month} · {overrun}% overrun</p>
          <p className="mt-1.5 text-2xs font-medium text-muted">Projected available balance, with proposal</p>
          <p className={cx("font-mono text-[26px] font-semibold leading-tight tracking-[-0.02em]", detail && BigInt(detail.afterBase) < 0n ? "text-danger" : "text-fg")}>{detail ? formatUnits(detail.afterBase, 6, 0) : "—"}</p>
          <p className="text-2xs text-muted">mUSDC</p>
          <dl className="mt-3 space-y-1.5 text-xs">
            <div className="flex justify-between gap-2"><dt className="text-muted">Before proposal</dt><dd className="font-mono font-medium">{detail ? m(detail.beforeBase) : "—"}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted">Difference from the proposal</dt><dd className="font-mono font-medium text-danger">{detail ? m(detail.differenceBase) : "—"}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted">Grant at this overrun</dt><dd className="font-mono">{row ? m(row.amount_base) : "—"}</dd></div>
          </dl>
          <p className="mt-2 text-2xs text-muted">The difference is the payouts made by this month under the model.</p>
        </div>

        <div className="rounded-xl border border-line p-3.5">
          <label htmlFor="threshold" className="text-xs font-semibold">Exploration threshold</label>
          <p className="text-2xs text-muted">Not a DAO policy: no liquidity threshold is configured. Starts at 0 (fully committed).</p>
          <div className="mt-2 flex items-center gap-2">
            <input id="threshold" className={cx("input font-mono", parsed === null && "border-danger")} inputMode="decimal" value={thresholdText} onChange={(e) => setThresholdText(e.target.value)} aria-invalid={parsed === null} />
            <span className="text-xs text-muted">mUSDC</span>
          </div>
          {parsed === null && <p className="mt-1 text-2xs text-danger">Enter an amount such as 500000 (up to 6 decimals).</p>}
          <p className={cx("mt-2.5 flex items-start gap-1.5 text-sm font-medium", crossing !== null ? "text-danger" : "text-primary")}>
            {crossing !== null && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            {crossing === null ? "Not reached within the selected horizon." : crossing === 0 ? "Already below the threshold at month 0." : `First below the threshold in month ${crossing}.`}
          </p>
          <p className="mt-0.5 text-2xs text-muted">For the selected {overrun}% scenario, at monthly resolution.</p>
        </div>

        <div className="rounded-xl border border-line p-3.5 text-xs">
          <div className="flex justify-between gap-2"><span className="text-muted">Treasury balance (on-chain)</span><span className="font-mono font-medium">{m(data.balance_base)}</span></div>
          <div className="mt-1 flex justify-between gap-2"><span className="text-muted">Available before (after commitments)</span><span className="font-mono">{m(data.available_before_base)}</span></div>
          <div className="mt-1 flex justify-between gap-2"><span className="text-muted">Net monthly burn (inputs)</span><span className="font-mono">{m(data.net_monthly_burn_base)}</span></div>
          <div className="mt-1 flex justify-between gap-2"><span className="text-muted">Runway (model)</span><span className="font-mono font-medium">{runwayBefore ?? "—"} → {runwayAfter ?? "—"} mo</span></div>
          <p className="mt-2 text-2xs text-muted">Block #{data.block_number}. {data.value_label} {data.overrun_note} A projection from the inputs, not a forecast or a probability.</p>
        </div>
      </aside>
    </div>
  );
}
