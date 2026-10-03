# Shared implementation contract

> **Contract scope:** This document describes the shared interfaces and contributor requirements. The runtime, eight domain services, and some workflows are implemented, but a listed interface does not mean every feature that could use it is shipped. See the [repository status](../../README.md#what-works-today), [connector contract](connectors.md), and service READMEs for current behavior. Student/parent portal authorization and production integrations remain future work.

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

Nest providers can use `OnModuleInit` and inject `EventBus` to register subscriptions. Registration occurs before the broker connects. Services use `@Controller('v1/...')`, `@CurrentContext()`, `@Roles(...)`, `Database.withTenant`, parameterized SQL and `parseBody(zodSchema, body)`. The runtime globally validates signed context and the configured service entitlement except on explicitly public routes. Default routes are staff-only until a documented resource relationship check is added for students/parents.

SQL migrations live in `services/<name>/migrations/*.sql`, run in lexical order once and are tracked transactionally. Runtime creates service-owned `service_outbox`, `service_inbox` and `service_migrations`. Do not create those tables in service migrations.

Every tenant table enables and forces RLS with `business_id = nullif(current_setting('app.business_id', true), '')::uuid` in both USING and WITH CHECK. Use `CREATE POLICY` per table. UUIDs can be generated with Node's `randomUUID()` or PostgreSQL `gen_random_uuid()`.

Services have package names `@palladium/<name>` and scripts `dev: tsx watch src/main.ts`, `build: tsc -p tsconfig.json`, `typecheck: tsc --noEmit -p tsconfig.json`, `start: node dist/main.js`. Use a local tsconfig extending `../../tsconfig.base.json` with `rootDir: src`, `outDir: dist`. Common runtime dependencies: `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `@nestjs/swagger`, `reflect-metadata`, `rxjs`, `pg`, `zod`, shared workspace packages. Root owns lockfile and installation.

## Environment

All services: `DATABASE_URL`, `RABBITMQ_URL`, `CONTEXT_PUBLIC_KEY` (PEM, escaped newlines accepted), `PORT`. Gateway additionally has `CONTEXT_PRIVATE_KEY`, `PLATFORM_INTERNAL_SECRET`, and `<SERVICE>_URL` values. Platform has `PLATFORM_INTERNAL_SECRET`, `BETTER_AUTH_SECRET`, `PUBLIC_APP_URL`, `PUBLIC_GATEWAY_URL`. Payments has `PAYMENT_ENCRYPTION_KEY` and `ALLOW_SANDBOX_PAYMENTS`; production must reject sandbox. Integrations has `INTEGRATIONS_ENCRYPTION_KEY`, a stable 32-byte key encoded as hexadecimal or base64. `pnpm setup:local` creates this key and new local database credentials while preserving existing environment values. Shared infrastructure supports `DISABLE_BROKER=true` only for bounded tests.

Do not add guessed success stubs for external providers. A provider connection or capability that is not implemented must be returned as unavailable. External API credentials and production authorization are not supplied by this repository.

## Agent boundaries

Each delegated agent owns only its assigned service folders and may add service-specific README/tests there. Root owns apps, shared packages, infra, root manifests, CI, lockfile and architecture documents. No delegated agent commits, pushes, creates a repository or edits another agent's files.
