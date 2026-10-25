import { useEffect, useState } from "react";
import { Bot, Boxes, RotateCcw, Save, Sigma, SlidersHorizontal, UserRound } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { titleCase } from "../lib/format";
import { useAction, useSettings, useSystemStatus } from "../lib/queries";
import { ConfirmDialog } from "../components/overlays";
import { Badge, Button, Callout, ErrorState, Field, Hash, LoadingBlock, Panel, Toggle } from "../components/ui";

export default function SettingsPage() {
  const settings = useSettings();
  const system = useSystemStatus();
  const { persona, setPersona, theme, toggleTheme } = useApp();
  const [autoHalt, setAutoHalt] = useState(true);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [priors, setPriors] = useState<Record<string, string>>({});
  const [lrs, setLrs] = useState<Record<string, string>>({});
  const [name, setName] = useState(persona);
  const [reset, setReset] = useState(false);
  useEffect(() => {
    const p = settings.data?.policy;
    if (!p) return;
    setAutoHalt(p.auto_halt_on_block_verdict);
    setOverrides(p.severity_overrides ?? {});
    setPriors(Object.fromEntries(Object.entries(p.risk_model.priors).map(([k, v]) => [k, String(v)])));
    setLrs(Object.fromEntries(Object.entries(p.risk_model.likelihood_ratios).map(([k, v]) => [k, String(v)])));
  }, [settings.data]);
  const save = useAction(
    () => api.put("/settings", {
      auto_halt_on_block_verdict: autoHalt,
      severity_overrides: Object.fromEntries(Object.entries(overrides).filter(([, v]) => v)),
      priors: Object.fromEntries(Object.entries(priors).map(([k, v]) => [k, Number(v)])),
      likelihood_ratios: Object.fromEntries(Object.entries(lrs).map(([k, v]) => [k, Number(v)])),
    }),
    { success: "Policy saved and recorded in the audit ledger", invalidate: [["settings"], ["evaluation"], ["overview"], ["audit"]] },
  );
  const doReset = useAction(() => api.post("/system/reset", { confirm: "RESET" }), { success: "Rebuilding the demo environment…", invalidate: [["health"]], onSuccess: () => setReset(false) });
  const numbersOk = [...Object.values(priors), ...Object.values(lrs)].every((v) => v !== "" && Number.isFinite(Number(v)) && Number(v) > 0);

  if (settings.error) return <ErrorState error={settings.error} retry={() => settings.refetch()} />;
  if (!settings.data) return <LoadingBlock rows={10} />;
  const rules = settings.data.rules as Record<string, { title: string; default_severity: string }>;
  const d = system.data?.deployment;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Settings</h1>
          <p className="mt-0.5 text-sm text-muted">Review policy, risk model, AI provider and the local demo deployment.</p>
        </div>
        <Button variant="primary" icon={<Save className="h-4 w-4" />} disabled={!numbersOk} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save policy</Button>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Autonomous response" icon={<SlidersHorizontal className="h-4 w-4 text-muted" />}>
          <div className="flex items-start justify-between gap-4 rounded-lg border border-line p-3">
            <div>
              <p className="text-sm font-semibold">Halt on BLOCK simulation verdict</p>
              <p className="text-xs text-muted">When the sentinel's simulation of an approved manifest contradicts declared intent or opens a new non-governance funds path, it calls ExecutionGuard.halt() during the review window. When off, it raises a critical alert for humans instead.</p>
            </div>
            <Toggle checked={autoHalt} onChange={setAutoHalt} label="Autonomous halt" />
          </div>
          <p className="label mb-2 mt-4">Execution-check rule severities</p>
          <div className="max-h-[360px] overflow-y-auto rounded-lg border border-line scroll-thin">
            <table className="table-base">
              <thead><tr><th>Rule</th><th>Default</th><th>Override</th></tr></thead>
              <tbody>
                {Object.entries(rules).map(([id, r]) => (
                  <tr key={id}>
                    <td className="text-xs"><span className="font-mono text-2xs text-muted">{id}</span><br />{r.title}</td>
                    <td><Badge>{r.default_severity}</Badge></td>
                    <td>
                      <select className="input h-7 text-xs" value={overrides[id] ?? ""} onChange={(e) => setOverrides({ ...overrides, [id]: e.target.value })} aria-label={`Severity for ${id}`}>
                        <option value="">default</option>
                        {["critical", "high", "medium", "low", "info"].map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Risk model (evaluation chain)" icon={<Sigma className="h-4 w-4 text-muted" />} subtitle={settings.data.policy.risk_model.description}>
          <p className="label mb-2">Stage priors (probability of a material issue before evidence)</p>
          <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
            {Object.entries(priors).map(([k, v]) => (
              <Field key={k} label={titleCase(k)}>
                <input className="input font-mono" value={v} onChange={(e) => setPriors({ ...priors, [k]: e.target.value })} inputMode="decimal" />
              </Field>
            ))}
          </div>
          <p className="label mb-2">Likelihood ratios (×odds per piece of evidence)</p>
          <div className="grid max-h-[300px] grid-cols-1 gap-x-4 gap-y-1.5 overflow-y-auto pr-1 md:grid-cols-2 scroll-thin">
            {Object.entries(lrs).map(([k, v]) => (
              <label key={k} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate font-mono text-2xs text-muted" title={k}>{k}</span>
                <input className="input h-7 w-20 font-mono text-xs" value={v} onChange={(e) => setLrs({ ...lrs, [k]: e.target.value })} inputMode="decimal" aria-label={k} />
              </label>
            ))}
          </div>
          {!numbersOk && <p className="mt-2 text-2xs text-danger">Every value must be a positive number.</p>}
        </Panel>

        <Panel title="AI analysis provider" icon={<Bot className="h-4 w-4 text-muted" />}>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-muted">Mode</span><Badge tone={settings.data.ai.provider ? "success" : "warning"}>{settings.data.ai.provider ? "Claude (live)" : "Demo analysis"}</Badge></div>
            <p className="text-xs text-muted">{settings.data.ai.label}</p>
            <Callout tone="info">
              Set <span className="font-mono">ANTHROPIC_API_KEY</span> in <span className="font-mono">backend/.env</span> and restart to enable Claude interpretation. The model only explains: every claim must quote its source verbatim or it is shown as unverified; amounts, manifests and execution decisions stay deterministic.
            </Callout>
          </div>
        </Panel>

        <Panel title="You" icon={<UserRound className="h-4 w-4 text-muted" />}>
          <div className="space-y-3">
            <Field label="Display name recorded on your audit events" hint="There is no login in this demo; this is a persona label.">
              <div className="flex gap-2">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
                <Button onClick={() => setPersona(name)}>Save</Button>
              </div>
            </Field>
            <div className="flex items-center justify-between rounded-lg border border-line p-3 text-sm">
              <span>Dark theme</span>
              <Toggle checked={theme === "dark"} onChange={toggleTheme} label="Dark theme" />
            </div>
          </div>
        </Panel>

        <Panel title="Local demo deployment" icon={<Boxes className="h-4 w-4 text-muted" />} subtitle={d ? `Chain ${d.chain_id} · deployed at block ${d.deployed_block} · review window ${d.review_window_blocks} blocks · voting period ${d.voting_period_blocks} blocks · quorum ${d.quorum_percent}%` : undefined} className="xl:col-span-2">
          {d && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="table-base">
                  <thead><tr><th>Contract</th><th>Address</th></tr></thead>
                  <tbody>{d.contracts.map((c: any) => <tr key={c.key}><td className="text-xs">{c.label}</td><td><Hash value={c.address} head={12} tail={6} /></td></tr>)}</tbody>
                </table>
              </div>
              <div className="max-h-[380px] overflow-auto rounded-lg border border-line scroll-thin">
                <table className="table-base">
                  <thead><tr><th>Demo account</th><th>Role</th><th>Address</th></tr></thead>
                  <tbody>{d.accounts.map((a: any) => <tr key={a.role}><td className="text-xs">{a.label}<span className="block text-2xs text-muted">{a.description}</span></td><td className="font-mono text-2xs">{a.role}</td><td><Hash value={a.address} head={8} tail={4} /></td></tr>)}</tbody>
                </table>
              </div>
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/25 bg-danger/5 p-3">
            <div>
              <p className="text-sm font-semibold text-danger">Reset the demo environment</p>
              <p className="text-xs text-muted">Resets the local chain to genesis, wipes the database, re-deploys the contracts and re-seeds the 30-day history.</p>
            </div>
            <Button variant="danger" data-tour="reset-demo" icon={<RotateCcw className="h-4 w-4" />} onClick={() => setReset(true)}>Reset demo</Button>
          </div>
        </Panel>
      </div>
      <ConfirmDialog open={reset} onClose={() => setReset(false)} onConfirm={() => doReset.mutate(undefined)} loading={doReset.isPending} danger phrase="RESET"
        title="Reset everything?" description="All proposals, versions, votes, executions, alerts and reports created in this session are discarded and the seeded demo is rebuilt (about 10 seconds)." confirmLabel="Reset demo" />
    </div>
  );
}
