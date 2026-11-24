import type { DataChannel, PeerConnection } from 'node-datachannel';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { TERMINAL_RTC_ICE_SERVER, type TerminalRtcCandidate, type TerminalSocketCommand, type TerminalSocketMessage, type TerminalSocketServerMessage } from '@okidoki/shared';
import { terminalCommandSchema, terminalService } from './terminal-service';

type Ndc = typeof import('node-datachannel').default;
let ndcModule: Promise<Ndc | null> | undefined;
// Loaded on first offer so a missing native binary only costs the direct path, not the terminal.
const loadNdc = () => ndcModule ??= import('node-datachannel').then((module) => module.default, () => null);

const CHANNEL_CHUNK_CHARS = 16_384;
const MAX_QUEUED_CANDIDATES = 32;
// A viewer that falls this far behind is cut off; it reconnects and resyncs from the replay buffer.
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

const socketMessageSchema = z.union([
  terminalCommandSchema,
  z.object({ type: z.literal('rtc-offer'), sdp: z.string().max(64 * 1024) }),
  z.object({ type: z.literal('rtc-candidate'), candidate: z.string().max(1024), mid: z.string().max(64) }),
  z.object({ type: z.literal('rtc-switch') }),
]) satisfies z.ZodType<Exclude<TerminalSocketMessage, { type: 'auth' }>>;

function parse<T>(schema: z.ZodType<T>, raw: string): T | null {
  try {
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function attachTerminalSocket(id: string, socket: WebSocket): void {
  const send = (message: TerminalSocketServerMessage) => socket.send(JSON.stringify(message));
  let peer: PeerConnection | null = null;
  let channel: DataChannel | null = null;
  const candidates: TerminalRtcCandidate[] = [];
  // Input the browser sent on the channel before its `rtc-switch` reached us over the slower socket.
  let early: TerminalSocketCommand[] | null = [];
  const subscription = terminalService.subscribe(id, (data) => {
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES || (channel?.bufferedAmount() ?? 0) > MAX_BUFFERED_BYTES) {
      socket.terminate();
      return;
    }
    if (!channel?.isOpen()) {
      send({ type: 'output', data });
      return;
    }
    // Stays far below the data channel's 256 KiB message limit, without splitting a surrogate pair.
    for (let start = 0; start < data.length;) {
      let end = Math.min(start + CHANNEL_CHUNK_CHARS, data.length);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
      channel.sendMessage(data.slice(start, end));
      start = end;
    }
  });
  if (!subscription) {
    socket.close(4410, 'Terminal session not found');
    return;
  }
  if (subscription.replay) send({ type: 'output', data: subscription.replay });

  const negotiate = async (offer: string) => {
    const ndc = await loadNdc();
    if (!ndc || peer || socket.readyState !== socket.OPEN) return;
    const connection = new ndc.PeerConnection(`terminal-${id}`, { iceServers: [TERMINAL_RTC_ICE_SERVER] });
    peer = connection;
    connection.onLocalDescription((sdp) => send({ type: 'rtc-answer', sdp }));
    connection.onLocalCandidate((candidate, mid) => send({ type: 'rtc-candidate', candidate, mid }));
    connection.onDataChannel((dc) => {
      dc.onMessage((raw) => {
        const command = typeof raw === 'string' ? parse(terminalCommandSchema, raw) : null;
        if (!command) return;
        if (early) early.push(command);
        else terminalService.command(id, command);
      });
      dc.onClosed(() => {
        if (channel === dc) channel = null;
      });
      const activate = () => {
        channel = dc;
        send({ type: 'rtc-switch' });
      };
      if (dc.isOpen()) activate();
      else dc.onOpen(activate);
    });
    connection.setRemoteDescription(offer, 'offer');
    for (const { candidate, mid } of candidates.splice(0)) connection.addRemoteCandidate(candidate, mid);
  };

  socket.on('message', (raw) => {
    const message = parse(socketMessageSchema, raw.toString());
    if (!message) return;
    if (message.type === 'rtc-offer') {
      negotiate(message.sdp).catch(() => {
        peer?.close();
        peer = null;
      });
    }
    else if (message.type === 'rtc-candidate') {
      if (peer) peer.addRemoteCandidate(message.candidate, message.mid);
      else if (candidates.length < MAX_QUEUED_CANDIDATES) candidates.push(message);
    }
    else if (message.type === 'rtc-switch') {
      for (const command of early ?? []) terminalService.command(id, command);
      early = null;
    } else terminalService.command(id, message);
  });
  socket.on('close', () => {
    subscription.unsubscribe();
    channel = null;
    peer?.close();
  });
}
