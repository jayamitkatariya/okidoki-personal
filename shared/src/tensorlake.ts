/** Tensorlake sizes CPU, memory and disk when a sandbox is created, so one image serves every workspace size. */
export const TENSORLAKE_IMAGE_NAME = 'okidoki-sandbox-2026-11-24-v7205';

/** The image's root disk and Tensorlake's maximum, so a create never has to grow it. */
export const TENSORLAKE_DISK_MB = 100 * 1024;
