export interface ExternalAccountConnectionStatusResponse {
  hasConnection: boolean;
  displayName?: string;
  lastConnectedAt?: string;
}

export interface ExternalAccountConnectionDeleteResponse {
  success: boolean;
}
