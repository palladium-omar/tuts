// Includes multipart overhead above the domain-owned upload caps. JSON parsers
// impose their lower 8 MiB limit. Responses retain controller completion before
// invocation cleanup without the unbounded arrayBuffer bridge allocation.
export const MAX_BRIDGE_REQUEST_BYTES = 32 * 1024 * 1024;
export const MAX_BRIDGE_RESPONSE_BYTES = 64 * 1024 * 1024;
export class RequestBodyLimitError extends Error {}
export function shouldPublishMutation(method: string, status: number, service?: string, path?: string): boolean {
  const verb = method.toUpperCase();
  // Reporting uses POST for a bounded read-only ID/query batch. It must not
  // pay for unrelated publication merely because the query has a JSON body.
  if (service === 'reporting' && verb === 'POST' && /^\/v1\/summaries\/?$/.test((path ?? '').split('?')[0]!)) return false;
  return !['GET', 'HEAD', 'OPTIONS'].includes(verb) && status < 400;
}
export function boundedRequest(request: Request): Request {
  if (!request.body) return request;
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > MAX_BRIDGE_REQUEST_BYTES) throw new RequestBodyLimitError('Request body exceeds transport limit');
  let bytes = 0;
  const body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_BRIDGE_REQUEST_BYTES) throw new RequestBodyLimitError('Request body exceeds transport limit');
      controller.enqueue(chunk);
    },
  }));
  return new Request(request, { body, duplex: 'half' } as RequestInit);
}
export async function readBoundedResponse(response: Response, limit = MAX_BRIDGE_RESPONSE_BYTES): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new RangeError('Response body exceeds transport limit');
      }
      chunks.push(item.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body;
  } finally { reader.releaseLock(); }
}
