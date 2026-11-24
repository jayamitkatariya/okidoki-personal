interface PingableSocket {
  readonly isPaused: boolean;
  ping(): void;
  on(event: string, listener: () => void): unknown;
}

export function trackWebSocketLiveness(socket: PingableSocket): () => boolean {
  let answered = true;
  for (const event of ['pong', 'message']) socket.on(event, () => { answered = true; });
  return () => {
    // A paused socket isn't read, so its pong waits behind data the other side hasn't taken yet.
    if (socket.isPaused) {
      answered = true;
      return true;
    }
    if (!answered) return false;
    answered = false;
    socket.ping();
    return true;
  };
}
