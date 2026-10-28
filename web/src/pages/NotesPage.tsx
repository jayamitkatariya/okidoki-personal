import { useEffect, useMemo, useRef, useState } from "react";
import { useDashboard } from "../store";
import { cx, relativeTime } from "../lib";
import type { Note } from "../types";
import { Button, ConfirmModal, IconButton, Markdown, PageTitle, PixelIcon, Segmented, TextArea, TextField, type ConfirmRequest } from "../components/ui";

/** Edits are saved a moment after typing stops, like any notes app. */
const SAVE_DELAY = 600;

function tagsFrom(text: string): string[] {
  return text.split(/[,\s]+/).map((tag) => tag.replace(/^#/, "").trim().toLowerCase()).filter(Boolean);
}

/** Asks the Notes page to open a note, the way Home opens a run. */
export function focusNote(id: string) {
  (window as unknown as { __okidokiFocusNote?: string }).__okidokiFocusNote = id;
}

function takeFocusNote(): string | null {
  const bridge = window as unknown as { __okidokiFocusNote?: string };
  const id = bridge.__okidokiFocusNote ?? null;
  delete bridge.__okidokiFocusNote;
  return id;
}

export function NotesPage() {
  const { state, invoke, notify } = useDashboard();
  const notes = state.notes ?? [];
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("all");
  // opens the note Home asked for, else the newest one, so the editor is never an empty pane
  const [selectedId, setSelectedId] = useState<string | null>(() => takeFocusNote() ?? notes[0]?.id ?? null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  // A note made here opens straight away once the Mac says which one it is.
  useEffect(() => {
    const onCreated = (event: Event) => setSelectedId((event as CustomEvent<string>).detail);
    window.addEventListener("okidokiNoteCreated", onCreated);
    return () => window.removeEventListener("okidokiNoteCreated", onCreated);
  }, []);

  const tags = useMemo(() => [...new Set(notes.flatMap((note) => note.tags))].sort(), [notes]);
  const shown = notes.filter((note) => {
    if (tag !== "all" && !note.tags.includes(tag)) return false;
    const q = query.trim().toLowerCase();
    return !q || note.title.toLowerCase().includes(q) || note.body.toLowerCase().includes(q) || note.tags.some((t) => t.includes(q));
  });
  const selected = notes.find((note) => note.id === selectedId) ?? null;

  const create = () => {
    invoke("addNote", { title: "untitled", body: "", tags: tag === "all" ? [] : [tag] });
  };

  const remove = (note: Note) =>
    setConfirm({
      title: `Delete “${note.title}”?`,
      detail: "It's removed from this Mac and from what okidoki can recall.",
      action: "Delete",
      onConfirm: () => {
        invoke("deleteNote", { id: note.id });
        if (selectedId === note.id) setSelectedId(null);
        notify("Deleted", note.title, "info");
      },
    });

  return (
    <div className="memory-page notes-page">
      <PageTitle
        title="Notes"
        subtitle="Jot things down here, or type “note: …” at the cursor. okidoki recalls them when they're relevant."
        trailing={
          <Button variant="primary" size="sm" icon="plus" onClick={create}>
            New note
          </Button>
        }
      />

      <div className="notes-layout">
        <section className="tile memory-list-tile reveal">
          <header className="tile-head">
            <h2>All notes</h2>
            {notes.length ? <span className="tile-count">{notes.length}</span> : null}
          </header>
          <TextField value={query} onChange={setQuery} icon="search" placeholder="Search notes" />
          {tags.length ? (
            <div className="notes-tags">
              <Segmented compact options={[{ value: "all", label: "All" }, ...tags.map((t) => ({ value: t, label: `#${t}` }))]} value={tag} onChange={setTag} />
            </div>
          ) : null}
          {shown.length ? (
            <div className="memory-list">
              {shown.map((note) => (
                <div className={cx("memory-item", note.id === selectedId && "is-selected")} key={note.id}>
                  <span className={cx("memory-dot", note.pinned && "is-now")} />
                  <button className="memory-copy" onClick={() => setSelectedId(note.id)} title="Open">
                    <span className="memory-text">{note.title}</span>
                    <span className="memory-meta">
                      {note.tags.length ? `${note.tags.map((t) => `#${t}`).join(" ")} · ` : ""}
                      {relativeTime(note.updatedAt)}
                    </span>
                  </button>
                  <div className="memory-actions">
                    <IconButton icon={note.pinned ? "check" : "plus"} label={note.pinned ? "Unpin" : "Pin to top"} size={14} onClick={() => invoke("updateNote", { id: note.id, pinned: !note.pinned })} />
                    <IconButton icon="trash" label="Delete" size={14} onClick={() => remove(note)} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="memory-empty">
              <strong>{notes.length ? "Nothing matches" : "No notes yet"}</strong>
              <span>{notes.length ? "Try another word or tag." : "Shake your mouse and type “note: call the dentist about Thursday”."}</span>
            </div>
          )}
        </section>

        {selected ? (
          <NoteEditor key={selected.id} note={selected} />
        ) : (
          <section className="tile memory-compose reveal reveal-2 notes-empty-editor">
            <PixelIcon name="note" size={22} />
            <strong>Pick a note, or start a new one</strong>
            <span>Markdown works: **bold**, lists, links.</span>
            <Button variant="secondary" size="sm" icon="plus" onClick={create}>
              New note
            </Button>
          </section>
        )}
      </div>
      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function NoteEditor({ note }: { note: Note }) {
  const { invoke } = useDashboard();
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [tagText, setTagText] = useState(note.tags.join(" "));
  const [mode, setMode] = useState<"write" | "read">(note.body ? "read" : "write");
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef({ title, body, tagText });
  latest.current = { title, body, tagText };

  const save = () => {
    window.clearTimeout(timer.current);
    const next = latest.current;
    if (next.title === note.title && next.body === note.body && next.tagText === note.tags.join(" ")) return;
    invoke("updateNote", { id: note.id, title: next.title, body: next.body, tags: tagsFrom(next.tagText) });
  };
  const schedule = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(save, SAVE_DELAY);
  };
  // Whatever is still pending goes in when the note is closed or another is opened.
  useEffect(() => () => save(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="tile memory-compose reveal reveal-2 notes-editor">
      <header className="tile-head">
        <input
          className="notes-title"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            schedule();
          }}
          onBlur={save}
          placeholder="Title"
          aria-label="Note title"
        />
        <span className="spacer" />
        <Segmented
          compact
          options={[
            { value: "write", label: "Write" },
            { value: "read", label: "Read" },
          ]}
          value={mode}
          onChange={(value) => {
            save();
            setMode(value as "write" | "read");
          }}
        />
      </header>
      {mode === "write" ? (
        <TextArea
          value={body}
          onChange={(value) => {
            setBody(value);
            schedule();
          }}
          rows={16}
          placeholder="Write anything. Markdown works."
        />
      ) : (
        <div className="notes-read" onDoubleClick={() => setMode("write")}>
          {body.trim() ? <Markdown text={body} /> : <span className="notes-hint">Empty. Double-click to write.</span>}
        </div>
      )}
      <div className="memory-compose-foot">
        <TextField
          value={tagText}
          onChange={(value) => {
            setTagText(value);
            schedule();
          }}
          icon="filter"
          placeholder="tags, like work ideas"
        />
        <span>
          <PixelIcon name="lock" size={13} />
          Saved on this Mac · {relativeTime(note.updatedAt)}
        </span>
      </div>
    </section>
  );
}
