# Architecture decisions

## ADR-001: Separate deployable services

Accepted: user explicitly requires decoupled services. Each domain runs in a separate process/image with a private database. The monorepo coordinates contracts and builds; it is not a modular monolith. This adds network failures, eventual consistency and deployment overhead, which the gateway, outbox/inbox and contract checks must address.

## ADR-002: Public HTTP contracts and durable events

REST/OpenAPI serves synchronous requests and independent app integrations. RabbitMQ carries asynchronous facts and has durable service queues. It is portable for local/self-hosted development. Future cloud deployment must provide persistent broker hosting and continuously available consumers; blindly placing a persistent consumer on request-only compute is not sufficient.

## ADR-003: Database per service

Each service has its own PostgreSQL database/role, including in Compose. Tenant-scoped tables enforce RLS. Shared physical PostgreSQL hosting is an operational choice, not permission to join another service's data. Initial implementation uses parameterized `pg` SQL and explicit migrations to make isolation/transactions inspectable; introducing Drizzle later is an internal service choice and cannot alter wire contracts.

## ADR-004: UI is a composition client

Next.js handles presentation, routes and branding. Business mutations go through the gateway and domain APIs. Neither frontend server actions nor shared UI packages own domain persistence. Entitlements are enforced by the gateway and service, and configuration is per business.

## ADR-005: Common transport helpers, separate business code

Shared packages contain wire types and infrastructure primitives only. They must not contain domain models, repositories or a shared business database. Boundary checks reject cross-service imports. Each service can be built and launched without starting unrelated services; platform authentication remains an explicit common dependency.

## ADR-006: Payment processors are adapters

Business-owned connections are selected per payment attempt. Invoices and provider state are separate service responsibilities. Provider capabilities are explicit. Live PayPal onboarding needs platform approval; automated bank settlement requires regional integration. Local simulated payments are labeled sandbox and gated by environment.
