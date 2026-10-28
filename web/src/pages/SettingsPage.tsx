import { useEffect, useRef, useState } from "react";
import { useDashboard } from "../store";
import { cx, relativeTime } from "../lib";
import type { AgentStatus, CodingAgentID, KeyProvider, PrivateMacPhase, PrivateMacState, ServicesState, Toast } from "../types";
import { SETTINGS_JUMP_EVENT, type Page } from "../nav";
import { Button, ConfirmModal, IconButton, PageTitle, PixelIcon, Progress, Segmented, Switch, TextArea, TextField, type ConfirmRequest } from "../components/ui";

const VOICES = [
  { id: "sarah", name: "Sarah", blurb: "Soothing and calm · American" },
  { id: "barney", name: "Barney", blurb: "Deep, steady, conversational · American" },
  { id: "eden", name: "Eden", blurb: "Clear, gender-neutral · American" },
  { id: "archie", name: "Archie", blurb: "Warm and casual · British" },
  { id: "siobhan", name: "Siobhan", blurb: "Friendly and everyday · Irish" },
  { id: "devansh", name: "Devansh", blurb: "Warm and easygoing · Indian English" },
  { id: "ella", name: "Ella", blurb: "Bright and light · Australian" },
  { id: "brenda", name: "Brenda", blurb: "Cheerful and upbeat · African American" },
  { id: "wyatt", name: "Wyatt", blurb: "Clear, with a gentle drawl · Southern US" },
  { id: "system", name: "System voice", blurb: "Your Mac's own voice" },
];

const PERMISSIONS = [
  { id: "screen", title: "Screen recording", icon: "screen", blurb: "See what you're looking at when you ask" },
  { id: "microphone", title: "Microphone", icon: "mic", blurb: "Talk instead of type" },
  { id: "accessibility", title: "Accessibility", icon: "cursor", blurb: "Click and type when you lend the screen" },
  { id: "automation", title: "Automation", icon: "bolt", blurb: "Reminders, Calendar and Notes without opening them" },
];

// Brand-green family first; the setting key stays cursorGlowHex / drawingColorHex.
const COLORS = ["44E45E", "1FB57A", "3DDC97", "9BE8C6", "0B8A5E", "B8F26B", "8FB7FF", "F7F2E9"];

const SECTIONS = [
  { id: "keys", label: "Keys", icon: "key" },
  { id: "permissions", label: "Permissions", icon: "lock" },
  { id: "instructions", label: "Instructions", icon: "pencil" },
  { id: "voice", label: "Voice & input", icon: "mic" },
  { id: "safety", label: "Safety", icon: "hand" },
  { id: "agents", label: "Agents", icon: "code" },
  { id: "private-mac", label: "Private Mac", icon: "screen" },
  { id: "notch", label: "Notch", icon: "bell" },
  { id: "appearance", label: "Appearance", icon: "sun" },
  { id: "account", label: "Profile", icon: "user" },
  { id: "advanced", label: "Advanced", icon: "gear" },
];

