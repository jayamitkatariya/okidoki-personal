/**
 * Image utilities for processing multimodal inputs.
 * Handles fetching URL images and converting them to base64.
 */

import {
  IMAGE_MEDIA_TYPES,
  KEEP_IMAGE_UNDER_BYTES,
  shrunkImageSize,
  SHRUNK_IMAGE_QUALITY,
  type Base64ImageSource,
  type ImageContent,
  type ImageMediaType,
} from '@okidoki/shared';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { MessageChannel, Worker } from 'node:worker_threads';
import { monolithRequest } from '../services/monolith-service';

function isImageMediaType(value: string): value is ImageMediaType {
  return IMAGE_MEDIA_TYPES.includes(value as ImageMediaType);
}

/**
 * Normalized image with base64 data ready for SDK consumption.
 */
interface NormalizedImage {
  type: 'image';
  source: Base64ImageSource;
  label?: string;
}

/**
 * Infer media type from URL or content-type header.
 */
export function inferMediaType(url: string, contentType?: string | null): ImageMediaType {
  // Try content-type header first
  if (contentType) {
    const normalized = contentType.toLowerCase().split(';')[0].trim();
    if (isImageMediaType(normalized)) {
      return normalized;
    }
    // Handle common variations
    if (normalized === 'image/jpg') {
      return 'image/jpeg';
    }
  }

  // Fall back to URL extension
  const urlLower = url.toLowerCase();
  if (urlLower.includes('.png')) return 'image/png';
  if (urlLower.includes('.jpg') || urlLower.includes('.jpeg')) return 'image/jpeg';
  if (urlLower.includes('.gif')) return 'image/gif';
  if (urlLower.includes('.webp')) return 'image/webp';

  // Default to jpeg if we can't determine
  return 'image/jpeg';
}

/**
 * Fetch an image from a URL and convert it to base64.
 */
async function fetchImageAsBase64(url: string): Promise<Base64ImageSource> {
  const hostname = new URL(url).hostname;
  const provider = hostname === 'uploads.linear.app' ? 'linear' : hostname === 'files.slack.com' ? 'slack' : null;
  // Bounds the body read too, so a host that never finishes can't hold up the chat.
  const signal = AbortSignal.timeout(30_000);
  const response = provider
    ? await monolithRequest(`/v1/engine/${provider}/download`, { body: { url }, signal })
    : await fetch(url, { redirect: 'follow', signal });

  if (!response.ok) {
    throw new Error(`Failed to fetch image from ${url}: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type');

  // Validate that the response is actually image data
  if (contentType) {
    const normalizedContentType = contentType.toLowerCase().split(';')[0].trim();
    if (!normalizedContentType.startsWith('image/')) {
      throw new Error(
        `Expected image content from ${url} but received Content-Type: ${normalizedContentType}. ` +
        `This may indicate an authentication or redirect issue.`
      );
    }
  }

  return toModelImage(Buffer.from(await response.arrayBuffer()), inferMediaType(url, contentType));
}

// A 48MP iPhone photo; past this decoding would take hundreds of MB.
const MAX_HEIC_PIXELS = 50_000_000;
// libheif is WebAssembly and decodes synchronously, so it runs on its own thread instead of stalling the engine for seconds.
const HEIC_WORKER = `const { workerData: { decoder, buffer, port } } = require('node:worker_threads');
require(decoder)({ buffer }).then(({ width, height, data }) => port.postMessage({ width, height, data }, [data.buffer]));`;

function decodeHeic(buffer: Buffer): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  // Its own channel, because node --watch also posts to a worker's parentPort.
  const { port1, port2 } = new MessageChannel();
  return new Promise<{ width: number; height: number; data: Uint8ClampedArray }>((resolve, reject) => {
    const worker = new Worker(HEIC_WORKER, { eval: true, workerData: { decoder: createRequire(import.meta.url).resolve('heic-decode'), buffer, port: port2 }, transferList: [port2] });
    port1.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => reject(new Error(`HEIC decoder exited (${code})`)));
  }).finally(() => port1.close());
}

async function toModelImage(content: Buffer, fallbackType: ImageMediaType): Promise<Base64ImageSource> {
  const passthrough: Base64ImageSource = { type: 'base64', media_type: fallbackType, data: content.toString('base64') };
  // sharp is native; if it can't load on this sandbox, images still go through as they are.
  const sharp = await import('sharp').then((module) => module.default).catch(() => null);
  if (!sharp) return passthrough;
  const metadata = await sharp(content).metadata().catch(() => null);
  if (!metadata) throw new Error('not an image the model can read');
  const mediaType = IMAGE_MEDIA_TYPES.find((type) => type === `image/${metadata.format}`);
  const size = metadata.width && metadata.height ? shrunkImageSize(metadata.width, metadata.height) : null;
  if (mediaType && !size && (metadata.orientation ?? 1) === 1 && (content.byteLength < KEEP_IMAGE_UNDER_BYTES || mediaType === 'image/gif')) {
    return { ...passthrough, media_type: mediaType };
  }
  // sharp's prebuilt libvips only decodes AVIF, so an iPhone's HEVC photo goes through libheif.
  const hevc = metadata.format === 'heif' && metadata.compression === 'hevc';
  if (hevc && metadata.width * metadata.height > MAX_HEIC_PIXELS) throw new Error(`HEIC image is over ${MAX_HEIC_PIXELS / 1_000_000}MP`);
  const heic = hevc ? await decodeHeic(content) : null;
  const image = heic ? sharp(heic.data, { raw: { width: heic.width, height: heic.height, channels: 4 } }) : sharp(content).autoOrient();
  const { width, height } = heic ?? metadata.autoOrient;
  const target = shrunkImageSize(width, height);
  const data = await (target ? image.resize(target.width, target.height) : image).webp({ quality: SHRUNK_IMAGE_QUALITY * 100 }).toBuffer();
  return { type: 'base64', media_type: 'image/webp', data: data.toString('base64') };
}

/**
 * Normalize an array of images to base64 format.
 * URL images are fetched and converted to base64.
 * Base64 images are passed through as-is.
 */
export async function normalizeImages(images: ImageContent[]): Promise<NormalizedImage[]> {
  const normalized: NormalizedImage[] = [];

  for (const image of images) {
    if (image.source.type === 'base64') {
      // Already base64, pass through
      normalized.push({
        type: 'image',
        source: image.source,
        label: image.label,
      });
    } else if (image.source.type === 'url') {
      // Fetch and convert to base64
      const base64Source = await fetchImageAsBase64(image.source.url);
      normalized.push({
        type: 'image',
        source: base64Source,
        label: image.label,
      });
    }
  }

  return normalized;
}

export async function saveNormalizedImagesToTempFiles(
  images: NormalizedImage[],
  tempImageDir = join(homedir(), '.okidoki', 'codex', 'temp-images'),
): Promise<string[]> {
  await mkdir(tempImageDir, { recursive: true });
  const tempPaths: string[] = [];

  try {
    for (const image of images) {
      const ext = image.source.media_type.split('/')[1] || 'png';
      const filename = `img_${randomUUID()}.${ext}`;
      const filepath = join(tempImageDir, filename);

      await writeFile(filepath, Buffer.from(image.source.data, 'base64'));
      tempPaths.push(filepath);
    }
  } catch (error) {
    await removeTempImageFiles(tempPaths);
    throw error;
  }

  return tempPaths;
}

export async function removeTempImageFiles(paths: string[]): Promise<void> {
  await Promise.allSettled(paths.map((path) => unlink(path)));
}
