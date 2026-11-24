export interface NativeIntegrationStatus {
  github: boolean;
  gitlab: boolean;
  linear: boolean;
  slack: boolean;
}

export interface WorkspaceNativeIntegrationStatus extends NativeIntegrationStatus {
  sentry: boolean;
  infisical: { secretPath: string } | null;
}
