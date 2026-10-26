/* Landing page. One story, told by scrolling: a proposal starts as loose, unverified claims and is
   forged, block by block, into a firm hash-linked chain. Live numbers come from the running demo
   chain when it is up; everything still renders (with placeholders) when it is not. Always dark. */
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useMotionValueEvent, useReducedMotion, useScroll, useSpring, useTransform } from "motion/react";
import { ArrowDown, ArrowRight, Blocks, Bot, Boxes, ChevronRight, Cpu, FileSearch, Fingerprint, GitBranch, Lock, Network, Radar, ScanLine, ShieldAlert, ShieldCheck, Sparkles, Waypoints } from "lucide-react";
import "@fontsource-variable/space-grotesk";
import { api, type AuditEvent } from "../lib/api";
import { BLOCKS, forgeState, type ForgeState } from "../lib/forge";
import { LEAVES, TAMPERED } from "../lib/merkle";
import MerkleEvidence from "../components/landing/MerkleEvidence";
import { EASE } from "../lib/motion";
import Particles from "../components/reactbits/Particles";
import ShinyText from "../components/reactbits/ShinyText";
import DecryptedText from "../components/reactbits/DecryptedText";
import GradientText from "../components/reactbits/GradientText";
import CountUp from "../components/reactbits/CountUp";
import Magnet from "../components/reactbits/Magnet";
import ScrollVelocity from "../components/reactbits/ScrollVelocity";
import LetterGlitch from "../components/reactbits/LetterGlitch";
import SpotlightCard from "../components/reactbits/SpotlightCard";

const ChainForge3D = lazy(() => import("../components/landing/ChainForge3D"));

const DISPLAY = { fontFamily: "'Space Grotesk Variable', 'Inter Variable', system-ui, sans-serif" };
const MINT = "#38D6AC";
const CYAN = "#7FE7FF";
const CORAL = "#FA7070";

const STAGE_COPY = [
  { k: "01", title: "Claims arrive loose", body: "A proposal is text, PDFs and promises. Nothing binds them, and nobody can tell which version voters actually read.", icon: ScanLine },
  { k: "02", title: "Evidence gets hashed", body: "Every document receives a sha256 fingerprint and joins a Merkle root, so a single changed word is detectable forever.", icon: Fingerprint },
  { k: "03", title: "Votes bind the manifest", body: "Voters approve one EIP-712 digest: the exact recipient, amount and calldata, not a paragraph that describes them.", icon: GitBranch },
  { k: "04", title: "The guard enforces it", body: "The ExecutionGuard recomputes the digest before it moves a token. Change one byte and the payload reverts on-chain.", icon: Lock },
  { k: "05", title: "The ledger locks", body: "Every step is hash-linked to the one before and anchored on-chain. The chain is firm, and anyone can re-verify it.", icon: Blocks },
];

const SAMPLE_HASHES = Array.from({ length: BLOCKS }, (_, i) => `sha256:${(0x9e3779b9 * (i + 7)).toString(16).padStart(8, "0").repeat(8).slice(0, 64)}`);

function useLanding() {
  const health = useQuery({ queryKey: ["landing-health"], queryFn: () => api.get<any>("/health"), refetchInterval: 6000, retry: false });
  const ready = health.data?.state?.phase === "ready";
  const events = useQuery({ queryKey: ["landing-events"], queryFn: () => api.get<{ items: AuditEvent[] }>("/audit-events?limit=1000"), enabled: ready, refetchInterval: 10000, retry: false });
  const overview = useQuery({ queryKey: ["landing-overview"], queryFn: () => api.get<any>("/overview"), enabled: ready, retry: false });
  const grant = useQuery({ queryKey: ["landing-gov042"], queryFn: () => api.get<any>("/proposals/GOV-042"), enabled: ready, retry: false });
  const items = events.data?.items ?? [];
  return {
    ready,
    block: health.data?.chain?.block as number | undefined,
    events: items,
    count: items.length || undefined,
    share: items.length ? Math.round((items.filter((e) => e.verification === "chain-confirmed").length / items.length) * 100) : undefined,
    proposals: overview.data?.pipeline?.length as number | undefined,
    hashes: items.length >= BLOCKS ? [...items].reverse().slice(-BLOCKS).map((e) => e.event_hash) : SAMPLE_HASHES,
    docs: evidenceDocs((grant.data?.evidence ?? []).map((e: any) => String(e.name))),
  };
}

/** Eight leaves for the Merkle tree: the grant's real evidence first, padded with its other commitments.
    The budget memo sits at the slot that gets "edited", matching the 520k vs 500k story above it. */
function evidenceDocs(real: string[]): string[] {
  const pad = ["GOV-042 proposal text", "Forum post: grant proposal", "Recipient multisig", "Signed disclosure v2", "Manifest digest v2", "Grant budget memo.pdf", "Milestone schedule", "Vote record"];
  const docs = [...new Set([...real, ...pad])].slice(0, LEAVES);
  const memo = docs.findIndex((d) => /budget|memo/i.test(d));
  if (memo >= 0 && memo !== TAMPERED) [docs[memo], docs[TAMPERED]] = [docs[TAMPERED], docs[memo]];
  return docs;
}

export default function Landing() {
  const data = useLanding();
  useEffect(() => {
    const prev = document.body.style.backgroundColor;
    document.body.style.backgroundColor = "#05080c"; // overscroll matches the page
    document.title = "DAOGuard · Every DAO vote, forged into proof";
    return () => {
      document.body.style.backgroundColor = prev;
      document.title = "DAOGuard · DAO Audit Engine";
    };
  }, []);
  return (
    <div className="relative min-h-screen overflow-x-clip bg-[#05080c] text-[#E8F3F0] antialiased selection:bg-[#38D6AC]/30">
      {/* One particle network behind the whole page (it listens on window, so it still reacts to the pointer). */}
      <div className="pointer-events-none fixed inset-0 z-0" aria-hidden>
        <Particles particleCount={240} particleSpread={10} speed={0.05} particleColors={[MINT, "#52F2C3", MINT, CYAN]} connections connectionDistance={115} particleBaseSize={66} glow={0.34} twinkle={0.35} hoverEffect="repel" clickBurst={false} />
      </div>
      <Nav />
      <Hero data={data} />
      <Forge hashes={data.hashes} />
      <Ticker events={data.events} />
      <LedgerSpine>
        <Illusion />
        <MerkleEvidence docs={data.docs} marker={<SpineBlock n={11} label="Evidence" />} />
        <Pillars />
        <Features />
        <AssistantSection />
        <FinalCta />
      </LedgerSpine>
      <Footer />
    </div>
  );
}

