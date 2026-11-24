import type {
  PluginDescribeRequest,
  PluginDescribeResponse,
  PluginExecuteRequest,
  PluginExecuteResponse,
  PluginSearchRequest,
  PluginSearchResponse,
  WorkspaceIntegrationsResponse,
  WorkspacePluginSummary,
} from './routes/plugins';

export type {
  PluginConnectionStatus,
  PluginId,
  PluginToolSchema,
  WorkspaceIntegrationsResponse,
  WorkspacePluginSummary,
} from './routes/plugins';

export interface AttachedLinearIssue {
  session_id: string;
  issue: { identifier: string; title: string; url: string };
}

export interface ProviderRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
}

export interface OkidokiSdk {
  integrations: {
    list(): Promise<WorkspaceIntegrationsResponse>;
  };
  plugins: {
    list(): Promise<WorkspacePluginSummary[]>;
    search(input: PluginSearchRequest): Promise<PluginSearchResponse>;
    describe(input: PluginDescribeRequest): Promise<PluginDescribeResponse>;
    execute<T = unknown>(input: PluginExecuteRequest): Promise<Omit<PluginExecuteResponse, 'data'> & { data: T }>;
  };
  linear: {
    download(url: string): Promise<Response>;
    graphql<T = unknown>(input: {
      query: string;
      variables?: Record<string, unknown> | null;
      operationName?: string | null;
    }): Promise<T>;
    attachIssue(input: { issue: string }): Promise<AttachedLinearIssue>;
  };
  slack: {
    call<T = unknown>(method: string, args?: Record<string, unknown>): Promise<T>;
    download(url: string): Promise<Response>;
    attachThread(input: { channel: string; threadTs: string }): Promise<{
      thread: unknown;
      workspace: { id: string; name: string };
    }>;
  };
  github: {
    request<T = unknown>(path: string, options?: ProviderRequestOptions & { repository?: string }): Promise<T>;
  };
  gitlab: {
    request<T = unknown>(path: string, options?: ProviderRequestOptions & { host?: string }): Promise<T>;
  };
  sentry: {
    request<T = unknown>(path: string): Promise<T>;
  };
  modal: {
    call<T = unknown>(input: import('./routes/plugins').ModalCallRequest): Promise<T>;
  };
  greptile: {
    call<T = unknown>(tool: import('./routes/plugins').GreptileKnowledgeBaseTool, args?: Record<string, unknown>): Promise<T>;
  };
  sazabi: {
    call<T = unknown>(tool: import('./routes/plugins').SazabiMcpTool, args?: Record<string, unknown>): Promise<T>;
  };
  kondo: {
    tools(): Promise<{ tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[] }>;
    call<T = unknown>(tool: string, args?: Record<string, unknown>): Promise<T>;
  };
  turbopuffer: {
    namespaces<T = unknown>(params?: Record<string, unknown>): Promise<T>;
    metadata<T = unknown>(namespace: string, params?: Record<string, unknown>): Promise<T>;
    query<T = unknown>(namespace: string, params: Record<string, unknown>): Promise<T>;
    write<T = unknown>(namespace: string, params: Record<string, unknown>): Promise<T>;
  };
  planetscale: {
    request<T = unknown>(path: string, options?: ProviderRequestOptions): Promise<T>;
  };
  vercel: {
    request<T = unknown>(path: string, options?: ProviderRequestOptions): Promise<T>;
  };
  lightfield: {
    request<T = unknown>(path: string, options?: ProviderRequestOptions): Promise<T>;
  };
  vanta: {
    request<T = unknown>(path: `/v1/${string}`, options?: ProviderRequestOptions): Promise<T>;
  };
  pangram: {
    detect<T = unknown>(input: import('./routes/plugins').PangramAnalyzeRequest): Promise<T>;
    plagiarism<T = unknown>(text: string): Promise<T>;
  };
}
