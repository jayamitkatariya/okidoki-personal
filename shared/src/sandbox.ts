import { parentDomain } from './preview-host';
import { createErrorResult, createSuccessResult, type Result } from './result';

export const SANDBOX_LIFECYCLE = {
  AUTO_STOP_MINUTES: 30,
  AUTO_ARCHIVE_MINUTES: 60 * 24 * 7,
  AUTO_DELETE_MINUTES: -1,
  SSH_TOKEN_EXPIRATION_MINUTES: 3 * 60,
} as const;

/** Sandbox compute providers backed by workspace rows. */
export const SANDBOX_PROVIDERS = ['tensorlake'] as const;
export type SandboxProviderId = (typeof SANDBOX_PROVIDERS)[number];

export interface SshWebSocketTransport {
  type: 'websocket';
  url: string;
}

/** Absolute sandbox paths for monolith-side file operations. */
export interface SandboxPaths {
  HOME_DIR: string;
  WORKSPACES_DIR: string;
  OKIDOKI_DIR: string;
  OKIDOKI_CANVAS_DIR: string;
  OKIDOKI_RUNTIME_ENV_FILE: string;
}

export const SANDBOX_CANVAS_DISPLAY_DIR = '~/.okidoki/canvas';

export const SANDBOX_PATHS: SandboxPaths = {
  HOME_DIR: '/home/user',
  WORKSPACES_DIR: '/home/user/workspaces',
  OKIDOKI_DIR: '/home/user/.okidoki',
  OKIDOKI_CANVAS_DIR: '/home/user/.okidoki/canvas',
  OKIDOKI_RUNTIME_ENV_FILE: '/home/user/.okidoki/runtime-env.sh',
};

export const SANDBOX_NVM_SOURCE = `export NVM_DIR="/usr/local/nvm" && if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; fi`;

/** Cookie name used for authenticated preview URLs. */
export const PREVIEW_AUTH_COOKIE_NAME = 'okidoki_preview_token';

export interface PreviewAuthHandoffRequest {
  url: string;
}

export interface PreviewAuthHandoffResponse {
  url: string;
}

