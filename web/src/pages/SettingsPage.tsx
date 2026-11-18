import { useEffect, useMemo, useRef, useState } from "react";
import { useDashboard } from "../store";
import { copyText, cx, relativeTime } from "../lib";
import { joinCommand, parseServerJSON, serversFromConfig, splitCommand } from "../mcp";
import type { Connector, KeyProvider, McpServer, PrivateMacPhase, PrivateMacState, Toast } from "../types";
import { SETTINGS_JUMP_EVENT } from "../nav";
import { CodingAgents } from "./CodingAgents";
import { Button, ConfirmModal, IconButton, Modal, PageTitle, PixelIcon, Progress, Segmented, Switch, TextArea, TextField, type ConfirmRequest } from "../components/ui";

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
  { id: "system", name: "System voice", blurb: "Your Mac’s own voice" },
];

const PERMISSIONS = [
  { id: "screen", title: "Screen recording", icon: "screen", blurb: "See what you’re looking at when you ask" },
  { id: "microphone", title: "Microphone", icon: "mic", blurb: "Talk instead of type" },
  { id: "accessibility", title: "Accessibility", icon: "cursor", blurb: "Click and type when you lend the screen" },
  { id: "automation", title: "Automation", icon: "bolt", blurb: "Calendar and other apps without opening them" },
];

const CONNECTOR_ICON: Record<string, string> = {
  calendar: "calendar",
  apify: "search",
  mcp: "link",
};

const HIDDEN_CONNECTORS = new Set(["notes", "reminders"]);

const SECTIONS = [
  { id: "mode", label: "Mode", icon: "people" },
  { id: "keys", label: "Keys", icon: "key" },
  { id: "permissions", label: "Permissions", icon: "lock" },
  { id: "you", label: "You", icon: "user" },
  { id: "voice", label: "Voice", icon: "mic" },
  { id: "safety", label: "Safety", icon: "hand" },
  { id: "advanced", label: "Advanced", icon: "link" },
  { id: "agents", label: "Use from agents", icon: "code" },
  { id: "private-mac", label: "Private Mac", icon: "screen" },
  { id: "summon", label: "Summon", icon: "spark" },
  { id: "general", label: "General", icon: "gear" },
];

