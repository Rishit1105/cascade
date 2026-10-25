/* Live ledger strip: the newest audit events slide in as the ledger grows (data from the existing
   audit query, refreshed by the live event stream). */
import { AnimatePresence, motion } from "motion/react";
import { Link } from "react-router-dom";
import { Link2, ScrollText } from "lucide-react";
import { cx, timeAgo } from "../lib/format";
import { SPRING } from "../lib/motion";
import { useAuditEvents } from "../lib/queries";
import { LiveIndicator } from "./SentinelActivity";

const DOT: Record<string, string> = { success: "bg-primary", failure: "bg-danger", warning: "bg-warning", info: "bg-info" };

export function LedgerTicker({ limit = 4 }: { limit?: number }) {
  const q = useAuditEvents({ limit });
  const items = (q.data?.items ?? []).slice(0, limit);
  return (
    <div className="panel mb-4 flex min-w-0 items-stretch overflow-hidden">
      <Link to="/audit" className="flex shrink-0 items-center gap-2 border-r border-line bg-subtle/60 px-3.5 text-xs font-semibold text-fg hover:bg-subtle">
        <ScrollText className="h-4 w-4 text-primary" />
        <span className="hidden sm:inline">Live ledger</span>
        <LiveIndicator />
      </Link>
      <ol className="flex min-w-0 flex-1 items-stretch divide-x divide-line" aria-label="Newest audit events">
        <AnimatePresence initial={false} mode="popLayout">
          {items.map((e, i) => (
            <motion.li
              key={e.id}
              layout
              initial={{ opacity: 0, x: -24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={SPRING}
              className={cx("min-w-0 flex-1 px-3.5 py-2", i === 2 && "hidden lg:block", i >= 3 && "hidden xl:block")}
            >
              <Link to={`/audit?event=${e.id}`} className="block min-w-0 hover:text-primary">
                <span className="flex items-center gap-1.5 text-2xs text-muted">
                  <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", DOT[e.status])} />
                  {e.proposal_id ?? "system"} · {timeAgo(e.occurred_at)}
                  {e.verification === "chain-confirmed" && <Link2 className="h-3 w-3 text-primary" aria-label="chain-confirmed" />}
                </span>
                <span className="mt-0.5 block truncate text-xs font-medium text-fg" title={e.summary}>{e.summary}</span>
              </Link>
            </motion.li>
          ))}
        </AnimatePresence>
        {items.length === 0 && <li className="flex-1 px-3.5 py-2.5 text-xs text-muted">{q.isLoading ? "Loading the ledger…" : "No events yet."}</li>}
      </ol>
    </div>
  );
}
