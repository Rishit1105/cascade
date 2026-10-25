import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { AlertTriangle, Check, CheckCircle2, CircleDashed, Copy, Info, Loader2, OctagonX, ShieldAlert, XCircle } from "lucide-react";
import { cx, shortAddr, shortHash } from "../lib/format";
import { useApp } from "../lib/app";
import type { Severity } from "../lib/api";

/* ------------------------------------------------------------------ buttons */
type Variant = "primary" | "secondary" | "ghost" | "danger" | "dark" | "outline-danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-primary text-white hover:bg-primary/90 border border-primary shadow-sm",
  secondary: "bg-surface text-fg border border-line hover:bg-subtle hover:border-line-strong shadow-sm",
  ghost: "text-muted hover:text-fg hover:bg-subtle border border-transparent",
  danger: "bg-danger text-white hover:bg-danger/90 border border-danger shadow-sm",
  dark: "bg-ink text-white hover:bg-ink/90 border border-ink shadow-sm dark:bg-fg dark:text-ink dark:border-fg",
  "outline-danger": "bg-surface text-danger border border-danger/40 hover:bg-danger/5",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  icon,
  children,
  className,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm",
        VARIANTS[variant],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx("inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-subtle hover:text-fg", className)}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ badges */
type Tone = "success" | "warning" | "danger" | "info" | "neutral" | "dark";
const TONES: Record<Tone, string> = {
  success: "bg-primary/10 text-primary border-primary/20",
  warning: "bg-warning/12 text-warning border-warning/25",
  danger: "bg-danger/10 text-danger border-danger/25",
  info: "bg-info/10 text-info border-info/20",
  neutral: "bg-subtle text-muted border-line",
  dark: "bg-ink text-white border-ink",
};

export function Badge({ tone = "neutral", children, icon, className, title }: { tone?: Tone; children: ReactNode; icon?: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-[1px] text-2xs font-semibold", TONES[tone], className)}>
      {icon}
      {children}
    </span>
  );
}

const SEV_TONE: Record<string, Tone> = { critical: "danger", high: "danger", medium: "warning", low: "info", info: "neutral" };
export function SeverityBadge({ severity }: { severity: Severity | string }) {
  const icon =
    severity === "critical" ? <OctagonX className="h-3 w-3" /> : severity === "high" ? <ShieldAlert className="h-3 w-3" /> : severity === "medium" ? <AlertTriangle className="h-3 w-3" /> : <Info className="h-3 w-3" />;
  return (
    <Badge tone={SEV_TONE[severity] ?? "neutral"} icon={icon} className={severity === "critical" ? "!bg-danger !text-white !border-danger" : ""}>
      {String(severity).toUpperCase()}
    </Badge>
  );
}

const CONF: Record<string, { tone: Tone; label: string; hint: string }> = {
  verified: { tone: "success", label: "Verified", hint: "Checked against chain data, signatures or the supplied material." },
  "source-supported": { tone: "info", label: "Source-supported", hint: "Backed by a quoted source; the source itself is not independently verified." },
  heuristic: { tone: "warning", label: "Heuristic", hint: "A pattern that warrants review. Not a finding of fact." },
  unverified: { tone: "neutral", label: "Unverified", hint: "No supporting evidence was found." },
};
export function ConfidenceBadge({ confidence }: { confidence: string }) {
  const c = CONF[confidence] ?? { tone: "neutral" as Tone, label: confidence, hint: "" };
  return (
    <Badge tone={c.tone} title={c.hint}>
      {c.label}
    </Badge>
  );
}

const LEVEL: Record<string, { tone: Tone; label: string }> = {
  verified_observation: { tone: "success", label: "Observed on-chain" },
  disclosed: { tone: "info", label: "Self-disclosed" },
  record: { tone: "neutral", label: "DAOGuard record" },
  unverified_lead: { tone: "warning", label: "Unverified lead" },
};
export function EvidenceLevelBadge({ level }: { level: string }) {
  const l = LEVEL[level] ?? { tone: "neutral" as Tone, label: level };
  return <Badge tone={l.tone}>{l.label}</Badge>;
}

