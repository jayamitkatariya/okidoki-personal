import { useEffect, useMemo, useRef, useState } from "react";
import { useDashboard } from "../store";
import { clockLabel, cx, dayLabel, relativeTime } from "../lib";
import type { Page } from "../nav";
import type { Account } from "../types";
import type { Space, SpaceMember, SpaceMessage, WorkerPolicy } from "../enterprise";
import { Avatar, Button, Chip, ConfirmModal, Empty, IconButton, isComposing, Markdown, Modal, PageTitle, PixelIcon, Segmented, TextField, type ConfirmRequest } from "../components/ui";

const WORKER_LABEL: Record<WorkerPolicy, string> = { thisMac: "This Mac", privateMac: "Private Mac", hostedVM: "Hosted VM" };
const WORKER_HINT: Record<WorkerPolicy, string> = {
  thisMac: "Jobs run on the Mac of whoever accepts them",
  privateMac: "Jobs run in a member's private Mac, in a window",
  hostedVM: "A VM in the cloud. Coming soon",
};
const AVATAR_COLORS = ["44E45E", "1FB57A", "3DDC97", "0B8A5E", "B8F26B", "8FB7FF", "F2B84B", "E97A6B"];

function personAccount(name: string, email: string, colorHex: string): Account {
  let hash = 0;
  for (const char of email || name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { id: email || name, name, email, kind: "work", colorHex: colorHex || AVATAR_COLORS[hash % AVATAR_COLORS.length], createdAt: "" };
}

function spaceAccount(space: Space): Account {
  return { id: space.id, name: space.name, email: "", kind: "work", colorHex: space.colorHex, createdAt: "" };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function SpacesPage({ go }: { go: (page: Page) => void }) {
  const { cloud, enterprise } = useDashboard();

  const gate = (icon: string, title: string, body: string, action: React.ReactNode) => (
    <div className="spaces-gate">
      <PageTitle title="Spaces" subtitle="Group chats with your colleagues, an agent and a shared worker." />
      <Empty icon={icon} title={title} action={action}>
        {body}
      </Empty>
    </div>
  );

  if (cloud.status === "off") {
    return gate(
      "link",
      "Turn on sync to use spaces",
      "Spaces live on Convex so everyone in them sees the same chat. Turn on sync in Settings and sign in with your sync login.",
      <Button variant="primary" size="sm" onClick={() => go("settings")}>
        Open Settings
      </Button>,
    );
  }
  if (enterprise.status === "signedOut") {
    return gate(
      "user",
      "Sign in to your sync login",
      "Spaces follow your organization, which follows your sync login.",
      <Button variant="primary" size="sm" onClick={() => go("settings")}>
        Sign in
      </Button>,
    );
  }
  if (enterprise.status !== "ready") {
    return gate("spinner", "Connecting…", "Checking your organization on your deployment.", null);
  }
  if (!enterprise.view) {
    return gate(
      "building",
      "Link this account to your company",
      "Spaces belong to an organization. Create one, join with a code, or ask to join by email domain on the Team page.",
      <Button variant="primary" size="sm" icon="people" onClick={() => go("team")}>
        Open Team
      </Button>,
    );
  }
  return <SpacesLayout />;
}

function SpacesLayout() {
  const { enterprise, spaceId, selectSpace, notify } = useDashboard();
  const { spaces, messages } = enterprise;
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  // The selection always comes from the visible list, so the highlighted row and the chat agree.
  const current = spaces.find((space) => space.id === spaceId) ?? spaces.find((space) => space.joined) ?? spaces[0] ?? null;
  useEffect(() => {
    if (current && current.id !== spaceId) selectSpace(current.id);
  }, [current, spaceId, selectSpace]);

  const attempt = async (task: () => Promise<unknown>, done?: [string, string?]) => {
    setBusy(true);
    try {
      await task();
      if (done) notify(done[0], done[1]);
    } catch (error) {
      notify("That didn't work", error instanceof Error ? error.message : String(error), "warning");
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    void attempt(async () => {
      const result = await enterprise.actions.createSpace(newName);
      selectSpace(result.spaceId);
      setCreating(false);
      setNewName("");
    }, ["Space created", newName.trim()]);

  return (
    <div className="spaces">
      <aside className="spaces-list">
        <div className="spaces-list-head">
          <h2 className="page-title-sm">Spaces</h2>
          <Button size="sm" variant="primary" icon="plus" onClick={() => setCreating(true)}>
            New
          </Button>
        </div>
        <div className="spaces-rows">
          {spaces.length ? (
            spaces.map((space) => (
              <button key={space.id} className={cx("space-row", current?.id === space.id && "is-selected", !space.joined && "is-open")} onClick={() => selectSpace(space.id)}>
                <Avatar account={spaceAccount(space)} size={32} />
                <span className="space-row-copy">
                  <span className="space-row-top">
                    <strong>{space.name}</strong>
                    {space.lastMessage ? <time>{relativeTime(iso(space.lastMessageAt))}</time> : null}
                  </span>
                  <em>{space.joined ? space.lastMessage || `${space.members.length} ${space.members.length === 1 ? "member" : "members"}` : `${space.members.length} ${space.members.length === 1 ? "member" : "members"} · not joined`}</em>
                </span>
                {space.unread ? <span className="space-row-unread">{space.unread > 99 ? "99+" : space.unread}</span> : null}
              </button>
            ))
          ) : (
            <div className="spaces-none">
              <PixelIcon name="chat" size={20} />
              <p>No spaces yet. Make one for a team, a project or a client.</p>
            </div>
          )}
        </div>
      </aside>

      <section className="spaces-chat">
        {current ? (
          current.joined ? (
            <SpaceChat space={current} messages={messages} />
          ) : (
            <div className="spaces-chat-empty">
              <Empty
                icon="chat"
                title={`Join ${current.name}`}
                action={
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => void attempt(() => enterprise.actions.joinSpace(current.id), ["Joined", current.name])}>
                    Join space
                  </Button>
                }
              >
                {current.members.length ? `${current.members.map((member) => member.name).slice(0, 4).join(", ")}${current.members.length > 4 ? ` and ${current.members.length - 4} more` : ""} ${current.members.length === 1 ? "is" : "are"} in here.` : "Nobody's in here yet."}{" "}
                Join to read the chat, share files and give the agent work.
              </Empty>
            </div>
          )
        ) : (
          <div className="spaces-chat-empty">
            <Empty
              icon="chat"
              title="Your first space"
              action={
                <Button variant="primary" size="sm" icon="plus" onClick={() => setCreating(true)}>
                  New space
                </Button>
              }
            >
              A space is a group chat with colleagues, an okidoki agent that takes work, and a worker Mac that does it. Files and skills you share stay with the space.
            </Empty>
          </div>
        )}
      </section>

      <Modal open={creating} onClose={() => setCreating(false)} title="New space" subtitle="Anyone in your organization can find and join it." width={420}>
        <div className="form-stack">
          <label className="form-label">Name</label>
          <TextField value={newName} onChange={setNewName} placeholder="Finance, Launch week, Acme account…" autoFocus onEnter={() => newName.trim() && create()} />
        </div>
        <footer className="modal-actions">
          <Button variant="ghost" onClick={() => setCreating(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!newName.trim() || busy} onClick={create}>
            Create
          </Button>
        </footer>
      </Modal>
    </div>
  );
}

function SpaceChat({ space, messages }: { space: Space; messages: SpaceMessage[] }) {
  const { enterprise, selectSpace, notify, state } = useDashboard();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Reading the chat marks it read; new messages that arrive while it's open do too.
  const latest = messages[messages.length - 1]?.id ?? "";
  useEffect(() => {
    if (space.unread > 0 || latest) void enterprise.actions.markRead(space.id).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space.id, latest]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node && stickToBottom.current) node.scrollTop = node.scrollHeight;
  }, [messages, space.id]);

  useEffect(() => {
    stickToBottom.current = true;
    setDraft("");
    composerRef.current?.focus();
  }, [space.id]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await enterprise.actions.send(space.id, text);
      setDraft("");
      stickToBottom.current = true;
    } catch (error) {
      notify("Not sent", error instanceof Error ? error.message : String(error), "warning");
    } finally {
      setSending(false);
      composerRef.current?.focus();
    }
  };

  const grouped = useMemo(() => groupMessages(messages), [messages]);
  const worker = (space.workerPolicy || "thisMac") as WorkerPolicy;

  return (
    <>
      <header className="space-head">
        <Avatar account={spaceAccount(space)} size={34} />
        <div className="space-head-copy">
          <h2>{space.name}</h2>
          <p>
            {space.members.length} {space.members.length === 1 ? "member" : "members"} · worker: {WORKER_LABEL[worker]}
          </p>
        </div>
        <div className="space-head-people" aria-label="Members">
          {space.members.slice(0, 6).map((member) => (
            <span key={member.userId} title={member.name} className="space-head-person">
              <Avatar account={personAccount(member.name, member.email, member.colorHex)} size={24} />
            </span>
          ))}
          {space.members.length > 6 ? <span className="space-head-more">+{space.members.length - 6}</span> : null}
        </div>
        <Chip tone={worker === "thisMac" ? "green" : worker === "privateMac" ? "blue" : "amber"}>{WORKER_LABEL[worker]}</Chip>
        <IconButton icon="gear" label="Space settings" onClick={() => setSettingsOpen(true)} />
      </header>

      <div className="space-messages" ref={scrollRef} onScroll={onScroll}>
        {grouped.map((group) =>
          group.kind === "day" ? (
            <div className="space-day" key={group.key}>
              <span>{group.label}</span>
            </div>
          ) : group.kind === "system" ? (
            <div className="space-system" key={group.key}>
              {group.messages.map((message) => (
                <span key={message.id}>{message.text}</span>
              ))}
            </div>
          ) : (
            <div className={cx("space-group", group.author === "agent" && "is-agent", group.isYou && "is-you")} key={group.key}>
              {group.author === "agent" ? (
                <span className="space-agent-mark">
                  <PixelIcon name="spark" size={15} />
                </span>
              ) : (
                <Avatar account={personAccount(group.name, group.email, group.colorHex)} size={28} />
              )}
              <div className="space-group-body">
                <div className="space-group-meta">
                  <strong>{group.author === "agent" ? "okidoki" : group.isYou ? "You" : group.name}</strong>
                  <time>{clockLabel(iso(group.messages[0].createdAt))}</time>
                </div>
                {group.messages.map((message) => (
                  <div className={cx("space-bubble", message.kind !== "text" && `is-${message.kind}`)} key={message.id}>
                    <Markdown text={message.text} />
                  </div>
                ))}
              </div>
            </div>
          ),
        )}
        {!messages.length ? (
          <div className="space-system">
            <span>Say hello. Mention @okidoki to give the agent work.</span>
          </div>
        ) : null}
      </div>

      <footer className="space-composer">
        <textarea
          ref={composerRef}
          className="textarea space-composer-input"
          rows={1}
          value={draft}
          placeholder={`Message ${space.name} — @okidoki to hand it work`}
          aria-label="Message"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !isComposing(event)) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <Button variant="primary" size="sm" icon="arrow" disabled={!draft.trim() || sending} onClick={() => void send()}>
          Send
        </Button>
      </footer>

      <SpaceSettings
        open={settingsOpen}
        space={space}
        onClose={() => setSettingsOpen(false)}
        privateMacReady={Boolean(state.privateMac?.supported)}
        onLeave={() =>
          setConfirm({
            title: `Leave ${space.name}?`,
            detail: "You stop seeing its chat and files. You can join again from the list.",
            action: "Leave",
            onConfirm: () => {
              setSettingsOpen(false);
              void enterprise.actions.leaveSpace(space.id).then(() => selectSpace(null)).catch((error: Error) => notify("That didn't work", error.message, "warning"));
            },
          })
        }
        onDelete={() =>
          setConfirm({
            title: `Delete ${space.name}?`,
            detail: "Its chat and membership go with it, for everyone. This can't be undone.",
            action: "Delete space",
            onConfirm: () => {
              setSettingsOpen(false);
              void enterprise.actions.deleteSpace(space.id).then(() => selectSpace(null)).catch((error: Error) => notify("That didn't work", error.message, "warning"));
            },
          })
        }
      />
      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}

function SpaceSettings({ open, space, onClose, privateMacReady, onLeave, onDelete }: { open: boolean; space: Space; onClose: () => void; privateMacReady: boolean; onLeave: () => void; onDelete: () => void }) {
  const { enterprise, notify } = useDashboard();
  const [name, setName] = useState(space.name);
  const [worker, setWorker] = useState<WorkerPolicy>((space.workerPolicy || "thisMac") as WorkerPolicy);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName(space.name);
      setWorker((space.workerPolicy || "thisMac") as WorkerPolicy);
    }
  }, [open, space.name, space.workerPolicy]);
  const admin = enterprise.view?.role === "owner" || enterprise.view?.role === "admin";
  const mayDelete = space.role === "owner" || admin;
  const dirty = name.trim() !== space.name || worker !== space.workerPolicy;

  const save = async () => {
    setBusy(true);
    try {
      await enterprise.actions.updateSpace(space.id, { name, workerPolicy: worker });
      notify("Saved", name.trim());
      onClose();
    } catch (error) {
      notify("That didn't work", error instanceof Error ? error.message : String(error), "warning");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Space settings" subtitle={`${space.members.length} ${space.members.length === 1 ? "member" : "members"}`} width={480}>
      <div className="form-stack">
        <label className="form-label">Name</label>
        <TextField value={name} onChange={setName} />
        <label className="form-label">Worker</label>
        <Segmented
          options={[
            { value: "thisMac", label: "This Mac" },
            { value: "privateMac", label: "Private Mac" },
          ]}
          value={worker === "hostedVM" ? "thisMac" : worker}
          onChange={(value) => setWorker(value as WorkerPolicy)}
        />
        <p className="form-hint">
          {WORKER_HINT[worker]}
          {worker === "privateMac" && !privateMacReady ? " Set one up under Settings › Private Mac on the Mac that will run jobs." : ""} Hosted VM: coming soon.
        </p>
      </div>
      <div className="space-members-list">
        {space.members.map((member: SpaceMember) => (
          <div className="space-member" key={member.userId}>
            <Avatar account={personAccount(member.name, member.email, member.colorHex)} size={26} />
            <span>
              <strong>
                {member.name}
                {member.isYou ? " (you)" : ""}
              </strong>
              <em>{member.role === "owner" ? "Owner" : "Member"}</em>
            </span>
          </div>
        ))}
      </div>
      <footer className="modal-actions space-settings-actions">
        <Button variant="ghost" icon="logout" onClick={onLeave}>
          Leave
        </Button>
        {mayDelete ? (
          <Button variant="ghost" icon="trash" className="is-danger" onClick={onDelete}>
            Delete
          </Button>
        ) : null}
        <span className="spacer" />
        <Button variant="primary" disabled={!dirty || !name.trim() || busy} onClick={() => void save()}>
          Save
        </Button>
      </footer>
    </Modal>
  );
}

