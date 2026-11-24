import type { AuditLogAction } from '../audit-log';

export interface AuditLogRecord {
  id: string;
  organization_id: string;

  resource_type: string;
  resource_id: string | null;
  resource_label: string | null;
  action: AuditLogAction;
  summary: string | null;

  user_id: string | null;
  user_email: string | null;
  user_name: string | null;
  api_key_id: string | null;
  api_key_name: string | null;

  environment_id: string | null;
  environment_name: string | null;

  created_at: string;
}

export interface ListAuditLogsResponse {
  logs: AuditLogRecord[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface AuditLogFiltersResponse {
  resource_types: string[];
  users: Array<{ user_id: string; email: string | null; name: string | null }>;
}
