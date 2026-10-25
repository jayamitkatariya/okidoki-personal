import { useCallback } from "react";
import { useDashboard } from "./store";

// A one-person team needs its own Mac to do the work. Creating or joining an organization, or
// making a space, switches the worker on here (once), so the first "@okidoki …" doesn't sit waiting.

export function useEnsureWorker() {
  const { native, state, updateSettings, notify } = useDashboard();
  const enabled = state.settings.workerEnabled === true;
  return useCallback(() => {
    if (!native || enabled) return false;
    updateSettings({ workerEnabled: true });
    notify("This Mac will take jobs from your spaces", "Change it any time under Settings › Worker");
    return true;
  }, [native, enabled, updateSettings, notify]);
}

/** Why a queued job isn't moving, from this Mac's point of view, and whether a switch here fixes it. */
export function workerHint(input: { native: boolean; enabled: boolean; state?: "off" | "paused" | "ready" | null; readyElsewhere: number; workAccountName: string }): { text: string; action: "enable" | "switch" | null } {
  if (input.readyElsewhere > 0) return { text: "", action: null };
  if (!input.native) return { text: "No Mac is taking jobs right now. Turn on Accept jobs under Settings › Worker on a member's Mac.", action: null };
  if (!input.enabled) return { text: "This Mac isn't taking jobs yet.", action: "enable" };
  if (input.state === "paused") return { text: `This Mac is on a personal account. Switch to ${input.workAccountName} to run it.`, action: "switch" };
  return { text: "Waiting for a Mac to pick it up.", action: null };
}