export function SettingsPage({ go }: { go?: (page: Page) => void } = {}) {
  const { state, settings, account, updateSettings, invoke, notify, native } = useDashboard();
  const [instructions, setInstructions] = useState(settings.customInstructions);
  const [name, setName] = useState(account.name);
  const [email, setEmail] = useState(account.email);
  const [appDraft, setAppDraft] = useState("");
  const [askDraft, setAskDraft] = useState("");
  const [active, setActive] = useState(SECTIONS[0].id);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  useEffect(() => setInstructions(settings.customInstructions), [settings.customInstructions]);
  useEffect(() => {
    setName(account.name);
    setEmail(account.email);
  }, [account.id, account.name, account.email]);

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
      // Keys only exists in the Mac app, so start from the first section actually on the page
      let current: string = SECTIONS.find((section) => document.getElementById(`settings-${section.id}`))?.id ?? SECTIONS[0].id;
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

  // "#/keys", the notch's "add a key" button and the Mac's own links land on a section, not just the page.
  useEffect(() => {
    const onJump = (event: Event) => jump((event as CustomEvent<string>).detail);
    window.addEventListener(SETTINGS_JUMP_EVENT, onJump);
    return () => window.removeEventListener(SETTINGS_JUMP_EVENT, onJump);
  }, []);

  const addToList = (list: "blockedApps" | "alwaysAsk", value: string) => {
    if (!value.trim()) return;
    if (settings[list].includes(value.trim())) return;
    updateSettings({ [list]: [...settings[list], value.trim()] } as never);
  };

  const profileDirty = name !== account.name || email !== account.email;
  const instructionsDirty = instructions !== settings.customInstructions;

  return (
    <div className="settings-page">
      <PageTitle title="Settings" subtitle="Everything stays on this Mac." />

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.filter((section) => native || section.id !== "keys").map((section) => (
            <button key={section.id} className={cx("settings-nav-item", active === section.id && "is-active")} onClick={() => jump(section.id)}>
              <PixelIcon name={section.icon} size={15} />
              {section.label}
            </button>
          ))}
          <span className="settings-nav-version">okidoki {state.version}</span>
        </nav>

        <div className="settings-body">
          {/* Keys: only inside the Mac app, which holds the key file. */}
          {native ? (
            <SettingsSection id="keys" title="Keys" description="Bring your own keys. Each goes in a private file on this Mac, readable only by you, and is sent only to the service it belongs to.">
              <div className="pref-group">
                {(state.keyProviders ?? []).map((provider) => (
                  <KeyRow key={provider.id} provider={provider} invoke={invoke} notify={notify} />
                ))}
                {!state.keyProviders?.length ? (
                  <PrefRow title="Keys" detail="Open this in the okidoki app on your Mac to add or remove keys.">
                    <span className="pref-hint">Mac only</span>
                  </PrefRow>
                ) : null}
              </div>
            </SettingsSection>
          ) : null}

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
                          <span className="pref-status is-warn">{native ? status : "on your Mac"}</span>
                          {native ? (
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
                          ) : null}
                        </>
                      )}
                      <IconButton icon="external" label={`Open ${permission.title} in System Settings`} onClick={() => invoke("openPermissionSettings", { kind: permission.id })} />
                    </span>
                  </div>
                );
              })}
            </div>
          </SettingsSection>

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
                    // A retired voice (like "brielle") plays as Sarah on the Mac, so show Sarah as chosen.
                    const known = VOICES.some((item) => item.id === settings.voiceID);
                    const selected = known ? settings.voiceID === voice.id : voice.id === VOICES[0].id;
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

          <SettingsSection id="safety" title="Safety" description="okidoki always asks before sending, buying, deleting, installing or running risky commands.">
            <div className="pref-group">
              <PrefRow title="Background mode" detail="Long jobs run without touching your cursor">
                <Switch label="Background mode" checked={settings.backgroundMode} onChange={(value) => updateSettings({ backgroundMode: value })} />
              </PrefRow>
              <PrefRow title="Screen borrowing" detail="A ghost cursor, ten seconds at a time">
                <Switch label="Screen borrowing" checked={settings.screenBorrowing} onChange={(value) => updateSettings({ screenBorrowing: value })} />
              </PrefRow>
              <PrefRow title="See the screen" detail="Send the front window, browser tab and a small screenshot with each request, so okidoki knows what it's about. Never stored.">
                <Switch label="See the screen" checked={settings.screenContext ?? true} onChange={(value) => updateSettings({ screenContext: value })} />
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

          <SettingsSection id="agents" title="Agents" description="Coding agents on this Mac. okidoki reads each CLI's own login files to see who's signed in; nothing is copied and the Keychain is never opened.">
            <AgentsSettings
              agents={state.agents}
              selected={settings.selectedAgent}
              autoConnect={settings.autoConnectAgents ?? true}
              native={native}
              onSelect={(id) => updateSettings({ selectedAgent: id })}
              onAutoConnect={(value) => updateSettings({ autoConnectAgents: value })}
              invoke={invoke}
              notify={notify}
            />
          </SettingsSection>

          <SettingsSection id="private-mac" title="Private Mac" description="Give okidoki its own macOS, in a window. Runs that drive apps happen there while you keep working here.">
            <PrivateMacSettings
              privateMac={state.privateMac ?? null}
              target={settings.computerTarget}
              native={native}
              onTarget={(value) => updateSettings({ computerTarget: value })}
              invoke={invoke}
              notify={notify}
              confirm={setConfirm}
            />
          </SettingsSection>

          <SettingsSection id="notch" title="Notch" description="Your status center. On Macs without a notch it floats at the top.">
            <div className="pref-group">
              <PrefRow title="Show in the notch" detail="Toasts, progress and approvals">
                <Switch label="Show in the notch" checked={settings.notchEnabled} onChange={(value) => updateSettings({ notchEnabled: value })} />
              </PrefRow>
              <PrefRow title="Quiet mode" detail="Silent during calls and screen shares">
                <Switch label="Quiet mode" checked={settings.quietMode} onChange={(value) => updateSettings({ quietMode: value })} />
              </PrefRow>
            </div>
          </SettingsSection>

          <SettingsSection id="appearance" title="Appearance" description="How the panel and the pointer behave.">
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
              <PrefRow title="Driving pace" detail="How the pointer moves when okidoki drives an app for you">
                <Segmented
                  options={[
                    { value: "calm", label: "Calm" },
                    { value: "fast", label: "Fast" },
                  ]}
                  value={settings.drivePace ?? "fast"}
                  onChange={(value) => updateSettings({ drivePace: value as typeof settings.drivePace })}
                  compact
                />
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

          <SettingsSection id="account" title="Profile" description="What okidoki calls you. It stays on this Mac.">
            <div className="pref-group">
              <PrefRow title="Name">
                <TextField value={name} onChange={setName} className="pref-field" />
              </PrefRow>
              <PrefRow title="Email">
                <TextField value={email} onChange={setEmail} type="email" className="pref-field" />
              </PrefRow>
              <div className="pref-row pref-row-end">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!profileDirty}
                  onClick={() => {
                    invoke("updateAccount", { name, email, kind: account.kind });
                    notify("Profile saved", name);
                  }}
                >
                  Save profile
                </Button>
              </div>
            </div>
          </SettingsSection>

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
              <PrefRow title="Brain" detail={state.services ? `Bun sidecar on 127.0.0.1:${state.services.brain.port}${state.services.brain.version ? ` · v${state.services.brain.version}` : ""}` : undefined}>
                <span className={cx("pref-value", (state.services?.brain.ready ?? state.sidecar === "ready") && "is-on")}>
                  <i />
                  {state.services?.brain.status ?? state.sidecar}
                </span>
              </PrefRow>
              <PrefRow title="Memory index" detail={memoryDetail(state.services)}>
                <span className={cx("pref-value", state.services?.memory.ready && !state.services.memory.error && "is-on")}>
                  <i />
                  {memoryLabel(state.services)}
                </span>
              </PrefRow>
              <PrefRow title="MCP servers" detail={mcpDetail(state.services)}>
                <span className={cx("pref-value", (state.services?.mcp.connected ?? 0) > 0 && state.services?.mcp.connected === state.services?.mcp.servers && "is-on")}>
                  <i />
                  {mcpLabel(state.services)}
                </span>
                {state.services?.mcp.enabled && state.services.mcp.servers ? (
                  <Button variant="secondary" size="sm" icon="grid" onClick={() => go?.("toolbox")}>
                    Toolbox
                  </Button>
                ) : null}
              </PrefRow>
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
            Open source. Screenshots never stored. No background tracking.
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

