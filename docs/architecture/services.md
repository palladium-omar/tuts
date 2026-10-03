# Service boundaries and plugging features into the app

Each service is an independently built Docker image and Node process, exposes `/health` and `/openapi.json`, and owns a PostgreSQL database. Local Compose may place the databases on one PostgreSQL server, but grants restrict each service role to its database. A database is never a shared integration surface.

## Composition

The gateway maps `/api/platform`, `/api/clients`, `/api/scheduling`, `/api/learning`, `/api/billing`, `/api/payments` and `/api/notifications` to configured service URLs. It checks membership and entitlement through platform, signs the verified request context, and proxies to the chosen service. The browser never receives internal signing credentials.

The frontend feature registry declares `id`, `label`, `path`, `entitlement`, and API prefix. Business configuration determines which entries appear. Services independently enforce entitlements, so hiding a navigation item is not access control. Provider selection and custom forms are data loaded through APIs.

To add a feature:

1. Define its data ownership, required core capabilities and versioned HTTP/event contracts.
2. Create a service package, database, migrations, image and health endpoint.
3. Register its URL at the gateway and its entitlement in platform.
4. Register its frontend entry and optional event subscriptions.
5. Demonstrate the feature through HTTP with unrelated services stopped or disabled.

## Dependencies

Platform identity and entitlements are a declared common prerequisite. Client references are opaque identifiers; a module may snapshot required display/payer data through an authenticated API. Identifiers from other services are not cross-database foreign keys. Shared IDs never authorize access.

Scheduling produces session lifecycle events. Billing only consumes them when a tenant has billing enabled and has explicitly selected automatic invoicing. Billing creates its own invoice from a supplied price snapshot; absence of price or payer information leaves the workflow unconfigured. Manual invoices work without scheduling.

Billing and payments integrate through invoice/payment events. A payment attempt has an immutable amount, currency, business ID, invoice ID, and selected business connection. Billing remains the source of truth for invoice balance; payments remains the source of truth for provider transaction state. Learning can be used without a booking or invoice. Notifications consumes events and has its own delivery state.

Reports initially use the owning service's APIs. A future reporting projection may consume events; it must not query service databases directly.

## Failure behavior

An unavailable optional service returns a structured 503 for its routes; other feature routes continue working. Platform authentication outages fail closed for protected requests. Durable events wait for consumers to recover. Disabling an entitlement stops new business operations but does not drop already accepted financial webhooks or erase payment/invoice history.
