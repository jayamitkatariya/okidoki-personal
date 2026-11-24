export const CODE_HOST_PROVIDERS = ['github', 'gitlab'] as const;
export type CodeHostProvider = (typeof CODE_HOST_PROVIDERS)[number];

export const CODE_HOST_RECONNECT_REQUIRED_CODES = {
  github: 'GITHUB_RECONNECT_REQUIRED',
  gitlab: 'GITLAB_RECONNECT_REQUIRED',
} as const satisfies Record<CodeHostProvider, string>;

export type CodeHostReconnectRequiredCode =
  (typeof CODE_HOST_RECONNECT_REQUIRED_CODES)[CodeHostProvider];

export interface CodeHostStartOAuthResponse {
  authorizationUrl: string;
}
