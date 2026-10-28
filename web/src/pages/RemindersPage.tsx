import { useState } from "react";
import { useDashboard } from "../store";
import { cx, relativeTime } from "../lib";
import type { Reminder, ReminderRepeat } from "../types";
import { Button, Chip, ConfirmModal, IconButton, PageTitle, PixelIcon, TextField, type ConfirmRequest } from "../components/ui";

const REPEATS: { value: ReminderRepeat; label: string }[] = [
  { value: "never", label: "Once" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
];

/** "2026-10-28T17:00" for a datetime-local input, in this Mac's time zone. */
function localInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function inAnHour(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  return localInput(date);
}

/** "today, 5:00 PM" or "Thu, Oct 29, 9:00 AM". Home uses it too. */
export function when(reminder: Reminder): string {
  if (!reminder.dueAt) return "no time";
  const due = new Date(reminder.dueAt);
  const today = new Date();
  const sameDay = due.toDateString() === today.toDateString();
  const time = due.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = sameDay ? "today" : due.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return `${day}, ${time}`;
}

type Group = { id: string; title: string; items: Reminder[] };

function grouped(reminders: Reminder[]): Group[] {
  const now = Date.now();
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  const open = reminders.filter((r) => !r.done);
  const groups: Group[] = [
    { id: "overdue", title: "Overdue", items: open.filter((r) => r.dueAt && +new Date(r.dueAt) < now) },
    { id: "today", title: "Today", items: open.filter((r) => r.dueAt && +new Date(r.dueAt) >= now && +new Date(r.dueAt) <= +endOfToday) },
    { id: "later", title: "Later", items: open.filter((r) => r.dueAt && +new Date(r.dueAt) > +endOfToday) },
    { id: "someday", title: "No time", items: open.filter((r) => !r.dueAt) },
    { id: "done", title: "Done", items: reminders.filter((r) => r.done).slice(0, 20) },
  ];
  return groups.filter((group) => group.items.length);
}

export function RemindersPage() {
  const { state, invoke, notify } = useDashboard();
  const reminders = state.reminders ?? [];
  const skills = state.skills ?? [];
  const [title, setTitle] = useState("");
  const [due, setDue] = useState(inAnHour);
  const [repeats, setRepeats] = useState<ReminderRepeat>("never");
  const [skillID, setSkillID] = useState("");
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const add = () => {
    const text = title.trim();
    if (!text) return;
    invoke("addReminder", { title: text, dueAt: due ? new Date(due).toISOString() : null, repeats, skillID });
    notify("Reminder set", due ? `${text} · ${when({ dueAt: new Date(due).toISOString() } as Reminder)}` : text);
    setTitle("");
    setSkillID("");
  };

  const groups = grouped(reminders);

  return (
    <div className="memory-page reminders-page">
      <PageTitle title="Reminders" subtitle="okidoki taps you on the shoulder in the notch, or does the chore itself with a skill. Or just say “remind me to …”." />

      <section className="tile memory-compose reveal">
        <header className="tile-head">
          <h2>New reminder</h2>
        </header>
        <div className="reminders-compose">
          <TextField value={title} onChange={setTitle} icon="bell" placeholder="Call the dentist, pay rent, stretch…" onEnter={add} />
          <input className="reminders-input" type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} aria-label="When" />
          <select className="reminders-input" value={repeats} onChange={(event) => setRepeats(event.target.value as ReminderRepeat)} aria-label="Repeat">
            {REPEATS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select className="reminders-input" value={skillID} onChange={(event) => setSkillID(event.target.value)} aria-label="Replay a skill when it's due">
            <option value="">Just remind me</option>
            {skills.map((skill) => (
              <option key={skill.id} value={skill.id}>
                Replay “{skill.name}”
              </option>
            ))}
          </select>
        </div>
        <div className="memory-compose-foot">
          <span>
            <PixelIcon name="lock" size={13} />
            Kept on this Mac{state.settings.appleReminders ? " · copied to Reminders when asked at the cursor" : ""}
          </span>
          <Button variant="primary" size="sm" icon="plus" onClick={add} disabled={!title.trim()}>
            Add
          </Button>
        </div>
      </section>

      {groups.length ? (
        <div className="reminders-groups">
          {groups.map((group) => (
            <section className="tile memory-list-tile reveal reveal-2" key={group.id}>
              <header className="tile-head">
                <h2>{group.title}</h2>
                <span className="tile-count">{group.items.length}</span>
              </header>
              <div className="memory-list">
                {group.items.map((reminder) => {
                  const skill = reminder.skillID ? skills.find((s) => s.id === reminder.skillID) : undefined;
                  return (
                    <div className={cx("memory-item", reminder.done && "is-done")} key={reminder.id}>
                      <button
                        className={cx("reminder-check", reminder.done && "is-on")}
                        onClick={() => invoke("completeReminder", { id: reminder.id, done: !reminder.done })}
                        aria-label={reminder.done ? "Mark not done" : reminder.repeats !== "never" ? "Done for now" : "Mark done"}
                        title={reminder.repeats !== "never" && !reminder.done ? "Done for now — it comes back next time" : undefined}
                      >
                        {reminder.done ? <PixelIcon name="check" size={11} /> : null}
                      </button>
                      <span className="memory-copy">
                        <span className="memory-text">{reminder.title}</span>
                        <span className="memory-meta">
                          {reminder.done && reminder.doneAt ? `done ${relativeTime(reminder.doneAt)}` : when(reminder)}
                          {reminder.repeats !== "never" ? ` · ${REPEATS.find((r) => r.value === reminder.repeats)?.label.toLowerCase()}` : ""}
                        </span>
                      </span>
                      {skill ? <Chip tone="blue">replays {skill.name}</Chip> : null}
                      <div className="memory-actions">
                        {!reminder.done && reminder.dueAt ? (
                          <IconButton icon="clock" label="Snooze 10 minutes" size={14} onClick={() => invoke("snoozeReminder", { id: reminder.id, minutes: 10 })} />
                        ) : null}
                        <IconButton
                          icon="trash"
                          label="Delete"
                          size={14}
                          onClick={() =>
                            setConfirm({
                              title: "Delete this reminder?",
                              detail: reminder.title,
                              action: "Delete",
                              onConfirm: () => invoke("deleteReminder", { id: reminder.id }),
                            })
                          }
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <section className="tile memory-list-tile reveal reveal-2">
          <div className="memory-empty">
            <strong>Nothing to remember yet</strong>
            <span>Shake your mouse and say “remind me to stretch every weekday at 3pm”, or add one above.</span>
          </div>
        </section>
      )}
      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
