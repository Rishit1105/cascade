/* Interactive relationship graph: d3-force layout, SVG rendering, d3-zoom pan/zoom. */
import { useEffect, useMemo, useRef, useState } from "react";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { select } from "d3-selection";
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import { ArrowRightLeft, Boxes, FileSearch, FileText, Landmark, Maximize2, Minus, Plus, RotateCcw, Tag, UserRound, Vault, Wallet } from "lucide-react";
import type { GraphEdge, GraphNode } from "../lib/api";
import { cx } from "../lib/format";

type SimNode = GraphNode & SimulationNodeDatum;
type SimLink = SimulationLinkDatum<SimNode> & { edge: GraphEdge };

const ICON = { dao: Landmark, proposal: FileText, wallet: Wallet, delegate: UserRound, treasury: Vault, contract: Boxes, evidence: FileSearch, transaction: ArrowRightLeft } as const;
const RADIUS: Record<string, number> = { dao: 24, treasury: 22, proposal: 20, contract: 16, wallet: 17, delegate: 17, evidence: 14, transaction: 13 };

export const NODE_TYPES: Array<{ id: GraphNode["type"]; label: string }> = [
  { id: "dao", label: "DAO" },
  { id: "proposal", label: "Proposal" },
  { id: "wallet", label: "Wallet" },
  { id: "delegate", label: "Delegate" },
  { id: "treasury", label: "Treasury" },
  { id: "contract", label: "Smart contract" },
  { id: "evidence", label: "Evidence" },
  { id: "transaction", label: "Transaction" },
];

const EDGE_STYLE: Record<string, { stroke: string; dash?: string }> = {
  verified_observation: { stroke: "rgb(var(--edge))" },
  record: { stroke: "rgb(var(--edge) / 0.7)" },
  disclosed: { stroke: "rgb(var(--info))", dash: "5 4" },
  unverified_lead: { stroke: "rgb(var(--warning))", dash: "3 4" },
};

function transferWidth(e: GraphEdge): number {
  if (e.type !== "transfer" || !e.value_base) return 1.2;
  const usd = Number(BigInt(e.value_base) / 1_000_000n);
  return Math.min(5, 1 + Math.log10(Math.max(1, usd)) / 1.6);
}

export interface GraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNode?: string | null;
  selectedEdge?: string | null;
  onSelectNode?: (n: GraphNode | null) => void;
  onSelectEdge?: (e: GraphEdge | null) => void;
  highlight?: Set<string> | null;
  flagged?: Set<string>;
  showLabels?: boolean;
  height?: number | string;
  compact?: boolean;
}

