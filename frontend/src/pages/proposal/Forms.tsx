import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileUp, Plus, Trash2 } from "lucide-react";
import { api, type ProposalDetail } from "../../lib/api";
import { formatUnits } from "../../lib/format";
import { useAction, useSystemStatus } from "../../lib/queries";
import { Modal } from "../../components/overlays";
import { Button, Callout, Field, Segmented } from "../../components/ui";

/** Decimal mUSDC string → base units string, without floating point. */
export function toBase(amount: string, decimals = 6): string | null {
  const s = amount.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) return null;
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0")).toString();
}

function useAccounts() {
  const sys = useSystemStatus();
  const accounts: Array<{ role: string; address: string; label: string; kind: string }> = sys.data?.deployment?.accounts ?? [];
  const contracts: Array<{ key: string; address: string; label: string }> = sys.data?.deployment?.contracts ?? [];
  return { accounts, contracts };
}

export function CreateProposal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { accounts, contracts } = useAccounts();
  const [mode, setMode] = useState<"form" | "import">("form");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("grant");
  const [proposer, setProposer] = useState("");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [impl, setImpl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [importRole, setImportRole] = useState("community");
  const fileRef = useRef<HTMLInputElement>(null);
  const people = accounts.filter((a) => a.kind === "wallet" || a.kind === "delegate");
  useEffect(() => {
    if (!proposer && people.length) setProposer(people.find((a) => a.role === "community")?.address ?? people[0].address);
  }, [people, proposer]);
  const base = amount ? toBase(amount) : "0";
  const create = useAction(
    () => {
      const recipientAcct = accounts.find((a) => a.address === recipient);
      const proxyAdmin = contracts.find((c) => c.key === "proxy_admin")?.address;
      const proxy = contracts.find((c) => c.key === "fee_vault")?.address;
      return api.post<any>("/proposals", {
        title,
        category,
        summary,
        body,
        proposer_address: proposer,
        proposer_label: accounts.find((a) => a.address === proposer)?.label ?? "",
        recipient_address: category === "upgrade" ? null : recipient || null,
        recipient_label: category === "upgrade" ? null : recipientAcct?.label ?? null,
        requested_amount_base: category === "upgrade" ? "0" : base,
        draft_actions: category === "upgrade" ? [{ kind: "proxy_upgrade", proxy_admin: proxyAdmin, proxy, implementation: impl, call_data: "0x" }] : [],
      });
    },
    { success: (r: any) => `${r.id} created as a draft`, onSuccess: (r: any) => { onClose(); navigate(`/proposals/${r.id}?tab=disclosure`); } },
  );
  const importFile = useAction(
    () => {
      const fd = new FormData();
      fd.append("file", file!);
      fd.append("proposer_role", importRole);
      return api.upload<any>("/proposals/import", fd);
    },
    { success: (r: any) => `${r.id} imported. Review the extracted fields.`, onSuccess: (r: any) => { onClose(); navigate(`/proposals/${r.id}?tab=brief`); } },
  );
  const formValid = title.trim().length >= 3 && proposer && (category === "upgrade" ? /^0x[0-9a-fA-F]{40}$/.test(impl) : base !== null && (!recipient || /^0x[0-9a-fA-F]{40}$/.test(recipient)));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New proposal"
      subtitle="Drafts are editable. Nothing is binding until a version is committed and voted on."
      width="max-w-2xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {mode === "form" ? (
            <Button variant="primary" disabled={!formValid} loading={create.isPending} onClick={() => create.mutate(undefined)}>Create draft</Button>
          ) : (
            <Button variant="primary" disabled={!file} loading={importFile.isPending} onClick={() => importFile.mutate(undefined)}>Import</Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <Segmented value={mode} onChange={setMode} options={[{ id: "form", label: "Fill in a form" }, { id: "import", label: "Import a PDF / text file" }]} />
        {mode === "import" ? (
          <>
            <input ref={fileRef} type="file" className="hidden" accept=".pdf,.md,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <button onClick={() => fileRef.current?.click()} className="flex w-full flex-col items-center gap-1.5 rounded-lg border border-dashed border-line-strong bg-subtle/40 px-4 py-8 text-sm text-muted hover:bg-subtle">
              <FileUp className="h-5 w-5" />
              {file ? <span className="font-medium text-fg">{file.name}</span> : "Choose a proposal document"}
            </button>
            <Field label="Proposer (demo account that will sign the disclosure)">
              <select className="input" value={importRole} onChange={(e) => setImportRole(e.target.value)}>
                {people.map((a) => (
                  <option key={a.role} value={a.role}>{a.label}</option>
                ))}
              </select>
            </Field>
            <Callout tone="info">Title, amount and recipient are extracted deterministically and must be confirmed. The file is also attached as hashed evidence.</Callout>
          </>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-[1fr_160px]">
              <Field label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
              <Field label="Category">
                <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
                  {["grant", "budget", "retainer", "upgrade"].map((c) => <option key={c}>{c}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Proposer" hint="Demo accounts only: the proposer's key must sign the disclosure on the local node.">
              <select className="input" value={proposer} onChange={(e) => setProposer(e.target.value)}>
                {people.map((a) => <option key={a.address} value={a.address}>{a.label} · {a.address.slice(0, 8)}…</option>)}
              </select>
            </Field>
            {category === "upgrade" ? (
              <Field label="New FeeVault implementation" hint="Upgrades the FeeVault proxy via ProxyAdmin.upgradeAndCall, executed by the ExecutionGuard.">
                <select className="input font-mono" value={impl} onChange={(e) => setImpl(e.target.value)}>
                  <option value="">Choose an implementation…</option>
                  {contracts.filter((c) => c.key.startsWith("fee_vault_v")).map((c) => <option key={c.key} value={c.address}>{c.label} · {c.address.slice(0, 10)}…</option>)}
                </select>
              </Field>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Recipient">
                  <select className="input" value={recipient} onChange={(e) => setRecipient(e.target.value)}>
                    <option value="">Choose a recipient…</option>
                    {people.map((a) => <option key={a.address} value={a.address}>{a.label}</option>)}
                  </select>
                </Field>
                <Field label="Requested amount (mUSDC)" error={amount && base === null ? "Use digits with at most 6 decimals" : undefined} hint={base && base !== "0" ? `${base} base units` : undefined}>
                  <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 25000" />
                </Field>
              </div>
            )}
            <Field label="Summary"><input className="input" value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
            <Field label="Proposal text (Markdown)" hint="Statements like “moves no funds” or “no change to custody” become testable intent assertions for the simulator.">
              <textarea className="textarea min-h-[140px] font-mono text-xs" value={body} onChange={(e) => setBody(e.target.value)} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

interface Milestone { title: string; deliverable: string; month: string; amount: string }
interface BudgetLine { item: string; amount: string }

export function EditDraft({ open, onClose, p }: { open: boolean; onClose: () => void; p: ProposalDetail }) {
  const { contracts } = useAccounts();
  const [title, setTitle] = useState(p.title);
  const [summary, setSummary] = useState(p.summary);
  const [body, setBody] = useState(p.body);
  const [amount, setAmount] = useState(formatUnits(p.requested_amount_base, 6, 6).replace(/,/g, ""));
  const [risks, setRisks] = useState(p.risks.join("\n"));
  const [assumptions, setAssumptions] = useState(p.assumptions.join("\n"));
  const [benefits, setBenefits] = useState(p.benefits.join("\n"));
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [budget, setBudget] = useState<BudgetLine[]>([]);
  const [impl, setImpl] = useState<string>("");
  useEffect(() => {
    if (!open) return;
    setTitle(p.title);
    setSummary(p.summary);
    setBody(p.body);
    setAmount(formatUnits(p.requested_amount_base, 6, 6).replace(/,/g, ""));
    setRisks(p.risks.join("\n"));
    setAssumptions(p.assumptions.join("\n"));
    setBenefits(p.benefits.join("\n"));
    setMilestones(p.milestones.map((m) => ({ title: m.title, deliverable: m.deliverable ?? "", month: m.month !== undefined ? String(m.month) : "", amount: m.amount_base ? formatUnits(m.amount_base, 6, 6).replace(/,/g, "") : "" })));
    setBudget(p.budget_breakdown.map((b) => ({ item: b.item, amount: formatUnits(b.amount_base, 6, 6).replace(/,/g, "") })));
    setImpl(p.draft_actions.find((a) => a.kind === "proxy_upgrade")?.implementation ?? "");
  }, [open, p]);
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  const base = toBase(amount || "0");
  const save = useAction(
    () => {
      const patch: Record<string, unknown> = {
        title, summary, body,
        risks: lines(risks), assumptions: lines(assumptions), benefits: lines(benefits),
        milestones: milestones.filter((m) => m.title.trim()).map((m) => ({ title: m.title, deliverable: m.deliverable, month: m.month ? Number(m.month) : null, amount_base: m.amount ? toBase(m.amount) : null })),
        budget_breakdown: budget.filter((b) => b.item.trim()).map((b) => ({ item: b.item, amount_base: toBase(b.amount) ?? "0" })),
      };
      if (p.category === "upgrade") {
        patch.draft_actions = p.draft_actions.map((a) => (a.kind === "proxy_upgrade" ? { ...a, implementation: impl } : a));
      } else if (base !== p.requested_amount_base) {
        patch.requested_amount_base = base;
        patch.draft_actions = p.draft_actions.map((a) => (a.kind === "erc20_transfer" ? { ...a, amount_base: base } : a));
      }
      return api.patch(`/proposals/${p.id}`, patch);
    },
    { success: "Draft saved. Committed versions are unchanged.", onSuccess: onClose },
  );
  const moneyOk = (s: string) => !s || toBase(s) !== null;
  const valid = title.trim().length >= 3 && base !== null && milestones.every((m) => moneyOk(m.amount)) && budget.every((b) => moneyOk(b.amount));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Edit draft · ${p.id}`}
      subtitle="Changes become part of the next committed version. The version diff will highlight them."
      width="max-w-3xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save draft</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Summary"><input className="input" value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
        {p.category === "upgrade" ? (
          <Field label="Implementation installed by the upgrade action">
            <select className="input font-mono" value={impl} onChange={(e) => setImpl(e.target.value)}>
              {contracts.filter((c) => c.key.startsWith("fee_vault_v")).map((c) => <option key={c.key} value={c.address}>{c.label} · {c.address}</option>)}
            </select>
          </Field>
        ) : (
          <Field label="Requested amount (mUSDC)" error={base === null ? "Use digits with at most 6 decimals" : undefined}>
            <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        )}
        <Field label="Proposal text (Markdown)"><textarea className="textarea min-h-[160px] font-mono text-xs" value={body} onChange={(e) => setBody(e.target.value)} /></Field>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Risks (one per line)"><textarea className="textarea min-h-[80px] text-xs" value={risks} onChange={(e) => setRisks(e.target.value)} /></Field>
          <Field label="Assumptions"><textarea className="textarea min-h-[80px] text-xs" value={assumptions} onChange={(e) => setAssumptions(e.target.value)} /></Field>
          <Field label="Benefits"><textarea className="textarea min-h-[80px] text-xs" value={benefits} onChange={(e) => setBenefits(e.target.value)} /></Field>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium">Milestones</p>
          {milestones.map((m, i) => (
            <div key={i} className="mb-1.5 grid grid-cols-[1fr_1fr_80px_110px_32px] gap-1.5">
              <input className="input" placeholder="Title" value={m.title} onChange={(e) => setMilestones(milestones.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
              <input className="input" placeholder="Deliverable" value={m.deliverable} onChange={(e) => setMilestones(milestones.map((x, j) => (j === i ? { ...x, deliverable: e.target.value } : x)))} />
              <input className="input" placeholder="Month" inputMode="numeric" value={m.month} onChange={(e) => setMilestones(milestones.map((x, j) => (j === i ? { ...x, month: e.target.value.replace(/\D/g, "") } : x)))} />
              <input className="input" placeholder="mUSDC" value={m.amount} onChange={(e) => setMilestones(milestones.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
              <Button size="sm" variant="ghost" aria-label="Remove milestone" onClick={() => setMilestones(milestones.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          ))}
          <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setMilestones([...milestones, { title: "", deliverable: "", month: "", amount: "" }])}>Add milestone</Button>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium">Budget breakdown</p>
          {budget.map((b, i) => (
            <div key={i} className="mb-1.5 grid grid-cols-[1fr_140px_32px] gap-1.5">
              <input className="input" placeholder="Item" value={b.item} onChange={(e) => setBudget(budget.map((x, j) => (j === i ? { ...x, item: e.target.value } : x)))} />
              <input className="input" placeholder="mUSDC" value={b.amount} onChange={(e) => setBudget(budget.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
              <Button size="sm" variant="ghost" aria-label="Remove line" onClick={() => setBudget(budget.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          ))}
          <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setBudget([...budget, { item: "", amount: "" }])}>Add budget line</Button>
        </div>
      </div>
    </Modal>
  );
}
