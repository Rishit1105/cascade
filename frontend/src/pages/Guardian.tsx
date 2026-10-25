import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Ban, Binary, CheckCircle2, CircleDashed, Cpu, FileCode2, FlaskConical, Play, ShieldAlert, ShieldCheck, ShieldX, Siren, Stamp, XCircle,
} from "lucide-react";
import { api, type ExecutionAttempt, type ExecutionCheck, type Simulation } from "../lib/api";
import { useSelectedProposal } from "../lib/app";
import { lineDiff } from "../lib/diff";
import { cx, dateTime, shortAddr, titleCase } from "../lib/format";
import { useAction, useAttempts, useGovernance, useManifest, useProposal, useScenarios, useSimulation, useSimulations } from "../lib/queries";
import { ProposalPicker } from "../components/common";
import { DiffViewer } from "../components/DiffViewer";
import { ConfirmDialog } from "../components/overlays";
import { Badge, Button, Callout, EmptyState, ErrorState, Hash, LoadingBlock, Panel, SeverityBadge, StatusBadge, Tabs, TxLink } from "../components/ui";

type CenterTab = "diff" | "bytecode" | "payload";

function Highlighted({ text, assertions, statuses }: { text: string; assertions: any[]; statuses: Record<string, string> }) {
  const spans = [...assertions].filter((a) => a.source?.char_start !== undefined).sort((a, b) => a.source.char_start - b.source.char_start);
  const parts: ReactNode[] = [];
  let pos = 0;
  spans.forEach((a, i) => {
    const s = a.source.char_start;
    const e = a.source.char_end;
    if (s < pos) return;
    parts.push(<span key={`t${i}`}>{text.slice(pos, s)}</span>);
    const status = statuses[a.kind + "|" + a.quote];
    parts.push(
      <mark key={`m${i}`} className={status === "violated" ? "mark-violated" : status === "consistent" ? "mark-consistent" : "mark-intent"} title={`${a.claim}${status ? ` · ${status}` : ""}`}>
        {text.slice(s, e)}
      </mark>,
    );
    pos = e;
  });
  parts.push(<span key="end">{text.slice(pos)}</span>);
  return <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-fg">{parts}</div>;
}

function AssertionIcon({ status }: { status: string }) {
  if (status === "violated") return <XCircle className="h-4 w-4 shrink-0 text-danger" />;
  if (status === "consistent") return <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />;
  return <CircleDashed className="h-4 w-4 shrink-0 text-faint" />;
}