export function RelationshipGraph({ nodes, edges, selectedNode, selectedEdge, onSelectNode, onSelectEdge, highlight, flagged, showLabels = true, height = 560, compact }: GraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [hover, setHover] = useState<{ x: number; y: number; text: string[] } | null>(null);
  const [layoutSeed, setLayoutSeed] = useState(0);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const key = useMemo(() => nodes.map((n) => n.id).join("|") + "#" + edges.length + "#" + layoutSeed, [nodes, edges, layoutSeed]);

  // Deterministic layout: run the force simulation to rest, then render statically.
  useEffect(() => {
    const simNodes: SimNode[] = nodes.map((n, i) => ({ ...n, x: Math.cos(i * 2.4 + layoutSeed) * 260, y: Math.sin(i * 2.4 + layoutSeed) * 200 }));
    const byId = new Map(simNodes.map((n) => [n.id, n]));
    const links: SimLink[] = edges.filter((e) => byId.has(e.source) && byId.has(e.target)).map((e) => ({ source: e.source, target: e.target, edge: e }));
    const distance: Record<string, number> = {
      references_evidence: 64, governs: 170, voted: 190, transfer: 150, delegated_to: 130, proposed: 120, pays: 140, executes_contract: 130,
      embedded_in_bytecode: 120, submitted_to: 180, execution_attempt: 90,
    };
    const sim = forceSimulation(simNodes)
      .force("link", forceLink<SimNode, SimLink>(links).id((d) => d.id).distance((l) => distance[l.edge.type] ?? 130).strength(0.35))
      .force("charge", forceManyBody().strength(compact ? -560 : -720).distanceMax(900))
      .force("collide", forceCollide<SimNode>().radius((d) => (RADIUS[d.type] ?? 16) + (compact ? 30 : 34)))
      .force("center", forceCenter(0, 0))
      .force("x", forceX(0).strength(0.02))
      .force("y", forceY(0).strength(0.075))
      .stop();
    for (let i = 0; i < 360; i++) sim.tick();
    setPositions(new Map(simNodes.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }])));
    sim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, compact]);

  useEffect(() => {
    if (!svgRef.current) return;
    const z = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.25, 3.5])
      .filter((ev: any) => !ev.target.closest?.("[data-node]") && (ev.type !== "wheel" || !compact))
      .on("zoom", (ev) => setTransform({ x: ev.transform.x, y: ev.transform.y, k: ev.transform.k }));
    zoomRef.current = z;
    select(svgRef.current).call(z).on("dblclick.zoom", null);
  }, [compact]);

  const fit = () => {
    if (!svgRef.current || !zoomRef.current || positions.size === 0) return;
    const xs = [...positions.values()].map((p) => p.x);
    const ys = [...positions.values()].map((p) => p.y);
    const minX = Math.min(...xs) - 60, maxX = Math.max(...xs) + 60, minY = Math.min(...ys) - 50, maxY = Math.max(...ys) + 70;
    const { width, height: h } = svgRef.current.getBoundingClientRect();
    const k = Math.min(2, 0.95 * Math.min(width / (maxX - minX), h / (maxY - minY)));
    const t = zoomIdentity.translate(width / 2 - (k * (minX + maxX)) / 2, h / 2 - (k * (minY + maxY)) / 2).scale(k);
    select(svgRef.current).call(zoomRef.current.transform, t);
  };
  useEffect(() => {
    const id = window.setTimeout(fit, 30);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions.size, key]);

  const zoomBy = (f: number) => svgRef.current && zoomRef.current && select(svgRef.current).call(zoomRef.current.scaleBy, f);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const neighbours = useMemo(() => {
    if (!selectedNode) return null;
    const s = new Set<string>([selectedNode]);
    edges.forEach((e) => {
      if (e.source === selectedNode) s.add(e.target);
      if (e.target === selectedNode) s.add(e.source);
    });
    return s;
  }, [selectedNode, edges]);
  const active = highlight ?? neighbours;

  const onPointerMove = (ev: React.PointerEvent) => {
    if (!drag.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = (ev.clientX - rect.left - transform.x) / transform.k;
    const y = (ev.clientY - rect.top - transform.y) / transform.k;
    const id = drag.current.id;
    setPositions((prev) => new Map(prev).set(id, { x: x - drag.current!.dx, y: y - drag.current!.dy }));
  };

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg" style={{ height }}>
      <svg
        ref={svgRef}
        className="h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
        style={{ backgroundImage: "radial-gradient(rgb(var(--line)) 1px, transparent 1px)", backgroundSize: "18px 18px" }}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => (drag.current = null)}
        onClick={(e) => {
          if (e.target === svgRef.current) {
            onSelectNode?.(null);
            onSelectEdge?.(null);
          }
        }}
        role="img"
        aria-label="Relationship graph. Use the table view for an accessible list."
      >
        <defs>
          {["edge", "primary", "warning", "danger", "info"].map((c) => (
            <marker key={c} id={`arrow-${c}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={c === "edge" ? "rgb(var(--edge))" : `rgb(var(--${c}))`} />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
          {edges.map((e) => {
            const a = positions.get(e.source);
            const b = positions.get(e.target);
            if (!a || !b) return null;
            const isSel = selectedEdge === e.id;
            const dim = active && !(active.has(e.source) && active.has(e.target));
            const style = EDGE_STYLE[e.evidence_level] ?? EDGE_STYLE.record;
            const rb = RADIUS[nodeById.get(e.target)?.type ?? "wallet"] ?? 16;
            const dx = b.x - a.x, dy = b.y - a.y;
            const len = Math.hypot(dx, dy) || 1;
            const ex = b.x - (dx / len) * (rb + 4), ey = b.y - (dy / len) * (rb + 4);
            const flaggedEdge = flagged?.has(e.id);
            const stroke = isSel ? "rgb(var(--primary))" : flaggedEdge ? "rgb(var(--danger))" : style.stroke;
            const markerColor = isSel ? "primary" : flaggedEdge ? "danger" : e.evidence_level === "unverified_lead" ? "warning" : e.evidence_level === "disclosed" ? "info" : "edge";
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            return (
              <g key={e.id} opacity={dim ? 0.12 : 1} className="transition-opacity duration-200">
                <line x1={a.x} y1={a.y} x2={ex} y2={ey} stroke="transparent" strokeWidth={12} className="cursor-pointer" onClick={(ev) => { ev.stopPropagation(); onSelectEdge?.(e); }}
                  onMouseEnter={(ev) => setHover({ x: ev.clientX, y: ev.clientY, text: [e.label, `${e.type.replace(/_/g, " ")} · ${e.evidence_level.replace(/_/g, " ")}`, e.provenance?.tx_hash ? `tx ${String(e.provenance.tx_hash).slice(0, 12)}…` : e.provenance?.kind ?? ""] })}
                  onMouseLeave={() => setHover(null)} />
                <line x1={a.x} y1={a.y} x2={ex} y2={ey} stroke={stroke} strokeWidth={(isSel ? 2 : 0) + transferWidth(e)} strokeDasharray={style.dash} markerEnd={e.directed ? `url(#arrow-${markerColor})` : undefined} pointerEvents="none" />
                {showLabels && !compact && (e.type === "transfer" || isSel || flaggedEdge) && (
                  <text x={mx} y={my - 4} textAnchor="middle" className="fill-muted text-[9.5px] font-medium" style={{ paintOrder: "stroke", stroke: "rgb(var(--surface))", strokeWidth: 3 }} pointerEvents="none">
                    {e.label.length > 34 ? e.label.slice(0, 32) + "…" : e.label}
                  </text>
                )}
              </g>
            );
          })}
          {nodes.map((n) => {
            const p = positions.get(n.id);
            if (!p) return null;
            const r = RADIUS[n.type] ?? 16;
            const Icon = ICON[n.type] ?? Tag;
            const isSel = selectedNode === n.id;
            const dim = active && !active.has(n.id);
            const isFlagged = flagged?.has(n.id);
            const fill = n.type === "proposal" ? "rgb(var(--primary))" : n.type === "evidence" ? "rgb(var(--surface))" : "rgb(var(--node))";
            const iconColor = n.type === "evidence" ? "rgb(var(--muted))" : "#fff";
            return (
              <g
                key={n.id}
                data-node
                transform={`translate(${p.x},${p.y})`}
                opacity={dim ? 0.18 : 1}
                className="cursor-pointer transition-opacity duration-200"
                tabIndex={0}
                role="button"
                aria-label={`${n.type} ${n.label}`}
                onKeyDown={(ev) => ev.key === "Enter" && onSelectNode?.(n)}
                onPointerDown={(ev) => {
                  ev.stopPropagation();
                  const rect = svgRef.current!.getBoundingClientRect();
                  const x = (ev.clientX - rect.left - transform.x) / transform.k;
                  const y = (ev.clientY - rect.top - transform.y) / transform.k;
                  drag.current = { id: n.id, dx: x - p.x, dy: y - p.y };
                }}
                onClick={(ev) => { ev.stopPropagation(); onSelectNode?.(n); }}
                onMouseEnter={(ev) => setHover({ x: ev.clientX, y: ev.clientY, text: [n.label, n.subtitle ?? n.type, n.address ? `${n.address.slice(0, 10)}…${n.address.slice(-6)}` : ""].filter(Boolean) as string[] })}
                onMouseLeave={() => setHover(null)}
              >
                {isSel && <circle r={r + 7} fill="rgb(var(--primary) / 0.14)" stroke="rgb(var(--primary))" strokeWidth={1.5} />}
                <circle r={r} fill={fill} stroke={n.type === "evidence" ? "rgb(var(--line-strong))" : "rgb(var(--surface))"} strokeWidth={2} />
                <Icon x={-r * 0.5} y={-r * 0.5} width={r} height={r} color={iconColor} strokeWidth={2} />
                {isFlagged && <circle cx={r * 0.72} cy={-r * 0.72} r={5} fill="rgb(var(--danger))" stroke="rgb(var(--surface))" strokeWidth={1.5} />}
                {n.tags?.includes("injection-flagged") && <circle cx={r * 0.72} cy={-r * 0.72} r={4.5} fill="rgb(var(--warning))" stroke="rgb(var(--surface))" strokeWidth={1.5} />}
                {(showLabels || isSel) && (
                  <text y={r + 13} textAnchor="middle" className={cx("text-[10.5px] font-semibold", "fill-fg")} style={{ paintOrder: "stroke", stroke: "rgb(var(--surface))", strokeWidth: 3.5 }} pointerEvents="none">
                    {n.label.length > 26 ? n.label.slice(0, 24) + "…" : n.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      {!compact && (
        <div className="absolute left-3 top-3 flex flex-col gap-1 rounded-lg border border-line bg-surface p-1 shadow-card">
          <button className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-fg" onClick={() => zoomBy(1.3)} aria-label="Zoom in" title="Zoom in"><Plus className="h-4 w-4" /></button>
          <button className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-fg" onClick={() => zoomBy(1 / 1.3)} aria-label="Zoom out" title="Zoom out"><Minus className="h-4 w-4" /></button>
          <button className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-fg" onClick={fit} aria-label="Fit to view" title="Fit to view"><Maximize2 className="h-3.5 w-3.5" /></button>
          <button className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-fg" onClick={() => setLayoutSeed((s) => s + 1)} aria-label="Reset layout" title="Reset layout"><RotateCcw className="h-3.5 w-3.5" /></button>
        </div>
      )}
      {hover && (
        <div className="pointer-events-none fixed z-50 max-w-[260px] rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-pop" style={{ left: hover.x + 14, top: hover.y + 10 }}>
          {hover.text.map((t, i) => (
            <p key={i} className={i === 0 ? "font-semibold text-fg" : "text-muted"}>
              {t}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export function GraphLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-2xs text-muted">
      {NODE_TYPES.map((t) => {
        const Icon = ICON[t.id];
        return (
          <span key={t.id} className="inline-flex items-center gap-1">
            <span className={cx("flex h-4 w-4 items-center justify-center rounded-full", t.id === "proposal" ? "bg-primary" : t.id === "evidence" ? "border border-line-strong bg-surface" : "bg-node")}>
              <Icon className={cx("h-2.5 w-2.5", t.id === "evidence" ? "text-muted" : "text-white")} />
            </span>
            {t.label}
          </span>
        );
      })}
      <span className="mx-1 h-3 w-px bg-line" />
      <span className="inline-flex items-center gap-1"><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="rgb(var(--edge))" strokeWidth="2" /></svg>Observed on-chain</span>
      <span className="inline-flex items-center gap-1"><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="rgb(var(--info))" strokeWidth="2" strokeDasharray="5 4" /></svg>Self-disclosed</span>
      <span className="inline-flex items-center gap-1"><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="rgb(var(--warning))" strokeWidth="2" strokeDasharray="3 4" /></svg>Unverified lead</span>
      <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-danger" />Involved in an open finding</span>
    </div>
  );
}