/* ------------------------------------------------------------------ chrome */
function Logo() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[#38D6AC] to-[#1E8C77] shadow-[0_0_24px_rgba(56,214,172,0.45)]">
        <ShieldCheck className="h-[18px] w-[18px] text-[#04130F]" strokeWidth={2.4} />
      </span>
      <span className="text-[15px] font-bold tracking-[0.06em]" style={DISPLAY}>DAOGUARD</span>
    </span>
  );
}

function LaunchButton({ big = false, label = "Launch the app", short }: { big?: boolean; label?: string; short?: string }) {
  return (
    // A static highlight (filled mint, inner top light, soft fixed glow) marks the primary action; nothing loops.
    <Magnet padding={big ? 90 : 40} magnetStrength={big ? 3 : 4}>
      <Link
        to="/overview"
        className={`group inline-flex items-center gap-2 whitespace-nowrap rounded-xl bg-gradient-to-b from-[#5BEBC4] to-[#2BB892] font-semibold text-[#03130E] shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_10px_30px_-12px_rgba(56,214,172,0.7)] ring-1 ring-[#9FF5DC]/40 transition-[filter,transform] duration-200 hover:-translate-y-0.5 hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#38D6AC] ${big ? "px-7 py-4 text-[16px]" : "px-3.5 py-2 text-[13.5px] sm:px-4"}`}
      >
        {short ? <><span className="sm:hidden">{short}</span><span className="hidden sm:inline">{label}</span></> : label}
        <ArrowRight className={`${big ? "h-5 w-5" : "h-4 w-4"} transition-transform duration-200 group-hover:translate-x-0.5`} />
      </Link>
    </Magnet>
  );
}

function Nav() {
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const on = () => setSolid(window.scrollY > 24);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  const links: Array<[string, string]> = [["#forge", "The forge"], ["#guard", "Execution guard"], ["#features", "Platform"], ["#assistant", "Local AI"]];
  return (
    <motion.header initial={{ y: -24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.6, ease: EASE }}
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${solid ? "border-b border-white/[0.06] bg-[#05080c]/80 backdrop-blur-xl" : "bg-transparent"}`}>
      <nav aria-label="Landing" className="mx-auto flex h-16 max-w-[1240px] items-center justify-between px-5">
        <a href="#top" aria-label="DAOGuard home"><Logo /></a>
        <ul className="hidden items-center gap-1 md:flex">
          {links.map(([href, label]) => (
            <li key={href}>
              <a href={href} className="rounded-lg px-3 py-2 text-[13px] font-medium text-[#9DB2B5] transition-colors duration-200 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#38D6AC]">{label}</a>
            </li>
          ))}
        </ul>
        <LaunchButton short="Launch" />
      </nav>
    </motion.header>
  );
}

/* ------------------------------------------------------------------ hero */
function Stat({ label, value, suffix = "", prefix = "" }: { label: string; value?: number; suffix?: string; prefix?: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-3 backdrop-blur-md">
      <p className="text-[22px] font-semibold tabular-nums leading-none text-white md:text-[26px]" style={DISPLAY}>
        {value === undefined ? <span className="text-[#4d5f63]">—</span> : <CountUp to={value} prefix={prefix} suffix={suffix} separator="," duration={1.6} />}
      </p>
      <p className="mt-1.5 text-[11.5px] font-medium uppercase tracking-[0.12em] text-[#7E9497]">{label}</p>
    </div>
  );
}

function Hero({ data }: { data: ReturnType<typeof useLanding> }) {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const lift = useTransform(scrollYProgress, [0, 1], [0, -120]);
  const fade = useTransform(scrollYProgress, [0, 0.8], [1, 0]);
  return (
    <section id="top" ref={ref} className="relative flex min-h-[100svh] items-center overflow-hidden pt-16">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_35%,rgba(56,214,172,0.13),transparent_70%),radial-gradient(40%_40%_at_85%_80%,rgba(127,231,255,0.10),transparent_70%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.22] [background-image:linear-gradient(rgba(127,231,255,0.10)_1px,transparent_1px),linear-gradient(90deg,rgba(127,231,255,0.10)_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_72%)]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-[#05080c]" />

      <motion.div style={{ y: lift, opacity: fade }} className="relative mx-auto w-full max-w-[1240px] px-5 text-center">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15, duration: 0.6, ease: EASE }}
          className="mx-auto inline-flex items-center gap-2.5 rounded-full border border-[#38D6AC]/25 bg-[#38D6AC]/[0.07] px-3.5 py-1.5 text-[12px] font-medium">
          <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#38D6AC] opacity-60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-[#38D6AC]" /></span>
          <ShinyText text={data.block ? `Live on the demo chain · block #${data.block}` : "Governance intelligence · Execution assurance"} color="#9FE9D6" shineColor="#ffffff" speed={3} />
        </motion.div>

        <h1 className="mx-auto mt-7 max-w-[980px] text-[44px] font-semibold leading-[1.02] tracking-[-0.035em] sm:text-[60px] md:text-[78px] lg:text-[88px]" style={DISPLAY}>
          <span className="block text-white">
            <DecryptedText text="Every DAO vote," animateOn="view" sequential speed={38} revealDirection="start" characters="0123456789abcdef#$%&" encryptedClassName="text-[#38D6AC]/70" />
          </span>
          <span className="block">
            <GradientText colors={[MINT, CYAN, "#B7FFE9", MINT]} animationSpeed={6} className="!mx-0 inline">forged into proof.</GradientText>
          </span>
        </h1>
        <motion.p initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5, duration: 0.7, ease: EASE }}
          className="mx-auto mt-6 max-w-[640px] text-[16px] leading-relaxed text-[#A9BCBF] md:text-[18px]">
          DAOGuard reads every proposal, checks every payload against exactly what voters approved, and seals each step in a hash-chained ledger anchored on-chain.
        </motion.p>
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.7, duration: 0.7, ease: EASE }} className="mt-9 flex flex-wrap items-center justify-center gap-4">
          <LaunchButton big />
          <a href="#forge" className="group inline-flex items-center gap-2 rounded-xl border border-white/10 px-5 py-3.5 text-[14px] font-medium text-[#C9D9DB] transition-colors duration-200 hover:border-white/25 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#38D6AC]">
            Watch the chain form <ArrowDown className="h-4 w-4 transition-transform duration-200 group-hover:translate-y-0.5" />
          </a>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.9, duration: 0.7, ease: EASE }} className="mx-auto mt-14 grid max-w-[860px] grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Current block" value={data.block} prefix="#" />
          <Stat label="Ledger events" value={data.count} />
          <Stat label="Chain-confirmed" value={data.share} suffix="%" />
          <Stat label="Proposals guarded" value={data.proposals} />
        </motion.div>
        {!data.ready && <p className="mt-3 text-[12px] text-[#5f7579]">Start the demo with <code className="font-mono text-[#8fd8c4]">npm run dev</code> to see live numbers.</p>}
      </motion.div>
      <motion.a href="#forge" aria-label="Scroll to the forge" style={{ opacity: fade }} className="absolute bottom-7 left-1/2 hidden -translate-x-1/2 flex-col items-center gap-2 text-[11px] md:flex font-medium uppercase tracking-[0.2em] text-[#6E8589]">
        Scroll to forge the chain
        <span className="flex h-9 w-5 justify-center rounded-full border border-white/20 pt-1.5"><motion.span animate={{ y: [0, 10, 0] }} transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }} className="h-1.5 w-1 rounded-full bg-[#38D6AC]" /></span>
      </motion.a>
    </section>
  );
}

