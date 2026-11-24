import { useState } from "react";
import { useDashboard } from "../store";
import { clamp, cx, futureTime, relativeTime, scheduleLabel } from "../lib";
import type { Cadence, Routine } from "../types";
import { Button, Choice, ConfirmModal, IconButton, Modal, PageTitle, PixelIcon, Segmented, Switch, TextField, type ConfirmRequest } from "../components/ui";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DRAFT_KEY = "okidoki.schedule.draft";

type Draft = { name: string; prompt: string };

function takeDraft(): Draft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(DRAFT_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const draft = parsed as Partial<Draft>;
    return { name: typeof draft.name === "string" ? draft.name : "", prompt: typeof draft.prompt === "string" ? draft.prompt : "" };
  } catch {
    return null;
  }
}

/** Automations are routines: a prompt okidoki runs on a schedule, on this Mac. */
export function AutomationsPage() {
  const { state, invoke, notify } = useDashboard();
  const [draft] = useState(takeDraft);
  const [routineOpen, setRoutineOpen] = useState(Boolean(draft));
  const [editing, setEditing] = useState<Routine | null>(null);
  const [name, setName] = useState(draft?.name ?? "");
  const [prompt, setPrompt] = useState(draft?.prompt ?? "");
  const [cadence, setCadence] = useState<Cadence>("weekly");
  const [weekday, setWeekday] = useState(6);
  const [hour, setHour] = useState(17);
  const [minute, setMinute] = useState(0);
  const [natural, setNatural] = useState("");
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const openNewRoutine = () => {
    setEditing(null);
    setName("");
    setPrompt("");
    setCadence("weekly");
    setWeekday(6);
    setHour(17);
    setMinute(0);
    setNatural("");
    setRoutineOpen(true);
  };

  const openEditRoutine = (routine: Routine) => {
    setEditing(routine);
    setName(routine.name);
    setPrompt(routine.prompt);
    setCadence(routine.cadence);
    setWeekday(routine.weekday);
    setHour(routine.hour);
    setMinute(routine.minute);
    setNatural("");
    setRoutineOpen(true);
  };

  const parseNatural = () => {
    if (!natural.trim()) return;
    const lower = natural.toLowerCase();
    const dayMatch = lower.match(/\b(sun|mon|tue|wed|thu|fri|sat)(?:[a-z]*day|rs|s)?s?\b/);
    const timeMatch = lower.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (/\b(hourly|every hour)\b/.test(lower)) setCadence("hourly");
    else if (/\bweekdays?\b/.test(lower)) setCadence("weekdays");
    else if (/\b(daily|every day|each day|every morning|every evening|every night)\b/.test(lower)) setCadence("daily");
    else if (dayMatch) setCadence("weekly");
    if (dayMatch) setWeekday(DAYS.indexOf(dayMatch[1]) + 1);
    if (timeMatch) {
      let value = Number(timeMatch[1]);
      if (timeMatch[3] === "pm" && value < 12) value += 12;
      if (timeMatch[3] === "am" && value === 12) value = 0;
      if (!timeMatch[3] && value < 8) value += 12;
      setHour(clamp(value, 0, 23));
      setMinute(clamp(Number(timeMatch[2] ?? 0), 0, 59));
    }
    const comma = natural.indexOf(",");
    const action = comma >= 0 ? natural.slice(comma + 1).trim() : natural;
    setName(action.slice(0, 40) || "automation");
    setPrompt(natural.trim());
    setNatural("");
  };

  const saveRoutine = () => {
    const title = name.trim() || "automation";
    if (editing) {
      invoke("updateRoutine", { id: editing.id, name: title, prompt: prompt.trim(), cadence, weekday, hour, minute });
      notify("Automation updated", title);
    } else {
      invoke("addRoutine", { name: title, prompt: prompt.trim(), cadence, weekday, hour, minute });
      notify("Automation saved", scheduleLabel({ cadence, weekday, hour, minute }));
    }
    setRoutineOpen(false);
  };

  const routines = state.routines;

  return (
    <div className="automations-page">
      <PageTitle
        title="Automations"
        subtitle="Things okidoki does on a schedule — on this Mac, even when you're not looking. Anything that needs you waits in the notch."
        trailing={
          <Button variant="primary" icon="plus" onClick={openNewRoutine}>
            New automation
          </Button>
        }
      />

      {routines.length ? (
        <section className="skills-section routines-section">
          <div className="section-head">
            <h2 className="skills-heading">Scheduled</h2>
            <span className="tile-count">{routines.length}</span>
            <span className="spacer" />
            <span className="section-note">Pause one with its switch. Run now to watch it once.</span>
          </div>
          <div className="tile routine-list">
            {routines.map((routine) => (
              <div className={cx("routine-row", !routine.enabled && "is-paused")} key={routine.id}>
                <span className="kind-icon small">
                  <PixelIcon name="clock" size={14} />
                </span>
                <button className="routine-copy" onClick={() => openEditRoutine(routine)} title="Edit automation">
                  <strong>{routine.name}</strong>
                  <em>{routine.prompt}</em>
                </button>
                <span className="routine-when">
                  <span className="routine-pill">
                    <PixelIcon name="calendar" size={12} />
                    {scheduleLabel(routine)}
                  </span>
                  <span className="routine-next">
                    {routine.enabled ? `Next ${futureTime(routine.nextRunAt)}` : "Paused"}
                    {routine.lastRunAt ? ` · Last ${relativeTime(routine.lastRunAt)}` : ""}
                  </span>
                </span>
                <div className="routine-actions">
                  <IconButton icon="edit" label="Edit automation" size={14} className="routine-hover" onClick={() => openEditRoutine(routine)} />
                  <IconButton
                    icon="trash"
                    label="Delete automation"
                    size={14}
                    className="routine-hover"
                    onClick={() =>
                      setConfirm({
                        title: "Delete this automation?",
                        detail: `“${routine.name}” won’t run again.`,
                        action: "Delete automation",
                        onConfirm: () => {
                          invoke("deleteRoutine", { id: routine.id });
                          notify("Automation removed", routine.name, "info");
                        },
                      })
                    }
                  />
                  <IconButton
                    icon="play"
                    label="Run now"
                    size={14}
                    className="routine-run"
                    onClick={() => {
                      invoke("runRoutine", { id: routine.id });
                      notify("Running", routine.name);
                    }}
                  />
                  <Switch
                    label={routine.enabled ? "Pause automation" : "Resume automation"}
                    checked={routine.enabled}
                    onChange={() => {
                      invoke("toggleRoutine", { id: routine.id });
                      notify(routine.enabled ? "Automation paused" : "Automation resumed", routine.name, "info");
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <section className="automations-empty">
          <span className="automations-empty-icon">
            <PixelIcon name="clock" size={22} />
          </span>
          <h2>Nothing scheduled yet</h2>
          <p>Put a task on repeat: “clean my Downloads every Friday at 5”, “summarize the news each morning”. okidoki runs it here, and asks you in the notch when it needs a hand.</p>
          <Button variant="secondary" icon="plus" onClick={openNewRoutine}>
            Create the first automation
          </Button>
        </section>
      )}

      <Modal
        open={routineOpen}
        onClose={() => setRoutineOpen(false)}
        title={editing ? "Edit automation" : "New automation"}
        subtitle={editing ? undefined : "Describe it in plain words, or set it up by hand."}
        width={540}
      >
        <div className="routine-form">
          {!editing ? (
            <div className="routine-natural">
              <TextField value={natural} onChange={setNatural} placeholder="Every Friday at 5, clean my Downloads folder" icon="spark" onEnter={parseNatural} />
              <Button variant="secondary" onClick={parseNatural} disabled={!natural.trim()}>
                Fill in
              </Button>
            </div>
          ) : null}
          <div className="routine-field">
            <span className="form-label">Name</span>
            <TextField value={name} onChange={setName} placeholder="Friday cleanup" />
          </div>
          <div className="routine-field">
            <span className="form-label">What should okidoki do?</span>
            <TextField value={prompt} onChange={setPrompt} placeholder="Clean my Downloads folder" />
          </div>
          <div className="routine-field">
            <span className="form-label">Repeats</span>
            <Segmented
              options={[
                { value: "hourly", label: "Hourly" },
                { value: "daily", label: "Daily" },
                { value: "weekdays", label: "Weekdays" },
                { value: "weekly", label: "Weekly" },
                { value: "manual", label: "Manual" },
              ]}
              value={cadence}
              onChange={(value) => setCadence(value as Cadence)}
            />
          </div>
          {cadence !== "manual" ? (
            <div className="routine-time">
              {cadence === "weekly" ? (
                <div className="routine-cell is-day">
                  <span className="form-label">Day</span>
                  <Choice label="Day" size="lg" value={weekday} onChange={setWeekday} options={DAYS.map((_, index) => ({ value: index + 1, label: DAY_LABELS[index] }))} />
                </div>
              ) : null}
              {cadence !== "hourly" ? (
                <label className="routine-cell">
                  <span className="form-label">Hour</span>
                  <NumberCell value={hour} min={0} max={23} onChange={setHour} />
                </label>
              ) : null}
              <label className="routine-cell">
                <span className="form-label">Minute</span>
                <NumberCell value={minute} min={0} max={59} onChange={setMinute} />
              </label>
            </div>
          ) : null}
          <p className="routine-summary">
            <PixelIcon name="calendar" size={13} />
            {scheduleLabel({ cadence, weekday, hour, minute })}
          </p>
          <p className="routine-note">Runs on this Mac. Anything that needs a person waits for you in the notch.</p>
        </div>
        <footer className="modal-actions">
          <Button variant="ghost" onClick={() => setRoutineOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={saveRoutine} disabled={!prompt.trim()}>
            {editing ? "Save automation" : "Add automation"}
          </Button>
        </footer>
      </Modal>
      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

/** A number box you can clear and retype: it keeps what you type, and settles to a valid value on blur. */
function NumberCell({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={draft ?? String(value)}
      onChange={(event) => {
        setDraft(event.target.value);
        const next = Number(event.target.value);
        if (event.target.value !== "" && Number.isFinite(next)) onChange(clamp(Math.round(next), min, max));
      }}
      onBlur={() => setDraft(null)}
    />
  );
}