export function VerificationBadge({ value }: { value: string }) {
  if (value === "chain-confirmed") return <Badge tone="success" icon={<CheckCircle2 className="h-3 w-3" />}>Chain-confirmed</Badge>;
  return <Badge tone="neutral" icon={<CircleDashed className="h-3 w-3" />}>Off-chain record</Badge>;
}

const STATUS_TONE: Record<string, Tone> = {
  draft: "neutral", in_review: "info", committed: "info", voting: "warning", approved: "success", executed: "dark", halted: "danger", defeated: "neutral",
  open: "warning", challenged: "info", resolved: "success", dismissed: "neutral", superseded: "neutral",
  new: "danger", triaged: "warning", escalated: "danger",
  MATCH: "success", MISMATCH: "danger", UNKNOWN: "neutral",
  pass: "success", flag: "warning", block: "danger", error: "neutral",
  executed_attempt: "success", rejected: "danger", not_sent: "warning",
  none: "neutral",
  pending: "warning", completed: "success", overdue: "danger", disputed: "danger",
};
const STATUS_TEXT: Record<string, string> = {
  in_review: "In review", not_submitted: "Not submitted", not_sent: "Not sent", pass: "PASS", flag: "FLAG", block: "BLOCK",
};
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const icon =
    ["approved", "MATCH", "pass", "resolved", "completed"].includes(status) ? <Check className="h-3 w-3" /> : ["halted", "MISMATCH", "block", "rejected"].includes(status) ? <XCircle className="h-3 w-3" /> : null;
  return (
    <Badge tone={STATUS_TONE[status] ?? "neutral"} icon={icon} className={className}>
      {STATUS_TEXT[status] ?? status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())}
    </Badge>
  );
}

