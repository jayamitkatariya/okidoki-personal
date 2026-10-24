import { useEffect, useState } from "react";
import { useDashboard } from "../store";
import { cx, relativeTime } from "../lib";
import { Button, ConfirmModal, IconButton, Modal, PageTitle, PixelIcon, Switch, TextField, type ConfirmRequest } from "../components/ui";

const PROVIDERS = [
  {
    id: "anthropic",
    name: "Anthropic",
    blurb: "Required. Reads the screen, teaches, and plans every action.",
    placeholder: "sk-ant-…",
    url: "https://console.anthropic.com/settings/keys",
    required: true,
  },
  {
    id: "cartesia",
    name: "Cartesia",
    blurb: "Fast, warm voices for spoken answers.",
    placeholder: "sk_car_…",
    url: "https://play.cartesia.ai/console",
    required: false,
  },
  {
    id: "moss",
    name: "Moss",
    blurb: "Semantic search across your threads and memory.",
    placeholder: "project-id:project-key",
    url: "https://moss.dev",
    required: false,
  },
  {
    id: "apify",
    name: "Apify",
    blurb: "Live web scraping and ready-made actors.",
    placeholder: "apify_api_…",
    url: "https://console.apify.com/account/integrations",
    required: false,
  },
  {
    id: "convex",
    name: "Convex sync secret",
    blurb: "Lets the Mac app talk to your private sync endpoint.",
    placeholder: "Sync secret",
    url: "https://convex.dev",
    required: false,
  },
] as const;

