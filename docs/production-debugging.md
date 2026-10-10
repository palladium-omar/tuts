# Production debugging

Tuts emits structured `tuts.diagnostic.v1` console records into Cloudflare Workers Logs. The configuration generator enables persistent logs on the ten service Workers and gateway, with 100% head sampling. This is diagnostic logging, not product usage analytics.

## Find an incident

1. Ask for the error's **Reference** UUID and approximate time. API error messages and the password-reset form show this UUID; every gateway response also includes `X-Request-Id` in its headers.
2. Open Workers & Pages → the affected `tuts-*` Worker → Observability → Logs. Filter for the reference UUID. Search gateway and the target service with the same UUID.
3. Review `event`, `service`, `trigger`, `status`, `durationMs`, normalized `route`, and safe `error.kind`, `error.code`, and code locations. A verified business UUID is present only after signed tenant context verification.
4. Distinguish `http` requests from `scheduled` ticks and `queue` invocations. A cron invocation shares its UUID across all service ticks. Queue retries currently share a batch invocation UUID; event contents are not logged.
5. For live investigation, run `XDG_CONFIG_HOME="$PWD/.cloudflare/cli-config" pnpm exec wrangler tail tuts-gateway --format json` from the checkout. Substitute another Worker name when needed. Tail is live, not historical.

Common events:

| Event | Meaning |
| --- | --- |
| request_completed | Response status, duration and normalized route |
| api_error | Controller/permission/database error handled by the API |
| identity_failed | Gateway could not obtain or validate business context |
| upstream_failed | Target service call failed or exceeded its deadline |
| request_failed | Unexpected outer HTTP invocation failure |
| tick_failed / tick_completed | Scheduled service result |
| queue_retry / queue_failed | Event processing retry or batch failure |
| outbox_deferred | Publication failed; durable outbox remains retryable |
| background_failed / cleanup_failed / database_failed | Background task or connection lifecycle failure |
| auth_mail_provider_failed | System sender failed; inspect only the whitelisted failure category and numeric provider status |
| password_mail_not_configured | System email configuration is disabled/incomplete |
| password_mail_failed | Password-reset delivery attempt failed |

## Privacy and retention

- No bodies, cookies, authorization headers, passwords, reset tokens, emails, student names, SQL parameters, provider response bodies or raw exception messages are written by this diagnostic logger.
- Route segments use a fixed allowlist; unknown segments are replaced with `:param`. Queries are omitted. Error stacks retain only bounded filename/line/column locations, not messages, directory paths or arbitrary function names.
- Public request IDs are replaced at ingress. Tenant identity comes from verified context, never a user-supplied business header.
- Automatic invocation log records are disabled and Cloudflare URL query-string redaction is enabled. Automatic traces are disabled because this deployment uses only the explicitly sanitized diagnostic records. A raw `wrangler tail` stream can still include platform metadata; keep captures private and do not paste them into Git or shared reports.
- Source maps are uploaded to aid code location lookup. They contain source code, not deployed secrets.
- Workers Free currently retains logs for **three days**, up to 200,000 log events/day. This is a short investigation window, not permanent history. Account limits can cause logs to be dropped; 100% sampling does not guarantee storage beyond those limits. Workers Paid currently retains logs for seven days; pricing changes are announced for December 1, 2026. See [Cloudflare pricing](https://developers.cloudflare.com/workers/platform/pricing/).
- This does not backfill the failures from before deployment or capture browser-only JavaScript errors. It does not enable the password email provider itself.

The generator in `scripts/cloudflare.mjs` owns logging configuration so future deployments retain these settings. Changes to logging fields must preserve the allowlist in `packages/service-kit/src/diagnostics.ts`.

## Deployment verification — October 9, 2026

All nine production Workers were deployed and their logging settings read back through the Cloudflare API. A harmless unauthenticated business-list request returned 401 with a newly generated support reference: the same UUID appeared in its response body/header, gateway completion log, Platform API error log and Platform completion log. A spoofed caller-supplied UUID was replaced. The ordinary session endpoint also returned 200 with a matching Platform completion record. No accounts or business records were created or changed by these checks.

Service-kit checks passed (17), including three diagnostic redaction/context checks; gateway checks passed (19). TypeScript builds and the static web build passed. The private deployment receipt and narrowly scoped tail captures are under the ignored `.cloudflare/audits/` directory.

## Current verification and performance follow-up

The [10 October audit](reviews/2026-10-10-platform-audit.md) rechecked live log configuration and runtime flags. General API timing is available; database connect/query/outbox phases and frontend failures still need dedicated instrumentation. Existing log retention is provider-managed and is not a backup strategy. Keep audit captures private.
