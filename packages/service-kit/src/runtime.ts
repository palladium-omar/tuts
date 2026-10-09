import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool } from 'pg';
import { currentDiagnosticId, logDiagnostic } from './diagnostics.js';

export type CloudflareBindings = Record<string, unknown>;
type Invocation = { bindings: CloudflareBindings; pools: Map<object, Pool>; backgroundTasks: Set<Promise<void>> };
type BackgroundContext = { waitUntil(promise: Promise<unknown>): void };
const invocation = new AsyncLocalStorage<Invocation>();
const nodeBackgroundTasks = new Set<Promise<void>>();

/** Keep asynchronous identity delivery alive after the HTTP response. */
export function registerBackgroundTask(promise: Promise<unknown>): void {
  const tasks = invocation.getStore()?.backgroundTasks ?? nodeBackgroundTasks;
  const retained = promise.then(() => {}, (error) => {
    logDiagnostic('error', 'background_failed', { error });
  });
  tasks.add(retained);
  void retained.then(() => { tasks.delete(retained); });
}

export function isCloudflareRuntime(): boolean {
  return Boolean(invocation.getStore()) || process.env.TUTS_RUNTIME === 'cloudflare';
}
export function currentCloudflareBindings(): CloudflareBindings | undefined {
  return invocation.getStore()?.bindings;
}

// Kept out of the Node bootstrap path. Every event owns and closes its sockets.
export async function withCloudflareInvocation<T>(bindings: CloudflareBindings, work: () => Promise<T>, context?: BackgroundContext): Promise<T> {
  return invocation.run({ bindings, pools: new Map(), backgroundTasks: new Set() }, async () => {
    const scope = invocation.getStore()!;
    try { return await work(); }
    finally {
      const cleanup = async () => {
        while (scope.backgroundTasks.size) await Promise.all([...scope.backgroundTasks]);
        await Promise.all([...scope.pools.values()].map(pool => pool.end()));
      };
      if (scope.backgroundTasks.size && context) {
        // Keep the invocation's sockets and service-binding work alive together.
        // Only explicitly registered tasks change response cleanup semantics.
        context.waitUntil(cleanup().catch((error) => {
          logDiagnostic('error', 'cleanup_failed', { error });
        }));
      } else await cleanup();
    }
  });
}

export function invocationPool(owner: object): Pool {
  const scope = invocation.getStore();
  if (!scope) throw new Error('Cloudflare database access requires an active invocation');
  let pool = scope.pools.get(owner);
  if (!pool) {
    const hyperdrive = scope.bindings.HYPERDRIVE as { connectionString?: string } | undefined;
    const connectionString = hyperdrive?.connectionString ?? scope.bindings.DATABASE_URL ?? process.env.DATABASE_URL;
    if (typeof connectionString !== 'string' || !connectionString) throw new Error('DATABASE_URL or HYPERDRIVE is required');
    pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000 });
    // Handle idle socket failures without leaking database details into logs.
    const invocationOwnedPool = pool;
    pool.on('error', (error) => {
      if (!invocationOwnedPool.ending) logDiagnostic('error', 'database_failed', { error });
    });
    scope.pools.set(owner, pool);
  }
  return pool;
}

export async function serviceFetch(serviceName: string, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const requestId = currentDiagnosticId();
  if (requestId) headers.set('x-request-id', requestId);
  init = { ...init, headers };
  if (!/^[a-z][a-z0-9_-]*$/i.test(serviceName) || !path.startsWith('/') || path.startsWith('//')) {
    throw new Error('Invalid internal service destination');
  }
  const name = serviceName.replace(/-/g, '_').toUpperCase();
  if (isCloudflareRuntime()) {
    const binding = currentCloudflareBindings()?.[name] as { fetch?: (request: Request) => Promise<Response> } | undefined;
    if (typeof binding?.fetch !== 'function') throw new Error(`Missing ${name} service binding`);
    return binding.fetch(new Request(`https://${serviceName}.internal${path}`, init));
  }
  const base = process.env[`${name}_URL`];
  if (!base) throw new Error(`Missing ${name}_URL`);
  const url = new URL(path, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid internal service URL');
  }
  return fetch(url, init);
}
