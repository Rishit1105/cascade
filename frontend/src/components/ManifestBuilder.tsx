/* Structured manifest builder. Every edit is encoded, hashed (EIP-712) and preflighted against the
   ExecutionGuard on the server, so the reviewer sees at once whether the digest still matches what
   governance approved, and exactly which part diverges. Nothing is stored or sent. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CheckCircle2, Copy, Hash as HashIcon, Loader2, Plus, RotateCcw, Trash2, XCircle } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { cx, shortHash } from "../lib/format";
import { Badge, Button, Callout, CopyButton, IconButton } from "./ui";

type Kind = "erc20_transfer" | "erc20_approve" | "proxy_upgrade" | "contract_call" | "raw";
type Spec = { kind: Kind; [field: string]: any };
type Row = { uid: number; spec: Spec };
interface Context {
  chain_id: string;
  guard: string;
  proposal_key: string;
  version: string;
}
interface ActionRow {
  index: number;
  spec: Spec;
  action: { target: string; value: string; data: string; operation: number };
  decoded: { human_readable: string; kind: string; function?: string | null };
  struct_hash: string;
  approved_struct_hash: string | null;
  matches_approved: boolean;
  differs_in: string[];
}
interface Preview {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  basis: string;
  basis_version?: number | null;
  payload?: any;
  specs?: Spec[];
  submitted?: Record<string, any>;
  approved?: Record<string, any> | null;
  match?: boolean;
  comparison?: Array<{ part: string; submitted: any; approved: any; match: boolean; note: string }>;
  actions?: ActionRow[];
  missing_actions?: Array<{ index: number; human: string }>;
  preflight?: { performed: boolean; would_execute?: boolean; reason?: string; revert?: { name: string; explanation: string } | null; contract_digest?: string | null };
  note?: string;
}
interface AddressBook {
  addresses: Array<{ address: string; label: string; kind: string }>;
  tokens: Array<{ address: string; symbol: string; decimals: number }>;
  defaults: { chain_id: number; guard: string; proxy_admin: string; fee_vault: string };
}

const KINDS: Array<{ id: Kind; label: string; short: string }> = [
  { id: "erc20_transfer", label: "ERC-20 transfer", short: "Transfer" },
  { id: "erc20_approve", label: "ERC-20 approve", short: "Approve" },
  { id: "proxy_upgrade", label: "Proxy upgrade", short: "Upgrade" },
  { id: "contract_call", label: "Contract call", short: "Call" },
  { id: "raw", label: "Raw calldata", short: "Raw" },
];

function blank(kind: Kind, book?: AddressBook, from?: Spec): Spec {
  const token = from?.token ?? book?.tokens[0]?.address ?? "";
  const target = from?.target ?? from?.token ?? "";
  switch (kind) {
    case "erc20_transfer":
      return { kind, token, to: from?.to ?? from?.spender ?? "", amount: from?.amount ?? "" };
    case "erc20_approve":
      return { kind, token, spender: from?.spender ?? from?.to ?? "", amount: from?.amount ?? "" };
    case "proxy_upgrade":
      return { kind, proxy_admin: book?.defaults.proxy_admin ?? "", proxy: book?.defaults.fee_vault ?? "", implementation: "", call_data: "0x" };
    case "contract_call":
      return { kind, target, signature: "", args: [], value: "0" };
    default:
      return { kind: "raw", target, value: "0", data: "0x", operation: 0 };
  }
}

let nextUid = 1;
const withUids = (specs: Spec[]): Row[] => specs.map((spec) => ({ uid: nextUid++, spec }));
const sigTypes = (sig: string): string[] => {
  const m = sig.replace(/\s+/g, "").match(/^[A-Za-z_][A-Za-z0-9_]*\(([^()]*)\)$/);
  return m ? m[1].split(",").filter(Boolean) : [];
};

function AddressInput({ value, onChange, book, placeholder, error }: { value: string; onChange: (v: string) => void; book?: AddressBook; placeholder?: string; error?: string }) {
  const known = book?.addresses.find((a) => a.address.toLowerCase() === (value ?? "").toLowerCase()) ?? book?.tokens.find((t) => t.address.toLowerCase() === (value ?? "").toLowerCase());
  const valid = /^0x[0-9a-fA-F]{40}$/.test(value ?? "");
  return (
    <div>
      <input className={cx("input font-mono text-xs", error && "border-danger")} list="dg-address-book" value={value ?? ""} placeholder={placeholder ?? "0x… or pick a labelled address"} onChange={(e) => onChange(e.target.value.trim())} spellCheck={false} />
      <p className={cx("mt-0.5 truncate text-2xs", error ? "text-danger" : known ? "text-primary" : "text-faint")}>
        {error ?? (known ? ("label" in known ? `${known.label} · ${known.kind}` : `${known.symbol} token`) : valid ? "Unlabelled address" : value ? "Not a 20-byte address yet" : " ")}
      </p>
    </div>
  );
}

function F({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block min-w-0", className)}>
      <span className="mb-1 block text-2xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

function SpecFields({ spec, set, book, err }: { spec: Spec; set: (patch: Partial<Spec>) => void; book?: AddressBook; err: (field: string) => string | undefined }) {
  const tokenSel = (
    <F label="Token">
      <select className="input text-xs" value={book?.tokens.some((t) => t.address === spec.token) ? spec.token : "other"} onChange={(e) => set({ token: e.target.value === "other" ? "" : e.target.value })}>
        {book?.tokens.map((t) => (
          <option key={t.address} value={t.address}>
            {t.symbol} ({t.decimals} decimals)
          </option>
        ))}
        <option value="other">Other token…</option>
      </select>
      {!book?.tokens.some((t) => t.address === spec.token) && (
        <div className="mt-1">
          <AddressInput value={spec.token} onChange={(v) => set({ token: v })} book={book} error={err("token")} placeholder="Token contract address" />
        </div>
      )}
    </F>
  );
  const amount = (
    <F label="Amount (token units)">
      <input className={cx("input font-mono text-xs", err("amount") && "border-danger")} inputMode="decimal" value={spec.amount ?? ""} placeholder="500000" onChange={(e) => set({ amount: e.target.value })} />
      {err("amount") && <p className="mt-0.5 text-2xs text-danger">{err("amount")}</p>}
    </F>
  );
  if (spec.kind === "erc20_transfer" || spec.kind === "erc20_approve") {
    const who = spec.kind === "erc20_transfer" ? "to" : "spender";
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        {tokenSel}
        {amount}
        <F label={spec.kind === "erc20_transfer" ? "Recipient" : "Spender"} className="sm:col-span-2">
          <AddressInput value={spec[who]} onChange={(v) => set({ [who]: v })} book={book} error={err(who)} />
        </F>
      </div>
    );
  }
  if (spec.kind === "proxy_upgrade") {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <F label="Proxy">
          <AddressInput value={spec.proxy} onChange={(v) => set({ proxy: v })} book={book} error={err("proxy")} />
        </F>
        <F label="New implementation">
          <AddressInput value={spec.implementation} onChange={(v) => set({ implementation: v })} book={book} error={err("implementation")} />
        </F>
        <F label="ProxyAdmin (call target)">
          <AddressInput value={spec.proxy_admin} onChange={(v) => set({ proxy_admin: v })} book={book} error={err("proxy_admin")} />
        </F>
        <F label="Initialisation calldata">
          <input className={cx("input font-mono text-xs", err("call_data") && "border-danger")} value={spec.call_data ?? "0x"} onChange={(e) => set({ call_data: e.target.value.trim() })} spellCheck={false} />
          {err("call_data") && <p className="mt-0.5 text-2xs text-danger">{err("call_data")}</p>}
        </F>
      </div>
    );
  }
  if (spec.kind === "contract_call") {
    const types = sigTypes(spec.signature ?? "");
    const args: string[] = spec.args ?? [];
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <F label="Target contract">
          <AddressInput value={spec.target} onChange={(v) => set({ target: v })} book={book} error={err("target")} />
        </F>
        <F label="Function signature">
          <input
            className={cx("input font-mono text-xs", err("signature") && "border-danger")}
            value={spec.signature ?? ""}
            placeholder="setFeeBps(uint16)"
            spellCheck={false}
            onChange={(e) => {
              const n = sigTypes(e.target.value).length;
              set({ signature: e.target.value, args: Array.from({ length: n }, (_, k) => args[k] ?? "") });
            }}
          />
          {err("signature") && <p className="mt-0.5 text-2xs text-danger">{err("signature")}</p>}
        </F>
        {types.map((t, k) => (
          <F key={k} label={`Argument ${k + 1} · ${t}`}>
            {t === "address" ? (
              <AddressInput value={args[k] ?? ""} onChange={(v) => set({ args: args.map((a, j) => (j === k ? v : a)) })} book={book} error={err(`args[${k}]`)} />
            ) : (
              <>
                <input className={cx("input font-mono text-xs", err(`args[${k}]`) && "border-danger")} value={args[k] ?? ""} onChange={(e) => set({ args: args.map((a, j) => (j === k ? e.target.value : a)) })} spellCheck={false} />
                {err(`args[${k}]`) && <p className="mt-0.5 text-2xs text-danger">{err(`args[${k}]`)}</p>}
              </>
            )}
          </F>
        ))}
        <F label="ETH value (wei)">
          <input className="input font-mono text-xs" value={spec.value ?? "0"} onChange={(e) => set({ value: e.target.value.trim() })} />
        </F>
        {err("args") && <p className="text-2xs text-danger sm:col-span-2">{err("args")}</p>}
      </div>
    );
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <F label="Target">
        <AddressInput value={spec.target} onChange={(v) => set({ target: v })} book={book} error={err("target")} />
      </F>
      <div className="grid grid-cols-2 gap-2">
        <F label="Value (wei)">
          <input className={cx("input font-mono text-xs", err("value") && "border-danger")} value={spec.value ?? "0"} onChange={(e) => set({ value: e.target.value.trim() })} />
        </F>
        <F label="Operation">
          <select className="input text-xs" value={String(spec.operation ?? 0)} onChange={(e) => set({ operation: Number(e.target.value) })}>
            <option value="0">0 · call</option>
            <option value="1">1 · delegatecall</option>
          </select>
        </F>
      </div>
      <F label="Calldata (hex)" className="sm:col-span-2">
        <textarea className={cx("textarea min-h-[64px] break-all font-mono text-[11px]", err("data") && "border-danger")} value={spec.data ?? "0x"} onChange={(e) => set({ data: e.target.value.trim() })} spellCheck={false} />
        {err("data") && <p className="mt-0.5 text-2xs text-danger">{err("data")}</p>}
      </F>
    </div>
  );
}

function DigestStrip({ preview, pending }: { preview: Preview | null; pending: boolean }) {
  if (!preview) return <div className="h-[74px] animate-pulse rounded-xl bg-subtle" />;
  const pf = preview.preflight;
  let tone: "success" | "warning" | "danger" = "danger";
  let title = "";
  let body: ReactNode = null;
  if (!preview.valid) {
    title = `Cannot encode: ${preview.errors.length} problem${preview.errors.length === 1 ? "" : "s"}`;
    body = preview.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join(" · ");
  } else if (preview.match) {
    tone = pf?.would_execute ? "success" : "warning";
    title = pf?.would_execute ? `Digest matches the ${preview.basis} manifest v${preview.basis_version} · the guard would execute it` : `Digest matches v${preview.basis_version}, but the guard would still refuse`;
    body = pf?.would_execute ? "ExecutionGuard.preflight() accepts this exact payload." : pf?.revert ? `${pf.revert.name}: ${pf.revert.explanation}` : pf?.reason;
  } else {
    title = preview.approved ? `Digest differs from the ${preview.basis} manifest v${preview.basis_version}` : "No committed manifest to compare with";
    body = pf?.revert ? `The guard would revert with ${pf.revert.name}. ${pf.revert.explanation}` : pf?.reason;
  }
  const styles = { success: "border-primary/30 bg-primary/[0.06]", warning: "border-warning/40 bg-warning/[0.07]", danger: "border-danger/30 bg-danger/[0.05]" }[tone];
  const Icon = tone === "success" ? CheckCircle2 : XCircle;
  return (
    <div className={cx("rounded-xl border px-3.5 py-3", styles)} aria-live="polite">
      <div className="flex items-start gap-2.5">
        {pending ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-info" /> : <Icon className={cx("mt-0.5 h-4 w-4 shrink-0", tone === "success" ? "text-primary" : tone === "warning" ? "text-warning" : "text-danger")} />}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-fg">{title}</p>
          {body && <p className="mt-0.5 text-xs text-muted">{body}</p>}
          {preview.valid && preview.submitted && (
            <div className="mt-2 grid gap-1 text-2xs sm:grid-cols-2">
              <span className="flex min-w-0 items-center gap-1">
                <span className="w-[62px] shrink-0 text-muted">Submitted</span>
                <span className={cx("truncate font-mono", preview.match ? "text-primary" : "text-danger")} title={preview.submitted.digest}>{shortHash(preview.submitted.digest, 12, 8)}</span>
                <CopyButton value={preview.submitted.digest} />
              </span>
              {preview.approved && (
                <span className="flex min-w-0 items-center gap-1">
                  <span className="w-[62px] shrink-0 text-muted">Approved</span>
                  <span className="truncate font-mono text-fg" title={preview.approved.digest}>{shortHash(preview.approved.digest, 12, 8)}</span>
                  <CopyButton value={preview.approved.digest} />
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ManifestBuilder({ proposalId, submitted, onPayload, onReset }: { proposalId: string; submitted: any; onPayload: (payload: any) => void; onReset: () => void }) {
  const book = useQuery({ queryKey: ["address-book"], queryFn: () => api.get<AddressBook>("/address-book"), staleTime: 60_000 });
  const [rows, setRows] = useState<Row[]>([]);
  const [ctx, setCtx] = useState<Context>({ chain_id: "", guard: "", proposal_key: "", version: "" });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, setPending] = useState(false);
  const [netError, setNetError] = useState<string | null>(null);
  const [editSeq, setEditSeq] = useState(0);
  const lastEmitted = useRef<string>("");
  const reqId = useRef(0);

  const run = async (body: unknown, fromEdit: boolean) => {
    const id = ++reqId.current;
    setPending(true);
    try {
      const res = await api.post<Preview>(`/proposals/${proposalId}/manifest/preview`, body);
      if (id !== reqId.current) return;
      setNetError(null);
      setPreview(res);
      if (!fromEdit && res.valid && res.specs && res.payload) {
        setRows(withUids(res.specs));
        setCtx({ chain_id: String(res.payload.chain_id), guard: res.payload.guard, proposal_key: res.payload.proposal_key, version: String(res.payload.version) });
      }
      if (fromEdit && res.valid && res.payload) {
        lastEmitted.current = JSON.stringify(res.payload);
        onPayload(res.payload);
      }
    } catch (e) {
      if (id === reqId.current) setNetError((e as ApiError).message);
    } finally {
      if (id === reqId.current) setPending(false);
    }
  };

  // Payload changed outside the builder (scenario switch, JSON edit): load it into structured form.
  const submittedKey = useMemo(() => (submitted ? JSON.stringify(submitted) : ""), [submitted]);
  useEffect(() => {
    if (!submittedKey || submittedKey === lastEmitted.current) return;
    lastEmitted.current = submittedKey;
    run({ payload: submitted }, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submittedKey, proposalId]);

  // Builder edits: debounce, then encode + hash + preflight.
  useEffect(() => {
    if (editSeq === 0) return;
    const t = window.setTimeout(() => {
      const context = { chain_id: ctx.chain_id.trim(), guard: ctx.guard.trim(), proposal_key: ctx.proposal_key.trim(), version: ctx.version.trim() };
      run({ context, actions: rows.map((r) => r.spec) }, true);
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editSeq]);

  const edit = (fn: (rows: Row[]) => Row[]) => {
    setRows((r) => fn(r));
    setEditSeq((n) => n + 1);
  };
  const setCtxField = (k: keyof Context, v: string) => {
    setCtx((c) => ({ ...c, [k]: v }));
    setEditSeq((n) => n + 1);
  };
  const err = (i: number) => (field: string) => preview?.errors.find((e) => e.path === `actions[${i}].${field}` || e.path === `actions[${i}].amount_base` && field === "amount")?.message;
  const ctxErr = (k: string) => preview?.errors.find((e) => e.path === `context.${k}`)?.message;
  const actionRow = (i: number) => (preview?.valid ? preview.actions?.[i] : undefined);
  const b = book.data;

  return (
    <div className="space-y-3" data-tour="builder">
      <datalist id="dg-address-book">
        {b?.addresses.map((a) => (
          <option key={a.address} value={a.address}>
            {a.label}
          </option>
        ))}
      </datalist>
      <DigestStrip preview={preview} pending={pending} />
      {netError && <Callout tone="danger">{netError}</Callout>}

      <details className="rounded-lg border border-line" open={!!(ctxErr("chain_id") || ctxErr("guard") || ctxErr("proposal_key") || ctxErr("version"))}>
        <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-xs">
          <span className="font-semibold text-fg">Signing context (EIP-712 domain, proposal key, version)</span>
          <span className="font-mono text-2xs text-muted">chain {ctx.chain_id || "—"} · v{ctx.version || "—"}</span>
        </summary>
        <div className="grid gap-2 border-t border-line px-3 py-2.5 sm:grid-cols-2">
          <F label="Chain id">
            <input className="input font-mono text-xs" value={ctx.chain_id} onChange={(e) => setCtxField("chain_id", e.target.value)} />
            {ctxErr("chain_id") && <p className="mt-0.5 text-2xs text-danger">{ctxErr("chain_id")}</p>}
          </F>
          <F label="Version">
            <input className="input font-mono text-xs" value={ctx.version} onChange={(e) => setCtxField("version", e.target.value)} />
            {ctxErr("version") && <p className="mt-0.5 text-2xs text-danger">{ctxErr("version")}</p>}
          </F>
          <F label="Guard (verifying contract)">
            <AddressInput value={ctx.guard} onChange={(v) => setCtxField("guard", v)} book={b} error={ctxErr("guard")} />
          </F>
          <F label={`Proposal key · keccak256("${proposalId}")`}>
            <input className="input font-mono text-xs" value={ctx.proposal_key} onChange={(e) => setCtxField("proposal_key", e.target.value.trim())} spellCheck={false} />
            {ctxErr("proposal_key") && <p className="mt-0.5 text-2xs text-danger">{ctxErr("proposal_key")}</p>}
          </F>
        </div>
      </details>

      <ol className="space-y-2.5">
        {rows.map((r, i) => {
          const ar = actionRow(i);
          return (
            <li key={r.uid} className={cx("rounded-xl border bg-surface", ar ? (ar.matches_approved ? "border-primary/30" : "border-danger/30") : "border-line")}>
              <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-subtle font-mono text-2xs font-bold text-muted">#{i + 1}</span>
                <select
                  className="input h-7 w-auto py-0 text-xs font-semibold"
                  value={r.spec.kind}
                  onChange={(e) => edit((rs) => rs.map((x) => (x.uid === r.uid ? { ...x, spec: blank(e.target.value as Kind, b, x.spec) } : x)))}
                  aria-label={`Action ${i + 1} type`}
                >
                  {KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
                {ar && (ar.matches_approved ? <Badge tone="success">matches approved #{i + 1}</Badge> : <Badge tone="danger">{ar.approved_struct_hash ? `differs in ${ar.differs_in.join(", ")}` : "not in approved manifest"}</Badge>)}
                <span className="ml-auto flex items-center">
                  <IconButton label="Move up" disabled={i === 0} onClick={() => edit((rs) => { const n = [...rs]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; })} className="h-7 w-7 disabled:opacity-30">
                    <ArrowUp className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton label="Move down" disabled={i === rows.length - 1} onClick={() => edit((rs) => { const n = [...rs]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; return n; })} className="h-7 w-7 disabled:opacity-30">
                    <ArrowDown className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton label="Duplicate" onClick={() => edit((rs) => [...rs.slice(0, i + 1), { uid: nextUid++, spec: { ...r.spec, args: r.spec.args ? [...r.spec.args] : undefined } }, ...rs.slice(i + 1)])} className="h-7 w-7">
                    <Copy className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton label="Remove" onClick={() => edit((rs) => rs.filter((x) => x.uid !== r.uid))} className="h-7 w-7 hover:text-danger">
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </span>
              </div>
              <div className="space-y-2 px-3 py-2.5">
                <SpecFields spec={r.spec} book={b} err={err(i)} set={(patch) => edit((rs) => rs.map((x) => (x.uid === r.uid ? { ...x, spec: { ...x.spec, ...patch } } : x)))} />
                {ar && (
                  <div className="rounded-lg bg-subtle/60 px-2.5 py-2 text-xs">
                    <p className="text-fg">{ar.decoded.human_readable}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-2xs text-muted">
                      <span className="inline-flex items-center gap-1" title={ar.struct_hash}>
                        <HashIcon className="h-3 w-3" /> struct {shortHash(ar.struct_hash, 10, 6)}
                      </span>
                      {ar.approved_struct_hash && !ar.matches_approved && <span title={ar.approved_struct_hash}>approved {shortHash(ar.approved_struct_hash, 10, 6)}</span>}
                      <span title={ar.action.data}>calldata {ar.action.data.length > 2 ? `${(ar.action.data.length - 2) / 2} bytes` : "empty"}</span>
                    </p>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {preview?.valid && (preview.missing_actions ?? []).map((m) => (
        <Callout key={m.index} tone="warning" title={`Approved action #${m.index + 1} is missing`}>
          {m.human}
        </Callout>
      ))}

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted">Add</span>
        {KINDS.map((k) => (
          <Button key={k.id} size="sm" variant="ghost" icon={<Plus className="h-3 w-3" />} onClick={() => edit((rs) => [...rs, { uid: nextUid++, spec: blank(k.id, b) }])}>
            {k.short}
          </Button>
        ))}
        <Button size="sm" className="ml-auto" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={onReset}>
          Reset to approved
        </Button>
      </div>

      {preview?.valid && preview.comparison && preview.comparison.length > 0 && (
        <details className="rounded-lg border border-line" open={!preview.match}>
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-fg">How the digest is built, part by part</summary>
          <div className="overflow-x-auto border-t border-line">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Part</th>
                  <th>Submitted</th>
                  <th>Approved</th>
                </tr>
              </thead>
              <tbody>
                {preview.comparison.map((c) => (
                  <tr key={c.part}>
                    <td className="whitespace-nowrap text-xs">
                      <span className="inline-flex items-center gap-1.5">
                        {c.match ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" /> : <XCircle className="h-3.5 w-3.5 text-danger" />}
                        <span className="font-medium">{c.part}</span>
                      </span>
                      {c.note && <p className="ml-5 text-2xs text-faint">{c.note}</p>}
                    </td>
                    <td className={cx("max-w-[200px] truncate font-mono text-2xs", c.match ? "text-muted" : "text-danger")} title={String(c.submitted)}>
                      {typeof c.submitted === "string" && c.submitted.startsWith("0x") ? shortHash(c.submitted, 10, 6) : String(c.submitted)}
                    </td>
                    <td className="max-w-[200px] truncate font-mono text-2xs text-muted" title={String(c.approved)}>
                      {typeof c.approved === "string" && c.approved.startsWith("0x") ? shortHash(c.approved, 10, 6) : String(c.approved)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-line px-3 py-2 text-2xs text-muted">{preview.note}</p>
        </details>
      )}
    </div>
  );
}
