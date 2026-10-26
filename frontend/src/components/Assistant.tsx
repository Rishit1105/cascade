/* DAOGuard assistant: a slide-over chat that streams answers from /api/assistant/chat (SSE over
   POST). It reads live data only. Conversation is kept for the browser session. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, ArrowUp, BookOpen, Bot, Check, Copy, Cpu, Database, Eraser, Sparkles, Square, X } from "lucide-react";
import { api } from "../lib/api";
import { cx } from "../lib/format";
import { EASE, SPRING } from "../lib/motion";
import { Markdown } from "./Markdown";

interface Msg {
  id: number;
  role: "user" | "assistant";
  content: string;
  links?: Array<{ label: string; to: string }>;
  sources?: string[];
  mode?: string;
  error?: boolean;
  understanding?: { label: string; confidence: number; proposal: string | null; proposal_from: string | null; engine: string };
}
interface AssistantState {
  open: boolean;
  setOpen: (v: boolean) => void;
  ask: (q: string) => void;
}

const Ctx = createContext<AssistantState>({ open: false, setOpen: () => undefined, ask: () => undefined });
export const useAssistant = () => useContext(Ctx);
const STORE = "daoguard.assistant";
let nextId = 1;

function loadHistory(): Msg[] {
  try {
    const raw = sessionStorage.getItem(STORE);
    const msgs = raw ? (JSON.parse(raw) as Msg[]) : [];
    nextId = msgs.reduce((m, x) => Math.max(m, x.id), 0) + 1;
    return msgs;
  } catch {
    return [];
  }
}

function pageContext(pathname: string, search: string) {
  const fromPath = /\/proposals\/(GOV-\d{3,})/i.exec(pathname)?.[1];
  const fromQuery = new URLSearchParams(search).get("p") ?? new URLSearchParams(search).get("proposal");
  let remembered: string | null = null;
  try {
    remembered = localStorage.getItem("daoguard.proposal");
  } catch {
    /* storage unavailable */
  }
  return { path: pathname + search, proposal_id: fromPath ?? fromQuery ?? remembered ?? undefined };
}

/** Parses an SSE stream delivered over fetch (EventSource cannot POST). */
async function readSse(res: Response, on: (event: string, data: any) => void) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let event = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) on(event, JSON.parse(data));
    }
  }
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const ask = useCallback((q: string) => {
    setPending(q);
    setOpen(true);
  }, []);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const value = useMemo(() => ({ open, setOpen, ask }), [open, ask]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <AssistantPanel open={open} onClose={() => setOpen(false)} pending={pending} clearPending={() => setPending(null)} />
      <Launcher open={open} onOpen={() => setOpen(true)} />
    </Ctx.Provider>
  );
}

function Launcher({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  const loc = useLocation();
  const raised = loc.pathname.startsWith("/guardian"); // clear the guardian's fixed action bar
  const [seen, setSeen] = useState(() => {
    try {
      return sessionStorage.getItem(STORE + ".seen") === "1";
    } catch {
      return true;
    }
  });
  return (
    <AnimatePresence>
      {!open && (
        <motion.button
          key="launcher"
          initial={{ opacity: 0, scale: 0.6, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.6, y: 20 }}
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.95 }}
          transition={SPRING}
          onClick={() => {
            setSeen(true);
            try {
              sessionStorage.setItem(STORE + ".seen", "1");
            } catch {
              /* storage unavailable */
            }
            onOpen();
          }}
          aria-label="Open the DAOGuard assistant (Ctrl+J)"
          title="Ask DAOGuard (Ctrl+J)"
          className={cx("fixed right-5 z-[55] flex h-14 cursor-pointer items-center gap-2 rounded-full bg-ink pl-4 pr-5 text-sm font-semibold text-white shadow-pop dark:bg-primary dark:text-ink", raised ? "bottom-20" : "bottom-5")}
        >
          {!seen && <span className="absolute inset-0 -z-10 animate-ping rounded-full bg-primary/40" />}
          <span className="relative flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-primary to-[#2F55E8]">
            <Sparkles className="h-4 w-4 text-white" />
          </span>
          Ask DAOGuard
        </motion.button>
      )}
    </AnimatePresence>
  );
}

