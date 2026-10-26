/* Dark lane graph of the audit ledger. Each lane is a proposal; a thread runs through every event
   in ledger order, which is the hash chain itself. Tie a "string" between any two events by
   dragging from one to the other (or with Link mode, or Shift+click): DAOGuard explains what joins
   them and can re-verify every hash link in between on the server. */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Cable, CheckCircle2, Hand, Link2, Maximize2, MessageSquareText, Minus, MousePointerClick, Plus, Spline, Trash2, Unlink, Waypoints, X, XCircle } from "lucide-react";
import { api, type AuditEvent } from "../lib/api";
import { analyse, describeGap, exampleTies, laneOf, lanesFor, suggestions, tieKey, type StringTie, type Trait } from "../lib/ledger";
import { cx, dateTime, titleCase } from "../lib/format";
import { EASE } from "../lib/motion";
import { useAssistant } from "./Assistant";

const LANE_H = 56;
const TOP = 40;
const PAD = 34;
const BOTTOM = 14;
const STORE = "daoguard.ledger.strings";
const MAX_STRINGS = 16;

const STATUS: Record<AuditEvent["status"], string> = { success: "rgb(var(--primary))", failure: "rgb(var(--danger))", warning: "rgb(var(--warning))", info: "rgb(var(--info))" };
const STRING_COLORS = ["#38D6AC", "#78A6F0", "#F2B44C", "#B48CFA", "#F472B6", "#5EEAD4"];
const LANE_ACCENT = ["#B48CFA", "#78A6F0", "#38D6AC", "#F472B6", "#F2B44C", "#94A3B8"];
const STRENGTH = { direct: { label: "Direct link", color: "#38D6AC" }, related: { label: "Related", color: "#F2B44C" }, chain: { label: "Hash chain only", color: "#94A3B8" } } as const;

type Point = { x: number; y: number };

function loadTies(): StringTie[] | null {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as StringTie[]) : null;
  } catch {
    return null;
  }
}

function saveTies(ties: StringTie[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(ties));
  } catch {
    /* storage unavailable: strings last for this visit only */
  }
}

/** Quadratic arc lifted above the higher endpoint; returns the path and its midpoint. */
function arc(p: Point, q: Point) {
  const lift = Math.min(96, 26 + Math.abs(q.x - p.x) * 0.2);
  const c = { x: (p.x + q.x) / 2, y: Math.min(p.y, q.y) - lift };
  const mid = { x: 0.25 * p.x + 0.5 * c.x + 0.25 * q.x, y: 0.25 * p.y + 0.5 * c.y + 0.25 * q.y };
  return { d: `M ${p.x} ${p.y} Q ${c.x} ${c.y} ${q.x} ${q.y}`, mid };
}

const shortDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function LedgerGraph({ events, selected, onSelect }: { events: AuditEvent[]; selected: string | null; onSelect: (id: string | null) => void }) {
  const uid = useId().replace(/:/g, "");
  const scrollRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [spacing, setSpacing] = useState(26);
  const [showChain, setShowChain] = useState(true);
  const [linkMode, setLinkMode] = useState(false);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [stored] = useState(loadTies);
  const [ties, setTies] = useState<StringTie[]>(stored ?? []);
  const [active, setActive] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: string; at: Point; moved: boolean; target: string | null; shift: boolean } | null>(null);
  const [view, setView] = useState({ left: 0, width: 1 });
  const anchorRatio = useRef<number | null>(null);
  const seeded = useRef(stored !== null);

  const chrono = useMemo(() => [...events].sort((a, b) => a.seq - b.seq), [events]);
  const byId = useMemo(() => new Map(chrono.map((e) => [e.id, e])), [chrono]);
  const lanes = useMemo(() => lanesFor(chrono), [chrono]);
  const laneIdx = useMemo(() => new Map(lanes.map((l, i) => [l.id, i])), [lanes]);
  const pos = useMemo(
    () => new Map(chrono.map((e, i) => [e.id, { x: PAD + i * spacing, y: TOP + (laneIdx.get(laneOf(e)) ?? 0) * LANE_H + LANE_H / 2 }])),
    [chrono, laneIdx, spacing],
  );
  const W = PAD * 2 + Math.max(0, chrono.length - 1) * spacing;
  const H = TOP + lanes.length * LANE_H + BOTTOM;

  // First visit: tie two example strings so the idea is visible before anyone drags.
  useEffect(() => {
    if (!seeded.current && chrono.length > 1) {
      seeded.current = true;
      const ex = exampleTies(chrono);
      setTies(ex);
      if (ex[0]) setActive(tieKey(ex[0].a, ex[0].b));
    }
  }, [chrono]);
  useEffect(() => {
    if (seeded.current) saveTies(ties);
  }, [ties]);

  // Start at the newest events; keep the centre steady when zooming.
  const started = useRef(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || chrono.length === 0) return;
    if (!started.current) {
      started.current = true;
      el.scrollLeft = el.scrollWidth;
    } else if (anchorRatio.current !== null) {
      el.scrollLeft = anchorRatio.current * W - el.clientWidth / 2;
      anchorRatio.current = null;
    }
    setView({ left: el.scrollLeft, width: el.clientWidth });
  }, [W, chrono.length]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView({ left: el.scrollLeft, width: el.clientWidth }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Opening a string brings it into view when either end is off-screen.
  useEffect(() => {
    const el = scrollRef.current;
    const [a, b] = active?.split("|") ?? [];
    const p = a && pos.get(a);
    const q = b && pos.get(b);
    if (!el || !p || !q) return;
    const lo = Math.min(p.x, q.x) - 40;
    const hi = Math.max(p.x, q.x) + 40;
    if (lo >= el.scrollLeft && hi <= el.scrollLeft + el.clientWidth) return;
    el.scrollTo({ left: (lo + hi) / 2 - el.clientWidth / 2, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const zoom = (factor: number | "fit") => {
    const el = scrollRef.current;
    if (!el) return;
    anchorRatio.current = (el.scrollLeft + el.clientWidth / 2) / Math.max(1, W);
    if (factor === "fit") setSpacing(Math.max(9, Math.min(60, (el.clientWidth - PAD * 2) / Math.max(1, chrono.length - 1))));
    else setSpacing((s) => Math.max(9, Math.min(72, s * factor)));
  };

  const days = useMemo(() => {
    const out: Array<{ x: number; label: string; show: boolean }> = [];
    let lastLabel = -Infinity;
    chrono.forEach((e, i) => {
      if (i > 0 && e.occurred_at.slice(0, 10) === chrono[i - 1].occurred_at.slice(0, 10)) return;
      const x = i === 0 ? PAD - Math.min(spacing / 2, PAD - 4) : PAD + (i - 0.5) * spacing;
      const show = x - lastLabel > 54;
      if (show) lastLabel = x;
      out.push({ x, label: shortDay(e.occurred_at), show });
    });
    return out;
  }, [chrono, spacing]);

  const chainPath = useMemo(() => {
    let d = "";
    chrono.forEach((e, i) => {
      const p = pos.get(e.id)!;
      if (i === 0) d += `M ${p.x} ${p.y}`;
      else {
        const q = pos.get(chrono[i - 1].id)!;
        const mx = (p.x + q.x) / 2;
        d += ` C ${mx} ${q.y}, ${mx} ${p.y}, ${p.x} ${p.y}`;
      }
    });
    return d;
  }, [chrono, pos]);

  const sel = selected ? byId.get(selected) ?? null : null;
  const suggested = useMemo(() => (sel ? suggestions(sel, chrono) : []), [sel, chrono]);
  const focusSet = useMemo(() => (sel && !drag ? new Set([sel.id, ...suggested.map((s) => s.event.id)]) : null), [sel, suggested, drag]);
  const visibleTies = ties.filter((t) => byId.has(t.a) && byId.has(t.b));
  const hiddenTies = ties.length - visibleTies.length;
  const activeTie = visibleTies.find((t) => tieKey(t.a, t.b) === active) ?? null;

  const tie = (a: string, b: string) => {
    if (a === b) return;
    const key = tieKey(a, b);
    setActive(key);
    setTies((prev) => {
      if (prev.some((t) => tieKey(t.a, t.b) === key)) return prev;
      const color = prev.length ? (prev[prev.length - 1].color + 1) % STRING_COLORS.length : 0;
      return [...prev, { a, b, color }].slice(-MAX_STRINGS);
    });
  };
  const untie = (key: string) => {
    setTies((prev) => prev.filter((t) => tieKey(t.a, t.b) !== key));
    setActive((k) => (k === key ? null : k));
  };

  const click = (id: string, shift: boolean) => {
    if (linkMode) {
      if (!linkFrom) setLinkFrom(id);
      else if (linkFrom !== id) {
        tie(linkFrom, id);
        setLinkFrom(null);
      } else setLinkFrom(null);
      return;
    }
    if (shift && selected && selected !== id) {
      tie(selected, id);
      return;
    }
    setActive(null);
    onSelect(selected === id ? null : id);
  };

  const local = (ev: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const nearest = (p: Point, exclude: string) => {
    let best: string | null = null;
    let bd = 20 * 20;
    for (const [id, q] of pos) {
      if (id === exclude) continue;
      const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
    return best;
  };
  const onNodeDown = (ev: RPointerEvent, id: string) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    svgRef.current?.setPointerCapture(ev.pointerId);
    setDrag({ from: id, at: local(ev), moved: false, target: null, shift: ev.shiftKey });
  };
  const onMove = (ev: RPointerEvent) => {
    if (!drag) return;
    const at = local(ev);
    const start = pos.get(drag.from)!;
    const moved = drag.moved || Math.hypot(at.x - start.x, at.y - start.y) > 8;
    setDrag({ ...drag, at, moved, target: moved ? nearest(at, drag.from) : null });
  };
  const onUp = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.moved) {
      if (d.target) tie(d.from, d.target);
    } else click(d.from, d.shift);
  };
  const onNodeKey = (ev: RKeyboardEvent, id: string) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      click(id, ev.shiftKey);
    }
  };

  const hovered = hover && !drag ? byId.get(hover) : null;
  const hp = hovered ? pos.get(hovered.id)! : null;
  const n = chrono.length;

  return (
    <section className="viz overflow-hidden rounded-xl shadow-card" aria-label="Audit ledger graph">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[13.5px] font-semibold"><Waypoints className="h-4 w-4 text-primary" /> Ledger constellation</p>
          <p className="mt-0.5 text-2xs text-muted">{n} events · the thread is the hash chain · drag from one event to another to tie a string</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Graph controls">
          <ToolButton on={showChain} onClick={() => setShowChain((v) => !v)} icon={<Spline className="h-3.5 w-3.5" />} label="Hash thread" />
          <ToolButton on={linkMode} onClick={() => { setLinkMode((v) => !v); setLinkFrom(null); }} icon={<Cable className="h-3.5 w-3.5" />} label={linkMode ? (linkFrom ? "Pick 2nd event" : "Pick 1st event") : "Link mode"} />
          <span className="mx-1 h-5 w-px bg-white/10" />
          <IconButton label="Zoom out" onClick={() => zoom(1 / 1.35)}><Minus className="h-3.5 w-3.5" /></IconButton>
          <IconButton label="Zoom in" onClick={() => zoom(1.35)}><Plus className="h-3.5 w-3.5" /></IconButton>
          <IconButton label="Fit all events" onClick={() => zoom("fit")}><Maximize2 className="h-3.5 w-3.5" /></IconButton>
          {visibleTies.length > 0 && (
            <IconButton label="Remove all strings" onClick={() => { setTies([]); setActive(null); }}><Unlink className="h-3.5 w-3.5" /></IconButton>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-2.5 text-[10.5px] text-muted">
        {(["success", "warning", "failure", "info"] as const).map((s) => (
          <span key={s} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: STATUS[s] }} />{s}</span>
        ))}
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full border border-primary/70" />chain-confirmed</span>
        <span className="flex items-center gap-1.5"><span className="h-[2px] w-4 rounded-full bg-[#78A6F0] shadow-[0_0_6px_#78A6F0]" />your strings</span>
      </div>

      <div className="grid grid-cols-[96px_minmax(0,1fr)]">
        <div className="relative" style={{ height: H }} aria-hidden>
          {lanes.map((l, i) => (
            <div key={l.id} className="absolute left-0 right-0 flex items-center gap-2 pl-4" style={{ top: TOP + i * LANE_H, height: LANE_H }}>
              <span className="h-6 w-[3px] rounded-full" style={{ background: LANE_ACCENT[i % LANE_ACCENT.length] }} />
              <span className="min-w-0">
                <span className="block font-mono text-[11px] font-semibold text-fg">{l.label}</span>
                <span className="block text-[10px] text-faint">{l.count} event{l.count === 1 ? "" : "s"}</span>
              </span>
            </div>
          ))}
        </div>
        <div
          ref={scrollRef}
          id="ledger-graph"
          className="relative overflow-x-auto overflow-y-hidden scroll-thin"
          onScroll={(e) => setView({ left: e.currentTarget.scrollLeft, width: e.currentTarget.clientWidth })}
          onKeyDown={(e) => { if (e.key === "Escape") { setDrag(null); setLinkFrom(null); } }}
        >
          <div className="relative" style={{ width: W, height: H }}>
            <svg
              ref={svgRef}
              width={W}
              height={H}
              className={cx("block select-none", drag?.moved && "cursor-grabbing")}
              style={{ overflow: "visible", touchAction: "none" }}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={() => setDrag(null)}
            >
              <defs>
                <filter id={`glow-${uid}`} x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="3.2" /></filter>
                <linearGradient id={`thread-${uid}`} x1="0" x2="1" y1="0" y2="0">
                  <stop offset="0" stopColor="#ffffff" stopOpacity="0.05" />
                  <stop offset="1" stopColor="#ffffff" stopOpacity="0.22" />
                </linearGradient>
              </defs>

              {lanes.map((l, i) => (
                <rect key={l.id} x={0} y={TOP + i * LANE_H} width={W} height={LANE_H} style={{ fill: i % 2 ? "rgb(255 255 255 / 0.018)" : "transparent" }} />
              ))}
              {days.map((d) => (
                <g key={d.x}>
                  <line x1={d.x} x2={d.x} y1={TOP - 6} y2={H - BOTTOM} style={{ stroke: "rgb(255 255 255 / 0.07)" }} strokeDasharray="2 4" />
                  {d.show && <text x={d.x + 4} y={TOP - 14} style={{ fill: "rgb(var(--faint))", fontSize: 10, fontWeight: 600 }}>{d.label}</text>}
                </g>
              ))}

              {showChain && n > 1 && (
                <g aria-hidden>
                  <path d={chainPath} fill="none" stroke={`url(#thread-${uid})`} strokeWidth={1.25} />
                  <path d={chainPath} fill="none" className="ledger-flow" style={{ stroke: "rgb(var(--primary) / 0.85)" }} strokeWidth={1.6} strokeLinecap="round" />
                </g>
              )}

              {sel && !drag && !activeTie && suggested.map((s) => {
                const a = arc(pos.get(sel.id)!, pos.get(s.event.id)!);
                return (
                  <path key={s.event.id} d={a.d} fill="none" strokeDasharray="3 5" strokeWidth={1.4} className="cursor-pointer" style={{ stroke: "rgb(var(--fg) / 0.38)" }} onClick={() => tie(sel.id, s.event.id)}>
                    <title>Tie #{sel.seq} to #{s.event.seq}: {s.traits.map((t) => t.label).join(", ")}</title>
                  </path>
                );
              })}

              {visibleTies.map((t) => {
                const key = tieKey(t.a, t.b);
                const p = pos.get(t.a)!;
                const q = pos.get(t.b)!;
                const a = arc(p, q);
                const color = STRING_COLORS[t.color % STRING_COLORS.length];
                const c = analyse(byId.get(t.a)!, byId.get(t.b)!);
                const label = `${c.links} link${c.links === 1 ? "" : "s"} · ${describeGap(c.elapsedMs)}`;
                const w = label.length * 5.6 + 16;
                const on = key === active;
                return (
                  <g key={key} className="cursor-pointer" onClick={() => setActive(on ? null : key)} opacity={active && !on ? 0.45 : 1}>
                    <path d={a.d} fill="none" stroke={color} strokeWidth={on ? 7 : 5} opacity={0.32} filter={`url(#glow-${uid})`} />
                    <motion.path d={a.d} fill="none" stroke={color} strokeWidth={on ? 2.4 : 1.7} strokeLinecap="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.7, ease: EASE }} />
                    <circle cx={p.x} cy={p.y} r={9} fill="none" stroke={color} strokeWidth={1.4} />
                    <circle cx={q.x} cy={q.y} r={9} fill="none" stroke={color} strokeWidth={1.4} />
                    <g transform={`translate(${a.mid.x} ${a.mid.y})`}>
                      <rect x={-w / 2} y={-10} width={w} height={20} rx={10} style={{ fill: "rgb(16 21 27)" }} stroke={color} strokeWidth={on ? 1.5 : 1} />
                      <text textAnchor="middle" dy={3.5} style={{ fill: color, fontSize: 10, fontWeight: 600 }}>{label}</text>
                    </g>
                  </g>
                );
              })}

              {drag?.moved && (() => {
                const target = drag.target ? pos.get(drag.target)! : drag.at;
                const a = arc(pos.get(drag.from)!, target);
                return (
                  <g pointerEvents="none">
                    <path d={a.d} fill="none" stroke="#78A6F0" strokeWidth={6} opacity={0.35} filter={`url(#glow-${uid})`} />
                    <path d={a.d} fill="none" stroke="#9CC0FF" strokeWidth={1.8} strokeDasharray={drag.target ? undefined : "5 5"} />
                    {!drag.target && <circle cx={drag.at.x} cy={drag.at.y} r={4} style={{ fill: "#9CC0FF" }} />}
                  </g>
                );
              })()}

              {chrono.map((e) => {
                const p = pos.get(e.id)!;
                const isSel = e.id === selected;
                const isTarget = drag?.target === e.id;
                const dim = focusSet ? !focusSet.has(e.id) : false;
                return (
                  <g
                    key={e.id}
                    transform={`translate(${p.x} ${p.y})`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Event ${e.seq}: ${titleCase(e.event_type)}, ${e.proposal_id ?? "system"}, ${e.status}${isSel ? ", selected" : ""}`}
                    aria-pressed={isSel}
                    className="ledger-node cursor-pointer outline-none"
                    style={{ opacity: dim ? 0.28 : 1, transition: "opacity 0.25s" }}
                    onPointerDown={(ev) => onNodeDown(ev, e.id)}
                    onPointerEnter={() => setHover(e.id)}
                    onPointerLeave={() => setHover((h) => (h === e.id ? null : h))}
                    onFocus={() => setHover(e.id)}
                    onBlur={() => setHover((h) => (h === e.id ? null : h))}
                    onKeyDown={(ev) => onNodeKey(ev, e.id)}
                  >
                    <circle r={15} fill="transparent" />
                    {e.status === "failure" && <circle r={9} className="ledger-halo" style={{ fill: "rgb(var(--danger) / 0.3)" }} />}
                    {e.verification === "chain-confirmed" && <circle r={9.5} fill="none" style={{ stroke: "rgb(var(--primary) / 0.6)" }} strokeWidth={1.2} />}
                    <circle r={isSel ? 7.5 : 5.5} style={{ fill: STATUS[e.status], stroke: "rgb(13 17 22)", transition: "r 0.2s" }} strokeWidth={2} />
                    <circle r={13.5} fill="none" className="ledger-focus" strokeWidth={1.5} style={{ stroke: isSel || isTarget ? "rgb(var(--fg))" : linkFrom === e.id ? "#9CC0FF" : "transparent" }} strokeDasharray={linkFrom === e.id ? "3 3" : undefined} />
                  </g>
                );
              })}
            </svg>

            <AnimatePresence>
              {hovered && hp && (
                <motion.div
                  key={hovered.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="pointer-events-none absolute z-20 w-[250px] rounded-lg border border-white/10 bg-[#10151b]/95 p-2.5 shadow-[0_12px_32px_rgba(0,0,0,0.45)] backdrop-blur"
                  style={{
                    left: Math.max(126, Math.min(W - 126, hp.x)),
                    top: (laneIdx.get(laneOf(hovered)) ?? 0) < 2 ? hp.y + 18 : hp.y - 18,
                    translate: (laneIdx.get(laneOf(hovered)) ?? 0) < 2 ? "-50% 0" : "-50% -100%",
                  }}
                >
                  <p className="flex items-center justify-between gap-2 text-[11.5px] font-semibold">
                    <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: STATUS[hovered.status] }} />{titleCase(hovered.event_type)}</span>
                    <span className="font-mono text-[10px] text-faint">#{hovered.seq}</span>
                  </p>
                  <p className="mt-1 line-clamp-3 text-[11px] leading-snug text-muted">{hovered.summary}</p>
                  <p className="mt-1.5 text-[10px] text-faint">{hovered.proposal_id ?? "system"} · {dateTime(hovered.occurred_at)} · {hovered.actor}</p>
                  {hovered.tx_hash && <p className="mt-0.5 text-[10px] text-primary">chain-confirmed · block #{hovered.block_number}</p>}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      <Minimap events={chrono} lanes={lanes.length} laneIdx={laneIdx} W={W} view={view} onScrub={(left) => { if (scrollRef.current) scrollRef.current.scrollLeft = left; }} />

      <div className="grid border-t border-white/[0.06] md:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
        <div className="border-b border-white/[0.06] p-4 md:border-b-0 md:border-r">
          <p className="label mb-2 flex items-center justify-between">
            <span>Strings · {visibleTies.length}</span>
            {hiddenTies > 0 && <span className="normal-case tracking-normal text-faint">{hiddenTies} hidden by filters</span>}
          </p>
          {visibleTies.length === 0 && <p className="text-xs text-muted">No strings yet. Drag between two events, or select one and tie a suggestion.</p>}
          <ul className="max-h-[240px] space-y-1.5 overflow-y-auto pr-1 scroll-thin">
            <AnimatePresence initial={false}>
              {visibleTies.map((t) => {
                const key = tieKey(t.a, t.b);
                const c = analyse(byId.get(t.a)!, byId.get(t.b)!);
                const color = STRING_COLORS[t.color % STRING_COLORS.length];
                return (
                  <motion.li key={key} layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }}>
                    <div className={cx("group flex items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors", key === active ? "border-white/25 bg-white/[0.06]" : "border-white/[0.07] hover:bg-white/[0.04]")}>
                      <button className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => setActive(key === active ? null : key)}>
                        <span className="flex items-center gap-1.5 text-[11.5px] font-semibold">
                          <span className="h-[3px] w-4 shrink-0 rounded-full" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
                          <span className="truncate">#{c.from.seq} → #{c.to.seq}</span>
                        </span>
                        <span className="mt-0.5 block truncate text-[10.5px] text-muted">{titleCase(c.from.event_type)} → {titleCase(c.to.event_type)}</span>
                      </button>
                      <span className="text-[10px] font-semibold" style={{ color: STRENGTH[c.strength].color }}>{c.strength === "chain" ? "chain" : c.strength}</span>
                      <button aria-label={`Remove string ${c.from.seq} to ${c.to.seq}`} className="cursor-pointer rounded p-0.5 text-faint opacity-60 transition-opacity hover:text-fg group-hover:opacity-100" onClick={() => untie(key)}><X className="h-3.5 w-3.5" /></button>
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        </div>
        <div className="min-w-0 p-4">
          {activeTie ? (
            <ConnectionCard key={tieKey(activeTie.a, activeTie.b)} a={byId.get(activeTie.a)!} b={byId.get(activeTie.b)!} color={STRING_COLORS[activeTie.color % STRING_COLORS.length]} onRemove={() => untie(tieKey(activeTie.a, activeTie.b))} />
          ) : sel ? (
            <div>
              <p className="label mb-2">Suggested strings for #{sel.seq} · {titleCase(sel.event_type)}</p>
              {suggested.length === 0 && <p className="text-xs text-muted">No other event shares a transaction, manifest or record id with this one. You can still tie it by dragging to any event.</p>}
              <ul className="grid gap-1.5 lg:grid-cols-2">
                {suggested.map((s) => (
                  <li key={s.event.id} className="flex items-start gap-2 rounded-lg border border-white/[0.07] p-2.5">
                    <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS[s.event.status] }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11.5px] font-semibold">#{s.event.seq} {titleCase(s.event.event_type)}</span>
                      <span className="mt-0.5 block truncate text-[10.5px] text-muted">{s.traits.slice(0, 2).map((t) => t.label).join(" · ")}</span>
                    </span>
                    <button className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-white/15 px-2 text-[10.5px] font-semibold text-fg transition-colors hover:bg-white/10" onClick={() => tie(sel.id, s.event.id)}>
                      <Link2 className="h-3 w-3" /> Tie
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                [MousePointerClick, "Select", "Click an event to inspect it. Related events stay lit and dashed strings suggest what to tie."],
                [Hand, "Drag to tie", "Press on one event and release on another. Link mode or Shift+click works too, keyboard included."],
                [CheckCircle2, "Verify", "Open a string to see what joins the two events and re-hash every link between them."],
              ].map(([Icon, title, body]) => {
                const I = Icon as typeof Hand;
                return (
                  <div key={title as string} className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-3">
                    <I className="h-4 w-4 text-primary" />
                    <p className="mt-2 text-xs font-semibold">{title as string}</p>
                    <p className="mt-0.5 text-[11px] leading-snug text-muted">{body as string}</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ToolButton({ on, onClick, icon, label }: { on: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={cx(
        "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary",
        on ? "border-primary/50 bg-primary/15 text-primary" : "border-white/10 text-muted hover:bg-white/[0.06] hover:text-fg",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-white/10 text-muted transition-colors duration-200 hover:bg-white/[0.06] hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
      {children}
    </button>
  );
}

function Minimap({ events, lanes, laneIdx, W, view, onScrub }: { events: AuditEvent[]; lanes: number; laneIdx: Map<string, number>; W: number; view: { left: number; width: number }; onScrub: (left: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const pressed = useRef(false);
  const scrub = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    onScrub(((clientX - r.left) / r.width) * W - view.width / 2);
  };
  const n = Math.max(1, events.length - 1);
  const rowH = Math.max(3, 24 / Math.max(1, lanes));
  return (
    <div className="px-4 pb-3 pt-1">
      <div
        ref={ref}
        role="scrollbar"
        aria-controls="ledger-graph"
        aria-orientation="horizontal"
        aria-valuenow={Math.round((view.left / Math.max(1, W - view.width)) * 100)}
        aria-label="Ledger overview: drag to move the graph"
        className="relative h-9 cursor-pointer touch-none select-none overflow-hidden rounded-md border border-white/[0.06] bg-black/20"
        onPointerDown={(e) => { pressed.current = true; e.currentTarget.setPointerCapture(e.pointerId); scrub(e.clientX); }}
        onPointerMove={(e) => pressed.current && scrub(e.clientX)}
        onPointerUp={() => (pressed.current = false)}
      >
        {events.map((e, i) => (
          <span key={e.id} className="absolute w-[2px] rounded-full" style={{ left: `${(i / n) * 100}%`, top: 5 + (laneIdx.get(laneOf(e)) ?? 0) * rowH, height: rowH - 1, background: STATUS[e.status] }} />
        ))}
        <div className="absolute inset-y-0 rounded border border-white/40 bg-white/[0.07] transition-[left] duration-75" style={{ left: `${(view.left / Math.max(1, W)) * 100}%`, width: `${Math.min(100, (view.width / Math.max(1, W)) * 100)}%` }} />
      </div>
    </div>
  );
}

const TRAIT_ICON: Record<Trait["kind"], string> = { tx: "Tx", manifest: "Mf", reference: "Id", version: "v", block: "Bk", proposal: "P", actor: "A" };

function ConnectionCard({ a, b, color, onRemove }: { a: AuditEvent; b: AuditEvent; color: string; onRemove: () => void }) {
  const c = useMemo(() => analyse(a, b), [a, b]);
  const { ask } = useAssistant();
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.get<any>(`/audit/verify-range?from_seq=${c.from.seq}&to_seq=${c.to.seq}`));
    } catch (e: any) {
      setError(e?.message ?? "Verification failed");
    } finally {
      setBusy(false);
    }
  };
  const strength = STRENGTH[c.strength];
  const tiles: Array<[string, string, string?]> = [
    ["Ledger links", String(c.links)],
    ["Time apart", describeGap(c.elapsedMs)],
    ["Strength", strength.label, strength.color],
    ["Shared traits", String(c.shared.length)],
  ];
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: EASE }}>
      <div className="flex flex-wrap items-center gap-2">
        <EventChip e={c.from} />
        <svg width="54" height="14" aria-hidden className="shrink-0">
          <path d="M 2 11 Q 27 -4 52 11" fill="none" stroke={color} strokeWidth="1.8" style={{ filter: `drop-shadow(0 0 3px ${color})` }} />
        </svg>
        <EventChip e={c.to} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {tiles.map(([k, v, col]) => (
          <div key={k} className="rounded-lg border border-white/[0.07] bg-white/[0.025] px-2.5 py-2">
            <p className="text-[10px] font-medium uppercase tracking-[0.06em] text-faint">{k}</p>
            <p className="mt-0.5 text-[15px] font-semibold" style={col ? { color: col } : undefined}>{v}</p>
          </div>
        ))}
      </div>
      {c.shared.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {c.shared.map((t) => (
            <li key={t.kind + t.value} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] py-0.5 pl-0.5 pr-2.5 text-[10.5px]">
              <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[9px] font-bold" style={{ background: `${color}22`, color }}>{TRAIT_ICON[t.kind]}</span>
              <span className="text-muted">{t.label}</span>
              <span className="truncate font-mono text-fg">{t.value.length > 22 ? `${t.value.slice(0, 10)}…${t.value.slice(-6)}` : t.value}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[12px] leading-relaxed text-muted">{c.verdict}</p>

      <div className="mt-3 rounded-lg border border-white/[0.07] bg-black/20 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11.5px] font-semibold">Segment verification</p>
          <button onClick={verify} disabled={busy} className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 text-[11px] font-semibold text-[#06231b] transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60">
            <CheckCircle2 className="h-3.5 w-3.5" /> {busy ? "Re-hashing…" : result ? "Verify again" : `Verify ${c.links + 1} events`}
          </button>
        </div>
        {!result && !error && <p className="mt-1 text-[11px] text-faint">Re-computes sha256(canonical event ‖ previous hash) for #{c.from.seq}–#{c.to.seq} on the server and re-confirms their transactions on the node.</p>}
        {error && <p className="mt-2 flex items-center gap-1.5 text-[11px] text-danger"><XCircle className="h-3.5 w-3.5" />{error}</p>}
        {result && (
          <div className="mt-2.5">
            <div className="flex flex-wrap gap-[3px]" aria-label="Hash links in this segment">
              {result.links.map((l: any, i: number) => (
                <motion.span
                  key={l.seq}
                  title={`#${l.seq} ${titleCase(l.event_type)}${l.ok ? " · intact" : ` · ${l.problems.join("; ")}`}${l.receipt_confirmed ? " · receipt confirmed" : ""}`}
                  initial={{ opacity: 0, scaleY: 0.3 }}
                  animate={{ opacity: 1, scaleY: 1 }}
                  transition={{ delay: Math.min(i * 0.012, 0.9), duration: 0.2 }}
                  className={cx("relative h-4 w-2 rounded-[2px]", l.ok ? "bg-primary/80" : "bg-danger")}
                >
                  {l.receipt_confirmed && <span className="absolute -top-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-white" />}
                </motion.span>
              ))}
            </div>
            <p className={cx("mt-2 flex items-start gap-1.5 text-[11.5px]", result.ok ? "text-primary" : "text-danger")}>
              {result.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              {result.ok
                ? `Intact: ${result.events} events re-hashed, attached to #${result.anchored_to}${result.chain_checked ? `, ${result.receipts_checked} transaction receipt(s) re-confirmed on the node` : ""}.`
                : `${result.links.filter((l: any) => !l.ok).length} broken link(s): ${result.links.filter((l: any) => !l.ok).map((l: any) => `#${l.seq} ${l.problems[0]}`).join("; ")}.`}
            </p>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => ask(`How are audit events #${c.from.seq} (${titleCase(c.from.event_type)}) and #${c.to.seq} (${titleCase(c.to.event_type)}) connected?`)} className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-white/15 px-2.5 text-[11px] font-semibold transition-colors hover:bg-white/10">
          <MessageSquareText className="h-3.5 w-3.5" /> Ask the assistant
        </button>
        <button onClick={onRemove} className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-white/10 px-2.5 text-[11px] font-semibold text-muted transition-colors hover:bg-white/10 hover:text-fg">
          <Trash2 className="h-3.5 w-3.5" /> Remove string
        </button>
      </div>
    </motion.div>
  );
}

function EventChip({ e }: { e: AuditEvent }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS[e.status] }} />
      <span className="min-w-0">
        <span className="block truncate text-[11.5px] font-semibold">#{e.seq} {titleCase(e.event_type)}</span>
        <span className="block truncate text-[10px] text-faint">{e.proposal_id ?? "system"} · {dateTime(e.occurred_at)}</span>
      </span>
    </span>
  );
}
