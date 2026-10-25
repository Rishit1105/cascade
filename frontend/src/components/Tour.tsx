/* Tour overlay: a highlight ring around the step's target and a card beside it. Neither blocks
   clicks on the page, so the reviewer performs each step for real. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { CheckCircle2, Compass, Loader2, MousePointerClick, X } from "lucide-react";
import { cx } from "../lib/format";
import { useTour } from "../lib/tour";
import { Button } from "./ui";

type Box = { top: number; left: number; width: number; height: number };
const PAD = 6;
const CARD_W = 360;

function useTargetBox(target: string | undefined, key: string): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useEffect(() => {
    if (!target) {
      setBox(null);
      return;
    }
    let attempts = 0;
    let lastScroll = 0;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const tick = () => {
      const el = document.querySelector(`[data-tour="${target}"]`);
      if (!el) {
        setBox(null);
        return;
      }
      const r = el.getBoundingClientRect();
      const inView = r.top >= 56 && r.top < window.innerHeight - 40;
      // Bring the target into view; content above it may still be loading, so re-check a few times.
      // Smooth scrolling can stall when the window is not painting, hence the instant retries.
      if (!inView && attempts < 4 && Date.now() - lastScroll > 700) {
        el.scrollIntoView({ block: r.height > window.innerHeight * 0.6 ? "start" : "center", behavior: attempts === 0 && !reduced ? "smooth" : "auto" });
        attempts += 1;
        lastScroll = Date.now();
      }
      if (r.width === 0 && r.height === 0) return setBox(null);
      setBox((b) => (b && b.top === r.top && b.left === r.left && b.width === r.width && b.height === r.height ? b : { top: r.top, left: r.left, width: r.width, height: r.height }));
    };
    tick();
    const t = window.setInterval(tick, 250);
    window.addEventListener("resize", tick);
    window.addEventListener("scroll", tick, true);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("resize", tick);
      window.removeEventListener("scroll", tick, true);
    };
  }, [target, key]);
  return box;
}

function IntroPrompt() {
  const { start, dismissIntro } = useTour();
  return (
    <div className="panel fixed bottom-4 left-4 z-[45] w-[340px] max-w-[calc(100vw-2rem)] p-4 shadow-pop animate-fade-in md:left-[80px]" role="dialog" aria-label="Guided tour">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Compass className="h-4 w-4" />
        </span>
        <div>
          <p className="text-sm font-semibold">New here? Take the guided tour</p>
          <p className="mt-0.5 text-xs text-muted">About 3 minutes. You do each step yourself: catch a tampered payload, accept a proposer's answer and watch the sentinel halt an upgrade.</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="primary" onClick={() => start(0)}>Start tour</Button>
            <Button size="sm" variant="ghost" onClick={dismissIntro}>Not now</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TourOverlay() {
  const tour = useTour();
  const loc = useLocation();
  const { step, index, total, done } = tour;
  const box = useTargetBox(tour.active ? step.target : undefined, `${step.id}:${loc.pathname}${loc.search}`);
  const card = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(220);
  const [vw, setVw] = useState(window.innerWidth);
  const [vh, setVh] = useState(window.innerHeight);

  useEffect(() => {
    const onResize = () => {
      setVw(window.innerWidth);
      setVh(window.innerHeight);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useLayoutEffect(() => {
    if (card.current) setCardH(card.current.offsetHeight);
  });
  useEffect(() => {
    if (!tour.active) return;
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return; // a modal owns the keyboard
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Escape") tour.stop();
      if (e.key === "ArrowRight") tour.next();
      if (e.key === "ArrowLeft") tour.back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tour]);

  if (!tour.active) return tour.seen ? null : <IntroPrompt />;

  const stepPath = step.route.split("?")[0];
  const offPage = loc.pathname !== stepPath;
  const mobile = vw < 640;
  const w = Math.min(CARD_W, vw - 32);
  let style: React.CSSProperties;
  if (mobile || !box || box.height > vh * 0.62) {
    style = mobile ? { left: 16, right: 16, bottom: 16 } : box ? { right: 24, bottom: 24, width: w } : { left: (vw - w) / 2, top: Math.max(80, vh / 2 - cardH / 2), width: w };
  } else {
    const below = box.top + box.height + PAD + 12;
    const above = box.top - PAD - 12 - cardH;
    const top = below + cardH < vh - 12 ? below : above > 64 ? above : Math.max(64, vh - cardH - 16);
    const left = Math.min(Math.max(16, box.left), vw - w - 16);
    style = { top, left, width: w };
  }

  return (
    <>
      {box && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[25] rounded-xl border-2 border-primary transition-all duration-200"
          style={{ top: box.top - PAD, left: box.left - PAD, width: box.width + PAD * 2, height: box.height + PAD * 2, boxShadow: "0 0 0 4px rgb(var(--primary) / 0.18), 0 0 24px rgb(var(--primary) / 0.25)" }}
        />
      )}
      <div ref={card} role="dialog" aria-label={`Guided tour step ${index + 1} of ${total}`} className="panel fixed z-[45] p-4 shadow-pop animate-fade-in" style={style}>
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-primary">
            <Compass className="h-3.5 w-3.5" /> Guided tour · {index + 1} of {total}
          </span>
          <button className="rounded p-1 text-muted hover:bg-subtle hover:text-fg" onClick={tour.stop} aria-label="End tour" title="End tour (Esc)">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-2 text-[15px] font-semibold text-fg">{step.title}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">{step.body}</p>
        {offPage && (
          <button className="mt-2 text-xs font-semibold text-primary hover:underline" onClick={tour.goToStep}>
            Back to this step's page →
          </button>
        )}
        {step.hint && !done && (
          <p className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-subtle px-2.5 py-2 text-xs text-fg">
            <MousePointerClick className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" /> {step.hint}
          </p>
        )}
        {step.waitFor && !done && (
          <p className="mt-2 flex items-center gap-1.5 text-2xs text-muted">
            <Loader2 className="h-3 w-3 animate-spin" /> Waiting for you to do it. You can also skip ahead.
          </p>
        )}
        {done && step.doneText && (
          <p className="mt-2.5 flex items-start gap-1.5 rounded-lg border border-primary/25 bg-primary/[0.06] px-2.5 py-2 text-xs text-fg">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" /> {step.doneText}
          </p>
        )}
        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="flex gap-1" aria-hidden>
            {Array.from({ length: total }, (_, i) => (
              <span key={i} className={cx("h-1.5 rounded-full transition-all", i === index ? "w-4 bg-primary" : i < index ? "w-1.5 bg-primary/40" : "w-1.5 bg-line")} />
            ))}
          </div>
          <div className="flex gap-1.5">
            {index > 0 && (
              <Button size="sm" variant="ghost" onClick={tour.back}>
                Back
              </Button>
            )}
            <Button size="sm" variant={!step.waitFor || done ? "primary" : "secondary"} onClick={tour.next}>
              {index === total - 1 ? "Finish" : step.waitFor && !done ? "Skip" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
