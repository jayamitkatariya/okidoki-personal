import type { WorkspaceNativeIntegrationStatus } from './integrations';
import { PLUGIN_CATALOG, type HostedPluginAuthScheme } from './plugin-catalog';

export { PLUGIN_CATALOG } from './plugin-catalog';

export type PluginId = (typeof PLUGIN_CATALOG)[number]['id'];
export type PluginBackend = (typeof PLUGIN_CATALOG)[number]['backend'];
export type NativePluginId = Extract<(typeof PLUGIN_CATALOG)[number], { backend: 'native' }>['id'];
export type ComposioPluginId = Extract<(typeof PLUGIN_CATALOG)[number], { backend: 'composio' }>['id'];
export type PluginAuthType = (typeof PLUGIN_CATALOG)[number]['authType'];
export type PluginCategory = (typeof PLUGIN_CATALOG)[number]['category'];
export const PLUGIN_CONNECTION_STATUSES = ['initiated', 'active', 'expired', 'failed'] as const;
export type PluginConnectionStatus = (typeof PLUGIN_CONNECTION_STATUSES)[number];

export interface PluginCatalogItem {
  id: PluginId;
  backend: PluginBackend;
  toolkit: string;
  authType: PluginAuthType;
  authScheme?: HostedPluginAuthScheme;
  managedAuth?: boolean;
  category: PluginCategory;
  name: string;
  description: string;
  readOnlyScopes?: readonly string[];
}

export interface PluginConnectionSummary {
  id: string;
  pluginId: PluginId;
  environmentId: string;
  status: PluginConnectionStatus;
  accountLabel?: string;
  connectedAt?: string;
  readOnly: boolean;
}

export interface PluginConnectionsResponse {
  plugins: PluginCatalogItem[];
  environment: PluginConnectionSummary[];
}

export interface PluginStartOAuthRequest {
  readOnly?: boolean;
}

export interface PluginStartOAuthResponse {
  authorizationUrl: string;
}

export const POSTHOG_REGIONS = ['us', 'eu'] as const;
export type PostHogRegion = (typeof POSTHOG_REGIONS)[number];

export interface PluginConnectPostHogRequest {
  apiKey: string;
  region: PostHogRegion;
}

export interface PluginConnectClickHouseRequest {
  url: string;
  username: string;
  password: string;
  database?: string;
}

export interface PluginConnectApiKeyRequest {
  apiKey: string;
}

export type PluginConnectCloudflareRequest = PluginConnectApiKeyRequest;

export const LIGHTFIELD_API_VERSION = '2026-03-01';

export const GREPTILE_KNOWLEDGE_BASE_TOOLS = [
  'get_me',
  'list_repositories',
  'list_knowledge_bases',
  'list_knowledge_base_documents',
  'get_knowledge_base_document',
  'search_knowledge_base',
] as const;

export type GreptileKnowledgeBaseTool = (typeof GREPTILE_KNOWLEDGE_BASE_TOOLS)[number];

export interface GreptileCallRequest {
  tool: GreptileKnowledgeBaseTool;
  arguments?: Record<string, unknown>;
}

export const SAZABI_MCP_TOOLS = ['search', 'execute'] as const;

export type SazabiMcpTool = (typeof SAZABI_MCP_TOOLS)[number];

export interface PluginConnectModalRequest {
  tokenId: string;
  tokenSecret: string;
}

export const VANTA_DEPLOYMENTS = ['standard', 'gov'] as const;
export type VantaDeployment = (typeof VANTA_DEPLOYMENTS)[number];

export interface PluginConnectVantaRequest {
  clientId: string;
  clientSecret: string;
  deployment: VantaDeployment;
}

export const TURBOPUFFER_REGIONS = ['aws-us-east-1', 'aws-us-west-2', 'gcp-us-central1', 'gcp-europe-west3'] as const;
export type TurbopufferRegion = (typeof TURBOPUFFER_REGIONS)[number];

export interface PluginConnectTurbopufferRequest {
  apiKey: string;
  region: TurbopufferRegion;
}

export type PluginConnectRequest =
  | PluginConnectPostHogRequest
  | PluginConnectClickHouseRequest
  | PluginConnectApiKeyRequest
  | PluginConnectModalRequest
  | PluginConnectVantaRequest
  | PluginConnectTurbopufferRequest;

export interface ModalCallRequest {
  app: string;
  function: string;
  args?: unknown[];
  kwargs?: Record<string, unknown>;
  environment?: string;
}

export interface TurbopufferOperationRequest {
  operation: 'namespaces' | 'metadata' | 'query' | 'write';
  namespace?: string;
  params?: Record<string, unknown>;
}

export interface PluginConnectResponse {
  success: true;
}

export interface PluginConnectionDeleteResponse {
  success: boolean;
}

export interface PangramAnalyzeRequest {
  text: string;
  publicDashboardLink?: boolean;
}

export interface WorkspacePluginSummary extends PluginCatalogItem {
  connected: boolean;
  status?: PluginConnectionStatus;
  accountLabel?: string;
  connections: PluginConnectionSummary[];
}

export interface WorkspaceIntegrationsResponse {
  plugins: WorkspacePluginSummary[];
  native: WorkspaceNativeIntegrationStatus;
}

export interface PluginSearchRequest {
  plugin: ComposioPluginId;
  query: string;
  connectionId?: string;
}

export interface PluginToolSchema {
  slug: string;
  toolkit: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface PluginSearchResponse {
  tools: PluginToolSchema[];
}

export interface PluginDescribeRequest {
  plugin: ComposioPluginId;
  tools: string[];
  connectionId?: string;
}

export interface PluginDescribeResponse {
  tools: PluginToolSchema[];
}

export interface PluginExecuteRequest {
  plugin: ComposioPluginId;
  tool: string;
  arguments?: Record<string, unknown>;
  connectionId?: string;
}

export interface PluginExecuteResponse {
  data: unknown;
  logId: string;
}

export function isPluginId(value: string): value is PluginId {
  return PLUGIN_CATALOG.some((plugin) => plugin.id === value);
}

export function isComposioPluginId(value: string): value is ComposioPluginId {
  return PLUGIN_CATALOG.some((plugin) => plugin.id === value && plugin.backend === 'composio');
}

export function isNativePluginId(value: string): value is NativePluginId {
  return PLUGIN_CATALOG.some((plugin) => plugin.id === value && plugin.backend === 'native');
}

export function isPluginConnectionStatus(value: string): value is PluginConnectionStatus {
  return PLUGIN_CONNECTION_STATUSES.some((status) => status === value);
}