function memoryLabel(services: ServicesState | null | undefined): string {
  if (!services) return "unknown";
  if (!services.memory.configured) return "off";
  if (services.memory.error) return "error";
  if (!services.memory.ready) return "starting";
  return `${services.memory.notes + services.memory.messages} items`;
}

function memoryDetail(services: ServicesState | null | undefined): string {
  if (!services) return "Moss, searched by meaning for every request.";
  const memory = services.memory;
  if (!memory.configured) return "Add a Moss key to search threads and notes by meaning. Right now only exact text matches.";
  if (memory.error) return memory.error;
  if (!memory.ready) return "Moss is loading the index on this Mac.";
  const parts = [`${memory.notes} note${memory.notes === 1 ? "" : "s"}`, `${memory.messages} recent turn${memory.messages === 1 ? "" : "s"}`, `${memory.tools} tools`];
  return `${parts.join(" · ")}${memory.lastSyncAt ? ` · synced ${relativeTime(memory.lastSyncAt)}` : ""}`;
}

function mcpLabel(services: ServicesState | null | undefined): string {
  if (!services) return "unknown";
  if (!services.mcp.enabled) return "off";
  if (!services.mcp.servers) return "none";
  return `${services.mcp.connected} of ${services.mcp.servers}`;
}

function mcpDetail(services: ServicesState | null | undefined): string {
  if (!services?.mcp.enabled) return "Turn on MCP in the Toolbox to bring your own tools in.";
  if (!services.mcp.servers) return "No servers added yet. Add one in the Toolbox.";
  const checked = services.mcp.checkedAt ? `Checked ${relativeTime(services.mcp.checkedAt)}; rechecked every minute while this is open.` : "Not checked yet.";
  return services.mcp.connected < services.mcp.servers ? `Some servers aren't answering. ${checked}` : checked;
}

