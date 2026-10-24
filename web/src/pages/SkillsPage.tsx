import { useState } from "react";
import { useDashboard } from "../store";
import { clamp, cx, futureTime, relativeTime, scheduleLabel } from "../lib";
import type { Cadence, Routine, Skill } from "../types";
import { Button, Chip, ConfirmModal, IconButton, Modal, PageTitle, PixelIcon, Segmented, Switch, TextField, type ConfirmRequest } from "../components/ui";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function SkillsPage() {
  const { state, invoke, notify } = useDashboard();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Routine | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cadence, setCadence] = useState<Cadence>("weekly");
  const [weekday, setWeekday] = useState(6);
  const [hour, setHour] = useState(17);
  const [minute, setMinute] = useState(0);
  const [natural, setNatural] = useState("");
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  // Reset here, not in an effect on open: an effect would also wipe what scheduleSkill fills in.
  const openNew = () => {
    setEditing(null);
    setName("");
    setPrompt("");
    setCadence("weekly");
    setWeekday(6);
    setHour(17);
    setMinute(0);
    setNatural("");
    setModalOpen(true);
  };

  const openEdit = (routine: Routine) => {
    setEditing(routine);
    setName(routine.name);
    setPrompt(routine.prompt);
    setCadence(routine.cadence);
    setWeekday(routine.weekday);
    setHour(routine.hour);
    setMinute(routine.minute);
    setModalOpen(true);
  };

  const scheduleSkill = (skill: Skill) => {
    setEditing(null);
    setName(skill.name);
    setPrompt(`run the “${skill.name}” skill: ${skill.steps.map((step) => step.text).join(" → ")}`);
    setCadence("weekly");
    setWeekday(6);
    setHour(17);
    setMinute(0);
    setNatural("");
    setModalOpen(true);
  };

  const parseNatural = () => {
    if (!natural.trim()) return;
    const lower = natural.toLowerCase();
    // whole words only, so "monitor" isn't Monday and "friend" isn't Friday
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
    setName(action.slice(0, 40) || "routine");
    setPrompt(natural.trim());
    setNatural("");
  };

  const save = () => {
    const title = name.trim() || "routine";
    // enabled is left out: the snapshot from when the modal opened would undo a pause made since
    if (editing) {
      invoke("updateRoutine", { id: editing.id, name: title, prompt: prompt.trim(), cadence, weekday, hour, minute });
      notify("Routine updated", title);
    } else {
      invoke("addRoutine", { name: title, prompt: prompt.trim(), cadence, weekday, hour, minute });
      notify("Routine saved", scheduleLabel({ cadence, weekday, hour, minute }));
    }
    setModalOpen(false);
  };

  const active = state.routines.filter((routine) => routine.enabled).length;

  return (
    <div className="skills-page">
      <PageTitle
        title="Skills & routines"
        subtitle="Replay what you've shown okidoki, or put a task on a schedule."
        trailing={
          <Button variant="primary" icon="plus" onClick={openNew}>
            New routine
          </Button>
        }
      />

      <section className="skills-section">
        <div className="section-head">
          <h2 className="skills-heading">Skills</h2>
          {state.skills.length ? <span className="tile-count">{state.skills.length}</span> : null}
        </div>
        {state.skills.length ? (
          <div className="skills-grid">
            {state.skills.map((skill) => (
              <article className="tile skill-tile reveal" key={skill.id}>
                <header className="skill-head">
                  <span className="kind-icon">
                    <PixelIcon name={skill.source === "watch me" ? "eye" : "wand"} size={16} />
                  </span>
                  <div className="skill-title">
                    <h3>{skill.name}</h3>
                    <span>
                      <span className="skill-source">{skill.source}</span> · {skill.runCount} {skill.runCount === 1 ? "run" : "runs"}
                    </span>
                  </div>
                  <IconButton
                    icon="trash"
                    label="Delete skill"
                    size={14}
                    className="skill-delete"
                    onClick={() =>
                      setConfirm({
                        title: "Delete this skill?",
                        detail: `“${skill.name}” and its recorded steps will be gone.`,
                        action: "Delete skill",
                        onConfirm: () => {
                          invoke("deleteSkill", { id: skill.id });
                          notify("Skill removed", skill.name, "info");
                        },
                      })
                    }
                  />
                </header>
                {skill.summary ? <p className="skill-summary">{skill.summary}</p> : null}
                <ol className="skill-steps">
                  {skill.steps.slice(0, 3).map((step, index) => (
                    <li key={step.id}>
                      <em>{index + 1}</em>
                      <span>{step.text}</span>
                    </li>
                  ))}
                  {skill.steps.length > 3 ? <li className="skill-more">+{skill.steps.length - 3} more {skill.steps.length - 3 === 1 ? "step" : "steps"}</li> : null}
                </ol>
                <footer className="skill-actions">
                  <Button
                    variant="primary"
                    size="sm"
                    icon="play"
                    onClick={() => {
                      invoke("replaySkill", { id: skill.id });
                      notify("Ready to replay", "Approve the preview to run it");
                    }}
                  >
                    Replay
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      invoke("startSkill", { id: skill.id });
                      notify("Walkthrough started", skill.name);
                    }}
                  >
                    Walk me through
                  </Button>
                  <Button variant="ghost" size="sm" icon="clock" onClick={() => scheduleSkill(skill)}>
                    Schedule
                  </Button>
                </footer>
              </article>
            ))}
          </div>
        ) : (
          <div className="tile skills-empty">
            <span className="kind-icon">
              <PixelIcon name="wand" size={16} />
            </span>
            <div>
              <strong>No skills yet</strong>
              <span>Say “watch me do this” and do the task once. okidoki saves it as steps you can replay.</span>
            </div>
          </div>
        )}
      </section>

      <section className="skills-section">
        <div className="section-head">
          <h2 className="skills-heading">Routines</h2>
          {state.routines.length ? <span className="tile-count">{state.routines.length}</span> : null}
          <span className="spacer" />
          {state.routines.length ? <span className="section-note">{active} active</span> : null}
        </div>
        {state.routines.length ? (
          <div className="tile routine-list reveal reveal-2">
            {state.routines.map((routine) => (
              <div className={cx("routine-row", !routine.enabled && "is-paused")} key={routine.id}>
                <span className="kind-icon small">
                  <PixelIcon name="clock" size={14} />
                </span>
                <button className="routine-copy" onClick={() => openEdit(routine)} title="Edit routine">
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
                  <IconButton icon="edit" label="Edit routine" size={14} className="routine-hover" onClick={() => openEdit(routine)} />
                  <IconButton
                    icon="trash"
                    label="Delete routine"
                    size={14}
                    className="routine-hover"
                    onClick={() =>
                      setConfirm({
                        title: "Delete this routine?",
                        detail: `“${routine.name}” won't run again.`,
                        action: "Delete routine",
                        onConfirm: () => {
                          invoke("deleteRoutine", { id: routine.id });
                          notify("Routine removed", routine.name, "info");
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
                      notify("Routine running", routine.name);
                    }}
                  />
                  <Switch
                    label={routine.enabled ? "Pause routine" : "Resume routine"}
                    checked={routine.enabled}
                    onChange={() => {
                      invoke("toggleRoutine", { id: routine.id });
                      notify(routine.enabled ? "Routine paused" : "Routine resumed", routine.name, "info");
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="tile skills-empty">
            <span className="kind-icon">
              <PixelIcon name="clock" size={16} />
            </span>
            <div>
              <strong>Nothing on repeat</strong>
              <span>Try “every Friday at 5, clean my Downloads folder.”</span>
            </div>
            <Button variant="secondary" size="sm" icon="plus" onClick={openNew}>
              New routine
            </Button>
          </div>
        )}
      </section>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? "Edit routine" : "New routine"}
        subtitle={editing ? undefined : "Describe it in plain words, or set it up by hand."}
        width={540}
      >
        <div className="routine-form">
          {!editing ? (
            <div className="routine-natural">
              <TextField
                value={natural}
                onChange={setNatural}
                placeholder="Every Friday at 5, clean my Downloads folder"
                icon="spark"
                onEnter={parseNatural}
              />
              <Button variant="secondary" onClick={parseNatural} disabled={!natural.trim()}>
                Fill in
              </Button>
            </div>
          ) : null}
          <label className="routine-field">
            <span className="form-label">Name</span>
            <TextField value={name} onChange={setName} placeholder="Friday cleanup" />
          </label>
          <label className="routine-field">
            <span className="form-label">What should okidoki do?</span>
            <TextField value={prompt} onChange={setPrompt} placeholder="Clean my Downloads folder" />
          </label>
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
                <label className="routine-cell is-day">
                  <span className="form-label">Day</span>
                  <select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>
                    {DAYS.map((day, index) => (
                      <option key={day} value={index + 1}>
                        {DAY_LABELS[index]}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {cadence !== "hourly" ? (
                <label className="routine-cell">
                  <span className="form-label">Hour</span>
                  <input type="number" min={0} max={23} value={hour} onChange={(event) => setHour(clamp(Math.round(Number(event.target.value) || 0), 0, 23))} />
                </label>
              ) : null}
              <label className="routine-cell">
                <span className="form-label">Minute</span>
                <input type="number" min={0} max={59} value={minute} onChange={(event) => setMinute(clamp(Math.round(Number(event.target.value) || 0), 0, 59))} />
              </label>
            </div>
          ) : null}
          <p className="routine-summary">
            <PixelIcon name="calendar" size={13} />
            {scheduleLabel({ cadence, weekday, hour, minute })}
          </p>
        </div>
        <footer className="modal-actions">
          <Button variant="ghost" onClick={() => setModalOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!prompt.trim()}>
            {editing ? "Save routine" : "Add routine"}
          </Button>
        </footer>
      </Modal>
      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
