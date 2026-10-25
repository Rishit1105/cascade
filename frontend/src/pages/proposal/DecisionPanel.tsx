import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Clock, FastForward, Gavel, Radar, ShieldCheck, ShieldX, Users, Vote } from "lucide-react";
import { api, type ProposalDetail } from "../../lib/api";
import { cx, formatUnits, govStateLabel, pct } from "../../lib/format";
import { useAction, useEvaluation, useGovernance } from "../../lib/queries";
import { VoteBar } from "../../components/common";
import { Badge, Button, Callout, Panel, Segmented, StatusBadge } from "../../components/ui";
import { CommitButton } from "./VersionsTab";
import { LiveIndicator, SentinelActivity } from "../../components/SentinelActivity";
import { useActivityRuns } from "../../lib/live";

export function DecisionPanel({ p }: { p: ProposalDetail }) {
  const gov = useGovernance(p.id, true);
  const evalChain = useEvaluation(p.id);
  const navigate = useNavigate();
  const g = gov.data ?? p.governance;
  const [voter, setVoter] = useState("");
  const [support, setSupport] = useState<"1" | "0" | "2">("1");
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState<"pass" | "fail">("pass");
  const propose = useAction(() => api.post(`/proposals/${p.id}/governance/propose`), { success: "On-chain vote opened on the Atlas Governor" });
  const vote = useAction(() => api.post(`/proposals/${p.id}/governance/vote`, { voter, support: Number(support), reason }), { success: "Vote cast on-chain", onSuccess: () => setReason("") });
  const simulate = useAction(() => api.post<any>(`/proposals/${p.id}/governance/simulate-votes?outcome=${outcome}`), { success: (r: any) => `${r.cast.length} demo delegates voted on-chain` });
  const advance = useAction((blocks: number) => api.post(`/proposals/${p.id}/governance/advance`, { blocks }), { success: "Demo chain advanced" });
  const finalize = useAction(() => api.post<any>(`/proposals/${p.id}/governance/finalize`), {
    success: (r: any) => (r.approved ? "Vote finalized: manifest approved on the guard. The sentinel is reviewing it now." : "Vote finalized: not approved"),
  });
  const runs = useActivityRuns(p.id, 1);
  const latest = p.versions[p.versions.length - 1];
  const voters = g.voters_available ?? [];
  const guard = g.guard;
  const windowLeft = guard.executable_at_block ? guard.executable_at_block - g.current_block - 1 : 0;

  return (
    <div className="flex flex-col gap-4 xl:sticky xl:top-[72px]">
      <Panel title="Decision" icon={<Gavel className="h-4 w-4 text-muted" />} actions={<span className="font-mono text-2xs text-muted">block #{g.current_block}</span>}>
        <div className="space-y-3">
          {!latest && (
            <>
              <p className="text-xs text-muted">Commit the reviewed draft to create v1. Voters will approve its exact manifest digest.</p>
              <CommitButton p={p} size="sm" />
            </>
          )}
          {latest && g.state === "not_submitted" && !["executed", "halted"].includes(p.status) && (
            <>
              <p className="text-xs text-muted">v{latest.version} is committed. Opening a vote creates a Governor proposal whose only action is <span className="font-mono">approveManifest(v{latest.version})</span>.</p>
              <Button size="sm" variant="primary" icon={<Vote className="h-3.5 w-3.5" />} loading={propose.isPending} onClick={() => propose.mutate(undefined)}>
                Open on-chain vote
              </Button>
            </>
          )}
          {g.state !== "not_submitted" && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted">Governor state · v{g.version}</span>
                <Badge tone={g.state === "Active" ? "warning" : g.state === "Succeeded" || g.state === "Executed" ? "success" : g.state === "Defeated" ? "danger" : "neutral"}>{govStateLabel(g.state)}</Badge>
              </div>
              <VoteBar votes={g.votes} />
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-subtle p-2"><p className="text-2xs text-muted">Quorum</p><p className={cx("text-xs font-semibold", g.quorum_reached ? "text-primary" : "text-warning")}>{g.quorum_reached ? "Reached" : "Not yet"}</p></div>
                <div className="rounded-lg bg-subtle p-2"><p className="text-2xs text-muted">Turnout</p><p className="text-xs font-semibold">{g.participation_pct}%</p></div>
                <div className="rounded-lg bg-subtle p-2"><p className="text-2xs text-muted">Blocks left</p><p className="text-xs font-semibold">{g.blocks_remaining}</p></div>
              </div>
            </>
          )}
          {(g.state === "Active" || g.state === "Pending") && (
            <div className="space-y-2 rounded-lg border border-line p-2.5">
              <p className="flex items-center gap-1.5 text-xs font-semibold"><Users className="h-3.5 w-3.5" /> Cast a vote as a demo account</p>
              <select className="input" value={voter} onChange={(e) => setVoter(e.target.value)} aria-label="Voter">
                <option value="">Choose a voter…</option>
                {voters.map((v) => (
                  <option key={v.address} value={v.address}>
                    {v.label} · {formatUnits(v.voting_power, 18, 0)} ATLAS
                  </option>
                ))}
              </select>
              <Segmented value={support} onChange={setSupport} size="sm" options={[{ id: "1", label: "For" }, { id: "0", label: "Against" }, { id: "2", label: "Abstain" }]} />
              <input className="input" placeholder="Reason (optional, stored on-chain)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button size="sm" variant="primary" className="w-full" disabled={!voter || g.state === "Pending"} loading={vote.isPending} onClick={() => vote.mutate(undefined)}>
                Cast vote
              </Button>
              <div className="flex items-center gap-1.5 border-t border-line pt-2">
                <Segmented value={outcome} onChange={setOutcome} size="sm" options={[{ id: "pass", label: "Pass" }, { id: "fail", label: "Fail" }]} />
                <Button size="sm" className="flex-1" loading={simulate.isPending} onClick={() => simulate.mutate(undefined)}>
                  Simulate delegates
                </Button>
              </div>
              {g.state === "Pending" && <p className="text-2xs text-muted">Voting opens after the snapshot block. Advance one block.</p>}
            </div>
          )}
          {(g.state === "Active" || g.state === "Pending" || (guard.status === "approved" && windowLeft > 0)) && (
            <Button size="sm" className="w-full" icon={<FastForward className="h-3.5 w-3.5" />} loading={advance.isPending}
              onClick={() => advance.mutate(g.state === "Pending" ? 2 : g.state === "Active" ? (g.blocks_remaining ?? 0) + 1 : windowLeft + 1)}>
              {g.state === "Pending" ? "Advance 2 blocks (open voting)" : g.state === "Active" ? `Advance ${(g.blocks_remaining ?? 0) + 1} blocks (end vote)` : `Advance ${windowLeft + 1} blocks (end review window)`}
            </Button>
          )}
          {g.state === "Succeeded" && (
            <>
              <Callout tone="info" title="Vote passed">Finalizing executes the Governor proposal, which records the manifest approval on the ExecutionGuard. The sentinel then simulates it during the review window.</Callout>
              <Button size="sm" variant="primary" className="w-full" data-tour="finalize" loading={finalize.isPending} onClick={() => finalize.mutate(undefined)}>
                Finalize vote → approve manifest
              </Button>
            </>
          )}
          {g.state === "Defeated" && <Callout tone="warning" title="Defeated">The vote failed. No manifest was approved; the guard will reject any execution.</Callout>}
        </div>
      </Panel>

      <Panel title="Execution guard" icon={<ShieldCheck className="h-4 w-4 text-muted" />} actions={<StatusBadge status={guard.status === "none" ? "none" : guard.status} />}>
        <div className="space-y-2 text-xs">
          {guard.status === "none" && <p className="text-muted">No approval on the ExecutionGuard. Any execution attempt reverts with NotApproved.</p>}
          {guard.status !== "none" && (
            <>
              <div className="flex justify-between"><span className="text-muted">Approved version</span><span className="font-semibold">v{guard.version}</span></div>
              <div className="flex justify-between"><span className="text-muted">Manifest</span><span className="font-mono">{guard.manifest_hash?.slice(0, 12)}…</span></div>
              {guard.status === "approved" && (
                <div className="flex justify-between">
                  <span className="text-muted">Review window</span>
                  <span className={cx("flex items-center gap-1 font-semibold", windowLeft > 0 ? "text-warning" : "text-primary")}>
                    <Clock className="h-3 w-3" />
                    {windowLeft > 0 ? `${windowLeft + 1} block(s) left` : `executable since #${guard.executable_at_block}`}
                  </span>
                </div>
              )}
              {guard.status === "halted" && (
                <p className="flex items-start gap-1.5 rounded-md bg-danger/5 p-2 text-danger"><ShieldX className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Halted by a guardian. Only a newer version approved by a new vote can execute.</p>
              )}
            </>
          )}
          <Button size="sm" variant={guard.status === "approved" ? "primary" : "secondary"} className="mt-1 w-full" onClick={() => navigate(`/guardian?p=${p.id}`)}>
            Open execution guardian
          </Button>
        </div>
      </Panel>

      {(runs.length > 0 || guard.status === "approved") && (
        <Panel title="Sentinel review" icon={<Radar className="h-4 w-4 text-primary" />} actions={<LiveIndicator />} subtitle="Every step of the review of this proposal, as it runs.">
          <SentinelActivity proposalId={p.id} limit={2} empty="Waiting for the sentinel to see the approval on-chain…" />
        </Panel>
      )}

      {evalChain.data && (
        <Panel title="Evaluation chain" icon={<Radar className="h-4 w-4 text-muted" />} subtitle={evalChain.data.label}>
          <ul className="space-y-2">
            {evalChain.data.stages.map((s) => (
              <li key={s.key}>
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium">{s.name}</span>
                  <span className={cx("font-semibold", s.band === "high" ? "text-danger" : s.band === "elevated" ? "text-warning" : "text-primary")}>{pct(s.posterior, 1)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-subtle">
                  <div className={cx("h-full rounded-full", s.band === "high" ? "bg-danger" : s.band === "elevated" ? "bg-warning" : "bg-primary")} style={{ width: `${Math.max(2, s.posterior * 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
