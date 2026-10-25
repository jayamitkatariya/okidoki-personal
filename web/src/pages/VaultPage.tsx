import { useEffect, useMemo, useRef, useState } from "react";
import { useDashboard } from "../store";
import { copyText, cx, formatBytes, relativeTime } from "../lib";
import type { Page } from "../nav";
import type { VaultCredential, VaultFile } from "../enterprise";
import { decryptSecret, deriveVaultKey, encryptSecret, rememberPassphrase, rememberedPassphrase, VAULT_KEY_VERSION } from "../vaultCrypto";
import { Button, Chip, ConfirmModal, Empty, IconButton, Modal, PageTitle, PixelIcon, Segmented, Switch, TextArea, TextField, type ConfirmRequest } from "../components/ui";

type Tab = "documents" | "credentials";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function fileIcon(mime: string, name: string): string {
  if (mime.startsWith("image/")) return "eye";
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "note";
  if (/zip|tar|gzip|compressed/.test(mime) || /\.(zip|tgz|gz|7z)$/i.test(name)) return "folder";
  if (mime.startsWith("text/") || /\.(md|txt|csv|json)$/i.test(name)) return "note";
  return "sticker";
}

export function VaultPage({ go }: { go: (page: Page) => void }) {
  const { cloud, enterprise } = useDashboard();
  const [tab, setTab] = useState<Tab>("documents");

  const gate = (icon: string, title: string, body: string, action: React.ReactNode) => (
    <div className="vault-page">
      <PageTitle title="Vault" subtitle="Confidential documents and logins, kept with your organization." />
      <Empty icon={icon} title={title} action={action}>
        {body}
      </Empty>
    </div>
  );

  if (cloud.status === "off") {
    return gate("link", "Turn on sync to use the vault", "The vault lives on Convex so colleagues share the same documents and logins. Turn on sync in Settings and sign in.", <Button variant="primary" size="sm" onClick={() => go("settings")}>Open Settings</Button>);
  }
  if (enterprise.status === "signedOut") {
    return gate("user", "Sign in to your sync login", "The vault follows your organization, which follows your sync login.", <Button variant="primary" size="sm" onClick={() => go("settings")}>Sign in</Button>);
  }
  if (enterprise.status !== "ready") return gate("spinner", "Connecting…", "Checking your organization on your deployment.", null);
  if (!enterprise.view) {
    return gate("building", "Link this account to your company", "The vault belongs to an organization. Create one, join with a code, or ask to join by email domain on the Team page.", <Button variant="primary" size="sm" icon="people" onClick={() => go("team")}>Open Team</Button>);
  }

  return (
    <div className="vault-page">
      <PageTitle
        title="Vault"
        subtitle={`${enterprise.view.org.name}'s documents and logins. Scoped to a space, only its members see them.`}
        trailing={
          <Segmented
            options={[
              { value: "documents", label: `Documents${enterprise.files.length ? ` · ${enterprise.files.length}` : ""}` },
              { value: "credentials", label: `Logins${enterprise.credentials.length ? ` · ${enterprise.credentials.length}` : ""}` },
            ]}
            value={tab}
            onChange={setTab}
          />
        }
      />
      {tab === "documents" ? <Documents /> : <Credentials key={enterprise.view?.org.id ?? ""} />}
    </div>
  );
}

// ---- Documents ----

