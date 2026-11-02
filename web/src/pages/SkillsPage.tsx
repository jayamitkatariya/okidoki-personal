import { useEffect, useMemo, useState } from "react";
import { useDashboard } from "../store";
import { clamp, cx, futureTime, relativeTime, scheduleLabel } from "../lib";
import type { Cadence, LibraryEntry, Routine, Skill, SkillStep, Watching } from "../types";
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

type LibraryFilter = "all" | "browser" | "mac" | "work" | "personal";

/** Ready-made skills: add one, then just ask for it. The first run follows its outline and teaches it. */
function LibrarySection({ entries, onAdd }: { entries: LibraryEntry[]; onAdd: (entry: LibraryEntry) => void }) {
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((entry) => {
      const fits =
        filter === "all" ||
        (filter === "browser" || filter === "mac" ? entry.surface === filter : entry.tags.includes(filter));
      const matches = !q || [entry.name, entry.summary, entry.intent, ...entry.tags].some((text) => text.toLowerCase().includes(q));
      return fits && matches;
    });
  }, [entries, filter, query]);
  if (!entries.length) return null;
  return (
    <section className="skills-section library-section">
      <div className="section-head">
        <h2 className="skills-heading">Library</h2>
        <span className="tile-count">{entries.length}</span>
        <span className="spacer" />
        <span className="section-note">Add one, then just ask. The first run learns it; after that it replays in seconds.</span>
      </div>
      <div className="library-tools">
        <Segmented<LibraryFilter>
          compact
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "browser", label: "Browser" },
            { value: "mac", label: "Mac" },
            { value: "work", label: "Work" },
            { value: "personal", label: "Personal" },
          ]}
        />
        <TextField value={query} onChange={setQuery} placeholder="Search the library" icon="search" className="library-search" />
      </div>
      {shown.length ? (
        <div className="skills-grid">
          {shown.map((entry) => (
            <article className="tile skill-tile library-tile reveal" key={entry.id}>
              <header className="skill-head">
                <span className="kind-icon">
                  <PixelIcon name={entry.surface === "mac" ? "cursor" : "globe"} size={16} />
                </span>
                <div className="skill-title">
                  <h3>{entry.name}</h3>
                  <span>
                    {entry.surface === "mac" ? "on your Mac" : "in okidoki's browser"}
                    {entry.confirms ? " · always checks with you first" : ""}
                  </span>
                </div>
              </header>
              <p className="skill-summary">{entry.summary}</p>
              {entry.inputs.length ? (
                <div className="skill-inputs">
                  {entry.inputs.map((input) => (
                    <Chip key={input}>{input}</Chip>
                  ))}
                </div>
              ) : null}
              <footer className="skill-actions">
                {entry.learned ? (
                  <Chip tone="green">Learned</Chip>
                ) : entry.added ? (
                  <Chip tone="blue">Added · just ask for it</Chip>
                ) : (
                  <Button variant="primary" size="sm" icon="plus" onClick={() => onAdd(entry)}>
                    Add
                  </Button>
                )}
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <p className="library-empty">Nothing in the library matches that.</p>
      )}
    </section>
  );
}

export function SkillsPage() {
  const { state, invoke, notify } = useDashboard();
  const watching = state.watching ?? IDLE_WATCHING;
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);


  // record
  const [recordOpen, setRecordOpen] = useState(false);
  const [recordName, setRecordName] = useState("");

  // replay × N
  const [repeatFor, setRepeatFor] = useState<Skill | null>(null);
  const [repeatCount, setRepeatCount] = useState(10);
  // What's typed in the count field: it may be empty mid-edit, so clamping waits for a real number
  // (clamping "" to 1 turned "backspace, then 50" into 150).
  const [repeatDraft, setRepeatDraft] = useState<string | null>(null);

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
    invoke("startWatching", { name: recordName.trim() });
    setRecordOpen(false);
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
        title="Replay"
        subtitle="Show okidoki once. It records every click, keystroke and scroll, then does it again — exactly, as many times as you need."
        trailing={
          watching.recording ? (
            <Button variant="danger" icon="stop" onClick={stopRecording}>
              Stop & save
            </Button>
          ) : (
            <span className="skills-head-actions">
              <Button variant="ghost" icon="download" onClick={() => invoke("importSkillFile")}>
                Import
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setRecordName("");
                  setRecordOpen(true);
                }}
              >
                <span className="rec-dot" />
                Record a skill
              </Button>
            </span>
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

      <LibrarySection
        entries={state.library ?? []}
        onAdd={(entry) => {
          invoke("installTemplate", { id: entry.id });
        }}
      />

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
                      {skill.template
                        ? "from the library · learns on its first run"
                        : `${skill.steps.length} ${skill.steps.length === 1 ? "step" : "steps"} · ${skill.runCount.toLocaleString("en-US")} ${skill.runCount === 1 ? "replay" : "replays"} · learned ${relativeTime(skill.createdAt)}`}
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
                    <IconButton icon="share" label="Save as a file to share" size={14} onClick={() => invoke("exportSkill", { id: skill.id })} />
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
                {skill.inputs?.filter((input) => input.source !== "page").length ? (
                  <div className="skill-inputs">
                    {skill.inputs
                      .filter((input) => input.source !== "page")
                      .map((input) => (
                        <Chip key={input.name} tone={input.source === "document" ? "lavender" : "default"}>
                          {input.name.replace(/_/g, " ")}
                        </Chip>
                      ))}
                    <span className="skill-inputs-note">
                      {skill.inputs.some((input) => input.source === "document") ? "changes per " + (skill.itemNoun ?? "run") + " · read from your documents" : "changes per " + (skill.itemNoun ?? "run")}
                    </span>
                  </div>
                ) : null}
                {skill.template && skill.outline?.length ? (
                  <ol className="skill-steps">
                    {skill.outline.slice(0, 4).map((line, index) => (
                      <li key={index}>
                        <em>{index + 1}</em>
                        <span>{line}</span>
                      </li>
                    ))}
                    {skill.outline.length > 4 ? <li className="skill-more">+{skill.outline.length - 4} more</li> : null}
                  </ol>
                ) : null}
                <ol className="skill-steps" hidden={!!skill.template}>
                  {skill.steps.slice(0, 4).map((step, index) => (
                    <li key={step.id}>
                      <em>{index + 1}</em>
                      <PixelIcon name={stepIcon(step)} size={12} className="step-glyph" />
                      <span>{step.text}</span>
                    </li>
                  ))}
                  {skill.steps.length > 4 ? <li className="skill-more">+{skill.steps.length - 4} more {skill.steps.length - 4 === 1 ? "step" : "steps"}</li> : null}
                </ol>
                <footer className="skill-actions" hidden={!!skill.template}>
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
                      setRepeatDraft(null);
                    }}
                  >
                    Repeat…
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
                setRecordName("");
                setRecordOpen(true);
              }}
            >
              <span className="rec-dot" />
              Record your first skill
            </Button>
          </div>
        ) : null}
      </section>


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

      <Modal open={recordOpen} onClose={() => setRecordOpen(false)} title="Record a skill" subtitle="You'll do the task once. okidoki learns it move by move." width={480}>
        <div className="routine-form">
          <div className="routine-field">
            <span className="form-label">Name (optional)</span>
            <TextField value={recordName} onChange={setRecordName} placeholder="Export the weekly report" autoFocus onEnter={startRecording} />
          </div>
          <ul className="record-tips">
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
              <span>Press Save in the notch at the top of your screen or come back to this page.</span>
            </li>
          </ul>
        </div>
        <footer className="modal-actions">
          <Button variant="ghost" onClick={() => setRecordOpen(false)}>
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
        subtitle="Runs the whole skill back to back. Press Esc at any time to stop."
        width={460}
      >
        <div className="routine-form">
          <div className="repeat-picks">
            {REPEAT_PICKS.map((count) => (
              <button key={count} type="button" className={cx("repeat-pick", repeatCount === count && "is-selected")} onClick={() => { setRepeatCount(count); setRepeatDraft(null); }}>
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
                  value={repeatDraft ?? repeatCount}
                  onChange={(event) => {
                    const raw = event.target.value;
                    setRepeatDraft(raw);
                    const n = Math.round(Number(raw));
                    if (raw.trim() && Number.isFinite(n) && n >= 1) setRepeatCount(clamp(n, 1, 10000));
                  }}
                  onBlur={() => setRepeatDraft(null)}
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
      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
