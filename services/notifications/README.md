# Notifications and communications service

Independent NestJS process on port 4007 with its own PostgreSQL database. All domain tables force tenant RLS. HTTP calls need a gateway-signed business context and the `notifications` entitlement. Existing activity intents remain separate from campaign delivery.

## Environment and delivery gate

Common runtime configuration: `DATABASE_URL`, `RABBITMQ_URL`, `CONTEXT_PUBLIC_KEY`, optional `PORT`. Communications additionally use:

- `COMMUNICATIONS_ENCRYPTION_KEY`: stable 32-byte hex or base64 key. AES-256-GCM authenticates the business ID as additional data. Keep the same key across restarts and protect backups. Credential edits need the key; disabling a connection works even if the key is unavailable.
- `CLIENTS_URL`: configured internal clients service URL, such as `http://127.0.0.1:4002`. Recipient lookup forwards the current signed gateway bearer token directly to `/v1/recipients`; it never stores that short-lived token or accesses the clients database.
- `ALLOW_OUTBOUND_DELIVERY`: must equal `true` for provider sending or campaign approval. Default is false in every environment, including development. Drafting/configuration still work. Setting this flag is an explicit deployment action; creating a connection never sends or verifies a mailbox.

Provider requests require public DNS only, pin an approved address at connect time, reject redirects, require certificate verification, and use bounded timeouts and bodies. SMTP uses only ports 465 or 587, with TLS required and TLS 1.2 minimum. AI drafting calls the configured HTTPS endpoint with user-written instruction/content; it receives no CRM contacts, business credentials, or hidden contact context.

## Connections

GET `/v1/communication-connections` returns `{items,deliveryEnabled}` for owner/admin/tutor. POST and PATCH require owner/admin. POST accepts exactly `{provider,displayName,config,credentials}`. Providers and fields:

| provider            | config                                                                 | credentials                                                  |
| ------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| `smtp`              | `host`, `port` (465 or 587), `fromEmail`, optional `fromName`          | `username`, `password` (mailbox app password where required) |
| `resend`            | `fromEmail`, optional `fromName`                                       | `apiKey`                                                     |
| `whatsapp_business` | `phoneNumberId`, `apiVersion` (explicit Graph version such as `v25.0`) | `accessToken`                                                |
| `ai_agent`          | `endpointUrl` (HTTPS port 443)                                         | optional `bearerToken`                                       |

Responses expose `{id,provider,displayName,config,status,revision,credentialsConfigured,verificationStatus,createdAt,updatedAt}`. `status` is `active` or `disabled`; active means enabled configuration, not provider authentication. `verificationStatus` remains `not_verified` because no provider verification action is implemented. Credentials never appear in responses.

PATCH `/v1/communication-connections/:id` accepts optional `displayName`, complete `config`, complete `credentials`, and `status`. It increments the revision and suppresses pending recipients in existing queued campaigns. DELETE on that path disables the connection and retains campaign/provider history. Existing drafts must be recreated after connection changes before approval.

POST `/v1/communication-connections/:id/generate`, available to staff, accepts `{instruction,subject?,message?}` and requires an active `ai_agent`. Its endpoint receives `{instruction,subject,message}` and must return JSON `{subject,message}`; the API responds `{item:{subject,message}}`. No automatic campaign approval or sending follows. Request/response size is bounded to 128 KiB; timeout is 15 seconds plus bounded DNS resolution.

## Campaigns

All staff may GET `/v1/campaigns` (latest 100) or GET `/v1/campaigns/:id`. Owner/admin may create, approve, and cancel campaigns.

POST `/v1/campaigns` accepts:

```json
{
  "connectionId": "11111111-1111-4111-8111-111111111111",
  "channel": "email",
  "selection": { "clientIds": ["22222222-2222-4222-8222-222222222222"] },
  "subject": "Hello {{firstName}}",
  "message": "Your tutor has an update, {{displayName}}."
}
```

`selection` accepts either `clientIds` (1–2000 UUIDs) or `filter` (the clients service filter object). An empty selection selects the current CRM, within the same maximum. Filter fields are validated by the clients service, not interpreted by notifications. Truncated selections or totals over 2000 are rejected. Addresses are resolved by the authenticated clients service and snapshotted by notifications; browser-supplied addresses or tenant fields are rejected.

Email requires `subject` and `message` with an active SMTP/Resend connection. WhatsApp requires an active WhatsApp connection and `template:{name,language,parameters:string[]}`; free-text bulk WhatsApp is rejected. The template must already be approved in the connected Meta account, and parameters currently support text values for the BODY component. Meta validates the template at send time; template management/header/button parameters are not implemented. WhatsApp numbers must be E.164 (`+` plus country code and number).