function Documents() {
  const { enterprise, notify } = useDashboard();
  const joined = enterprise.spaces.filter((space) => space.joined);
  const [scope, setScope] = useState<string>("all");
  const [uploadTo, setUploadTo] = useState<string>("org");
  const [uploading, setUploading] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [shareFor, setShareFor] = useState<VaultFile | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const files = enterprise.files.filter((file) => (scope === "all" ? true : scope === "org" ? !file.spaceId : file.spaceId === scope));

  const upload = async (list: FileList | File[]) => {
    const picked = Array.from(list);
    if (!picked.length) return;
    const spaceId = uploadTo === "org" ? null : uploadTo;
    setUploading((current) => [...current, ...picked.map((file) => file.name)]);
    for (const file of picked) {
      try {
        await enterprise.actions.uploadFile(spaceId, file);
        notify("Uploaded", file.name);
      } catch (error) {
        notify("Upload failed", `${file.name}: ${error instanceof Error ? error.message : String(error)}`, "warning");
      } finally {
        setUploading((current) => {
          const index = current.indexOf(file.name);
          return index < 0 ? current : [...current.slice(0, index), ...current.slice(index + 1)];
        });
      }
    }
  };

  return (
    <div className="vault-section">
      <div
        className={cx("vault-drop", dragging && "is-over")}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
          setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void upload(event.dataTransfer.files);
        }}
      >
        <PixelIcon name="share" size={20} />
        <div className="vault-drop-copy">
          <strong>Drop files here, or</strong>
          <Button size="sm" variant="secondary" onClick={() => inputRef.current?.click()}>
            Choose files
          </Button>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void upload(files);
            }}
          />
        </div>
        <label className="vault-drop-target">
          <span>Into</span>
          <select value={uploadTo} onChange={(event) => setUploadTo(event.target.value)} aria-label="Where the upload goes">
            <option value="org">Whole organization</option>
            {joined.map((space) => (
              <option key={space.id} value={space.id}>
                {space.name}
              </option>
            ))}
          </select>
        </label>
        {uploading.length ? <em className="vault-uploading">Uploading {uploading.join(", ")}…</em> : null}
      </div>

      <div className="vault-filter">
        <Segmented
          compact
          options={[{ value: "all", label: "All" }, { value: "org", label: "Org-wide" }, ...joined.map((space) => ({ value: space.id, label: space.name }))]}
          value={scope}
          onChange={setScope}
        />
      </div>

      {files.length ? (
        <div className="pref-group">
          {files.map((file) => (
            <VaultFileRow key={file.id} file={file} onShare={() => setShareFor(file)} setConfirm={setConfirm} />
          ))}
        </div>
      ) : (
        <Empty icon="folder" title={enterprise.files.length ? "Nothing in this view" : "No documents yet"}>
          {enterprise.files.length ? "Pick another scope above." : "Contracts, exports, briefs — anything the team or the agent needs. Files stay in your organization's own deployment."}
        </Empty>
      )}

      <Modal open={Boolean(shareFor)} onClose={() => setShareFor(null)} title="Share to a space" subtitle={shareFor?.name} width={420}>
        <div className="share-targets">
          {joined
            .filter((space) => !shareFor?.spaceId || space.id === shareFor.spaceId)
            .map((space) => (
              <button
                key={space.id}
                className="share-target"
                onClick={() => {
                  const file = shareFor;
                  setShareFor(null);
                  if (!file) return;
                  void enterprise.actions.shareFile(file.id, space.id).then(() => notify("Shared", `${file.name} → ${space.name}`)).catch((error: Error) => notify("That didn't work", error.message, "warning"));
                }}
              >
                <PixelIcon name="chat" size={15} />
                <span>
                  <strong>{space.name}</strong>
                  <em>
                    {space.members.length} {space.members.length === 1 ? "member" : "members"}
                  </em>
                </span>
              </button>
            ))}
          {!joined.length ? <p className="form-hint">Join a space first.</p> : null}
        </div>
      </Modal>
      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

/** One document in the vault: download, share to a chat, delete. Used by Vault and by a space's Files tab. */
export function VaultFileRow({ file, onShare, setConfirm }: { file: VaultFile; onShare?: () => void; setConfirm: (request: ConfirmRequest) => void }) {
  const { enterprise, notify } = useDashboard();
  return (
    <div className="pref-row vault-row">
      <span className="kind-icon">
        <PixelIcon name={fileIcon(file.mime, file.name)} size={15} />
      </span>
      <span className="pref-copy">
        <strong>{file.name}</strong>
        <em>
          {formatBytes(file.size)} · {file.spaceId ? file.spaceName : "whole organization"} · {file.uploadedBy} · {relativeTime(iso(file.createdAt))}
        </em>
      </span>
      <span className="pref-control vault-row-tools">
        {file.url ? (
          <a className="btn btn-secondary btn-sm" href={file.url} target="_blank" rel="noreferrer" download={file.name}>
            <PixelIcon name="download" size={13} /> Download
          </a>
        ) : null}
        {onShare ? <IconButton icon="chat" label="Share to a space" onClick={onShare} /> : null}
        {file.canDelete ? (
          <IconButton
            icon="trash"
            label="Delete file"
            onClick={() =>
              setConfirm({
                title: `Delete ${file.name}?`,
                detail: "It's removed for everyone. Links already shared in chats stop working.",
                action: "Delete",
                onConfirm: () => void enterprise.actions.deleteFile(file.id).then(() => notify("Deleted", file.name, "info")).catch((error: Error) => notify("That didn't work", error.message, "warning")),
              })
            }
          />
        ) : null}
      </span>
    </div>
  );
}

// ---- Credentials ----