export function serializePreviewAuthCookie(value: string, hostname: string, maxAge: number) {
  const domainBase = hostname.split(':')[0];
  const isLocalhost = domainBase === 'localhost';
  const isLocalDevelopment = domainBase.split('.').includes('localhost');
  const domain = isLocalDevelopment
    ? isLocalhost
      ? undefined
      : domainBase
    : parentDomain(domainBase);

  return [
    `${PREVIEW_AUTH_COOKIE_NAME}=${value}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    `SameSite=${isLocalDevelopment ? 'Lax' : 'None'}`,
    ...(domain ? [`Domain=${domain}`] : []),
    ...(!isLocalDevelopment ? ['Secure'] : []),
    'HttpOnly',
  ].join('; ');
}

export type SandboxMemoryTier = 'default' | 'high' | 'ultra';

export const SANDBOX_MEMORY_TIER_VALUES: Record<SandboxMemoryTier, number> = {
  default: 8,
  high: 16,
  ultra: 32,
} as const;

export type SandboxCpuTier = 'default' | 'high' | 'ultra';

export const SANDBOX_CPU_TIER_VALUES: Record<SandboxCpuTier, number> = {
  default: 2,
  high: 4,
  ultra: 8,
} as const;

export type SandboxTierByResource = {
  cpu: SandboxCpuTier;
  memory: SandboxMemoryTier;
};

export function sandboxTierResources(tiers: SandboxTierByResource) {
  return { cpus: SANDBOX_CPU_TIER_VALUES[tiers.cpu], memoryMb: SANDBOX_MEMORY_TIER_VALUES[tiers.memory] * 1024 };
}

export type SandboxResources = ReturnType<typeof sandboxTierResources>;

export const WORKSPACE_SIZES = ['small', 'large', 'ultra'] as const;

export type WorkspaceSize = (typeof WORKSPACE_SIZES)[number];

export const DEFAULT_WORKSPACE_SIZE: WorkspaceSize = 'small';

export const WORKSPACE_SIZE_LABELS: Record<WorkspaceSizeOption, string> = {
  small: '2 vCPU, 8 GB memory',
  large: '4 vCPU, 16 GB memory',
  ultra: '8 vCPU, 32 GB memory',
  auto: 'Starts small, resizes with load',
} as const;

export const WORKSPACE_SIZE_TIERS: Record<WorkspaceSize, SandboxTierByResource> = {
  small: { cpu: 'default', memory: 'default' },
  large: { cpu: 'high', memory: 'high' },
  ultra: { cpu: 'ultra', memory: 'ultra' },
} as const;

// Billing charges by size, so a sandbox whose CPU and memory grew apart bills as the size covering its memory,
// counting CPU one size later: Auto's 4 vCPU floor is ours to pay for.
export function creditWorkspaceSize({ cpus, memoryMb }: SandboxResources): WorkspaceSize {
  const cpuLevel = cpus <= 4 ? 0 : cpus <= 8 ? 1 : 2;
  const memoryLevel = WORKSPACE_SIZES.findIndex((size) => memoryMb <= sandboxTierResources(WORKSPACE_SIZE_TIERS[size]).memoryMb);
  return WORKSPACE_SIZES[Math.max(cpuLevel, memoryLevel === -1 ? WORKSPACE_SIZES.length - 1 : memoryLevel)];
}

export function isWorkspaceSize(value: unknown): value is WorkspaceSize {
  return WORKSPACE_SIZES.some((size) => size === value);
}

export const AUTO_WORKSPACE_SIZE = 'auto';

export const WORKSPACE_SIZE_OPTIONS = [...WORKSPACE_SIZES, AUTO_WORKSPACE_SIZE] as const;
export type WorkspaceSizeOption = (typeof WORKSPACE_SIZE_OPTIONS)[number];

export const DEFAULT_AUTOMATION_WORKSPACE_SIZE: WorkspaceSizeOption = AUTO_WORKSPACE_SIZE;

export function isWorkspaceSizeOption(value: unknown): value is WorkspaceSizeOption {
  return WORKSPACE_SIZE_OPTIONS.some((size) => size === value);
}

export function startingWorkspaceSize(size: WorkspaceSizeOption): WorkspaceSize {
  return size === AUTO_WORKSPACE_SIZE ? WORKSPACE_SIZES[0] : size;
}

export const AUTO_SIZE_RULES = {
  GROW_MEMORY_FRACTION: 0.75,
  GROW_MEMORY_PRESSURE: 20,
  SPIKE_INTERVAL_MS: 10_000,
  GROW_CPU_FRACTION: 0.9,
  GROW_CPU_MINUTES: 2,
  // A CPU-starved engine can stop reporting, so a pegged minute followed by this long without a newer one also grows.
  GROW_SILENT_MINUTES: 2,
  SHRINK_FRACTION: 0.5,
  SHRINK_QUIET_MINUTES: 10,
} as const;

// Idle vCPUs bill at 20% of allocation, so a 4 vCPU floor costs little; memory bills in full, so it grows on its own.
export const AUTO_CPU_FLOOR_RULES = {
  CPUS: [4, 8],
  MEMORY_GB: [8, 16, 32, 64],
  GROW_CPU_MINUTES: 1,
  // Tensorlake allows at most 8 GB of memory per vCPU.
  MAX_MEMORY_GB_PER_CPU: 8,
} as const;

export const AUTO_CPU_FLOOR_TIERS: SandboxTierByResource = { cpu: 'high', memory: 'default' };

// Stalls only count once memory is half used, so a cache-heavy workspace that shrinks below half doesn't grow straight back.
export function needsMoreMemory(usedMb: number, totalMb: number, pressureSome: number | null): boolean {
  return usedMb >= totalMb * AUTO_SIZE_RULES.GROW_MEMORY_FRACTION
    || ((pressureSome ?? 0) >= AUTO_SIZE_RULES.GROW_MEMORY_PRESSURE && usedMb >= totalMb * AUTO_SIZE_RULES.SHRINK_FRACTION);
}

export const INVALID_WORKSPACE_SIZE_ERROR = `Invalid size: must be one of ${WORKSPACE_SIZES.join(', ')}`;

export function validateOptionalWorkspaceSize(
  value: unknown,
): Result<WorkspaceSize | undefined> {
  if (value === undefined || value === null) return createSuccessResult(undefined);
  if (!isWorkspaceSize(value)) return createErrorResult({ message: INVALID_WORKSPACE_SIZE_ERROR });
  return createSuccessResult(value);
}

// Collapsing the start of the file needs no free space, so this works on a full disk while append-mode writers continue.
export function trimLogTailCommand(file: string, maxBytes: number, keepBytes: number): string {
  return `size=$(stat -c %s ${file} 2>/dev/null || echo 0); [ "$size" -gt ${maxBytes} ] && { fallocate --collapse-range --offset 0 --length $(( (size - ${keepBytes}) / 4096 * 4096 )) ${file} 2>/dev/null || truncate -s 0 ${file}; }`;
}
