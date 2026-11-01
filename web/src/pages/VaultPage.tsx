import { useEffect, useRef, useState } from "react";
import { useDashboard } from "../store";
import { copyText, cx, formatBytes, relativeTime } from "../lib";
import type { Page } from "../nav";
import type { VaultFile, VaultLogin, VaultState } from "../types";
import { decryptSecret, deriveVaultKey, encryptSecret, rememberPassphrase, rememberedPassphrase, VAULT_KEY_VERSION } from "../vaultCrypto";
import { Button, ConfirmModal, Empty, IconButton, Modal, PageTitle, PixelIcon, Segmented, Switch, TextArea, TextField, type ConfirmRequest } from "../components/ui";

type Tab = "documents" | "credentials";

/** Files the panel hands the Mac in one message; bigger ones are better dropped into the folder in Finder. */
const MAX_UPLOAD = 200 * 1024 * 1024;

function fileIcon(mime: string, name: string): string {
  if (mime.startsWith("image/")) return "eye";
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "note";
  if (/zip|tar|gzip|compressed/.test(mime) || /\.(zip|tgz|gz|7z)$/i.test(name)) return "folder";
  if (mime.startsWith("text/") || /\.(md|txt|csv|json)$/i.test(name)) return "note";
  return "sticker";
}

/** "~/Desktop/Okidoki Vault" rather than the full path. */
function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("couldn't read the file"));
    reader.readAsDataURL(file);
  });
}

const EMPTY_VAULT: VaultState = { folder: "", available: false, truncated: false, files: [], folders: [], logins: [], salt: "", rememberedPassphrase: "" };

export function VaultPage(_: { go: (page: Page) => void }) {
  const { state, invoke } = useDashboard();
  const vault = state.vault ?? EMPTY_VAULT;
  const [tab, setTab] = useState<Tab>("documents");

  return (
    <div className="vault-page">
      <PageTitle
        title="Vault"
        subtitle={vault.folder ? `Documents in ${shortPath(vault.folder)}, and logins sealed on this Mac.` : "Documents in a folder on this Mac, and logins sealed on this Mac."}
        trailing={
          <Segmented
            options={[
              { value: "documents", label: `Documents${vault.files.length ? ` · ${vault.files.length}` : ""}` },
              { value: "credentials", label: `Logins${vault.logins.length ? ` · ${vault.logins.length}` : ""}` },
            ]}
            value={tab}
            onChange={setTab}
          />
        }
      />
      {tab === "documents" ? <Documents vault={vault} invoke={invoke} /> : <Credentials key={vault.salt} vault={vault} />}
    </div>
  );
}

// ---- Documents ----

