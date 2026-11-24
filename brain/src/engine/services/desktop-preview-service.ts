import { DESKTOP_STREAM_PORT } from '@okidoki/shared';
import { ENGINE_ENV } from '../engine-env';
import { monolithRequest } from './monolith-service';
import { setTimeout } from 'node:timers/promises';

const REGISTRATION_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const ATTEMPT_TIMEOUT_MS = 8_000;

async function attemptRegistration(signal: AbortSignal): Promise<boolean> {
  try {
    const response = await monolithRequest('/v1/previews', {
      body: { port: DESKTOP_STREAM_PORT, authenticated: true },
      signal: AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)]),
    });

    if (response.ok || response.status === 409) {
      console.log(
        `[DesktopPreview] Registered port ${DESKTOP_STREAM_PORT} (status ${response.status}).`,
      );
      return true;
    }

    const errorText = await response.text().catch(() => '');
    console.error(
      `[DesktopPreview] Registration failed: ${response.status} ${errorText}`,
    );
    return false;
  } catch (error) {
    if (signal.aborted) return false;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[DesktopPreview] Registration error: ${message}`);
    return false;
  }
}

export async function registerDesktopPreview(signal: AbortSignal): Promise<void> {
  if (!ENGINE_ENV.OKIDOKI_WORKSPACE_ID) {
    return;
  }

  const deadline = Date.now() + REGISTRATION_TIMEOUT_MS;
  while (!signal.aborted && Date.now() < deadline) {
    if (await attemptRegistration(signal)) {
      return;
    }
    await setTimeout(RETRY_DELAY_MS, undefined, { signal }).catch(() => {});
  }

  if (signal.aborted) return;
  console.error(
    `[DesktopPreview] Gave up registering port ${DESKTOP_STREAM_PORT} after ${REGISTRATION_TIMEOUT_MS}ms`,
  );
}
