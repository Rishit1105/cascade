import { useMemo, useState } from "react";
import { CircleCheck } from "lucide-react";
import type { ProposalDetail } from "../../lib/api";
import { FindingCard } from "../../components/common";
import { EmptyState, Segmented } from "../../components/ui";

const KIND_LABEL: Record<string, string> = {
  missing_info: "Missing information",
  conflict: "Conflict of interest",
  version: "Version integrity",
  simulation: "Simulation",
  execution: "Execution",
  injection: "Prompt injection",
  analysis: "Contradictions",
};

export function FindingsTab({ p }: { p: ProposalDetail }) {
  const [filter, setFilter] = useState<"open" | "all">("open");
  const shown = useMemo(() => p.findings.filter((f) => (filter === "open" ? f.status === "open" || f.status === "challenged" : true)), [p.findings, filter]);
  const groups = useMemo(() => {
    const g: Record<string, typeof shown> = {};
    shown.forEach((f) => (g[f.kind] ??= []).push(f));
    return g;
  }, [shown]);
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-xs text-muted">Severity and confidence are shown separately. Findings are never silently overwritten: challenges and status changes are appended to their history.</p>
        <Segmented value={filter} onChange={setFilter} size="sm" options={[{ id: "open", label: "Open" }, { id: "all", label: "All" }]} />
      </div>
      {shown.length === 0 && <EmptyState icon={<CircleCheck className="h-5 w-5" />} title="No open findings" />}
      <div className="space-y-5">
        {Object.entries(groups).map(([kind, items]) => (
          <section key={kind}>
            <p className="label mb-2">{KIND_LABEL[kind] ?? kind} · {items.length}</p>
            <div className="space-y-2">
              {items.map((f) => (
                <FindingCard key={f.id} f={f} proposalId={p.id} challenges={p.challenges} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
