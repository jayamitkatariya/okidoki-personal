export interface EgressProfileRecord {
  id: string;
  organization_id: string;
  /** The systemd instance serving this organization on the exit. Null when a human created it, in which case the monolith will not act on it. */
  exit_listener: string | null;
  proxy_host: string;
  proxy_port: number;
  enabled: boolean;
  destinations: string[];
  dedicated_ip_allocation_id: string | null;
  routes_all_traffic: boolean;
  created_at: string;
  updated_at: string;
}

export interface AdminListEgressProfilesResponse {
  profiles: EgressProfileRecord[];
}

export interface AdminUpsertEgressProfileRequest {
  proxyHost: string;
  proxyPort: number;
  /** Shadowsocks password for this customer's dedicated exit port. Write-only. */
  password: string;
  enabled?: boolean;
}

export interface AdminUpsertEgressProfileResponse {
  profile: EgressProfileRecord;
}

export interface AdminDeleteEgressProfileResponse {
  success: boolean;
}

export interface AdminProvisionEgressProfileResponse {
  profile: EgressProfileRecord;
  allowlistAddress: string;
}
