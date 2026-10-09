import { timingSafeEqual } from 'node:crypto';
import { httpServerHandler } from 'cloudflare:node';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createServiceApplication } from './index.js';
import { EventBus } from './events.js';
import type { ServiceOptions } from './auth.js';
import { withCloudflareInvocation, type CloudflareBindings } from './runtime.js';
import { diagnosticId, logDiagnostic, withDiagnostics } from './diagnostics.js';

export interface WorkerServiceOptions extends Omit<ServiceOptions, 'migrationsDir'> {
  migrationsDir?: string;
  scheduled?: (app: NestExpressApplication) => Promise<void>;
}
export interface QueueMessage {
  body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}
export interface QueueBatch { messages: QueueMessage[]; }

function configureEnvironment(bindings: CloudflareBindings): void {
  // Node compatibility populates process.env in deployed Workers. Also initialize
  // explicitly for local Worker emulation before providers read configuration.
  for (const [key, value] of Object.entries(bindings)) {
    if (typeof value === 'string') process.env[key] = value;
  }
  Object.assign(process.env, { TUTS_RUNTIME: 'cloudflare', NODE_ENV: 'production' });
}
function authorizedTick(request: Request, bindings: CloudflareBindings): boolean {
  const secret = bindings.INTERNAL_RUNTIME_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get('authorization') ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createWorkerService(options: WorkerServiceOptions) {
  let initialized: Promise<{ app: NestExpressApplication; bridge: ReturnType<typeof httpServerHandler> }> | undefined;
  async function application(bindings: CloudflareBindings) {
    configureEnvironment(bindings);
    if (!initialized) {
      initialized = (async () => {
        const app = await createServiceApplication({ ...options, migrationsDir: options.migrationsDir ?? '' }, false);
        // Cloudflare uses this number as a routing key, not a network socket.
        await app.listen(options.port);
        await app.get(EventBus).start();
        return { app, bridge: httpServerHandler({ port: options.port }) };
      })();
      initialized.catch(() => { initialized = undefined; });
    }
    return initialized;
  }
  return {
    async fetch(request: Request, bindings: CloudflareBindings, context?: unknown): Promise<Response> {
      const backgroundContext = context && typeof context === 'object' &&
        'waitUntil' in context && typeof context.waitUntil === 'function'
        ? { waitUntil: context.waitUntil.bind(context) as (promise: Promise<unknown>) => void }
        : undefined;
      const requestId = diagnosticId(request.headers.get('x-request-id'));
      const tickRequest = new URL(request.url).pathname === '/__runtime/tick';
      return withDiagnostics({ service: options.name, requestId, trigger: tickRequest ? 'scheduled' : 'http' }, async () => {
      const started = Date.now();
      let status = 500;
      try {
      const result = await withCloudflareInvocation(bindings, async () => {
        const tick = new URL(request.url).pathname === '/__runtime/tick';
        if (tick && (request.method !== 'POST' || !authorizedTick(request, bindings))) {
          return new Response('Unauthorized', { status: 401 });
        }
        const { app, bridge } = await application(bindings);
        const events = app.get(EventBus);
        if (tick) {
          await options.scheduled?.(app);
          await events.flushOutbox();
          return Response.json({ status: 'ok' });
        }
        const response = await bridge.fetch(request, bindings, context);
        // The bridge may return headers before the Node response body finishes.
        // Keep database scope alive until every controller has completed its work.
        const body = response.body ? await response.arrayBuffer() : null;
        if (response.status < 400) {
          try { await events.flushOutbox(); }
          catch (error) { logDiagnostic('warn', 'outbox_deferred', { error }); }
        }
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      }, tickRequest ? undefined : backgroundContext);
      status = result.status;
      const headers = new Headers(result.headers);
      headers.set('x-request-id', requestId);
      return new Response(result.body, { status, statusText: result.statusText, headers });
      } catch (error) {
        logDiagnostic('error', tickRequest ? 'tick_failed' : 'request_failed', { error });
        // Cloudflare also records uncaught exceptions: never rethrow raw SQL or provider text.
        throw new Error('Tuts service invocation failed; consult structured diagnostics');
      } finally {
        logDiagnostic(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'request_completed', { status, method: request.method, route: new URL(request.url).pathname, durationMs: Date.now() - started });
      }
      });
    },
    async queue(batch: QueueBatch, bindings: CloudflareBindings): Promise<void> {
      await withDiagnostics({ service: options.name, requestId: diagnosticId(), trigger: 'queue' }, async () => {
      try { await withCloudflareInvocation(bindings, async () => {
        const { app } = await application(bindings);
        const events = app.get(EventBus);
        for (const message of batch.messages) {
          try {
            await events.consumeEvent(message.body);
            await events.flushOutbox();
            message.ack();
          } catch (error) {
            logDiagnostic('warn', 'queue_retry', { error });
            message.retry({ delaySeconds: 30 });
          }
        }
      }); } catch (error) {
        logDiagnostic('error', 'queue_failed', { error });
        throw new Error('Tuts queue invocation failed; consult structured diagnostics');
      }
      });
    },
  };
}
