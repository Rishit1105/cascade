import { useRef, useState } from "react";
import { FileUp, Link2, Paperclip, ShieldAlert } from "lucide-react";
import { api, type ProposalDetail } from "../../lib/api";
import { useApp } from "../../lib/app";
import { dateTime, titleCase } from "../../lib/format";
import { useAction } from "../../lib/queries";
import { Modal } from "../../components/overlays";
import { Badge, Button, EmptyState, Field, Hash, Segmented } from "../../components/ui";

export function EvidenceTab({ p }: { p: ProposalDetail }) {
  const { inspect } = useApp();
  const [adding, setAdding] = useState(false);
  const latest = p.versions[p.versions.length - 1];
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">
          Every item is content-hashed (SHA-256). Committed versions bind the set through an on-chain Merkle root{latest ? ` (v${latest.version} root ${latest.evidence_root.slice(0, 10)}…)` : ""}.
        </p>
        <Button size="sm" variant="primary" icon={<Paperclip className="h-3.5 w-3.5" />} onClick={() => setAdding(true)}>
          Attach evidence
        </Button>
      </div>
      {p.evidence.length === 0 && <EmptyState title="No evidence attached" body="Attach the documents, forum posts and transactions behind the proposal's claims." />}
      <div className="overflow-x-auto rounded-lg border border-line">
        {p.evidence.length > 0 && (
          <table className="table-base">
            <thead>
              <tr>
                <th>Source</th>
                <th>Type</th>
                <th>Content hash</th>
                <th>Verification</th>
                <th>Added</th>
              </tr>
            </thead>
            <tbody>
              {p.evidence.map((d) => (
                <tr key={d.id} className="cursor-pointer hover:bg-subtle/60" onClick={() => inspect({ kind: "evidence", proposalId: p.id, docId: d.id })}>
                  <td className="max-w-[320px]">
                    <p className="font-medium text-fg">{d.name}</p>
                    <p className="line-clamp-1 text-2xs text-muted">{d.excerpt}</p>
                    {d.injection_flags.length > 0 && (
                      <Badge tone="danger" className="mt-1" icon={<ShieldAlert className="h-3 w-3" />}>
                        Instruction-like text flagged
                      </Badge>
                    )}
                  </td>
                  <td><Badge>{titleCase(d.source_type)}</Badge></td>
                  <td onClick={(e) => e.stopPropagation()}><Hash value={d.content_hash} head={14} tail={6} /></td>
                  <td>
                    <Badge tone={d.verification_status === "chain-verified" ? "success" : d.verification_status === "not-found-on-chain" ? "danger" : "neutral"}>
                      {d.verification_status.replace(/-/g, " ")}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap text-2xs text-muted">{dateTime(d.added_at)}<br />{d.added_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <AttachEvidence open={adding} onClose={() => setAdding(false)} proposalId={p.id} />
    </div>
  );
}

function AttachEvidence({ open, onClose, proposalId }: { open: boolean; onClose: () => void; proposalId: string }) {
  const [mode, setMode] = useState<"file" | "text" | "transaction" | "url">("file");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [location, setLocation] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const reset = () => {
    setName("");
    setText("");
    setLocation("");
    setFile(null);
    onClose();
  };
  const attach = useAction(
    async () => {
      if (mode === "file") {
        const fd = new FormData();
        fd.append("file", file!);
        fd.append("name", name);
        return api.upload(`/proposals/${proposalId}/evidence/upload`, fd);
      }
      return api.post(`/proposals/${proposalId}/evidence`, {
        name: name || (mode === "transaction" ? `Transaction ${text.slice(0, 10)}…` : "Note"),
        source_type: mode === "url" ? "url" : mode,
        text: mode === "url" ? `Reference: ${location}\n\n${text}` : text,
        location: mode === "url" ? location : mode === "transaction" ? text : null,
      });
    },
    { success: "Evidence attached and hashed", onSuccess: reset },
  );
  const valid = mode === "file" ? !!file : mode === "transaction" ? /^0x[0-9a-fA-F]{64}$/.test(text.trim()) : mode === "url" ? location.trim().length > 4 : text.trim().length > 0 && name.trim().length > 0;
  return (
    <Modal
      open={open}
      onClose={reset}
      title="Attach evidence"
      subtitle="Content is hashed on upload. Identical content cannot be attached twice."
      footer={
        <>
          <Button onClick={reset}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={attach.isPending} onClick={() => attach.mutate(undefined)}>
            Attach
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { id: "file", label: "File (PDF / text)" },
            { id: "text", label: "Text" },
            { id: "url", label: "Link" },
            { id: "transaction", label: "Transaction" },
          ]}
        />
        {mode !== "transaction" && (
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={mode === "file" ? "Defaults to the file name" : "e.g. Forum thread summary"} />
          </Field>
        )}
        {mode === "file" && (
          <div>
            <input ref={fileRef} type="file" accept=".pdf,.md,.txt,application/pdf,text/plain,text/markdown" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <button onClick={() => fileRef.current?.click()} className="flex w-full flex-col items-center gap-1.5 rounded-lg border border-dashed border-line-strong bg-subtle/40 px-4 py-6 text-sm text-muted hover:bg-subtle">
              <FileUp className="h-5 w-5" />
              {file ? <span className="font-medium text-fg">{file.name} · {(file.size / 1024).toFixed(1)} KB</span> : "Choose a PDF, Markdown or text file (max 8 MB)"}
            </button>
            <p className="mt-1 text-2xs text-muted">PDF text is extracted page by page. Scanned PDFs without a text layer are rejected (no OCR in this prototype).</p>
          </div>
        )}
        {mode === "url" && (
          <Field label="URL" hint="DAOGuard records the reference and your summary; it does not fetch external pages.">
            <div className="relative">
              <Link2 className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
              <input className="input pl-8" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="https://forum.example/t/…" />
            </div>
          </Field>
        )}
        {mode === "transaction" ? (
          <Field label="Transaction hash" hint="Looked up on the connected chain and marked chain-verified if found.">
            <input className="input font-mono" value={text} onChange={(e) => setText(e.target.value)} placeholder="0x…" />
          </Field>
        ) : mode !== "file" ? (
          <Field label={mode === "url" ? "Summary of the linked content" : "Content"} hint="Markdown headings become sections that citations can point to.">
            <textarea className="textarea min-h-[140px] font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        ) : null}
      </div>
    </Modal>
  );
}
