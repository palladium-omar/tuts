import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import gateway, { type GatewayEnv } from './worker.js';
/** Node and Workers share origin, route, size and authorization checks. */
export function createNodeGateway(env: GatewayEnv) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const abort = new AbortController();
    req.on('aborted', () => abort.abort());
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) { res.writeHead(404, { 'cache-control':'private, no-store' }); res.end(); return; }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (name.startsWith('cf-') || value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
      }
      headers.set('cf-connecting-ip', req.socket.remoteAddress ?? 'unknown');
      const body = !['GET', 'HEAD'].includes(req.method ?? 'GET') ? Readable.toWeb(req) as ReadableStream<Uint8Array> : undefined;
      const request = new Request(new URL(req.url ?? '/', env.PUBLIC_GATEWAY_URL), {
        method: req.method, headers, signal: abort.signal,
        ...(body ? { body, duplex: 'half' } : {}),
      });
      const response = await gateway.fetch(request, env);
      res.statusCode = response.status;
      for (const [name, value] of response.headers) if (name !== 'set-cookie') res.setHeader(name, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader('set-cookie', cookies);
      if (response.body && req.method !== 'HEAD') await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res);
      else res.end();
    } catch {
      if (!res.headersSent) {
        res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'private, no-store' });
        res.end(JSON.stringify({ error: { code: 'service_unavailable', message: 'Gateway is unavailable' } }));
      } else res.destroy();
    }
  };
}
