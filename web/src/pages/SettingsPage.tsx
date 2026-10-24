import { useEffect, useRef, useState } from "react";
import { useDashboard } from "../store";
import { cx, relativeTime } from "../lib";
import type { AccountKind } from "../types";
import { SyncLogin } from "../components/CloudAuth";
import { Avatar, Button, ConfirmModal, IconButton, PageTitle, PixelIcon, Segmented, Switch, TextArea, TextField, type ConfirmRequest } from "../components/ui";

const VOICES = [
  { id: "sarah", name: "Sarah", blurb: "Calm, clear, a little dry" },
  { id: "brielle", name: "Brielle", blurb: "Warm and quick" },
  { id: "barney", name: "Barney", blurb: "Low, friendly, unhurried" },
  { id: "system", name: "System voice", blurb: "Your Mac's own voice" },
];

const PERMISSIONS = [
  { id: "screen", title: "Screen recording", icon: "screen", blurb: "See what you're looking at when you ask" },
  { id: "microphone", title: "Microphone", icon: "mic", blurb: "Talk instead of type" },
  { id: "accessibility", title: "Accessibility", icon: "cursor", blurb: "Click and type when you lend the screen" },
  { id: "automation", title: "Automation", icon: "bolt", blurb: "Reminders, Calendar and Notes without opening them" },
];

// Brand-green family first; the setting key stays cursorGlowHex / drawingColorHex.
const COLORS = ["1FB57A", "3DDC97", "9BE8C6", "0B8A5E", "B8F26B", "8FB7FF", "F7F2E9"];

const SECTIONS = [
  { id: "instructions", label: "Instructions", icon: "pencil" },
  { id: "voice", label: "Voice & input", icon: "mic" },
  { id: "permissions", label: "Permissions", icon: "lock" },
  { id: "safety", label: "Safety", icon: "hand" },
  { id: "notch", label: "Notch", icon: "bell" },
  { id: "appearance", label: "Appearance", icon: "sun" },
  { id: "account", label: "Account", icon: "user" },
  { id: "sync-login", label: "Sync login", icon: "link" },
  { id: "advanced", label: "Advanced", icon: "gear" },
];

