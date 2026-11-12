import { useEffect, useRef, useState } from "react";
import { MotionConfig } from "motion/react";
import { DashboardProvider, useDashboard } from "./store";
import { AppShell, AuthGate } from "./components/Layout";
import { isPage, jumpToSettingsSection, resolveRoute, type Page } from "./nav";
import { HomePage } from "./pages/HomePage";
import { VaultPage } from "./pages/VaultPage";
import { RunsPage } from "./pages/RunsPage";
import { LivePage } from "./pages/LivePage";
import { HistoryPage } from "./pages/HistoryPage";
import { MemoryPage } from "./pages/MemoryPage";
import { SkillsPage } from "./pages/SkillsPage";
import { BrowserPage } from "./pages/BrowserPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ToastStack } from "./components/ui";
import { Shell } from "./shell/Shell";

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <DashboardProvider>
        <Root />
      </DashboardProvider>
    </MotionConfig>
  );
}

/** The new look is its own shell; off, the original dashboard renders exactly as before. */
function Root() {
  const { state, settings, booting } = useDashboard();
  // In the Mac app, wait for its state rather than flashing the demo's for a frame.
  if (booting) return null;
  if (settings.newShell && !state.signedOut) return <Shell />;
  return <LegacyRoot />;
}

function LegacyRoot() {
  const { state, toasts, dismissToast } = useDashboard();
  const raw = window.location.hash.replace("#/", "");
  const initial = resolveRoute(raw);
  const [page, setPage] = useState<Page>(isPage(initial.page) ? initial.page : "home");
  const [askOpen, setAskOpen] = useState(false);

  useEffect(() => {
    if (window.location.hash !== `#/${page}`) window.location.hash = `#/${page}`;
  }, [page]);

  // A deep link into a Settings section (#/keys) on first load: the page effect above rewrites the
  // hash to #/settings, so the section has to be remembered here rather than read back from it.
  const initialSection = useRef(initial.section);
  useEffect(() => {
    if (initialSection.current) jumpToSettingsSection(initialSection.current);
    initialSection.current = undefined;
  }, []);

  useEffect(() => {
    const onHash = () => {
      const route = resolveRoute(window.location.hash.replace("#/", ""));
      if (isPage(route.page)) setPage(route.page);
      if (route.section) jumpToSettingsSection(route.section);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (state.signedOut) {
    return (
      <>
        <AuthGate />
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  return (
    <AppShell page={page} setPage={setPage} askOpen={askOpen} setAskOpen={setAskOpen}>
      {page === "home" ? <HomePage go={setPage} /> : null}
      {page === "browser" ? <BrowserPage /> : null}
      {page === "runs" ? <RunsPage /> : null}
      {page === "live" ? <LivePage /> : null}
      {page === "history" ? <HistoryPage go={setPage} /> : null}
      {page === "memory" ? <MemoryPage /> : null}
      {page === "skills" ? <SkillsPage /> : null}
      {page === "settings" ? <SettingsPage /> : null}
      {page === "vault" ? <VaultPage go={setPage} /> : null}
    </AppShell>
  );
}
