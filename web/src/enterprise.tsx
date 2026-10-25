import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex, useConvexAuth, useMutation, useQuery } from "convex/react";
import { anyApi } from "convex/server";

// The enterprise side: organizations a sync login belongs to, and the one the current work
// account is linked to. Lives on Convex directly (it's shared between people), so it mounts
// inside the same auth provider as the sync login and reports up, like CloudBridge.

export type OrgRole = "owner" | "admin" | "member" | "agent";
export type EnterpriseStatus = "off" | "loading" | "signedOut" | "ready";

export interface OrgSummary {
  id: string;
  name: string;
  domain: string;
  plan: string;
  createdAt: number;
  role: OrgRole | "";
  memberCount: number;
  /** What a new member's Mac says the first time it links. Missing on older deployments. */
  welcome?: string;
}

export interface OrgMembershipSummary extends OrgSummary {
  status: "active" | "pending";
  linkedAccountId: string | null;
}

export interface OrgMember {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: OrgRole;
  status: "active" | "pending";
  accountName: string;
  colorHex: string;
  joinedAt: number;
  isYou: boolean;
}

export interface JoinCode {
  id: string;
  code: string;
  expiresAt: number;
  uses: number;
  maxUses: number;
  createdAt: number;
}

export interface OrgView {
  org: OrgSummary;
  role: OrgRole;
  members: OrgMember[];
  /** Join requests waiting on an admin. Empty unless you're one. */
  pending: OrgMember[];
  /** Live join codes. Empty unless you're an admin. */
  codes: JoinCode[];
}

export interface SpaceMember {
  userId: string;
  role: "owner" | "member";
  name: string;
  email: string;
  colorHex: string;
  isYou: boolean;
}

export type WorkerPolicy = "thisMac" | "privateMac" | "hostedVM";

export interface Space {
  id: string;
  name: string;
  colorHex: string;
  workerPolicy: WorkerPolicy;
  createdAt: number;
  lastMessageAt: number;
  lastMessage: string;
  joined: boolean;
  role: "owner" | "member" | "";
  unread: number;
  members: SpaceMember[];
}

export interface SpaceMessage {
  id: string;
  author: "user" | "agent" | "system";
  authorId: string | null;
  name: string;
  colorHex: string;
  kind: "text" | "run" | "file" | "approval" | "system";
  text: string;
  runId: string | null;
  fileId: string | null;
  /** For file lines: the file as it is now, with a fresh link; null once deleted. */
  file?: { name: string; size: number; mime: string; url: string | null } | null;
  createdAt: number;
  isYou: boolean;
}

export type JobStatus = "queued" | "accepted" | "running" | "waiting" | "done" | "failed" | "cancelled";

export interface JobStep {
  title: string;
  detail?: string;
  status?: string;
}

export interface JobPreview {
  summary: string;
  risk: "low" | "medium" | "high";
  steps?: string[];
  commands?: string[];
  apps?: string[];
}

