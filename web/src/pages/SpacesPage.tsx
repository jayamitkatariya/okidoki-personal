import { useEffect, useMemo, useRef, useState } from "react";
import { useDashboard } from "../store";
import { clockLabel, cx, dayLabel, duration, formatBytes, relativeTime } from "../lib";
import type { Page } from "../nav";
import type { Account, RunStatus } from "../types";
import type { Job, JobStatus, Space, SpaceMember, SpaceMessage, VaultFile, WorkerPolicy } from "../enterprise";
import { useEnsureWorker, workerHint } from "../worker";
import { VaultFileRow } from "./VaultPage";
import { SharedSkillTile } from "./SkillsPage";
import { Avatar, Button, Chip, ConfirmModal, Empty, IconButton, isComposing, Markdown, Modal, PageTitle, PixelIcon, RiskBadge, Segmented, StatusBadge, TextField, type ConfirmRequest } from "../components/ui";

type SpaceTab = "chat" | "files" | "skills" | "runs";

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
  return <SpacesLayout go={go} />;
}

function SpacesLayout({ go }: { go: (page: Page) => void }) {
  const { enterprise, spaceId, selectSpace, notify } = useDashboard();
  const { spaces, messages, jobs } = enterprise;
  const ensureWorker = useEnsureWorker();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  // The selection always comes from the visible list, so the highlighted row and the chat agree.
  const current = spaces.find((space) => space.id === spaceId) ?? spaces.find((space) => space.joined) ?? spaces[0] ?? null;
  useEffect(() => {
    if (current && current.id !== spaceId) selectSpace(current.id);
  }, [current, spaceId, selectSpace]);

  // The notch, the cursor card and Home open a specific space; it may arrive before the page mounted.
  useEffect(() => {
    const pending = window as unknown as { __okidokiFocusSpace?: string };
    if (pending.__okidokiFocusSpace) selectSpace(pending.__okidokiFocusSpace);
    delete pending.__okidokiFocusSpace;
    const onFocus = (event: Event) => {
      selectSpace((event as CustomEvent<string>).detail);
      delete pending.__okidokiFocusSpace;
    };
    window.addEventListener("okidoki-focus-space", onFocus);
    return () => window.removeEventListener("okidoki-focus-space", onFocus);
  }, [selectSpace]);

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
      ensureWorker();
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
            <SpaceChat space={current} messages={messages} jobs={jobs} go={go} />
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

function SpaceChat({ space, messages, jobs, go }: { space: Space; messages: SpaceMessage[]; jobs: Job[]; go: (page: Page) => void }) {
  const { enterprise, selectSpace, notify, state, native, account } = useDashboard();
  const jobById = useMemo(() => new Map(jobs.map((job) => [job.id, job])), [jobs]);
  const inSpace = enterprise.workers.filter((worker) => worker.online && space.members.some((member) => member.userId === worker.userId));
  const ready = inSpace.filter((worker) => (worker.state ?? "ready") === "ready");
  const paused = inSpace.length - ready.length;
  const workersLine = ready.length ? `${ready.length} ${ready.length === 1 ? "Mac" : "Macs"} ready${paused ? `, ${paused} paused` : ""}` : paused ? `${paused} ${paused === 1 ? "Mac" : "Macs"} paused` : "no worker online";
  const solo = space.members.length === 1;
  const ensureWorker = useEnsureWorker();
  const [tab, setTab] = useState<SpaceTab>("chat");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Attachments go to the space's vault folder, then into the chat as a file line.
  const attach = async (list: FileList | File[]) => {
    const picked = Array.from(list);
    if (!picked.length) return;
    setAttaching((current) => [...current, ...picked.map((file) => file.name)]);
    for (const file of picked) {
      try {
        const saved = await enterprise.actions.uploadFile(space.id, file);
        await enterprise.actions.shareFile(saved.id, space.id);
        stickToBottom.current = true;
      } catch (error) {
        notify("Couldn't attach", `${file.name}: ${error instanceof Error ? error.message : String(error)}`, "warning");
      } finally {
        setAttaching((current) => {
          const index = current.indexOf(file.name);
          return index < 0 ? current : [...current.slice(0, index), ...current.slice(index + 1)];
        });
      }
    }
  };

  // The composer grows with what's typed, up to a few lines, like the ask box on Home.
  useEffect(() => {
    const node = composerRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }, [draft]);

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
    setTab("chat");
    composerRef.current?.focus();
  }, [space.id]);

  // Loading an earlier page prepends lines; keep what's on screen where it is.
  const loadEarlier = async () => {
    const node = scrollRef.current;
    const before = node ? node.scrollHeight - node.scrollTop : 0;
    stickToBottom.current = false;
    try {
      await enterprise.actions.loadEarlier();
      requestAnimationFrame(() => {
        if (node) node.scrollTop = node.scrollHeight - before;
      });
    } catch (error) {
      notify("Couldn't load earlier messages", error instanceof Error ? error.message : String(error), "warning");
    }
  };

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
  const mine = enterprise.workers.find((item) => item.isYou);
  const hint = workerHint({ native, enabled: state.settings.workerEnabled === true, state: native ? state.worker?.state ?? mine?.state : mine?.state, readyElsewhere: ready.filter((item) => !item.isYou).length, workAccountName: account.name });
  const spaceFiles = enterprise.files.filter((file) => file.spaceId === space.id);
  const spaceSkills = enterprise.sharedSkills.filter((skill) => skill.spaceId === space.id);
  const lastMember = space.members.length === 1 && space.members[0].isYou;

  return (
    <>
      <header className="space-head">
        <Avatar account={spaceAccount(space)} size={34} />
        <div className="space-head-copy">
          <h2>{space.name}</h2>
          <p>
            {space.members.length} {space.members.length === 1 ? "member" : "members"} · {WORKER_LABEL[worker]} ·{" "}
            {ready.length || !hint.action ? (
              workersLine
            ) : (
              <button className="space-head-link" onClick={() => (hint.action === "enable" ? ensureWorker() : go("settings"))}>
                {workersLine} · {hint.action === "enable" ? "let this Mac take jobs" : "switch account"}
              </button>
            )}
          </p>
        </div>
        <Segmented
          compact
          options={[
            { value: "chat", label: "Chat" },
            { value: "files", label: spaceFiles.length ? `Files · ${spaceFiles.length}` : "Files" },
            { value: "skills", label: spaceSkills.length ? `Skills · ${spaceSkills.length}` : "Skills" },
            { value: "runs", label: jobs.length ? `Runs · ${jobs.length}` : "Runs" },
          ]}
          value={tab}
          onChange={(value) => setTab(value as SpaceTab)}
        />
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

      {tab === "files" ? (
        <SpaceFiles files={spaceFiles} onPick={() => fileRef.current?.click()} setConfirm={setConfirm} />
      ) : tab === "skills" ? (
        <div className="space-pane">
          {spaceSkills.length ? (
            <div className="skills-grid">
              {spaceSkills.map((skill) => (
                <SharedSkillTile key={skill.id} skill={skill} replaying={Boolean(state.watching?.replaying)} setConfirm={setConfirm} />
              ))}
            </div>
          ) : (
            <Empty icon="spark" title="No skills shared here yet">
              Share one from the Skills page with the share button on its card, picking {space.name} as the target. Anyone in the space can then replay it on their Mac.
            </Empty>
          )}
        </div>
      ) : tab === "runs" ? (
        <div className="space-pane">
          {jobs.length ? (
            <div className="space-runs">
              {jobs.map((job) => (
                <JobCard key={job.id} job={job} go={go} />
              ))}
            </div>
          ) : (
            <Empty icon="bolt" title="Nothing run here yet">
              {solo ? "Type what you need in the chat and this Mac does it." : "Mention @okidoki in the chat to hand it work."}
            </Empty>
          )}
        </div>
      ) : null}

      <div
        className={cx("space-messages", tab !== "chat" && "is-hidden", dragging && "is-over")}
        ref={scrollRef}
        onScroll={onScroll}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          // Children fire dragleave too (the drop overlay itself is one); only leaving the container counts.
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
          setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void attach(event.dataTransfer.files);
        }}
      >
        {enterprise.hasEarlier ? (
          <div className="space-earlier">
            <Button size="sm" variant="ghost" disabled={enterprise.loadingEarlier} onClick={() => void loadEarlier()}>
              {enterprise.loadingEarlier ? "Loading…" : "Load earlier messages"}
            </Button>
          </div>
        ) : null}
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
                {group.messages.map((message) =>
                  message.kind === "run" ? (
                    <JobCard key={message.id} job={message.runId ? jobById.get(message.runId) : undefined} settled={jobs.length > 0} go={go} />
                  ) : message.kind === "file" ? (
                    <div className="space-bubble space-file" key={message.id}>
                      <PixelIcon name="sticker" size={15} />
                      {message.file?.url ? (
                        <a href={message.file.url} target="_blank" rel="noreferrer" download={message.file.name}>
                          {message.file.name}
                        </a>
                      ) : (
                        <span className="is-gone">{message.text} (deleted)</span>
                      )}
                      {message.file ? <em>{formatBytes(message.file.size)}</em> : null}
                    </div>
                  ) : (
                    <div className={cx("space-bubble", message.kind !== "text" && `is-${message.kind}`)} key={message.id}>
                      <Markdown text={message.text} />
                    </div>
                  ),
                )}
              </div>
            </div>
          ),
        )}
        {!messages.length ? (
          <div className="space-system">
            <span>{solo ? "It's just you here, so whatever you type goes straight to okidoki." : "Say hello. Mention @okidoki to give the agent work."}</span>
          </div>
        ) : null}
        {attaching.length ? (
          <div className="space-group is-you">
            <span className="space-agent-mark">
              <PixelIcon name="spinner" size={15} />
            </span>
            <div className="space-group-body">
              <div className="space-bubble space-file is-ghost">
                <PixelIcon name="clip" size={15} />
                <span>Attaching {attaching.join(", ")}…</span>
              </div>
            </div>
          </div>
        ) : null}
        {dragging ? (
          <div className="space-drop">
            <PixelIcon name="clip" size={18} />
            <span>Drop to share in {space.name}</span>
          </div>
        ) : null}
      </div>

      <footer className={cx("space-composer", tab !== "chat" && "is-hidden")}>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            // Cleared so the same file can be chosen again (after a failed upload, say).
            event.target.value = "";
            void attach(files);
          }}
        />
        <IconButton icon="clip" label="Attach a file" onClick={() => fileRef.current?.click()} />
        <textarea
          ref={composerRef}
          className="textarea space-composer-input"
          rows={1}
          value={draft}
          placeholder={solo ? `Tell okidoki what to do — it's just you in ${space.name}` : `Message ${space.name} — @okidoki to hand it work`}
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
          setConfirm(
            lastMember
              ? {
                  title: `You're the only one in ${space.name}`,
                  detail: "Leaving would strand its chat and files with nobody to see them. Delete the space instead? This can't be undone.",
                  action: "Delete space",
                  onConfirm: () => {
                    setSettingsOpen(false);
                    void enterprise.actions.deleteSpace(space.id).then(() => selectSpace(null)).catch((error: Error) => notify("That didn't work", error.message, "warning"));
                  },
                }
              : {
                  title: `Leave ${space.name}?`,
                  detail: "You stop seeing its chat and files. You can join again from the list.",
                  action: "Leave",
                  onConfirm: () => {
                    setSettingsOpen(false);
                    void enterprise.actions.leaveSpace(space.id).then(() => selectSpace(null)).catch((error: Error) => notify("That didn't work", error.message, "warning"));
                  },
                },
          )
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

