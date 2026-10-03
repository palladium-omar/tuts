# Payment providers and business-owned collection

> **Current status:** The shipped payment adapter is a clearly labeled local sandbox with simulated confirmation. Stripe, PayPal, and bank providers are returned as unavailable; no real funds move. This page defines the provider ownership and adapter contract for future integrations. See the [repository status](../../README.md#what-works-today).

Each business receives client payments through its own connected merchant account. Our SaaS subscription charges are a different product/accounting flow. A business may enable several providers concurrently. The paying client selects among the methods allowed for that invoice and supported by the business's connections.

## Ownership

Billing owns invoices, amount due, line items and allocations. Payments owns provider connections, checkout attempts, provider references, webhook verification and payment state. It consumes issued-invoice snapshots to validate requested amounts; the browser never supplies an authoritative payable amount. Both enforce matching business ID, invoice ID and currency.

Amounts are integer minor units with a currency; never floating-point money. No shared assumption that all currencies have two decimal places. Connection IDs and external transaction IDs are scoped to a business and provider. Credentials are encrypted at rest with a deployment secret; API responses expose only sanitized status/capabilities.

## Adapter interface

Every adapter reports capabilities and implements supported operations: `createCheckout`, `getPayment`, `verifyWebhook`, and optionally `refund`. The adapter receives the selected business connection and a persisted payment attempt. Unsupported operations return an explicit capability error. Raw provider SDK objects do not escape the service.

- Stripe: connected-business direct charges through Stripe Connect; business onboarding and capability status are prerequisites.
- PayPal: approved platform seller onboarding and authorized partner calls. Production partner approval is required. A generic PayPal account email is not a connected integration.
- Bank: a region/provider-specific adapter for actual payment initiation or transfer reconciliation. Bank instructions/receipt upload may be a separately labeled manual workflow; they are not automatic integration.
- Sandbox: explicitly named `sandbox` and enabled only by local development configuration. It must not be selectable in production. A simulated confirmation is labeled simulated throughout.

## Reliability

Persist the attempt before calling a provider. Use its ID as the provider idempotency key, retry safely, and reconcile unknown outcomes instead of creating another charge. Verify webhook signatures against raw request bodies or the provider's verification API before accepting an event. Persist the provider event and payment transition before acknowledging it. Only verified confirmation emits `payments.payment-confirmed.v1`. Retries cannot allocate the same payment twice.

Availability varies by country, currency and connected-account capabilities. The local sandbox demonstrates a simulated flow. Live adapters are future work and are considered complete only after provider sandbox verification, account authorization and operational reconciliation have been implemented.
