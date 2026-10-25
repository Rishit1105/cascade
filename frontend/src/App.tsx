import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppProvider } from "./lib/app";
import { LiveProvider } from "./lib/live";
import { TourProvider } from "./lib/tour";
import { MotionProvider } from "./lib/motion";
import { TourOverlay } from "./components/Tour";
import { AssistantProvider } from "./components/Assistant";
import { useHealth } from "./lib/queries";
import { AppShell, BootScreen } from "./components/layout";
import { Inspectors } from "./components/inspectors";
import { Toasts } from "./components/overlays";
import { EmptyState, LoadingBlock } from "./components/ui";

const Overview = lazy(() => import("./pages/Overview"));
const Proposals = lazy(() => import("./pages/Proposals"));
const Relationships = lazy(() => import("./pages/Relationships"));
const Versions = lazy(() => import("./pages/Versions"));
const Financial = lazy(() => import("./pages/Financial"));
const Voting = lazy(() => import("./pages/Voting"));
const Guardian = lazy(() => import("./pages/Guardian"));
const AuditTimeline = lazy(() => import("./pages/AuditTimeline"));
const Escalation = lazy(() => import("./pages/Escalation"));
const Reports = lazy(() => import("./pages/Reports"));
const SettingsPage = lazy(() => import("./pages/Settings"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 3000, retry: 1, refetchOnWindowFocus: false } },
});

function Gate({ children }: { children: ReactNode }) {
  const health = useHealth();
  if (health.error) {
    return <BootScreen phase="error" message="The DAOGuard API did not respond." error="Start the stack with `npm run dev` from the project root (backend on :8000, Hardhat node on :8545)." />;
  }
  if (!health.data) return <BootScreen phase="waiting_for_chain" message="Contacting the DAOGuard API…" />;
  if (health.data.state.phase !== "ready") return <BootScreen phase={health.data.state.phase} message={health.data.state.message} error={health.data.state.error} />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <QueryClientProvider client={queryClient}>
        <MotionProvider>
        <AppProvider>
          <Gate>
            <LiveProvider>
              <TourProvider>
                <AssistantProvider>
                  <AppShell>
                    <Suspense fallback={<LoadingBlock rows={8} />}>
                      <Routes>
                        <Route path="/" element={<Overview />} />
                        <Route path="/proposals" element={<Proposals />} />
                        <Route path="/proposals/:id" element={<Proposals />} />
                        <Route path="/relationships" element={<Relationships />} />
                        <Route path="/versions" element={<Versions />} />
                        <Route path="/financial" element={<Financial />} />
                        <Route path="/voting" element={<Voting />} />
                        <Route path="/guardian" element={<Guardian />} />
                        <Route path="/audit" element={<AuditTimeline />} />
                        <Route path="/escalation" element={<Escalation />} />
                        <Route path="/reports" element={<Reports />} />
                        <Route path="/settings" element={<SettingsPage />} />
                        <Route path="*" element={<EmptyState title="Page not found" body="This route does not exist." action={<Link className="text-sm font-semibold text-primary" to="/">Back to overview</Link>} />} />
                      </Routes>
                    </Suspense>
                  </AppShell>
                  <Inspectors />
                  <TourOverlay />
                </AssistantProvider>
              </TourProvider>
            </LiveProvider>
          </Gate>
          <Toasts />
        </AppProvider>
        </MotionProvider>
      </QueryClientProvider>
    </BrowserRouter>
  );
}
