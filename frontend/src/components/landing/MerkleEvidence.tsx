/* Landing section: a proposal's evidence collapses into a Merkle root as you scroll, the root is anchored
   on-chain, then one document is edited and the corrupted path turns red up to a root that no longer
   matches the anchor. Every hash is a real sha256, computed in the browser. SVG + motion, scroll-driven. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useMotionValueEvent, useReducedMotion, useScroll } from "motion/react";
import { Anchor, CheckCircle2, FileText, ShieldAlert, XCircle } from "lucide-react";
import { anchorT, buildTree, DEPTH, leafT, LEAVES, nodeT, pathToRoot, stage, STAGES, TAMPERED, tamperT } from "../../lib/merkle";
import { EASE } from "../../lib/motion";

const MINT = "#38D6AC";
const CYAN = "#7FE7FF";
const CORAL = "#FA7070";
const DISPLAY = { fontFamily: "'Space Grotesk Variable', 'Inter Variable', system-ui, sans-serif" };
const MONO = "'JetBrains Mono', ui-monospace, monospace";

const BODY = [
  "Each piece of evidence, from the proposal text to the budget memo and the signed disclosure, gets a sha256 fingerprint. Same bytes, same hash, forever.",
  "Hashes are paired and hashed again, level by level. Every node commits to everything beneath it.",
  "Eight documents collapse into one 32-byte root that stands for the entire evidence set.",
  "Committing the version writes that root to the ProposalRegistry. From here on, the evidence is fixed in public.",
  "Change a single document and its hash changes, then its parent, then the root. It no longer matches the anchor, so tampering is caught instantly.",
];

const Y = [540, 410, 288, 168]; // leaves, level 1, level 2, root
const W = [112, 150, 170, 214];
const H = [56, 46, 46, 54];
const ANCHOR_Y = 52;

function xs(level: number): number[] {
  const leaves = Array.from({ length: LEAVES }, (_, i) => 78 + (i * 844) / (LEAVES - 1));
  let row = leaves;
  for (let l = 0; l < level; l++) row = row.filter((_, i) => i % 2 === 0).map((x, i) => (x + row[2 * i + 1]) / 2);
  return row;
}

const HEX = "0123456789abcdef";
/** Reveals a hash left to right as t goes 0 → 1; unrevealed characters flicker with the scroll. */
function scramble(hash: string, t: number, tick: number, seed: number, n = 10, calm = false): string {
  if (!hash) return "·".repeat(n);
  if (t <= 0) return "·".repeat(n);
  const shown = calm ? (t > 0.5 ? n : 0) : Math.round(t * n);
  let out = "";
  for (let k = 0; k < n; k++) out += k < shown ? hash[k] : HEX[(seed * 31 + k * 7 + tick * 13) % 16];
  return out;
}

function bezier(x1: number, y1: number, x2: number, y2: number, u: number) {
  const my = (y1 + y2) / 2;
  const a = (1 - u) ** 3, b = 3 * (1 - u) ** 2 * u, c = 3 * (1 - u) * u ** 2, d = u ** 3;
  return { x: a * x1 + b * x1 + c * x2 + d * x2, y: a * y1 + b * my + c * my + d * y2 };
}