export interface Job {
  id: string;
  spaceId: string;
  requestedBy: string;
  prompt: string;
  status: JobStatus;
  decision: "" | "approve" | "decline";
  workerName: string;
  workerDevice: string;
  runClientId: string | null;
  title: string;
  summary: string;
  output: string;
  steps: JobStep[];
  preview: JobPreview | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface WorkerInfo {
  userId: string;
  name: string;
  device: string;
  kind: "thisMac" | "privateMac";
  online: boolean;
  /** off · paused (its person is on a personal account) · ready. Missing on older deployments. */
  state?: "off" | "paused" | "ready";
  isYou: boolean;
  lastSeenAt: number;
}

/** A page of chat is this long; a full page means there may be more before it. */
export const CHAT_PAGE = 200;

export interface SharedSkill {
  id: string;
  spaceId: string | null;
  spaceName: string;
  sourceSkillId: string;
  name: string;
  summary: string;
  steps: unknown[];
  stepCount: number;
  requires: string[];
  params: string[];
  publishedBy: string;
  isMine: boolean;
  canUnpublish: boolean;
  version: number;
  versions: number;
  runCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface VaultFile {
  id: string;
  spaceId: string | null;
  spaceName: string;
  name: string;
  size: number;
  mime: string;
  url: string | null;
  uploadedBy: string;
  canDelete: boolean;
  createdAt: number;
}

export interface VaultCredential {
  id: string;
  spaceId: string | null;
  spaceName: string;
  site: string;
  username: string;
  ciphertext: string;
  iv: string;
  keyVersion: number;
  note: string;
  createdBy: string;
  canEdit: boolean;
  lastUsedAt: number | null;
  lastUsedBy: string;
  createdAt: number;
  updatedAt: number;
}

/** How far the organization has got, for admins: who's installed, who's online, who shares. */
export interface Rollout {
  members: {
    id: string;
    userId: string;
    name: string;
    email: string;
    role: OrgRole;
    installed: boolean;
    lastSeenAt: number | null;
    online: boolean;
    workerOn: boolean;
    device: string;
    skillsPublished: number;
    joinedAt: number;
  }[];
  installed: number;
  activeToday: number;
  workersOn: number;
  skillsShared: number;
  totalReplays: number;
  topSkills: { id: string; name: string; runCount: number; publishedBy: string }[];
}

export interface EnterpriseActions {
  setWelcome: (orgId: string, welcome: string) => Promise<void>;
  uploadFile: (spaceId: string | null, file: File) => Promise<{ id: string }>;
  deleteFile: (fileId: string) => Promise<void>;
  shareFile: (fileId: string, spaceId: string) => Promise<void>;
  saveCredential: (input: { credentialId?: string; spaceId: string | null; site: string; username: string; ciphertext: string; iv: string; keyVersion: number; note: string }) => Promise<{ id: string }>;
  deleteCredential: (credentialId: string) => Promise<void>;
  touchCredential: (credentialId: string) => Promise<void>;
  publishSkill: (spaceId: string | null, skill: { id: string; name: string; summary: string; steps: unknown[] }) => Promise<{ id: string; version: number }>;
  unpublishSkill: (sharedId: string) => Promise<void>;
  rollbackSkill: (sharedId: string) => Promise<void>;
  recordSkillRun: (sharedId: string) => Promise<void>;
  decide: (jobId: string, decision: "approve" | "decline") => Promise<void>;
  cancelJob: (jobId: string) => Promise<void>;
  createSpace: (name: string) => Promise<{ spaceId: string }>;
  joinSpace: (spaceId: string) => Promise<void>;
  leaveSpace: (spaceId: string) => Promise<void>;
  updateSpace: (spaceId: string, patch: { name?: string; workerPolicy?: WorkerPolicy; colorHex?: string }) => Promise<void>;
  deleteSpace: (spaceId: string) => Promise<void>;
  markRead: (spaceId: string) => Promise<void>;
  send: (spaceId: string, text: string) => Promise<void>;
  /** Fetches the page of chat before the oldest loaded line of the open space. */
  loadEarlier: () => Promise<void>;
  create: (name: string, domain: string) => Promise<void>;
  rename: (orgId: string, name: string, domain: string) => Promise<void>;
  join: (code: string) => Promise<{ name: string }>;
  link: (orgId: string) => Promise<void>;
  unlink: () => Promise<void>;
  requestByDomain: () => Promise<{ status: string; name: string }>;
  approve: (membershipId: string) => Promise<void>;
  decline: (membershipId: string) => Promise<void>;
  setRole: (membershipId: string, role: OrgRole) => Promise<void>;
  remove: (membershipId: string) => Promise<void>;
  leave: (orgId: string) => Promise<void>;
  createCode: (orgId: string, days: number, maxUses: number) => Promise<{ code: string }>;
  revokeCode: (codeId: string) => Promise<void>;
}

export interface EnterpriseState {
  status: EnterpriseStatus;
  /** The organization the current work account is linked to. */
  view: OrgView | null;
  /** Every organization this login belongs to, for linking another work account. */
  memberships: OrgMembershipSummary[];
  /** An organization that takes join requests from this login's email domain. */
  domainOrg: OrgSummary | null;
  /** Spaces in the linked organization, joined ones first. */
  spaces: Space[];
  /** The open space's chat, oldest first, including any earlier pages that were loaded. Empty until a space is selected. */
  messages: SpaceMessage[];
  /** Whether the chat may have lines before the oldest one loaded. */
  hasEarlier: boolean;
  loadingEarlier: boolean;
  /** The open space's jobs for the agent, newest first. */
  jobs: Job[];
  /** Macs in the organization that take jobs, and whether they're online right now. */
  workers: WorkerInfo[];
  /** Skills published to the organization or its spaces. */
  sharedSkills: SharedSkill[];
  /** The vault: documents and logins this account may see. */
  files: VaultFile[];
  credentials: VaultCredential[];
  /** Admins only: adoption across the organization. Null for members. */
  rollout: Rollout | null;
  actions: EnterpriseActions;
}

const unavailable = async (): Promise<never> => {
  throw new Error("Sign in to sync first.");
};

export const ENTERPRISE_OFF: EnterpriseState = {
  status: "off",
  view: null,
  memberships: [],
  domainOrg: null,
  spaces: [],
  messages: [],
  hasEarlier: false,
  loadingEarlier: false,
  jobs: [],
  workers: [],
  sharedSkills: [],
  files: [],
  credentials: [],
  rollout: null,
  actions: {
    setWelcome: unavailable,
    uploadFile: unavailable,
    deleteFile: unavailable,
    shareFile: unavailable,
    saveCredential: unavailable,
    deleteCredential: unavailable,
    touchCredential: unavailable,
    publishSkill: unavailable,
    unpublishSkill: unavailable,
    rollbackSkill: unavailable,
    recordSkillRun: unavailable,
    decide: unavailable,
    cancelJob: unavailable,
    createSpace: unavailable,
    joinSpace: unavailable,
    leaveSpace: unavailable,
    updateSpace: unavailable,
    deleteSpace: unavailable,
    markRead: unavailable,
    send: unavailable,
    loadEarlier: unavailable,
    create: unavailable,
    rename: unavailable,
    join: unavailable,
    link: unavailable,
    unlink: unavailable,
    requestByDomain: unavailable,
    approve: unavailable,
    decline: unavailable,
    setRole: unavailable,
    remove: unavailable,
    leave: unavailable,
    createCode: unavailable,
    revokeCode: unavailable,
  },
};

export function EnterpriseBridge({ accountId, spaceId, onChange }: { accountId: string | null; spaceId: string | null; onChange: (state: EnterpriseState) => void }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const view = useQuery(anyApi.orgs.forAccount, isAuthenticated && accountId ? { accountId } : "skip") as OrgView | null | undefined;
  const memberships = useQuery(anyApi.orgs.mine, isAuthenticated ? {} : "skip") as OrgMembershipSummary[] | undefined;
  const domainOrg = useQuery(anyApi.orgs.byMyDomain, isAuthenticated ? {} : "skip") as OrgSummary | null | undefined;
  const linked = Boolean(view);
  const spaces = useQuery(anyApi.spaces.list, isAuthenticated && accountId && linked ? { accountId } : "skip") as Space[] | undefined;
  const live = useQuery(anyApi.chat.messages, isAuthenticated && linked && spaceId ? { spaceId } : "skip") as SpaceMessage[] | undefined;

  // Earlier pages are fetched once and kept per space; the live query only ever holds the newest page.
  const convex = useConvex();
  const [earlier, setEarlier] = useState<{ spaceId: string; pages: SpaceMessage[][]; exhausted: boolean }>({ spaceId: "", pages: [], exhausted: false });
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const oldest = earlier.spaceId === spaceId && earlier.pages.length ? earlier.pages[earlier.pages.length - 1][0] : live?.[0];
  const hasEarlier = Boolean(spaceId && live && live.length >= CHAT_PAGE && !(earlier.spaceId === spaceId && earlier.exhausted));
  const loadEarlier = useCallback(async () => {
    if (!spaceId || !oldest || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = (await convex.query(anyApi.chat.messages, { spaceId, before: oldest.createdAt })) as SpaceMessage[];
      setEarlier((current) => {
        const pages = current.spaceId === spaceId ? current.pages : [];
        return { spaceId, pages: [...pages, page], exhausted: page.length < CHAT_PAGE };
      });
    } finally {
      setLoadingEarlier(false);
    }
  }, [convex, spaceId, oldest, loadingEarlier]);
  const messages = useMemo(() => {
    if (!live) return undefined;
    if (earlier.spaceId !== spaceId || !earlier.pages.length) return live;
    const seen = new Set<string>();
    const out: SpaceMessage[] = [];
    for (const page of [...earlier.pages].reverse()) for (const message of page) if (!seen.has(message.id)) { seen.add(message.id); out.push(message); }
    for (const message of live) if (!seen.has(message.id)) { seen.add(message.id); out.push(message); }
    return out;
  }, [live, earlier, spaceId]);
  const jobs = useQuery(anyApi.jobs.forSpace, isAuthenticated && linked && spaceId ? { spaceId } : "skip") as Job[] | undefined;
  const workers = useQuery(anyApi.jobs.workersFor, isAuthenticated && accountId && linked ? { accountId } : "skip") as WorkerInfo[] | undefined;

  const sharedSkills = useQuery(anyApi.sharedSkills.list, isAuthenticated && accountId && linked ? { accountId } : "skip") as SharedSkill[] | undefined;

  const files = useQuery(anyApi.vault.files, isAuthenticated && accountId && linked ? { accountId } : "skip") as VaultFile[] | undefined;
  const credentials = useQuery(anyApi.vault.credentials, isAuthenticated && accountId && linked ? { accountId } : "skip") as VaultCredential[] | undefined;
  const admin = view?.role === "owner" || view?.role === "admin";
  const rollout = useQuery(anyApi.enterprise.rollout, isAuthenticated && accountId && linked && admin ? { accountId } : "skip") as Rollout | null | undefined;
  const setWelcome = useMutation(anyApi.enterprise.setWelcome);

  const uploadUrl = useMutation(anyApi.vault.uploadUrl);
  const saveFile = useMutation(anyApi.vault.saveFile);
  const deleteFile = useMutation(anyApi.vault.deleteFile);
  const shareFile = useMutation(anyApi.vault.shareFile);
  const saveCredential = useMutation(anyApi.vault.saveCredential);
  const deleteCredential = useMutation(anyApi.vault.deleteCredential);
  const touchCredential = useMutation(anyApi.vault.touchCredential);
  const publishSkill = useMutation(anyApi.sharedSkills.publish);
  const unpublishSkill = useMutation(anyApi.sharedSkills.unpublish);
  const rollbackSkill = useMutation(anyApi.sharedSkills.rollback);
  const recordSkillRun = useMutation(anyApi.sharedSkills.recordRun);
  const decide = useMutation(anyApi.jobs.decide);
  const cancelJob = useMutation(anyApi.jobs.cancel);
  const createSpace = useMutation(anyApi.spaces.create);
  const joinSpace = useMutation(anyApi.spaces.join);
  const leaveSpace = useMutation(anyApi.spaces.leave);
  const updateSpace = useMutation(anyApi.spaces.update);
  const deleteSpace = useMutation(anyApi.spaces.remove);
  const markRead = useMutation(anyApi.spaces.markRead);
  const send = useMutation(anyApi.chat.send);

  const create = useMutation(anyApi.orgs.create);
  const rename = useMutation(anyApi.orgs.rename);
  const join = useMutation(anyApi.orgs.join);
  const link = useMutation(anyApi.orgs.link);
  const unlink = useMutation(anyApi.orgs.unlink);
  const requestByDomain = useMutation(anyApi.orgs.requestByDomain);
  const approve = useMutation(anyApi.orgs.approve);
  const decline = useMutation(anyApi.orgs.decline);
  const setRole = useMutation(anyApi.orgs.setRole);
  const remove = useMutation(anyApi.orgs.remove);
  const leave = useMutation(anyApi.orgs.leave);
  const createCode = useMutation(anyApi.orgs.createCode);
  const revokeCode = useMutation(anyApi.orgs.revokeCode);

  // The account can change under a stable action, so read the latest one at call time.
  const latestAccount = useRef(accountId);
  latestAccount.current = accountId;
  const actions = useMemo<EnterpriseActions>(() => {
    const account = () => {
      if (!latestAccount.current) throw new Error("Pick a work account first.");
      return latestAccount.current;
    };
    const wrap = <T,>(run: () => Promise<T>): Promise<T> => run().catch((error) => Promise.reject(new Error(friendlyError(error))));
    return {
      setWelcome: (orgId, welcome) => wrap(async () => void (await setWelcome({ orgId, welcome }))),
      uploadFile: (spaceId, file) =>
        wrap(async () => {
          // Convex file storage: ask for a one-shot upload URL, post the bytes, then record the file.
          const url = (await uploadUrl({ accountId: account() })) as string;
          const response = await fetch(url, { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
          if (!response.ok) throw new Error("the upload didn't go through");
          const { storageId } = (await response.json()) as { storageId: string };
          return (await saveFile({ accountId: account(), spaceId, storageId, name: file.name, size: file.size, mime: file.type || "application/octet-stream" })) as { id: string };
        }),
      deleteFile: (fileId) => wrap(async () => void (await deleteFile({ fileId }))),
      shareFile: (fileId, spaceId) => wrap(async () => void (await shareFile({ fileId, spaceId }))),
      saveCredential: (input) => wrap(() => saveCredential({ accountId: account(), ...input }) as Promise<{ id: string }>),
      deleteCredential: (credentialId) => wrap(async () => void (await deleteCredential({ credentialId }))),
      touchCredential: (credentialId) => wrap(async () => void (await touchCredential({ credentialId }))),
      publishSkill: (spaceId, skill) => wrap(() => publishSkill({ accountId: account(), spaceId, skill }) as Promise<{ id: string; version: number }>),
      unpublishSkill: (sharedId) => wrap(async () => void (await unpublishSkill({ sharedId }))),
      rollbackSkill: (sharedId) => wrap(async () => void (await rollbackSkill({ sharedId }))),
      recordSkillRun: (sharedId) => wrap(async () => void (await recordSkillRun({ sharedId }))),
      decide: (jobId, decision) => wrap(async () => void (await decide({ jobId, decision }))),
      cancelJob: (jobId) => wrap(async () => void (await cancelJob({ jobId }))),
      createSpace: (name) => wrap(() => createSpace({ accountId: account(), name }) as Promise<{ spaceId: string }>),
      joinSpace: (spaceId) => wrap(async () => void (await joinSpace({ spaceId }))),
      leaveSpace: (spaceId) => wrap(async () => void (await leaveSpace({ spaceId }))),
      updateSpace: (spaceId, patch) => wrap(async () => void (await updateSpace({ spaceId, ...patch }))),
      deleteSpace: (spaceId) =>
        wrap(async () => {
          // Long chats are deleted in batches; keep going until the space itself is gone.
          for (let round = 0; round < 50; round += 1) {
            const result = (await deleteSpace({ spaceId })) as { done: boolean };
            if (result.done) return;
          }
        }),
      markRead: (spaceId) => wrap(async () => void (await markRead({ spaceId }))),
      send: (spaceId, text) => wrap(async () => void (await send({ spaceId, text }))),
      loadEarlier: () => wrap(loadEarlier),
      create: (name, domain) => wrap(async () => void (await create({ name, domain, accountId: account() }))),
      rename: (orgId, name, domain) => wrap(async () => void (await rename({ orgId, name, domain }))),
      join: (code) => wrap(() => join({ code, accountId: account() }) as Promise<{ name: string }>),
      link: (orgId) => wrap(async () => void (await link({ orgId, accountId: account() }))),
      unlink: () => wrap(async () => void (await unlink({ accountId: account() }))),
      requestByDomain: () => wrap(() => requestByDomain({ accountId: account() }) as Promise<{ status: string; name: string }>),
      approve: (membershipId) => wrap(async () => void (await approve({ membershipId }))),
      decline: (membershipId) => wrap(async () => void (await decline({ membershipId }))),
      setRole: (membershipId, role) => wrap(async () => void (await setRole({ membershipId, role }))),
      remove: (membershipId) => wrap(async () => void (await remove({ membershipId }))),
      leave: (orgId) => wrap(async () => void (await leave({ orgId }))),
      createCode: (orgId, days, maxUses) => wrap(() => createCode({ orgId, days, maxUses }) as Promise<{ code: string }>),
      revokeCode: (codeId) => wrap(async () => void (await revokeCode({ codeId }))),
    };
  }, [loadEarlier, setWelcome, uploadUrl, saveFile, deleteFile, shareFile, saveCredential, deleteCredential, touchCredential, publishSkill, unpublishSkill, rollbackSkill, recordSkillRun, decide, cancelJob, createSpace, joinSpace, leaveSpace, updateSpace, deleteSpace, markRead, send, create, rename, join, link, unlink, requestByDomain, approve, decline, setRole, remove, leave, createCode, revokeCode]);

  const status: EnterpriseStatus = isLoading
    ? "loading"
    : !isAuthenticated
      ? "signedOut"
      : (accountId && view === undefined) || memberships === undefined || domainOrg === undefined || (linked && spaces === undefined)
        ? "loading"
        : "ready";

  useEffect(() => {
    onChange({ status, view: view ?? null, memberships: memberships ?? [], domainOrg: domainOrg ?? null, spaces: spaces ?? [], messages: messages ?? [], hasEarlier, loadingEarlier, jobs: jobs ?? [], workers: workers ?? [], sharedSkills: sharedSkills ?? [], files: files ?? [], credentials: credentials ?? [], rollout: rollout ?? null, actions });
  }, [status, view, memberships, domainOrg, spaces, messages, hasEarlier, loadingEarlier, jobs, workers, sharedSkills, files, credentials, rollout, actions, onChange]);

  return null;
}

// Convex wraps thrown messages in a longer report; keep the sentence the mutation wrote.
function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/Uncaught Error: ([^\n]+)/);
  const text = (match?.[1] ?? message).trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "That didn't work. Try again.";
}
