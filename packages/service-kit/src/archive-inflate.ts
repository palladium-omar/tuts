import { createInflateRaw } from 'node:zlib';

/** Expand one ZIP entry with a bound on actual output, in Node and Workers.
 * Do not use inflateRawSync(maxOutputLength): Workers can reject valid entries
 * at that limit. Streaming also lets us stop a dishonest archive before ExcelJS
 * expands it. ZIP structure and the archive-wide limits belong to the caller.
 */
export async function inflateArchiveEntry(bytes: Buffer, expectedLength: number): Promise<Buffer> {
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0 || expectedLength > 20 * 1024 * 1024)
    throw new RangeError('Invalid archive entry expansion limit');
  const inflater = createInflateRaw({ chunkSize: 16 * 1024 });
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    inflater.end(bytes);
    for await (const chunk of inflater) {
      length += chunk.length;
      if (length > expectedLength) throw new RangeError('Archive entry exceeds declared size');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  } finally {
    inflater.destroy();
  }
}