export function KeysPage() {
  const { state, settings, updateSettings, invoke, notify, convexConnected } = useDashboard();
  const [editing, setEditing] = useState<(typeof PROVIDERS)[number] | null>(null);
  const [value, setValue] = useState("");
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  // A local draft, committed on blur or Enter, so typing doesn't save, sync and reconnect on every key.
  const [urlDraft, setUrlDraft] = useState(settings.convexSiteURL);
  useEffect(() => setUrlDraft(settings.convexSiteURL), [settings.convexSiteURL]);
  const commitURL = () => {
    const next = urlDraft.trim();
    if (next !== settings.convexSiteURL) updateSettings({ convexSiteURL: next });
  };

  const open = (provider: (typeof PROVIDERS)[number]) => {
    setEditing(provider);
    setValue("");
  };

  const added = PROVIDERS.filter((provider) => state.keys[provider.id]).length;
  const syncState = convexConnected ? "Live" : settings.syncEnabled ? "Waiting" : "Off";

  return (
    <div className="keys-page">
      <PageTitle
        title="Keys"
        subtitle="An Anthropic key is required. Everything else is optional, and every key stays on this Mac."
        trailing={
          <span className="keys-badge">
            <PixelIcon name="lock" size={14} />
            Stored on this Mac
          </span>
        }
      />

      <section className="tile keys-tile">
        <header className="tile-head">
          <h2>API keys</h2>
          <span className="tile-count">
            {added}/{PROVIDERS.length}
          </span>
        </header>
        <div className="pref-list keys-list">
          {PROVIDERS.map((provider) => {
            const configured = Boolean(state.keys[provider.id]);
            return (
              <div className={cx("pref-row keys-row", configured && "is-configured")} key={provider.id}>
                <span className="keys-mark" style={keyTone(provider.id)}>
                  {provider.name.slice(0, 1)}
                </span>
                <span className="pref-copy">
                  <span className="keys-name">
                    <strong>{provider.name}</strong>
                    {provider.required && !configured ? <span className="chip chip-green">Recommended</span> : null}
                  </span>
                  <em>{provider.blurb}</em>
                </span>
                <span className="pref-control">
                  {configured ? (
                    <>
                      <span className="pref-status is-on">
                        <PixelIcon name="check" size={13} /> Added
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => open(provider)}>
                        Replace
                      </Button>
                      <IconButton
                        icon="trash"
                        label={`Remove ${provider.name} key`}
                        className="keys-remove"
                        onClick={() =>
                          setConfirm({
                            title: `Remove the ${provider.name} key?`,
                            detail: "It's deleted from this Mac. You'll need to paste it again to use it.",
                            action: "Remove key",
                            onConfirm: () => {
                              invoke("deleteKey", { provider: provider.id });
                              notify("Key removed", provider.name, "info");
                            },
                          })
                        }
                      />
                    </>
                  ) : (
                    <>
                      <button className="text-link" onClick={() => invoke("openExternal", { url: provider.url })}>
                        Get a key <PixelIcon name="external" size={12} />
                      </button>
                      <Button variant={provider.required ? "primary" : "secondary"} size="sm" icon="plus" onClick={() => open(provider)}>
                        Add
                      </Button>
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="tile keys-tile">
        <header className="tile-head">
          <h2>Sync</h2>
          <span className={cx("keys-sync-state", convexConnected && "is-live", !convexConnected && settings.syncEnabled && "is-waiting")}>
            <i />
            {syncState}
          </span>
          <span className="keys-actions-buttons">
            <Button variant="ghost" size="sm" icon="external" onClick={() => invoke("openExternal", { url: "http://127.0.0.1:6791" })}>
              Dashboard
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon="refresh"
              disabled={!settings.syncEnabled}
              title={settings.syncEnabled ? undefined : "Turn on sync first"}
              onClick={() => {
                if (!state.keys.convex) {
                  notify("Add a sync secret first", "Convex sync secret, above", "warning");
                  return;
                }
                invoke("syncNow");
                notify("Syncing", "Pushing this Mac's state", "info");
              }}
            >
              Sync now
            </Button>
          </span>
        </header>
        <p className="keys-lead">
          Mirrors threads, memory and runs to your own Convex deployment so this panel and share links stay live. The sync secret above is its password. {state.sidecar === "ready" ? "The brain is running." : `Brain: ${state.sidecar}.`}
        </p>
        <div className="pref-list keys-list">
          <div className="pref-row">
            <span className="pref-copy">
              <strong>Sync threads, memory and runs</strong>
              <em>{settings.lastSyncAt ? `Last synced ${relativeTime(settings.lastSyncAt)}` : "Never synced"}</em>
            </span>
            <Switch
              label="Sync"
              checked={settings.syncEnabled}
              onChange={(value) => {
                updateSettings({ syncEnabled: value });
                notify(value ? "Sync on" : "Sync off", value ? "Using your Convex deployment" : "Everything stays local", "info");
              }}
            />
          </div>
          <div className="pref-row">
            <span className="pref-copy">
              <strong>Deployment URL</strong>
              <em>Your Convex HTTP actions URL</em>
            </span>
            <TextField
              value={urlDraft}
              onChange={setUrlDraft}
              onBlur={commitURL}
              onEnter={commitURL}
              placeholder="http://127.0.0.1:3211"
              icon="link"
              className="keys-url"
            />
          </div>
          <div className="pref-row is-stack keys-selfhost-row">
            <details className="keys-selfhost">
              <summary>
                <PixelIcon name="chevron" size={13} />
                Self-host locally
              </summary>
              <pre className="keys-code">
                <code>{"cd backend && docker compose up -d\ndocker compose exec backend ./generate_admin_key.sh\nnpx convex dev"}</code>
              </pre>
            </details>
          </div>
        </div>
      </section>

      <footer className="keys-foot">
        <PixelIcon name="lock" size={13} />
        Keys never reach Convex or this panel. They only leave your Mac as the Authorization header on your own requests.
      </footer>

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing ? `${state.keys[editing.id] ? "Replace" : "Add"} ${editing.name} key` : "Key"}
        subtitle="Saved privately on this Mac. It's never shown again, here or anywhere."
        width={480}
      >
        {editing ? (
          <>
            <div className="form-stack">
              <TextField
                value={value}
                onChange={setValue}
                placeholder={editing.placeholder}
                type="password"
                icon="key"
                autoFocus
                onEnter={() => {
                  if (!value.trim()) return;
                  invoke("saveKey", { provider: editing.id, value: value.trim() });
                  notify("Key saved", `${editing.name} · on this Mac`);
                  setEditing(null);
                }}
              />
              <p className="keys-modal-note">
                {editing.id === "anthropic"
                  ? "Without it, answers and screen reading fall back to the local router. The notch, voice and Apple apps still work."
                  : "Optional. Add it when you want this capability."}{" "}
                <button className="text-link" onClick={() => invoke("openExternal", { url: editing.url })}>
                  Get a key <PixelIcon name="external" size={12} />
                </button>
              </p>
            </div>
            <footer className="modal-actions">
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!value.trim()}
                onClick={() => {
                  invoke("saveKey", { provider: editing.id, value: value.trim() });
                  notify("Key saved", `${editing.name} · on this Mac`);
                  setEditing(null);
                }}
              >
                Save key
              </Button>
            </footer>
          </>
        ) : null}
      </Modal>
      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

const KEY_TONES: Record<string, { bg: string; fg: string }> = {
  anthropic: { bg: "var(--accent-soft)", fg: "var(--accent-ink)" },
  cartesia: { bg: "var(--lavender-soft)", fg: "var(--lavender)" },
  moss: { bg: "var(--green-soft)", fg: "var(--green)" },
  apify: { bg: "var(--sky-soft)", fg: "var(--sky)" },
  convex: { bg: "var(--amber-soft)", fg: "var(--amber)" },
};

function keyTone(id: string): React.CSSProperties {
  const tone = KEY_TONES[id] ?? { bg: "var(--well-strong)", fg: "var(--ink-2)" };
  return { background: tone.bg, color: tone.fg };
}
