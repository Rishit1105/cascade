/* React Query hooks for every resource plus a mutation helper with toasts and invalidation. */
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api, ApiError, qs, type Alert, type AuditEvent, type EvaluationChain, type ExecutionAttempt, type ExecutionCheck, type Finding, type GovernanceState, type GraphEdge, type GraphNode, type Health, type ProposalDetail, type ProposalItem, type Simulation } from "./api";
import { useApp, type ToastTone } from "./app";

export const useHealth = () =>
  useQuery({ queryKey: ["health"], queryFn: () => api.get<Health>("/health"), refetchInterval: (q) => (q.state.data?.state.phase === "ready" ? 8000 : 1500) });

export const useSystemStatus = () => useQuery({ queryKey: ["system"], queryFn: () => api.get<any>("/system/status"), refetchInterval: 6000 });

export const useProposals = (filters: Record<string, string | number | undefined> = {}) =>
  useQuery({ queryKey: ["proposals", filters], queryFn: () => api.get<{ items: ProposalItem[] }>(`/proposals${qs(filters)}`).then((r) => r.items) });

export const useProposal = (id?: string) =>
  useQuery({ queryKey: ["proposal", id], queryFn: () => api.get<ProposalDetail>(`/proposals/${id}`), enabled: !!id });

export const useGovernance = (id?: string, live = false) =>
  useQuery({ queryKey: ["governance", id], queryFn: () => api.get<GovernanceState>(`/proposals/${id}/governance`), enabled: !!id, refetchInterval: live ? 2500 : false });

export const useEvaluation = (id?: string) =>
  useQuery({ queryKey: ["evaluation", id], queryFn: () => api.get<EvaluationChain>(`/proposals/${id}/evaluation-chain`), enabled: !!id });

export const useOverview = () => useQuery({ queryKey: ["overview"], queryFn: () => api.get<any>("/overview"), refetchInterval: 10000 });

export const useGraph = () => useQuery({ queryKey: ["graph"], queryFn: () => api.get<{ nodes: GraphNode[]; edges: GraphEdge[]; legend: any; note: string; block_number: number; data_label: string }>("/graph") });

export const useConflicts = (id?: string) =>
  useQuery({ queryKey: ["conflicts", id], queryFn: () => api.get<any>(`/proposals/${id}/conflicts`), enabled: !!id });

export const useFindings = (id?: string) =>
  useQuery({ queryKey: ["findings", id], queryFn: () => api.get<{ items: Finding[] }>(`/proposals/${id}/findings`).then((r) => r.items), enabled: !!id });

export const useAuditEvents = (filters: Record<string, string | number | undefined>) =>
  useQuery({ queryKey: ["audit", filters], queryFn: () => api.get<{ items: AuditEvent[]; event_types: string[] }>(`/audit-events${qs(filters)}`), refetchInterval: 5000 });

export const useAlerts = (filters: Record<string, string | undefined> = {}) =>
  useQuery({ queryKey: ["alerts", filters], queryFn: () => api.get<{ items: Alert[]; reviewers: string[] }>(`/alerts${qs(filters)}`), refetchInterval: 6000 });

export const useNotifications = () =>
  useQuery({ queryKey: ["notifications"], queryFn: () => api.get<{ items: any[]; unread: number }>("/notifications"), refetchInterval: 4000 });

export const useScenarios = (id?: string) =>
  useQuery({ queryKey: ["scenarios", id], queryFn: () => api.get<{ items: Array<{ id: string; label: string; description: string; expect: string; basis: string; version: number }> }>(`/proposals/${id}/scenarios`).then((r) => r.items), enabled: !!id });

export const useChecks = (id?: string) =>
  useQuery({ queryKey: ["checks", id], queryFn: () => api.get<{ items: ExecutionCheck[] }>(`/proposals/${id}/execution-checks`).then((r) => r.items), enabled: !!id });

export const useAttempts = (id?: string) =>
  useQuery({ queryKey: ["attempts", id], queryFn: () => api.get<{ items: ExecutionAttempt[] }>(`/proposals/${id}/execution-attempts`).then((r) => r.items), enabled: !!id, refetchInterval: 5000 });

export const useSimulations = (id?: string) =>
  useQuery({ queryKey: ["simulations", id], queryFn: () => api.get<{ items: Simulation[] }>(`/proposals/${id}/simulations`).then((r) => r.items), enabled: !!id, refetchInterval: 4000 });

export const useSimulation = (sid?: string) =>
  useQuery({ queryKey: ["simulation", sid], queryFn: () => api.get<Simulation>(`/simulations/${sid}`), enabled: !!sid });

export const useManifest = (id?: string) => useQuery({ queryKey: ["manifest", id], queryFn: () => api.get<any>(`/proposals/${id}/manifest`), enabled: !!id });

export const useTreasury = (id: string | undefined, params: Record<string, string | number | undefined>) =>
  useQuery({ queryKey: ["treasury", id, params], queryFn: () => api.get<any>(`/proposals/${id}/treasury${qs(params)}`), enabled: !!id, placeholderData: (prev) => prev });

export const useDependencies = (id?: string) =>
  useQuery({ queryKey: ["dependencies", id], queryFn: () => api.get<{ items: any[] }>(`/proposals/${id}/dependencies`).then((r) => r.items), enabled: !!id });

export const useVoting = (proposal?: string) => useQuery({ queryKey: ["voting", proposal], queryFn: () => api.get<any>(`/voting${qs({ proposal })}`) });
export const useDelegates = () => useQuery({ queryKey: ["delegates"], queryFn: () => api.get<any>("/voting/delegates") });
export const useReports = () => useQuery({ queryKey: ["reports"], queryFn: () => api.get<{ items: any[]; sections: Record<string, string> }>("/reports") });
export const useSettings = () => useQuery({ queryKey: ["settings"], queryFn: () => api.get<any>("/settings") });
export const useTreasuryOverview = () => useQuery({ queryKey: ["treasury-overview"], queryFn: () => api.get<any>("/treasury") });
export const useVersionDiff = (id?: string, from?: number, to?: string) =>
  useQuery({ queryKey: ["diff", id, from, to], queryFn: () => api.get<any>(`/proposals/${id}/versions/diff${qs({ from, to })}`), enabled: !!id && !!from });
export const useAnchors = () => useQuery({ queryKey: ["anchors"], queryFn: () => api.get<{ items: any[] }>("/audit/anchors").then((r) => r.items) });

/** Mutation with success/error toasts and cache invalidation of everything chain-derived. */
export function useAction<TVars, TResult>(
  fn: (vars: TVars) => Promise<TResult>,
  opts: { success?: string | ((r: TResult) => string); tone?: (r: TResult) => ToastTone; invalidate?: QueryKey[]; onSuccess?: (r: TResult) => void; quiet?: boolean } = {},
) {
  const qc = useQueryClient();
  const { toast } = useApp();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result) => {
      const keys = opts.invalidate ?? [["proposal"], ["proposals"], ["governance"], ["evaluation"], ["overview"], ["audit"], ["alerts"], ["notifications"], ["findings"], ["attempts"], ["checks"], ["simulations"], ["graph"], ["conflicts"], ["voting"], ["delegates"], ["manifest"], ["dependencies"], ["treasury"]];
      keys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
      if (opts.success && !opts.quiet) toast(opts.tone?.(result) ?? "success", typeof opts.success === "function" ? opts.success(result) : opts.success);
      opts.onSuccess?.(result);
    },
    onError: (err: unknown) => {
      const e = err as ApiError;
      toast("error", e.code ? e.code.replace(/_/g, " ") : "Request failed", e.message);
    },
  });
}
