import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  Bell, Blocks, BookOpenCheck, Compass, FileText, GitCompareArrows, Landmark, LayoutDashboard, Loader2, Menu, Moon, Network, Radar,
  ScrollText, Search, Settings, ShieldCheck, Siren, Sun, Vote, X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { cx, timeAgo } from "../lib/format";
import { useAction, useHealth, useNotifications, useSystemStatus } from "../lib/queries";
import { DemoBadge, IconButton } from "./ui";
import { LiveIndicator, SentinelActivity } from "./SentinelActivity";
import { useTour } from "../lib/tour";

export const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/proposals", label: "Proposals", icon: FileText },
  { to: "/relationships", label: "Relationships", icon: Network },
  { to: "/versions", label: "Version history", icon: GitCompareArrows },
  { to: "/financial", label: "Financial impact", icon: Landmark },
  { to: "/voting", label: "Voting & delegates", icon: Vote },
  { to: "/guardian", label: "Execution guardian", icon: ShieldCheck },
  { to: "/audit", label: "Audit timeline", icon: ScrollText },
  { to: "/escalation", label: "Risk escalation", icon: Siren },
  { to: "/reports", label: "Reports & export", icon: BookOpenCheck },
];

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-white shadow-sm">
        <ShieldCheck className="h-[18px] w-[18px]" strokeWidth={2.2} />
      </span>
      {!compact && (
        <span className="leading-none">
          <span className="block text-[14px] font-bold tracking-[0.04em] text-fg">DAOGUARD</span>
          <span className="mt-0.5 block text-2xs font-medium uppercase tracking-[0.12em] text-muted">DAO Audit Engine</span>
        </span>
      )}
    </div>
  );
}

function Rail() {
  return (
    <nav aria-label="Primary" className="hidden w-[64px] shrink-0 flex-col items-center border-r border-line bg-surface py-3 md:flex">
      <div className="mb-4">
        <Logo compact />
      </div>
      <div className="flex flex-1 flex-col items-center gap-1">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              cx("group relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors", isActive ? "bg-ink text-white dark:bg-primary" : "text-muted hover:bg-subtle hover:text-fg")
            }
            aria-label={n.label}
          >
            <n.icon className="h-[18px] w-[18px]" />
            <span className="pointer-events-none absolute left-[52px] z-50 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-xs font-medium text-white opacity-0 shadow-pop transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              {n.label}
            </span>
          </NavLink>
        ))}
      </div>
      <NavLink
        to="/settings"
        className={({ isActive }) => cx("group relative flex h-10 w-10 items-center justify-center rounded-xl", isActive ? "bg-ink text-white dark:bg-primary" : "text-muted hover:bg-subtle hover:text-fg")}
        aria-label="Settings"
      >
        <Settings className="h-[18px] w-[18px]" />
        <span className="pointer-events-none absolute left-[52px] z-50 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-xs font-medium text-white opacity-0 shadow-pop group-hover:opacity-100">Settings</span>
      </NavLink>
    </nav>
  );
}

