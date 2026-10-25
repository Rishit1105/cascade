/* Guided demo tour. Each step opens a page, points at a real control and, where it makes sense,
   waits for the reviewer to do the thing (detected from live ledger / sentinel events) instead of
   doing it for them. Progress survives reloads; the tour never blocks the page underneath. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useLive, type LiveMessage } from "./live";

export interface TourStep {
  id: string;
  route: string;
  target?: string;
  title: string;
  body: string;
  hint?: string;
  waitFor?: { ledger?: string[]; activity?: string[]; proposal?: string };
  doneText?: string;
}

export const TOUR: TourStep[] = [
  {
    id: "welcome",
    route: "/",
    title: "Welcome to DAOGuard",
    body: "This tour follows Atlas DAO through three risks: a grant with an undisclosed link, a draft with missing information, and an upgrade that hides a way to drain funds. It all runs on a local chain with demo data. Nothing real moves, and you can click anything while the tour is open.",
  },
  {
    id: "chain",
    route: "/",
    target: "eval-chain",
    title: "One question per stage",
    body: "The evaluation chain asks four questions in order. Each stage starts from a prior and is updated by the likelihood ratio of every piece of evidence found. All the factors are listed and the ratios are editable in Settings. The result is an estimate to direct attention, not a verdict.",
  },
  {
    id: "brief",
    route: "/proposals/GOV-042?tab=brief",
    target: "brief-missing",
    title: "Claims you can check",
    body: "Every claim in the brief links to the sentence it came from. The missing-information rules turn gaps into questions. Here the forum post asks for 520,000 while the payload pays 500,000.",
  },
  {
    id: "graph",
    route: "/relationships?p=GOV-042",
    target: "graph",
    title: "Relationships from on-chain events",
    body: "Before the proposal, the proposer sent funds to the grant recipient's wallet and did not disclose it. A transfer proves value moved, not common ownership, so it is shown as a lead to explain, with its transaction as evidence.",
  },
  {
    id: "qa",
    route: "/proposals/GOV-044?tab=qa",
    target: "qa-awaiting",
    title: "Close the loop with the proposer",
    body: "A reviewer asked for a budget breakdown. The proposer answered with a signed statement and attached the itemised budget. Review the answer and accept it.",
    hint: "Click “Review answer”, then “Accept answer”.",
    waitFor: { ledger: ["answer_accepted"], proposal: "GOV-044" },
    doneText: "Accepted. The finding is resolved and GOV-044's Proposal Claims estimate went down; the Evaluation chain panel on the right shows the change.",
  },
  {
    id: "tamper",
    route: "/guardian?p=GOV-042&scenario=tampered_recipient&view=diff",
    target: "execute",
    title: "Try to execute a tampered payload",
    body: "GOV-042 was approved. This payload quietly swaps the recipient for another wallet, and the diff shows exactly where. Now send it to the real ExecutionGuard contract.",
    hint: "Click “Execute guarded demo” and confirm.",
    waitFor: { ledger: ["execution_rejected"], proposal: "GOV-042" },
    doneText: "The contract reverted with ManifestMismatch. It was a real transaction on the local chain, and no funds moved.",
  },
  {
    id: "builder",
    route: "/guardian?p=GOV-042&scenario=safe&view=builder",
    target: "builder",
    title: "Build a payload yourself",
    body: "Change the amount or the recipient and watch the EIP-712 digest and the guard's own preflight answer update as you type. The breakdown table shows which part of the hash stopped matching.",
  },
  {
    id: "sentinel",
    route: "/proposals/GOV-043?tab=brief",
    target: "finalize",
    title: "Let the sentinel catch the upgrade",
    body: "GOV-043's vote passed, but the new contract code hard-codes an address that can drain the fee vault, while the text says it “moves no funds”. Finalize the vote: the manifest is approved on-chain and the sentinel simulates it straight away.",
    hint: "Click “Finalize vote”, then watch the Sentinel review panel. If it is already finalized, that panel shows what happened.",
    waitFor: { activity: ["halted", "halt_failed", "passed", "flagged", "escalated"], proposal: "GOV-043" },
    doneText: "The sentinel halted the approval on-chain inside the review window. Executing it now fails with ProposalIsHalted.",
  },
  {
    id: "ledger",
    route: "/audit",
    target: "verify-ledger",
    title: "Verify the record",
    body: "Everything you just did was appended to a hash-chained audit ledger, and its head is anchored on-chain. Verifying re-hashes every event in order and re-checks every transaction receipt against the node.",
    hint: "Click “Verify on-chain”.",
    waitFor: { ledger: ["ledger_verified"] },
    doneText: "Verified. Any edited, deleted or reordered event would show up as a broken link.",
  },
  {
    id: "end",
    route: "/settings",
    target: "reset-demo",
    title: "That's the tour",
    body: "Reset the demo here to rebuild the chain and start again. Replay the tour any time from the compass button in the top bar.",
  },
];

const KEY = "daoguard.tour";
const SEEN = "daoguard.tour.seen";
const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage unavailable: the tour just won't resume after a reload */
  }
};

interface TourState {
  active: boolean;
  index: number;
  step: TourStep;
  total: number;
  done: boolean;
  seen: boolean;
  start: (at?: number) => void;
  stop: () => void;
  next: () => void;
  back: () => void;
  goToStep: () => void;
  dismissIntro: () => void;
}

const TourContext = createContext<TourState | null>(null);

function matches(step: TourStep, msg: LiveMessage): boolean {
  const w = step.waitFor;
  if (!w) return false;
  const pid = msg.kind === "ledger" ? msg.event.proposal_id : msg.proposal_id;
  if (w.proposal && pid !== w.proposal) return false;
  if (msg.kind === "ledger") return !!w.ledger?.includes(msg.event.event_type);
  return !!w.activity?.includes(msg.stage);
}

export function TourProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { listen } = useLive();
  const saved = useMemo(() => {
    try {
      return JSON.parse(read(KEY) ?? "null") as { active: boolean; index: number } | null;
    } catch {
      return null;
    }
  }, []);
  const [active, setActive] = useState(!!saved?.active);
  const [index, setIndex] = useState(Math.min(saved?.index ?? 0, TOUR.length - 1));
  const [done, setDone] = useState(false);
  const [seen, setSeen] = useState(() => read(SEEN) === "1" || !!saved);
  const step = TOUR[index];

  useEffect(() => {
    write(KEY, active ? JSON.stringify({ active, index }) : null);
  }, [active, index]);

  const goTo = useCallback((i: number) => {
    setIndex(i);
    setDone(false);
    navigate(TOUR[i].route);
  }, [navigate]);

  useEffect(() => {
    if (!active || !step.waitFor) return;
    return listen((msg) => {
      if (matches(step, msg)) setDone(true);
    });
  }, [active, step, listen]);

  const value = useMemo<TourState>(
    () => ({
      active,
      index,
      step,
      total: TOUR.length,
      done,
      seen,
      start: (at = 0) => {
        setActive(true);
        setSeen(true);
        write(SEEN, "1");
        goTo(at);
      },
      stop: () => setActive(false),
      next: () => (index < TOUR.length - 1 ? goTo(index + 1) : setActive(false)),
      back: () => index > 0 && goTo(index - 1),
      goToStep: () => navigate(step.route),
      dismissIntro: () => {
        setSeen(true);
        write(SEEN, "1");
      },
    }),
    [active, index, step, done, seen, goTo, navigate],
  );
  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}

export function useTour(): TourState {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error("useTour outside TourProvider");
  return ctx;
}
