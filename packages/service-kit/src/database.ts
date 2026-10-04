import { Injectable } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { invocationPool, isCloudflareRuntime } from './runtime.js';

@Injectable()
export class Database {
  // BetterAuth retains this object. Resolve methods against the invocation's
  // pool, so it never captures a socket belonging to a completed Worker event.
  readonly pool: Pool = isCloudflareRuntime()
    ? new Proxy(Object.create(Pool.prototype) as Pool, {
        get: (_target, key) => {
          if (key === 'constructor') return Pool;
          const pool = invocationPool(this);
          const value = Reflect.get(pool, key, pool);
          return typeof value === 'function' ? value.bind(pool) : value;
        },
      })
    : new Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 5000 });
  async transaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    const tx = await this.pool.connect();
    try { await tx.query('BEGIN'); const result = await work(tx); await tx.query('COMMIT'); return result; }
    catch (error) { await tx.query('ROLLBACK'); throw error; }
    finally { tx.release(); }
  }
  async withTenant<T>(businessId: string, work: (tx: PoolClient) => Promise<T>): Promise<T> {
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(businessId)) throw new Error('Invalid business context');
    return this.transaction(async tx => { await tx.query("SELECT set_config('app.business_id',$1,true)",[businessId]); return work(tx); });
  }
  async migrate(directory: string): Promise<void> {
    if (isCloudflareRuntime()) throw new Error('Apply migrations outside the Worker runtime');
    await this.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('palladium-migrations'))");
      await tx.query(`CREATE TABLE IF NOT EXISTS service_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS service_outbox (id uuid PRIMARY KEY, event jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz);
        CREATE INDEX IF NOT EXISTS service_outbox_pending ON service_outbox(created_at) WHERE published_at IS NULL;
        CREATE TABLE IF NOT EXISTS service_inbox (consumer text NOT NULL, event_id uuid NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(consumer,event_id));`);
      const files = (await readdir(directory)).filter(f => f.endsWith('.sql')).sort();
      for (const file of files) {
        const found = await tx.query('SELECT 1 FROM service_migrations WHERE name=$1',[file]);
        if (!found.rowCount) { await tx.query(await readFile(join(directory,file),'utf8')); await tx.query('INSERT INTO service_migrations(name) VALUES($1)',[file]); }
      }
    });
  }
  async onApplicationShutdown() { if (!isCloudflareRuntime()) await this.pool.end(); }
}