export function SettingsPage() {
  const { state, settings, account, updateSettings, invoke, notify, convexConnected, native } = useDashboard();
  const [instructions, setInstructions] = useState(settings.customInstructions);
  const [name, setName] = useState(account.name);
  const [email, setEmail] = useState(account.email);
  const [kind, setKind] = useState<AccountKind>(account.kind);
  const [appDraft, setAppDraft] = useState("");
  const [askDraft, setAskDraft] = useState("");
  const [active, setActive] = useState(SECTIONS[0].id);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  useEffect(() => setInstructions(settings.customInstructions), [settings.customInstructions]);
  useEffect(() => {
    setName(account.name);
    setEmail(account.email);
    setKind(account.kind);
  }, [account.id, account.name, account.email, account.kind]);

  // Highlight the section at the top of the scroll area. Driven by scroll position, so the
  // last sections still light up at the bottom, and a click holds its section while the
  // smooth scroll passes the others.
  const jumping = useRef<number | null>(null);
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".content");
    if (!root) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (jumping.current !== null) return;
      const top = root.getBoundingClientRect().top + 96;
      let current: string = SECTIONS[0].id;
      for (const section of SECTIONS) {
        const node = document.getElementById(`settings-${section.id}`);
        if (node && node.getBoundingClientRect().top <= top) current = section.id;
      }
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) current = SECTIONS[SECTIONS.length - 1].id;
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      root.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
      if (jumping.current !== null) window.clearTimeout(jumping.current);
    };
  }, []);

  const jump = (id: string) => {
    setActive(id);
    if (jumping.current !== null) window.clearTimeout(jumping.current);
    jumping.current = window.setTimeout(() => (jumping.current = null), 700);
    document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const addToList = (list: "blockedApps" | "alwaysAsk", value: string) => {
    if (!value.trim()) return;
    if (settings[list].includes(value.trim())) return;
    updateSettings({ [list]: [...settings[list], value.trim()] } as never);
  };

  const profileDirty = name !== account.name || email !== account.email || kind !== account.kind;
  const instructionsDirty = instructions !== settings.customInstructions;

  return (
    <div className="settings-page">
      <PageTitle title="Settings" subtitle="Everything stays on this Mac unless you turn on sync." />

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.filter((section) => native || section.id !== "sync-login").map((section) => (
            <button key={section.id} className={cx("settings-nav-item", active === section.id && "is-active")} onClick={() => jump(section.id)}>
              <PixelIcon name={section.icon} size={15} />
              {section.label}
            </button>
          ))}
          <span className="settings-nav-version">okidoki {state.version}</span>
        </nav>

        <div className="settings-body">
          <SettingsSection id="instructions" title="Instructions" description="Added to the top of every request. Keep it short and concrete.">
            <div className="pref-group">
              <div className="pref-row is-stack">
                <TextArea value={instructions} onChange={setInstructions} rows={4} placeholder="Keep answers short. I'm a student. Prefer free tools." />
                <div className="pref-row-foot">
                  <span className="pref-hint">{instructions.length} characters</span>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!instructionsDirty}
                    onClick={() => {
                      updateSettings({ customInstructions: instructions });
                      notify("Instructions saved", "Applies to the next request");
                    }}
                  >
                    Save
                  </Button>
                </div>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection id="voice" title="Voice & input" description="Your default for every summon. You can switch for a single request.">
            <div className="pref-group">
              <PrefRow title="Default input" detail={settings.defaultInput === "voice" ? "Starts listening right away" : "A small box opens at your cursor"}>
                <Segmented
                  options={[
                    { value: "voice", label: "Voice" },
                    { value: "typing", label: "Typing" },
                  ]}
                  value={settings.defaultInput}
                  onChange={(value) => updateSettings({ defaultInput: value as "voice" | "typing" })}
                />
              </PrefRow>
              <PrefRow title="Speaking speed">
                <Slider min={0.7} max={1.4} step={0.05} value={settings.voiceSpeed} onChange={(value) => updateSettings({ voiceSpeed: value })} format={(value) => `${value.toFixed(2)}×`} />
              </PrefRow>
              <PrefRow title="Captions" detail="Show what okidoki is saying">
                <Switch label="Captions" checked={settings.captions} onChange={(value) => updateSettings({ captions: value })} />
              </PrefRow>
              <PrefRow title="Say “okidoki!”" detail="A quick confirmation when it takes a task">
                <Switch label="Confirmation" checked={settings.confirmOK} onChange={(value) => updateSettings({ confirmOK: value })} />
              </PrefRow>
            </div>

            <div className="pref-group">
              <div className="pref-row is-stack">
                <span className="pref-copy">
                  <strong>Voice</strong>
                  <em>Pick one to hear a preview.</em>
                </span>
                <div className="voice-grid">
                  {VOICES.map((voice) => {
                    const selected = settings.voiceID === voice.id;
                    return (
                      <button
                        key={voice.id}
                        role="radio"
                        aria-checked={selected}
                        className={cx("voice-card", selected && "is-selected")}
                        onClick={() => {
                          updateSettings({ voiceID: voice.id });
                          invoke("previewVoice", { voice: voice.id });
                          notify("Voice changed", voice.name);
                        }}
                      >
                        <span className="voice-wave" aria-hidden="true">
                          {[0, 1, 2, 3, 4].map((bar) => (
                            <i key={bar} style={{ height: 5 + ((bar * 5) % 11) }} />
                          ))}
                        </span>
                        <span className="voice-copy">
                          <strong>{voice.name}</strong>
                          <em>{voice.blurb}</em>
                        </span>
                        <span className={cx("voice-radio", selected && "is-on")}>{selected ? <PixelIcon name="check" size={11} /> : null}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection id="permissions" title="Permissions" description="macOS owns these. Reopen okidoki after changing screen recording.">
            <div className="pref-group">
              {PERMISSIONS.map((permission) => {
                const status = state.permissions[permission.id] ?? "not yet";
                const granted = status === "granted";
                return (
                  <div className="pref-row" key={permission.id}>
                    <span className={cx("kind-icon small", !granted && "is-warn")}>
                      <PixelIcon name={permission.icon} size={14} />
                    </span>
                    <span className="pref-copy">
                      <strong>{permission.title}</strong>
                      <em>{permission.blurb}</em>
                    </span>
                    <span className="pref-control">
                      {granted ? (
                        <span className="pref-status is-on">
                          <PixelIcon name="check" size={13} /> Granted
                        </span>
                      ) : (
                        <>
                          <span className="pref-status is-warn">{status}</span>
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => {
                              invoke("requestPermission", { kind: permission.id });
                              notify("Asking macOS", permission.title, "info");
                            }}
                          >
                            Grant
                          </Button>
                        </>
                      )}
                      <IconButton icon="external" label={`Open ${permission.title} in System Settings`} onClick={() => invoke("openPermissionSettings", { kind: permission.id })} />
                    </span>
                  </div>
                );
              })}
            </div>
          </SettingsSection>

          <SettingsSection id="safety" title="Safety" description="okidoki always asks before sending, buying, deleting, installing or running risky commands.">
            <div className="pref-group">
              <PrefRow title="Background mode" detail="Long jobs run without touching your cursor">
                <Switch label="Background mode" checked={settings.backgroundMode} onChange={(value) => updateSettings({ backgroundMode: value })} />
              </PrefRow>
              <PrefRow title="Screen borrowing" detail="A ghost cursor, ten seconds at a time">
                <Switch label="Screen borrowing" checked={settings.screenBorrowing} onChange={(value) => updateSettings({ screenBorrowing: value })} />
              </PrefRow>
              <PrefRow title="Hide in screenshots" detail="Keep the overlay out of captures">
                <Switch label="Hide in screenshots" checked={settings.hideInScreenshots} onChange={(value) => updateSettings({ hideInScreenshots: value })} />
              </PrefRow>
              <PrefRow title="Spending limit" detail="Per task, for tools that cost money">
                <Slider min={0} max={200} step={5} value={settings.spendingLimit} onChange={(value) => updateSettings({ spendingLimit: value })} format={(value) => `$${value}`} />
              </PrefRow>
            </div>

            <div className="pref-group">
              <ListEditor
                title="Blocked apps and tools"
                detail="okidoki never opens or runs these."
                placeholder="Add an app or tool"
                draft={appDraft}
                setDraft={setAppDraft}
                items={settings.blockedApps}
                labelFor={(item) => {
                  const tool = state.tools.find((candidate) => candidate.command.toLowerCase() === item.trim().toLowerCase());
                  return tool && tool.name.toLowerCase() !== item.toLowerCase() ? `${tool.name} (${item})` : item;
                }}
                empty="Nothing blocked."
                onAdd={() => {
                  addToList("blockedApps", appDraft);
                  setAppDraft("");
                }}
                onRemove={(item) => updateSettings({ blockedApps: settings.blockedApps.filter((value) => value !== item) })}
              />
              <ListEditor
                title="Always ask"
                detail="Extra commands or tools that need your yes."
                placeholder="Command or tool"
                draft={askDraft}
                setDraft={setAskDraft}
                items={settings.alwaysAsk}
                empty="Risky commands already ask."
                onAdd={() => {
                  addToList("alwaysAsk", askDraft);
                  setAskDraft("");
                }}
                onRemove={(item) => updateSettings({ alwaysAsk: settings.alwaysAsk.filter((value) => value !== item) })}
              />
              {settings.alwaysAllow.length ? (
                <div className="pref-row is-stack">
                  <span className="pref-copy">
                    <strong>Always allowed</strong>
                    <em>Things you said yes to for good. Remove one to be asked again.</em>
                  </span>
                  <div className="chip-row">
                    {settings.alwaysAllow.map((item) => (
                      <RemovableChip key={item} label={item} onRemove={() => updateSettings({ alwaysAllow: settings.alwaysAllow.filter((value) => value !== item) })} />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </SettingsSection>

          <SettingsSection id="notch" title="Notch" description="Your status center. On Macs without a notch it floats at the top.">
            <div className="pref-group">
              <PrefRow title="Show in the notch" detail="Toasts, progress and approvals">
                <Switch label="Show in the notch" checked={settings.notchEnabled} onChange={(value) => updateSettings({ notchEnabled: value })} />
              </PrefRow>
              <PrefRow title="Quiet mode" detail="Silent during calls and screen shares">
                <Switch label="Quiet mode" checked={settings.quietMode} onChange={(value) => updateSettings({ quietMode: value })} />
              </PrefRow>
              <PrefRow title="Notifications">
                <Segmented
                  options={[
                    { value: "everything", label: "All" },
                    { value: "approvalsAndDone", label: "Approvals + done" },
                    { value: "silent", label: "None" },
                  ]}
                  value={settings.notificationStyle}
                  onChange={(value) => updateSettings({ notificationStyle: value as typeof settings.notificationStyle })}
                  compact
                />
              </PrefRow>
            </div>
          </SettingsSection>

          <SettingsSection id="appearance" title="Appearance" description="The glow follows your real cursor, since macOS doesn't let apps recolor it.">
            <div className="pref-group">
              <PrefRow title="Theme">
                <Segmented
                  options={[
                    { value: "system", label: "System" },
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark" },
                  ]}
                  value={settings.appearance}
                  onChange={(value) => updateSettings({ appearance: value as typeof settings.appearance })}
                />
              </PrefRow>
              <PrefRow title="Cursor glow">
                <Swatches value={settings.cursorGlowHex} onPick={(color) => updateSettings({ cursorGlowHex: color })} />
              </PrefRow>
              <PrefRow title="Shake sensitivity" detail="Lower is easier to trigger">
                <Slider
                  min={0.2}
                  max={1}
                  step={0.05}
                  value={settings.shakeSensitivity}
                  onChange={(value) => updateSettings({ shakeSensitivity: value })}
                  format={(value) => `${Math.round(value * 100)}%`}
                />
              </PrefRow>
            </div>
            <div className="pref-group">
              <PrefRow title="Drawing pen">
                <Segmented
                  options={[
                    { value: "ink", label: "Ink" },
                    { value: "marker", label: "Marker" },
                    { value: "pencil", label: "Pencil" },
                  ]}
                  value={settings.drawingStyle}
                  onChange={(value) => updateSettings({ drawingStyle: value as typeof settings.drawingStyle })}
                  compact
                />
              </PrefRow>
              <PrefRow title="Drawing color">
                <Swatches value={settings.drawingColorHex} onPick={(color) => updateSettings({ drawingColorHex: color })} small />
              </PrefRow>
            </div>
          </SettingsSection>

          <SettingsSection id="account" title="Account" description="Personal and work accounts keep separate threads, runs, skills and routines. Memory is shared by every account on this Mac.">
            <div className="pref-group">
              <PrefRow title="Name">
                <TextField value={name} onChange={setName} className="pref-field" />
              </PrefRow>
              <PrefRow title="Email">
                <TextField value={email} onChange={setEmail} type="email" className="pref-field" />
              </PrefRow>
              <PrefRow title="Type">
                <Segmented
                  options={[
                    { value: "personal", label: "Personal" },
                    { value: "work", label: "Work" },
                  ]}
                  value={kind}
                  onChange={(value) => setKind(value as AccountKind)}
                />
              </PrefRow>
              <div className="pref-row pref-row-end">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!profileDirty}
                  onClick={() => {
                    invoke("updateAccount", { name, email, kind });
                    notify("Profile saved", name);
                  }}
                >
                  Save profile
                </Button>
              </div>
            </div>

            <div className="pref-group">
              {state.accounts.map((item) => {
                const current = item.id === state.currentAccountID;
                return (
                  <button key={item.id} className={cx("pref-row pref-row-button", current && "is-current")} onClick={() => invoke("switchAccount", { id: item.id })}>
                    <Avatar account={item} size={28} />
                    <span className="pref-copy">
                      <strong className="capitalize">{item.name}</strong>
                      <em>{item.kind}</em>
                    </span>
                    {current ? (
                      <span className="pref-status is-on">
                        <PixelIcon name="check" size={13} /> Current
                      </span>
                    ) : (
                      <span className="pref-switch-hint">
                        Switch <PixelIcon name="chevron" size={14} />
                      </span>
                    )}
                  </button>
                );
              })}
              <button className="pref-row pref-row-button pref-action" onClick={() => invoke("signOut")}>
                <PixelIcon name="logout" size={15} />
                Sign out
              </button>
              <button
                className="pref-row pref-row-button pref-action is-danger"
                disabled={state.accounts.length <= 1}
                title={state.accounts.length <= 1 ? "Your only account can't be deleted. Add another first." : undefined}
                onClick={() =>
                  setConfirm({
                    title: `Delete ${account.name}?`,
                    detail: "Its threads, runs, skills and routines go with it. Memory is shared and stays. This can't be undone.",
                    action: "Delete account",
                    onConfirm: () => invoke("deleteAccount", { id: state.currentAccountID }),
                  })
                }
              >
                <PixelIcon name="trash" size={15} />
                Delete account…
                {state.accounts.length <= 1 ? <span className="pref-hint">Add another account first</span> : null}
              </button>
            </div>
          </SettingsSection>

          {/* Sync login: only inside the Mac app; the hosted panel signs in at its front door. */}
          {native ? (
            <SettingsSection id="sync-login" title="Sync login" description="Link this Mac's accounts to a login on your own Convex deployment. Only that login can read what syncs.">
              <div className="pref-group">
                <SyncLogin onOpenKeys={() => (window.location.hash = "#/keys")} />
              </div>
            </SettingsSection>
          ) : null}

          <SettingsSection id="advanced" title="Advanced" description="The boring but necessary bits.">
            <div className="pref-group">
              <PrefRow title="Onboarding" detail="Walk through setup again">
                <Button variant="secondary" size="sm" icon="wand" onClick={() => invoke("openOnboarding")}>
                  Replay
                </Button>
              </PrefRow>
              <PrefRow title="Data folder" detail="Threads, memory and logs on disk">
                <Button variant="secondary" size="sm" icon="folder" onClick={() => invoke("openDataFolder")}>
                  Open
                </Button>
              </PrefRow>
              <PrefRow title="Installed tools" detail="Check your PATH for new tools">
                <Button
                  variant="secondary"
                  size="sm"
                  icon="refresh"
                  onClick={() => {
                    invoke("refreshTools");
                    notify("Checking tools", "Reading your PATH", "info");
                  }}
                >
                  Rescan
                </Button>
              </PrefRow>
            </div>

            <div className="pref-group">
              <PrefRow title="Brain">
                <span className={cx("pref-value", state.sidecar === "ready" && "is-on")}>
                  <i />
                  {state.sidecar}
                </span>
              </PrefRow>
              <PrefRow title="Convex">
                <span className={cx("pref-value", state.convexConfigured && "is-on")}>
                  <i />
                  {state.convexConfigured ? "Configured" : "Local only"}
                </span>
              </PrefRow>
              <PrefRow title="Convex live">
                <span className={cx("pref-value", convexConnected && "is-on")}>
                  <i />
                  {convexConnected ? "Yes" : "No"}
                </span>
              </PrefRow>
              {settings.lastSyncAt ? (
                <PrefRow title="Last sync">
                  <span className="pref-hint">{relativeTime(settings.lastSyncAt)}</span>
                </PrefRow>
              ) : null}
            </div>

            <div className="pref-group">
              <PrefRow title="Quit okidoki" detail="Stops listening until you open it again">
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() =>
                    setConfirm({
                      title: "Quit okidoki?",
                      detail: "It stops listening until you open it again.",
                      action: "Quit",
                      onConfirm: () => invoke("quit"),
                    })
                  }
                >
                  Quit
                </Button>
              </PrefRow>
            </div>
          </SettingsSection>

          <footer className="settings-foot">
            <PixelIcon name="lock" size={13} />
            Open source. Keys in your Keychain. Screenshots never stored. No background tracking.
          </footer>
        </div>
      </div>
      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function SettingsSection({ id, title, description, children }: { id: string; title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="settings-section" id={`settings-${id}`}>
      <header className="settings-section-head">
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      {children}
    </section>
  );
}

function PrefRow({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }) {
  return (
    <div className="pref-row">
      <span className="pref-copy">
        <strong>{title}</strong>
        {detail ? <em>{detail}</em> : null}
      </span>
      <span className="pref-control">{children}</span>
    </div>
  );
}

// Moves live while dragging; commits once on release so a drag isn't a save and a sync per tick.
function Slider({ min, max, step, value, onChange, format }: { min: number; max: number; step: number; value: number; onChange: (value: number) => void; format: (value: number) => string }) {
  const [draft, setDraft] = useState(value);
  const latest = useRef(value);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) {
      latest.current = value;
      setDraft(value);
    }
  }, [value]);
  const commit = () => {
    dragging.current = false;
    if (latest.current !== value) onChange(latest.current);
  };
  const fill = ((draft - min) / (max - min)) * 100;
  const label = format(draft);
  return (
    <span className="pref-slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft}
        aria-label={label}
        style={{ ["--fill" as string]: `${fill}%` }}
        onPointerDown={() => (dragging.current = true)}
        onChange={(event) => {
          latest.current = Number(event.target.value);
          setDraft(latest.current);
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <em>{label}</em>
    </span>
  );
}

function Swatches({ value, onPick, small }: { value: string; onPick: (color: string) => void; small?: boolean }) {
  return (
    <span className={cx("swatch-row", small && "small")}>
      {COLORS.map((color) => (
        <button
          key={color}
          className={cx("swatch", small && "small", value.toUpperCase() === color && "is-selected")}
          style={{ background: `#${color}` }}
          onClick={() => onPick(color)}
          aria-label={`#${color}`}
          title={`#${color}`}
        />
      ))}
    </span>
  );
}

function RemovableChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button className="removable-chip" onClick={onRemove} title={`Remove ${label}`}>
      {label}
      <PixelIcon name="x" size={11} />
    </button>
  );
}

function ListEditor({
  title,
  detail,
  placeholder,
  draft,
  setDraft,
  items,
  labelFor = (item) => item,
  empty,
  onAdd,
  onRemove,
}: {
  title: string;
  detail: string;
  placeholder: string;
  draft: string;
  setDraft: (value: string) => void;
  items: string[];
  labelFor?: (item: string) => string;
  empty: string;
  onAdd: () => void;
  onRemove: (item: string) => void;
}) {
  return (
    <div className="pref-row is-stack">
      <span className="pref-copy">
        <strong>{title}</strong>
        <em>{detail}</em>
      </span>
      <div className="chip-input-row">
        <TextField value={draft} onChange={setDraft} placeholder={placeholder} onEnter={onAdd} />
        <Button variant="secondary" size="sm" icon="plus" disabled={!draft.trim()} onClick={onAdd}>
          Add
        </Button>
      </div>
      <div className="chip-row">
        {items.map((item) => (
          <RemovableChip key={item} label={labelFor(item)} onRemove={() => onRemove(item)} />
        ))}
        {!items.length ? <span className="pref-hint">{empty}</span> : null}
      </div>
    </div>
  );
}
