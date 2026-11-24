import { z } from 'zod';

export const COMPUTE_SANDBOX_KINDS = ['gpu', 'macos'] as const;
export type ComputeSandboxKind = (typeof COMPUTE_SANDBOX_KINDS)[number];

export const COMPUTE_SANDBOX_STATUSES = ['creating', 'running', 'terminated'] as const;
export type ComputeSandboxStatus = (typeof COMPUTE_SANDBOX_STATUSES)[number];

export const GPU_TYPES = ['T4', 'L4', 'A10G', 'L40S', 'A100', 'A100-80GB', 'H100', 'H200', 'B200'] as const;
export const DEFAULT_GPU_TYPE = 'L4';
export const DEFAULT_GPU_IMAGE = 'pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime';
export const COMPUTE_SANDBOX_WORKDIRS: Record<ComputeSandboxKind, string> = { gpu: '/workspace', macos: '/Users/computer/workspace' };
export const COMPUTE_SANDBOX_LABELS: Record<ComputeSandboxKind, string> = { gpu: 'GPU sandbox', macos: 'macOS sandbox' };
// Revyl stops every Mac two hours after it starts: https://docs.revyl.com/computers.md#limits
export const MACOS_SANDBOX_MAX_TIMEOUT_MINUTES = 120;

export const COMPUTE_SANDBOX_LIMITS = {
  maxActivePerWorkspace: 3,
  maxActivePerOrganization: 10,
  maxGpuCount: 8,
  maxPorts: 5,
  defaultTimeoutMinutes: 60,
  maxTimeoutMinutes: 24 * 60,
  defaultIdleTimeoutMinutes: 10,
  maxIdleTimeoutMinutes: 60,
  maxTransferBytes: 1024 ** 3,
} as const;

export interface ComputeSandboxTunnel {
  port: number;
  url: string;
}

export interface ComputeSandbox {
  id: string;
  kind: ComputeSandboxKind;
  status: ComputeSandboxStatus;
  gpu: string | null;
  image: string;
  createdAt: string;
  expiresAt: string;
  terminatedAt: string | null;
  error: string | null;
  tunnels: ComputeSandboxTunnel[];
}

const computeEnvSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128), z.string().max(32_768))
  .refine((env) => Object.keys(env).length <= 64, 'At most 64 environment variables are allowed');

export const createComputeSandboxRequestSchema = z.object({
  kind: z.enum(COMPUTE_SANDBOX_KINDS),
  gpu: z.string().trim().optional(),
  image: z.string().trim().min(1).max(256).regex(/^\S+$/, 'Image must not contain whitespace').optional(),
  timeoutMinutes: z.number().int().min(1).max(COMPUTE_SANDBOX_LIMITS.maxTimeoutMinutes).optional(),
  idleTimeoutMinutes: z.number().int().min(1).max(COMPUTE_SANDBOX_LIMITS.maxIdleTimeoutMinutes).optional(),
  ports: z.array(z.number().int().min(1).max(65535)).max(COMPUTE_SANDBOX_LIMITS.maxPorts).optional(),
  env: computeEnvSchema.optional(),
});
export type CreateComputeSandboxRequest = z.infer<typeof createComputeSandboxRequestSchema>;

export interface ComputeSandboxResponse {
  sandbox: ComputeSandbox;
}

export interface ListComputeSandboxesResponse {
  sandboxes: ComputeSandbox[];
}

export const computeExecRequestSchema = z.object({
  command: z.string().min(1).max(100_000),
  workdir: z.string().min(1).max(4096).optional(),
  env: computeEnvSchema.optional(),
  detach: z.boolean().optional(),
});
export type ComputeExecRequest = z.infer<typeof computeExecRequestSchema>;

export const computeUploadRequestSchema = z.object({
  size: z.number().int().min(1).max(COMPUTE_SANDBOX_LIMITS.maxTransferBytes),
});

export interface ComputeUploadResponse {
  uploadId: string;
  uploadUrl: string;
}

export const computeTransferPathSchema = z.object({
  path: z.string().min(1).max(4096).optional(),
});

export interface ComputeDownloadResponse {
  downloadUrl: string;
}

export interface ComputeDetachedJobResponse {
  jobId: string;
}

export type ComputeOutputEvent =
  | { type: 'stdout' | 'stderr'; data: string }
  | { type: 'heartbeat' }
  | { type: 'exit'; exitCode: number | null }
  | { type: 'error'; message: string };