/* ------------------------------------------------------------------ the forge */
function ForgeFallback({ state }: { state: ForgeState }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center" aria-hidden>
      <div className="flex items-center gap-2">
        {Array.from({ length: BLOCKS }, (_, i) => {
          const firm = i < state.verified;
          return (
            <div key={i} className="flex items-center gap-2">
              <div className="h-12 w-16 rounded-lg border transition-all duration-500 md:h-16 md:w-24" style={{ borderColor: firm ? MINT : CORAL, background: firm ? "rgba(56,214,172,0.18)" : "transparent", boxShadow: firm ? "0 0 24px rgba(56,214,172,0.35)" : "none", opacity: firm ? 1 : 0.5 }} />
              {i < BLOCKS - 1 && <div className="h-1 w-4 rounded-full transition-colors duration-500" style={{ background: i < state.links ? MINT : "rgba(255,255,255,0.12)" }} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Forge({ hashes }: { hashes: string[] }) {
  const ref = useRef<HTMLElement>(null);
  const progress = useRef(0);
  const reduce = useReducedMotion();
  const [state, setState] = useState<ForgeState>(() => forgeState(0));
  const [webgl, setWebgl] = useState(true);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  useMotionValueEvent(scrollYProgress, "change", (v) => {
    progress.current = v;
    const next = forgeState(v);
    setState((s) => (s.verified === next.verified && s.links === next.links && s.integrity === next.integrity && s.stage === next.stage ? s : next));
  });
  const bar = useTransform(scrollYProgress, [0, 1], ["0%", "100%"]);
  const stage = STAGE_COPY[state.stage];
  // With reduced motion the scene shows the finished chain, so the HUD reports it too; captions still follow the scroll.
  const hud = reduce ? forgeState(1) : state;
  const latest = hashes[Math.min(hashes.length - 1, Math.max(0, hud.verified - 1))] ?? hashes[0];

  return (
    <section id="forge" ref={ref} className="relative h-[460vh]" aria-label="How DAOGuard forges a proposal into a verifiable chain">
      <div className="sticky top-0 h-[100svh] overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(70%_60%_at_50%_55%,rgba(56,214,172,0.08),transparent_70%)]" />
        {webgl ? (
          <Suspense fallback={<ForgeFallback state={state} />}>
            <ChainForge3D progress={progress} hashes={hashes} onError={() => setWebgl(false)} />
          </Suspense>
        ) : (
          <ForgeFallback state={state} />
        )}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,#05080c_100%)]" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-[#05080c] to-transparent" />

        <div className="relative mx-auto flex h-full max-w-[1240px] flex-col justify-between px-5 pb-8 pt-24">
          <div className="flex items-start justify-between gap-6">
            <div className="max-w-[430px]">
              <p className="text-[12px] font-semibold uppercase tracking-[0.22em] text-[#38D6AC]">The forge</p>
              <AnimatePresence mode="wait">
                <motion.div key={stage.k} initial={{ opacity: 0, y: 18, filter: "blur(6px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={{ opacity: 0, y: -14, filter: "blur(6px)" }} transition={{ duration: 0.45, ease: EASE }} className="mt-3">
                  <div className="flex items-center gap-3">
                    <span className="text-[56px] font-semibold leading-none text-white/[0.12] md:text-[72px]" style={DISPLAY}>{stage.k}</span>
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#38D6AC]/30 bg-[#38D6AC]/10 text-[#38D6AC]"><stage.icon className="h-5 w-5" /></span>
                  </div>
                  <h2 className="mt-2 text-[30px] font-semibold leading-tight tracking-[-0.02em] text-white md:text-[40px]" style={DISPLAY}>{stage.title}</h2>
                  <p className="mt-3 text-[15px] leading-relaxed text-[#A9BCBF] md:text-[16.5px]">{stage.body}</p>
                </motion.div>
              </AnimatePresence>
            </div>

            <div className="hidden w-[290px] shrink-0 rounded-2xl border border-white/[0.08] bg-[#071012]/70 p-5 backdrop-blur-xl md:block">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7E9497]">Chain integrity</p>
              <p className="mt-1 text-[44px] font-semibold leading-none tabular-nums" style={{ ...DISPLAY, color: hud.integrity === 100 ? MINT : hud.integrity > 40 ? "#B7FFE9" : CORAL }}>{hud.integrity}%</p>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${hud.integrity}%`, background: `linear-gradient(90deg, ${CORAL}, ${MINT})` }} />
              </div>
              <dl className="mt-4 space-y-2 text-[13px]">
                <div className="flex justify-between"><dt className="text-[#7E9497]">Blocks verified</dt><dd className="font-semibold tabular-nums text-white">{hud.verified}/{BLOCKS}</dd></div>
                <div className="flex justify-between"><dt className="text-[#7E9497]">Hash links locked</dt><dd className="font-semibold tabular-nums text-white">{hud.links}/{BLOCKS - 1}</dd></div>
                <div className="flex justify-between"><dt className="text-[#7E9497]">Tamper tolerance</dt><dd className="font-semibold" style={{ color: hud.integrity === 100 ? MINT : CORAL }}>{hud.integrity === 100 ? "zero bytes" : "not yet sealed"}</dd></div>
              </dl>
              <div className="mt-4 rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#5f7579]">{hud.verified ? `Block #${String(hud.verified).padStart(2, "0")} hash` : "Awaiting first block"}</p>
                <p className="mt-1 truncate font-mono text-[11.5px] text-[#9FE9D6]">
                  {hud.verified ? <DecryptedText key={latest} text={latest} animateOn="view" speed={22} maxIterations={8} characters="0123456789abcdef" /> : "sha256:················"}
                </p>
              </div>
            </div>
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between gap-2 md:hidden">
              <span className="text-[12px] text-[#7E9497]">Integrity <b className="text-white">{hud.integrity}%</b></span>
              <span className="text-[12px] text-[#7E9497]">Blocks <b className="text-white">{hud.verified}/{BLOCKS}</b> · Links <b className="text-white">{hud.links}/{BLOCKS - 1}</b></span>
            </div>
            <ol className="grid grid-cols-5 gap-2">
              {STAGE_COPY.map((s, i) => (
                <li key={s.k} className="min-w-0">
                  <div className="h-[3px] overflow-hidden rounded-full bg-white/[0.08]">
                    <motion.div className="h-full rounded-full bg-[#38D6AC]" style={{ width: i < state.stage ? "100%" : i === state.stage ? bar : "0%", opacity: i <= state.stage ? 1 : 0.3 }} />
                  </div>
                  <p className={`mt-2 hidden truncate text-[11.5px] font-medium md:block ${i === state.stage ? "text-white" : i < state.stage ? "text-[#38D6AC]" : "text-[#5f7579]"}`}>{s.k} · {s.title}</p>
                </li>
              ))}
            </ol>
            {reduce && <p className="mt-2 text-[11px] text-[#5f7579]">Reduced motion is on, so the chain is shown already forged.</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ live ticker */
function Ticker({ events }: { events: AuditEvent[] }) {
  const rows = useMemo(() => {
    const src = events.length ? events.slice(0, 24) : SAMPLE_HASHES.map((h, i) => ({ seq: 77 - i, event_type: "ledger_event", event_hash: h }) as AuditEvent);
    const fmt = (e: AuditEvent) => `${e.event_hash.slice(0, 19)}… ${e.event_type.replace(/_/g, " ").toUpperCase()} #${e.seq}`;
    return [src.filter((_, i) => i % 2 === 0).map(fmt).join("   ◆   "), src.filter((_, i) => i % 2 === 1).map(fmt).join("   ◆   ")];
  }, [events]);
  return (
    <section aria-label="Live audit ledger" className="relative border-y border-white/[0.06] bg-[#060b0e]/60 py-7 backdrop-blur-[2px]">
      <p className="mx-auto mb-4 flex max-w-[1240px] items-center gap-2 px-5 text-[11.5px] font-semibold uppercase tracking-[0.2em] text-[#7E9497]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#38D6AC] shadow-[0_0_10px_#38D6AC]" /> {events.length ? "Live from the audit ledger" : "Audit ledger preview"}
      </p>
      <ScrollVelocity texts={rows} velocity={22} numCopies={4} fadeEdges className="font-mono text-[14px] font-medium text-[#6FCDB4]/80 md:text-[16px]" gap={48} />
    </section>
  );
}

/* ------------------------------------------------------------------ the illusion */
function Field({ k, v, bad, delay }: { k: string; v: string; bad?: boolean; delay: number }) {
  return (
    <motion.div initial={{ opacity: 0, x: -10 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }} transition={{ delay, duration: 0.4, ease: EASE }}
      className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 font-mono text-[12.5px] ${bad ? "bg-[#FA7070]/10 text-[#FFB4B4] ring-1 ring-[#FA7070]/40" : "bg-white/[0.03] text-[#CFE4E0]"}`}>
      <span className="text-[#6E8589]">{k}</span>
      {bad ? <DecryptedText text={v} animateOn="view" speed={45} maxIterations={14} characters="0123456789abcdefx" className="text-[#FFB4B4]" /> : <span className="truncate">{v}</span>}
    </motion.div>
  );
}

function Illusion() {
  return (
    <section id="guard" className="relative overflow-hidden py-20 md:py-24">
      <SpineBlock n={10} label="Guard" />
      <div className="absolute inset-0 opacity-[0.34]">
        <LetterGlitch glitchColors={["#1c3b36", MINT, "#2a5d59"]} characters="0123456789abcdef" fontSize={14} speed={0.6} glitchAmount={0.35} baseOpacity={0.14} edgeFade={0.6} centerFade={0.5} interactive={false} />
      </div>
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#05080c]/80 via-transparent to-[#05080c]/80" />
      <div className="relative mx-auto grid max-w-[1240px] items-center gap-14 px-5 lg:grid-cols-[1fr_1.05fr]">
        <motion.div initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-80px" }} transition={{ duration: 0.7, ease: EASE }}>
          <p className="text-[12px] font-semibold uppercase tracking-[0.22em] text-[#FA7070]">The governance illusion</p>
          <h2 className="mt-4 text-[36px] font-semibold leading-[1.05] tracking-[-0.03em] text-white md:text-[52px]" style={DISPLAY}>
            Voters approve words.<br />Chains execute <span className="text-[#FA7070]">bytes</span>.
          </h2>
          <p className="mt-5 max-w-[520px] text-[16px] leading-relaxed text-[#A9BCBF]">
            When the payload drifts from the proposal, a different recipient, a bigger amount, a backdoored upgrade, nobody notices until the treasury moves. DAOGuard makes the drift impossible to miss and impossible to execute.
          </p>
          <ul className="mt-7 space-y-3 text-[14.5px] text-[#C9D9DB]">
            {[
              [ShieldCheck, "One EIP-712 digest binds recipient, amount and calldata"],
              [Radar, "The sentinel simulates every approval before it can run"],
              [ShieldAlert, "Tampered payloads revert on-chain, with the proof recorded"],
            ].map(([I, t]) => {
              const Icon = I as typeof ShieldCheck;
              return (
                <li key={t as string} className="flex items-center gap-3"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#38D6AC]/10 text-[#38D6AC]"><Icon className="h-4 w-4" /></span>{t as string}</li>
              );
            })}
          </ul>
        </motion.div>

        <div className="relative">
          <div className="grid gap-4 sm:grid-cols-2">
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.6, ease: EASE }} className="rounded-2xl border border-[#38D6AC]/25 bg-[#071211]/90 p-4 backdrop-blur">
              <p className="mb-3 flex items-center gap-2 text-[12px] font-semibold text-[#38D6AC]"><ShieldCheck className="h-4 w-4" /> What voters approved</p>
              <div className="space-y-1.5">
                <Field k="to" v="Wallet A · Northstar" delay={0.1} />
                <Field k="amount" v="500,000 mUSDC" delay={0.18} />
                <Field k="call" v="transfer(to, amount)" delay={0.26} />
                <Field k="digest" v="0x9e48…a8c1d2" delay={0.34} />
              </div>
            </motion.div>
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ delay: 0.15, duration: 0.6, ease: EASE }} className="rounded-2xl border border-[#FA7070]/30 bg-[#140909]/90 p-4 backdrop-blur">
              <p className="mb-3 flex items-center gap-2 text-[12px] font-semibold text-[#FA7070]"><ShieldAlert className="h-4 w-4" /> What was submitted</p>
              <div className="space-y-1.5">
                <Field k="to" v="0xBAD0…77e1" bad delay={0.3} />
                <Field k="amount" v="520,000 mUSDC" bad delay={0.38} />
                <Field k="call" v="transfer(to, amount)" delay={0.46} />
                <Field k="digest" v="0x41f0…0be93a" bad delay={0.54} />
              </div>
            </motion.div>
          </div>
          <motion.div initial={{ opacity: 0, scale: 1.6, rotate: -14 }} whileInView={{ opacity: 1, scale: 1, rotate: -6 }} viewport={{ once: true, margin: "-60px" }} transition={{ delay: 0.9, type: "spring", stiffness: 260, damping: 16 }}
            className="relative mx-auto mt-6 w-fit rounded-xl border-2 border-[#FA7070] bg-[#1a0b0b]/95 px-5 py-3 text-center shadow-[0_0_40px_rgba(250,112,112,0.35)]">
            <p className="font-mono text-[18px] font-bold tracking-[0.06em] text-[#FF8A8A]">REVERT · ManifestMismatch</p>
            <p className="mt-0.5 text-[12px] text-[#E9B9B9]">The guard recomputed the digest. Nothing moved; the attempt is on-chain.</p>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ pillars */
function Pillars() {
  const pillars = [
    { icon: FileSearch, title: "Understand the decision", body: "A cited brief for every proposal: each claim quotes its source, and gaps or contradictions become questions for the proposer.", chips: ["Cited brief", "Missing-info rules", "Signed Q&A"] },
    { icon: ShieldCheck, title: "Verify the execution", body: "Voters approve one digest. The guard recomputes it and reverts any change; upgrades are simulated before they can run.", chips: ["EIP-712 manifest", "Bytecode simulation", "Guardian halt"] },
    { icon: Waypoints, title: "Preserve the evidence", body: "Every action becomes a hash-chained ledger event, anchored on-chain and re-verifiable by anyone, any time.", chips: ["sha256 chain", "On-chain anchors", "Compliance exports"] },
  ];
  return (
    <section className="relative py-16 md:py-20">
      <SpineBlock n={12} label="Guarantees" />
      <div className="mx-auto max-w-[1240px] px-5">
        <SectionHead eyebrow="Three guarantees" title={<>Clarity before the vote.<br />Certainty after it.</>} />
        <div className="relative mt-10 grid gap-5 md:grid-cols-3">
          <DataBeam />
          {pillars.map((p, i) => (
            <motion.div key={p.title} initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ delay: i * 0.12, duration: 0.6, ease: EASE }}>
              <SpotlightCard spotlightColor="rgba(56,214,172,0.22)" className="relative h-full rounded-2xl border border-white/[0.08] bg-[#081012]/90 p-7 backdrop-blur-sm">
                <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-[#38D6AC]/25 bg-[#38D6AC]/10 text-[#38D6AC]"><p.icon className="h-6 w-6" /></span>
                <h3 className="mt-6 text-[22px] font-semibold tracking-[-0.01em] text-white" style={DISPLAY}>{p.title}</h3>
                <p className="mt-3 text-[14.5px] leading-relaxed text-[#A9BCBF]">{p.body}</p>
                <ul className="mt-6 flex flex-wrap gap-2">
                  {p.chips.map((c) => <li key={c} className="rounded-full border border-white/10 px-2.5 py-1 text-[11.5px] font-medium text-[#C9D9DB]">{c}</li>)}
                </ul>
              </SpotlightCard>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

function SectionHead({ eyebrow, title, body }: { eyebrow: string; title: ReactNode; body?: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.6, ease: EASE }} className="max-w-[760px]">
      <p className="text-[12px] font-semibold uppercase tracking-[0.22em] text-[#38D6AC]">{eyebrow}</p>
      <h2 className="mt-4 text-[34px] font-semibold leading-[1.06] tracking-[-0.03em] text-white md:text-[50px]" style={DISPLAY}>{title}</h2>
      {body && <p className="mt-5 max-w-[620px] text-[16px] leading-relaxed text-[#A9BCBF]">{body}</p>}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ feature bento */
function MiniGraph() {
  const nodes = [[30, 40], [80, 22], [120, 58], [62, 82], [150, 30], [170, 76]];
  const edges = [[0, 1], [1, 2], [2, 3], [0, 3], [1, 4], [4, 5], [2, 5]];
  return (
    <svg viewBox="0 0 200 100" className="h-full w-full" aria-hidden>
      {edges.map(([a, b], i) => <motion.line key={i} x1={nodes[a][0]} y1={nodes[a][1]} x2={nodes[b][0]} y2={nodes[b][1]} stroke={i === 2 ? CORAL : "rgba(127,231,255,0.45)"} strokeWidth={1.4} initial={{ pathLength: 0 }} whileInView={{ pathLength: 1 }} viewport={{ once: true }} transition={{ delay: i * 0.08, duration: 0.6 }} />)}
      {nodes.map(([x, y], i) => <motion.circle key={i} cx={x} cy={y} r={i === 3 ? 6 : 4.5} fill={i === 3 ? CORAL : MINT} initial={{ scale: 0 }} whileInView={{ scale: 1 }} viewport={{ once: true }} transition={{ delay: 0.3 + i * 0.06 }} />)}
    </svg>
  );
}

function MiniChain() {
  const reduce = useReducedMotion(); // cx is not a transform, so MotionConfig alone would not stop the loop
  return (
    <svg viewBox="0 0 200 100" className="h-full w-full" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <motion.rect x={14 + i * 46} y={34} width={34} height={30} rx={6} fill="rgba(56,214,172,0.14)" stroke={MINT} strokeWidth={1.4} initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.15 }} />
          {i < 3 && <motion.line x1={48 + i * 46} y1={49} x2={60 + i * 46} y2={49} stroke={CYAN} strokeWidth={2} initial={{ pathLength: 0 }} whileInView={{ pathLength: 1 }} viewport={{ once: true }} transition={{ delay: 0.2 + i * 0.15 }} />}
        </g>
      ))}
      {!reduce && <motion.circle r={4} cy={49} fill={CYAN} initial={{ cx: 20 }} animate={{ cx: [20, 180, 20] }} transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }} />}
    </svg>
  );
}

function MiniRing({ value }: { value: number }) {
  const c = 2 * Math.PI * 34;
  return (
    <svg viewBox="0 0 200 100" className="h-full w-full" aria-hidden>
      <circle cx={100} cy={50} r={34} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={8} />
      <motion.circle cx={100} cy={50} r={34} fill="none" stroke={MINT} strokeWidth={8} strokeLinecap="round" strokeDasharray={c} initial={{ strokeDashoffset: c }} whileInView={{ strokeDashoffset: c * (1 - value / 100) }} viewport={{ once: true }} transition={{ duration: 1.2, ease: EASE }} transform="rotate(-90 100 50)" />
      <text x={100} y={56} textAnchor="middle" fill="#fff" fontSize={18} fontWeight={700} style={DISPLAY}>{value}</text>
    </svg>
  );
}

function MiniBars() {
  const v = [32, 40, 4, 2];
  return (
    <svg viewBox="0 0 200 100" className="h-full w-full" aria-hidden>
      {v.map((x, i) => (
        <g key={i}>
          <rect x={20} y={14 + i * 20} width={160} height={10} rx={5} fill="rgba(255,255,255,0.06)" />
          <motion.rect x={20} y={14 + i * 20} height={10} rx={5} fill={x > 30 ? "#F2B44C" : MINT} initial={{ width: 0 }} whileInView={{ width: (x / 50) * 160 }} viewport={{ once: true }} transition={{ delay: i * 0.1, duration: 0.8, ease: EASE }} />
        </g>
      ))}
    </svg>
  );
}

function MiniGate() {
  const reduce = useReducedMotion();
  return (
    <svg viewBox="0 0 200 100" className="h-full w-full" aria-hidden>
      <rect x={96} y={14} width={8} height={72} rx={3} fill={CORAL} opacity={0.8} />
      <motion.rect width={22} height={16} rx={4} y={42} fill={MINT} initial={{ x: reduce ? 70 : 10 }} animate={reduce ? { x: 70 } : { x: [10, 70, 70, 10] }} transition={reduce ? { duration: 0 } : { duration: 3.2, repeat: Infinity, times: [0, 0.45, 0.6, 1], ease: "easeInOut" }} />
      <motion.text x={124} y={54} fill={CORAL} fontSize={11} fontFamily="JetBrains Mono, monospace" animate={reduce ? { opacity: 1 } : { opacity: [0, 0, 1, 0] }} transition={reduce ? { duration: 0 } : { duration: 3.2, repeat: Infinity, times: [0, 0.44, 0.5, 0.9] }}>REVERT</motion.text>
    </svg>
  );
}

function MiniChat() {
  return (
    <div className="flex h-full flex-col justify-center gap-2 px-2" aria-hidden>
      <motion.span initial={{ opacity: 0, x: 12 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }} className="ml-auto rounded-xl rounded-br-sm bg-white/10 px-3 py-1.5 text-[11.5px]">risk?</motion.span>
      <motion.span initial={{ opacity: 0, x: -12 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }} transition={{ delay: 0.4 }} className="w-fit rounded-xl rounded-bl-sm border border-[#38D6AC]/25 bg-[#38D6AC]/10 px-3 py-1.5 text-[11.5px] text-[#CFFAEE]">GOV-042 ranks first · 62%</motion.span>
    </div>
  );
}

function Features() {
  const items: Array<{ title: string; body: string; to: string; icon: typeof Radar; art: ReactNode; wide?: boolean }> = [
    { title: "Probabilistic evaluation chain", body: "Four stages, every likelihood ratio shown. A model estimate to direct attention, never a verdict.", to: "/overview", icon: Radar, art: <MiniBars />, wide: true },
    { title: "Relationship explorer", body: "Undisclosed transfers and shared funders surface as leads, never as accusations.", to: "/relationships", icon: Network, art: <MiniGraph /> },
    { title: "Execution guardian", body: "Preflight any payload. Tampered recipients and amounts revert on-chain.", to: "/guardian", icon: ShieldCheck, art: <MiniGate /> },
    { title: "Ledger constellation", body: "Tie strings between events and re-hash every link between them.", to: "/audit", icon: Boxes, art: <MiniChain /> },
    { title: "Compliance scorecard", body: "A readiness score that shows its working, plus control coverage per proposal.", to: "/reports", icon: Sparkles, art: <MiniRing value={51} /> },
    { title: "Local AI assistant", body: "Ask in your own words; a model trained on this app answers from live data.", to: "/overview", icon: Bot, art: <MiniChat />, wide: true },
  ];
  return (
    <section id="features" className="relative py-16 md:py-20">
      <SpineBlock n={13} label="Platform" />
      <div className="mx-auto max-w-[1240px] px-5">
        <SectionHead eyebrow="The platform" title="Every page is a proof surface." body="Open any of them with the live demo chain: real transactions, real reverts, fictional DAO." />
        <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          {items.map((f, i) => (
            <ParallaxCard key={f.title} speed={[34, -26, 44, -34, 22, -28][i]} className={f.wide ? "lg:col-span-2" : ""} delay={(i % 3) * 0.1}>
              <Link to={f.to} className="group block h-full rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#38D6AC]">
                <SpotlightCard spotlightColor="rgba(127,231,255,0.18)" className="flex h-full flex-col rounded-2xl border border-white/[0.08] bg-[#081012] p-6 transition-colors duration-300 group-hover:border-[#38D6AC]/35">
                  <div className="h-[120px] rounded-xl border border-white/[0.05] bg-black/30 p-2">{f.art}</div>
                  <div className="mt-5 flex items-center gap-2.5">
                    <f.icon className="h-5 w-5 text-[#38D6AC]" />
                    <h3 className="text-[17px] font-semibold text-white" style={DISPLAY}>{f.title}</h3>
                  </div>
                  <p className="mt-2 flex-1 text-[14px] leading-relaxed text-[#A9BCBF]">{f.body}</p>
                  <span className="mt-4 inline-flex items-center gap-1 text-[13px] font-semibold text-[#38D6AC]">Open <ChevronRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1" /></span>
                </SpotlightCard>
              </Link>
            </ParallaxCard>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ assistant */
const DEMO: Array<[string, string]> = [
  ["how much?", "GOV-044 requests **45,000 mUSDC**, 1.8% of the treasury. No itemised budget yet (MI-R001)."],
  ["and 42?", "GOV-042 requests **500,000 mUSDC** in three milestones. Sources disagree: a memo says 520,000."],
  ["why?", "The evaluation chain puts it at **62%**: an undisclosed transfer (×3.0) and the amount mismatch (×3.0)."],
];

function AssistantSection() {
  const [shown, setShown] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    if (reduce) {
      setShown(DEMO.length * 2);
      return;
    }
    const el = ref.current;
    if (!el) return;
    let timer = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting || timer) return;
      let k = 0;
      timer = window.setInterval(() => {
        k += 1;
        setShown(k);
        if (k >= DEMO.length * 2) window.clearInterval(timer);
      }, 900);
    }, { threshold: 0.4 });
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearInterval(timer);
    };
  }, [reduce]);
  return (
    <section id="assistant" className="relative overflow-hidden py-16 md:py-24">
      <SpineBlock n={14} label="Local AI" />
      <div className="pointer-events-none absolute -left-40 top-20 h-[420px] w-[420px] rounded-full bg-[#38D6AC]/10 blur-[120px]" />
      <div className="relative mx-auto grid max-w-[1240px] items-center gap-14 px-5 lg:grid-cols-2">
        <div>
          <SectionHead eyebrow="Local AI" title={<>Ask anything.<br />It runs on your machine.</>} />
          <ul className="mt-8 space-y-4 text-[15px] text-[#C9D9DB]">
            {[
              [Cpu, "A locally trained intent model understands even two-word questions (98% on held-out phrasings)."],
              [Sparkles, "Open-source Qwen2.5 and nomic-embed-text run in Ollama. Nothing you type leaves the computer."],
              [Lock, "Read-only by design: it explains and links, it never votes, executes or halts."],
            ].map(([I, t]) => {
              const Icon = I as typeof Cpu;
              return <li key={t as string} className="flex gap-3"><Icon className="mt-0.5 h-5 w-5 shrink-0 text-[#38D6AC]" />{t as string}</li>;
            })}
          </ul>
        </div>
        <div ref={ref} className="rounded-3xl border border-white/[0.08] bg-[#071012]/90 p-5 shadow-[0_30px_80px_-30px_rgba(56,214,172,0.35)] backdrop-blur">
          <div className="mb-4 flex items-center gap-2.5 border-b border-white/[0.06] pb-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[#38D6AC] to-[#2F55E8]"><Bot className="h-4 w-4 text-white" /></span>
            <span><span className="block text-[13px] font-semibold">DAOGuard Assistant</span><span className="block text-[11px] text-[#7E9497]">Local AI · example conversation</span></span>
          </div>
          <div className="min-h-[250px] space-y-3">
            {DEMO.flatMap(([q, a], i) => [
              shown > i * 2 && (
                <motion.div key={`q${i}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex justify-end">
                  <span className="rounded-2xl rounded-br-md bg-white/10 px-3.5 py-2 text-[13.5px]">{q}</span>
                </motion.div>
              ),
              shown > i * 2 + 1 && (
                <motion.div key={`a${i}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="max-w-[88%] rounded-2xl rounded-tl-md border border-white/[0.07] bg-white/[0.03] px-3.5 py-2.5 text-[13.5px] leading-relaxed text-[#D7E7E4]">
                  {a.split("**").map((part, k) => (k % 2 ? <b key={k} className="text-white">{part}</b> : part))}
                </motion.div>
              ),
            ])}
            {shown < DEMO.length * 2 && shown > 0 && (
              <span className="inline-flex gap-1 px-1">{[0, 1, 2].map((d) => <motion.span key={d} className="h-1.5 w-1.5 rounded-full bg-[#38D6AC]" animate={{ opacity: [0.2, 1, 0.2] }} transition={{ duration: 1, repeat: Infinity, delay: d * 0.15 }} />)}</span>
            )}
          </div>
          <p className="mt-3 text-[11px] text-[#5f7579]">Open the app and press Ctrl+J to ask it yourself.</p>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ close */
function FinalCta() {
  return (
    <section className="relative overflow-hidden py-20 md:py-28">
      <SpineBlock n={15} label="Your turn" last />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_60%_at_50%_100%,rgba(56,214,172,0.18),transparent_70%)]" />
      <motion.div initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-80px" }} transition={{ duration: 0.8, ease: EASE }} className="relative mx-auto max-w-[900px] px-5 text-center">
        <h2 className="text-[42px] font-semibold leading-[1.02] tracking-[-0.035em] md:text-[72px]" style={DISPLAY}>
          <GradientText colors={["#ffffff", MINT, CYAN, "#ffffff"]} animationSpeed={7} className="!mx-0 inline">Make every vote verifiable.</GradientText>
        </h2>
        <p className="mx-auto mt-6 max-w-[560px] text-[16.5px] leading-relaxed text-[#A9BCBF]">Understand the decision. Verify the execution. Preserve the evidence. The full demo runs on a local chain in under a minute.</p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <LaunchButton big label="Enter DAOGuard" />
          <Link to="/audit" className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-5 py-3.5 text-[14px] font-medium text-[#C9D9DB] transition-colors duration-200 hover:border-white/25 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#38D6AC]">
            Inspect the audit ledger <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </motion.div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-white/[0.06] py-10">
      <div className="mx-auto flex max-w-[1240px] flex-col items-start justify-between gap-6 px-5 md:flex-row md:items-center">
        <div>
          <Logo />
          <p className="mt-3 max-w-[460px] text-[12.5px] leading-relaxed text-[#6E8589]">Built for CASCADE '26 · Theme 4, Information Asymmetry. Fictional demo data on a local Hardhat chain; no real funds are involved.</p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-[#9DB2B5]">
          {[["/overview", "Overview"], ["/proposals", "Proposals"], ["/guardian", "Execution guardian"], ["/audit", "Audit ledger"], ["/reports", "Compliance"]].map(([to, label]) => (
            <Link key={to} to={to} className="transition-colors duration-200 hover:text-white">{label}</Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------ lower-page motion */
/** The ledger keeps growing below the forge: a spine that fills as you read, one block per section. */
function LedgerSpine({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 55%", "end 55%"] });
  const fill = useSpring(scrollYProgress, { stiffness: 140, damping: 30, mass: 0.4 });
  return (
    <div ref={ref} className="relative">
      <div className="pointer-events-none absolute inset-y-0 z-[1] hidden w-px bg-white/[0.07] min-[1400px]:block" style={{ left: SPINE_X }} aria-hidden>
        <motion.div style={{ scaleY: fill }} className="absolute inset-0 origin-top bg-gradient-to-b from-[#38D6AC] via-[#7FE7FF] to-[#38D6AC] shadow-[0_0_10px_rgba(56,214,172,0.8)]" />
      </div>
      {children}
    </div>
  );
}

const SPINE_X = "max(18px, calc((100vw - 1240px) / 2 - 34px))";

/** A section's block on the spine: an unverified coral diamond until the reading line (the middle of the
    screen) passes it, then a locked mint block. Driven by scroll position, so jumping down the page works too. */
function SpineBlock({ n, label, last = false }: { n: number; label: string; last?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 55%", "start 50%"] });
  useMotionValueEvent(scrollYProgress, "change", (v) => setOn(v > 0.5));
  useEffect(() => setOn(scrollYProgress.get() > 0.5), [scrollYProgress]);
  return (
    <div ref={ref} className="pointer-events-none absolute top-24 z-[2] hidden -translate-x-1/2 min-[1400px]:block" style={{ left: SPINE_X }} aria-hidden>
      <motion.span
        animate={on ? { rotate: 0, scale: 1, borderColor: MINT, backgroundColor: "rgba(56,214,172,0.22)", boxShadow: "0 0 18px rgba(56,214,172,0.6)" } : { rotate: 45, scale: 0.7, borderColor: CORAL, backgroundColor: "rgba(250,112,112,0.06)", boxShadow: "0 0 0 rgba(0,0,0,0)" }}
        transition={{ type: "spring", stiffness: 260, damping: 18 }}
        className="block h-4 w-4 rounded-[4px] border-2"
      />
      <motion.span animate={{ opacity: on ? 1 : 0.35, x: on ? 0 : -4 }} className="absolute left-6 top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[10.5px] font-semibold tracking-[0.08em]" title={label} style={{ color: on ? MINT : "#5f7579" }}>
        #{n}
      </motion.span>
      <span className="sr-only">{label}{last ? " (last block)" : ""}</span>
    </div>
  );
}

/** Joins the three guarantee cards with a beam that carries packets between them. */
function DataBeam() {
  const reduce = useReducedMotion();
  return (
    <svg className="pointer-events-none absolute inset-x-0 top-[52px] z-0 hidden h-6 w-full md:block" viewBox="0 0 1000 24" preserveAspectRatio="none" aria-hidden>
      <line x1={60} y1={12} x2={940} y2={12} stroke="rgba(56,214,172,0.5)" strokeWidth={2} strokeDasharray="6 6" />
      {!reduce && [0, 1.3, 2.6].map((d) => (
        <motion.circle key={d} r={4} cy={12} fill={CYAN} initial={{ cx: 60, opacity: 0 }} animate={{ cx: [60, 940], opacity: [0, 1, 1, 0] }} transition={{ duration: 3.9, delay: d, repeat: Infinity, ease: "linear" }} />
      ))}
    </svg>
  );
}

/** A card that fades in, then drifts against the scroll at its own speed for depth. */
function ParallaxCard({ children, speed, className, delay }: { children: ReactNode; speed: number; className?: string; delay: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const y = useTransform(scrollYProgress, [0, 1], reduce ? [0, 0] : [speed, -speed]);
  return (
    <motion.div ref={ref} style={{ y }} className={className}>
      <motion.div className="h-full" initial={{ opacity: 0, y: 28 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ delay, duration: 0.6, ease: EASE }}>
        {children}
      </motion.div>
    </motion.div>
  );
}
