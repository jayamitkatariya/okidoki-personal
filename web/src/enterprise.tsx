import { useEffect, useMemo, useRef } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
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
  accountId: string;
  userId: string;
  name: string;
  device: string;
  kind: "thisMac" | "privateMac";
  online: boolean;
  isYou: boolean;
  lastSeenAt: number;
}

export interface EnterpriseActions {
  decide: (jobId: string, decision: "approve" | "decline") => Promise<void>;
  cancelJob: (jobId: string) => Promise<void>;
  createSpace: (name: string) => Promise<{ spaceId: string }>;
  joinSpace: (spaceId: string) => Promise<void>;
  leaveSpace: (spaceId: string) => Promise<void>;
  updateSpace: (spaceId: string, patch: { name?: string; workerPolicy?: WorkerPolicy; colorHex?: string }) => Promise<void>;
  deleteSpace: (spaceId: string) => Promise<void>;
  markRead: (spaceId: string) => Promise<void>;
  send: (spaceId: string, text: string) => Promise<void>;
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
  /** The open space's chat, oldest first. Empty until a space is selected. */
  messages: SpaceMessage[];
  /** The open space's jobs for the agent, newest first. */
  jobs: Job[];
  /** Macs in the organization that take jobs, and whether they're online right now. */
  workers: WorkerInfo[];
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
  jobs: [],
  workers: [],
  actions: {
    decide: unavailable,
    cancelJob: unavailable,
    createSpace: unavailable,
    joinSpace: unavailable,
    leaveSpace: unavailable,
    updateSpace: unavailable,
    deleteSpace: unavailable,
    markRead: unavailable,
    send: unavailable,
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
  const messages = useQuery(anyApi.chat.messages, isAuthenticated && linked && spaceId ? { spaceId } : "skip") as SpaceMessage[] | undefined;
  const jobs = useQuery(anyApi.jobs.forSpace, isAuthenticated && linked && spaceId ? { spaceId } : "skip") as Job[] | undefined;
  const workers = useQuery(anyApi.jobs.workersFor, isAuthenticated && accountId && linked ? { accountId } : "skip") as WorkerInfo[] | undefined;

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
  }, [decide, cancelJob, createSpace, joinSpace, leaveSpace, updateSpace, deleteSpace, markRead, send, create, rename, join, link, unlink, requestByDomain, approve, decline, setRole, remove, leave, createCode, revokeCode]);

  const status: EnterpriseStatus = isLoading
    ? "loading"
    : !isAuthenticated
      ? "signedOut"
      : (accountId && view === undefined) || memberships === undefined || domainOrg === undefined
        ? "loading"
        : "ready";

  useEffect(() => {
    onChange({ status, view: view ?? null, memberships: memberships ?? [], domainOrg: domainOrg ?? null, spaces: spaces ?? [], messages: messages ?? [], jobs: jobs ?? [], workers: workers ?? [], actions });
  }, [status, view, memberships, domainOrg, spaces, messages, jobs, workers, actions, onChange]);

  return null;
}

// Convex wraps thrown messages in a longer report; keep the sentence the mutation wrote.
function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/Uncaught Error: ([^\n]+)/);
  const text = (match?.[1] ?? message).trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "That didn't work. Try again.";
}