function AssistantPanel({ open, onClose, pending, clearPending }: { open: boolean; onClose: () => void; pending: string | null; clearPending: () => void }) {
  const loc = useLocation();
  const navigate = useNavigate();
  const status = useQuery({ queryKey: ["assistant-status"], queryFn: () => api.get<{ mode: string; label: string; suggestions: string[]; local_llm?: { chat: boolean; chat_model: string | null } }>("/assistant/status"), staleTime: 60_000 });
  const [msgs, setMsgs] = useState<Msg[]>(loadHistory);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const ctx = pageContext(loc.pathname, loc.search);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORE, JSON.stringify(msgs.slice(-40)));
    } catch {
      /* storage unavailable */
    }
  }, [msgs]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [msgs, statusLine]);
  useEffect(() => {
    if (open) window.setTimeout(() => field.current?.focus(), 250);
  }, [open]);

  const send = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || busy) return;
      const user: Msg = { id: nextId++, role: "user", content: q };
      const reply: Msg = { id: nextId++, role: "assistant", content: "" };
      const history = [...msgs, user].filter((m) => !m.error && m.content).map((m) => ({ role: m.role, content: m.content }));
      setMsgs((m) => [...m, user, reply]);
      setInput("");
      setBusy(true);
      setStatusLine("Thinking…");
      setSuggestions([]);
      const ctrl = new AbortController();
      abort.current = ctrl;
      const patch = (fn: (r: Msg) => Msg) => setMsgs((m) => m.map((x) => (x.id === reply.id ? fn(x) : x)));
      try {
        const res = await fetch("/api/assistant/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: history.slice(-20), context: ctx }), signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`The assistant is unavailable (HTTP ${res.status}).`);
        await readSse(res, (event, data) => {
          if (event === "status") setStatusLine(data.text);
          else if (event === "delta") {
            setStatusLine(null);
            patch((r) => ({ ...r, content: r.content + data.text }));
          } else if (event === "meta") patch((r) => ({ ...r, mode: data.mode }));
          else if (event === "done") {
            patch((r) => ({ ...r, links: data.links, sources: data.sources, mode: data.mode, understanding: data.understanding }));
            setSuggestions(data.suggestions ?? []);
          } else if (event === "error") patch((r) => ({ ...r, content: r.content || data.message, error: true }));
        });
      } catch (e) {
        if ((e as Error).name !== "AbortError") patch((r) => ({ ...r, content: r.content || (e as Error).message, error: true }));
        else patch((r) => ({ ...r, content: r.content ? r.content + "\n\n_Stopped._" : "_Stopped._" }));
      } finally {
        setBusy(false);
        setStatusLine(null);
        abort.current = null;
      }
    },
    [busy, msgs, ctx],
  );

  useEffect(() => {
    if (open && pending) {
      clearPending();
      void send(pending);
    }
  }, [open, pending, clearPending, send]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
    if (e.key === "Escape") onClose();
  };
  const starter = suggestions.length ? suggestions : status.data?.suggestions ?? [];
  const offline = status.data?.mode !== "claude";

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          key="assistant"
          role="dialog"
          aria-label="DAOGuard assistant"
          initial={{ opacity: 0, x: 48, scale: 0.98 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: 48, scale: 0.98 }}
          transition={{ duration: 0.32, ease: EASE }}
          className="fixed bottom-3 right-3 top-[64px] z-[56] flex w-[min(440px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop"
        >
          {/* Header */}
          <header className="relative overflow-hidden border-b border-line px-4 py-3">
            <div className="pointer-events-none absolute -right-10 -top-16 h-40 w-40 rounded-full bg-primary/15 blur-3xl" />
            <div className="pointer-events-none absolute -left-10 -top-20 h-40 w-40 rounded-full bg-[#2F55E8]/10 blur-3xl" />
            <div className="relative flex items-center gap-3">
              <span className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-[#2F55E8] text-white shadow-sm">
                <Bot className="h-[18px] w-[18px]" />
                <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-primary" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-fg">DAOGuard Assistant</p>
                <p className="truncate text-2xs text-muted" title={status.data?.label}>
                  {status.data?.label ?? "Connecting…"}
                </p>
              </div>
              {msgs.length > 0 && (
                <button onClick={() => { abort.current?.abort(); setMsgs([]); setSuggestions([]); }} className="cursor-pointer rounded-lg p-1.5 text-muted hover:bg-subtle hover:text-fg" aria-label="Clear conversation" title="Clear conversation">
                  <Eraser className="h-4 w-4" />
                </button>
              )}
              <button onClick={onClose} className="cursor-pointer rounded-lg p-1.5 text-muted hover:bg-subtle hover:text-fg" aria-label="Close assistant (Esc)" title="Close (Esc)">
                <X className="h-4 w-4" />
              </button>
            </div>
          </header>

          {/* Conversation */}
          <div ref={scroller} className="flex-1 space-y-4 overflow-y-auto px-4 py-4 scroll-thin" aria-live="polite">
            {msgs.length === 0 && <Welcome offline={offline} label={status.data?.label} llm={!!status.data?.local_llm?.chat} suggestions={starter} onPick={(q) => void send(q)} />}
            {msgs.map((m) => (
              <Bubble key={m.id} m={m} streaming={busy && m.id === msgs[msgs.length - 1]?.id} onNavigate={(to) => navigate(to)} />
            ))}
            {busy && statusLine && (
              <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2 pl-10 text-xs text-muted">
                <Database className="h-3.5 w-3.5 text-primary" />
                <span>{statusLine}</span>
                <span className="flex gap-0.5">
                  {[0, 1, 2].map((d) => (
                    <motion.span key={d} className="h-1 w-1 rounded-full bg-primary" animate={{ opacity: [0.2, 1, 0.2] }} transition={{ duration: 1, repeat: Infinity, delay: d * 0.15 }} />
                  ))}
                </span>
              </motion.div>
            )}
            {!busy && msgs.length > 0 && suggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pl-10">
                {suggestions.slice(0, 3).map((s) => (
                  <button key={s} onClick={() => void send(s)} className="cursor-pointer rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-fg transition-colors hover:border-primary/50 hover:bg-primary/[0.06]">
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="border-t border-line bg-subtle/40 p-3">
            <div className="flex items-end gap-2 rounded-xl border border-line bg-surface p-1.5 shadow-sm focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
              <textarea
                ref={field}
                rows={1}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(140, e.target.scrollHeight)}px`;
                }}
                onKeyDown={onKey}
                placeholder="Ask about proposals, risks, treasury, execution…"
                aria-label="Message the assistant"
                className="max-h-[140px] min-h-[36px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-fg placeholder:text-faint focus:outline-none"
              />
              {busy ? (
                <button onClick={() => abort.current?.abort()} className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-fg text-surface" aria-label="Stop generating">
                  <Square className="h-3.5 w-3.5" fill="currentColor" />
                </button>
              ) : (
                <button onClick={() => void send(input)} disabled={!input.trim()} className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-primary text-white transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-40" aria-label="Send">
                  <ArrowUp className="h-4 w-4" />
                </button>
              )}
            </div>
            <p className="mt-1.5 text-center text-[10.5px] text-faint">Reads live demo data only · never votes, executes or halts · Enter to send, Shift+Enter for a new line</p>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function Welcome({ offline, label, llm, suggestions, onPick }: { offline: boolean; label?: string; llm: boolean; suggestions: string[]; onPick: (q: string) => void }) {
  const caps = [
    ["Proposals", "summaries, gaps and contradictions"],
    ["Risk", "the evaluation chain, factor by factor"],
    ["Execution", "guard status, simulations, attacks"],
    ["Treasury", "runway and overrun scenarios"],
  ];
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: EASE }} className="space-y-4">
      <div className="relative overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-ink to-[#1d2a3a] p-4 text-white">
        <motion.div className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-primary/40 blur-2xl" animate={{ scale: [1, 1.15, 1], opacity: [0.6, 0.9, 0.6] }} transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }} />
        <Sparkles className="relative h-5 w-5 text-[#5fe0c4]" />
        <p className="relative mt-2 text-[17px] font-semibold leading-snug">Ask anything about Atlas DAO's proposals.</p>
        <p className="relative mt-1 text-xs text-white/70">I read the live chain, the findings and the audit ledger, and I know every page of DAOGuard.</p>
        <div className="relative mt-3 grid grid-cols-2 gap-1.5">
          {caps.map(([t, d]) => (
            <div key={t} className="rounded-lg bg-white/[0.07] px-2.5 py-1.5">
              <p className="text-xs font-semibold">{t}</p>
              <p className="text-[10.5px] leading-tight text-white/60">{d}</p>
            </div>
          ))}
        </div>
      </div>
      <div>
        <p className="label mb-2">Try asking</p>
        <div className="grid gap-1.5">
          {suggestions.map((s, i) => (
            <motion.button
              key={s}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.08 + i * 0.05, duration: 0.3, ease: EASE }}
              onClick={() => onPick(s)}
              className="group flex cursor-pointer items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-left text-sm text-fg transition-colors hover:border-primary/50 hover:bg-primary/[0.05]"
            >
              {s}
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
            </motion.button>
          ))}
        </div>
      </div>
      {offline && (
        <div className="flex gap-2.5 rounded-lg border border-line bg-subtle/40 px-3 py-2.5 text-[11px] text-muted">
          <Cpu className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p>
            <span className="font-semibold text-fg">Runs on this computer.</span> {label ?? "Local engine"}. Nothing you type leaves your machine.
            {!llm && <> Start Ollama with <code className="font-mono">qwen2.5:3b</code> for open-ended answers.</>} Short questions work: I use this page and our conversation for context.
          </p>
        </div>
      )}
    </motion.div>
  );
}

function Bubble({ m, streaming, onNavigate }: { m: Msg; streaming: boolean; onNavigate: (to: string) => void }) {
  const [copied, setCopied] = useState(false);
  if (m.role === "user") {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: EASE }} className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-ink px-3.5 py-2 text-sm text-white dark:bg-primary dark:text-ink">{m.content}</p>
      </motion.div>
    );
  }
  if (!m.content && streaming) return null;
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: EASE }} className="group flex gap-2.5">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-[#2F55E8] text-white">
        <Bot className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className={cx("rounded-2xl rounded-tl-md border px-3.5 py-2.5", m.error ? "border-danger/30 bg-danger/[0.05]" : "border-line bg-subtle/50")}>
          <Markdown text={m.content} onNavigate={() => undefined} />
          {streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse2 rounded-sm bg-primary" />}
        </div>
        {!streaming && m.understanding && m.understanding.label && (
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-faint" title="How the local engine read your question">
            {m.understanding.engine === "local-llm" ? <Cpu className="h-3 w-3" /> : m.understanding.engine === "guide" ? <BookOpen className="h-3 w-3" /> : <Database className="h-3 w-3" />}
            <span>Understood as <span className="font-semibold text-muted">{m.understanding.label}</span></span>
            {m.understanding.proposal && <span>· {m.understanding.proposal}{m.understanding.proposal_from && m.understanding.proposal_from !== "message" ? ` (from ${m.understanding.proposal_from === "page" ? "this page" : "our conversation"})` : ""}</span>}
            <span className="rounded bg-subtle px-1 font-mono">{Math.round(m.understanding.confidence * 100)}%</span>
          </p>
        )}
        {!streaming && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {(m.links ?? []).slice(0, 3).map((l) => (
              <button key={l.to + l.label} onClick={() => onNavigate(l.to)} className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-primary/30 bg-primary/[0.06] px-2.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/[0.12]">
                {l.label} <ArrowRight className="h-3 w-3" />
              </button>
            ))}
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(m.content);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              }}
              className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-faint opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
              aria-label="Copy answer"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} {copied ? "Copied" : "Copy"}
            </button>
            {m.sources && m.sources.length > 0 && (
              <span className="text-[10.5px] text-faint" title={m.sources.join(", ")}>
                {m.mode === "claude" ? "Claude" : m.understanding?.engine === "local-llm" ? "Local LLM" : m.understanding?.engine === "guide" ? "Product guide" : "Live data"} · {m.sources.length} source{m.sources.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

/** Top-bar entry point. */
export function AssistantButton() {
  const { setOpen } = useAssistant();
  return (
    <button onClick={() => setOpen(true)} className="hidden h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-xs font-medium text-fg transition-colors hover:border-primary/50 hover:bg-primary/[0.05] lg:inline-flex" title="Ask DAOGuard (Ctrl+J)">
      <Sparkles className="h-3.5 w-3.5 text-primary" /> Ask AI <kbd className="kbd ml-0.5 py-0 text-[10px]">Ctrl J</kbd>
    </button>
  );
}

