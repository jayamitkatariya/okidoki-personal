import type { AgentProvider } from '../agent';
import type { CodeHostProvider } from '../code-host';

export interface CodeHostIssueSessionMetadata {
  issue_id: number;
  issue_number: number;
  issue_title: string;
  issue_body: string | null;
  issue_url: string;
  comment_id: number;
  comment_body: string;
  sender_login: string;
  sender_id: number;
  owner: string;
  repo: string;
  workspace?: {
    id: string;
    coding_agent: AgentProvider;
    task_description: string;
    created_at: string;
  };
}

export interface CodeHostIssueSessionRecord {
  id: string;
  provider: CodeHostProvider;
  provider_issue_id: number;
  provider_issue_number: number;
  github_issue_id: number | null;
  organization_id: string;
  repository_id: string;
  github_issue_number: number | null;
  status: string;
  metadata: CodeHostIssueSessionMetadata;
  soft_delete: boolean;
  created_at: string;
  updated_at: string;
}