export function DemoBadge({ label = "Demo data" }: { label?: string }) {
  return (
    <span title="Fictional entities on a local development chain. No real funds." className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-2xs font-semibold text-warning">
      <span className="h-1.5 w-1.5 rounded-full bg-warning" />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ layout bits */
export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
  icon,
  dark,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  icon?: ReactNode;
  dark?: boolean;
}) {
  return (
    <section className={cx(dark ? "rounded-xl border border-ink bg-ink text-white shadow-card dark:border-line" : "panel", "flex min-w-0 flex-col", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-4 pb-2.5 pt-3.5">
          <div className="min-w-0 flex-1 basis-[220px]">
            <h2 className={cx("flex items-center gap-2 text-[13.5px] font-semibold", dark ? "text-white" : "text-fg")}>
              {icon}
              {title}
            </h2>
            {subtitle && <p className={cx("mt-0.5 text-xs", dark ? "text-white/60" : "text-muted")}>{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={cx("min-h-0 flex-1 px-4 pb-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold tracking-[-0.01em] text-fg">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: Array<{ id: T; label: ReactNode; count?: number }>; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div role="tablist" className={cx("flex items-center gap-1 overflow-x-auto overflow-y-hidden border-b border-line scroll-thin", className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            "relative -mb-px inline-flex h-9 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors",
            value === t.id ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg",
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="rounded-full bg-subtle px-1.5 text-2xs font-semibold text-muted">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange, size = "md" }: { options: Array<{ id: T; label: ReactNode }>; value: T; onChange: (v: T) => void; size?: "sm" | "md" }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-subtle p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={cx(
            "rounded-md px-2.5 font-medium transition-colors",
            size === "sm" ? "h-6 text-xs" : "h-7 text-sm",
            value === o.id ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function MetricCard({ label, value, sub, icon, tone, footer }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode; tone?: "danger" | "warning" | "success"; footer?: ReactNode }) {
  return (
    <div className="panel flex flex-col justify-between p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-muted">{label}</span>
        {icon && <span className={cx("text-faint", tone === "danger" && "text-danger", tone === "warning" && "text-warning", tone === "success" && "text-primary")}>{icon}</span>}
      </div>
      <div className="mt-2 text-[24px] font-semibold leading-tight tracking-[-0.02em] text-fg">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
      {footer && <div className="mt-3 border-t border-line pt-2.5">{footer}</div>}
    </div>
  );
}

export function KeyValue({ rows, className }: { rows: Array<[ReactNode, ReactNode]>; className?: string }) {
  return (
    <dl className={cx("divide-y divide-line", className)}>
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-start justify-between gap-4 py-1.5 text-sm">
          <dt className="shrink-0 text-muted">{k}</dt>
          <dd className="min-w-0 text-right font-medium text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon && <div className="rounded-xl border border-line bg-subtle p-2.5 text-muted">{icon}</div>}
      <p className="text-sm font-semibold text-fg">{title}</p>
      {body && <p className="max-w-sm text-xs text-muted">{body}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger/5 p-3 text-sm">
      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-danger">Could not load this data</p>
        <p className="mt-0.5 break-words text-xs text-muted">{msg}</p>
      </div>
      {retry && (
        <Button size="sm" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse2 rounded-md bg-subtle", className)} />;
}

export function LoadingBlock({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2.5 py-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={cx("h-4", i % 3 === 2 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

export function Callout({ tone = "info", title, children, icon }: { tone?: "info" | "warning" | "danger" | "success"; title?: ReactNode; children: ReactNode; icon?: ReactNode }) {
  const style = { info: "border-info/25 bg-info/5", warning: "border-warning/30 bg-warning/8", danger: "border-danger/25 bg-danger/5", success: "border-primary/25 bg-primary/5" }[tone];
  const color = { info: "text-info", warning: "text-warning", danger: "text-danger", success: "text-primary" }[tone];
  return (
    <div className={cx("flex gap-2.5 rounded-lg border p-3 text-sm", style)}>
      <span className={cx("mt-0.5 shrink-0", color)}>{icon ?? <Info className="h-4 w-4" />}</span>
      <div className="min-w-0">
        {title && <p className={cx("font-semibold", color)}>{title}</p>}
        <div className="text-xs leading-relaxed text-muted">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ chain identifiers */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={`${label}: ${value}`}
      title={done ? "Copied" : label}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1200);
        });
      }}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint hover:bg-subtle hover:text-fg"
    >
      {done ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

export function Hash({ value, head = 10, tail = 6, className, copy = true }: { value?: string | null; head?: number; tail?: number; className?: string; copy?: boolean }) {
  if (!value) return <span className="text-faint">—</span>;
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-0.5 font-mono text-xs", className)} title={value}>
      <span className="truncate">{shortHash(value, head, tail)}</span>
      {copy && <CopyButton value={value} />}
    </span>
  );
}

export function TxLink({ hash, block }: { hash?: string | null; block?: number | null }) {
  const { inspect } = useApp();
  if (!hash) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <button onClick={() => inspect({ kind: "tx", value: hash })} className="font-mono text-xs text-info hover:underline" title={`Open transaction ${hash}`}>
        {shortHash(hash, 8, 4)}
      </button>
      <CopyButton value={hash} />
      {block !== undefined && block !== null && <span className="text-2xs text-faint">#{block}</span>}
    </span>
  );
}

export function AddressChip({ address, label, compact }: { address?: string | null; label?: string | null; compact?: boolean }) {
  const { inspect } = useApp();
  if (!address) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <button onClick={() => inspect({ kind: "address", value: address })} className="inline-flex min-w-0 items-center gap-1.5 text-left hover:underline" title={address}>
        {label && !compact && <span className="truncate text-sm font-medium text-fg">{label}</span>}
        <span className="font-mono text-xs text-muted">{shortAddr(address)}</span>
      </button>
      <CopyButton value={address} />
    </span>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors", checked ? "bg-primary" : "bg-line-strong")}
    >
      <span className={cx("inline-block h-4 w-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
    </button>
  );
}

export function Field({ label, hint, children, error }: { label: string; hint?: ReactNode; children: ReactNode; error?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-fg">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-2xs text-muted">{hint}</span>}
      {error && <span className="mt-1 block text-2xs text-danger">{error}</span>}
    </label>
  );
}

export function ProgressBar({ value, tone = "primary" }: { value: number; tone?: "primary" | "warning" | "danger" }) {
  const color = { primary: "bg-primary", warning: "bg-warning", danger: "bg-danger" }[tone];
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-subtle">
      <div className={cx("h-full rounded-full transition-all", color)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}
