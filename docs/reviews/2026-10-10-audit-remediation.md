# 10 October 2026 audit remediation

This receipt supersedes the open status in the [original audit](2026-10-10-platform-audit.md). It distinguishes implemented controls from production verification and operational limits. Ten independent services and databases remain; no cross-database queries or shared domain state were introduced.

## Changes

| Finding | Remediation | Evidence and limits |
| --- | --- | --- |
| P-01 | GET/HEAD/OPTIONS and read-only Reporting summary POSTs skip outbox publication. Successful mutations publish in registered background work; queue acknowledgement still follows durable publication. | Service-kit lifetime/retry tests. Scheduled recovery retains committed events after publication failure. |
| P-02 | Ten service-specific Hyperdrive pools, verified TLS origins, query caching disabled, five origin connections each. | All ten deployed bindings read back successfully; each uses its own restricted role/database. End-user latency still needs authenticated measurement. |
| P-03/P-04 | One authorized bootstrap, lazy feature chunks, workspace policy reads bounded to four concurrent transactions. | Final referenced JavaScript decreased from 1,391,360 to 992,567 bytes (28.7%). This is a build result, not a latency guarantee. |
| P-05 | Bounded permission-scoped navigation snapshots and coalesced summary queries. Generation-aware invalidation at mutation start/completion; disposal on identity/scope changes and authorization failures. Only matching resources invalidate pending list reads; mounted hooks immediately drop rows after 401/403. | 46 frontend tests. Retained data can be shown while refreshing; server authorization remains mandatory. |
| P-06 | Shared advisory locks for Reporting reads; exclusive locks for projection/activity/merge writers. | Real PostgreSQL concurrency tests. |
| P-07 | Five Billing aggregate statements, repeatable-read snapshot, indexable month boundaries and exact minor-unit money arithmetic. Historical names are not assumed to be canonical students. | Manual reviewed identity endpoint and UI; unknown/ambiguous metrics stay unavailable. Real database tests cover revisions and authorization. |
| P-08/S-04 | Learning assignment-resource reads batched; request/response body ceilings and atomic per-minute actor/tenant budgets. | 32 MiB requests, 64 MiB responses; expensive actions 20/actor and 60/tenant, summary reads 120/actor and 300/tenant. Whole workbook bodies are still buffered; queued parsing/reconciliation is not implemented. |
| S-01 | Removed Node proxy dependency chain; patched CSV/YAML/ExcelJS UUID dependencies with import compatibility checks. | Production dependency audit reports zero advisories at release preparation; this is time-specific. |
| S-02/S-03 | Protected APIs consistently private/no-store. Static Next inline scripts use exact CSP hashes; frames have explicit allowed providers. | Static export/CSP tests and gateway regressions. Arbitrary inline scripts are not allowed. |
| S-05 | Published outbox payloads retained 30 days, bounded pruning; pending events and inbox replay tombstones retained. Request budget counters expire after one day. | Financial/source data has no new automatic purge. Seven-day R2 transport expiry still requires reviewed replay from canonical events. |
| S-06/A-05 | Complete ten-database schema/data/sequence snapshots, encrypted off-provider bundle including R2 and configuration/keys, safe new-local-database restore and object materialization. Legacy eight-service tool refuses operations. | Actual production snapshot restored across ten isolated local databases; 191 current-release bundle entries authenticated, one R2 object verified. Local recovery does not measure hosted disaster recovery time. |
| S-07 | Reject known PDF active content/object streams and Office macros/embedded active content; private attachment delivery retained. | This is structural screening, not a malware scanner. |
| A-02 | CI runs production dependency checks, boundaries, inventory, schema catalog, typechecks, workbook/runtime/CSP tests and a separate mandatory ordinary-role database job. | Local ten-service run: 157 tests, zero failures/skips. Workflow exists; branch protection is not enabled because available GitHub API access lacks administration rights. |
| A-03 | OpenAPI route registered before router initialization; generated request-schema catalog and concrete API examples added. | [Schema catalog](../api-input-schemas.json) covers the three newly introduced validators; it is not a complete schema description of every existing endpoint. |
| Diagnostics | Sanitized server request/phase logs and bounded authenticated client diagnostics. | No raw messages, stacks, tokens, private URLs or customer payloads in client telemetry. |

## Deployment receipt

All ten domain Workers, Gateway and Pages were deployed. Production was paused for a consistent recovery point; all ten ordinary-role database migrations completed successfully. Ingress is reopened, all nine consumer queues are unpaused, and the Gateway cron is restored. Live metadata verifies ten distinct Hyperdrive bindings, 77 forced-RLS domain tables and ordinary roles without superuser/RLS-bypass privileges. Health/home return 200 with CSP; unauthenticated session and invalid sign-in return 401; a foreign-origin recovery request returns 403. These probes do not measure authenticated dashboard p95.

The current-release encrypted database/configuration/file bundle authenticated 191 entries and one private R2 object. Both the pre-migration and post-migration ten-database snapshots were restored into fresh isolated local databases; production data was not restored or reset.

System email: the dedicated Resend sender domain is DNS-verified, its restricted sending credential is stored as a deployment secret, and both mail flags are enabled. Live tracing first exposed a 502 in the Notifications provider call. The provider now binds native fetch correctly and uses portable bounded timeout handling; safe failure categories/status are logged without provider content or recipient/token data. After redeployment, the actual production Forgot password form generated a second reset email and Resend confirmed Delivered. The owner account password was not changed. Local synthetic tests cover expiry, reuse and session revocation; invitation delivery uses the same provider but a real student invitation was not sent as part of this check.

The final run passed 157 ordinary-role database tests with zero failures/skips, 46 frontend tests and 31 service-kit tests. Final provider checks passed, and the production dependency audit returned zero known advisories. Login and Forgot password pages rendered in the isolated browser without console errors.

## Operational limits

- Neon production is on the Free plan with six-hour history retention, verified in its console on 10 October. This provider history is separate from the complete encrypted database/file capture.
- Complete encrypted captures are currently manual. There is no verified recurring full backup schedule; full-system recovery point remains unbounded between captures. Independent offline copy/key escrow and an isolated hosted recovery exercise remain to be established.
- Hosted recovery time, authenticated production p95 latency, maximum-volume workbook throughput and malware scanning have not been established by these tests.
- Payment charges and outbound customer campaigns remain disabled. No enterprise administration/licensing was introduced.

See [performance](../architecture/performance.md), [security](../architecture/security.md), [operations](../operations.md), and [recovery](../../scripts/RECOVERY.md) for the contracts and reproducible checks.
