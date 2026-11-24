import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { UserMessageImage } from './engine/v1';

const hashes = new WeakMap<object, string>();

export function userMessageImageHash(image: Pick<UserMessageImage, 'data' | 'dataHash'>, cacheKey: object = image): string | undefined {
  if (!image.data) return image.dataHash;
  let hash = hashes.get(cacheKey);
  if (hash === undefined) {
    hash = bytesToHex(sha256(new TextEncoder().encode(image.data)));
    hashes.set(cacheKey, hash);
  }
  return hash;
}