const JOB_TO_RUN: Record<JobStatus, RunStatus> = {
  queued: "previewing",
  accepted: "previewing",
  running: "running",
  waiting: "waiting",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

function JobCard({ job, settled = true, go }: { job: Job | undefined; settled?: boolean; go: (page: Page) => void }) {
  const { enterprise, notify, state, native, account } = useDashboard();
  const ensureWorker = useEnsureWorker();
  const [busy, setBusy] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  if (!job) {
    // The chat keeps more history than the jobs query (its latest hundred): an older run's card has
    // nothing to show but shouldn't look like it's still going.
    return (
      <div className="space-bubble job-card is-ghost">
        <em>{settled ? "An earlier run; its details have scrolled out of reach." : "Working on it…"}</em>
      </div>
    );
  }
  const act = async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
    } catch (error) {
      notify("That didn't work", error instanceof Error ? error.message : String(error), "warning");
    } finally {
      setBusy(false);
    }
  };
  const active = !["done", "failed", "cancelled"].includes(job.status);
  // The run exists on this Mac when it's the worker: the Runs page can show every line of it.
  const local = native && job.runClientId ? state.runs.find((run) => run.id === job.runClientId) : undefined;
  const where =
    job.status === "queued"
      ? "waiting for a worker Mac"
      : `${job.workerName ? `on ${job.workerName}'s Mac` : "on a worker"}${job.workerDevice ? ` · ${job.workerDevice}` : ""}`;
  const took = job.startedAt ? duration(iso(job.startedAt), job.endedAt ? iso(job.endedAt) : null) : null;
  const doneSteps = job.steps.filter((step) => step.status === "done").length;
  const mine = enterprise.workers.find((worker) => worker.isYou);
  const readyElsewhere = enterprise.workers.filter((worker) => worker.online && !worker.isYou && (worker.state ?? "ready") === "ready").length;
  const hint = job.status === "queued" ? workerHint({ native, enabled: state.settings.workerEnabled === true, state: native ? state.worker?.state ?? mine?.state : mine?.state, readyElsewhere, workAccountName: account.name }) : null;

  return (
    <div className={cx("space-bubble job-card", `is-${job.status}`)}>
      <div className="job-head">
        <StatusBadge status={JOB_TO_RUN[job.status]} />
        <strong>{job.title || job.prompt}</strong>
        {took ? <time>{took}</time> : null}
      </div>
      <p className="job-meta">
        Asked by {job.requestedBy} · {where}
      </p>
      {hint?.text ? (
        <div className="job-stuck">
          <PixelIcon name="clock" size={13} />
          <span>{hint.text}</span>
          {hint.action === "enable" ? (
            <Button size="sm" variant="primary" onClick={() => ensureWorker()}>
              Let this Mac take it
            </Button>
          ) : hint.action === "switch" ? (
            <Button size="sm" variant="secondary" onClick={() => go("settings")}>
              Open Settings
            </Button>
          ) : null}
        </div>
      ) : null}
      {job.summary && job.status !== "waiting" ? <p className="job-summary">{job.summary}</p> : null}

      {job.status === "waiting" && job.preview ? (
        <div className="job-approval">
          <div className="job-approval-head">
            <RiskBadge risk={job.preview.risk} />
            <span>{job.preview.summary}</span>
          </div>
          {job.preview.steps?.length ? (
            <ol className="job-plan">
              {job.preview.steps.slice(0, 8).map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          ) : null}
          {job.decision ? (
            <em className="job-decided">{job.decision === "approve" ? "Approved — going ahead." : "Declined."}</em>
          ) : (
            <div className="job-actions">
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void act(() => enterprise.actions.decide(job.id, "approve"))}>
                Do it
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => enterprise.actions.decide(job.id, "decline"))}>
                Not now
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {job.steps.length ? (
        <details className="job-steps" open={active}>
          <summary>
            {doneSteps} of {job.steps.length} steps
          </summary>
          <ul>
            {job.steps.map((step, index) => (
              <li key={index} className={cx(step.status && `is-${step.status}`)}>
                <PixelIcon name={step.status === "done" ? "check" : step.status === "failed" ? "x" : step.status === "running" ? "spinner" : "minus"} size={12} />
                <span>{step.title}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {job.output ? (
        <details className="job-output" open={showOutput} onToggle={(event) => setShowOutput((event.target as HTMLDetailsElement).open)}>
          <summary>Output</summary>
          <pre>{job.output}</pre>
        </details>
      ) : null}

      <div className="job-foot">
        {local ? (
          <button
            className="job-link"
            onClick={() => {
              (window as unknown as { __okidokiFocusRun?: string }).__okidokiFocusRun = local.id;
              go("runs");
            }}
          >
            Open in Runs <PixelIcon name="arrow" size={12} />
          </button>
        ) : null}
        {active ? (
          <button className="job-link is-danger" disabled={busy} onClick={() => void act(() => enterprise.actions.cancelJob(job.id))}>
            Cancel
          </button>
        ) : null}
      </div>
    </div>
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

function SpaceFiles({ files, onPick, setConfirm }: { files: VaultFile[]; onPick: () => void; setConfirm: (request: ConfirmRequest) => void }) {
  return (
    <div className="space-pane">
      <div className="space-pane-head">
        <p className="form-hint">Files shared in this space live in the Vault under its folder. Attaching one in the chat puts it here too.</p>
        <Button size="sm" variant="secondary" icon="clip" onClick={onPick}>
          Add a file
        </Button>
      </div>
      {files.length ? (
        <div className="pref-group">
          {files.map((file) => (
            <VaultFileRow key={file.id} file={file} setConfirm={setConfirm} />
          ))}
        </div>
      ) : (
        <Empty icon="folder" title="No files here yet">
          Drop a file onto the chat or use the paperclip to share one with the space.
        </Empty>
      )}
    </div>
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