/** One saved key: set / shipped / missing, with a field to save or replace it. The value is never shown back. */
function KeyRow({ provider, invoke, notify }: { provider: KeyProvider; invoke: (type: string, payload?: Record<string, unknown>) => void; notify: (title: string, detail: string, kind: Toast["kind"]) => void }) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const save = () => {
    const value = draft.trim();
    if (!value) return;
    invoke("saveKey", { provider: provider.id, value });
    notify("Key saved", `${provider.name} · stored on this Mac`, "success");
    setDraft("");
    setEditing(false);
  };
  // A key from the environment (or your own service.env) works until one saved here replaces it.
  const status = provider.set ? (provider.builtin ? "from environment" : "set") : provider.optional ? "optional" : "missing";
  return (
    <div className={cx("pref-row", editing && "is-stack")}>
      <span className="pref-copy">
        <strong>{provider.name}</strong>
        <em>{provider.blurb}</em>
      </span>
      {editing ? (
        <div className="pref-row-foot">
          <TextField className="pref-field" type="password" value={draft} onChange={setDraft} placeholder={provider.placeholder} autoFocus onEnter={save} />
          <span className="pref-control">
            <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setDraft(""); }}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" disabled={!draft.trim()} onClick={save}>
              Save
            </Button>
          </span>
        </div>
      ) : (
        <span className="pref-control">
          <span className={cx("pref-status", provider.set && "is-on", !provider.set && !provider.optional && "is-warn")}>{status}</span>
          {provider.url ? (
            <IconButton icon="external" label={`Get a ${provider.name} key`} onClick={() => invoke("openExternal", { url: provider.url })} />
          ) : null}
          <Button variant="secondary" size="sm" icon="key" onClick={() => setEditing(true)}>
            {provider.set ? "Replace" : "Add"}
          </Button>
          {provider.set ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                invoke("deleteKey", { provider: provider.id });
                notify("Key removed", provider.name, "info");
              }}
            >
              Remove
            </Button>
          ) : null}
        </span>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 MB";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

function agentDetail(agent: AgentStatus): string {
  const ready = agent.installed && agent.signedIn;
  const who = agent.account ? `Signed in as ${agent.account}` : agent.providers.length ? `Signed in to ${agent.providers.join(", ")}` : "Signed in";
  if (ready) return agent.source ? `${who} · ${agent.source}` : who;
  if (agent.installed) return `Installed, not signed in · run ${agent.loginHint}`;
  if (agent.signedIn) return `${who}, but the CLI isn't on your PATH · ${agent.installHint}`;
  return `Not installed · ${agent.installHint}`;
}

