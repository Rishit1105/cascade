import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { EASE, SPRING } from "../lib/motion";
import { useApp } from "../lib/app";
import { cx } from "../lib/format";
import { Button, IconButton } from "./ui";

function useEscape(onClose: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose, active]);
}

export function Modal({ open, onClose, title, subtitle, children, footer, width = "max-w-lg" }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }) {
  useEscape(onClose, open);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>("input,textarea,select,button")?.focus();
  }, [open]);
  return (
    <AnimatePresence>
      {open && (
    <motion.div key="modal" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" onMouseDown={onClose}>
      <motion.div
        ref={ref}
        role="dialog"
        aria-modal="true"
        initial={{ opacity: 0, y: 18, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.98 }}
        transition={{ duration: 0.24, ease: EASE }}
        className={cx("panel max-h-[92vh] w-full overflow-hidden shadow-pop sm:rounded-xl", width)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="max-h-[66vh] overflow-y-auto px-5 py-4 scroll-thin">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line bg-subtle/50 px-5 py-3">{footer}</div>}
      </motion.div>
    </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Drawer({ open, onClose, title, subtitle, children, actions, width = "sm:w-[460px]" }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; actions?: ReactNode; width?: string }) {
  useEscape(onClose, open);
  return (
    <AnimatePresence>
      {open && (
    <motion.div key="drawer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="fixed inset-0 z-40 flex justify-end bg-ink/25" onMouseDown={onClose}>
      <motion.aside
        role="dialog"
        aria-modal="true"
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        transition={{ duration: 0.28, ease: EASE }}
        className={cx("mt-auto flex max-h-[88vh] w-full flex-col rounded-t-2xl border-l border-line bg-surface shadow-pop sm:mt-0 sm:h-full sm:max-h-none sm:rounded-none", width)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold text-fg">{title}</h2>
            {subtitle && <div className="mt-0.5 text-xs text-muted">{subtitle}</div>}
          </div>
          <IconButton label="Close panel" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 scroll-thin">{children}</div>
        {actions && <div className="flex flex-wrap gap-2 border-t border-line px-5 py-3">{actions}</div>}
      </motion.aside>
    </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Consequential action: optional typed confirmation phrase plus a required written reason. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  phrase,
  reasonLabel,
  danger,
  loading,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string, phrase: string) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  phrase?: string;
  reasonLabel?: string;
  danger?: boolean;
  loading?: boolean;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) {
      setTyped("");
      setReason("");
    }
  }, [open]);
  const ready = (!phrase || typed.trim() === phrase) && (!reasonLabel || reason.trim().length >= 8);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} disabled={!ready} loading={loading} onClick={() => onConfirm(reason.trim(), typed.trim())}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="text-muted">{description}</div>
        {children}
        {reasonLabel && (
          <label className="block">
            <span className="mb-1 block text-xs font-medium">{reasonLabel}</span>
            <textarea className="textarea min-h-[72px]" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="At least 8 characters. Recorded in the audit ledger." />
          </label>
        )}
        {phrase && (
          <label className="block">
            <span className="mb-1 block text-xs font-medium">
              Type <span className="kbd">{phrase}</span> to confirm
            </span>
            <input className="input font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </label>
        )}
      </div>
    </Modal>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="pointer-events-none fixed bottom-24 right-5 z-[60] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
      <AnimatePresence initial={false}>
      {toasts.map((t) => {
        const icon =
          t.tone === "success" ? <CheckCircle2 className="h-4 w-4 text-primary" /> : t.tone === "error" ? <XCircle className="h-4 w-4 text-danger" /> : t.tone === "warning" ? <AlertTriangle className="h-4 w-4 text-warning" /> : <Info className="h-4 w-4 text-info" />;
        return (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, x: 32, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 32, scale: 0.96, transition: { duration: 0.16 } }}
            transition={SPRING}
            className={cx("pointer-events-auto panel relative flex items-start gap-2.5 overflow-hidden p-3 shadow-pop", t.tone === "success" ? "accent-primary" : t.tone === "error" ? "accent-danger" : t.tone === "warning" ? "accent-warning" : "accent-info")}
          >
            <span className="mt-0.5">{icon}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold capitalize-first text-fg">{t.title}</p>
              {t.body && <p className="mt-0.5 break-words text-xs text-muted">{t.body}</p>}
            </div>
            <button aria-label="Dismiss" onClick={() => dismissToast(t.id)} className="cursor-pointer text-faint hover:text-fg">
              <X className="h-3.5 w-3.5" />
            </button>
          </motion.div>
        );
      })}
      </AnimatePresence>
    </div>
  );
}
