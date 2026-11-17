import { useEffect, useState } from "react";
import { useDashboard } from "../store";
import { cx, relativeTime } from "../lib";
import type { Memory, MemorySource, ServicesState } from "../types";
import { Button, Chip, ConfirmModal, IconButton, isComposing, Modal, PageTitle, PixelIcon, Segmented, Switch, TextArea, TextField, type ConfirmRequest } from "../components/ui";
import { isNative } from "../bridge";
import { orderMemories, searchMemories } from "../memorySearch";
import { memorySourceLabel } from "../shell/MemoryChips";

type Section = "aboutYou" | "rightNow";

const SECTIONS: Record<Section, { title: string; hint: string; example: string; placeholder: string }> = {
  aboutYou: {
    title: "About you",
    hint: "Who you are and how you like to work.",
    example: "I’m a designer. I use Figma and VS Code. Keep replies short.",
    placeholder: "I’m a student. I use Figma and VS Code. Keep it short.",
  },
  rightNow: {
    title: "Right now",
    hint: "What you’re focused on this week.",
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
  const [query, setQuery] = useState("");
  const memoryIndex = state.services?.memory;
  // Search by meaning only when the index is up; otherwise matching words is all there is.
  const indexed = Boolean(isNative() && memoryIndex?.configured && memoryIndex.ready && !memoryIndex.error);
  useEffect(() => {
    if (!indexed) return;
    // Wait for a pause in typing so the index isn't asked about every keystroke.
    const timer = window.setTimeout(() => invoke("searchMemory", { query: query.trim() }), query.trim() ? 220 : 0);
    return () => window.clearTimeout(timer);
  }, [query, indexed, invoke]);
  const searched = searchMemories(orderMemories(state.memories), query, state.memorySearch, indexed);
  const searching = Boolean(query.trim());
  const about = searched.memories.filter((memory) => memory.section === "aboutYou");
  const now = searched.memories.filter((memory) => memory.section === "rightNow");
  const calendar = state.connectors.find((connector) => connector.id === "calendar");
  const sources = state.memorySources ?? [];
  const onThisMac = sources.filter((source) => source.files.length > 0);
  const needExport = sources.filter((source) => source.files.length === 0);

  const importFrom = (source?: MemorySource) => {
    const text = source ? `import my memory from ${source.name}` : "import my memory from other assistants";
    invoke("ask", { text });
    notify("Preparing the import", source ? `Reading what ${source.name} remembers` : "Reading every assistant on this Mac", "info");
  };

  const [tooShort, setTooShort] = useState(false);
  const add = () => {
    // mirror the native rules (OkidokiStore.addMemory) so the toast only claims what gets saved
    const cleaned = text.trim().replace(/^[.,;: ]+|[.,;: ]+$/g, "");
    if (cleaned.length <= 2) {
      setTooShort(true);
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

  const pin = (memory: Memory) => {
    invoke("pinMemory", { id: memory.id, pinned: !memory.pinned });
    notify(memory.pinned ? "Unpinned" : "Pinned", memory.pinned ? "Used when it fits the request" : "Goes with every request", "info");
  };

  const fillExample = (target: Section) => {
    setSection(target);
    setText(SECTIONS[target].example);
  };

  return (
    <div className="memory-page">
      <PageTitle
        title="Memory"
        subtitle="What okidoki knows about you, kept on this Mac."
        trailing={state.services ? <MemoryIndexBadge services={state.services} onFix={isNative() ? () => (window.location.hash = "#/keys") : undefined} /> : null}
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
          {/* ⌘↩ remembers it, as in the chat composer. */}
          <div
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.metaKey && !isComposing(event)) {
                event.preventDefault();
                add();
              }
            }}
          >
            <TextArea
              value={text}
              onChange={(value) => {
                setText(value);
                setTooShort(false);
              }}
              rows={3}
              placeholder={SECTIONS[section].placeholder}
            />
          </div>
          {tooShort ? (
            <em className="field-error" role="alert">
              Too short to remember. Add a few more words.
            </em>
          ) : null}
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
          <p className="memory-nudges-copy">A quick heads-up before meetings, using only apps you’ve connected.</p>
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

      {state.memories.length ? (
        <div className="memory-search reveal reveal-3">
          <TextField value={query} onChange={setQuery} icon="search" placeholder={indexed ? "Search memories by meaning or words" : "Search memories"} />
          {searching ? (
            <span className="memory-search-count" aria-live="polite">
              {searched.memories.length} {searched.memories.length === 1 ? "match" : "matches"}
              {searched.related.size ? ` · ${searched.related.size} by meaning` : ""}
              {searched.pending ? " · looking…" : ""}
            </span>
          ) : (
            <span className="memory-search-count">
              {state.memories.length} {state.memories.length === 1 ? "memory" : "memories"}
            </span>
          )}
          {searching ? <IconButton icon="x" label="Clear search" size={14} onClick={() => setQuery("")} /> : null}
        </div>
      ) : null}

      <div className="memory-lists">
        <MemoryList section="aboutYou" memories={about} searching={searching} related={searched.related} onEdit={startEdit} onDelete={remove} onPin={pin} onExample={fillExample} />
        <MemoryList section="rightNow" memories={now} searching={searching} related={searched.related} onEdit={startEdit} onDelete={remove} onPin={pin} onExample={fillExample} />
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
              if (editText.trim() !== editing.text) {
                invoke("updateMemory", { id: editing.id, text: editText.trim() });
                notify("Memory updated", editText.trim());
              }
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
  searching,
  related,
  onEdit,
  onDelete,
  onPin,
  onExample,
}: {
  section: Section;
  memories: Memory[];
  searching: boolean;
  related: Set<string>;
  onEdit: (memory: Memory) => void;
  onDelete: (memory: Memory) => void;
  onPin: (memory: Memory) => void;
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
                  {memory.pinned ? <span className="memory-flag">Pinned · </span> : null}
                  {related.has(memory.id) ? <span className="memory-flag">Related · </span> : null}
                  {memory.learned ? <span className="memory-flag memory-learned" title="okidoki picked this up on its own. Edit or delete it if it's wrong.">Learned · </span> : null}
                  {memorySourceLabel(memory)} · {relativeTime(memory.updatedAt)}
                </span>
              </button>
              <div className={cx("memory-actions", memory.pinned && "is-pinned")}>
                <IconButton icon="pin" label={memory.pinned ? "Unpin" : "Pin: send with every request"} size={14} className={cx(memory.pinned && "is-on")} onClick={() => onPin(memory)} />
                <IconButton icon="edit" label="Edit" size={14} onClick={() => onEdit(memory)} />
                <IconButton icon="trash" label="Delete" size={14} onClick={() => onDelete(memory)} />
              </div>
            </div>
          ))}
        </div>
      ) : searching ? (
        <div className="memory-empty">
          <strong>No matches</strong>
          <span>Nothing here matches that search.</span>
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
export function MemoryIndexBadge({ services, onFix }: { services: ServicesState; onFix?: () => void }) {
  const memory = services.memory;
  // Without a key, recall still works: notes that share words with the request go to the model.
  if (!memory.configured) {
    const label = (
      <>
        <i />
        Moss off · matching by words
      </>
    );
    // Keys live in the Mac app's Settings; on the web there's nowhere to send you.
    return onFix ? (
      <button className="memory-index is-off" onClick={onFix} title="Add a Moss key in Settings › Keys to recall by meaning">
        {label}
      </button>
    ) : (
      <span className="memory-index is-off">{label}</span>
    );
  }
  if (memory.error) {
    return onFix ? (
      <button className="memory-index is-warn" onClick={onFix} title={`${memory.error} · open Settings › Keys`}>
        <i />
        Moss error
      </button>
    ) : (
      <span className="memory-index is-warn" title={memory.error}>
        <i />
        Moss error
      </span>
    );
  }
  if (!memory.ready) {
    return (
      <span className="memory-index" title="Building the index on this Mac">
        <i />
        Moss indexing…
      </span>
    );
  }
  const items = memory.documents;
  const parts = [`${memory.notes} memories`, `${memory.messages} recent turns`, `${memory.runs ?? 0} tasks`, `${memory.skills ?? 0} skills`];
  return (
    <span className="memory-index is-on" title={parts.join(" · ")}>
      <i />
      Moss · {items} item{items === 1 ? "" : "s"} indexed{memory.lastSyncAt ? ` · ${relativeTime(memory.lastSyncAt)}` : ""}
    </span>
  );
}