function Documents({ vault, invoke }: { vault: VaultState; invoke: (type: string, payload?: Record<string, unknown>) => void }) {
  const { notify, native } = useDashboard();
  const [scope, setScope] = useState<string>("all");
  const [uploadTo, setUploadTo] = useState<string>("");
  const [uploading, setUploading] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A folder that went away (renamed in Finder) shouldn't leave the filter on nothing.
  useEffect(() => {
    if (scope !== "all" && scope !== "" && !vault.folders.includes(scope)) setScope("all");
  }, [scope, vault.folders]);

  const files = vault.files.filter((file) => (scope === "all" ? true : file.folder === scope));
  const topFolders = vault.folders.filter((folder) => !folder.includes("/"));

  const upload = async (list: FileList | File[]) => {
    const picked = Array.from(list);
    if (!picked.length) return;
    if (!native) {
      notify("Do this on your Mac", "The browser preview can't write to the vault folder.", "info");
      return;
    }
    const tooBig = picked.filter((file) => file.size > MAX_UPLOAD);
    if (tooBig.length) notify("Too big to drop here", `${tooBig[0].name}: put it in the vault folder in Finder instead.`, "warning");
    const fits = picked.filter((file) => file.size <= MAX_UPLOAD);
    if (!fits.length) return;
    setUploading((current) => [...current, ...fits.map((file) => file.name)]);
    try {
      const encoded = await Promise.all(fits.map(async (file) => ({ name: file.name, data: await readAsBase64(file) })));
      invoke("vaultAddFiles", { folder: uploadTo, files: encoded });
    } catch (error) {
      notify("Couldn't read that", error instanceof Error ? error.message : String(error), "warning");
    } finally {
      setUploading((current) => current.filter((name) => !fits.some((file) => file.name === name)));
    }
  };

  return (
    <div className="vault-section">
      <div className="vault-filter">
        <span className="vault-unlocked">
          <PixelIcon name="folder" size={13} /> {vault.folder ? shortPath(vault.folder) : "No folder yet"}
          {vault.folder && !vault.available ? " · not found" : ""}
        </span>
        <span className="spacer" />
        <Button size="sm" variant="ghost" icon="edit" onClick={() => invoke("vaultChooseFolder")}>
          Change folder
        </Button>
        <Button size="sm" variant="secondary" icon="folder" onClick={() => invoke("vaultOpenFolder")}>
          Open in Finder
        </Button>
      </div>

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
              const picked = Array.from(event.target.files ?? []);
              event.target.value = "";
              void upload(picked);
            }}
          />
        </div>
        <label className="vault-drop-target">
          <span>Into</span>
          <select value={uploadTo} onChange={(event) => setUploadTo(event.target.value)} aria-label="Which folder the files go in">
            <option value="">The vault folder</option>
            {topFolders.map((folder) => (
              <option key={folder} value={folder}>
                {folder}
              </option>
            ))}
          </select>
        </label>
        {uploading.length ? <em className="vault-uploading">Adding {uploading.join(", ")}…</em> : null}
      </div>

      {topFolders.length ? (
        <div className="vault-filter">
          <Segmented
            compact
            options={[{ value: "all", label: "All" }, { value: "", label: "Top level" }, ...topFolders.map((folder) => ({ value: folder, label: folder }))]}
            value={scope}
            onChange={setScope}
          />
        </div>
      ) : null}

      {files.length ? (
        <div className="pref-group">
          {files.map((file) => (
            <VaultFileRow key={file.id} file={file} invoke={invoke} setConfirm={setConfirm} />
          ))}
        </div>
      ) : (
        <Empty icon="folder" title={vault.files.length ? "Nothing in this folder" : "No documents yet"}>
          {vault.files.length
            ? "Pick another folder above."
            : "Contracts, tax forms, scans — anything okidoki should be able to find and use. They stay in the folder on your Mac; ask “add the W-9 to the vault” and it fetches one for you."}
        </Empty>
      )}
      {vault.truncated ? <p className="form-hint">Showing the newest {vault.files.length.toLocaleString("en-US")} files. The rest are still in the folder.</p> : null}

      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function VaultFileRow({ file, invoke, setConfirm }: { file: VaultFile; invoke: (type: string, payload?: Record<string, unknown>) => void; setConfirm: (request: ConfirmRequest) => void }) {
  return (
    <div className="pref-row vault-row">
      <span className="kind-icon">
        <PixelIcon name={fileIcon(file.mime, file.name)} size={15} />
      </span>
      <span className="pref-copy">
        <strong>{file.name}</strong>
        <em>
          {formatBytes(file.size)} · {file.folder || "vault folder"} · {relativeTime(file.modifiedAt)}
        </em>
      </span>
      <span className="pref-control vault-row-tools">
        <Button size="sm" variant="secondary" icon="eye" onClick={() => invoke("vaultOpen", { id: file.id })}>
          Open
        </Button>
        <IconButton icon="folder" label="Show in Finder" onClick={() => invoke("vaultReveal", { id: file.id })} />
        <IconButton
          icon="trash"
          label="Move to Trash"
          onClick={() =>
            setConfirm({
              title: `Move ${file.name} to the Trash?`,
              detail: "It leaves the vault folder. You can put it back from the Trash.",
              action: "Move to Trash",
              onConfirm: () => invoke("vaultDelete", { id: file.id }),
            })
          }
        />
      </span>
    </div>
  );
}

