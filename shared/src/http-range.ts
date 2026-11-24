interface ByteRange {
  start: number;
  end: number;
}

// Malformed and multi-range headers are ignored (full 200), as RFC 9110 §14.2 allows.
function parseByteRange(header: string | null | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return null;
  const [, first, last] = match;
  if (!first) {
    const suffix = Number(last);
    return suffix > 0 && size > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : 'unsatisfiable';
  }
  const start = Number(first);
  const end = last ? Math.min(Number(last), size - 1) : size - 1;
  if (last && Number(last) < start) return null;
  return start < size ? { start, end } : 'unsatisfiable';
}

export async function byteRangeResponse(input: {
  rangeHeader: string | null | undefined;
  size: number;
  contentType: string;
  body: (start: number, endExclusive: number) => BodyInit | Promise<BodyInit>;
  headers?: Record<string, string>;
}): Promise<Response> {
  const range = parseByteRange(input.rangeHeader, input.size);
  const headers = { ...input.headers, 'Content-Type': input.contentType, 'Accept-Ranges': 'bytes' };
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${input.size}` } });
  }
  const { start, end } = range ?? { start: 0, end: input.size - 1 };
  return new Response(end >= start ? await input.body(start, end + 1) : null, {
    status: range ? 206 : 200,
    headers: {
      ...headers,
      'Content-Length': String(end + 1 - start),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${input.size}` } : {}),
    },
  });
}