function MobileNav({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-ink/40 md:hidden" onClick={onClose}>
      <nav className="h-full w-[260px] bg-surface p-4 shadow-pop animate-slide-in" onClick={(e) => e.stopPropagation()}>
        <div className="mb-5 flex items-center justify-between">
          <Logo />
          <IconButton label="Close menu" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        {[...NAV, { to: "/settings", label: "Settings", icon: Settings, end: false }].map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} onClick={onClose} className={({ isActive }) => cx("mb-0.5 flex items-center gap-3 rounded-lg px-3 py-2 text-sm", isActive ? "bg-subtle font-semibold text-fg" : "text-muted")}>
            <n.icon className="h-4 w-4" />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState("");
  const navigate = useNavigate();
  const { inspect } = useApp();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 220);
    return () => window.clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA")) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  const results = useQuery({ queryKey: ["search", debounced], queryFn: () => api.get<{ results: any[] }>(`/search?q=${encodeURIComponent(debounced)}`), enabled: debounced.length >= 2 });
  const go = (r: any) => {
    setOpen(false);
    setQ("");
    if (r.type === "transaction") inspect({ kind: "tx", value: r.id });
    else if (r.type === "address") inspect({ kind: "address", value: r.id });
    else navigate(r.link);
  };
  return (
    <div className="relative w-full max-w-[420px]">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
      <input
        ref={ref}
        className="input h-9 pl-8 pr-12"
        placeholder="Search proposals, addresses, tx hashes…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        aria-label="Global search"
      />
      <span className="kbd pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 sm:inline">Ctrl K</span>
      {open && debounced.length >= 2 && (
        <div className="panel absolute left-0 right-0 top-11 z-50 max-h-[360px] overflow-y-auto p-1 shadow-pop scroll-thin">
          {results.isLoading && <p className="px-3 py-2 text-xs text-muted">Searching…</p>}
          {results.data?.results.length === 0 && <p className="px-3 py-2 text-xs text-muted">No matches for “{debounced}”.</p>}
          {results.data?.results.map((r) => (
            <button key={`${r.type}-${r.id}`} onMouseDown={() => go(r)} className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-subtle">
              <span className="mt-0.5 rounded bg-subtle px-1.5 text-2xs font-semibold uppercase text-muted">{r.type}</span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-fg">{r.title}</span>
                <span className="block truncate text-2xs text-muted">{r.subtitle}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const n = useNotifications();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const markRead = useAction((ids?: string[]) => api.post("/notifications/read", { ids }), { invalidate: [["notifications"]], quiet: true });
  const unread = n.data?.unread ?? 0;
  return (
    <div className="relative">
      <IconButton label={`Notifications (${unread} unread)`} onClick={() => setOpen((o) => !o)} className="relative">
        <Bell className="h-[17px] w-[17px]" />
        {unread > 0 && <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-bold text-white">{unread}</span>}
      </IconButton>
      {open && (
        <div className="panel absolute right-0 top-10 z-50 w-[380px] max-w-[calc(100vw-2rem)] shadow-pop" onMouseLeave={() => setOpen(false)}>
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <p className="text-sm font-semibold">Notifications</p>
            <button className="text-xs font-medium text-primary hover:underline" onClick={() => markRead.mutate(undefined)}>
              Mark all read
            </button>
          </div>
          <div className="max-h-[420px] overflow-y-auto scroll-thin">
            {(n.data?.items ?? []).length === 0 && <p className="px-4 py-6 text-center text-xs text-muted">No notifications yet.</p>}
            {(n.data?.items ?? []).map((item: any) => (
              <button
                key={item.id}
                onClick={() => {
                  markRead.mutate([item.id]);
                  setOpen(false);
                  if (item.link) navigate(item.link);
                }}
                className={cx("flex w-full gap-2.5 border-b border-line px-4 py-2.5 text-left last:border-0 hover:bg-subtle", !item.read && "bg-primary/[0.03]")}
              >
                <span className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", { critical: "bg-danger", warning: "bg-warning", success: "bg-primary", info: "bg-info" }[item.level as string] ?? "bg-faint")} />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-fg">{item.title}</span>
                  {item.body && <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{item.body}</span>}
                  <span className="mt-0.5 block text-2xs text-faint">
                    {timeAgo(item.created_at)} · {item.audience}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ChainStatus() {
  const h = useHealth();
  const s = useSystemStatus();
  const [open, setOpen] = useState(false);
  const connected = h.data?.chain.connected;
  const sentinel = s.data?.sentinel;
  return (
    <div className="relative hidden xl:block">
      <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs" title="Local Hardhat demo chain">
        <span className="flex items-center gap-1.5">
          <span className={cx("h-2 w-2 rounded-full", connected ? "bg-primary" : "bg-danger")} />
          <Blocks className="h-3.5 w-3.5 text-muted" />
          <span className="font-medium text-fg">{connected ? `#${h.data?.chain.block}` : "offline"}</span>
          <span className="text-faint">· chain {h.data?.chain.chain_id ?? "—"}</span>
        </span>
        <span className="h-4 w-px bg-line" />
        <button
          className="flex items-center gap-1.5 rounded hover:text-fg"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title={sentinel?.last_error ?? "Sentinel watches ManifestApproved events and simulates every approval. Click for live activity."}
        >
          <Radar className={cx("h-3.5 w-3.5", sentinel?.running ? "text-primary" : "text-faint")} />
          <span className="text-muted">Sentinel {sentinel?.running ? "watching" : "off"}</span>
        </button>
        <span className="h-4 w-px bg-line" />
        <LiveIndicator />
      </div>
      {open && (
        <div className="panel absolute right-0 top-10 z-50 w-[440px] max-w-[calc(100vw-2rem)] shadow-pop">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <p className="text-sm font-semibold">Sentinel activity</p>
            <button className="text-xs font-medium text-muted hover:text-fg" onClick={() => setOpen(false)}>Close</button>
          </div>
          <div className="max-h-[460px] overflow-y-auto p-3 scroll-thin">
            <SentinelActivity limit={8} />
          </div>
        </div>
      )}
    </div>
  );
}

function Persona() {
  const { persona, setPersona } = useApp();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(persona);
  const initials = persona.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className="relative">
      <button onClick={() => { setDraft(persona); setOpen((o) => !o); }} className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary" aria-label={`Acting as ${persona}`} title={`Acting as ${persona}`}>
        {initials}
      </button>
      {open && (
        <div className="panel absolute right-0 top-10 z-50 w-[280px] p-3 shadow-pop">
          <p className="text-xs font-semibold">Acting as</p>
          <p className="mb-2 text-2xs text-muted">Your name is recorded on every audit event you create. There is no login in this demo.</p>
          <input className="input" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { setPersona(draft); setOpen(false); } }} />
          <div className="mt-2 flex justify-end gap-2">
            <button className="text-xs text-muted" onClick={() => setOpen(false)}>Cancel</button>
            <button className="text-xs font-semibold text-primary" onClick={() => { setPersona(draft); setOpen(false); }}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Topbar({ onMenu }: { onMenu: () => void }) {
  const { theme, toggleTheme } = useApp();
  const tour = useTour();
  return (
    <header className="sticky top-0 z-30 flex h-[56px] items-center gap-3 border-b border-line bg-surface/95 px-3 backdrop-blur md:px-5">
      <IconButton label="Open menu" onClick={onMenu} className="md:hidden">
        <Menu className="h-5 w-5" />
      </IconButton>
      <div className="hidden shrink-0 items-center gap-3 md:flex">
        <Logo />
        <span className="hidden h-6 w-px bg-line xl:block" />
        <span className="hidden rounded-lg border border-line bg-subtle px-2 py-1 text-xs font-medium text-fg xl:inline">Atlas DAO · local devnet</span>
      </div>
      <div className="flex flex-1 justify-center px-2">
        <GlobalSearch />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <ChainStatus />
        <span className="hidden lg:inline-flex">
          <DemoBadge />
        </span>
        <IconButton label={tour.active ? "Guided tour (running)" : "Start the guided tour"} onClick={() => tour.start(tour.active ? tour.index : 0)} className={cx(tour.active && "text-primary")}>
          <Compass className="h-[17px] w-[17px]" />
        </IconButton>
        <Notifications />
        <IconButton label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"} onClick={toggleTheme}>
          {theme === "light" ? <Moon className="h-[17px] w-[17px]" /> : <Sun className="h-[17px] w-[17px]" />}
        </IconButton>
        <Persona />
      </div>
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [loc.pathname]);
  return (
    <div className="flex min-h-full">
      <Rail />
      <MobileNav open={menu} onClose={() => setMenu(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onMenu={() => setMenu(true)} />
        <main className="mx-auto w-full max-w-[1680px] flex-1 px-4 py-5 md:px-6">{children}</main>
      </div>
    </div>
  );
}

export function BootScreen({ phase, message, error }: { phase?: string; message?: string; error?: string | null }) {
  const reset = useAction(() => api.post("/system/reset", { confirm: "RESET" }), { success: "Rebuilding the demo environment", invalidate: [["health"]] });
  const steps = ["waiting_for_chain", "deploying", "seeding", "ready"];
  const idx = Math.max(0, steps.indexOf(phase ?? ""));
  return (
    <div className="flex min-h-full items-center justify-center bg-bg p-6">
      <div className="panel w-full max-w-[520px] p-7">
        <Logo />
        <h1 className="mt-6 text-lg font-semibold">{phase === "error" ? "The demo environment could not start" : "Preparing the demo environment"}</h1>
        <p className="mt-1 text-sm text-muted">DAOGuard deploys its contracts to a local Hardhat chain and lays down a 30-day governance history with real local transactions.</p>
        <ol className="mt-5 space-y-2.5">
          {["Connect to the local chain", "Deploy guard, governor, registry and FeeVault", "Seed proposals, votes and executions", "Ready"].map((label, i) => (
            <li key={label} className="flex items-center gap-2.5 text-sm">
              <span className={cx("flex h-5 w-5 items-center justify-center rounded-full border text-2xs font-bold", i < idx ? "border-primary bg-primary text-white" : i === idx && phase !== "error" ? "border-primary text-primary" : "border-line text-faint")}>
                {i === idx && phase !== "error" && phase !== "ready" ? <Loader2 className="h-3 w-3 animate-spin" /> : i + 1}
              </span>
              <span className={i <= idx ? "text-fg" : "text-muted"}>{label}</span>
            </li>
          ))}
        </ol>
        <p className="mt-5 rounded-lg bg-subtle px-3 py-2 font-mono text-xs text-muted">{message ?? "Starting…"}</p>
        {error && (
          <div className="mt-3 space-y-3">
            <p className="break-words rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 font-mono text-xs text-danger">{error}</p>
            <button className="text-sm font-semibold text-primary hover:underline" onClick={() => reset.mutate(undefined)}>
              Retry by resetting the demo chain
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
