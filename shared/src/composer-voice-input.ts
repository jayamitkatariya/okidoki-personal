export interface ComposerVoiceInputSession {
  base: string;
  lastValue: string;
}

export type ComposerVoiceInputState = 'idle' | 'starting' | 'listening' | 'stopping';

export type VoiceInputEvent =
  | { type: 'listening' }
  | { type: 'audio-level'; levels: number[] }
  | { type: 'result'; transcript: string }
  | { type: 'error'; message: string }
  | { type: 'stopped' };

const BAR_HEIGHTS = [6, 10, 14, 8, 12, 16, 9, 13, 7, 15, 11, 6];

export const VOICE_WAVEFORM = {
  bands: BAR_HEIGHTS.length,
  intervalMs: 32,
  rmsFloor: 0.001,
  minDecibels: -48,
  decibelRange: 36,
  barHeights: BAR_HEIGHTS,
};

export function voiceWaveformLevel(rms: number): number {
  const decibels = 20 * Math.log10(Math.max(rms, VOICE_WAVEFORM.rmsFloor));
  return Math.max(0, Math.min(1, (decibels - VOICE_WAVEFORM.minDecibels) / VOICE_WAVEFORM.decibelRange));
}

export function createComposerVoiceInputSession(value: string): ComposerVoiceInputSession {
  return {
    base: value && !/\s$/.test(value) ? `${value} ` : value,
    lastValue: value,
  };
}

export function updateComposerVoiceTranscript(session: ComposerVoiceInputSession, transcript: string): string {
  session.lastValue = `${session.base}${transcript}`;
  return session.lastValue;
}
