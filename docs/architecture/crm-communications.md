# CRM columns and business-owned communications

## Service ownership

Clients owns contacts, typed custom-column definitions, values, filters, imports, and communication permissions. Notifications owns encrypted sender/agent connections, campaign drafts, approved recipient snapshots, and durable delivery attempts. The app composes these independently through the gateway; neither service imports another service’s code or reads its database.

A business needs `clients` and `notifications` for the combined CRM campaign workflow. Each API independently verifies signed membership, role, entitlement, and tenant scope. Connection changes and campaign creation/approval/cancellation require owner/admin. Staff may read campaign history. The UI is not an authorization boundary.

## CRM contract

- `GET/POST /api/clients/v1/fields`; `PATCH /fields/:id`. Fields have UUID `id`, immutable `key` and `type`, editable label/options. Types: text, number, date, select, boolean.
- Contact create/update accepts `customFields` keyed by field UUID. Null clears a value; updates merge with existing values. Definitions and values are validated in the selected business.
- Lists accept ordinary search/stage/relationship filters, tag/source/address-presence filters, and a JSON `filters` array of `{field,operator,value?}`. Custom field references are `custom:<uuid>`. Operators are type checked; all database values are parameterized.
- Sort accepts `displayName`, `createdAt`, `status`, or `custom:<uuid>`, with `asc/desc`.
- CSV and XLSX import mapping supports `custom:<uuid>` and email/WhatsApp permission fields. Blank imported values preserve existing values. UI column visibility and order are local preferences keyed by business; field definitions are persisted server side.
- `POST /api/clients/v1/recipients` takes `{clientIds:[...]}` or `{filter:{...}}`, never both. The server resolves the complete filtered audience independently of pagination. At most 2,000 contacts can enter one campaign; an oversized result is rejected by Notifications rather than silently truncated.

## Connections and drafts

`POST /api/notifications/v1/communication-connections` takes `{provider,displayName,config,credentials}`. Supported providers:

| Provider                | Business configuration                                | Capabilities                                                 |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| SMTP                    | TLS host/port, sender identity, app credentials       | Plain-text email                                             |
| Resend                  | Verified sender identity and API key                  | Plain-text email with provider idempotency key               |
| WhatsApp Business Cloud | Phone number ID, Graph API version, access token      | Meta-approved template messages and ordered body parameters  |
| AI agent                | Public HTTPS draft endpoint and optional bearer token | Draft subject/message generation; no campaign send authority |

Secrets are encrypted with AES-256-GCM and tenant authenticated data using `COMMUNICATIONS_ENCRYPTION_KEY`. Responses expose configuration and unverified status, never secrets. SMTP and agent destinations require public DNS, TLS, bounded requests, and no redirects. Configuration does not prove successful delivery. The business supplies its Meta API version and approved template; a version example is not a latest-version claim.

`POST /communication-connections/:id/generate` sends `{instruction,subject?,message?}` to the business’s agent. The endpoint must return `{subject,message}`. Contact records are not automatically sent to the agent. The resulting text remains editable and requires campaign preview and approval.

`POST /campaigns` takes `{connectionId,channel,selection,subject?,message?,template?}`. Notifications calls Clients’ recipient API over HTTP using the gateway’s short-lived signed Authorization context. The business ID is taken from verified context; recipient addresses supplied by the browser are never trusted. Email and WhatsApp permissions default to false. Missing permission/invalid addresses are recorded as skipped.

Personalization supports `{{firstName}}`, `{{lastName}}`, `{{displayName}}`, and `{{custom:<uuid>}}` through bounded string replacement, not executable templates. Preview stores the exact recipients and personalized content. Response includes eligible/skipped counts and a confirmation token derived from the reviewed snapshot.

## Approval, queue, and outcomes

`POST /campaigns/:id/send {confirmationToken}` verifies the preview, active connection revision, current consent, and owner/admin role. Concurrent approvals queue once. A durable worker claims recipients under tenant RLS and leases; it rechecks consent/connection state before transmission.

States: pending, sending, accepted, failed, unknown, skipped. **Accepted means provider acceptance, not confirmed delivery.** Timeout/crash outcomes become unknown; they are not automatically resent. Cancelling stops pending recipients and cannot recall accepted messages. Provider delivery/read receipts are future work.

Local setup defaults `ALLOW_OUTBOUND_DELIVERY=false`. Connections and drafts work with delivery disabled; send approval fails explicitly and the UI disables the send button. Enabling delivery is a deployment choice, not something the browser can change. No actual email/WhatsApp delivery was performed during this implementation.

## Events

- `clients.client-created.v1` and `clients.client-updated.v1`: `{clientId,emailOptIn,whatsappOptIn}`. Notifications projects ordered consent state and suppresses pending recipients on revocation.
- `clients.field-created.v1` / `clients.field-updated.v1`: `{fieldId}`.
- `notifications.connection-created.v1` / `connection-updated.v1`: identifiers/status only; no secrets.
- `notifications.campaign-queued.v1`: `{campaignId}`. The service’s own durable outbox is also a tenant catalogue for restart-safe queue discovery. It is not a cross-service database dependency.

Every event is persisted transactionally with its mutation. RabbitMQ bindings are declared in `packages/contracts`. Consumers deduplicate through the shared inbox.
