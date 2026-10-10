# Architecture decisions

These decisions define Tuts' architecture and extension constraints. They do not assert that production deployment or every described business workflow is already delivered; see the [repository status](../../README.md#what-works-today).

## ADR-001: Separate deployable services

Accepted: user explicitly requires decoupled services. Each domain runs in a separate process/image with a private database. The monorepo coordinates contracts and builds; it is not a modular monolith. This adds network failures, eventual consistency and deployment overhead, which the gateway, outbox/inbox and contract checks must address.

## ADR-002: Public HTTP contracts and durable events

REST/OpenAPI serves synchronous requests and independent app integrations. RabbitMQ carries asynchronous facts and has durable service queues. It is portable for local/self-hosted development. The deployed Cloudflare adapter uses per-consumer Queues, private bindings, R2 event pointers and scheduled recovery. Node retains RabbitMQ. Both preserve the same contracts; no persistent AMQP consumer runs inside a Worker.

## ADR-003: Database per service

Each service has its own PostgreSQL database/role, including in Compose. Tenant-scoped tables enforce RLS. Shared physical PostgreSQL hosting is an operational choice, not permission to join another service's data. Initial implementation uses parameterized `pg` SQL and explicit migrations to make isolation/transactions inspectable; introducing Drizzle later is an internal service choice and cannot alter wire contracts.

## ADR-004: UI is a composition client

Next.js handles presentation, routes and branding. Business mutations go through the gateway and domain APIs. Neither frontend server actions nor shared UI packages own domain persistence. Entitlements are enforced by the gateway and service, and configuration is per business.

## ADR-005: Common transport helpers, separate business code

Shared packages contain wire types and infrastructure primitives only. They must not contain domain models, repositories or a shared business database. Boundary checks reject cross-service imports. Each service can be built and launched without starting unrelated services; platform authentication remains an explicit common dependency.

## ADR-006: Payment processors are adapters

Business-owned connections are selected per payment attempt. Invoices and provider state are separate service responsibilities. Provider capabilities are explicit. Live PayPal onboarding needs platform approval; automated bank settlement requires regional integration. Local simulated payments are labeled sandbox and gated by environment.

## ADR-007: Capabilities and explicit resource scope

Accepted: Platform resolves feature/action permissions independently from role names and signs business or student scope. Services enforce both action and resource policy. This supports future enterprise provisioning without moving financial ownership into tutor UI. Enterprise hierarchy, licenses and trusted cross-tenant aggregation are deferred.

## ADR-008: Derived reporting, source-preserving history

Accepted: Reporting owns rebuildable event projections and HTTP composition; it never joins Billing/Clients databases. Billing retains imported source files and historical work/invoice assertions separately from native invoice/payment facts. Dashboard coverage labels incomplete identity/history and provisional inactivity measures.

## ADR-009: Optimistic interaction with server authority

Accepted: Kanban updates render locally and save through ordered revision-checked requests. Memory caches and optimistic state improve interaction; they do not grant access or establish financial truth. Transport/connection/cache/lock optimizations remain proposed in the current audit until benchmarked and tested.
