import { useEffect, useState } from "react";
import { useDashboard } from "../store";
import { copyText, cx, futureTime, relativeTime } from "../lib";
import type { Page } from "../nav";
import type { Account } from "../types";
import type { JoinCode, OrgMember, OrgRole, OrgView } from "../enterprise";
import { Avatar, Button, Chip, ConfirmModal, Empty, IconButton, Modal, PageTitle, PixelIcon, Segmented, Switch, TextField, type ConfirmRequest } from "../components/ui";

const ROLE_LABEL: Record<OrgRole, string> = { owner: "Owner", admin: "Admin", member: "Member", agent: "Agent" };
const AVATAR_COLORS = ["44E45E", "1FB57A", "3DDC97", "0B8A5E", "B8F26B", "8FB7FF", "F2B84B", "E97A6B"];

// Members aren't accounts on this Mac, so give each one a steady colour from their email.
function memberAccount(member: OrgMember): Account {
  let hash = 0;
  for (const char of member.email || member.name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return {
    id: member.id,
    name: member.name,
    email: member.email,
    kind: "work",
    colorHex: member.colorHex || AVATAR_COLORS[hash % AVATAR_COLORS.length],
    createdAt: "",
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function TeamPage({ go }: { go: (page: Page) => void }) {
  const { cloud, enterprise } = useDashboard();

  if (cloud.status === "off") {
    return (
      <div className="team-page">
        <PageTitle title="Team" subtitle="Your organization, its people and join codes." />
        <Empty
          icon="link"
          title="Turn on sync to use your team"
          action={
            <Button variant="primary" size="sm" onClick={() => go("settings")}>
              Open Settings
            </Button>
          }
        >
          A team lives on Convex so colleagues can see the same thing. Turn on sync in Settings and sign in with your sync login.
        </Empty>
      </div>
    );
  }

  if (enterprise.status === "signedOut") {
    return (
      <div className="team-page">
        <PageTitle title="Team" subtitle="Your organization, its people and join codes." />
        <Empty
          icon="user"
          title="Sign in to your sync login"
          action={
            <Button variant="primary" size="sm" onClick={() => go("settings")}>
              Sign in
            </Button>
          }
        >
          Your organization follows your sync login, so colleagues can work with the same people and spaces from any Mac.
        </Empty>
      </div>
    );
  }

  if (enterprise.status !== "ready") {
    return (
      <div className="team-page">
        <PageTitle title="Team" subtitle="Your organization, its people and join codes." />
        <Empty icon="spinner" title="Connecting…">
          Checking your organization on your deployment.
        </Empty>
      </div>
    );
  }

  return enterprise.view ? <OrgPage view={enterprise.view} /> : <LinkAccount />;
}

// A work account that isn't linked yet: create, join with a code, or pick an organization this login is already in.
function LinkAccount() {
  const { account, enterprise, notify, state } = useDashboard();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    try {
      await task();
    } catch (error) {
      notify("That didn't work", error instanceof Error ? error.message : String(error), "warning");
    } finally {
      setBusy(null);
    }
  };

  const joinable = enterprise.memberships.filter((item) => item.status === "active");
  const waiting = enterprise.memberships.filter((item) => item.status === "pending");
  const domainOrg = enterprise.domainOrg && !enterprise.memberships.some((item) => item.id === enterprise.domainOrg?.id) ? enterprise.domainOrg : null;
  const nearby = state.nearby?.invites ?? [];

  return (
    <div className="team-page">
      <PageTitle title="Team" subtitle={`Link ${account.name} to your company. Spaces, shared skills and the vault follow the organization.`} />

      <div className="team-options">
        {nearby.length ? (
          <section className="team-card team-card-nearby">
            <header>
              <PixelIcon name="wave" size={18} />
              <h2>On this network</h2>
              <p>A colleague's Mac is letting people in right now.</p>
            </header>
            <div className="pref-group">
              {nearby.map((invite) => (
                <div className="pref-row" key={`${invite.orgId}-${invite.code}`}>
                  <span className="pref-copy">
                    <strong>{invite.orgName}</strong>
                    <em>via {invite.device}</em>
                  </span>
                  <span className="pref-control">
                    <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => run(`nearby-${invite.code}`, () => enterprise.actions.join(invite.code).then((result) => notify("Joined", result.name)))}>
                      {busy === `nearby-${invite.code}` ? "Joining…" : "Join"}
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {joinable.length ? (
          <section className="team-card">
            <header>
              <PixelIcon name="building" size={18} />
              <h2>Already in one</h2>
              <p>Organizations this login belongs to.</p>
            </header>
            <div className="pref-group">
              {joinable.map((org) => (
                <div className="pref-row" key={org.id}>
                  <span className="pref-copy">
                    <strong>{org.name}</strong>
                    <em>
                      {ROLE_LABEL[(org.role || "member") as OrgRole]} · {org.memberCount} {org.memberCount === 1 ? "person" : "people"}
                      {org.linkedAccountId ? " · linked to another account here" : ""}
                    </em>
                  </span>
                  <span className="pref-control">
                    <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => run(`link-${org.id}`, () => enterprise.actions.link(org.id).then(() => notify("Linked", `${account.name} is now part of ${org.name}`)))}>
                      {busy === `link-${org.id}` ? "Linking…" : "Link"}
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {domainOrg ? (
          <section className="team-card">
            <header>
              <PixelIcon name="building" size={18} />
              <h2>Ask to join {domainOrg.name}</h2>
              <p>Your email domain matches. An admin there approves the request.</p>
            </header>
            <Button variant="primary" disabled={busy !== null} onClick={() => run("domain", () => enterprise.actions.requestByDomain().then((result) => notify(result.status === "active" ? "Joined" : "Request sent", result.name)))}>
              {busy === "domain" ? "Sending…" : "Ask to join"}
            </Button>
          </section>
        ) : null}

        {waiting.length ? (
          <section className="team-card">
            <header>
              <PixelIcon name="clock" size={18} />
              <h2>Waiting for approval</h2>
              <p>An admin has to let you in.</p>
            </header>
            <div className="pref-group">
              {waiting.map((org) => (
                <div className="pref-row" key={org.id}>
                  <span className="pref-copy">
                    <strong>{org.name}</strong>
                    <em>Request pending</em>
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="team-card">
          <header>
            <PixelIcon name="ticket" size={18} />
            <h2>Join with a code</h2>
            <p>Someone in the organization shares a six-character code.</p>
          </header>
          <div className="form-stack">
            <TextField value={code} onChange={(value) => setCode(value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))} placeholder="ABC123" className="team-code-field" onEnter={() => code.length === 6 && run("join", () => enterprise.actions.join(code).then((result) => notify("Joined", result.name)))} />
            <Button variant="primary" disabled={code.length !== 6 || busy !== null} onClick={() => run("join", () => enterprise.actions.join(code).then((result) => notify("Joined", result.name)))}>
              {busy === "join" ? "Joining…" : "Join"}
            </Button>
          </div>
        </section>

        <section className="team-card">
          <header>
            <PixelIcon name="plus" size={18} />
            <h2>Create an organization</h2>
            <p>You become its owner. Add an email domain so colleagues can ask to join.</p>
          </header>
          <div className="form-stack">
            <label className="form-label">Name</label>
            <TextField value={name} onChange={setName} placeholder="Acme Inc." />
            <label className="form-label">Email domain (optional)</label>
            <TextField value={domain} onChange={setDomain} placeholder="acme.com" />
            <Button variant="primary" disabled={!name.trim() || busy !== null} onClick={() => run("create", () => enterprise.actions.create(name, domain).then(() => notify("Organization created", name.trim())))}>
              {busy === "create" ? "Creating…" : "Create"}
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}

function OrgPage({ view }: { view: OrgView }) {
  const { account, enterprise, notify, state, native, invoke } = useDashboard();
  const advertising = state.nearby?.advertising ?? null;
  const [inviting, setInviting] = useState(false);

  // One day, twenty people: an open door for a room, not a permanent one.
  const openDoor = async (on: boolean) => {
    if (!on) {
      invoke("nearbyStop");
      return;
    }
    setInviting(true);
    try {
      const result = await enterprise.actions.createCode(view.org.id, 1, 20);
      invoke("nearbyInvite", { orgId: view.org.id, orgName: view.org.name, code: result.code });
      notify("Open to nearby Macs", `Colleagues on this network can join ${view.org.name} for a day`);
    } catch (error) {
      notify("That didn't work", error instanceof Error ? error.message : String(error), "warning");
    } finally {
      setInviting(false);
    }
  };
  const { org, role, members, pending, codes } = view;
  const admin = role === "owner" || role === "admin";
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(org.name);
  const [domain, setDomain] = useState(org.domain);
  const [newCode, setNewCode] = useState(false);
  const [days, setDays] = useState<"1" | "7" | "30">("7");
  const [maxUses, setMaxUses] = useState<"1" | "10" | "500">("10");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    setName(org.name);
    setDomain(org.domain);
  }, [org.name, org.domain]);

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

  const copy = async (code: JoinCode) => {
    if (await copyText(code.code)) {
      setCopied(code.id);
      window.setTimeout(() => setCopied((value) => (value === code.id ? null : value)), 1600);
    }
  };

  const canEdit = (member: OrgMember) => admin && !member.isYou && (member.role !== "owner" || role === "owner");
  const roleOptions = (member: OrgMember) =>
    (Object.keys(ROLE_LABEL) as OrgRole[])
      .filter((value) => value !== "owner" || role === "owner" || member.role === "owner")
      .map((value) => ({ value, label: ROLE_LABEL[value] }));

  return (
    <div className="team-page">
      <PageTitle
        title={org.name}
        subtitle={`${org.domain ? `@${org.domain} · ` : ""}${org.memberCount} ${org.memberCount === 1 ? "person" : "people"} · ${account.name} is linked as ${ROLE_LABEL[role].toLowerCase()}`}
        trailing={
          <>
            <Chip tone="green">{ROLE_LABEL[role]}</Chip>
            {admin ? (
              <Button size="sm" variant="secondary" icon="edit" onClick={() => setEditing(true)}>
                Edit
              </Button>
            ) : null}
          </>
        }
      />

      <section className="team-section">
        <header className="team-section-head">
          <h2>People</h2>
          <p>{admin ? "Change roles here. Owners run the organization; admins manage people and codes." : "Who's in the organization."}</p>
        </header>
        <div className="pref-group">
          {members.map((member) => (
            <div className={cx("pref-row team-member", member.isYou && "is-you")} key={member.id}>
              <Avatar account={memberAccount(member)} size={30} />
              <span className="pref-copy">
                <strong>
                  {member.name}
                  {member.isYou ? <span className="team-you">you</span> : null}
                </strong>
                <em>
                  {member.email || "no email"} · joined {relativeTime(iso(member.joinedAt))}
                </em>
              </span>
              <span className="pref-control team-member-control">
                {canEdit(member) ? (
                  <Segmented options={roleOptions(member)} value={member.role} onChange={(value) => void attempt(() => enterprise.actions.setRole(member.id, value as OrgRole), ["Role changed", `${member.name} is now ${ROLE_LABEL[value as OrgRole].toLowerCase()}`])} />
                ) : (
                  <Chip tone={member.role === "owner" ? "green" : member.role === "admin" ? "blue" : "default"}>{ROLE_LABEL[member.role]}</Chip>
                )}
                {canEdit(member) ? (
                  <IconButton
                    icon="trash"
                    label={`Remove ${member.name}`}
                    onClick={() =>
                      setConfirm({
                        title: `Remove ${member.name}?`,
                        detail: "They lose access to the organization's spaces, shared skills and vault. They can be invited again with a code.",
                        action: "Remove",
                        onConfirm: () => void attempt(() => enterprise.actions.remove(member.id), ["Removed", member.name]),
                      })
                    }
                  />
                ) : null}
              </span>
            </div>
          ))}
        </div>
      </section>

      {admin && pending.length ? (
        <section className="team-section">
          <header className="team-section-head">
            <h2>Join requests</h2>
            <p>People whose email domain matches, waiting to be let in.</p>
          </header>
          <div className="pref-group">
            {pending.map((member) => (
              <div className="pref-row team-member" key={member.id}>
                <Avatar account={memberAccount(member)} size={30} />
                <span className="pref-copy">
                  <strong>{member.name}</strong>
                  <em>
                    {member.email} · asked {relativeTime(iso(member.joinedAt))}
                  </em>
                </span>
                <span className="pref-control team-member-control">
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void attempt(() => enterprise.actions.decline(member.id), ["Declined", member.name])}>
                    Decline
                  </Button>
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => void attempt(() => enterprise.actions.approve(member.id), ["Let in", member.name])}>
                    Let in
                  </Button>
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {admin ? (
        <section className="team-section">
          <header className="team-section-head">
            <h2>Join codes</h2>
            <p>Share a code with a colleague; they enter it on their Team page. Codes expire on their own.</p>
            <Button size="sm" variant="secondary" icon="plus" onClick={() => setNewCode(true)}>
              New code
            </Button>
          </header>
          {native ? (
            <div className="pref-group">
              <div className="pref-row">
                <span className="pref-copy">
                  <strong>Let nearby Macs join</strong>
                  <em>
                    {advertising
                      ? `This Mac is inviting over the network with code ${advertising.code}. Anyone running okidoki on this Wi-Fi sees “Join ${org.name}”.`
                      : "Announce a one-day code over this network, so colleagues in the room join with one click."}
                  </em>
                </span>
                <span className="pref-control">
                  <Switch checked={Boolean(advertising)} onChange={(value) => { if (!inviting) void openDoor(value); }} />
                </span>
              </div>
            </div>
          ) : null}
          {codes.length ? (
            <div className="pref-group">
              {codes.map((code) => (
                <div className="pref-row team-code-row" key={code.id}>
                  <span className="team-code">{code.code}</span>
                  <span className="pref-copy">
                    <strong>
                      {code.uses} of {code.maxUses >= 500 ? "unlimited" : code.maxUses} used
                    </strong>
                    <em>expires {futureTime(iso(code.expiresAt))}</em>
                  </span>
                  <span className="pref-control team-member-control">
                    <Button size="sm" variant="secondary" icon={copied === code.id ? "check" : "copy"} onClick={() => void copy(code)}>
                      {copied === code.id ? "Copied" : "Copy"}
                    </Button>
                    <IconButton icon="x" label="Revoke code" onClick={() => void attempt(() => enterprise.actions.revokeCode(code.id), ["Code revoked", code.code])} />
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Empty icon="ticket" title="No live codes">
              Make one to bring a colleague in. Each code can be used a set number of times before it expires.
            </Empty>
          )}
        </section>
      ) : null}

      <section className="team-section">
        <header className="team-section-head">
          <h2>This account</h2>
          <p>{account.name} is the work account linked to {org.name} on this Mac.</p>
        </header>
        <div className="pref-group">
          <button
            className="pref-row pref-row-button pref-action"
            onClick={() =>
              setConfirm({
                title: `Unlink ${account.name}?`,
                detail: `You stay in ${org.name}; this account just stops showing its spaces and vault. Link it again any time.`,
                action: "Unlink",
                onConfirm: () => void attempt(() => enterprise.actions.unlink(), ["Unlinked", account.name]),
              })
            }
          >
            <PixelIcon name="link" size={15} />
            Unlink this account
          </button>
          <button
            className="pref-row pref-row-button pref-action is-danger"
            onClick={() =>
              setConfirm({
                title: `Leave ${org.name}?`,
                detail: role === "owner" ? "Make someone else an owner first if you're the only one." : "You lose access to its spaces, shared skills and vault. Someone can invite you back with a code.",
                action: "Leave",
                onConfirm: () => void attempt(() => enterprise.actions.leave(org.id), ["Left", org.name]),
              })
            }
          >
            <PixelIcon name="logout" size={15} />
            Leave organization…
          </button>
        </div>
      </section>

      <Modal open={editing} onClose={() => setEditing(false)} title="Edit organization" width={440}>
        <div className="form-stack">
          <label className="form-label">Name</label>
          <TextField value={name} onChange={setName} autoFocus />
          <label className="form-label">Email domain</label>
          <TextField value={domain} onChange={setDomain} placeholder="acme.com" />
          <p className="form-hint">With a domain, anyone whose sync login ends in @{domain || "your-domain"} can ask to join; an admin lets them in.</p>
        </div>
        <footer className="modal-actions">
          <Button variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim() || busy}
            onClick={() =>
              void attempt(() => enterprise.actions.rename(org.id, name, domain), ["Saved", name.trim()]).then(() => setEditing(false))
            }
          >
            Save
          </Button>
        </footer>
      </Modal>

      <Modal open={newCode} onClose={() => setNewCode(false)} title="New join code" subtitle="Whoever enters it joins as a member." width={440}>
        <div className="form-stack">
          <div className="form-inline">
            <span className="form-label">Expires in</span>
            <Segmented
              options={[
                { value: "1", label: "1 day" },
                { value: "7", label: "7 days" },
                { value: "30", label: "30 days" },
              ]}
              value={days}
              onChange={(value) => setDays(value as typeof days)}
            />
          </div>
          <div className="form-inline">
            <span className="form-label">Uses</span>
            <Segmented
              options={[
                { value: "1", label: "Once" },
                { value: "10", label: "10" },
                { value: "500", label: "Unlimited" },
              ]}
              value={maxUses}
              onChange={(value) => setMaxUses(value as typeof maxUses)}
            />
          </div>
        </div>
        <footer className="modal-actions">
          <Button variant="ghost" onClick={() => setNewCode(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void attempt(async () => {
                const result = await enterprise.actions.createCode(org.id, Number(days), Number(maxUses));
                await copyText(result.code);
                notify("Code ready and copied", result.code);
                setNewCode(false);
              })
            }
          >
            Make code
          </Button>
        </footer>
      </Modal>

      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
