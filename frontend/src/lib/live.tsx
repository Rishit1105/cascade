/* Live updates over Server-Sent Events: ledger events refresh the affected data, and
   sentinel / simulator activity is kept as a feed so reviewers can watch reviews happen. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type AuditEvent } from "./api";
import { useApp, type ToastTone } from "./app";

export type ActivityStatus = "info" | "success" | "warning" | "failure";
export interface LiveActivity {
  id: number;
  kind: "activity";
  at: string;
  proposal_id: string | null;
  stage: string;
  message: string;
  status: ActivityStatus;
  simulation_id?: string;
  tx_hash?: string;
  block_number?: number;
  verdict?: string;
}
export interface LiveLedger {
  id: number;
  kind: "ledger";
  at: string;
  proposal_id: string | null;
  event: AuditEvent;
}

export type LiveMessage = LiveActivity | LiveLedger;
type Listener = (msg: LiveMessage) => void;

interface LiveState {
  connected: boolean;
  activity: LiveActivity[];
  lastLedger: AuditEvent | null;
  /** Called for every message received live (not for history loaded on connect). */
  listen: (fn: Listener) => () => void;
}

const LiveContext = createContext<LiveState>({ connected: false, activity: [], lastLedger: null, listen: () => () => undefined });
const MAX_ACTIVITY = 200;

// Everything derived from the ledger or the chain. Only queries that are on screen refetch.
const LEDGER_KEYS = [
  "proposal", "proposals", "governance", "evaluation", "overview", "audit", "alerts", "notifications", "findings", "attempts",
  "checks", "simulations", "graph", "conflicts", "voting", "delegates", "manifest", "dependencies", "treasury", "anchors", "questions", "system",
];

// Sentinel outcomes worth interrupting for, wherever the reviewer is in the app.
const TOAST_STAGES: Record<string, ToastTone> = {
  approval_seen: "info",
  halted: "warning",
  halt_failed: "error",
  flagged: "warning",
  escalated: "warning",
  passed: "success",
};

export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { toast } = useApp();
  const [connected, setConnected] = useState(false);
  const [activity, setActivity] = useState<LiveActivity[]>([]);
  const [lastLedger, setLastLedger] = useState<AuditEvent | null>(null);
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const listeners = useRef(new Set<Listener>());
  const listen = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  useEffect(() => {
    let closed = false;
    let pending: number | undefined;
    let wasDown = false;
    const refresh = () => {
      window.clearTimeout(pending);
      // Coalesce bursts (a vote finalization appends several events in a row).
      pending = window.setTimeout(() => LEDGER_KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] })), 300);
    };
    const merge = (items: LiveActivity[]) =>
      setActivity((cur) => {
        const seen = new Set(cur.map((m) => m.id));
        const next = [...cur, ...items.filter((m) => !seen.has(m.id))].sort((a, b) => a.id - b.id);
        return next.slice(-MAX_ACTIVITY);
      });

    api
      .get<{ items: LiveActivity[] }>("/activity?kind=activity&limit=120")
      .then((r) => !closed && merge(r.items))
      .catch(() => undefined);

    const es = new EventSource("/api/stream");
    es.addEventListener("hello", () => {
      setConnected(true);
      if (wasDown) {
        // Events may have been missed while disconnected: refetch what is on screen.
        refresh();
        api.get<{ items: LiveActivity[] }>("/activity?kind=activity&limit=120").then((r) => merge(r.items)).catch(() => undefined);
      }
      wasDown = false;
    });
    es.addEventListener("ledger", (e) => {
      const msg = JSON.parse((e as MessageEvent).data) as LiveLedger;
      setLastLedger(msg.event);
      refresh();
      listeners.current.forEach((fn) => fn(msg));
    });
    es.addEventListener("activity", (e) => {
      const msg = JSON.parse((e as MessageEvent).data) as LiveActivity;
      merge([msg]);
      listeners.current.forEach((fn) => fn(msg));
      const tone = TOAST_STAGES[msg.stage];
      if (tone) toastRef.current(tone, `Sentinel · ${msg.proposal_id ?? "unknown proposal"}`, msg.message);
    });
    es.onerror = () => {
      setConnected(false);
      wasDown = true;
    };
    return () => {
      closed = true;
      window.clearTimeout(pending);
      es.close();
    };
  }, [qc]);

  const value = useMemo(() => ({ connected, activity, lastLedger, listen }), [connected, activity, lastLedger, listen]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export const useLive = () => useContext(LiveContext);

export interface ActivityRun {
  key: string;
  proposalId: string | null;
  simulationId?: string;
  source: "sentinel" | "simulation";
  verdict?: string;
  halted: boolean;
  haltTx?: string;
  items: LiveActivity[];
  startedAt: string;
  updatedAt: string;
}

const TERMINAL = new Set(["halted", "halt_failed", "passed", "flagged", "escalated"]);

/** Groups the flat feed into runs: one sentinel review or one simulation, newest first. */
export function groupRuns(items: LiveActivity[]): ActivityRun[] {
  const runs: ActivityRun[] = [];
  const open = new Map<string, ActivityRun>();
  for (const m of items) {
    const pid = m.proposal_id ?? "system";
    const prev = open.get(pid);
    const last = prev?.items[prev.items.length - 1];
    let joins = !!prev && !!last && Date.parse(m.at) - Date.parse(last.at) < 60_000 && m.stage !== "approval_seen" && !TERMINAL.has(last.stage);
    if (joins && m.simulation_id && prev!.simulationId && prev!.simulationId !== m.simulation_id) joins = false;
    if (joins && m.stage === "snapshot" && prev!.simulationId) joins = false;
    if (joins && last!.stage === "verdict" && prev!.source === "simulation") joins = TERMINAL.has(m.stage) || m.stage === "finding" || m.stage === "halt";
    const run: ActivityRun = joins
      ? prev!
      : { key: `run-${m.id}`, proposalId: m.proposal_id, source: m.stage === "approval_seen" ? "sentinel" : "simulation", halted: false, items: [], startedAt: m.at, updatedAt: m.at };
    if (!joins) {
      runs.push(run);
      open.set(pid, run);
    }
    if (m.simulation_id && !run.simulationId) run.simulationId = m.simulation_id;
    if (m.verdict) run.verdict = m.verdict;
    if (m.stage === "halted") {
      run.halted = true;
      run.haltTx = m.tx_hash;
    }
    if (TERMINAL.has(m.stage) || m.stage === "halt") run.source = "sentinel"; // only sentinel reviews emit outcome stages
    run.items.push(m);
    run.updatedAt = m.at;
  }
  return runs.reverse();
}

export function useActivityRuns(proposalId?: string, limit = 6): ActivityRun[] {
  const { activity } = useLive();
  return useMemo(() => {
    const items = proposalId ? activity.filter((m) => m.proposal_id === proposalId) : activity;
    return groupRuns(items).slice(0, limit);
  }, [activity, proposalId, limit]);
}
