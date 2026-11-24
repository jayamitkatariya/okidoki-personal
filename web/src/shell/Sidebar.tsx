import { useMemo, useState } from "react";
import { useDashboard } from "../store";
import { cx } from "../lib";
import { Avatar, PixelIcon } from "../components/ui";
import { Tip } from "./Tip";
import { ChatMenu } from "./ChatMenu";
import { jumpToSettingsSection } from "../nav";
import { showsPrivateMac, threadInfo, type View } from "./model";

const CHATS_SHOWN = 5;

/** A spinner the size of a line of text, for a chat that's working. */
export function RowSpinner() {
  return <span className="srow-spin" aria-label="Working" role="img" />;
}

/**
 * The shell's one navigation: talk to okidoki, see the work, replay a skill,
 * open the vault, change settings. Browser tabs belong to a conversation, not
 * to the sidebar, so they never pile up here.
 */
export function Sidebar({
  view,
  onNavigate,
  onNewChat,
  onHide,
}: {
  view: View;
  onNavigate: (view: View) => void;
  onNewChat: () => void;
  onHide: () => void;
}) {
  const { state, settings, account } = useDashboard();
  const chats = useMemo(() => threadInfo(state), [state]);
  const [scrolled, setScrolled] = useState(false);

  const waiting = state.runs.filter((run) => run.status === "waiting" || run.status === "previewing" || run.status === "asked").length;
  const working = state.runs.filter((run) => run.status === "running").length;
  const status = !settings.okidokiEnabled
    ? "Paused"
    : settings.quietMode
      ? "Quiet mode"
      : waiting
        ? `${waiting} waiting for you`
        : working
          ? `${working} working`
          : "Ready";
  const vmShown = showsPrivateMac(state);
  const sessionLive = Boolean(state.collab?.active);
  const sessionHere = state.collab?.participants?.length ?? 0;
  const pageActive = (page: "runs" | "automations" | "skills" | "vault" | "settings") => view.kind === "page" && view.page === page;

  return (
    <aside className={cx("side", scrolled && "is-scrolled")} aria-label="okidoki">
      <div className="side-top">
        <span className="side-lights" aria-hidden="true" />
        <Tip label="Hide sidebar ⌘B">
          <button type="button" className="side-icon" aria-label="Hide sidebar (⌘B)" onClick={onHide}>
            <PixelIcon name="panel" size={16} />
          </button>
        </Tip>
        <Tip label="New chat ⌘N">
          <button type="button" className="side-icon" aria-label="New chat (⌘N)" onClick={onNewChat}>
            <PixelIcon name="plus" size={16} />
          </button>
        </Tip>
      </div>

      <div className="side-scroll" onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 2)}>
        <button
          type="button"
          className={cx("side-brand", view.kind === "home" && "is-active")}
          aria-current={view.kind === "home" ? "page" : undefined}
          onClick={() => onNavigate({ kind: "home" })}
        >
          <span className="side-brandmark" aria-hidden="true" />
          <span className="side-brand-text">
            <strong>okidoki</strong>
            <em>Ask me anything</em>
          </span>
        </button>

        <nav className="side-nav" aria-label="Main">
          <NavRow
            icon="hand"
            label="Work"
            count={waiting || working || undefined}
            active={pageActive("runs")}
            onClick={() => onNavigate({ kind: "page", page: "runs" })}
          />
          <NavRow icon="clock" label="Automations" active={pageActive("automations")} onClick={() => onNavigate({ kind: "page", page: "automations" })} />
          <NavRow icon="repeat" label="Replay" active={pageActive("skills")} onClick={() => onNavigate({ kind: "page", page: "skills" })} />
          <NavRow icon="lock" label="Vault" active={pageActive("vault")} onClick={() => onNavigate({ kind: "page", page: "vault" })} />
          <NavRow icon="gear" label="Settings" active={pageActive("settings")} onClick={() => onNavigate({ kind: "page", page: "settings" })} />
        </nav>

        <section className="side-recent" aria-label="Recent conversations">
          <header className="side-heading">Recent</header>
          <div className="side-rows">
            {chats.slice(0, CHATS_SHOWN).map((info) => (
              <Row
                key={info.thread.id}
                label={info.thread.title || "New chat"}
                title={info.thread.title || undefined}
                active={view.kind === "chat" && view.id === info.thread.id}
                onClick={() => onNavigate({ kind: "chat", id: info.thread.id })}
                menu={
                  <ChatMenu
                    thread={info.thread}
                    className="srow-close"
                    onGone={() => view.kind === "chat" && view.id === info.thread.id && onNavigate({ kind: "home" })}
                  />
                }
                trailing={
                  info.needsYou ? (
                    <span className="srow-badge" aria-label="Needs you">
                      !
                    </span>
                  ) : info.active ? (
                    <RowSpinner />
                  ) : info.unread ? (
                    <span className="unread-dot" aria-label="Unread" role="img" />
                  ) : null
                }
              />
            ))}
            {!chats.length ? <p className="side-empty">No conversations yet. Ask okidoki anything.</p> : null}
            {chats.length > CHATS_SHOWN ? (
              <Row label="All chats" muted onClick={() => onNavigate({ kind: "page", page: "history" })} />
            ) : null}
          </div>
        </section>

        {vmShown || sessionLive ? (
          <section className="side-recent" aria-label="Live">
            <header className="side-heading">Live</header>
            <div className="side-rows">
              {sessionLive ? (
                <Row
                  icon={<PixelIcon name="people" size={16} />}
                  label="Shared session"
                  active={pageActive("settings")}
                  onClick={() => {
                    onNavigate({ kind: "page", page: "settings" });
                    jumpToSettingsSection("session");
                  }}
                  trailing={<span className="side-count tnum">{sessionHere}</span>}
                />
              ) : null}
              {vmShown ? (
                <Row
                  icon={<PixelIcon name="screen" size={16} />}
                  label="Private Mac"
                  active={view.kind === "vm"}
                  onClick={() => onNavigate({ kind: "vm" })}
                />
              ) : null}
            </div>
          </section>
        ) : null}
      </div>

      <div className="side-foot">
        <button
          type="button"
          className="side-account"
          onClick={() => onNavigate({ kind: "page", page: "settings" })}
          aria-label={`${account.name}, ${status}. Open settings`}
        >
          <Avatar account={account} size={26} />
          <span className="side-account-text">
            <strong>{account.name}</strong>
            <em className={cx(waiting > 0 && "is-wait", !settings.okidokiEnabled && "is-off")}>{status}</em>
          </span>
        </button>
      </div>
    </aside>
  );
}

function NavRow({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: string;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={cx("srow", "side-nav-row", active && "is-active")} aria-current={active ? "page" : undefined} onClick={onClick}>
      <span className="srow-icon">
        <PixelIcon name={icon} size={16} />
      </span>
      <span className="srow-label">{label}</span>
      {count ? <span className="side-count tnum">{count > 9 ? "9+" : count}</span> : null}
    </button>
  );
}

function Row({
  icon,
  label,
  title,
  active,
  muted,
  onClick,
  trailing,
  menu,
}: {
  icon?: React.ReactNode;
  label: string;
  title?: string;
  active?: boolean;
  muted?: boolean;
  onClick: () => void;
  trailing?: React.ReactNode;
  menu?: React.ReactNode;
}) {
  return (
    <div className={cx("srow", active && "is-active", muted && "is-muted", Boolean(menu) && "has-close")} title={title}>
      <button type="button" className="srow-main" onClick={onClick} aria-current={active ? "page" : undefined}>
        {icon ? <span className="srow-icon">{icon}</span> : null}
        <span className="srow-label">{label}</span>
        {trailing ? <span className="srow-trailing">{trailing}</span> : null}
      </button>
      {menu}
    </div>
  );
}
