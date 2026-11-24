import { readFile } from 'fs/promises';
import type { UpdateTextFileResponse } from '@okidoki/shared';
import { atomicWriteFile } from './file';
import { fileRevision } from './file-revision';

export async function writeRevisionedTextFile(
  filePath: string,
  content: string,
  expectedRevision: string,
): Promise<UpdateTextFileResponse> {
  const current = await readFile(filePath, 'utf8');
  const revision = fileRevision(current);
  if (revision !== expectedRevision) {
    return {
      saved: false,
      current: { content: current, revision, sizeBytes: Buffer.byteLength(current) },
    };
  }

  await atomicWriteFile(filePath, content);
  return { saved: true, revision: fileRevision(content), sizeBytes: Buffer.byteLength(content) };
}
