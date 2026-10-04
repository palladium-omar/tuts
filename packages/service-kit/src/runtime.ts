import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool } from 'pg';

export type CloudflareBindings = Record<string, unknown>;
type Invocation = { bindings: CloudflareBindings; pools: Map<object, Pool> };
const invocation = new AsyncLocalStorage<Invocation>();

export function isCloudflareRuntime(): boolean {
  return Boolean(invocation.getStore()) || process.env.TUTS_RUNTIME === 'cloudflare';
}
export function currentCloudflareBindings(): CloudflareBindings | undefined {
  return invocation.getStore()?.bindings;
}

// Kept out of the Node bootstrap path. Every event owns and closes its sockets.
export async function withCloudflareInvocation<T>(bindings: CloudflareBindings, work: () => Promise<T>): Promise<T> {
  return invocation.run({ bindings, pools: new Map() }, async () => {
    const scope = invocation.getStore()!;
    try { return await work(); }
    finally { await Promise.all([...scope.pools.values()].map(pool => pool.end())); }
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
    pool.on('error', () => {
      if (!invocationOwnedPool.ending) console.warn('Database connection unavailable');
    });
    scope.pools.set(owner, pool);
  }
  return pool;
}

export async function serviceFetch(serviceName: string, path: string, init?: RequestInit): Promise<Response> {
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