export default function MerkleEvidence({ docs, marker }: { docs: string[]; marker?: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const reduce = !!useReducedMotion();
  const [p, setP] = useState(0);
  const [trees, setTrees] = useState<{ base: string[][]; edited: string[][] } | null>(null);
  const [compact, setCompact] = useState(false);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  useMotionValueEvent(scrollYProgress, "change", (v) => setP(Math.round(v * 500) / 500));

  const leaves = useMemo(() => Array.from({ length: LEAVES }, (_, i) => docs[i] ?? `Evidence ${i + 1}`), [docs]);
  useEffect(() => {
    let live = true;
    const edited = leaves.map((d, i) => (i === TAMPERED ? `${d} (edited: 520,000)` : d));
    Promise.all([buildTree(leaves), buildTree(edited)]).then(([base, ed]) => live && setTrees({ base, edited: ed })).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [leaves]);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const on = () => setCompact(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const tick = Math.floor(p * 90);
  const s = stage(p);
  const tam = tamperT(p);
  const anc = anchorT(p);
  const path = pathToRoot(TAMPERED);
  const onPath = (level: number, i: number) => path[level] === i;
  const hashOf = (level: number, i: number) => {
    if (!trees) return "";
    const corrupt = tam > 0.5 && onPath(level, i);
    return (corrupt ? trees.edited : trees.base)[level][i];
  };
  const tOf = (level: number, i: number) => (level === 0 ? leafT(p, i) : nodeT(p, level, i));
  const hashed = Array.from({ length: LEAVES }, (_, i) => leafT(p, i)).filter((t) => t >= 1).length;
  const levelDone = [1, 2, 3].filter((l) => xs(l).every((_, i) => nodeT(p, l, i) >= 1)).length;
  const root = trees?.base[DEPTH][0] ?? "";
  const rootNow = hashOf(DEPTH, 0);
  const status = tam > 0.5 ? "tamper" : anc >= 1 ? "anchored" : levelDone === DEPTH ? "root" : "building";

  const nodeColor = (level: number, i: number, t: number) => (tam > 0 && onPath(level, i) ? CORAL : t >= 1 ? MINT : t > 0 ? CYAN : "rgba(255,255,255,0.18)");

  return (
    <section id="evidence" ref={ref} className="relative h-[300vh]" aria-label="How evidence becomes a tamper-evident Merkle root">
      {marker}
      <div className="sticky top-0 flex h-[100svh] flex-col overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_60%,rgba(127,231,255,0.07),transparent_70%)]" />
        <div className="relative mx-auto flex w-full max-w-[1240px] items-start justify-between gap-6 px-5 pt-24">
          <div className="max-w-[460px]">
            <p className="text-[12px] font-semibold uppercase tracking-[0.22em] text-[#7FE7FF]">The evidence root</p>
            <AnimatePresence mode="wait">
              <motion.div key={s} initial={{ opacity: 0, y: 16, filter: "blur(6px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={{ opacity: 0, y: -12, filter: "blur(6px)" }} transition={{ duration: 0.4, ease: EASE }} className="mt-3">
                <h2 className={`text-[28px] font-semibold leading-tight tracking-[-0.02em] md:text-[38px] ${s === 4 ? "text-[#FF9A9A]" : "text-white"}`} style={DISPLAY}>{STAGES[s]}</h2>
                <p className="mt-3 text-[14.5px] leading-relaxed text-[#A9BCBF] md:text-[16px]">{BODY[s]}</p>
              </motion.div>
            </AnimatePresence>
            <p className="mt-3 font-mono text-[11.5px] md:hidden" style={{ color: status === "tamper" ? CORAL : status === "anchored" ? MINT : "#7E9497" }}>
              {hashed}/{LEAVES} hashed · {levelDone}/{DEPTH} sealed · {status === "tamper" ? "tamper detected" : status === "anchored" ? "anchored" : status === "root" ? "root ready" : "hashing"}
            </p>
          </div>
          <div className="hidden w-[280px] shrink-0 rounded-2xl border border-white/[0.08] bg-[#071012]/70 p-5 backdrop-blur-xl md:block">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7E9497]">Merkle status</p>
            <p className="mt-1 flex items-center gap-2 text-[22px] font-semibold" style={{ ...DISPLAY, color: status === "tamper" ? CORAL : status === "anchored" ? MINT : status === "root" ? CYAN : "#E8F3F0" }}>
              {status === "tamper" ? <XCircle className="h-5 w-5" /> : status === "anchored" ? <CheckCircle2 className="h-5 w-5" /> : null}
              {status === "tamper" ? "Tamper detected" : status === "anchored" ? "Anchored on-chain" : status === "root" ? "Root computed" : "Hashing evidence"}
            </p>
            <dl className="mt-4 space-y-2 text-[13px]">
              <div className="flex justify-between"><dt className="text-[#7E9497]">Documents hashed</dt><dd className="font-semibold tabular-nums text-white">{hashed}/{LEAVES}</dd></div>
              <div className="flex justify-between"><dt className="text-[#7E9497]">Tree levels sealed</dt><dd className="font-semibold tabular-nums text-white">{levelDone}/{DEPTH}</dd></div>
            </dl>
            <div className="mt-3 space-y-1.5 rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2 font-mono text-[11px]">
              <p className="flex justify-between gap-2"><span className="text-[#5f7579]">anchored</span><span className="truncate text-[#9FE9D6]">{anc > 0 ? `0x${root.slice(0, 14)}…` : "—"}</span></p>
              <p className="flex justify-between gap-2"><span className="text-[#5f7579]">recomputed</span><span className="truncate" style={{ color: tam > 0.5 ? CORAL : "#9FE9D6" }}>{levelDone === DEPTH ? `0x${rootNow.slice(0, 14)}…` : "—"}</span></p>
            </div>
            <p className="mt-2 text-[10.5px] text-[#5f7579]">Real sha256, computed live in your browser.</p>
          </div>
        </div>

        <div className="relative mx-auto min-h-0 w-full max-w-[1240px] flex-1 px-3 pb-6">
          <svg viewBox="0 0 1000 620" className="h-full w-full" preserveAspectRatio={compact ? "xMidYMin meet" : "xMidYMid meet"} role="img" aria-label={`Merkle tree: ${hashed} of ${LEAVES} documents hashed, ${levelDone} of ${DEPTH} levels sealed, status ${status}`}>
            <defs>
              <filter id="mk-glow" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="5" /></filter>
            </defs>

            {/* anchor block and its link to the root */}
            <g opacity={0.25 + 0.75 * anc}>
              <line x1={500} y1={ANCHOR_Y + 32} x2={500} y2={Y[3] - H[3] / 2} stroke={tam > 0.5 ? CORAL : MINT} strokeWidth={2.2} strokeDasharray={anc >= 1 ? undefined : "4 6"} pathLength={1} style={{ strokeDashoffset: 0 }} />
              <rect x={350} y={ANCHOR_Y - 32} width={300} height={64} rx={12} fill={anc >= 1 ? "rgba(56,214,172,0.14)" : "rgba(255,255,255,0.03)"} stroke={anc >= 1 ? MINT : "rgba(255,255,255,0.2)"} strokeWidth={1.5} />
              {anc >= 1 && <rect x={350} y={ANCHOR_Y - 32} width={300} height={64} rx={12} fill="none" stroke={MINT} strokeWidth={6} opacity={0.35} filter="url(#mk-glow)" />}
              <text x={370} y={ANCHOR_Y - 8} fill="#E8F3F0" fontSize={13} fontWeight={700} style={DISPLAY}>ProposalRegistry · on-chain anchor</text>
              <text x={370} y={ANCHOR_Y + 15} fill={anc >= 1 ? "#9FE9D6" : "#5f7579"} fontSize={12} fontFamily={MONO}>{anc > 0 ? `root 0x${root.slice(0, 22)}…` : "awaiting the evidence root"}</text>
            </g>

            {/* edges */}
            {[1, 2, 3].map((level) =>
              xs(level).map((px, i) =>
                [0, 1].map((side) => {
                  const ci = 2 * i + side;
                  const cx = xs(level - 1)[ci];
                  const t = nodeT(p, level, i);
                  const bad = tam > 0 && onPath(level - 1, ci) && onPath(level, i);
                  const x1 = cx, y1 = Y[level - 1] - H[level - 1] / 2, x2 = px, y2 = Y[level] + H[level] / 2;
                  const my = (y1 + y2) / 2;
                  const dot = !reduce && t > 0.02 && t < 0.98 ? bezier(x1, y1, x2, y2, t) : null;
                  return (
                    <g key={`${level}-${i}-${side}`}>
                      <path d={`M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={1.5} />
                      <path d={`M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`} fill="none" stroke={bad ? CORAL : MINT} strokeWidth={bad ? 2.4 : 1.8} pathLength={1} strokeDasharray="1" strokeDashoffset={1 - t} strokeLinecap="round" opacity={0.9} />
                      {dot && <circle cx={dot.x} cy={dot.y} r={4} fill={CYAN} filter="url(#mk-glow)" />}
                      {dot && <circle cx={dot.x} cy={dot.y} r={2.4} fill="#fff" />}
                    </g>
                  );
                }),
              ),
            )}

            {/* nodes, leaves first */}
            {[0, 1, 2, 3].map((level) =>
              xs(level).map((x, i) => {
                const t = tOf(level, i);
                const c = nodeColor(level, i, t);
                const w = W[level];
                const h = H[level];
                const isRoot = level === DEPTH;
                const edited = level === 0 && i === TAMPERED && tam > 0;
                const label = level === 0 ? leaves[i] : isRoot ? "Evidence root" : `Node ${level}·${i}`;
                return (
                  <g key={`${level}-${i}`} transform={`translate(${x} ${Y[level]})`} opacity={level === 0 ? 0.35 + 0.65 * t : t > 0 ? 1 : 0.45}>
                    {(t >= 1 || edited) && <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={10} fill="none" stroke={c} strokeWidth={isRoot ? 8 : 5} opacity={isRoot ? 0.45 : 0.22} filter="url(#mk-glow)" />}
                    <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={10} fill={t >= 1 ? (c === CORAL ? "rgba(250,112,112,0.12)" : "rgba(56,214,172,0.1)") : "rgba(7,16,18,0.85)"} stroke={c} strokeWidth={isRoot ? 2 : 1.4} />
                    {level === 0 && !compact && (
                      <text x={-w / 2 + 10} y={-h / 2 + 18} fill={edited ? "#FFB4B4" : "#CFE4E0"} fontSize={10.5} fontWeight={600} style={DISPLAY}>
                        {label.length > 17 ? `${label.slice(0, 16)}…` : label}
                      </text>
                    )}
                    {level > 0 && !compact && <text x={-w / 2 + 12} y={-h / 2 + 18} fill={isRoot ? "#E8F3F0" : "#8FA7AA"} fontSize={isRoot ? 12.5 : 10.5} fontWeight={700} style={DISPLAY}>{label}</text>}
                    <text x={compact ? 0 : -w / 2 + (level === 0 ? 10 : 12)} y={compact ? 5 : h / 2 - 12} textAnchor={compact ? "middle" : "start"} fill={t >= 1 ? (c === CORAL ? "#FF9A9A" : "#9FE9D6") : "#6E8589"} fontSize={compact ? 18 : isRoot ? 13 : 11} fontFamily={MONO}>
                      {compact && level === 0 ? (t >= 1 ? "✓" : "·") : `0x${scramble(hashOf(level, i), t, tick + (edited ? 50 : 0), level * 8 + i, isRoot ? 14 : level === 0 ? 9 : 11, reduce)}`}
                    </text>
                    {edited && (
                      <g transform={`translate(${w / 2 - 6} ${-h / 2 - 2})`}>
                        <rect x={-46} y={-11} width={52} height={18} rx={9} fill={CORAL} />
                        <text x={-20} y={2} textAnchor="middle" fill="#2a0808" fontSize={10} fontWeight={800} style={DISPLAY}>EDITED</text>
                      </g>
                    )}
                    {isRoot && tam > 0.5 && (
                      <g transform={`translate(${w / 2 + 14} 0)`}>
                        <rect x={0} y={-15} width={150} height={30} rx={15} fill="rgba(250,112,112,0.15)" stroke={CORAL} />
                        <text x={75} y={5} textAnchor="middle" fill="#FFB4B4" fontSize={12} fontWeight={700} style={DISPLAY}>≠ anchored root</text>
                      </g>
                    )}
                  </g>
                );
              }),
            )}
          </svg>
          {!compact && (
            <div className="pointer-events-none absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-4 text-[11.5px] text-[#6E8589]">
              <span className="flex items-center gap-1.5"><FileText className="h-3.5 w-3.5" />documents</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#7FE7FF]" />hashing</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#38D6AC]" />sealed</span>
              <span className="flex items-center gap-1.5"><Anchor className="h-3.5 w-3.5" />anchored</span>
              <span className="flex items-center gap-1.5"><ShieldAlert className="h-3.5 w-3.5 text-[#FA7070]" />tampered</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
