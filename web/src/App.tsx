import { useEffect, useState } from "react";
import { DashboardProvider, useDashboard } from "./store";
import { AppShell, AuthGate, type Page } from "./components/Layout";
import { HomePage } from "./pages/HomePage";
import { RunsPage } from "./pages/RunsPage";
import { HistoryPage } from "./pages/HistoryPage";
import { MemoryPage } from "./pages/MemoryPage";
import { SkillsPage } from "./pages/SkillsPage";
import { ToolboxPage } from "./pages/ToolboxPage";
import { KeysPage } from "./pages/KeysPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SharePage } from "./pages/SharePage";
import { ToastStack } from "./components/ui";

export default function App() {
  const shareToken = window.location.hash.match(/^#\/share\/(.+)$/)?.[1];
  if (shareToken) return <SharePage token={shareToken} />;
  return (
    <DashboardProvider>
      <Root />
    </DashboardProvider>
  );
}

function Root() {
  const { state, toasts, dismissToast } = useDashboard();
  const initial = (window.location.hash.replace("#/", "") as Page) || "home";
  const [page, setPage] = useState<Page>(isPage(initial) ? initial : "home");
  const [askOpen, setAskOpen] = useState(false);

  useEffect(() => {
    if (window.location.hash !== `#/${page}`) window.location.hash = `#/${page}`;
  }, [page]);

  useEffect(() => {
    const onHash = () => {
      const next = window.location.hash.replace("#/", "");
      if (isPage(next)) setPage(next);
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
      {page === "history" ? <HistoryPage go={setPage} /> : null}
      {page === "memory" ? <MemoryPage /> : null}
      {page === "skills" ? <SkillsPage /> : null}
      {page === "toolbox" ? <ToolboxPage /> : null}
      {page === "keys" ? <KeysPage /> : null}
      {page === "settings" ? <SettingsPage /> : null}
    </AppShell>
  );
}

function isPage(value: string): value is Page {
  return ["home", "runs", "history", "memory", "skills", "toolbox", "keys", "settings"].includes(value);
}