type MessageGroup =
  | { kind: "day"; key: string; label: string }
  | { kind: "system"; key: string; messages: SpaceMessage[] }
  | { kind: "run"; key: string; author: "user" | "agent"; name: string; email: string; colorHex: string; isYou: boolean; messages: SpaceMessage[] };

// Consecutive messages from one author inside five minutes share a header, like any chat.
export function groupMessages(messages: SpaceMessage[]): MessageGroup[] {
  const out: MessageGroup[] = [];
  let day = "";
  for (const message of messages) {
    const label = dayLabel(iso(message.createdAt));
    if (label !== day) {
      day = label;
      out.push({ kind: "day", key: `day-${message.createdAt}`, label });
    }
    const last = out[out.length - 1];
    if (message.author === "system") {
      if (last?.kind === "system") last.messages.push(message);
      else out.push({ kind: "system", key: `sys-${message.id}`, messages: [message] });
      continue;
    }
    const author = message.author === "agent" ? "agent" : "user";
    const sameRun =
      last?.kind === "run" &&
      last.author === author &&
      (author === "agent" || last.messages[0].authorId === message.authorId) &&
      message.createdAt - last.messages[last.messages.length - 1].createdAt < 5 * 60_000;
    if (sameRun && last.kind === "run") last.messages.push(message);
    else out.push({ kind: "run", key: `run-${message.id}`, author, name: message.name, email: "", colorHex: message.colorHex, isYou: message.isYou, messages: [message] });
  }
  return out;
}
