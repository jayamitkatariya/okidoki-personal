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
import { NotesPage } from "./pages/NotesPage";
import { RemindersPage } from "./pages/RemindersPage";
import { TerminalPage } from "./pages/TerminalPage";
import { SkillsPage } from "./pages/SkillsPage";
import { ToolboxPage } from "./pages/ToolboxPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ToastStack } from "./components/ui";

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <DashboardProvider>
        <Root />
      </DashboardProvider>
    </MotionConfig>
  );
}

function Root() {
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
      {page === "runs" ? <RunsPage /> : null}
      {page === "live" ? <LivePage /> : null}
      {page === "history" ? <HistoryPage go={setPage} /> : null}
      {page === "memory" ? <MemoryPage /> : null}
      {page === "notes" ? <NotesPage /> : null}
      {page === "reminders" ? <RemindersPage /> : null}
      {page === "skills" ? <SkillsPage /> : null}
      {page === "terminal" ? <TerminalPage go={setPage} /> : null}
      {page === "toolbox" ? <ToolboxPage /> : null}
      {page === "settings" ? <SettingsPage go={setPage} /> : null}
      {page === "vault" ? <VaultPage go={setPage} /> : null}
    </AppShell>
  );
}
