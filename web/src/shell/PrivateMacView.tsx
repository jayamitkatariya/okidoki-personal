import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useDashboard } from "../store";
import { isNative } from "../bridge";
import { cx } from "../lib";
import { Button, Empty, PixelIcon, Progress } from "../components/ui";
import { jumpToSettingsSection } from "../nav";
import { ACTIVE } from "./model";

/**
 * okidoki's private Mac, live inside the shell. The Mac streams small stills of the VM's display while
 * this is open (a few a second), so you can watch a run without its window in the way. Clicking the
 * picture, or "Use it", brings up the real window to take the wheel.
 */
export function PrivateMacView({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { state, settings, invoke } = useDashboard();
  const vm = state.privateMac ?? null;
  const phase = vm?.phase ?? "unsupported";
  const running = phase === "running";
  const [frame, setFrame] = useState<string | null>(null);
  const act = (action: string, extra: Record<string, unknown> = {}) => invoke("privateMac", { action, ...extra });

  // Frames flow only while this view is open and the VM is up.
  useEffect(() => {
    if (!running || !isNative()) return;
    const onFrame = (event: Event) => setFrame((event as CustomEvent<string>).detail || null);
    window.addEventListener("okidoki-vm-frame", onFrame);
    invoke("privateMac", { action: "mirror", on: true });
    return () => {
      window.removeEventListener("okidoki-vm-frame", onFrame);
      invoke("privateMac", { action: "mirror", on: false });
    };
  }, [running, invoke]);
  useEffect(() => {
    if (!running) setFrame(null);
  }, [running]);

  const run = settings.computerTarget === "vm" ? state.runs.find((item) => item.kind === "computer_use" && ACTIVE.has(item.status)) : undefined;
  const settingsLink = () => {
    onOpenSettings();
    jumpToSettingsSection("private-mac");
  };

  if (!vm || phase === "unsupported" || phase === "notSetUp" || phase === "failed" || phase === "downloading" || phase === "installing") {
    const busy = phase === "downloading" || phase === "installing";
    return (
      <div className="card-scroll">
        <Empty
          icon="screen"
          title={busy ? "Setting up your private Mac" : phase === "failed" ? "Your private Mac didn’t finish setting up" : phase === "unsupported" ? "Private Mac isn’t available here" : "No private Mac yet"}
          action={
            busy ? undefined : (
              <Button variant="secondary" size="sm" icon="gear" onClick={settingsLink}>
                {phase === "unsupported" ? "Settings" : "Set it up in Settings"}
              </Button>
            )
          }
        >
          {busy ? (
            <span className="vm-setup">
              <span>{vm?.status}</span>
              <Progress value={vm?.progress ?? 0} />
            </span>
          ) : phase === "unsupported" ? (
            "A private Mac needs Apple silicon. Runs happen on this Mac."
          ) : (
            "Give okidoki its own macOS. Runs that drive apps happen there, and you watch them right here while you keep working."
          )}
        </Empty>
      </div>
    );
  }

  return (
    <div className="vm-view">
      <div className="vm-bar">
        <span className={cx("vm-state", running && "is-live", run && "is-working")}>
          <i aria-hidden="true" />
          {run ? "Working" : running ? "Live" : phase === "starting" ? "Starting" : phase === "stopping" ? "Shutting down" : "Off"}
        </span>
        <span className="vm-meta">
          {run ? run.title : `macOS ${vm.macOSVersion || ""}`.trim()}
          <em>
            {vm.cpuCount} cores · {vm.memoryGB} GB
          </em>
        </span>
        <span className="vm-actions">
          {running ? (
            <>
              <Button variant="secondary" size="sm" icon="cursor" onClick={() => act("show")}>
                Use it
              </Button>
              <Button variant="ghost" size="sm" disabled={Boolean(run)} onClick={() => act("stop")}>
                Shut down
              </Button>
            </>
          ) : phase === "stopped" ? (
            <Button variant="primary" size="sm" icon="play" onClick={() => act("startQuiet")}>
              Start
            </Button>
          ) : null}
        </span>
      </div>

      <div className="vm-stage">
        <button
          type="button"
          className={cx("vm-screen", running && "is-on")}
          onClick={() => (running ? act("show") : phase === "stopped" ? act("startQuiet") : undefined)}
          aria-label={running ? "Open the private Mac’s window to use it" : "Start the private Mac"}
        >
          <AnimatePresence initial={false}>
            {frame ? (
              <motion.img
                key="live"
                src={frame}
                alt="The private Mac’s screen"
                draggable={false}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: 0.24, ease: [0.23, 1, 0.32, 1] } }}
                exit={{ opacity: 0, transition: { duration: 0.16, ease: [0.4, 0, 0.6, 1] } }}
              />
            ) : (
              <motion.span key="idle" className="vm-idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <PixelIcon name="screen" size={26} />
                {running
                  ? isNative()
                    ? "Connecting to the screen…"
                    : "The private Mac’s screen shows here in the Mac app."
                  : phase === "starting"
                    ? "Starting up…"
                    : phase === "stopping"
                      ? "Shutting down…"
                      : "Off. It starts by itself when a run needs it, or start it now."}
              </motion.span>
            )}
          </AnimatePresence>
        </button>
        {vm.needsFirstBoot && running ? (
          <p className="vm-note">
            First boot: click through macOS Setup Assistant in its window, then{" "}
            <button type="button" className="text-link" onClick={() => act("firstBootDone")}>
              tell okidoki it's done
            </button>
            .
          </p>
        ) : running ? (
          <p className="vm-note">Watching only. Click the screen or Use it to take over in its own window.</p>
        ) : null}
      </div>
    </div>
  );
}
