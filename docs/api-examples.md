# Reviewed API request and response examples

These four examples describe current code paths using synthetic identities. They are illustrative JSON, not captured customer responses or complete response schemas. Gateway routes use `/api/{service}`. Domain requests require the browser session cookie and `X-Business-Id`; the gateway derives signed context after checking current membership. Platform bootstrap and diagnostics verify the session directly. Never use a business header or this document as authorization.

The [generated input catalog](api-input-schemas.json) contains JSON Schema converted from three actual exported Zod validators, source locations, source fingerprints and request examples validated against those validators. It explicitly lists server checks that JSON Schema cannot express. Coverage excludes other endpoints and all response schemas. `/openapi.json` documents controller routes; this catalog supplements its current request-body coverage.

Regenerate with `pnpm exec tsx --tsconfig tsconfig.base.json scripts/document-input-schemas.mts`; check in CI with the same command followed by `--check`. Build the shared workspace packages first. A changed validator source or example makes the check fail until reviewed regeneration.

## Authorized startup

`GET /api/platform/v1/bootstrap` has no request body. It performs one verified session read, returns up to 100 currently authorized businesses, and resolves policy under each business's tenant scope with at most four workers. Session tokens are omitted. [Implementation](../services/platform/src/businesses.controller.ts).

Illustrative response, with optional user/profile fields omitted:

```json
{
  "item": {
    "user": {"id":"22222222-2222-4222-8222-222222222222","name":"Synthetic Tutor","email":"tutor@example.test","emailVerified":true},
    "expiresAt":"2026-10-11T12:00:00.000Z"
  },
  "items": [{
    "id":"33333333-3333-4333-8333-333333333333",
    "name":"Synthetic Learning Space",
    "role":"tutor",
    "entitlements":["clients","learning","reporting"],
    "settings":{},
    "createdAt":"2026-10-01T12:00:00.000Z",
    "permissions":["clients.read","learning.read","reporting.read"],
    "accessScope":"students",
    "studentIds":["11111111-1111-4111-8111-111111111111"],
    "policyVersion":1
  }]
}
```

Permissions and visible settings depend on the current membership policy. This response is never a reusable grant: subsequent domain requests recheck membership and resource access. Missing/expired sessions return 401.

## Categorical browser diagnostics

`POST /api/platform/v1/client-diagnostics` accepts `Content-Type: application/json`, an approved mutation origin, and a verified session. The body is limited to 2048 bytes and 1–10 events. Unknown object fields are rejected. [Validator](../services/platform/src/schemas.ts), [implementation](../services/platform/src/businesses.controller.ts).

```json
{"events":[{"kind":"TypeError","source":"window","view":"learning"}]}
```

Response:

```json
{"item":{"accepted":1}}
```

Only the allowlisted kind, source and coarse view are accepted. Do not include messages, stacks, URLs, student IDs, email, session values or screenshots. The browser sends no more than 50 events per authenticated API context, uses batches of at most ten, and does not retry failed reports. Student portal sections map to learning, scheduling, planning or other; contacts use other.

## Reporting student summaries

`POST /api/reporting/v1/summaries` is a read-only batch request. It requires the Reporting entitlement, staff role, `reporting.read`, and access to every requested and canonical student. The strict body requires 1–100 UUIDs, month year 2000–2200, and a valid IANA timezone. `includeFinancial` defaults to false; true additionally requires `billing.read`, `reporting.financial` and the Billing entitlement. [Validator](../services/reporting/src/schemas.ts), [controller](../services/reporting/src/reporting.controller.ts), [response composition](../services/reporting/src/reporting.service.ts).

```json
{"studentIds":["11111111-1111-4111-8111-111111111111"],"month":"2026-10","timeZone":"Africa/Casablanca","includeFinancial":false}
```

Illustrative response when no source history/events have been reconciled:

```json
{
  "items":[{
    "studentId":"11111111-1111-4111-8111-111111111111",
    "month":"2026-10","timeZone":"Africa/Casablanca",
    "bookings":{"booked":null,"completed":null,"cancelled":null,"noShow":null},
    "homework":{"assigned":null,"submitted":null,"completed":null,"needsRevision":null},
    "resources":{"period":"all_time","materials":null,"submissionFiles":null},
    "activity":{"activeSeconds":0,"lastSeenAt":null,"estimated":true,"scope":"tuts"},
    "coverage":{
      "scheduling":{"status":"missing","asOf":null,"reason":"No reconciled history or source events yet"},
      "learning":{"status":"missing","asOf":null,"reason":"No reconciled history or source events yet"}
    },
    "asOf":null,"partial":true
  }],
  "asOf":null
}
```

Unknown coverage uses null counts, rather than a claimed zero. Activity is an estimate within Tuts. Financial fields are omitted when not requested. When requested, `financial.period` is `all_time`; complete snapshots expose integer minor-unit currency totals and invoice counts, while incomplete snapshots expose null totals. Requesting unavailable financial access returns 403. Invalid bodies return 400. Rendering cards does not initiate source reconciliation.

## Reviewed work-history student identity

`PATCH /api/billing/v1/work-log/{id}/identity` requires the Billing entitlement, owner/admin/tutor role with business-wide access, `billing.read`, `reporting.financial` and `billing.write`. Linking additionally requires Clients access and `clients.read`; Billing verifies the canonical CRM student through Clients using signed authorization. [Route](../services/billing/src/history.controller.ts), [validator and implementation](../services/billing/src/history-identity.ts).

```json
{"status":"linked","studentId":"11111111-1111-4111-8111-111111111111","expectedWorkRevision":1,"expectedIdentityRevision":0,"reason":"Reviewed synthetic identity"}
```

Illustrative first successful review:

```json
{"item":{"workId":"44444444-4444-4444-8444-444444444444","status":"linked","studentId":"11111111-1111-4111-8111-111111111111","revision":1,"reason":"Reviewed synthetic identity","reviewedAt":"2026-10-10T12:00:00.000Z"}}
```

`expectedWorkRevision` is the current work row revision and must be at least one. `expectedIdentityRevision` is zero before a review exists, then the current identity revision. A stale revision returns 409; refresh before reviewing again. `unknown` and `ambiguous` must omit studentId or use null. Linked requires a UUID. Reason is trimmed, at most 500 characters, and defaults to the empty string. Imported source identity/name remains preserved; review stores a separate association. Later edits to the work row make an older review stale and remove it from confident identity attribution until reviewed again.
