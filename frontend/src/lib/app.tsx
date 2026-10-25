/* App-wide state: theme, acting persona, selected proposal, toasts and inspector drawers. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { setActor } from "./api";

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable: preferences just won't persist */
    }
  },
};

type Theme = "light" | "dark";
export type ToastTone = "success" | "error" | "warning" | "info";
export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
}
export type Inspector =
  | { kind: "tx"; value: string }
  | { kind: "address"; value: string }
  | { kind: "evidence"; proposalId: string; docId: string; quote?: string; page?: number }
  | null;

interface AppState {
  theme: Theme;
  toggleTheme: () => void;
  persona: string;
  setPersona: (name: string) => void;
  toasts: Toast[];
  toast: (tone: ToastTone, title: string, body?: string) => void;
  dismissToast: (id: number) => void;
  inspector: Inspector;
  inspect: (i: Inspector) => void;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => (store.get("daoguard.theme") === "dark" ? "dark" : "light"));
  const [persona, setPersonaState] = useState<string>(() => store.get("daoguard.persona") || "Demo reviewer");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [inspector, inspect] = useState<Inspector>(null);
  const nextId = useRef(1);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    store.set("daoguard.theme", theme);
  }, [theme]);

  useEffect(() => {
    setActor(persona);
    store.set("daoguard.persona", persona);
  }, [persona]);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (tone: ToastTone, title: string, body?: string) => {
      const id = nextId.current++;
      setToasts((t) => [...t.slice(-3), { id, tone, title, body }]);
      window.setTimeout(() => dismissToast(id), tone === "error" ? 9000 : 5500);
    },
    [dismissToast],
  );

  const value = useMemo<AppState>(
    () => ({
      theme,
      toggleTheme: () => setTheme((t) => (t === "light" ? "dark" : "light")),
      persona,
      setPersona: (n: string) => setPersonaState(n.trim() || "Demo reviewer"),
      toasts,
      toast,
      dismissToast,
      inspector,
      inspect,
    }),
    [theme, persona, toasts, toast, dismissToast, inspector],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppProvider");
  return ctx;
}

/** Selected proposal, shared across pages through the ?p= URL parameter (falls back to last used). */
export function useSelectedProposal(fallback?: string): [string | undefined, (id: string) => void] {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get("p") || undefined;
  const remembered = store.get("daoguard.proposal") || undefined;
  const current = fromUrl || remembered || fallback;
  useEffect(() => {
    if (fromUrl) store.set("daoguard.proposal", fromUrl);
  }, [fromUrl]);
  const set = useCallback(
    (id: string) => {
      store.set("daoguard.proposal", id);
      const next = new URLSearchParams(params);
      next.set("p", id);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );
  return [current, set];
}
