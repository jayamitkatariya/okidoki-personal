import { createConcurrencyLimit, MAX_CANVAS_FILE_BYTES } from '@okidoki/shared';
import { canvasService, type CanvasItemFile } from './canvas-service';
import { monolithRequest } from './monolith-service';

interface ReconcileCanvasItemsResponse {
  deleted: number;
  skipped?: string;
}

interface CanvasFlushResult {
  flushed: number;
  skipped: number;
  failed: number;
  deleted: number;
}

const CANVAS_REQUEST_TIMEOUT_MS = 20_000;
const MIN_CANVAS_UPLOAD_BYTES_PER_SECOND = 256 * 1024;
const uploadedCanvasItems = new Map<string, { sizeBytes: number; updatedAt: string }>();
const withCanvasUploadSlot = createConcurrencyLimit(2);
let canvasFlushQueue = Promise.resolve();

function isReconcileCanvasItemsResponse(value: unknown): value is ReconcileCanvasItemsResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'deleted' in value &&
    typeof value.deleted === 'number' &&
    (!('skipped' in value) || typeof value.skipped === 'string')
  );
}

export function flushAllCanvasItems(): Promise<CanvasFlushResult> {
  const flush = canvasFlushQueue.then(flushCanvasItems);
  canvasFlushQueue = flush.then(() => undefined, () => undefined);
  return flush;
}

async function flushCanvasItems(): Promise<CanvasFlushResult> {
  let flushed = 0;
  let skipped = 0;
  let failed = 0;
  let deleted = 0;
  const filenames: string[] = [];
  const items = await canvasService.listItems();

  await Promise.all(items.map(async (item) => {
    if (item.sizeBytes > MAX_CANVAS_FILE_BYTES) {
      skipped++;
      return;
    }

    await withCanvasUploadSlot(async () => {
      try {
        const file = await canvasService.getItemFile(item.filename);
        if (!file?.bytes || file.tooLarge) {
          skipped++;
          return;
        }

        const uploaded = uploadedCanvasItems.get(file.filename);
        if (uploaded?.sizeBytes === file.sizeBytes && uploaded.updatedAt === file.updatedAt) {
          filenames.push(file.filename);
          skipped++;
          return;
        }

        await uploadCanvasItem(file);
        uploadedCanvasItems.set(file.filename, { sizeBytes: file.sizeBytes, updatedAt: file.updatedAt });
        filenames.push(file.filename);
        flushed++;
      } catch (err) {
        failed++;
        console.error('[CanvasUploader] upload failed:', { filename: item.filename, err });
      }
    });
  }));

  if (failed === 0) {
    try {
      deleted = await reconcileCanvasItems(filenames);
      const currentFilenames = new Set(filenames);
      for (const filename of uploadedCanvasItems.keys()) {
        if (!currentFilenames.has(filename)) uploadedCanvasItems.delete(filename);
      }
    } catch (err) {
      failed++;
      console.error('[CanvasUploader] reconcile failed:', err);
    }
  }

  return { flushed, skipped, failed, deleted };
}

export async function uploadCanvasItem(item: CanvasItemFile): Promise<void> {
  if (!item.bytes || item.tooLarge) return;

  const form = new FormData();
  form.append('filename', item.filename);
  form.append('updated_at', item.updatedAt);
  form.append(
    'file',
    new Blob([Uint8Array.from(item.bytes)], { type: item.mimeType }),
    item.filename,
  );

  const response = await monolithRequest('/v1/engine/canvas', {
    body: form,
    signal: AbortSignal.timeout(
      CANVAS_REQUEST_TIMEOUT_MS
      + Math.ceil(item.sizeBytes / MIN_CANVAS_UPLOAD_BYTES_PER_SECOND) * 1000,
    ),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`upload failed: ${response.status} ${errorText}`);
  }
}

async function reconcileCanvasItems(filenames: string[]): Promise<number> {
  const response = await monolithRequest('/v1/engine/canvas/reconcile', {
    body: { filenames },
    signal: AbortSignal.timeout(CANVAS_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`reconcile failed: ${response.status} ${errorText}`);
  }
  const data = await response.json();
  if (!isReconcileCanvasItemsResponse(data)) {
    throw new Error('Invalid response from reconcile endpoint');
  }
  return data.deleted;
}