Personalization supports literal `{{firstName}}`, `{{lastName}}`, `{{displayName}}` and `{{custom:<field UUID>}}`. Missing values become empty strings. No evaluation occurs. Unknown/malformed tokens, newline subjects, and oversized expanded content are rejected. Recipients without the appropriate opt-in or a valid address are stored as skipped with `consent_required` / `invalid_address`. Duplicate destination addresses are skipped as `duplicate_address`.

Create/detail responses are `{item,recipients,deliveryEnabled}`. List responses are `{items,deliveryEnabled}`. Each item has:

```text
id, connectionId, channel, subject, message, template, selection,
status (draft|queued|completed|cancelled),
counts {pending,sending,accepted,failed,unknown,skipped},
totalRecipients, eligibleRecipients, confirmationToken,
approvedAt, createdAt, updatedAt
```

Each recipient has `id,clientId,displayName,address,subject,message,template,status,reason,providerMessageId,acceptedAt`. The confirmation token binds campaign content, connection revision and recipient content/eligibility. It changes when pending consent is revoked. “Completed” means every recipient has a terminal processing state, including failures and unknowns; it does not mean delivered.

POST `/v1/campaigns/:id/send` requires `{confirmationToken}` from the reviewed server preview, an active unchanged connection, at least one pending eligible recipient, owner/admin permission, and enabled delivery. Approval and the durable `notifications.campaign-queued.v1` outbox event commit together. Concurrent/repeated approval never creates another queue entry. POST `/v1/campaigns/:id/cancel` suppresses pending recipients and preserves accepted/in-flight history; an already in-flight provider operation may finish.

## Durable worker and acceptance history

The worker discovers tenant IDs from its own persisted campaign outbox events, then opens tenant-scoped transactions. It leases a single pending recipient, commits `sending`, and calls the provider. SMTP has a deterministic per-recipient Message-ID; Resend receives a stable Idempotency-Key; WhatsApp uses approved Cloud API template payloads. Resend's documented key lifetime is 24 hours, but this queue never automatically retries recipient attempts.

A verified provider response records `accepted` and its provider message ID. It never records “delivered”; delivery receipt webhooks are not implemented. Definite provider rejection records `failed`. Network timeouts, malformed acceptance responses, ambiguous errors, and expired leases record `unknown` and are never automatically resent. Late verified acceptance can replace lease-expired unknown while preserving the provider ID. Database failure after provider acceptance leaves the durable lease to recover as unknown, preventing duplicate sends.

Consent subscriptions process `clients.client-created.v1` and `clients.client-updated.v1` with `{clientId,emailOptIn?,whatsappOptIn?}`. Event timestamps protect against older consent overwriting newer state; false flags suppress pending recipients as `consent_revoked`. The worker rechecks consent, campaign cancellation and connection revision immediately before sending. Revocation/cancellation cannot retract an operation already in flight, and broker lag can delay receipt of updated consent.

Campaign operations and connection edits emit transactional notifications events with opaque IDs only. Tenant domain state is never accessed outside RLS. The shared outbox has routing metadata and remains the worker's restart discovery source; long-term outbox retention/archival must preserve queued tenant discoverability.

## Existing activity intents

| Method | Route                   | Behavior                                                                  |
| ------ | ----------------------- | ------------------------------------------------------------------------- | ------------- |
| GET    | `/v1/notifications`     | `{items}`; optional status/limit; default 100, max 200                    |
| POST   | `/v1/notifications`     | `{title,message,channel?,recipientClientId?}` persists an activity intent |
| PATCH  | `/v1/notifications/:id` | `{status:"read"                                                           | "cancelled"}` |

Activity intents retain `deliveryMode:"queue_only"` and never invoke communication providers. Only queued in-app intents may be read. Existing event handlers retain validated facts for client creation, session creation/completion, assignment creation, invoice issuance, and payment confirmation.

## Validation and provider references

Run `pnpm --filter @palladium/notifications typecheck`, `build`, and `test`. PostgreSQL tests need `NOTIFICATIONS_TEST_DATABASE_URL`, using a non-superuser without BYPASSRLS; they use only synthetic isolated tenants and clean them up. Tests exercise tenant isolation, permissions, queue approval idempotency, acceptance-history preservation, unknown lease recovery, consent/address selection, encryption, SSRF rejection and disabled outbound adapters. They never deliver messages.

Provider implementations follow primary documentation: [Nodemailer SMTP transport](https://nodemailer.com/smtp), [Resend sending API](https://resend.com/docs/api-reference/emails/send-email), [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), and [Meta's official Cloud API template example](https://github.com/fbsamples/whatsapp-api-examples/blob/main/template-for-ecommerce-js/messageHelper.js). Meta documentation pages returned HTTP 429 during implementation; the official Meta example supplies the versioned endpoint and template BODY payload. Graph API version is explicit configuration and should match the connected application's supported version.

Real external credentials and template approvals have not been supplied or live-tested. OAuth mailbox onboarding, provider connection verification, delivered/read webhooks, automatic retry/reconciliation, scheduled delivery, attachments and template header/buttons are not implemented.
