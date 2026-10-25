/* Motion primitives (motion.dev). One easing and a short set of durations keep movement
   consistent: entrances 0.35s, hovers 0.2s, layout slides spring. Reduced-motion users get the
   final state instantly (MotionConfig reducedMotion="user" plus the guards below). */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { animate, motion, MotionConfig, useInView, useReducedMotion, type Transition } from "motion/react";

export const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
export const SPRING: Transition = { type: "spring", stiffness: 420, damping: 34, mass: 0.7 };
export const ENTER: Transition = { duration: 0.35, ease: EASE };

export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={ENTER}>
      {children}
    </MotionConfig>
  );
}

/** Fades and lifts content in the first time it scrolls into view. */
export function Reveal({ children, className, delay = 0, y = 12 }: { children: ReactNode; className?: string; delay?: number; y?: number }) {
  return (
    <motion.div className={className} initial={{ opacity: 0, y }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-40px" }} transition={{ ...ENTER, delay }}>
      {children}
    </motion.div>
  );
}

/** Page entrance, keyed by route so every navigation settles in the same way. */
export function PageEnter({ id, children }: { id: string; children: ReactNode }) {
  return (
    <motion.div key={id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: EASE }}>
      {children}
    </motion.div>
  );
}

const NUM = /-?\d[\d,]*(?:\.\d+)?/;

/** Counts the first number in a string up to its value when it appears ("45,000 mUSDC", "28.5%", "02"). */
export function AnimatedNumber({ value, className, duration = 0.9 }: { value: string | number; className?: string; duration?: number }) {
  const text = String(value);
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const reduced = useReducedMotion();
  const match = NUM.exec(text);
  const last = useRef<number | null>(null); // value shown or being counted to; null until first seen
  const run = useRef<ReturnType<typeof animate> | null>(null);
  const latest = useRef(text);
  latest.current = text;

  useEffect(
    () => () => {
      run.current?.stop();
      run.current = null;
      last.current = null; // a remount (StrictMode, route change) counts up again from scratch
    },
    [],
  );

  // Layout effect: the starting value is written before paint, so the final number never flashes first.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !match) return;
    const raw = match[0];
    const target = Number(raw.replace(/,/g, ""));
    const decimals = raw.includes(".") ? raw.split(".")[1].length : 0;
    const pad = raw.startsWith("0") && raw.length > 1 && !raw.includes(".") ? raw.length : 0;
    const grouped = raw.includes(",");
    const fmt = (v: number) => {
      let s = decimals ? v.toFixed(decimals) : String(Math.round(v));
      if (grouped) s = Number(s).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      if (pad) s = s.padStart(pad, "0");
      return text.slice(0, match.index) + s + text.slice(match.index + raw.length);
    };
    if (reduced || !Number.isFinite(target)) {
      run.current?.stop();
      el.textContent = text;
      last.current = target;
      return;
    }
    if (last.current === null) {
      const r = el.getBoundingClientRect();
      if (!inView && !(r.bottom > 0 && r.top < window.innerHeight)) return; // count up the first time it is seen
    }
    if (last.current === target) {
      if (!run.current) el.textContent = text; // same number, new wording
      return;
    }
    const from = last.current ?? 0;
    last.current = target;
    run.current?.stop();
    el.textContent = fmt(from);
    run.current = animate(from, target, {
      duration,
      ease: EASE,
      onUpdate: (v) => (el.textContent = fmt(v)),
      onComplete: () => {
        run.current = null;
        el.textContent = latest.current;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, inView, reduced]);

  return (
    <span ref={ref} className={className}>
      {text}
    </span>
  );
}

/** Horizontal bar that grows to its width on mount and glides when the value changes. */
export function GrowBar({ pct, className }: { pct: number; className?: string }) {
  const reduced = useReducedMotion(); // width is not a transform, so MotionConfig alone would still animate it
  return (
    <motion.div
      className={className}
      initial={reduced ? false : { width: 0 }}
      animate={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      transition={reduced ? { duration: 0 } : { duration: 0.8, ease: EASE }}
    />
  );
}
