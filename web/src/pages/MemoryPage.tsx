import { useState } from "react";
import { useDashboard } from "../store";
import { cx, relativeTime } from "../lib";
import type { Memory } from "../types";
import { Button, Chip, IconButton, Modal, PageTitle, PixelIcon, Segmented, Switch, TextArea } from "../components/ui";

type Section = "aboutYou" | "rightNow";

const SECTIONS: Record<Section, { title: string; hint: string; example: string; placeholder: string }> = {
  aboutYou: {
    title: "About you",
    hint: "Who you are and how you like to work.",
    example: "I'm a designer. I use Figma and VS Code. Keep replies short.",
    placeholder: "I'm a student. I use Figma and VS Code. Keep it short.",
  },
  rightNow: {
    title: "Right now",
    hint: "What you're focused on this week.",
    example: "Shipping the new onboarding flow this week.",
    placeholder: "Building okidoki and redesigning the Workro onboarding.",
  },
};

export function MemoryPage() {
  const { state, settings, invoke, updateSettings, notify } = useDashboard();
  const [section, setSection] = useState<Section>("aboutYou");
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<Memory | null>(null);
  const [editText, setEditText] = useState("");
  const about = state.memories.filter((memory) => memory.section === "aboutYou");
  const now = state.memories.filter((memory) => memory.section === "rightNow");
  const calendar = state.connectors.find((connector) => connector.id === "calendar");

  const add = () => {
    if (!text.trim()) return;
    invoke("addMemory", { text: text.trim(), section });
    notify("Noted", text.trim());
    setText("");
  };

  const startEdit = (memory: Memory) => {
    setEditing(memory);
    setEditText(memory.text);
  };

  const remove = (id: string) => {
    invoke("deleteMemory", { id });
    notify("Forgotten", "Removed from memory", "info");
  };

  const fillExample = (target: Section) => {
    setSection(target);
    setText(SECTIONS[target].example);
  };

  return (
    <div className="memory-page">
      <PageTitle title="Memory" subtitle="What okidoki knows about you. Only what you tell it, and you can change any of it." />

      <div className="memory-top">
        <section className="tile memory-compose reveal">
          <header className="tile-head">
            <h2>Add a memory</h2>
            <span className="spacer" />
            <Segmented
              compact
              options={[
                { value: "aboutYou", label: "About you" },
                { value: "rightNow", label: "Right now" },
              ]}
              value={section}
              onChange={(value) => setSection(value as Section)}
            />
          </header>
          <TextArea value={text} onChange={setText} rows={3} placeholder={SECTIONS[section].placeholder} />
          <div className="memory-compose-foot">
            <span>
              <PixelIcon name="lock" size={13} />
              Stored on this Mac
            </span>
            <Button variant="primary" size="sm" icon="plus" onClick={add} disabled={!text.trim()}>
              Remember
            </Button>
          </div>
        </section>

        <section className="tile memory-nudges reveal reveal-2">
          <header className="tile-head">
            <h2>Nudges</h2>
          </header>
          <p className="memory-nudges-copy">A quick heads-up before meetings, using only apps you've connected.</p>
          <div className="memory-setting">
            <span className="kind-icon small">
              <PixelIcon name="bell" size={14} />
            </span>
            <span className="row-copy">
              <strong>Before meetings</strong>
              <em>Ten-minute heads-up</em>
            </span>
            <Switch
              label="Nudges before meetings"
              checked={settings.proactiveNudges}
              onChange={(value) => {
                updateSettings({ proactiveNudges: value });
                notify(value ? "Nudges on" : "Nudges off", value ? "Only using connected apps" : "okidoki will stay quiet", "info");
              }}
            />
          </div>
          <div className="memory-setting">
            <span className="kind-icon small">
              <PixelIcon name="calendar" size={14} />
            </span>
            <span className="row-copy">
              <strong>Apple Calendar</strong>
              <em>{calendar?.enabled ? "Meeting times" : "Needed for nudges"}</em>
            </span>
            {calendar?.enabled ? (
              <Chip tone="green">Connected</Chip>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  invoke("connectApple", { id: "calendar" });
                  notify("Asking macOS", "Allow automation for Calendar", "info");
                }}
              >
                Connect
              </Button>
            )}
          </div>
        </section>
      </div>

      <div className="memory-lists">
        <MemoryList section="aboutYou" memories={about} onEdit={startEdit} onDelete={remove} onExample={fillExample} />
        <MemoryList section="rightNow" memories={now} onEdit={startEdit} onDelete={remove} onExample={fillExample} />
      </div>

      <footer className="memory-footer">
        <PixelIcon name="lock" size={13} />
        <span>Nothing is tracked in the background. Screenshots are never stored.</span>
        <button
          className="text-link"
          onClick={() => {
            invoke("openExternal", { url: "https://github.com/jaykatariya/okidoki" });
          }}
        >
          Open source <PixelIcon name="external" size={12} />
        </button>
      </footer>

      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title="Edit memory" width={480}>
        <TextArea value={editText} onChange={setEditText} rows={4} />
        <div className="modal-actions">
          <Button variant="ghost" onClick={() => setEditing(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!editText.trim()}
            onClick={() => {
              if (!editing) return;
              invoke("updateMemory", { id: editing.id, text: editText });
              notify("Memory updated", editText);
              setEditing(null);
            }}
          >
            Save
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function MemoryList({
  section,
  memories,
  onEdit,
  onDelete,
  onExample,
}: {
  section: Section;
  memories: Memory[];
  onEdit: (memory: Memory) => void;
  onDelete: (id: string) => void;
  onExample: (section: Section) => void;
}) {
  const copy = SECTIONS[section];
  return (
    <section className="tile memory-list-tile reveal reveal-3">
      <header className="tile-head">
        <h2>{copy.title}</h2>
        {memories.length ? <span className="tile-count">{memories.length}</span> : null}
      </header>
      {memories.length ? (
        <div className="memory-list">
          {memories.map((memory) => (
            <div className="memory-item" key={memory.id}>
              <span className={cx("memory-dot", section === "rightNow" && "is-now")} />
              <button className="memory-copy" onClick={() => onEdit(memory)} title="Edit">
                <span className="memory-text">{memory.text}</span>
                <span className="memory-meta">
                  {memory.source} · {relativeTime(memory.updatedAt)}
                </span>
              </button>
              <div className="memory-actions">
                <IconButton icon="edit" label="Edit" size={14} onClick={() => onEdit(memory)} />
                <IconButton icon="trash" label="Delete" size={14} onClick={() => onDelete(memory.id)} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="memory-empty">
          <strong>Nothing yet</strong>
          <span>{copy.hint}</span>
          <button className="memory-example" onClick={() => onExample(section)}>
            <PixelIcon name="plus" size={12} />“{copy.example}”
          </button>
        </div>
      )}
    </section>
  );
}