export function SettingsPage() {
  const { state, settings, account, updateSettings, invoke, notify, native } = useDashboard();
  const [instructions, setInstructions] = useState(settings.customInstructions);
  const [name, setName] = useState(account.name);
  const [email, setEmail] = useState(account.email);
  const [appDraft, setAppDraft] = useState("");
  const [active, setActive] = useState(SECTIONS[0].id);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  useEffect(() => setInstructions(settings.customInstructions), [settings.customInstructions]);
  useEffect(() => {
    setName(account.name);
    setEmail(account.email);
  }, [account.id, account.name, account.email]);

  // The mode shapes the page: collab adds the Shared session section (after Private Mac, which a
  // session drives); personal keeps sharing out of sight. Same loop either way.
  const collab = settings.useMode === "collab";
  const sections = useMemo(() => {
    const base = SECTIONS.filter((section) => native || section.id !== "keys");
    if (!collab) return base;
    const at = base.findIndex((section) => section.id === "private-mac");
    return at >= 0
      ? [...base.slice(0, at + 1), { id: "session", label: "Shared session", icon: "people" }, ...base.slice(at + 1)]
      : base;
  }, [native, collab]);

  // Highlight the section at the top of the scroll area. Driven by scroll position, so the
  // last sections still light up at the bottom, and a click holds its section while the
  // smooth scroll passes the others.
  const jumping = useRef<number | null>(null);
  useEffect(() => {
    // The page scrolls inside the shell's card.
    const root = document.querySelector<HTMLElement>(".page-host");
    if (!root) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (jumping.current !== null) return;
      // The reading line sits a third of the way down: the section you're looking at, not the one
      // whose last rows are still peeking in at the top.
      const top = root.getBoundingClientRect().top + Math.max(96, root.clientHeight * 0.3);
      // Keys only exists in the Mac app, so start from the first section actually on the page
      let current: string = sections.find((section) => document.getElementById(`settings-${section.id}`))?.id ?? sections[0].id;
      for (const section of sections) {
        const node = document.getElementById(`settings-${section.id}`);
        if (node && node.getBoundingClientRect().top <= top) current = section.id;
      }
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) current = sections[sections.length - 1].id;
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
  }, [sections]);

  const jump = (id: string) => {
    setActive(id);
    // Advanced is collapsed by default; jumping to it opens it so the section isn't an empty scroll.
    if (id === "advanced") document.getElementById("settings-advanced")?.setAttribute("open", "");
    if (jumping.current !== null) window.clearTimeout(jumping.current);
    jumping.current = window.setTimeout(() => (jumping.current = null), 700);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
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

  // MCP is listed with its servers below; Apple Notes and Reminders aren't offered any more, and a
  // connector that can't work without a key (Apify) only shows once there is one.
  const connectors = state.connectors.filter(
    (connector) => connector.id !== "mcp" && !HIDDEN_CONNECTORS.has(connector.id) && !(connector.id === "apify" && !state.keys.apify),
  );
  // Picking a voice only means something with a Cartesia key; without one okidoki speaks with the Mac's voice.
  const cartesia = Boolean(state.keyProviders?.find((provider) => provider.id === "cartesia")?.set ?? state.keys.cartesia);
  const mcpConnector = state.connectors.find((connector) => connector.id === "mcp");

  const profileDirty = name !== account.name || email !== account.email;
  const emailInvalid = email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const instructionsDirty = instructions !== settings.customInstructions;

  return (
    <div className="settings-page">
      <PageTitle title="Settings" subtitle="Everything stays on this Mac." />

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map((section) => (
            <button key={section.id} className={cx("settings-nav-item", active === section.id && "is-active")} onClick={() => jump(section.id)}>
              <PixelIcon name={section.icon} size={15} />
              {section.label}
            </button>
          ))}
          <span className="settings-nav-version">okidoki {state.version}</span>
        </nav>

        <div className="settings-body">
          <SettingsSection id="mode" title="Mode" description="The same loop either way — show it once, it does it forever. This only changes what's offered here.">
            <div className="pref-group">
              <PrefRow
                title="How you use okidoki"
                detail={
                  collab
                    ? "Shared sessions are on: people on your WiFi can watch okidoki's private Mac live, chat, and ask — joining needs your code."
                    : "Everything stays on this Mac. Switch on to share live sessions with people on your WiFi."
                }
              >
                <Segmented<"personal" | "collab">
                  options={[
                    { value: "personal", label: "Just me" },
                    { value: "collab", label: "With people" },
                  ]}
                  value={settings.useMode ?? "personal"}
                  onChange={(value) => updateSettings({ useMode: value })}
                />
              </PrefRow>
              {collab ? (
                <PrefRow title="Sharing" detail="Invite people from Shared session below. A session drives the private Mac — never your own screen — and anything risky still waits for your okay.">
                  <span className="pref-status is-on">Collab on</span>
                </PrefRow>
              ) : null}
            </div>
          </SettingsSection>

          {/* Keys: only inside the Mac app, which holds the key file. */}
          {native ? (
            <SettingsSection id="keys" title="Keys" description="Bring your own keys. Each goes in a private file on this Mac, readable only by you, and is sent only to the service it belongs to.">
              <div className="pref-group">
                {(state.keyProviders ?? []).map((provider) => (
                  <KeyRow key={provider.id} provider={provider} invoke={invoke} notify={notify} confirm={setConfirm} />
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

          <SettingsSection id="you" title="You" description="What okidoki calls you, and what it should always keep in mind. Stays on this Mac.">
            <div className="pref-group">
              <PrefRow title="Name">
                <TextField value={name} onChange={setName} placeholder="Your name" className="pref-field" />
              </PrefRow>
              <PrefRow title="Email">
                <span className="pref-field-wrap">
                  <TextField value={email} onChange={setEmail} type="email" placeholder="you@example.com" className="pref-field" />
                  {emailInvalid ? (
                    <em className="field-error" role="alert">
                      That doesn't look like an email address.
                    </em>
                  ) : null}
                </span>
              </PrefRow>
              <div className="pref-row pref-row-end">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!profileDirty || !name.trim() || emailInvalid}
                  onClick={() => {
                    invoke("updateAccount", { name: name.trim(), email: email.trim(), kind: account.kind });
                    notify("Profile saved", name.trim());
                  }}
                >
                  Save profile
                </Button>
              </div>
            </div>
            <div className="pref-group">
              <div className="pref-row is-stack">
                <span className="pref-copy">
                  <strong>Instructions</strong>
                  <em>Added to the top of every request. Keep it short and concrete.</em>
                </span>
                <TextArea value={instructions} onChange={setInstructions} rows={4} placeholder="Keep answers short. I’m a student. Prefer free tools." />
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

          <SettingsSection id="voice" title="Voice" description="How you talk to okidoki, and how it talks back.">
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
                <Slider name="Speaking speed" min={0.7} max={1.4} step={0.05} value={settings.voiceSpeed} onChange={(value) => updateSettings({ voiceSpeed: value })} format={(value) => `${value.toFixed(2)}×`} />
              </PrefRow>
              <PrefRow title="Captions" detail="Show what okidoki is saying">
                <Switch label="Captions" checked={settings.captions} onChange={(value) => updateSettings({ captions: value })} />
              </PrefRow>
            </div>

            {cartesia ? (
              <div className="pref-group">
                <div className="pref-row is-stack">
                  <span className="pref-copy">
                    <strong>Voice</strong>
                    <em>Pick one to hear a preview.</em>
                  </span>
                  <div className="voice-grid" role="radiogroup" aria-label="Voice">
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
            ) : (
              <div className="pref-group">
                <PrefRow title="Voices" detail="okidoki speaks with your Mac’s voice. Add a Cartesia key for natural voices to pick from.">
                  {native ? (
                    <Button variant="secondary" size="sm" icon="key" onClick={() => jump("keys")}>
                      Add key
                    </Button>
                  ) : (
                    <span className="pref-hint">Mac voice</span>
                  )}
                </PrefRow>
              </div>
            )}
          </SettingsSection>

          <SettingsSection id="safety" title="Safety" description="okidoki always asks before sending, buying, deleting, installing or running risky commands. Background mode and screen borrowing are on the composer’s Guard chip.">
            <div className="pref-group">
              <PrefRow title="Smart replay" detail="Skills fill in what changes from your documents, check each step, run themselves when a request matches, and hand off to the agent if the screen changed. Off replays exactly as recorded.">
                <Switch label="Smart replay" checked={settings.hybridReplay ?? false} onChange={(value) => updateSettings({ hybridReplay: value })} />
              </PrefRow>
              {/* Only Apify spends money today, so the limit shows once it can. */}
              {state.keys.apify ? (
                <PrefRow title="Spending limit" detail="Per task, for tools that cost money">
                  <Slider name="Spending limit" min={0} max={200} step={5} value={settings.spendingLimit} onChange={(value) => updateSettings({ spendingLimit: value })} format={(value) => `$${value}`} />
                </PrefRow>
              ) : null}
            </div>

            <div className="pref-group">
              <ListEditor
                title="Blocked apps and tools"
                detail="okidoki never opens or runs these."
                placeholder="Add an app or tool"
                draft={appDraft}
                setDraft={setAppDraft}
                items={settings.blockedApps}
                empty="Nothing blocked."
                onAdd={() => {
                  addToList("blockedApps", appDraft);
                  setAppDraft("");
                }}
                onRemove={(item) => updateSettings({ blockedApps: settings.blockedApps.filter((value) => value !== item) })}
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

          {/* The agent-platform surface: connectors and outbound coding-agent delegation. Kept, but
              collapsed and off the beaten path — okidoki's loop works fully without any of it. */}
          <details className="settings-section settings-advanced" id="settings-advanced">
            <summary className="settings-advanced-summary">
              <span className="settings-advanced-head">
                <PixelIcon name="link" size={15} />
                <span>
                  <strong>Advanced</strong>
                  <em>Connectors, and handing work to coding agents. okidoki works fully without these.</em>
                </span>
              </span>
              <PixelIcon name="chevron-down" size={14} className="settings-advanced-caret" />
            </summary>
            <div className="settings-advanced-body">
              <h3 className="settings-subhead">Connectors</h3>
              <p className="settings-advanced-note">Services and tools okidoki can reach for you. Each one asks before it changes anything.</p>
              <div className="pref-group">
                {connectors.map((connector) => (
                  <ConnectorRow key={connector.id} connector={connector} />
                ))}
                {!connectors.length ? (
                  <PrefRow title="Connectors" detail="Open this in the okidoki app on your Mac to see what it can connect to.">
                    <span className="pref-hint">Mac only</span>
                  </PrefRow>
                ) : null}
              </div>
              <div className="pref-group">
                {mcpConnector ? (
                  <ConnectorRow connector={mcpConnector} />
                ) : (
                  <PrefRow title="MCP" detail="Open this in the okidoki app on your Mac to add servers.">
                    <span className="pref-hint">Mac only</span>
                  </PrefRow>
                )}
                {mcpConnector?.enabled ? <McpServers /> : null}
              </div>
              <h3 className="settings-subhead">Hand work to coding agents</h3>
              <p className="settings-advanced-note">okidoki hands files, the terminal and code to Claude Code, Codex and other coding agents. Each uses its own sign-in.</p>
              <CodingAgents />
            </div>
          </details>

          <SettingsSection id="agents" title="Use from agents" description="Claude Code, Codex and other agents hand okidoki the web, your logins and your Mac’s apps: they look for a saved skill first, replay it, and ask for the rest. Risky steps still wait for your okay.">
            <UseFromAgents />
          </SettingsSection>

          <SettingsSection id="private-mac" title="Private Mac" description="Give okidoki its own macOS, in a window. Runs that drive apps happen there while you keep working here.">
            <PrivateMacSettings
              privateMac={state.privateMac ?? null}
              target={settings.computerTarget}
              native={native}
              onTarget={(value) => updateSettings({ computerTarget: value })}
              memoryGB={settings.privateMacMemoryGB}
              onMemory={(gb) => updateSettings({ privateMacMemoryGB: gb })}
              invoke={invoke}
              notify={notify}
              confirm={setConfirm}
            />
          </SettingsSection>

          {collab ? (
            <SettingsSection id="session" title="Shared session" description="Let everyone on your WiFi watch okidoki work in the private Mac, chat, and ask it to do things. They join in a browser — no install. You approve anything risky here, in the notch. Collab shares okidoki's Mac, never yours.">
              <SharedSession />
            </SettingsSection>
          ) : null}

          <SettingsSection id="summon" title="Summon" description="How you call okidoki from anywhere on your Mac. The notch’s Ask button and the menu bar always work too.">
            <div className="pref-group">
              <PrefRow title="Shake to summon" detail="Shake the pointer and okidoki opens beside it. Off stops watching the mouse entirely.">
                <Switch label="Shake to summon" checked={settings.shakeToSummon ?? true} onChange={(value) => updateSettings({ shakeToSummon: value })} />
              </PrefRow>
              <PrefRow
                title="Shake sensitivity"
                detail={(settings.shakeToSummon ?? true) ? "Lower is easier to trigger" : "Turn on Shake to summon to tune this"}
              >
                <span className={(settings.shakeToSummon ?? true) ? undefined : "pref-disabled"} aria-disabled={!(settings.shakeToSummon ?? true)} inert={!(settings.shakeToSummon ?? true)}>
                  <Slider
                    name="Shake sensitivity"
                    min={0.2}
                    max={1}
                    step={0.05}
                    value={settings.shakeSensitivity}
                    onChange={(value) => updateSettings({ shakeSensitivity: value })}
                    format={(value) => `${Math.round(value * 100)}%`}
                  />
                </span>
              </PrefRow>
              <PrefRow title="Summon shortcut" detail="Works in any app. Click, then press the keys you want.">
                <HotkeyField value={settings.summonHotkey ?? "option+space"} onChange={(value) => updateSettings({ summonHotkey: value })} />
              </PrefRow>
              <PrefRow title="Notch" detail="Progress, approvals and answers at the top of the screen. On Macs without a notch it floats there.">
                <Switch label="Show in the notch" checked={settings.notchEnabled} onChange={(value) => updateSettings({ notchEnabled: value })} />
              </PrefRow>
            </div>
          </SettingsSection>

          <SettingsSection id="general" title="General" description="Look, setup and where your data lives.">
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
              <PrefRow title="Onboarding" detail="Walk through setup again">
                <Button variant="secondary" size="sm" icon="wand" onClick={() => invoke("openOnboarding")}>
                  Replay
                </Button>
              </PrefRow>
              <PrefRow title="Data folder" detail={`Threads, memory and logs on disk · okidoki ${state.version}`}>
                <Button variant="secondary" size="sm" icon="folder" onClick={() => invoke("openDataFolder")}>
                  Open
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

/** One saved key: set / shipped / missing, with a field to save or replace it. The value is never shown back. */
function KeyRow({
  provider,
  invoke,
  notify,
  confirm,
}: {
  provider: KeyProvider;
  invoke: (type: string, payload?: Record<string, unknown>) => void;
  notify: (title: string, detail: string, kind: Toast["kind"]) => void;
  confirm: (request: ConfirmRequest) => void;
}) {
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
              onClick={() =>
                confirm({
                  title: `Remove your ${provider.name} key?`,
                  detail: "okidoki stops using it until you add one again.",
                  action: "Remove key",
                  onConfirm: () => {
                    invoke("deleteKey", { provider: provider.id });
                    notify("Key removed", provider.name, "info");
                  },
                })
              }
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

function PrivateMacSettings({
  privateMac,
  target,
  native,
  onTarget,
  memoryGB,
  onMemory,
  invoke,
  notify,
  confirm,
}: {
  privateMac: PrivateMacState | null;
  target: "mac" | "vm";
  native: boolean;
  onTarget: (value: "mac" | "vm") => void;
  memoryGB?: number;
  onMemory: (gb: number) => void;
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
            <PrefRow title="Finish macOS setup" detail="The first boot shows Setup Assistant. Click through it in the private Mac’s window, then tell okidoki it’s done.">
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

          {ready || phase === "notSetUp" ? (
            <PrefRow
              title="Memory"
              detail={
                phase === "running" || phase === "starting"
                  ? "Takes effect the next time the private Mac starts."
                  : "Less leaves more for your own apps; more keeps big apps smooth in there."
              }
            >
              <Segmented<string>
                compact
                options={[{ value: "0", label: "Auto" }, ...(vm.memoryChoicesGB ?? [4, 8]).map((gb) => ({ value: String(gb), label: `${gb} GB` }))]}
                value={String(memoryGB ?? 0)}
                onChange={(value) => onMemory(Number(value))}
              />
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
                      detail: `Removes ${formatBytes(vm.bytesOnDisk)}: macOS, every app installed there and every file saved there. Runs go back to this Mac. This can’t be undone.`,
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

function SharedSession() {
  const { state, invoke, notify, native } = useDashboard();
  const collab = state.collab ?? null;
  const supported = Boolean(state.privateMac?.supported);
  const active = Boolean(collab?.active);
  const act = (action: string, extra: Record<string, unknown> = {}) => invoke("collab", { action, ...extra });

  if (!native) {
    return (
      <div className="pref-group">
        <PrefRow title="Shared session" detail="Open this in the okidoki app on your Mac to start a session.">
          <span className="pref-hint">Mac only</span>
        </PrefRow>
      </div>
    );
  }

  if (!active) {
    return (
      <div className="pref-group">
        <PrefRow
          title="Share the private Mac"
          detail={supported ? "Start a session and give everyone the code. The private Mac starts when a run needs it." : "A shared session needs the private Mac, which needs Apple silicon."}
        >
          <Button
            variant="primary"
            size="sm"
            icon="people"
            disabled={!supported}
            onClick={() => {
              act("start");
              notify("Session live", "Give everyone the code below", "success");
            }}
          >
            Start a session
          </Button>
        </PrefRow>
      </div>
    );
  }

  const people = collab?.participants ?? [];
  return (
    <div className="pref-group">
      {collab?.error ? (
        <PrefRow title="The network isn't open" detail={collab.error}>
          <span className="pref-status is-warn">Can't share</span>
        </PrefRow>
      ) : null}
      <div className="pref-row is-stack">
        <span className="pref-copy">
          <strong>Join code</strong>
          <em>Everyone on your WiFi opens the link and enters this code.</em>
        </span>
        <div className="session-code">{collab?.code}</div>
        {collab?.url ? (
          <div className="pref-row-foot">
            <code className="mcp-cmd">{collab.url}</code>
            <IconButton icon="copy" label="Copy link" onClick={() => void copyText(collab.url!).then(() => notify("Copied", "Paste it to everyone", "info"))} />
          </div>
        ) : null}
      </div>
      <div className="pref-row is-stack">
        <span className="pref-copy">
          <strong>Participants</strong>
          <em>{people.length} here · they see okidoki's Mac, never yours</em>
        </span>
        <div className="session-people">
          {people.map((person) => (
            <div key={person.id} className="session-person">
              <span className="session-dot" style={{ background: `#${person.colorHex}` }}>
                {person.name.split(" ").slice(0, 2).map((word) => word[0]).join("").toUpperCase()}
              </span>
              <span className="session-name">{person.name}{person.isHost ? " (host)" : ""}</span>
              {collab?.wheelHolder === person.id ? <em className="session-driving">driving</em> : null}
              {!person.isHost ? <IconButton icon="x" label={`Remove ${person.name}`} onClick={() => act("kick", { id: person.id })} /> : null}
            </div>
          ))}
          {!people.length ? <span className="pref-hint">No one has joined yet.</span> : null}
        </div>
      </div>
      <div className="pref-row">
        <span className="pref-copy">
          <strong>End the session</strong>
          <em>Stops sharing and disconnects everyone.</em>
        </span>
        <span className="pref-control">
          {collab?.wheelHolder ? (
            <Button size="sm" onClick={() => act("reclaimWheel")}>
              Reclaim wheel
            </Button>
          ) : null}
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              act("stop");
              notify("Session ended", "No longer sharing", "info");
            }}
          >
            End session
          </Button>
        </span>
      </div>
    </div>
  );
}

function ConnectorRow({ connector }: { connector: Connector }) {
  const { state, invoke, notify } = useDashboard();
  // Apify can't do anything without a key, so the switch asks for one first.
  const needsKey = connector.id === "apify" && !state.keys.apify;
  const toggle = (value: boolean) => {
    if (value && needsKey) {
      notify("Apify isn’t configured", "It stays off until a key is set", "warning");
      return;
    }
    if (connector.kind === "apple") {
      invoke(value ? "connectApple" : "disconnectApple", { id: connector.id });
      notify(value ? "Connecting" : "Disconnected", connector.name, "info");
    } else {
      invoke("setConnector", { id: connector.id, enabled: value });
      notify(value ? "Connector on" : "Connector off", connector.name, "info");
    }
  };
  return (
    <>
      <div className="pref-row">
        <span className={cx("kind-icon small", !connector.enabled && "is-off")}>
          <PixelIcon name={CONNECTOR_ICON[connector.id] ?? (connector.kind === "apple" ? "apple" : "link")} size={14} />
        </span>
        <span className="pref-copy">
          <strong>{connector.name}</strong>
          <em>
            {connector.blurb}
            {connector.kind === "apple" ? " Uses Apple Events." : ""}
            {connector.id === "apify" && !needsKey ? " Every run shows a preview first and uses your Apify credits." : ""}
            {needsKey ? " Apify isn’t configured." : null}
          </em>
        </span>
        <Switch label={connector.name} checked={connector.enabled && !needsKey} onChange={toggle} />
      </div>
    </>
  );
}

function McpServers() {
  const { state, settings, updateSettings, invoke, notify, native } = useDashboard();
  const [editing, setEditing] = useState<McpServer | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const servers = settings.mcpServers ?? [];
  return (
    <div className="mcp-list">
      {servers.map((server) => {
        const status = state.mcpStatus?.[server.id];
        // Status only reaches the panel on the Mac; elsewhere there's nothing to wait for.
        const tone = !server.enabled || !native ? "is-off" : !status ? "is-pending" : status.ok ? "is-ok" : "is-error";
        return (
          <div className="mcp-row" key={server.id}>
            <span className={cx("mcp-dot", tone)} aria-hidden />
            <span className="mcp-copy">
              <strong>{server.name}</strong>
              <code className="mcp-cmd">{server.transport === "http" ? server.url : joinCommand([server.command, ...server.args])}</code>
              <em className={cx(tone === "is-error" && "mcp-error")}>
                {!server.enabled
                  ? "Off"
                  : !native
                    ? "Status on your Mac"
                  : !status
                    ? "Connecting…"
                    : status.ok
                      ? `${status.tools.length} tool${status.tools.length === 1 ? "" : "s"}${status.tools.length ? ` · ${status.tools.slice(0, 3).map((tool) => tool.name).join(", ")}${status.tools.length > 3 ? "…" : ""}` : ""}`
                      : status.error || "Couldn’t connect"}
              </em>
            </span>
            <Switch
              label={`Use ${server.name}`}
              checked={server.enabled}
              onChange={(value) => {
                updateSettings({ mcpServers: servers.map((item) => (item.id === server.id ? { ...item, enabled: value } : item)) });
              }}
            />
            <IconButton icon="edit" label={`Edit ${server.name}`} onClick={() => setEditing(server)} />
          </div>
        );
      })}
      <div className="mcp-actions">
        <Button variant="secondary" size="sm" icon="plus" onClick={() => setEditing("new")}>
          Add server
        </Button>
        <Button variant="ghost" size="sm" icon="download" onClick={() => setImporting(true)}>
          Paste a config
        </Button>
        {servers.length ? (
          <Button
            variant="ghost"
            size="sm"
            icon="refresh"
            onClick={() => {
              invoke("refreshMcp");
              notify("Reconnecting", `${servers.length} MCP server${servers.length === 1 ? "" : "s"}`, "info");
            }}
          >
            Reconnect
          </Button>
        ) : (
          <span className="mcp-hint">Any MCP server works: a command okidoki starts, or a URL.</span>
        )}
        {servers.length && state.services?.mcp.checkedAt ? (
          <span className="mcp-hint">
            {state.services.mcp.connected} of {state.services.mcp.servers} answering · checked {relativeTime(state.services.mcp.checkedAt)}
          </span>
        ) : null}
      </div>
      <McpServerModal server={editing} onClose={() => setEditing(null)} />
      <McpImportModal open={importing} onClose={() => setImporting(false)} />
    </div>
  );
}

function McpImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { invoke, notify } = useDashboard();
  const [text, setText] = useState("");
  let found: ReturnType<typeof serversFromConfig> = [];
  let problem = "";
  if (text.trim()) {
    try {
      found = serversFromConfig(text);
      if (!found.length) problem = "No servers in that. Paste the part with \"mcpServers\".";
    } catch {
      problem = "That isn’t valid JSON yet.";
    }
  }
  const add = () => {
    for (const { server, secrets } of found) invoke("saveMcpServer", { server, secrets });
    notify(found.length === 1 ? "Server added" : `${found.length} servers added`, found.map((item) => item.server.name).join(", "), "info");
    setText("");
    onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title="Paste an MCP config" subtitle="From Claude Desktop, Claude Code or Cursor. Secrets go to this Mac’s key file." width={560}>
      <TextArea value={text} onChange={setText} rows={10} placeholder={'{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  }\n}'} />
      <p className="form-hint">{problem || (found.length ? `Found ${found.map((item) => item.server.name).join(", ")}.` : " ")}</p>
      <footer className="modal-actions">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!found.length} onClick={add}>
          Add {found.length > 1 ? `${found.length} servers` : "server"}
        </Button>
      </footer>
    </Modal>
  );
}

/** How other agents reach okidoki: the okidoki skill (instructions they load) plus the `okidoki` command it uses. */
function UseFromAgents() {
  const { state, invoke, notify, native } = useDashboard();
  const skill = state.agentSkill ?? null;
  const installed = Boolean(skill?.installed);
  const example = 'okidoki do "find the cheapest direct flight SFO→JFK next Friday" --wait 300';
  return (
    <div className="pref-group">
      <PrefRow
        title="okidoki skill"
        detail={
          installed
            ? `Installed for ${skill!.paths.length === 1 ? "1 agent" : `${skill!.paths.length} agents`}${skill!.cli ? " with the okidoki command" : ""}. Agents look for a saved skill first, replay it, and hand the rest to okidoki. Risky steps still wait for your okay.`
            : "Puts the okidoki command on this Mac and teaches Claude Code, Codex and other agents to use it: replay your skills, run browser and Mac tasks, read memory and the vault."
        }
      >
        {native ? (
          installed ? (
            <>
              <span className="pref-status is-on">
                <PixelIcon name="check" size={13} /> Installed
              </span>
              <Button variant="ghost" size="sm" onClick={() => invoke("uninstallAgentSkill")}>
                Remove
              </Button>
            </>
          ) : (
            <Button variant="primary" size="sm" icon="download" onClick={() => invoke("installAgentSkill")}>
              Install
            </Button>
          )
        ) : (
          <span className="pref-hint">Mac only</span>
        )}
      </PrefRow>
      {installed && skill!.paths.length ? (
        <div className="pref-row is-stack">
          <span className="pref-copy">
            <strong>Try it from any agent or terminal</strong>
            <em>{skill!.paths.map((path) => path.replace(/^\/Users\/[^/]+/, "~")).join(" · ")}</em>
          </span>
          <div className="pref-row-foot">
            <code className="mcp-cmd agent-command">{example}</code>
            <IconButton icon="copy" label="Copy" onClick={() => void copyText(example).then(() => notify("Copied", "Paste it in a terminal", "info"))} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function parsePairs(text: string, separator: "=" | ":"): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(separator);
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (key) pairs[key] = line.slice(at + 1).trim();
  }
  return pairs;
}

function McpServerModal({ server, onClose }: { server: McpServer | "new" | null; onClose: () => void }) {
  const { state, invoke, notify } = useDashboard();
  const existing = server && server !== "new" ? server : null;
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpServer["transport"]>("stdio");
  const [target, setTarget] = useState("");
  const [secretText, setSecretText] = useState("");
  const [clearSecrets, setClearSecrets] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const stored = existing ? (state.mcpSecretNames?.[existing.id] ?? []) : [];

  useEffect(() => {
    setName(existing?.name ?? "");
    setTransport(existing?.transport ?? "stdio");
    setTarget(existing ? (existing.transport === "http" ? existing.url : joinCommand([existing.command, ...existing.args])) : "");
    setSecretText("");
    setClearSecrets(false);
    setConfirmRemove(false);
  }, [server]);

  // Pasting a README's JSON fills the whole form.
  const onTarget = (value: string) => {
    const parsed = value.trim().startsWith("{") ? parseServerJSON(value) : null;
    if (!parsed) {
      setTarget(value);
      return;
    }
    if (parsed.name && !name) setName(parsed.name);
    if (parsed.url) {
      setTransport("http");
      setTarget(parsed.url);
      setSecretText(Object.entries(parsed.headers ?? {}).map(([key, val]) => `${key}: ${val}`).join("\n"));
    } else {
      setTransport("stdio");
      setTarget(joinCommand([parsed.command ?? "", ...(parsed.args ?? [])]));
      setSecretText(Object.entries(parsed.env ?? {}).map(([key, val]) => `${key}=${val}`).join("\n"));
    }
  };

  const words = splitCommand(target.trim());
  const valid = name.trim() && (transport === "http" ? /^https?:\/\/\S+$/.test(target.trim()) : !target.trim().startsWith("{") && words !== null && Boolean(words[0]));
  // Why Save is off, said next to it rather than left to guess.
  const blocked = !name.trim()
    ? "Give it a name."
    : transport === "http"
      ? /^https?:\/\/\S+$/.test(target.trim())
        ? null
        : "Add the server’s http(s) address."
      : target.trim().startsWith("{")
        ? "That JSON couldn’t be read. Check it, or type the command instead."
        : words === null
          ? "The command has an unclosed quote."
          : !words[0]
            ? "Add the command that starts the server."
            : null;
  const save = () => {
    if (!valid || (transport === "stdio" && !words)) return;
    const next: McpServer = {
      id: existing?.id ?? `mcp-${Math.random().toString(16).slice(2, 10)}`,
      name: name.trim(),
      transport,
      command: transport === "stdio" ? words![0] : "",
      args: transport === "stdio" ? words!.slice(1) : [],
      url: transport === "http" ? target.trim() : "",
      enabled: existing?.enabled ?? true,
    };
    const typed = secretText.trim();
    // Secrets go only when changed, straight to the Mac's key file; leaving the box empty keeps what's saved.
    const secrets = typed
      ? transport === "http"
        ? { env: {}, headers: parsePairs(typed, ":") }
        : { env: parsePairs(typed, "="), headers: {} }
      : clearSecrets || !existing
        ? { env: {}, headers: {} }
        : undefined;
    invoke("saveMcpServer", { server: next, ...(secrets ? { secrets } : {}) });
    notify(existing ? "Server updated" : "Server added", `${next.name} · connecting`, "info");
    onClose();
  };

  return (
    <Modal
      open={Boolean(server)}
      onClose={onClose}
      title={existing ? `Edit ${existing.name}` : "Add an MCP server"}
      subtitle="okidoki lists its tools and asks before calling any of them."
      width={560}
    >
      <div className="form-stack mcp-form">
        <div className="mcp-field">
          <span className="form-label">Name</span>
          <TextField value={name} onChange={setName} placeholder="GitHub" autoFocus={!existing} />
        </div>
        <div className="mcp-field">
          <span className="form-label">How it runs</span>
          <Segmented
            options={[
              { value: "stdio", label: "Command" },
              { value: "http", label: "URL" },
            ]}
            value={transport}
            onChange={setTransport}
          />
        </div>
        <div className="mcp-field">
          <span className="form-label">{transport === "http" ? "Server URL" : "Command"}</span>
          <TextField
            value={target}
            onChange={onTarget}
            placeholder={transport === "http" ? "https://example.com/mcp" : "npx -y @modelcontextprotocol/server-github"}
            icon={transport === "http" ? "link" : "terminal"}
          />
          <span className="mcp-hint">{transport === "http" ? "A streamable HTTP endpoint." : "Or paste the JSON from the server’s README."}</span>
        </div>
        <div className="mcp-field">
          <span className="form-label">{transport === "http" ? "Headers" : "Environment variables"}</span>
          <TextArea
            value={secretText}
            onChange={setSecretText}
            rows={3}
            placeholder={transport === "http" ? "Authorization: Bearer …" : "GITHUB_PERSONAL_ACCESS_TOKEN=…"}
          />
          <span className="mcp-hint">
            <PixelIcon name="lock" size={12} /> Saved privately on this Mac, never synced.{" "}
            {stored.length && !clearSecrets ? (
              <>
                Saved now: {stored.join(", ")}. Leave empty to keep them, or{" "}
                <button className="text-link" onClick={() => setClearSecrets(true)}>
                  remove them
                </button>
                .
              </>
            ) : clearSecrets ? (
              "Saved values will be removed."
            ) : null}
          </span>
        </div>
      </div>
      <footer className="modal-actions">
        {existing ? (
          <Button
            variant="ghost"
            icon="trash"
            className="mcp-remove"
            onClick={() => {
              if (!confirmRemove) {
                setConfirmRemove(true);
                return;
              }
              invoke("deleteMcpServer", { id: existing.id });
              notify("Server removed", existing.name, "info");
              onClose();
            }}
          >
            {confirmRemove ? "Remove for good" : "Remove"}
          </Button>
        ) : null}
        <span className="spacer" />
        {blocked ? <em className="field-hint">{blocked}</em> : null}
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!valid} onClick={save}>
          {existing ? "Save" : "Add server"}
        </Button>
      </footer>
    </Modal>
  );
}

const KEY_GLYPH: Record<string, string> = { command: "⌘", option: "⌥", control: "⌃", shift: "⇧", space: "Space", return: "↩", escape: "esc", tab: "⇥" };

/** "option+space" → "⌥ Space". */
export function hotkeyLabel(value: string): string {
  if (!value) return "Off";
  return value
    .split("+")
    .map((part) => KEY_GLYPH[part] ?? part.toUpperCase())
    .join(" ");
}

/** Records a global shortcut: at least one modifier and one key. */
function HotkeyField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { invoke } = useDashboard();
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  // While recording, the Mac lets go of the current shortcut so pressing it records instead of summoning.
  useEffect(() => {
    if (!recording) return;
    invoke("hotkeyRecording", { on: true });
    return () => invoke("hotkeyRecording", { on: false });
  }, [recording, invoke]);
  const stop = () => {
    setRecording(false);
    setError("");
  };
  // Only the field itself listens, so typing anywhere else in Settings is never swallowed.
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    if (event.key === "Tab") {
      stop();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stop();
      return;
    }
    if (["Meta", "Alt", "Control", "Shift"].includes(event.key)) return;
    const mods = [event.metaKey && "command", event.altKey && "option", event.ctrlKey && "control", event.shiftKey && "shift"].filter(Boolean) as string[];
    if (!mods.length || (mods.length === 1 && mods[0] === "shift")) {
      setError("Add ⌘, ⌥ or ⌃ so it doesn’t fire while you type");
      return;
    }
    const code = event.code;
    const key = code === "Space" ? "space" : code.startsWith("Key") ? code.slice(3).toLowerCase() : code.startsWith("Digit") ? code.slice(5) : code === "Enter" ? "return" : "";
    if (!key) {
      setError("Use a letter, a number or Space");
      return;
    }
    if (mods.length === 1 && mods[0] === "command" && ["q", "w", "h", "m", "c", "v", "x", "z", "a"].includes(key)) {
      setError("That one belongs to every Mac app — try adding ⌥ or ⌃");
      return;
    }
    stop();
    onChange([...mods, key].join("+"));
  };
  return (
    <span className="hotkey-field">
      <button
        type="button"
        className={cx("hotkey-keys", recording && "is-recording")}
        onClick={() => {
          setError("");
          setRecording((v) => !v);
        }}
        onKeyDown={onKeyDown}
        onBlur={stop}
        aria-label={recording ? "Press the new shortcut, or Escape to cancel" : "Record a shortcut"}
      >
        {recording ? "Press keys…" : hotkeyLabel(value)}
      </button>
      {value && !recording ? (
        <button type="button" className="hotkey-clear" onClick={() => onChange("")}>
          Turn off
        </button>
      ) : null}
      {error ? <em className="hotkey-error" role="alert">{error}</em> : null}
    </span>
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
function Slider({ name, min, max, step, value, onChange, format }: { name: string; min: number; max: number; step: number; value: number; onChange: (value: number) => void; format: (value: number) => string }) {
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
  const commitRef = useRef(commit);
  commitRef.current = commit;
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
        aria-label={name}
        aria-valuetext={label}
        style={{ ["--fill" as string]: `${fill}%` }}
        onPointerDown={() => {
          dragging.current = true;
          // A release outside the slider still ends the drag.
          const end = () => {
            window.removeEventListener("pointerup", end);
            window.removeEventListener("pointercancel", end);
            if (dragging.current) commitRef.current();
          };
          window.addEventListener("pointerup", end);
          window.addEventListener("pointercancel", end);
        }}
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
