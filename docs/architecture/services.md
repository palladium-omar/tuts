# Service boundaries and plugging features into the app

> **Contract scope:** This page defines how Tuts features are composed and how future services should be added. It is not a claim that every feature or workflow below is shipped. See the [repository status](../../README.md#what-works-today) for implemented scope; student/parent portal access, for example, is not implemented.

Each service is an independently built Docker image and Node process, exposes `/health` and `/openapi.json`, and owns a PostgreSQL database. Local Compose may place the databases on one PostgreSQL server, but grants restrict each service role to its database. A database is never a shared integration surface.

## Composition

The gateway maps `/api/platform`, `/api/clients`, `/api/scheduling`, `/api/learning`, `/api/billing`, `/api/payments`, `/api/notifications` and `/api/integrations` to configured service URLs. It checks membership and entitlement through platform, signs the verified request context, and proxies to the chosen service. The browser never receives internal signing credentials. The form-hook ingress at `/api/integrations/hooks/...` is a separate public route authenticated by a per-connection bearer secret.

The frontend feature registry declares `id`, `label`, `path`, `entitlement`, and API prefix. Business configuration determines which entries appear. Services independently enforce entitlements, so hiding a navigation item is not access control. Provider selection and custom forms are data loaded through APIs.

### Add a feature

1. Define its data ownership, required core capabilities and versioned HTTP/event contracts.
2. Create a service package, database, migrations, image and health endpoint.
3. Register its URL at the gateway and its entitlement in platform.
4. Register its frontend entry and optional event subscriptions.
5. Demonstrate the feature through HTTP with unrelated services stopped or disabled.

These steps are the feature plugging workflow: establish ownership and contracts, build an independently runnable service, connect gateway access, then compose its UI and optional event subscriptions. The web registry alone does not deliver a feature or grant access. Start here when planning a new feature, then use the [implementation contract](implementation.md), [HTTP contract](http.md), and [event contract](events.md) for the required interfaces.

## Dependencies

Platform identity and entitlements are a declared common prerequisite. Client references are opaque identifiers; a module may snapshot required display/payer data through an authenticated API. Identifiers from other services are not cross-database foreign keys. Shared IDs never authorize access.

The integrations service polls business-connected Calendly/Cal.com calendars and accepts contact sources. It publishes contact batches for the CRM and read-only session batches for scheduling; it never writes to provider bookings. See the [connector contracts](connectors.md) for the current protocols and user flow. Scheduling's local session API remains separate. Billing does not automatically invoice completed sessions; it consumes payment confirmations and business-profile updates, while staff create invoices directly.

Billing and payments integrate through invoice/payment events. A payment attempt has an immutable amount, currency, business ID, invoice ID, and selected business connection. Billing remains the source of truth for invoice balance; payments remains the source of truth for provider transaction state. Learning can be used without a booking or invoice. Notifications consumes events and has its own delivery state. Platform business profile changes project the seller details and branding into billing; issuing an invoice snapshots the latest available profile.

Reports initially use the owning service's APIs. A future reporting projection may consume events; it must not query service databases directly.

## Failure behavior

An unavailable optional service returns a structured 503 for its routes; other feature routes continue working. Platform authentication outages fail closed for protected requests. Durable events wait for consumers to recover. Disabling an entitlement stops new business operations but does not drop already accepted financial webhooks or erase payment/invoice history.
