// Mirrored as Postgres ENUM `public.audit_log_action` — keep in sync.
export const AUDIT_LOG_ACTION = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
} as const;

export type AuditLogAction = typeof AUDIT_LOG_ACTION[keyof typeof AUDIT_LOG_ACTION];

export const AUDIT_LOG_ACTIONS: readonly AuditLogAction[] =
  Object.values(AUDIT_LOG_ACTION);