// ---- Credentials ----

function Credentials({ vault }: { vault: VaultState }) {
  const { notify, native, invoke } = useDashboard();
  const salt = vault.salt;
  const [passphrase, setPassphrase] = useState(() => vault.rememberedPassphrase || rememberedPassphrase(salt) || "");
  const [remember, setRemember] = useState(() => Boolean(vault.rememberedPassphrase || rememberedPassphrase(salt)));
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [draftPass, setDraftPass] = useState("");
  // Setting the first passphrase asks for it twice: a typo would seal every login with a passphrase no one knows.
  const [confirmPass, setConfirmPass] = useState("");
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<VaultLogin | null | "new">(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!passphrase || !salt) {
      setKey(null);
      return;
    }
    void deriveVaultKey(passphrase, salt).then((derived) => {
      if (!cancelled) setKey(derived);
    });
    return () => {
      cancelled = true;
    };
  }, [passphrase, salt]);

  const unlock = async () => {
    const value = draftPass;
    if (!value) return;
    if (vault.logins.length === 0 && value !== confirmPass) {
      notify("Passphrases don’t match", "Type the same passphrase in both fields.", "warning");
      return;
    }
    // With logins already there, a wrong passphrase is caught here rather than on the first reveal.
    const first = vault.logins[0];
    if (first && (await decryptSecret(await deriveVaultKey(value, salt), first.ciphertext, first.iv)) === null) {
      notify("Wrong passphrase", "That isn't the passphrase these logins were sealed with.", "warning");
      return;
    }
    setPassphrase(value);
    setDraftPass("");
    setConfirmPass("");
    if (remember) {
      rememberPassphrase(salt, value);
      if (native) invoke("saveVaultPassphrase", { passphrase: value });
    }
  };

  const lock = () => {
    setPassphrase("");
    setKey(null);
    setRevealed({});
    rememberPassphrase(salt, null);
    if (native) invoke("saveVaultPassphrase", { passphrase: "" });
  };

  const reveal = async (login: VaultLogin) => {
    if (!key) return;
    if (revealed[login.id]) {
      setRevealed((current) => {
        const next = { ...current };
        delete next[login.id];
        return next;
      });
      return;
    }
    const secret = await decryptSecret(key, login.ciphertext, login.iv);
    if (secret === null) {
      notify("Wrong passphrase", "This login was sealed with a different vault passphrase.", "warning");
      return;
    }
    setRevealed((current) => ({ ...current, [login.id]: secret }));
    invoke("vaultTouchLogin", { id: login.id });
  };

  const copy = async (login: VaultLogin) => {
    if (!key) return;
    const secret = revealed[login.id] ?? (await decryptSecret(key, login.ciphertext, login.iv));
    if (secret === null) {
      notify("Wrong passphrase", "This login was sealed with a different vault passphrase.", "warning");
      return;
    }
    if (await copyText(secret)) {
      setCopied(login.id);
      window.setTimeout(() => setCopied((value) => (value === login.id ? null : value)), 1600);
      invoke("vaultTouchLogin", { id: login.id });
    }
  };

  if (!key) {
    return (
      <div className="vault-section">
        <div className="team-card vault-unlock">
          <header>
            <PixelIcon name="lock" size={18} />
            <h2>{vault.logins.length ? "Unlock the vault" : "Set a vault passphrase"}</h2>
            <p>
              {vault.logins.length
                ? "Logins are sealed with your vault passphrase. Nothing can read them without it, okidoki included."
                : "Pick one you'll remember. Passwords are sealed with it right here, before they're saved; only the sealed box is kept on this Mac."}
            </p>
          </header>
          <div className="form-stack">
            <TextField value={draftPass} onChange={setDraftPass} type="password" icon="key" placeholder="Vault passphrase" onEnter={() => void unlock()} />
            {vault.logins.length === 0 ? (
              <TextField value={confirmPass} onChange={setConfirmPass} type="password" icon="key" placeholder="Same passphrase again" onEnter={() => void unlock()} />
            ) : null}
            <div className="form-inline">
              <span className="form-label">Remember on this Mac</span>
              <Switch checked={remember} onChange={setRemember} />
            </div>
            <Button variant="primary" disabled={!draftPass || (vault.logins.length === 0 && !confirmPass)} onClick={() => void unlock()}>
              {vault.logins.length ? "Unlock" : "Set passphrase"}
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

      {vault.logins.length ? (
        <div className="pref-group">
          {vault.logins.map((login) => (
            <div className="pref-row vault-row" key={login.id}>
              <span className="kind-icon">
                <PixelIcon name="key" size={15} />
              </span>
              <span className="pref-copy">
                <strong>{login.site}</strong>
                <em>
                  {login.username || "no username"}
                  {revealed[login.id] ? (
                    <>
                      {" · "}
                      <code className="vault-secret">{revealed[login.id]}</code>
                    </>
                  ) : null}
                  {login.lastUsedAt ? ` · used ${relativeTime(login.lastUsedAt)}` : " · never used"}
                  {login.note ? ` · ${login.note}` : ""}
                </em>
              </span>
              <span className="pref-control vault-row-tools">
                <IconButton icon={revealed[login.id] ? "x" : "eye"} label={revealed[login.id] ? "Hide password" : "Show password"} onClick={() => void reveal(login)} />
                <Button size="sm" variant="secondary" icon={copied === login.id ? "check" : "copy"} onClick={() => void copy(login)}>
                  {copied === login.id ? "Copied" : "Copy"}
                </Button>
                <IconButton icon="edit" label="Edit login" onClick={() => setEditing(login)} />
                <IconButton
                  icon="trash"
                  label="Delete login"
                  onClick={() =>
                    setConfirm({
                      title: `Delete the ${login.site} login?`,
                      detail: "It's removed from this Mac.",
                      action: "Delete",
                      onConfirm: () => {
                        invoke("vaultDeleteLogin", { id: login.id });
                        notify("Deleted", login.site, "info");
                      },
                    })
                  }
                />
              </span>
            </div>
          ))}
        </div>
      ) : (
        <Empty icon="key" title="No logins yet">
          Add the accounts you use for chores — the billing portal, the bank, the utility site — so a replay can sign in when it needs to and you stop hunting for passwords.
        </Empty>
      )}

      <LoginModal editing={editing} vaultKey={key} onClose={() => setEditing(null)} />
      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function LoginModal({ editing, vaultKey, onClose }: { editing: VaultLogin | null | "new"; vaultKey: CryptoKey; onClose: () => void }) {
  const { invoke, notify } = useDashboard();
  const [site, setSite] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const existing = editing && editing !== "new" ? editing : null;

  useEffect(() => {
    if (!editing) return;
    setSite(existing?.site ?? "");
    setUsername(existing?.username ?? "");
    setPassword("");
    setNote(existing?.note ?? "");
  }, [editing, existing]);

  const ready = site.trim() && (password || existing) && !busy;

  const save = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      // Editing without a new password keeps the sealed box as it is.
      const sealed = password ? await encryptSecret(vaultKey, password) : { ciphertext: existing!.ciphertext, iv: existing!.iv };
      invoke("vaultSaveLogin", {
        login: { id: existing?.id ?? "", site: site.trim(), username: username.trim(), ciphertext: sealed.ciphertext, iv: sealed.iv, keyVersion: VAULT_KEY_VERSION, note },
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
        <TextField value={site} onChange={setSite} placeholder="stripe.com, the bank, the utility portal…" autoFocus />
        <label className="form-label">Username or email</label>
        <TextField value={username} onChange={setUsername} placeholder="you@example.com" />
        <label className="form-label">Password</label>
        <TextField value={password} onChange={setPassword} type="password" icon="key" placeholder={existing ? "Leave blank to keep the current one" : "••••••••"} />
        <label className="form-label">Note (optional)</label>
        <TextArea value={note} onChange={setNote} rows={2} placeholder="2FA goes to my phone…" />
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
