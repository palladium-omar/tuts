# Shared implementation contract

> **Current contract:** Ten domain services, staff/student portals and Cloudflare/Node adapters are implemented. Feature delivery limits and audit findings are recorded in the [documentation index](../README.md) and [current system](system.md). Enterprise hierarchy/licensing, live payment activation and arbitrary provider egress remain future work.

This document fixes the common interface used by independently implemented services. Ask the coordinating agent before changing shared packages or these interfaces.

## Repository layout

```
apps/web/                  Next.js composition client
apps/gateway/              HTTP routing and verified context issuer
services/platform/         identity, businesses, memberships
services/clients/
services/scheduling/
services/learning/
services/billing/
services/payments/
services/notifications/
services/integrations/     external scheduling and contact connectors
services/planning/         boards, templates and ordered card persistence
services/reporting/        projections, activity, business dashboard and attribution
packages/contracts/        wire types only
packages/service-kit/      Nest bootstrap, auth, database, events
infra/                     local database provisioning
scripts/                   development and integration tools
```

## Runtime exports from @palladium/service-kit

```ts
type RequestContext = {
  sub: string; businessId: string;
  role: 'owner' | 'admin' | 'tutor' | 'student' | 'parent';
  entitlements: string[]; requestId: string;
  permissions?: string[]; accessScope?: 'business' | 'students';
  studentIds?: string[]; policyVersion?: 1;
};
// Also exported by @palladium/contracts.

// Injectable; .pool is a pg Pool for internal/migration/platform access.
class Database {
  pool: Pool;
  withTenant<T>(businessId: string, work: (tx: PoolClient) => Promise<T>): Promise<T>;
  transaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T>;
}
// Decorators for Nest controllers.
CurrentContext(): ParameterDecorator;
Public(): MethodDecorator & ClassDecorator;
Roles(...roles: RequestContext['role'][]): MethodDecorator & ClassDecorator;
Permissions(...permissions: string[]): MethodDecorator & ClassDecorator;
StudentScoped(): MethodDecorator & ClassDecorator;
assertPermission(ctx: RequestContext, permission: string): void;
assertStudentAccess(ctx: RequestContext, studentId: string): void;

parseBody<T>(schema: ZodType<T>, input: unknown): T;
// Writes to outbox using the caller's open transaction.
emitEvent(tx: PoolClient, event: {
  type: string; producer: string; businessId: string;
  correlationId?: string; data: Record<string, unknown>;
}): Promise<string>;

// Injectable. Handler runs within a tenant-scoped transaction; inbox dedup is automatic.
class EventBus {
  subscribe(type: string, handler: (event: PlatformEvent, tx: PoolClient) => Promise<void>): void;
}

bootstrap({
  name: string, port: number, controllers: any[], providers?: any[],
  migrationsDir: string, entitlement?: string,
}): Promise<void>;
```

Nest providers can use `OnModuleInit` and inject `EventBus` to register subscriptions. Registration occurs before the broker connects. Services use `@Controller('v1/...')`, `@CurrentContext()`, `@Roles(...)`, `Database.withTenant`, parameterized SQL and `parseBody(zodSchema, body)`. The runtime globally validates signed context and the configured service entitlement except on explicitly public routes. Default routes are staff-only. Student/scoped tutor routes opt into StudentScoped and must check requested and canonical student IDs. Versioned contexts require all permission/resource fields; use explicit permissions for new endpoints.

SQL migrations live in `services/<name>/migrations/*.sql`, run in lexical order once and are tracked transactionally. Runtime creates service-owned `service_outbox`, `service_inbox` and `service_migrations`. Do not create those tables in service migrations.

Every tenant table enables and forces RLS with `business_id = nullif(current_setting('app.business_id', true), '')::uuid` in both USING and WITH CHECK. Use `CREATE POLICY` per table. UUIDs can be generated with Node's `randomUUID()` or PostgreSQL `gen_random_uuid()`.

Services have package names `@palladium/<name>` and scripts `dev: tsx watch src/main.ts`, `build: tsc -p tsconfig.json`, `typecheck: tsc --noEmit -p tsconfig.json`, `start: node dist/main.js`. Use a local tsconfig extending `../../tsconfig.base.json` with `rootDir: src`, `outDir: dist`. Common runtime dependencies: `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `@nestjs/swagger`, `reflect-metadata`, `rxjs`, `pg`, `zod`, shared workspace packages. Root owns lockfile and installation.

## Environment

All services: `DATABASE_URL`, `RABBITMQ_URL`, `CONTEXT_PUBLIC_KEY` (PEM, escaped newlines accepted), `PORT`. Gateway additionally has `CONTEXT_PRIVATE_KEY`, `PLATFORM_INTERNAL_SECRET`, and `<SERVICE>_URL` values. Platform has `PLATFORM_INTERNAL_SECRET`, `BETTER_AUTH_SECRET`, `PUBLIC_APP_URL`, `PUBLIC_GATEWAY_URL`. Payments has `PAYMENT_ENCRYPTION_KEY` and `ALLOW_SANDBOX_PAYMENTS`; production must reject sandbox. Notifications has `COMMUNICATIONS_ENCRYPTION_KEY`, `CLIENTS_URL` and explicit `ALLOW_OUTBOUND_DELIVERY` (false locally). Billing has `SCHEDULING_URL` for signed class reconciliation. Payments also uses trusted `PUBLIC_APP_URL` for Checkout return URLs. Integrations has `INTEGRATIONS_ENCRYPTION_KEY`, a stable 32-byte key encoded as hexadecimal or base64. `pnpm setup:local` creates this key and new local database credentials while preserving existing environment values. Shared infrastructure supports `DISABLE_BROKER=true` only for bounded tests.

Do not add guessed success stubs for external providers. A provider connection or capability that is not implemented must be returned as unavailable. External API credentials and production authorization are not supplied by this repository.

## Cloudflare deployment adapter

`services/<name>/src/app.ts` owns that service's controllers and providers. Its `main.ts` starts the existing Node process; its `worker.ts` uses `createWorkerService` from `@palladium/service-kit/worker`. Compile service TypeScript with `tsc` before Wrangler bundles the emitted JavaScript so Nest decorator metadata is retained.

Workers use invocation-scoped PostgreSQL pools, private service bindings through `serviceFetch`, contract-derived Cloudflare Queue fanout, and the same transactional outbox/inbox. `currentCloudflareBindings` exposes runtime storage bindings to a service's own adapter. Learning alone owns its R2 binding. No service imports another service's application source.

The public gateway's 15-minute schedule invokes private authenticated ticks on all ten services. A service's optional scheduled callback advances its own jobs; all ticks also recover pending outbox publication. Migrations run outside Workers. The [Cloudflare guide](../cloudflare-deployment.md) documents runtime configuration, provider limitations, costs, and deployment evidence.

## Agent boundaries

Each delegated agent owns only its assigned service folders and may add service-specific README/tests there. Root owns apps, shared packages, infra, root manifests, CI, lockfile and architecture documents. No delegated agent commits, pushes, creates a repository or edits another agent's files.
