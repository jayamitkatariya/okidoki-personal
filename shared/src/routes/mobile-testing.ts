export type MobileTestingPlatform = 'ios' | 'android';
export type MobileTestingInstanceState = 'creating' | 'assigned' | 'ready';

export interface MobileTestingInstance {
  id: string;
  platform: MobileTestingPlatform;
  state: MobileTestingInstanceState;
  model: string | null;
  endpointWebSocketUrl: string | null;
  signedStreamUrl: string | null;
  token: string | null;
}

export interface ListMobileTestingInstancesResponse {
  instances: MobileTestingInstance[];
}
