import { useEffect, useState } from "react";
import { useDashboard } from "../store";
import { clamp, cx, futureTime, relativeTime, scheduleLabel } from "../lib";
import type { Cadence, Routine, Skill, SkillStep, Watching } from "../types";
import { Button, Chip, ConfirmModal, IconButton, Modal, PageTitle, PixelIcon, Segmented, Switch, TextField, type ConfirmRequest } from "../components/ui";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const REPEAT_PICKS = [1, 5, 10, 50, 100, 1000];
const IDLE_WATCHING: Watching = { recording: false, startedAt: null, name: "", steps: [], replaying: false };

function stepIcon(step: SkillStep): string {
  switch (step.action) {
    case "type":
      return "keyboard";
    case "key":
      return "bolt";
    case "scroll":
      return "scroll";
    case "drag":
      return "hand";
    case "switch":
      return "switch";
    default:
      return "cursor";
  }
}

function elapsedLabel(startedAt: string | null | undefined, now: number): string {
  if (!startedAt) return "0:00";
  const total = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function SkillsPage() {
  const { state, account, enterprise, invoke, notify } = useDashboard();
  const watching = state.watching ?? IDLE_WATCHING;
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  // share (work accounts linked to an organization)
  const canShare = account.kind === "work" && enterprise.status === "ready" && Boolean(enterprise.view);
  const [sharing, setSharing] = useState<Skill | null>(null);

  // teach
  const [teachOpen, setTeachOpen] = useState(false);
  const [teachName, setTeachName] = useState("");

  // replay × N
  const [repeatFor, setRepeatFor] = useState<Skill | null>(null);
  const [repeatCount, setRepeatCount] = useState(10);

  // rename
  const [renaming, setRenaming] = useState<Skill | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // routines (secondary)
  const [routineOpen, setRoutineOpen] = useState(false);
  const [editing, setEditing] = useState<Routine | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cadence, setCadence] = useState<Cadence>("weekly");
  const [weekday, setWeekday] = useState(6);
  const [hour, setHour] = useState(17);
  const [minute, setMinute] = useState(0);
  const [natural, setNatural] = useState("");

  // ticks the elapsed clock while recording
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!watching.recording) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [watching.recording]);

  const startRecording = () => {
    invoke("startWatching", { name: teachName.trim() });
    setTeachOpen(false);
    notify("Recording", "Do the task once. Stop from the notch at the top of your screen, or come back here.", "info");
  };

  const stopRecording = () => {
    invoke("stopWatching");
    const count = watching.steps.length;
    if (count) notify("Saving skill", `${count} ${count === 1 ? "step" : "steps"} learned`);
    else notify("Stopped", "Nothing was captured yet", "info");
  };

  const replay = (skill: Skill, times: number) => {
    invoke("replaySkill", { id: skill.id, times });
    notify(times > 1 ? `Replay ×${times} queued` : "Ready to replay", "Approve the preview to run it");
  };

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
    setRoutineOpen(true);
  };

  const scheduleSkill = (skill: Skill) => {
    setEditing(null);
    setName(skill.name);
    setPrompt(`replay the “${skill.name}” skill`);
    setCadence("weekly");
    setWeekday(6);
    setHour(17);
    setMinute(0);
    setNatural("");
    setRoutineOpen(true);
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

  const saveRoutine = () => {
    const title = name.trim() || "routine";
    // enabled is left out: the snapshot from when the modal opened would undo a pause made since
    if (editing) {
      invoke("updateRoutine", { id: editing.id, name: title, prompt: prompt.trim(), cadence, weekday, hour, minute });
      notify("Schedule updated", title);
    } else {
      invoke("addRoutine", { name: title, prompt: prompt.trim(), cadence, weekday, hour, minute });
      notify("Schedule saved", scheduleLabel({ cadence, weekday, hour, minute }));
    }
    setRoutineOpen(false);
  };

  const liveSteps = watching.steps.slice(-6);
  const totalRuns = state.skills.reduce((sum, skill) => sum + skill.runCount, 0);

  return (
    <div className="skills-page">
      <PageTitle
        title="Skills"
        subtitle="Show okidoki once. It records every click, keystroke and scroll, then does it again — exactly, as many times as you need."
        trailing={
          watching.recording ? (
            <Button variant="danger" icon="stop" onClick={stopRecording}>
              Stop & save
            </Button>
          ) : (
            <Button
              variant="primary"
             
              onClick={() => {
                setTeachName("");
                setTeachOpen(true);
              }}
            >
              <span className="rec-dot" />
              Record a skill
            </Button>
          )
        }
      />

      {watching.recording ? (
        <section className="tile recording-tile reveal">
          <header className="recording-head">
            <span className="rec-dot is-live" />
            <div className="recording-copy">
              <strong>Recording{watching.name ? ` · ${watching.name}` : ""}</strong>
              <span>
                {elapsedLabel(watching.startedAt, now)} · {watching.steps.length} {watching.steps.length === 1 ? "step" : "steps"} captured
              </span>
            </div>
            <div className="recording-actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  invoke("discardWatching");
                  notify("Discarded", "Nothing was saved", "info");
                }}
              >
                Discard
              </Button>
              <Button variant="danger" size="sm" icon="stop" onClick={stopRecording}>
                Stop & save
              </Button>
            </div>
          </header>
          {liveSteps.length ? (
            <ol className="recording-steps">
              {liveSteps.map((step, index) => (
                <li key={step.id} className={cx(index === liveSteps.length - 1 && "is-latest")}>
                  <PixelIcon name={stepIcon(step)} size={13} />
                  <span>{step.text}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="recording-hint">Go do the task at a normal pace. Every click, keystroke, drag and scroll shows up here as it happens.</p>
          )}
          <p className="recording-foot">Press Save in the notch at the top of your screen, or click Stop & save here.</p>
        </section>
      ) : null}

      <section className="skills-section">
        <div className="section-head">
          <h2 className="skills-heading">Learned skills</h2>
          {state.skills.length ? <span className="tile-count">{state.skills.length}</span> : null}
          <span className="spacer" />
          {totalRuns ? (
            <span className="section-note">
              {totalRuns.toLocaleString("en-US")} {totalRuns === 1 ? "replay" : "replays"} so far
            </span>
          ) : null}
        </div>
        {state.skills.length ? (
          <div className="skills-grid">
            {state.skills.map((skill) => (
              <article className="tile skill-tile reveal" key={skill.id}>
                <header className="skill-head">
                  <span className="kind-icon">
                    <PixelIcon name={skill.source === "watch me" ? "record" : "wand"} size={16} />
                  </span>
                  <div className="skill-title">
                    <h3>{skill.name}</h3>
                    <span>
                      {skill.steps.length} {skill.steps.length === 1 ? "step" : "steps"} · {skill.runCount.toLocaleString("en-US")} {skill.runCount === 1 ? "replay" : "replays"} · learned{" "}
                      {relativeTime(skill.createdAt)}
                    </span>
                  </div>
                  <div className="skill-tools">
                    <IconButton
                      icon="edit"
                      label="Rename skill"
                      size={14}
                      onClick={() => {
                        setRenaming(skill);
                        setRenameValue(skill.name);
                      }}
                    />
                    <IconButton icon="clock" label="Replay on a schedule" size={14} onClick={() => scheduleSkill(skill)} />
                    {canShare ? <IconButton icon="share" label="Share with your organization" size={14} onClick={() => setSharing(skill)} /> : null}
                    <IconButton
                      icon="trash"
                      label="Delete skill"
                      size={14}
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
                  </div>
                </header>
                {skill.summary ? <p className="skill-summary">{skill.summary}</p> : null}
                <ol className="skill-steps">
                  {skill.steps.slice(0, 4).map((step, index) => (
                    <li key={step.id}>
                      <em>{index + 1}</em>
                      <PixelIcon name={stepIcon(step)} size={12} className="step-glyph" />
                      <span>{step.text}</span>
                    </li>
                  ))}
                  {skill.steps.length > 4 ? <li className="skill-more">+{skill.steps.length - 4} more {skill.steps.length - 4 === 1 ? "step" : "steps"}</li> : null}
                </ol>
                <footer className="skill-actions">
                  <Button variant="primary" size="sm" icon="play" disabled={watching.recording || watching.replaying} onClick={() => replay(skill, 1)}>
                    Replay
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="repeat"
                    disabled={watching.recording || watching.replaying}
                    onClick={() => {
                      setRepeatFor(skill);
                      setRepeatCount(10);
                    }}
                  >
                    Repeat…
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
                </footer>
              </article>
            ))}
          </div>
        ) : !watching.recording ? (
          <div className="tile skills-empty skills-howto">
            <div className="howto-steps">
              <div className="howto-step">
                <span className="kind-icon">
                  <PixelIcon name="record" size={16} />
                </span>
                <div>
                  <strong>1. Hit record</strong>
                  <span>Give it a name if you like. okidoki starts watching your whole Mac.</span>
                </div>
              </div>
              <div className="howto-step">
                <span className="kind-icon">
                  <PixelIcon name="cursor" size={16} />
                </span>
                <div>
                  <strong>2. Do it once</strong>
                  <span>Every click, keystroke, shortcut, drag and scroll is captured — with what you clicked, not just where.</span>
                </div>
              </div>
              <div className="howto-step">
                <span className="kind-icon">
                  <PixelIcon name="repeat" size={16} />
                </span>
                <div>
                  <strong>3. Replay it</strong>
                  <span>Once, ten times, a thousand times. A ghost cursor does it exactly the way you did. Esc stops it.</span>
                </div>
              </div>
            </div>
            <Button
              variant="primary"
             
              onClick={() => {
                setTeachName("");
                setTeachOpen(true);
              }}
            >
              <span className="rec-dot" />
              Record your first skill
            </Button>
          </div>
        ) : null}
      </section>

      {canShare ? <SharedSkillsSection replaying={watching.recording || watching.replaying} setConfirm={setConfirm} /> : null}

      <section className="skills-section routines-section">
        <div className="section-head">
          <h2 className="skills-heading">On a schedule</h2>
          {state.routines.length ? <span className="tile-count">{state.routines.length}</span> : null}
          <span className="spacer" />
          <Button variant="ghost" size="sm" icon="plus" onClick={openNewRoutine}>
            New schedule
          </Button>
        </div>
        {state.routines.length ? (
          <div className="tile routine-list reveal reveal-2">
            {state.routines.map((routine) => (
              <div className={cx("routine-row", !routine.enabled && "is-paused")} key={routine.id}>
                <span className="kind-icon small">
                  <PixelIcon name="clock" size={14} />
                </span>
                <button className="routine-copy" onClick={() => openEditRoutine(routine)} title="Edit schedule">
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
                  <IconButton icon="edit" label="Edit schedule" size={14} className="routine-hover" onClick={() => openEditRoutine(routine)} />
                  <IconButton
                    icon="trash"
                    label="Delete schedule"
                    size={14}
                    className="routine-hover"
                    onClick={() =>
                      setConfirm({
                        title: "Delete this schedule?",
                        detail: `“${routine.name}” won't run again.`,
                        action: "Delete schedule",
                        onConfirm: () => {
                          invoke("deleteRoutine", { id: routine.id });
                          notify("Schedule removed", routine.name, "info");
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
                    label={routine.enabled ? "Pause schedule" : "Resume schedule"}
                    checked={routine.enabled}
                    onChange={() => {
                      invoke("toggleRoutine", { id: routine.id });
                      notify(routine.enabled ? "Schedule paused" : "Schedule resumed", routine.name, "info");
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="section-note routines-empty">Optional. Use the clock on a skill to replay it at set times, or put any request on repeat.</p>
        )}
      </section>

      <Modal open={teachOpen} onClose={() => setTeachOpen(false)} title="Record a skill" subtitle="You'll do the task once. okidoki learns it move by move." width={480}>
        <div className="routine-form">
          <div className="routine-field">
            <span className="form-label">Name (optional)</span>
            <TextField value={teachName} onChange={setTeachName} placeholder="Export the weekly report" autoFocus onEnter={startRecording} />
          </div>
          <ul className="teach-tips">
            <li>
              <PixelIcon name="cursor" size={13} />
              <span>Go at a normal pace. Clicks are remembered by what you clicked, so a moved window still works.</span>
            </li>
            <li>
              <PixelIcon name="keyboard" size={13} />
              <span>Typing and shortcuts like ⌘S are captured too, as plain text — don't type secrets while recording.</span>
            </li>
            <li>
              <PixelIcon name="stop" size={13} />
              <span>Press Save in the notch at the top of your screen, shake your mouse, or come back to this page.</span>
            </li>
          </ul>
        </div>
        <footer className="modal-actions">
          <Button variant="ghost" onClick={() => setTeachOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={startRecording}>
            <span className="rec-dot" />
            Start recording
          </Button>
        </footer>
      </Modal>

      <Modal
        open={Boolean(repeatFor)}
        onClose={() => setRepeatFor(null)}
        title={repeatFor ? `Repeat “${repeatFor.name}”` : "Repeat"}
        subtitle="Runs the whole skill back to back. Press Esc or shake at any time to stop."
        width={460}
      >
        <div className="routine-form">
          <div className="repeat-picks">
            {REPEAT_PICKS.map((count) => (
              <button key={count} type="button" className={cx("repeat-pick", repeatCount === count && "is-selected")} onClick={() => setRepeatCount(count)}>
                ×{count.toLocaleString("en-US")}
              </button>
            ))}
          </div>
          <div className="routine-field">
            <span className="form-label">Or exactly</span>
            <div className="routine-time">
              <label className="routine-cell">
                <input
                  type="number"
                  min={1}
                  max={10000}
                  aria-label="Number of replays"
                  value={repeatCount}
                  onChange={(event) => setRepeatCount(clamp(Math.round(Number(event.target.value) || 1), 1, 10000))}
                />
              </label>
              <span className="repeat-note">
                {repeatFor ? `${(repeatFor.steps.length * repeatCount).toLocaleString("en-US")} moves in total` : ""}
              </span>
            </div>
          </div>
        </div>
        <footer className="modal-actions">
          <Button variant="ghost" onClick={() => setRepeatFor(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="repeat"
            onClick={() => {
              if (repeatFor) replay(repeatFor, repeatCount);
              setRepeatFor(null);
            }}
          >
            Replay ×{repeatCount.toLocaleString("en-US")}
          </Button>
        </footer>
      </Modal>

      <Modal open={Boolean(renaming)} onClose={() => setRenaming(null)} title="Rename skill" width={420}>
        <div className="routine-form">
          <div className="routine-field">
            <span className="form-label">Name</span>
            <TextField
              value={renameValue}
              onChange={setRenameValue}
              placeholder="Friday cleanup"
              autoFocus
              onEnter={() => {
                if (renaming && renameValue.trim()) {
                  invoke("renameSkill", { id: renaming.id, name: renameValue.trim() });
                  setRenaming(null);
                }
              }}
            />
          </div>
        </div>
        <footer className="modal-actions">
          <Button variant="ghost" onClick={() => setRenaming(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!renameValue.trim()}
            onClick={() => {
              if (renaming) {
                invoke("renameSkill", { id: renaming.id, name: renameValue.trim() });
                notify("Renamed", renameValue.trim());
              }
              setRenaming(null);
            }}
          >
            Save
          </Button>
        </footer>
      </Modal>

      <Modal
        open={routineOpen}
        onClose={() => setRoutineOpen(false)}
        title={editing ? "Edit schedule" : "New schedule"}
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
          <Button variant="ghost" onClick={() => setRoutineOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={saveRoutine} disabled={!prompt.trim()}>
            {editing ? "Save schedule" : "Add schedule"}
          </Button>
        </footer>
      </Modal>
      {canShare ? <ShareSkillModal skill={sharing} onClose={() => setSharing(null)} /> : null}
      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

// Publish one of my skills to the whole organization or to one of my spaces.
function ShareSkillModal({ skill, onClose }: { skill: Skill | null; onClose: () => void }) {
  const { enterprise, notify } = useDashboard();
  const joined = enterprise.spaces.filter((space) => space.joined);
  const [target, setTarget] = useState<string>("org");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (skill) setTarget("org");
  }, [skill]);
  const already = skill ? enterprise.sharedSkills.find((shared) => shared.sourceSkillId === skill.id && (shared.spaceId ?? "org") === target) : null;

  const publish = async () => {
    if (!skill) return;
    setBusy(true);
    try {
      const result = await enterprise.actions.publishSkill(target === "org" ? null : target, { id: skill.id, name: skill.name, summary: skill.summary, steps: skill.steps });
      notify(result.version > 1 ? `Updated to v${result.version}` : "Shared", `${skill.name} · ${target === "org" ? enterprise.view?.org.name ?? "organization" : joined.find((space) => space.id === target)?.name ?? "space"}`);
      onClose();
    } catch (error) {
      notify("That didn't work", error instanceof Error ? error.message : String(error), "warning");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={Boolean(skill)} onClose={onClose} title="Share this skill" subtitle="Colleagues pull it onto their own Macs and replay it there. Typed secrets were never recorded." width={460}>
      {skill ? (
        <div className="form-stack">
          <label className="form-label">With</label>
          <div className="share-targets">
            <button className={cx("share-target", target === "org" && "is-selected")} onClick={() => setTarget("org")}>
              <PixelIcon name="building" size={15} />
              <span>
                <strong>Everyone at {enterprise.view?.org.name ?? "the organization"}</strong>
                <em>Every member sees it under Skills</em>
              </span>
            </button>
            {joined.map((space) => (
              <button key={space.id} className={cx("share-target", target === space.id && "is-selected")} onClick={() => setTarget(space.id)}>
                <PixelIcon name="chat" size={15} />
                <span>
                  <strong>{space.name}</strong>
                  <em>
                    {space.members.length} {space.members.length === 1 ? "member" : "members"}
                  </em>
                </span>
              </button>
            ))}
          </div>
          <p className="form-hint">
            {skill.steps.length} {skill.steps.length === 1 ? "step" : "steps"}
            {already ? ` · already shared here as v${already.version}; this publishes v${already.version + 1}` : ""}
          </p>
        </div>
      ) : null}
      <footer className="modal-actions">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy || !skill} onClick={() => void publish()}>
          {already ? "Publish update" : "Share"}
        </Button>
      </footer>
    </Modal>
  );
}

// Skills colleagues have shared. Replay pulls the skill onto this Mac first; it stays under "Learned skills" after.
function SharedSkillsSection({ replaying, setConfirm }: { replaying: boolean; setConfirm: (request: ConfirmRequest) => void }) {
  const { state, enterprise, invoke, notify, native } = useDashboard();
  const [scope, setScope] = useState<"all" | "org" | "space">("all");
  const shared = enterprise.sharedSkills.filter((skill) => (scope === "all" ? true : scope === "org" ? !skill.spaceId : Boolean(skill.spaceId)));
  const orgName = enterprise.view?.org.name ?? "your organization";
  const localFor = (sharedId: string) => state.skills.find((skill) => skill.source === `shared:${sharedId}`);

  const pull = (skill: (typeof shared)[number], replay: boolean) => {
    if (!native) {
      notify("Do this on your Mac", "Shared skills replay on the Mac that has okidoki.", "info");
      return;
    }
    invoke("importSkill", { sharedId: skill.id, name: skill.name, summary: skill.summary, steps: skill.steps, version: skill.version, replay });
    if (replay) {
      void enterprise.actions.recordSkillRun(skill.id).catch(() => {});
      notify("Ready to replay", "Approve the preview to run it");
    } else {
      notify("Added to your skills", skill.name);
    }
  };

  const totalRuns = enterprise.sharedSkills.reduce((sum, skill) => sum + skill.runCount, 0);

  return (
    <section className="skills-section shared-section">
      <div className="section-head">
        <h2 className="skills-heading">Shared at {orgName}</h2>
        {enterprise.sharedSkills.length ? <span className="tile-count">{enterprise.sharedSkills.length}</span> : null}
        <span className="spacer" />
        {totalRuns ? (
          <span className="section-note">
            {totalRuns.toLocaleString("en-US")} {totalRuns === 1 ? "replay" : "replays"} across the team
          </span>
        ) : null}
        <Segmented
          compact
          options={[
            { value: "all", label: "All" },
            { value: "org", label: "Org-wide" },
            { value: "space", label: "By space" },
          ]}
          value={scope}
          onChange={setScope}
        />
      </div>
      {shared.length ? (
        <div className="skills-grid">
          {shared.map((skill) => {
            const local = localFor(skill.id);
            const missing = skill.requires.filter((app) => !state.tools.some((tool) => tool.name.toLowerCase() === app.toLowerCase()));
            return (
              <article className="tile skill-tile shared-tile reveal" key={skill.id}>
                <header className="skill-head">
                  <span className="kind-icon">
                    <PixelIcon name={skill.spaceId ? "chat" : "building"} size={16} />
                  </span>
                  <div className="skill-title">
                    <h3>{skill.name}</h3>
                    <span>
                      {skill.stepCount} {skill.stepCount === 1 ? "step" : "steps"} · v{skill.version} · by {skill.isMine ? "you" : skill.publishedBy} · {skill.spaceId ? skill.spaceName : "everyone"} · {skill.runCount.toLocaleString("en-US")}{" "}
                      {skill.runCount === 1 ? "replay" : "replays"}
                    </span>
                  </div>
                  <div className="skill-tools">
                    {skill.canUnpublish && skill.versions > 1 ? (
                      <IconButton icon="refresh" label="Roll back to the previous version" size={14} onClick={() => void enterprise.actions.rollbackSkill(skill.id).then(() => notify("Rolled back", skill.name)).catch((error: Error) => notify("That didn't work", error.message, "warning"))} />
                    ) : null}
                    {skill.canUnpublish ? (
                      <IconButton
                        icon="trash"
                        label="Unshare"
                        size={14}
                        onClick={() =>
                          setConfirm({
                            title: "Stop sharing this skill?",
                            detail: `“${skill.name}” disappears for everyone at ${orgName}. Copies already pulled onto Macs stay there.`,
                            action: "Unshare",
                            onConfirm: () => void enterprise.actions.unpublishSkill(skill.id).then(() => notify("Unshared", skill.name, "info")).catch((error: Error) => notify("That didn't work", error.message, "warning")),
                          })
                        }
                      />
                    ) : null}
                  </div>
                </header>
                {skill.summary ? <p className="skill-summary">{skill.summary}</p> : null}
                <div className="shared-needs">
                  {skill.requires.map((app) => (
                    <Chip key={app} tone={missing.includes(app) ? "amber" : "green"}>
                      {app}
                    </Chip>
                  ))}
                  {skill.params.map((param) => (
                    <Chip key={`p-${param}`} tone="blue">
                      {`{{${param}}}`}
                    </Chip>
                  ))}
                </div>
                <footer className="skill-actions">
                  <Button variant="primary" size="sm" icon="play" disabled={replaying} onClick={() => pull(skill, true)}>
                    Replay here
                  </Button>
                  <Button variant="secondary" size="sm" icon="download" onClick={() => pull(skill, false)}>
                    {local ? "Update my copy" : "Add to my skills"}
                  </Button>
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="tile skills-empty">
          <p className="recording-hint">
            {enterprise.sharedSkills.length ? "Nothing in this view." : `Nobody at ${orgName} has shared a skill yet. Share one of yours with the share button on its card.`}
          </p>
        </div>
      )}
    </section>
  );
}
