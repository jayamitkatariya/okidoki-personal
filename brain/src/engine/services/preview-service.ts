import { mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { type PreviewPort, type ListPreviewsResponse } from '@okidoki/shared';
import { dirname, join } from 'path';
import { eventService } from './event-service';
import { atomicWriteFile } from '../utils/file';

const PREVIEW_PORTS_FILE = join(homedir(), '.okidoki', 'preview-ports.json');

async function readPreviewsFile(): Promise<ListPreviewsResponse> {
  try {
    if (!existsSync(PREVIEW_PORTS_FILE)) {
      return { previews: [] };
    }
    const raw = await readFile(PREVIEW_PORTS_FILE, 'utf-8');
    return JSON.parse(raw) as ListPreviewsResponse;
  } catch {
    return { previews: [] };
  }
}

async function writePreviewsFile(data: ListPreviewsResponse): Promise<void> {
  const dir = dirname(PREVIEW_PORTS_FILE);
  await mkdir(dir, { recursive: true });
  await atomicWriteFile(PREVIEW_PORTS_FILE, `${JSON.stringify(data, null, 2)}\n`);
}

class PreviewService {
  async initialize(): Promise<void> {
    await writePreviewsFile({ previews: [] });
  }

  async addPreview(port: number, publicUrl: string): Promise<PreviewPort> {
    const data = await readPreviewsFile();

    const existing = data.previews.find((p) => p.port === port);
    if (existing) {
      throw new Error(`Preview already exists for port ${port}`);
    }

    const preview: PreviewPort = {
      port,
      publicUrl,
      createdAt: new Date().toISOString(),
    };

    data.previews.push(preview);
    await writePreviewsFile(data);

    eventService.publish({
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: 'preview.changed',
      payload: { previews: data.previews },
    });

    return preview;
  }

  async listPreviews(): Promise<PreviewPort[]> {
    const data = await readPreviewsFile();
    return data.previews;
  }

  async removePreview(port: number): Promise<boolean> {
    const data = await readPreviewsFile();
    const before = data.previews.length;
    data.previews = data.previews.filter((p) => p.port !== port);
    if (data.previews.length === before) {
      return false;
    }

    await writePreviewsFile(data);

    eventService.publish({
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: 'preview.changed',
      payload: { previews: data.previews },
    });

    return true;
  }
}

export const previewService = new PreviewService();