function Credentials() {
  const { enterprise, notify, native, invoke } = useDashboard();
  const orgId = enterprise.view?.org.id ?? "";
  const joined = enterprise.spaces.filter((space) => space.joined);
  const [passphrase, setPassphrase] = useState(() => rememberedPassphrase(orgId));
  const [remember, setRemember] = useState(() => Boolean(rememberedPassphrase(orgId)));
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [draftPass, setDraftPass] = useState("");
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<VaultCredential | null | "new">(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!passphrase || !orgId) {
      setKey(null);
      return;
    }
    void deriveVaultKey(passphrase, orgId).then((derived) => {
      if (!cancelled) setKey(derived);
    });
    return () => {
      cancelled = true;
    };
  }, [passphrase, orgId]);

  const unlock = () => {
    const value = draftPass;
    if (!value) return;
    setPassphrase(value);
    setDraftPass("");
    if (remember) {
      rememberPassphrase(orgId, value);
      if (native) invoke("saveVaultPassphrase", { orgId, passphrase: value });
    }
  };

  const lock = () => {
    setPassphrase("");
    setKey(null);
    setRevealed({});
    rememberPassphrase(orgId, null);
    if (native) invoke("saveVaultPassphrase", { orgId, passphrase: "" });
  };

  const reveal = async (credential: VaultCredential) => {
    if (!key) return;
    if (revealed[credential.id]) {
      setRevealed((current) => {
        const next = { ...current };
        delete next[credential.id];
        return next;
      });
      return;
    }
    const secret = await decryptSecret(key, credential.ciphertext, credential.iv);
    if (secret === null) {
      notify("Wrong passphrase", "This login was sealed with a different vault passphrase.", "warning");
      return;
    }
    setRevealed((current) => ({ ...current, [credential.id]: secret }));
    void enterprise.actions.touchCredential(credential.id).catch(() => {});
  };

  const copy = async (credential: VaultCredential) => {
    if (!key) return;
    const secret = revealed[credential.id] ?? (await decryptSecret(key, credential.ciphertext, credential.iv));
    if (secret === null) {
      notify("Wrong passphrase", "This login was sealed with a different vault passphrase.", "warning");
      return;
    }
    if (await copyText(secret)) {
      setCopied(credential.id);
      window.setTimeout(() => setCopied((value) => (value === credential.id ? null : value)), 1600);
      void enterprise.actions.touchCredential(credential.id).catch(() => {});
    }
  };

  if (!key) {
    return (
      <div className="vault-section">
        <div className="team-card vault-unlock">
          <header>
            <PixelIcon name="lock" size={18} />
            <h2>{enterprise.credentials.length ? "Unlock the vault" : "Set a vault passphrase"}</h2>
            <p>
              {enterprise.credentials.length
                ? "Logins are sealed with your organization's vault passphrase before they leave this Mac. Ask whoever set it up."
                : "Pick one and share it with your colleagues out of band. Passwords are encrypted with it here, on your Mac; your deployment only ever stores the sealed box."}
            </p>
          </header>
          <div className="form-stack">
            <TextField value={draftPass} onChange={setDraftPass} type="password" icon="key" placeholder="Vault passphrase" onEnter={unlock} />
            <div className="form-inline">
              <span className="form-label">Remember on this Mac</span>
              <Switch checked={remember} onChange={setRemember} />
            </div>
            <Button variant="primary" disabled={!draftPass} onClick={unlock}>
              {enterprise.credentials.length ? "Unlock" : "Set passphrase"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="vault-section">
      <div className="vault-filter">
        <span className="vault-unlocked">
          <PixelIcon name="check" size={13} /> Vault unlocked{remember ? " · remembered on this Mac" : ""}
        </span>
        <span className="spacer" />
        <Button size="sm" variant="ghost" icon="lock" onClick={lock}>
          Lock
        </Button>
        <Button size="sm" variant="primary" icon="plus" onClick={() => setEditing("new")}>
          Add login
        </Button>
      </div>

      {enterprise.credentials.length ? (
        <div className="pref-group">
          {enterprise.credentials.map((credential) => (
            <div className="pref-row vault-row" key={credential.id}>
              <span className="kind-icon">
                <PixelIcon name="key" size={15} />
              </span>
              <span className="pref-copy">
                <strong>
                  {credential.site}
                  {credential.spaceId ? <Chip tone="blue">{credential.spaceName}</Chip> : null}
                </strong>
                <em>
                  {credential.username || "no username"}
                  {revealed[credential.id] ? (
                    <>
                      {" · "}
                      <code className="vault-secret">{revealed[credential.id]}</code>
                    </>
                  ) : null}
                  {credential.lastUsedAt ? ` · used by ${credential.lastUsedBy} ${relativeTime(iso(credential.lastUsedAt))}` : " · never used"}
                  {credential.note ? ` · ${credential.note}` : ""}
                </em>
              </span>
              <span className="pref-control vault-row-tools">
                <IconButton icon={revealed[credential.id] ? "x" : "eye"} label={revealed[credential.id] ? "Hide password" : "Show password"} onClick={() => void reveal(credential)} />
                <Button size="sm" variant="secondary" icon={copied === credential.id ? "check" : "copy"} onClick={() => void copy(credential)}>
                  {copied === credential.id ? "Copied" : "Copy"}
                </Button>
                {credential.canEdit ? <IconButton icon="edit" label="Edit login" onClick={() => setEditing(credential)} /> : null}
                {credential.canEdit ? (
                  <IconButton
                    icon="trash"
                    label="Delete login"
                    onClick={() =>
                      setConfirm({
                        title: `Delete the ${credential.site} login?`,
                        detail: "It's removed for everyone in the organization.",
                        action: "Delete",
                        onConfirm: () => void enterprise.actions.deleteCredential(credential.id).then(() => notify("Deleted", credential.site, "info")).catch((error: Error) => notify("That didn't work", error.message, "warning")),
                      })
                    }
                  />
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <Empty icon="key" title="No logins yet">
          Add the accounts the team shares — the billing portal, the CRM, the ad console — so the agent can sign in when a job needs it and everyone stops pasting passwords in chat.
        </Empty>
      )}

      <CredentialModal editing={editing} vaultKey={key} spaces={joined.map((space) => ({ id: space.id, name: space.name }))} onClose={() => setEditing(null)} />
      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function CredentialModal({ editing, vaultKey, spaces, onClose }: { editing: VaultCredential | null | "new"; vaultKey: CryptoKey; spaces: { id: string; name: string }[]; onClose: () => void }) {
  const { enterprise, notify } = useDashboard();
  const [site, setSite] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [note, setNote] = useState("");
  const [scope, setScope] = useState("org");
  const [busy, setBusy] = useState(false);
  const existing = editing && editing !== "new" ? editing : null;

  useEffect(() => {
    if (!editing) return;
    setSite(existing?.site ?? "");
    setUsername(existing?.username ?? "");
    setPassword("");
    setNote(existing?.note ?? "");
    setScope(existing?.spaceId ?? "org");
  }, [editing, existing]);

  const options = useMemo(() => [{ value: "org", label: "Whole organization" }, ...spaces.map((space) => ({ value: space.id, label: space.name }))], [spaces]);
  const ready = site.trim() && (password || existing) && !busy;

  const save = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      // Editing without a new password keeps the sealed box as it is.
      const sealed = password ? await encryptSecret(vaultKey, password) : { ciphertext: existing!.ciphertext, iv: existing!.iv };
      await enterprise.actions.saveCredential({
        credentialId: existing?.id,
        spaceId: scope === "org" ? null : scope,
        site,
        username,
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        keyVersion: VAULT_KEY_VERSION,
        note,
      });
      notify(existing ? "Login updated" : "Login added", site.trim());
      onClose();
    } catch (error) {
      notify("That didn't work", error instanceof Error ? error.message : String(error), "warning");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={Boolean(editing)} onClose={onClose} title={existing ? "Edit login" : "Add a login"} subtitle="The password is sealed on this Mac before it's saved." width={460}>
      <div className="form-stack">
        <label className="form-label">Site or tool</label>
        <TextField value={site} onChange={setSite} placeholder="stripe.com, Salesforce, the ad console…" autoFocus />
        <label className="form-label">Username or email</label>
        <TextField value={username} onChange={setUsername} placeholder="finance@acme.com" />
        <label className="form-label">Password</label>
        <TextField value={password} onChange={setPassword} type="password" icon="key" placeholder={existing ? "Leave blank to keep the current one" : "••••••••"} />
        <div className="form-inline">
          <span className="form-label">Who can use it</span>
          <Segmented compact options={options} value={scope} onChange={setScope} />
        </div>
        <label className="form-label">Note (optional)</label>
        <TextArea value={note} onChange={setNote} rows={2} placeholder="2FA goes to the shared phone…" />
      </div>
      <footer className="modal-actions">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!ready} onClick={() => void save()}>
          {existing ? "Save" : "Add login"}
        </Button>
      </footer>
    </Modal>
  );
}
