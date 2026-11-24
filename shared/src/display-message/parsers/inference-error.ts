import { INFERENCE_PROVIDER_LABELS } from '../../credentials/agents';
import { isTransientErrorText } from '../../errors';

const TRANSIENT_HTTP_STATUSES: readonly number[] = [408, 429, 500, 502, 503, 504, 529];
const SERVER_ERROR_TEXT_PATTERN = /internal ?server ?error|server ?error|service unavailable|bad gateway|gateway timeout|overloaded|too many requests/i;
const INFERENCE_ERROR_DETAIL_MAX = 600;
const INFERENCE_ERROR_RETRY_HINT = 'This is usually temporary — retry the message.';

export interface InferenceErrorContext {
  provider?: string;
  model?: string;
  status?: number;
  /** Provider-reported retryability; overrides text sniffing. */
  retryable?: boolean;
  detail?: string;
}

export function formatInferenceError(message: string, context: InferenceErrorContext = {}): string {
  const label = context.provider ? INFERENCE_PROVIDER_LABELS[context.provider] ?? context.provider : null;
  const source = label
    ? `${label}${context.model ? ` (${context.model})` : ''} request failed${typeof context.status === 'number' ? ` with HTTP ${context.status}` : ''}`
    : null;
  let body = source ? (message ? `${source}: ${message}` : `${source}.`) : message;
  const detail = context.detail?.trim();
  if (detail && !body.includes(detail)) {
    body = `${body}\n${detail.length > INFERENCE_ERROR_DETAIL_MAX ? `${detail.slice(0, INFERENCE_ERROR_DETAIL_MAX)}…` : detail}`;
  }
  const sniffText = `${message}\n${detail ?? ''}`;
  const transient = context.retryable
    ?? (typeof context.status === 'number'
      ? TRANSIENT_HTTP_STATUSES.includes(context.status) || context.status >= 500
      : isTransientErrorText(sniffText, { httpStatuses: TRANSIENT_HTTP_STATUSES, includeRateLimit: true })
        || SERVER_ERROR_TEXT_PATTERN.test(sniffText));
  return transient ? `${body}\n${INFERENCE_ERROR_RETRY_HINT}` : body;
}
