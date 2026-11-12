import { MotionConfig } from "motion/react";
import { DashboardProvider, useDashboard } from "./store";
import { AuthGate } from "./components/AuthGate";
import { KobraToastBridge } from "./components/ui";
import { Toasts } from "@/components/ui/toast";
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

function Root() {
  const { state, toasts, booting } = useDashboard();
  // In the Mac app, wait for its state rather than flashing the demo's for a frame.
  if (booting) return null;
  if (state.signedOut) {
    return (
      <>
        <AuthGate />
        <KobraToastBridge toasts={toasts} />
        <Toasts position="bottom-center" />
      </>
    );
  }
  return <Shell />;
}
