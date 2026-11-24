/**
 * A standard discriminated-union result type used across services to represent
 * an operation that can succeed with data or fail with a structured error.
 *
 * Use this for *expected* failures that a caller should branch on (validation
 * errors, "not found", "unauthorized", etc.). Keep throwing for *exceptional*
 * conditions (a downed database, misconfiguration) that should bubble up loudly.
 *
 * The HTTP wire boundary is not a `Result`: route handlers translate a `Result`
 * into an HTTP status + JSON body at the edge, and clients translate back.
 */

export type SuccessResult<T> = {
  ok: true;
  data: T;
};

export type ErrorResult<K = string> = {
  ok: false;
  error: {
    message: string;
    code?: K;
    details?: unknown;
  };
};

export type Result<T, K = string> = SuccessResult<T> | ErrorResult<K>;

export function createSuccessResult<T>(data: T): SuccessResult<T>;
export function createSuccessResult(): SuccessResult<void>;
export function createSuccessResult<T = void>(data?: T): SuccessResult<T | void> {
  return { ok: true, data };
}

export function createErrorResult<K = string>(error: {
  message: string;
  code?: K;
  details?: unknown;
}): ErrorResult<K> {
  return {
    ok: false,
    error: {
      message: error.message,
      code: error.code,
      details: error.details,
    },
  };
}
