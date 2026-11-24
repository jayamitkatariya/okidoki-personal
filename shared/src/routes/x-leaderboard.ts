export const X_LEADERBOARD_PERIODS = ['24h', '7d', '30d'] as const;
export type XLeaderboardPeriod = (typeof X_LEADERBOARD_PERIODS)[number];
type XCompanyKind = 'okidoki' | 'goal';
export const X_BOOST_ACTIONS = ['like', 'reply', 'repost', 'quote'] as const;
export type XBoostAction = (typeof X_BOOST_ACTIONS)[number];

export const isXLeaderboardPeriod = (value: string): value is XLeaderboardPeriod =>
  X_LEADERBOARD_PERIODS.some((period) => period === value);

export interface XLeaderboardPerson {
  id: string;
  companyId: string;
  xUserId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  source: 'manual' | 'affiliate';
  included: boolean;
  active: boolean;
  oauthConnected: boolean;
  monitoringMode: 'activity' | 'polling';
  lastSyncedAt: string | null;
  syncError: string | null;
  rank: number;
  posts: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  interactions: number;
  impressions: number;
}

export type XLeaderboardPostKind = 'post' | 'reply' | 'repost' | 'quote';

export interface XLeaderboardPost {
  id: string;
  xPostId: string;
  kind: XLeaderboardPostKind;
  text: string;
  url: string;
  postedAt: string;
  lastSyncedAt: string;
  deletedAt: string | null;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  impressions: number;
}

export interface GetXLeaderboardPersonPostsResponse {
  period: XLeaderboardPeriod;
  person: Pick<XLeaderboardPerson, 'id' | 'handle' | 'displayName' | 'avatarUrl' | 'lastSyncedAt' | 'syncError'>;
  posts: XLeaderboardPost[];
  page: number;
  pageSize: number;
  total: number;
}

export interface XLeaderboardCompany {
  id: string;
  xUserId: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  kind: XCompanyKind;
  displayOrder: number;
  affiliateSyncEnabled: boolean;
  active: boolean;
  lastSyncedAt: string | null;
  rank: number;
  employeeCount: number;
  topEmployee: Pick<XLeaderboardPerson, 'id' | 'handle' | 'displayName' | 'avatarUrl' | 'interactions'> | null;
  posts: number;
  interactions: number;
  impressions: number;
  people: XLeaderboardPerson[];
  roster: XLeaderboardPerson[];
}

export interface XBoostLeaderboardEntry {
  person: Pick<XLeaderboardPerson, 'id' | 'handle' | 'displayName' | 'avatarUrl'>;
  rank: number;
  score: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
}

export interface XRecentBoost {
  id: string;
  actor: Pick<XLeaderboardPerson, 'id' | 'handle' | 'displayName' | 'avatarUrl'>;
  targetAuthor: Pick<XLeaderboardPerson, 'id' | 'handle' | 'displayName' | 'avatarUrl'>;
  action: XBoostAction;
  occurredAt: string;
  elapsedSeconds: number;
  multiplier: number;
  points: number;
  postUrl: string;
  slackUrl: string | null;
}

export interface XLeaderboardSettings {
  monitoringEnabled: boolean;
  slackChannelId: string | null;
  competitorRefreshHours: number;
  recentPostRefreshMinutes: number;
  appConfigured: boolean;
  oauthConfigured: boolean;
}

export interface GetXLeaderboardResponse {
  period: XLeaderboardPeriod;
  companies: XLeaderboardCompany[];
  boosting: XBoostLeaderboardEntry[];
  recentBoosts: XRecentBoost[];
  settings: XLeaderboardSettings;
  lastSyncedAt: string | null;
}

export interface CreateXLeaderboardCompanyRequest {
  handle: string;
  kind?: XCompanyKind;
  affiliateSyncEnabled?: boolean;
}

export interface CreateXLeaderboardCompanyResponse {
  company: XLeaderboardCompany;
}

export interface UpdateXLeaderboardCompanyRequest {
  displayOrder?: number;
  affiliateSyncEnabled?: boolean;
  active?: boolean;
}

export interface AddXLeaderboardPersonRequest {
  companyId: string;
  handle: string;
}

export interface UpdateXLeaderboardPersonRequest {
  included?: boolean;
  active?: boolean;
}

export interface UpdateXLeaderboardSettingsRequest {
  monitoringEnabled?: boolean;
  slackChannelId?: string | null;
  competitorRefreshHours?: number;
  recentPostRefreshMinutes?: number;
}

export interface ReconcileXLeaderboardResponse {
  companiesSynced: number;
  peopleSynced: number;
  postsSynced: number;
  boostsSynced: number;
  errors: string[];
  completedAt: string;
}

export interface XOAuthStartResponse {
  authorizationUrl: string;
}
