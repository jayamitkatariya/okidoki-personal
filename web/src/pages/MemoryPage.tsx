import { useState } from "react";
import { useDashboard } from "../store";
import { cx, relativeTime } from "../lib";
import type { Memory, MemorySource, ServicesState } from "../types";
import { Button, Chip, ConfirmModal, IconButton, Modal, PageTitle, PixelIcon, Segmented, Switch, TextArea, type ConfirmRequest } from "../components/ui";

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
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const about = state.memories.filter((memory) => memory.section === "aboutYou");
  const now = state.memories.filter((memory) => memory.section === "rightNow");
  const calendar = state.connectors.find((connector) => connector.id === "calendar");
  const sources = state.memorySources ?? [];
  const onThisMac = sources.filter((source) => source.files.length > 0);
  const needExport = sources.filter((source) => source.files.length === 0);

  const importFrom = (source?: MemorySource) => {
    const text = source ? `import my memory from ${source.name}` : "import my memory from other assistants";
    invoke("ask", { text });
    notify("Preparing the import", source ? `Reading what ${source.name} remembers` : "Reading every assistant on this Mac", "info");
  };

  const add = () => {
    // mirror the native rules (OkidokiStore.addMemory) so the toast only claims what gets saved
    const cleaned = text.trim().replace(/^[.,;: ]+|[.,;: ]+$/g, "");
    if (cleaned.length <= 2) {
      notify("Too short to remember", "Add a few more words", "warning");
      return;
    }
    if (state.memories.some((memory) => memory.text.toLowerCase() === cleaned.toLowerCase())) {
      notify("Already remembered", cleaned, "info");
      return;
    }
    invoke("addMemory", { text: cleaned, section });
    notify("Noted", cleaned);
    setText("");
  };

  const startEdit = (memory: Memory) => {
    setEditing(memory);
    setEditText(memory.text);
  };

  const remove = (memory: Memory) => {
    setConfirm({
      title: "Forget this memory?",
      detail: memory.text,
      action: "Forget",
      onConfirm: () => {
        invoke("deleteMemory", { id: memory.id });
        notify("Forgotten", "Removed from memory", "info");
      },
    });
  };

  const fillExample = (target: Section) => {
    setSection(target);
    setText(SECTIONS[target].example);
  };

  return (
    <div className="memory-page">
      <PageTitle
        title="Memory"
        subtitle="About you stays with your account. Right now is short-term memory, searched with Moss."
        trailing={state.services ? <MemoryIndexBadge services={state.services} onFix={() => (window.location.hash = "#/keys")} /> : null}
      />

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

      <section className="tile memory-import reveal reveal-2">
        <header className="tile-head">
          <h2>Bring memories from another assistant</h2>
          <span className="spacer" />
          {onThisMac.length > 1 ? (
            <Button variant="secondary" size="sm" icon="download" onClick={() => importFrom()}>
              Import all on this Mac
            </Button>
          ) : null}
        </header>
        <p className="memory-import-copy">
          Reads the notes other assistants keep about you and adds them here. You approve before anything is read, their files aren't changed, and
          nothing leaves your Mac.
        </p>
        {onThisMac.length ? (
          <div className="memory-import-list">
            {onThisMac.map((source) => (
              <div className="memory-setting" key={source.id}>
                <span className="kind-icon small">
                  <PixelIcon name="terminal" size={14} />
                </span>
                <span className="row-copy">
                  <strong>{source.name}</strong>
                  <em>
                    {source.files.length} {source.files.length === 1 ? "file" : "files"} on this Mac
                  </em>
                </span>
                <Button variant="secondary" size="sm" onClick={() => importFrom(source)}>
                  Import
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        {needExport.length ? (
          <div className="memory-import-foot">
            <span>From an export:</span>
            {needExport.map((source) => (
              <Button key={source.id} variant="ghost" size="sm" onClick={() => importFrom(source)} title={source.blurb}>
                {source.name}
              </Button>
            ))}
          </div>
        ) : null}
      </section>

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
              invoke("updateMemory", { id: editing.id, text: editText.trim() });
              notify("Memory updated", editText.trim());
              setEditing(null);
            }}
          >
            Save
          </Button>
        </div>
      </Modal>
      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
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
  onDelete: (memory: Memory) => void;
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
                <IconButton icon="trash" label="Delete" size={14} onClick={() => onDelete(memory)} />
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

/** What the Moss index holds, so "searched with Moss" is a fact rather than a promise. */
function MemoryIndexBadge({ services, onFix }: { services: ServicesState; onFix: () => void }) {
  const memory = services.memory;
  if (!memory.configured) {
    return (
      <button className="memory-index is-off" onClick={onFix} title="Add a Moss key in Settings › Keys">
        <i />
        Moss off · exact matches only
      </button>
    );
  }
  if (memory.error) {
    return (
      <span className="memory-index is-warn" title={memory.error}>
        <i />
        Moss error
      </span>
    );
  }
  if (!memory.ready) {
    return (
      <span className="memory-index">
        <i />
        Moss loading…
      </span>
    );
  }
  const items = memory.notes + memory.messages;
  return (
    <span className="memory-index is-on" title={`${memory.notes} notes · ${memory.messages} recent turns · ${memory.tools} tools`}>
      <i />
      Moss · {items} item{items === 1 ? "" : "s"} indexed{memory.lastSyncAt ? ` · ${relativeTime(memory.lastSyncAt)}` : ""}
    </span>
  );
}
