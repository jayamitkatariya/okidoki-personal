import { readdir, readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import {
  classifyCanvasFilename,
  MAX_CANVAS_FILE_BYTES,
  MAX_CANVAS_PREVIEW_BYTES,
  isCanvasTextKind,
  sanitizeCanvasFilename,
  serializeCanvasContentResponse,
  type CanvasContentResponse,
  type CanvasItem,
  type CanvasItemKind,
  type UpdateTextFileResponse,
} from '@okidoki/shared';
import { gitService } from '../git/service';
import { AsyncLock } from '../utils/async-lock';
import { resolveContainedFile } from '../utils/contained-file';
import { fileRevision } from '../utils/file-revision';
import { writeRevisionedTextFile } from '../utils/revisioned-text-file';

const GLOBAL_CANVAS_DIRECTORIES = [
  join(homedir(), '.claude', 'plans'),
  join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode', 'plans'),
  join(homedir(), '.okidoki', 'canvas'),
];

export async function canvasDirectories(
  repositories?: readonly { path: string }[],
): Promise<string[]> {
  repositories ??= await gitService.listRepositories().catch(() => []);

  return [
    ...GLOBAL_CANVAS_DIRECTORIES,
    ...repositories.map((repository) => join(repository.path, '.opencode', 'plans')),
  ];
}

export interface CanvasItemFile {
  filename: string;
  kind: CanvasItemKind;
  sizeBytes: number;
  mimeType: string;
  updatedAt: string;
  bytes?: Uint8Array;
  tooLarge?: boolean;
}

export class CanvasService {
  private readonly writeLock = new AsyncLock();

  constructor(private readonly directories: () => Promise<string[]> = () => canvasDirectories()) {}

  async listItems(): Promise<CanvasItem[]> {
    const items = new Map<string, CanvasItem>();

    for (const directory of await this.directories()) {
      const pending = [{ directory, relativePath: '' }];

      while (pending.length > 0) {
        const current = pending.pop();
        if (!current) continue;

        let entries;
        try {
          entries = await readdir(current.directory, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const filename = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name;
          const filePath = join(current.directory, entry.name);
          if (entry.isDirectory()) {
            pending.push({ directory: filePath, relativePath: filename });
            continue;
          }
          if (!entry.isFile() || items.has(filename)) continue;

          const { kind } = classifyCanvasFilename(filename);
          let sizeBytes = 0;
          try {
            const s = await stat(filePath);
            sizeBytes = s.size;
          } catch {
            continue;
          }
          items.set(filename, { filename, kind, sizeBytes });
        }
      }
    }

    return Array.from(items.values()).sort((a, b) => a.filename.localeCompare(b.filename));
  }

  async locateItem(filename: string) {
    const safe = sanitizeCanvasFilename(filename);
    if (!safe) return null;

    for (const directory of await this.directories()) {
      const path = join(directory, safe);
      const stats = await stat(path).catch(() => null);
      if (stats?.isFile()) {
        return {
          filename: safe,
          path,
          sizeBytes: stats.size,
          updatedAt: stats.mtime.toISOString(),
          ...classifyCanvasFilename(safe),
        };
      }
    }

    return null;
  }

  async getItemFile(filename: string, maxBytes = MAX_CANVAS_FILE_BYTES): Promise<CanvasItemFile | null> {
    const item = await this.locateItem(filename);
    if (!item) return null;

    const { path, ...file } = item;
    if (file.sizeBytes > maxBytes) return { ...file, tooLarge: true };

    const bytes = await readFile(path).catch(() => null);
    return bytes ? { ...file, bytes } : null;
  }

  async getItem(filename: string): Promise<CanvasContentResponse | null> {
    const item = await this.getItemFile(filename, MAX_CANVAS_PREVIEW_BYTES);
    if (!item) return null;
    if (item.tooLarge || !item.bytes) {
      return {
        filename: item.filename,
        kind: item.kind,
        sizeBytes: item.sizeBytes,
        mimeType: item.mimeType,
        tooLarge: true,
      };
    }

    return serializeCanvasContentResponse({
      filename: item.filename,
      kind: item.kind,
      sizeBytes: item.sizeBytes,
      mimeType: item.mimeType,
      bytes: item.bytes,
      revision: fileRevision(item.bytes),
    });
  }

  async updateItem(
    filename: string,
    content: string,
    expectedRevision: string,
  ): Promise<UpdateTextFileResponse | null> {
    const safe = sanitizeCanvasFilename(filename);
    if (
      !safe ||
      !isCanvasTextKind(classifyCanvasFilename(safe).kind) ||
      Buffer.byteLength(content) > MAX_CANVAS_PREVIEW_BYTES
    ) return null;

    return this.writeLock.run(async () => {
      for (const directory of await this.directories()) {
        const file = await resolveContainedFile(directory, safe);
        if (file) return await writeRevisionedTextFile(file.fullPath, content, expectedRevision);
      }
      return null;
    });
  }
}

export const canvasService = new CanvasService();