function AgentsSettings({
  agents,
  selected,
  autoConnect,
  native,
  onSelect,
  onAutoConnect,
  invoke,
  notify,
}: {
  agents: AgentStatus[] | undefined;
  selected: CodingAgentID;
  autoConnect: boolean;
  native: boolean;
  onSelect: (id: CodingAgentID) => void;
  onAutoConnect: (value: boolean) => void;
  invoke: (type: string, payload?: Record<string, unknown>) => void;
  notify: (title: string, detail?: string, kind?: Toast["kind"]) => void;
}) {
  if (!native || !agents) {
    return (
      <div className="pref-group">
        <PrefRow title="Default coding agent" detail="Open this in the okidoki app on your Mac to see which agents are installed and signed in.">
          <span className="pref-status">{selected}</span>
        </PrefRow>
      </div>
    );
  }

  const ready = agents.filter((agent) => agent.installed && agent.signedIn);
  return (
    <>
      <div className="pref-group">
        <PrefRow
          title="Auto-connect"
          detail={autoConnect ? "If the default agent is missing or logged out, okidoki switches to one that's ready" : "The default agent stays put even when it can't answer"}
        >
          <Switch label="Auto-connect agents" checked={autoConnect} onChange={onAutoConnect} />
        </PrefRow>
        <PrefRow title="Detected" detail={ready.length ? `${ready.length} of ${agents.length} ready: ${ready.map((agent) => agent.name).join(", ")}` : "No agent is both installed and signed in yet"}>
          <Button
            variant="secondary"
            size="sm"
            icon="refresh"
            onClick={() => {
              invoke("refreshTools");
              notify("Checking agents", "Reading your PATH and each CLI's login files", "info");
            }}
          >
            Rescan
          </Button>
        </PrefRow>
      </div>

      <div className="pref-group">
        {agents.map((agent) => {
          const isReady = agent.installed && agent.signedIn;
          const isDefault = agent.id === selected;
          return (
            <div className="pref-row" key={agent.id}>
              <span className={cx("kind-icon small", !isReady && "is-warn")}>
                <PixelIcon name="code" size={14} />
              </span>
              <span className="pref-copy">
                <strong>{agent.name}</strong>
                <em>{agentDetail(agent)}</em>
              </span>
              <span className="pref-control">
                {isDefault ? (
                  <span className={cx("pref-status", isReady ? "is-on" : "is-warn")}>
                    <PixelIcon name="check" size={13} /> Default
                  </span>
                ) : isReady ? (
                  <>
                    <span className="pref-status is-on">Ready</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        onSelect(agent.id);
                        notify("Default agent", agent.name);
                      }}
                    >
                      Use
                    </Button>
                  </>
                ) : (
                  <span className="pref-status is-warn">{agent.installed ? "Logged out" : agent.signedIn ? "Not on PATH" : "Not installed"}</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function PrivateMacSettings({
  privateMac,
  target,
  native,
  onTarget,
  invoke,
  notify,
  confirm,
}: {
  privateMac: PrivateMacState | null;
  target: "mac" | "vm";
  native: boolean;
  onTarget: (value: "mac" | "vm") => void;
  invoke: (type: string, payload?: Record<string, unknown>) => void;
  notify: (title: string, detail?: string, kind?: Toast["kind"]) => void;
  confirm: (request: ConfirmRequest) => void;
}) {
  const vm = privateMac;
  const supported = Boolean(vm?.supported);
  const phase: PrivateMacPhase = vm?.phase ?? "unsupported";
  const busy = phase === "downloading" || phase === "installing";
  const ready = phase === "stopped" || phase === "running" || phase === "starting" || phase === "stopping";
  const act = (action: string) => invoke("privateMac", { action });

  if (!native || !vm) {
    return (
      <div className="pref-group">
        <PrefRow title="Where okidoki works" detail="Open this in the okidoki app on your Mac to set up a private Mac.">
          <span className="pref-status">{target === "vm" ? "Private Mac" : "This Mac"}</span>
        </PrefRow>
      </div>
    );
  }

  const statusTone = phase === "failed" ? "is-warn" : ready ? "is-on" : "";
  const statusLabel =
    phase === "running" ? "Running" : phase === "stopped" ? "Off" : phase === "starting" ? "Starting" : phase === "stopping" ? "Stopping"
    : phase === "downloading" ? "Downloading" : phase === "installing" ? "Installing" : phase === "failed" ? "Failed"
    : phase === "unsupported" ? "Unavailable" : "Not set up";

  return (
    <>
      <div className="pref-group">
        <PrefRow
          title="Where okidoki works"
          detail={
            !supported
              ? "A private Mac needs Apple silicon. Runs happen on this Mac."
              : target === "vm"
                ? "Runs drive the private Mac. Your screen and cursor stay yours."
                : "Runs share your screen. Press Esc to take over anytime."
          }
        >
          <Segmented<"mac" | "vm">
            compact
            options={[
              { value: "mac", label: "This Mac" },
              { value: "vm", label: "Private Mac" },
            ]}
            value={supported ? target : "mac"}
            onChange={(value) => {
              if (value === "vm" && !supported) {
                notify("Not on this Mac", "A private Mac needs Apple silicon.", "warning");
                return;
              }
              onTarget(value);
              if (value === "vm" && (phase === "notSetUp" || phase === "failed")) {
                act("setUp");
                notify("Setting up your private Mac", `About ${vm.downloadGB} GB to download. It runs in the background.`, "info");
              }
            }}
          />
        </PrefRow>
      </div>

      {supported ? (
        <div className="pref-group">
          <div className={cx("pref-row", busy && "is-stack")}>
            <span className="pref-copy">
              <strong>
                {ready || busy ? `macOS ${vm.macOSVersion || ""}`.trim() : "Your private Mac"}
                {ready ? ` · ${vm.cpuCount} cores · ${vm.memoryGB} GB` : ""}
              </strong>
              <em>{vm.status}</em>
            </span>
            {busy ? (
              <div className="pref-row-foot">
                <div style={{ flex: 1 }}>
                  <Progress value={vm.progress} />
                </div>
                <span className="pref-hint">{Math.round(vm.progress * 100)}%</span>
                {phase === "downloading" ? (
                  <Button size="sm" onClick={() => act("cancelSetup")}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            ) : (
              <span className="pref-control">
                <span className={cx("pref-status", statusTone)}>{statusLabel}</span>
                {phase === "notSetUp" || phase === "failed" ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      act("setUp");
                      notify("Setting up your private Mac", `About ${vm.downloadGB} GB to download. It runs in the background.`, "info");
                    }}
                  >
                    {phase === "failed" ? "Try again" : "Set up"}
                  </Button>
                ) : null}
                {phase === "stopped" ? (
                  <Button variant="primary" size="sm" onClick={() => act("start")}>
                    Start
                  </Button>
                ) : null}
                {phase === "running" ? (
                  <>
                    <Button size="sm" onClick={() => act("show")}>
                      Show
                    </Button>
                    <Button size="sm" onClick={() => act("stop")}>
                      Shut down
                    </Button>
                  </>
                ) : null}
              </span>
            )}
          </div>

          {ready && vm.needsFirstBoot ? (
            <PrefRow title="Finish macOS setup" detail="The first boot shows Setup Assistant. Click through it in the private Mac's window, then tell okidoki it's done.">
              {phase === "running" ? (
                <Button size="sm" onClick={() => act("show")}>
                  Open window
                </Button>
              ) : null}
              <Button variant="primary" size="sm" onClick={() => act("firstBootDone")}>
                It's done
              </Button>
            </PrefRow>
          ) : null}

          {phase === "failed" && vm.error ? (
            <PrefRow title="What went wrong" detail={vm.error}>
              <span />
            </PrefRow>
          ) : null}

          {ready || phase === "notSetUp" ? (
            <PrefRow
              title="On disk"
              detail={vm.bytesOnDisk > 0 ? `${formatBytes(vm.bytesOnDisk)} in Application Support. Deleting removes macOS, its apps and files.` : "Nothing yet."}
            >
              {vm.bytesOnDisk > 0 ? (
                <Button
                  size="sm"
                  onClick={() =>
                    confirm({
                      title: "Delete your private Mac?",
                      detail: `Removes ${formatBytes(vm.bytesOnDisk)}: macOS, every app installed there and every file saved there. Runs go back to this Mac. This can't be undone.`,
                      action: "Delete private Mac",
                      onConfirm: () => act("delete"),
                    })
                  }
                >
                  <PixelIcon name="trash" size={14} />
                  Delete
                </Button>
              ) : null}
            </PrefRow>
          ) : null}
        </div>
      ) : null}
    </>
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