export default function Guardian() {
  const [pid, setPid] = useSelectedProposal("GOV-042");
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const proposal = useProposal(pid);
  const manifest = useManifest(pid);
  const scenarios = useScenarios(pid);
  const gov = useGovernance(pid, true);
  const attempts = useAttempts(pid);
  const sims = useSimulations(pid);
  const intent = useQuery({ queryKey: ["intent", pid], queryFn: () => api.get<any>(`/proposals/${pid}/intent`), enabled: !!pid });
  const [scenario, setScenarioState] = useState(params.get("scenario") ?? "safe");
  const [tab, setTab] = useState<CenterTab>("diff");
  const [check, setCheck] = useState<ExecutionCheck | null>(null);
  const [simResult, setSimResult] = useState<Simulation | null>(null);
  const [attempt, setAttempt] = useState<ExecutionAttempt | null>(null);
  const [customText, setCustomText] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const [confirmExec, setConfirmExec] = useState(false);
  const [confirmHalt, setConfirmHalt] = useState(false);
  const [confirmDispute, setConfirmDispute] = useState(false);

  const setScenario = (s: string) => {
    setScenarioState(s);
    const next = new URLSearchParams(params);
    next.set("scenario", s);
    setParams(next, { replace: true });
  };
  useEffect(() => {
    setCheck(null);
    setSimResult(null);
    setAttempt(null);
  }, [pid, scenario]);
  useEffect(() => {
    if (scenarios.data && scenario !== "custom" && !scenarios.data.find((s) => s.id === scenario)) setScenarioState("safe");
  }, [scenarios.data, scenario]);

  const payloadQ = useQuery({
    queryKey: ["scenario-payload", pid, scenario],
    queryFn: () => api.get<{ payload: any }>(`/proposals/${pid}/scenarios/${scenario}/payload`).then((r) => r.payload),
    enabled: !!pid && scenario !== "custom" && !!manifest.data?.manifest,
  });
  useEffect(() => {
    if (payloadQ.data && scenario !== "custom") setCustomText(JSON.stringify(payloadQ.data, null, 2));
  }, [payloadQ.data, scenario]);

  const submitted = useMemo(() => {
    if (scenario !== "custom") return payloadQ.data;
    try {
      return JSON.parse(customText);
    } catch {
      return undefined;
    }
  }, [scenario, payloadQ.data, customText]);
  const approvedPayload = manifest.data?.payload;
  const rows = useMemo(
    () => (approvedPayload && submitted ? lineDiff(JSON.stringify(approvedPayload, null, 2).split("\n"), JSON.stringify(submitted, null, 2).split("\n")) : []),
    [approvedPayload, submitted],
  );

  const latestSimId = sims.data?.find((s) => (scenario === "safe" ? s.scenario?.includes("manifest") : s.scenario === scenario))?.id;
  const latestSim = useSimulation(simResult ? undefined : latestSimId);
  const sim = simResult ?? latestSim.data ?? null;
  const report = sim?.report;
  const upgrade = report?.upgrades?.[0];
  const isUpgrade = manifest.data?.manifest?.actions?.some((a: any) => a.kind === "proxy_upgrade");
  const statuses: Record<string, string> = {};
  (report?.intent?.assertions ?? []).forEach((a: any) => (statuses[a.kind + "|" + a.quote] = a.status));

  const body = (): Record<string, unknown> => (scenario === "custom" ? { payload: submitted, scenario: "custom" } : { scenario });
  const runCheck = useAction(() => api.post<ExecutionCheck>(`/proposals/${pid}/execution-checks`, body()), {
    success: (c) => `Advisory check: ${c.status}`,
    onSuccess: setCheck,
    invalidate: [["audit"], ["checks"], ["evaluation"]],
  });
  const simulate = useAction(() => api.post<Simulation>(`/proposals/${pid}/simulations`, scenario === "safe" ? {} : body()), {
    success: (s) => `Simulation verdict: ${s.verdict.toUpperCase()}`,
    tone: (s) => (s.verdict === "pass" ? "success" : "warning"),
    onSuccess: setSimResult,
  });
  const execute = useAction(() => api.post<{ attempt: ExecutionAttempt; check: ExecutionCheck }>(`/proposals/${pid}/demo-execution`, body()), {
    success: (r) => (r.attempt.outcome === "executed" ? "Executed through the guard" : r.attempt.outcome === "rejected" ? `Rejected by the contract: ${r.attempt.revert?.name}` : "Not sent"),
    tone: (r) => (r.attempt.outcome === "executed" ? "success" : "warning"),
    onSuccess: (r) => {
      setAttempt(r.attempt);
      setCheck(r.check);
      setConfirmExec(false);
    },
  });
  const halt = useAction((v: { reason: string; confirm: string }) => api.post(`/proposals/${pid}/halt`, v), { success: "Guardian halt recorded on-chain", onSuccess: () => setConfirmHalt(false) });
  const dispute = useAction((statement: string) => api.post(`/proposals/${pid}/disputes`, { version: proposal.data?.current_version, statement }), {
    success: "Dispute hash recorded on-chain in ProposalRegistry",
    onSuccess: () => setConfirmDispute(false),
  });

  const guard = gov.data?.guard;
  const p = proposal.data;
  const scenarioInfo = scenarios.data?.find((s) => s.id === scenario);

  if (!pid) return <EmptyState title="Choose a proposal" />;
  return (
    <div className="pb-20">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Execution discrepancy & code simulator</h1>
          <p className="mt-0.5 text-sm text-muted">Compare what voters approved with what is submitted. The ExecutionGuard contract, not this page, decides.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ProposalPicker value={pid} onChange={setPid} />
          {guard && (
            <Badge tone={guard.status === "approved" ? "success" : guard.status === "halted" ? "danger" : guard.status === "executed" ? "dark" : "neutral"} className="h-7 px-2 text-xs">
              Guard: {guard.status}
              {guard.status === "approved" && guard.executable_at_block && gov.data && guard.executable_at_block > gov.data.current_block ? ` · window until #${guard.executable_at_block}` : ""}
            </Badge>
          )}
        </div>
      </div>

      {manifest.data && !manifest.data.manifest && <Callout tone="warning" title="No committed manifest">Commit a version of this proposal before checking execution payloads.</Callout>}

      {scenarios.data && scenarios.data.length > 0 && (
        <div className="panel mb-4 flex flex-wrap items-center gap-1.5 p-2">
          <span className="px-2 text-2xs font-semibold uppercase tracking-[0.06em] text-muted">Scenario</span>
          {scenarios.data.map((s) => (
            <button
              key={s.id}
              onClick={() => setScenario(s.id)}
              title={s.description}
              className={cx("rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors", scenario === s.id ? "border-fg bg-fg text-surface" : "border-line hover:border-line-strong")}
            >
              <span className="font-semibold">{s.label}</span>
              <span className={cx("ml-1.5 text-2xs", scenario === s.id ? "text-surface/70" : "text-muted")}>expect {s.expect}</span>
            </button>
          ))}
          <button onClick={() => { setScenario("custom"); setTab("payload"); }} className={cx("rounded-lg border px-2.5 py-1.5 text-xs font-semibold", scenario === "custom" ? "border-fg bg-fg text-surface" : "border-dashed border-line-strong text-muted hover:text-fg")}>
            Custom payload
          </button>
          {scenarioInfo && <span className="ml-auto px-2 text-xs text-muted">{scenarioInfo.description} Basis: {scenarioInfo.basis} manifest v{scenarioInfo.version}.</span>}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[330px_minmax(0,1fr)_380px]">
        <Panel title="Natural-language proposal" icon={<FileCode2 className="h-4 w-4 text-muted" />} subtitle="Clauses DAOGuard parsed into testable assertions are highlighted.">
          {intent.isLoading && <LoadingBlock rows={8} />}
          {intent.data && (
            <>
              <div className="max-h-[360px] overflow-y-auto rounded-lg border border-line bg-subtle/40 p-3 scroll-thin">
                <Highlighted text={intent.data.text} assertions={intent.data.assertions} statuses={statuses} />
              </div>
              <p className="mt-2 text-2xs text-muted">
                {intent.data.assertions.length} assertion(s) · {intent.data.method}
              </p>
            </>
          )}
          <p className="label mb-2 mt-4">Interpreted functions (approved manifest)</p>
          <div className="space-y-2">
            {(manifest.data?.manifest?.actions ?? []).map((a: any) => (
              <div key={a.index} className="rounded-lg border border-line p-2.5">
                <p className="text-xs leading-relaxed">{a.human_readable}</p>
                <p className="mt-1 font-mono text-2xs text-muted">
                  {a.function ?? a.data.slice(0, 10)} → {a.target_label ?? shortAddr(a.target)}
                </p>
                {a.privileged && <Badge tone="warning" className="mt-1">Privileged: {a.privileged}</Badge>}
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="Manifest & bytecode verification"
          icon={<Binary className="h-4 w-4 text-muted" />}
          bodyClassName="pt-0"
          actions={<span className="font-mono text-2xs text-muted">{manifest.data?.basis ?? "—"} v{manifest.data?.version ?? "—"}</span>}
        >
          <Tabs<CenterTab>
            className="mb-3"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "diff", label: "Payload diff" },
              ...(isUpgrade ? [{ id: "bytecode" as CenterTab, label: "Bytecode simulation" }] : []),
              { id: "payload", label: "Payload JSON" },
            ]}
          />
          {tab === "diff" && (
            <>
              {(manifest.isLoading || payloadQ.isLoading) && <LoadingBlock rows={10} />}
              {payloadQ.error && <ErrorState error={payloadQ.error} />}
              {approvedPayload && submitted && (
                <DiffViewer
                  rows={rows}
                  leftTitle={`Human-readable expectation · ${manifest.data?.basis} v${manifest.data?.version}`}
                  rightTitle={rows.some((r) => r.tag !== "equal") ? "Submitted payload: differs" : "Submitted payload: identical"}
                />
              )}
              {check && check.discrepancies.length > 0 && (
                <div className="mt-3 overflow-x-auto rounded-lg border border-line">
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>Rule</th>
                        <th>Field</th>
                        <th>Approved</th>
                        <th>Submitted</th>
                      </tr>
                    </thead>
                    <tbody>
                      {check.discrepancies.map((d, i) => (
                        <tr key={i}>
                          <td className="whitespace-nowrap">
                            <SeverityBadge severity={d.severity} />
                            <p className="mt-1 font-mono text-2xs text-muted">{d.rule_id}</p>
                          </td>
                          <td className="font-mono text-2xs">{d.field_path}</td>
                          <td className="max-w-[180px] break-all font-mono text-2xs text-primary">{d.approved_display ?? (typeof d.approved_value === "object" ? JSON.stringify(d.approved_value) : String(d.approved_value ?? "—"))}</td>
                          <td className="max-w-[180px] break-all font-mono text-2xs text-danger">{d.submitted_display ?? (typeof d.submitted_value === "object" ? JSON.stringify(d.submitted_value) : String(d.submitted_value ?? "—"))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          {tab === "bytecode" && (
            <>
              {!upgrade && (
                <EmptyState icon={<Cpu className="h-5 w-5" />} title="No simulation yet" body="Run “Simulate contract run” to disassemble the submitted implementation and probe it." action={<Button variant="primary" loading={simulate.isPending} onClick={() => simulate.mutate(undefined)}>Simulate contract run</Button>} />
              )}
              {upgrade && <BytecodeView upgrade={upgrade} />}
            </>
          )}
          {tab === "payload" && (
            <div className="space-y-2">
              <p className="text-xs text-muted">
                Exactly what an executor submits: chain id, guard, proposal key, version and each action's target, value (base units), calldata and operation. Edit it to try your own tampering.
              </p>
              <textarea
                className="textarea min-h-[340px] font-mono text-[11.5px]"
                value={customText}
                onChange={(e) => {
                  setCustomText(e.target.value);
                  if (scenario !== "custom") setScenario("custom");
                  try {
                    JSON.parse(e.target.value);
                    setCustomError(null);
                  } catch (err) {
                    setCustomError((err as Error).message);
                  }
                }}
                spellCheck={false}
                aria-label="Submitted payload JSON"
              />
              {customError && <p className="text-2xs text-danger">Invalid JSON: {customError}</p>}
            </div>
          )}
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel title="Preflight analysis" icon={<ShieldCheck className="h-4 w-4 text-muted" />} subtitle="Advisory: deterministic rules plus an eth_call to ExecutionGuard.preflight()." actions={check && <StatusBadge status={check.status} />}>
            {!check && <p className="text-xs text-muted">Not checked yet. Run the preflight check to compare this payload with the approved manifest.</p>}
            {check && (
              <div className="space-y-2.5">
                <p className="text-sm">{check.preflight.summary}</p>
                <div className="rounded-lg border border-line p-2.5 text-xs">
                  <p className="font-semibold">Contract preflight</p>
                  {check.preflight.performed ? (
                    check.preflight.would_execute ? (
                      <p className="mt-1 text-primary">The guard would execute this payload.</p>
                    ) : (
                      <p className="mt-1 text-danger">
                        Would revert: <span className="font-mono">{check.preflight.revert?.name}</span>. {check.preflight.revert?.explanation}
                      </p>
                    )
                  ) : (
                    <p className="mt-1 text-warning">{check.preflight.reason}</p>
                  )}
                </div>
                {check.discrepancies.slice(0, 4).map((d, i) => (
                  <div key={i} className="rounded-lg border border-danger/20 bg-danger/[0.03] p-2.5">
                    <div className="flex items-center gap-1.5">
                      <SeverityBadge severity={d.severity} />
                      <span className="text-xs font-semibold">{d.title}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted">{d.explanation}</p>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel
            title="Simulation results & analysis"
            icon={<FlaskConical className="h-4 w-4 text-muted" />}
            actions={sim && <StatusBadge status={sim.verdict} />}
            subtitle={sim ? `${sim.id} · ${sim.trigger} · block #${sim.chain_block} · ${dateTime(sim.finished_at)}` : "Executes the payload as the guard on a snapshot, probes the result, then reverts."}
          >
            {simulate.isPending && <LoadingBlock rows={5} />}
            {!sim && !simulate.isPending && <p className="text-xs text-muted">No simulation for this scenario yet.</p>}
            {sim && sim.status === "failed" && <ErrorState error={sim.report?.error} />}
            {report && sim?.status === "completed" && (
              <div className="space-y-3">
                <p className={cx("text-sm font-medium", sim.verdict === "block" ? "text-danger" : sim.verdict === "flag" ? "text-warning" : "text-primary")}>{report.summary}</p>
                {report.findings.length > 0 && (
                  <div>
                    <p className="label mb-1.5">Severe risk metrics</p>
                    <ul className="space-y-1.5">
                      {report.findings.slice(0, 6).map((f: any, i: number) => (
                        <li key={i} className="rounded-lg border border-line p-2">
                          <div className="flex items-center gap-1.5">
                            <SeverityBadge severity={f.severity} />
                            <span className="truncate text-xs font-semibold" title={f.title}>{f.title}</span>
                          </div>
                          <p className="mt-1 line-clamp-3 text-2xs text-muted" title={f.explanation}>{f.explanation}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div>
                  <p className="label mb-1.5">Declared intent vs observed behaviour</p>
                  <ul className="space-y-1.5">
                    {report.intent.assertions.map((a: any) => (
                      <li key={a.id} className="flex gap-2 text-xs">
                        <AssertionIcon status={a.status} />
                        <span className="min-w-0">
                          <span className="font-medium">{a.claim}</span>
                          <span className="block text-2xs text-muted">{a.evidence_text}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                {report.balance_changes.length > 0 && (
                  <div>
                    <p className="label mb-1.5">Balance changes (simulated)</p>
                    {report.balance_changes.map((b: any, i: number) => (
                      <div key={i} className="flex justify-between text-xs">
                        <span className="text-muted">{b.holder_label ?? shortAddr(b.holder)}</span>
                        <span className={cx("font-mono", b.delta.startsWith("-") ? "text-danger" : "text-primary")}>{b.display}</span>
                      </div>
                    ))}
                  </div>
                )}
                <details className="text-2xs text-muted">
                  <summary className="cursor-pointer font-medium">Method & limitations</summary>
                  <p className="mt-1">{report.engine}</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {report.limitations.map((l: string) => <li key={l}>{l}</li>)}
                  </ul>
                </details>
              </div>
            )}
          </Panel>

          {attempt && <AttemptCard a={attempt} />}

          <Panel title="Execution attempts" subtitle="Real transactions to the ExecutionGuard on the local chain.">
            {(attempts.data ?? []).length === 0 && <p className="text-xs text-muted">No execution attempts yet.</p>}
            <ul className="space-y-1.5">
              {(attempts.data ?? []).slice(0, 8).map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 rounded-lg border border-line px-2.5 py-1.5 text-xs">
                  <span className="min-w-0">
                    <span className="font-medium">{titleCase(a.scenario ?? "custom")}</span>
                    <span className="block truncate text-2xs text-muted">{a.outcome === "executed" ? "Executed" : a.outcome === "not_sent" ? "Not sent (gateway)" : a.revert?.name}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <StatusBadge status={a.outcome === "executed" ? "executed_attempt" : a.outcome} />
                    {a.tx_hash && <TxLink hash={a.tx_hash} />}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 backdrop-blur md:left-[64px]">
        <div className="mx-auto flex max-w-[1680px] flex-wrap items-center gap-2 px-4 py-2.5 md:px-6">
          <span className="hidden text-xs text-muted lg:inline">{p?.id} · {scenarioInfo?.label ?? (scenario === "custom" ? "Custom payload" : scenario)}</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button icon={<ShieldCheck className="h-4 w-4" />} loading={runCheck.isPending} disabled={!submitted} onClick={() => runCheck.mutate(undefined)}>
              Run preflight check
            </Button>
            <Button icon={<FlaskConical className="h-4 w-4" />} loading={simulate.isPending} disabled={!submitted} onClick={() => simulate.mutate(undefined)}>
              Simulate contract run
            </Button>
            <Button variant="dark" icon={<Play className="h-4 w-4" />} disabled={!submitted} onClick={() => setConfirmExec(true)}>
              Execute guarded demo
            </Button>
            <Button variant="outline-danger" icon={<Ban className="h-4 w-4" />} disabled={guard?.status !== "approved"} title={guard?.status !== "approved" ? "Only an approved, not-yet-executed manifest can be halted" : undefined} onClick={() => setConfirmHalt(true)}>
              Force halt (guardian)
            </Button>
            <Button icon={<Siren className="h-4 w-4" />} onClick={() => navigate(`/escalation?p=${pid}`)}>
              Trigger escalation
            </Button>
            <Button variant="danger" icon={<Stamp className="h-4 w-4" />} disabled={!p?.current_version} onClick={() => setConfirmDispute(true)}>
              Report discrepancy
            </Button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmExec}
        onClose={() => setConfirmExec(false)}
        onConfirm={() => execute.mutate(undefined)}
        loading={execute.isPending}
        title="Send a real transaction to the ExecutionGuard?"
        description={
          <>
            The demo executor will call <span className="font-mono">ExecutionGuard.execute()</span> with this payload on the local chain. If it does not match the approved
            manifest, the contract reverts and nothing moves. The rejection is recorded on-chain with a transaction hash. Tampered payloads are sent on purpose so the
            rejection is contract-enforced, not a dashboard warning.
          </>
        }
        confirmLabel="Send transaction"
      />
      <ConfirmDialog
        open={confirmHalt}
        onClose={() => setConfirmHalt(false)}
        onConfirm={(reason, confirm) => halt.mutate({ reason, confirm })}
        loading={halt.isPending}
        danger
        title={`Halt ${pid} on-chain`}
        description="The guardian calls ExecutionGuard.halt(). The approved manifest can then never execute; governance must approve a newer version. Guardians can only block, never approve or execute."
        reasonLabel="Reason (hashed on-chain, full text in the audit ledger)"
        phrase={pid}
        confirmLabel="Halt execution"
      />
      <ConfirmDialog
        open={confirmDispute}
        onClose={() => setConfirmDispute(false)}
        onConfirm={(statement) => dispute.mutate(statement)}
        loading={dispute.isPending}
        title={`File a cryptographic dispute against ${pid} v${p?.current_version}`}
        description="The statement's hash is recorded on-chain in ProposalRegistry.fileDispute(); the full text is kept in the audit ledger."
        reasonLabel="Dispute statement"
        confirmLabel="File dispute on-chain"
      />
    </div>
  );
}

function AttemptCard({ a }: { a: ExecutionAttempt }) {
  const ok = a.outcome === "executed";
  const notSent = a.outcome === "not_sent";
  return (
    <section className={cx("rounded-xl border p-4 shadow-card animate-fade-in", ok ? "border-primary/40 bg-primary/5" : notSent ? "border-warning/40 bg-warning/5" : "border-danger/40 bg-danger/5")}>
      <div className="flex items-center gap-2">
        {ok ? <ShieldCheck className="h-5 w-5 text-primary" /> : notSent ? <ShieldAlert className="h-5 w-5 text-warning" /> : <ShieldX className="h-5 w-5 text-danger" />}
        <p className={cx("text-sm font-bold uppercase tracking-[0.04em]", ok ? "text-primary" : notSent ? "text-warning" : "text-danger")}>
          {ok ? "Executed through the guard" : notSent ? "Not sent: gateway refusal" : "Rejected by the contract"}
        </p>
      </div>
      {a.revert && <p className="mt-2 text-sm"><span className="font-mono font-semibold">{a.revert.name}</span>: {a.revert.explanation}</p>}
      {a.balance_changes.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {a.balance_changes.map((b, i) => (
            <div key={i} className="flex justify-between text-xs">
              <span>{b.holder_label ?? shortAddr(b.holder)}</span>
              <span className="font-mono">{b.display}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
        <span className="text-muted">{a.enforcement}</span>
        {a.tx_hash && <TxLink hash={a.tx_hash} block={a.block_number} />}
        {a.submitted_manifest_hash && <Hash value={a.submitted_manifest_hash} />}
      </div>
    </section>
  );
}

function BytecodeView({ upgrade }: { upgrade: any }) {
  const ref = upgrade.reference;
  const old = upgrade.old_analysis;
  const neu = upgrade.new_analysis;
  const added = new Set((upgrade.bytecode_diff.selectors_added ?? []).map((f: any) => f.selector));
  const probes = [...(ref?.probes ?? []), ...(upgrade.probes_before ?? []), ...(upgrade.probes_after ?? [])];
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-2">
        <div className="rounded-lg border border-line p-2.5 text-xs">
          <p className="label mb-1">{ref && !ref.identical ? "Reviewed implementation" : "Currently installed"}</p>
          <p className="font-medium">{ref && !ref.identical ? ref.label : upgrade.old_label ?? "FeeVault implementation"}</p>
          <Hash value={ref && !ref.identical ? ref.implementation : upgrade.old_implementation} />
          <p className="mt-1 text-2xs text-muted">codehash <span className="font-mono">{(ref && !ref.identical ? ref.codehash_reviewed : old.codehash)?.slice(0, 18)}…</span></p>
        </div>
        <div className="rounded-lg border border-danger/30 bg-danger/[0.03] p-2.5 text-xs">
          <p className="label mb-1">Submitted implementation</p>
          <p className="font-medium">{upgrade.new_label ?? "unlabelled"}</p>
          <Hash value={upgrade.new_implementation} />
          <p className="mt-1 text-2xs text-muted">codehash <span className="font-mono">{neu.codehash?.slice(0, 18)}…</span> · {neu.size} bytes</p>
        </div>
      </div>
      {ref && !ref.identical && (
        <Callout tone={ref.capabilities_added.length || ref.embedded_added.length ? "danger" : "info"} title="Against the reviewed implementation">
          {ref.selectors_added.length + ref.selectors_removed.length === 0 ? "Same dispatcher functions. " : "Dispatcher functions differ. "}
          {ref.embedded_added.length > 0 && `New hard-coded address ${ref.embedded_added.join(", ")}. `}
          {ref.behaviour_diff.length === 0 ? "Identical sampled outputs. " : `${ref.behaviour_diff.length} sampled output(s) differ. `}
          {ref.capabilities_added.length > 0 && `${ref.capabilities_added.length} caller capability(ies) exist only in the submitted code.`}
        </Callout>
      )}
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="table-base">
          <thead>
            <tr>
              <th>Selector</th>
              <th>Function (dispatcher)</th>
              <th>vs installed code</th>
            </tr>
          </thead>
          <tbody>
            {neu.functions.map((f: any) => (
              <tr key={f.selector}>
                <td className="font-mono text-2xs">{f.selector}</td>
                <td className="font-mono text-2xs">{f.signature ?? <span className="text-warning">unknown</span>}</td>
                <td>{added.has(f.selector) ? <Badge tone="warning">added</Badge> : <Badge>unchanged</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <div className="rounded-lg border border-line p-2.5 text-xs">
          <p className="label mb-1">Embedded addresses (PUSH20 / immutables)</p>
          {neu.embedded_addresses.length === 0 ? <p className="text-muted">None</p> : neu.embedded_addresses.map((a: string) => <Hash key={a} value={a} head={12} tail={6} />)}
        </div>
        <div className="rounded-lg border border-line p-2.5 text-xs">
          <p className="label mb-1">Opcode profile</p>
          <div className="flex flex-wrap gap-1">
            {Object.entries(neu.opcodes as Record<string, number>).map(([op, n]) => (
              <Badge key={op} tone={["DELEGATECALL", "SELFDESTRUCT", "CALLCODE", "ORIGIN"].includes(op) ? "danger" : "neutral"}>{op} ×{n}</Badge>
            ))}
          </div>
        </div>
      </div>
      <div>
        <p className="label mb-1.5">Capability probes ({probes.length})</p>
        <div className="max-h-[260px] overflow-auto rounded-lg border border-line scroll-thin">
          <table className="table-base">
            <thead>
              <tr>
                <th>Code</th>
                <th>Caller</th>
                <th>Function</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {probes.map((pr: any, i: number) => (
                <tr key={i} className={pr.outflows.length ? "bg-danger/[0.05]" : ""}>
                  <td className="text-2xs">{pr.phase === "before" ? "installed" : pr.phase === "reviewed" ? "reviewed" : "submitted"}</td>
                  <td className="text-2xs">{pr.caller_role}<span className="block font-mono text-faint">{shortAddr(pr.caller)}</span></td>
                  <td className="font-mono text-2xs">{pr.function}</td>
                  <td className="text-2xs">
                    {pr.outflows.length ? <span className="font-semibold text-danger">moved {pr.outflows.map((o: any) => o.display).join(", ")}</span> : pr.status === "success" ? <span className="text-muted">ok · no funds moved</span> : <span className="text-muted">reverted ({pr.revert})</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
