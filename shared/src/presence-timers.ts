import type { PresenceStatus } from './routes/presence';

const TYPING_IDLE_MS = 4_000;

type PostStatus = (status: PresenceStatus) => void;

export function createTypingPresence() {
  let session: { key: string; post: PostStatus; idle: ReturnType<typeof setTimeout> } | null = null;
  const drop = () => {
    if (session) clearTimeout(session.idle);
    session = null;
  };
  const stop = () => {
    const post = session?.post;
    drop();
    post?.('online');
  };
  const type = (post: PostStatus, key = '') => {
    if (session && session.key !== key) stop();
    if (session) clearTimeout(session.idle);
    else post('typing');
    session = { key, post, idle: setTimeout(stop, TYPING_IDLE_MS) };
  };
  return { type, stop, drop, isTyping: (key?: string) => session !== null && (key === undefined || session.key === key) };
}

// A switch leaves one workspace and enters the next in one commit, so the leave post waits to be replaced.
const pendingLeaves = new Map<string, ReturnType<typeof setTimeout>>();

export function cancelPresenceLeave(scope: string): void {
  clearTimeout(pendingLeaves.get(scope));
  pendingLeaves.delete(scope);
}

export function schedulePresenceLeave(scope: string, leave: () => void): void {
  cancelPresenceLeave(scope);
  pendingLeaves.set(scope, setTimeout(() => {
    pendingLeaves.delete(scope);
    leave();
  }));
}
