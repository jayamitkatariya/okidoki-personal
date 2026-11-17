import { useState } from "react";
import { useDashboard } from "../store";
import { cx } from "../lib";
import { PixelIcon } from "../components/ui";
import type { Memory } from "../types";

/** Where a memory came from, in words. */
export function memorySourceLabel(memory: Memory): string {
  const source = memory.source ?? "";
  if (memory.learned || source === "learned") return memory.runID ? "from a task" : "from a chat";
  switch (source) {
    case "you":
      return "added by you";
    case "said":
    case "control":
    case "chat":
    case "summon":
    case "typed":
      return "you said";
    case "agent":
      return "from the CLI";
    case "browser":
      return "from a browser task";
    case "onboarding":
      return "from setup";
    default:
      return source;
  }
}

/** The memories one turn saved, right under it: what was kept, with Undo and Edit. */
export function MemoryChips({ memories }: { memories: Memory[] }) {
  if (!memories.length) return null;
  return (
    <div className="mem-chips" role="status">
      {memories.map((memory) => (
        <MemoryChip key={memory.id} memory={memory} />
      ))}
    </div>
  );
}

function MemoryChip({ memory }: { memory: Memory }) {
  const { invoke, notify } = useDashboard();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.text);
  const label = memory.previousText ? "Updated memory" : memory.learned ? "Learned" : "Saved to memory";

  const save = () => {
    const text = draft.trim();
    setEditing(false);
    if (text && text !== memory.text) invoke("updateMemory", { id: memory.id, text });
  };

  return (
    <div className={cx("mem-chip", memory.learned && "is-learned")}>
      <PixelIcon name="memory" size={13} />
      <span className="mem-chip-label">{label}</span>
      {editing ? (
        <input
          className="mem-chip-input"
          value={draft}
          autoFocus
          aria-label="Edit memory"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
            if (event.key === "Escape") {
              setDraft(memory.text);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span className="mem-chip-text">
          {memory.text}
          {memory.previousText ? <em> (was: {memory.previousText})</em> : null}
        </span>
      )}
      {editing ? null : (
        <span className="mem-chip-actions">
          <button
            type="button"
            onClick={() => {
              setDraft(memory.text);
              setEditing(true);
            }}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => {
              invoke("undoMemory", { id: memory.id });
              notify(memory.previousText ? "Put back" : "Forgotten", memory.previousText ?? memory.text, "info");
            }}
          >
            Undo
          </button>
        </span>
      )}
    </div>
  );
}
