function parseSseChunk<T = unknown>(chunk: string): T | null {
  let data = '';
  for (const line of chunk.split('\n')) {
    if (line.startsWith('data: ')) {
      data += line.slice(6);
    }
  }
  if (!data) return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

export async function* iterateSseStream<T>(
  body: ReadableStream<Uint8Array>,
  onChunk?: () => void,
): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // A large event arrives over many reads; rescanning the whole buffer on each one is quadratic.
  let searchFrom = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk?.();

    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf('\n\n', searchFrom);
    while (end >= 0) {
      const event = parseSseChunk<T>(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (event) yield event;
      end = buffer.indexOf('\n\n');
    }
    searchFrom = Math.max(0, buffer.length - 1);
  }
}

export async function readSseStream<T>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: T) => void | Promise<void>,
  shouldContinue: () => boolean = () => true,
  onChunk?: () => void,
): Promise<void> {
  if (!shouldContinue()) return;
  for await (const event of iterateSseStream<T>(body, onChunk)) {
    if (!shouldContinue()) break;
    await onEvent(event);
  }
}
