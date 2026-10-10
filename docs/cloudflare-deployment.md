# Cloudflare deployment

This deployment keeps Tuts' ten independent domain services and their PostgreSQL databases. Cloudflare supplies the request runtime, private service calls, event queues, scheduled invocations, static assets, and private upload storage. Neon supplies PostgreSQL. The existing Node/container deployment remains available through the normal `main.ts` entrypoints.

The initial deployment on October 4, 2026 had nine Workers and the Pages ingress deployed, with **https://tuts.palladiumscholars.com** as the primary origin and **https://tuts-palladium.pages.dev** as the default Pages hostname, whose page visits redirect to the primary origin. The original local account and owned-workspace data have been restored into all eight Neon service databases; per-table counts and row digests match the private recovery snapshot. See the [data migration procedure](data-migration.md). Each service database uses an ordinary role, and cross-service database connections are denied. Initially, twelve event/dead-letter queues and both private R2 buckets were provisioned, with seven-day expiration for transport payloads. The account Workers namespace is `tuts-palladium.workers.dev`; individual service Workers and bucket public access remain disabled. R2 was activated after the owner approved its usage-based terms and completed billing setup. The Workers plan was not upgraded.

The GoDaddy `tuts` CNAME targets `tuts-palladium.pages.dev`; GoDaddy nameservers remain authoritative. After final-origin redeployment, normal TLS validation succeeded on the custom hostname. Live requests confirmed HTTP 200 for `/` (title `Tuts`), `/health` (`gateway ok`), and `/api/platform/auth/get-session` (`null`) with `Origin: https://tuts.palladiumscholars.com`. A Pages HTML request for `/?view=scheduling` returned HTTP 308 to the same path on the custom hostname. Hosted signup/sign-in, authenticated application flows, hosted R2 upload/download, provider requests, and sustained free-plan CPU compliance have not been verified. Earlier local workerd checks exercised password signup/sign-in, gateway service bindings, tenant-scoped CRM requests, R2 upload/download byte equality, and queue consumption into a notification intent; those local results do not establish complete hosted behavior.

## Service and data boundaries

| Component | Cloudflare deployment | Data and access |
| --- | --- | --- |
| Browser app | Next.js static export in the gateway's `ASSETS` binding | Browser sessions and API calls use the gateway origin |
| Gateway | Fetch Worker, public in Worker ingress mode and private in Pages ingress mode | Verifies browser Origin, resolves platform membership, and issues short-lived signed context |
| Optional Pages ingress | Thin public Pages Function bound to the gateway | Forwards requests unchanged; supports a custom subdomain with externally hosted DNS |
| Platform | Private Worker | Own PostgreSQL database; identity, sessions, businesses, memberships |
| Clients | Private Worker | Own PostgreSQL database; CRM and contact projections |
| Scheduling | Private Worker | Own PostgreSQL database; classes and connected-calendar projections |
| Learning | Private Worker | Own PostgreSQL database plus private R2 objects; assignments and resources |
| Billing | Private Worker | Own PostgreSQL database; rates, invoice drafts, invoices, allocations |
| Payments | Private Worker | Own PostgreSQL database; connector state and payment reconciliation |
| Notifications | Private Worker | Own PostgreSQL database; campaigns, delivery jobs, notifications |
| Integrations | Private Worker | Own PostgreSQL database; connector credentials, polling, intake |
| Planning | Private Worker | Own PostgreSQL database; student boards and versioned templates |
| Reporting | Private Worker | Own PostgreSQL database; scoped projections, activity aggregates and tagged links |
| Scheduled jobs | One cron trigger on the gateway Worker | Calls each service's authenticated runtime tick every 15 minutes |

Worker ingress publishes the gateway directly. Pages ingress publishes a thin proxy with a single `GATEWAY` service binding and disables direct gateway `workers.dev`/custom-domain routes. All application requests reach the same gateway checks, and its `ASSETS` binding and cron remain in place. Disable `workers.dev`, preview URLs, and public routes on domain services. Service calls use explicit bindings named `PLATFORM`, `CLIENTS`, `SCHEDULING`, `LEARNING`, `BILLING`, `PAYMENTS`, `NOTIFICATIONS`, `INTEGRATIONS`, `PLANNING`, and `REPORTING`. A binding does not grant tenant permission: the existing signed-context and resource authorization checks still apply.

The gateway rejects public `/internal` and `/__runtime` paths, including encoded variants. Ordinary API forwarding removes client-supplied authorization, internal secrets, identity/role/tenant context headers, and forwarding headers, then overwrites `x-real-ip` from Cloudflare's client IP. Non-platform business requests obtain membership and entitlements through the private platform context endpoint before receiving a JWT. Browser mutations require a trusted Origin. Platform owns session cookies; the gateway preserves separate `Set-Cookie` values and their security attributes.

The public `/api/integrations/hooks/...` route retains the existing connector-scoped `Authorization` secret and strips browser cookies and staff context. Its request limit remains 1 MiB. Other API requests have a 25 MiB streaming gateway limit; Learning retains its 20 MiB file limit and file-content validation. R2 objects use validated business/resource keys and are retrieved through the authorized Learning API. Keep the bucket private, with no public `r2.dev` endpoint or public custom domain.

Each service must have a distinct database and a dedicated owner/login role with `NOSUPERUSER` and `NOBYPASSRLS`. Do not deploy a Neon administration credential or a role that inherits an RLS-bypassing role as `DATABASE_URL`. Tenant tables retain `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and the policies keyed by the transaction-local `app.business_id`. Verify effective role membership and tenant isolation after provisioning. Separate databases can share a Neon project/compute to reduce cost; this must not introduce shared tables, cross-database SQL, or another service's credentials.

Neon's proxy terminates client TLS, so `pg_stat_ssl` on its database backend does not establish whether the deployment client is encrypted. The migration script requires verified client TLS, certificate rejection on failure, and a matching endpoint hostname before issuing SQL. It uses a direct endpoint. PostgreSQL also requires the administrator to be able to `SET ROLE` to a database's intended owner when creating it: the script grants each ordinary service role **to the administrator**, with automatic inheritance disabled. It applies database access grants/revocations while acting as that owner, then resets the role. Service roles receive no administrator membership, and each completed migration checks that its role cannot connect to any other service database.

## Runtime adaptation

Domain controllers, tenant transactions, wire contracts, event schemas, and business rules remain in their service folders. `@palladium/service-kit/worker` hosts each Nest application through Cloudflare's Node HTTP compatibility bridge. Database sockets belong to a Worker invocation and close when it completes. Migrations run from the deployment script, outside the Worker request runtime. Long-lived Node timers are replaced by queue consumers and scheduled ticks.

Cloudflare Queues replaces RabbitMQ for this deployment. An event is still written to its producer's transactional outbox alongside the state change. Outbox publication sends a copy to every consumer whose subscription matches the exact event type in [`eventConsumerSubscriptions`](../packages/contracts/src/index.ts). It marks the outbox entry published only after all destination sends succeed. Partial fanout can produce duplicates; the consumer's transactional inbox deduplicates by consumer/event ID before applying the handler. Queue retry and dead-letter configuration must be provisioned for each consumer.

Queues limits each message to 128,000 bytes including metadata. Larger event bodies, including business logos and contact batches, use a separate private `EVENT_PAYLOADS` R2 bucket shared by the transport adapters. The queue carries a versioned pointer with identity fields and a content digest; consumers validate the referenced bytes and event identity before passing the original event to domain handlers. This transport bucket has seven-day expiration, longer than the configured queue retention. It is separate from Learning's private upload bucket, which has no such expiration. Full event JSON remains in each producer's PostgreSQL outbox for recovery. [Queue size limits](https://developers.cloudflare.com/queues/platform/limits/).

| Consumer queue | Subscribed event types |
| --- | --- |
| billing | `payments.payment-confirmed.v1`, `platform.business-profile-updated.v1`, `scheduling.class-updated.v1`, `clients.student-merged.v1` |
| integrations | `clients.source-synced.v1` |
| clients | `integrations.contacts-received.v1`, `integrations.connection-disconnected.v1` |
| scheduling | `clients.student-merged.v1`, `integrations.sessions-synced.v1`, `integrations.connection-disconnected.v1` |
| planning | `clients.student-merged.v1` |
| reporting | `scheduling.class-updated.v1`, `learning.assignment-created.v1`, `learning.assignment-submitted.v1`, `learning.assignment-reviewed.v1`, `learning.assignment-updated.v1`, `learning.resource-created.v1`, `learning.resource-updated.v1`, `billing.invoice-updated.v1`, `clients.student-merged.v1` |
| learning | `clients.student-merged.v1` |
| payments | `billing.invoice-issued.v1` |
| notifications | `clients.client-created.v1`, `clients.client-updated.v1`, `scheduling.session-created.v1`, `scheduling.session-completed.v1`, `learning.assignment-created.v1`, `billing.invoice-issued.v1`, `payments.payment-confirmed.v1` |

Producer bindings use `EVENTS_<CONSUMER>` names. Queues perform fanout between independent consumers; one shared queue with competing consumers would lose the required subscription behavior. Successful HTTP and queue invocations attempt outbox flushing. A single `*/15 * * * *` gateway schedule also ticks **all ten** services sequentially, so pending events in services without a domain job can recover. Sequential ticks leave room for database/provider calls within Cloudflare's six pending-connection slots, which are shared by service-bound Workers within the top-level invocation. [Connection limits](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections). Ticks require a shared `INTERNAL_RUNTIME_SECRET` of at least 32 characters and remain private; the gateway rejects public runtime paths. A failed tick fails the scheduled invocation after all services have been attempted, and each tick has a 30-second deadline. The ten deadlines total five minutes, below the cron's 15-minute wall-time limit. Billing additionally runs automatic arrears drafting, Integrations polls enabled connections, and Notifications advances approved campaign jobs. These jobs are eventually consistent and may wait until the next tick.

## Provider availability

The password-recovery pages and backend are deployed. Live GET requests to `/forgot-password` and `/reset-password` returned HTTP 200 with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`; a session read returned HTTP 200 after applying Platform's database rate-limit migration. Automatic recovery email remains disabled pending a real system sender. A delivered administrative recovery link does not establish automatic mail delivery or completion of a password change. See [password recovery](architecture/password-recovery.md).

| Provider route | Cloudflare behavior |
| --- | --- |
| Calendly and Cal.com | Fetch adapters target the fixed provider origins; businesses still supply valid tokens |
| Resend and Meta WhatsApp | Fetch adapters target fixed provider origins; explicit outbound-delivery enablement and campaign approval still apply |
| Stripe test API | Fetch adapter is implemented; existing test-only restrictions remain |
| Custom HTTPS contact sources | Unavailable pending a safe egress adapter that preserves DNS/address checks |
| Custom SMTP | Unavailable pending a safe egress adapter |
| Business AI endpoints | Unavailable pending a safe egress adapter |

The Worker runtime sets `NODE_ENV=production`. The current Stripe test connector requires development or test, and the simulated sandbox provider retains its production restriction. Therefore deploying these adapters does **not** enable Stripe test payment links or real payment collection in the hosted production app. Production payment-provider support remains unfinished. Provider adapter tests and a successful deploy do not establish successful live calendar sync or message delivery.

## Deployment files and sequence

The deployment interface is `node scripts/cloudflare.mjs <command>`, with `init`, `config`, `build`, `bundle`, `provision`, `migrate`, and `deploy`. Worker-mode manifest, secret scoping, queue topology, database isolation checks, and deployment ordering have focused local checks. Pages ingress is an additional deployment path; remote commands for that mode have not yet been exercised against the hosting accounts.

Local deployment metadata belongs in ignored `.cloudflare/deployment.json`, with `prefix`, `accountId`, `publicUrl`, `ingress` (`worker` by default, or `pages`), optional `customDomain`, and a required `pagesProject` for Pages ingress. Generated Wrangler files live under `.cloudflare/generated/<service>/wrangler.json`; the gateway configuration binds `apps/web/out` as `ASSETS` with `run_worker_first: true` so API/private-path checks take precedence over asset serving. Pages mode also generates `.cloudflare/generated/pages/wrangler.json` and `dist/_worker.js`/`dist/_routes.json`. The proxy sends every request to the gateway and returns its response directly, preserving the streamed body and separate session cookies. It has no application secrets or database/queue/storage bindings.

Ignored `.cloudflare/secrets.json` contains the top-level `CONTEXT_PRIVATE_KEY`, `CONTEXT_PUBLIC_KEY`, `PLATFORM_INTERNAL_SECRET`, `INTERNAL_RUNTIME_SECRET`, `BETTER_AUTH_SECRET`, `AUTH_MAIL_INTERNAL_SECRET`, `PORTAL_INTERNAL_SECRET`, `PAYMENT_ENCRYPTION_KEY`, `INTEGRATIONS_ENCRYPTION_KEY`, and `COMMUNICATIONS_ENCRYPTION_KEY`. Its `databasePasswords` and `databaseUrls` maps each have the ten lowercase service names as keys; `adminDatabaseUrl` holds the Neon administration connection used for provisioning databases/roles. Keep both JSON files out of Git and shared artifacts. Stable encryption keys must survive redeployments or stored connector credentials become unreadable. Deployment uploads only the required secrets to each Worker; the administration credential must remain local and the static browser bundle must contain no secrets.

System password emails have separate configuration from business communications. Platform and Notifications receive `AUTH_MAIL_INTERNAL_SECRET`; only Notifications receives `AUTH_MAIL_PROVIDER`, `AUTH_MAIL_FROM` and `AUTH_MAIL_API_KEY`. Configure a real verified sender before setting `authMailEnabled: true` in the deployment manifest, regenerate configuration and deploy both services. The default is disabled, and the generator refuses to enable mail without its required credentials. No marketing connector credential is reused for identity recovery.

Run from the repository root, replacing `YOUR-SUBDOMAIN` with the account's actual Workers subdomain:

```sh
pnpm install
node scripts/cloudflare.mjs init --public-url 'https://tuts-gateway.YOUR-SUBDOMAIN.workers.dev'
node scripts/cloudflare.mjs config
node scripts/cloudflare.mjs build
node scripts/cloudflare.mjs bundle
```

`init` also accepts `--account-id`, `--prefix`, `--custom-domain`, `--ingress`, and `--pages-project`. `--custom-domain none` clears a previous custom-domain setting when returning to staging. It preserves existing signing/encryption keys, database passwords, and account metadata except for explicitly supplied options. Configure the intended account, service/resource names, public URLs, and stable secrets using the generated files. Create or select a Neon project and store its administration URL as `adminDatabaseUrl` before running `migrate`; the generated per-service passwords are used to create the restricted service roles. Worker mode starts with the gateway's HTTPS `workers.dev` address for both `PUBLIC_APP_URL` and `PUBLIC_GATEWAY_URL`. The `bundle` step reports each deployable Worker's size and local compatibility errors, and also compiles the thin Pages proxy in Pages mode; actual edge startup/CPU acceptance still needs deployment and measurement.

The static browser build can also be run directly:

```sh
TUTS_STATIC_EXPORT=true NEXT_PUBLIC_GATEWAY_URL='' pnpm --filter @palladium/web build
```

Its output is `apps/web/out`. Empty `NEXT_PUBLIC_GATEWAY_URL` compiles same-origin API calls into the browser app. Set a public HTTPS gateway URL only when a distinct browser origin is intentional and configured as trusted. The normal build retains Next.js standalone output.

After authenticating the selected Cloudflare and Neon accounts and resolving account activation/plan limits:

```sh
node scripts/cloudflare.mjs provision
node scripts/cloudflare.mjs config
node scripts/cloudflare.mjs migrate
node scripts/cloudflare.mjs deploy
```

`provision` preserves an existing account Workers namespace, or registers one when the API explicitly reports it missing; queue consumers require that namespace even while public Worker routes are disabled. It creates Cloudflare queues/dead-letter queues, the private upload bucket, and the private event payload bucket with its seven-day lifecycle policy. In Pages mode it also creates the named Pages project if absent, with `main` as its production branch. An existing project must already use `main` as its production branch; the script does not change its branch settings. Generated bindings use resource names. `migrate` uses the local Neon administration URL to create separate databases and restricted roles, then applies each service's migrations as its own role and records its connection URL in `databaseUrls`. `deploy` uploads each Worker's required secrets and deploys domain Workers in dependency order followed by the gateway with its cron trigger. In Pages mode it publishes the Pages proxy after the gateway; its CLI invocation discovers configuration through `--cwd` and forces Pages to avoid automatic migration to Workers. [Custom-domain association](cloudflare-domain.md) and DNS updates remain separate steps. Confirm the final script's behavior before using these commands against an account: provisioning and deployment create remote resources, and migration changes remote schemas.

## Pages ingress with GoDaddy DNS

For `tuts.palladiumscholars.com`, Pages supports a custom subdomain while GoDaddy remains the authoritative DNS provider. The proxy's `GATEWAY` service binding calls the existing Worker; the gateway continues to own routing, auth, assets, and scheduled jobs. [Pages custom subdomains](https://developers.cloudflare.com/pages/configuration/custom-domains/#add-a-custom-subdomain), [Pages service bindings](https://developers.cloudflare.com/pages/functions/bindings/#service-bindings).

Stage on the project's production `pages.dev` hostname first. The example project name must be available; if Pages returns a different hostname, update `publicUrl` to that actual HTTPS origin and regenerate/deploy before browser verification.

```sh
node scripts/cloudflare.mjs init --ingress pages --pages-project tuts-palladium --custom-domain none --public-url 'https://tuts-palladium.pages.dev'
node scripts/cloudflare.mjs config
node scripts/cloudflare.mjs build
node scripts/cloudflare.mjs bundle
node scripts/cloudflare.mjs provision
node scripts/cloudflare.mjs migrate
node scripts/cloudflare.mjs deploy
```

These commands reuse the existing ignored secret file. The script's deploy uses `main`, so check that branch setting when selecting an existing Pages project. After staging works, associate `tuts.palladiumscholars.com` in the Pages project's **Custom domains** settings. Then add a GoDaddy CNAME with name `tuts` and target the actual project's `*.pages.dev` hostname. Registering the hostname with Pages before adding the CNAME is required; the CNAME alone can return a 522. This subdomain path requires no whole-zone nameserver change. Preserve the Firebase apex/www records and Google mail MX/verification/SPF/DKIM/DMARC records. [External-DNS CNAME setup](https://developers.cloudflare.com/pages/configuration/custom-domains/#add-a-custom-cname-record).

Set the production browser/API origin and redeploy after the hostname association and DNS are ready:

```sh
node scripts/cloudflare.mjs init --ingress pages --pages-project tuts-palladium --custom-domain tuts.palladiumscholars.com --public-url 'https://tuts.palladiumscholars.com'
node scripts/cloudflare.mjs config
node scripts/cloudflare.mjs deploy
```

The custom-domain setting in Pages mode configures the trusted application origin; it does not create a Worker route or modify DNS. Repeat signup/sign-in/session/sign-out, browser Origin, private-route, and tenant checks through the final hostname. Pages Function requests share the Workers quota; this proxy does not remove backend CPU or connection limits. [Pages pricing](https://developers.cloudflare.com/pages/functions/pricing/).

## Cost target and limits

The target is a $0 attempt for a small demo, subject to actual account access and resource limits. It is not a cost guarantee. Cloudflare Workers Free currently permits 10 ms CPU per HTTP invocation; the Nest initialization, identity/password processing, imports, and upload validation need measurement against that limit and the startup limit. Workers Paid has a $5/month account minimum, with usage above included allowances billed separately. The application may need that plan. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

Current Cloudflare documentation lists a 64 MiB uncompressed Worker limit for both plans, with no compressed-size limit. Verify the account's effective constraints and Wrangler output. No remote upload/startup acceptance has been demonstrated. [Worker size limits](https://developers.cloudflare.com/workers/platform/limits/#worker-size).

Neon's current Free allowance is 100 CU-hours per project per month, and inactive compute normally scales to zero after five minutes. A 0.25 CU compute awakened every 15 minutes for five minutes would consume roughly 60 CU-hours over 30 days, before work duration, queue activity, or browser traffic. Multiple service databases on one compute share that compute's budget; separate projects have separate quotas and wake cycles. The 15-minute schedule is a compromise between recovery latency and idle cost. Confirm actual compute size, suspension settings, storage/transfer allowances, and observed usage. [Neon Free allowance](https://neon.com/blog/neon-free-plan-1-gb-per-project), [Neon scale-to-zero documentation](https://github.com/neondatabase/website/blob/main/content/docs/introduction/scale-to-zero.md).

The observed Neon signup console lists 0.5 GB storage for this account. Use the actual console quota when planning capacity; the published free-plan announcement may describe a different rollout.

Queues Free includes 10,000 operations/day; fanout and retries multiply operations. This configuration uses 24-hour retention for both delivery and dead-letter queues. Inspect failures promptly: expiration does not automatically replay an event whose outbox row is already marked published. Outbox rows are retained in PostgreSQL, but operator replay tooling is not implemented. R2 is active: the owner approved its usage-based terms and completed billing setup. Both buckets are provisioned and private; the Workers plan was not upgraded. [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

## Public verification and custom domain

First deploy and verify the selected staging origin: the gateway's `workers.dev` URL for Worker mode or the project's production `pages.dev` URL for Pages mode. Required hosted checks include loading the ordinary browser app, signup/sign-in/session/sign-out cookies, tenant isolation, feature denial, blocked internal paths, event retry/deduplication, scheduled recovery, private upload/download isolation, and provider capability errors. Use synthetic data. Record live results separately from local checks.

The intended custom domain is `tuts.palladiumscholars.com`. In Worker ingress mode, a Worker Custom Domain requires control of the applicable Cloudflare zone; an existing CNAME on that hostname must be resolved before attaching it. Cloudflare account authentication alone does not establish zone control. Pages ingress uses the external-DNS subdomain procedure above. [Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

The GoDaddy `tuts` CNAME has been added, and GoDaddy nameservers remain authoritative. The custom hostname is the primary origin after final-origin redeployment. Live checks confirmed the homepage, health endpoint, unauthenticated session endpoint with the custom Origin, and canonical redirect. Signup/sign-in, authenticated sessions, tenant isolation, private uploads, event retries, scheduled recovery, and provider behavior still need hosted verification. The local account, four owned workspaces and their related records have been restored. Referenced private file contents were copied to R2 and matched by download; the authenticated application upload/download flow remains unverified.

## Student workspace rollout (October 10, 2026)

Planning and Reporting extend the same deployment to ten service Workers plus
one gateway. Learning, Planning and Reporting add three consumer queues and three
dead-letter queues (18 total). Existing R2 buckets and database contents remain.
Use `cloudflare.mjs init` to add missing credentials, build/bundle before pausing,
then pause ingress/cron/queues with `cloudflare-maintenance.mjs pause`.
`snapshot-hosted-data.mjs --writers-frozen` archives lossless rows, applied
migrations and schema metadata privately before additive schema migrations.
It captures original RLS metadata, then temporarily permits table-owner reads
inside isolated transactions that are rolled back. Original forced RLS is restored
before connections close; live writers must stay paused.
This is a recovery archive, not an automatically tested rollback. Archive files
contain personal data and stay ignored under `.cloudflare/recovery` (0600/0700).

After migrations, deploy Workers and Pages, then explicitly resume maintenance.
The gateway maintenance flag also suppresses cron work during deployment.
The maintenance helper can archive a completed prior snapshot when new queues
are added, only after checking existing controls remain unchanged. It refuses
topology changes while a maintenance operation remains incomplete.

Reporting uses private Scheduling/Learning/Billing/Clients bindings. Planning
uses Clients. Public Beacons redirects have one exact GET route with an opaque
token; all management/report/export endpoints require signed context.
`PUBLIC_REPORTING_BASE_URL` is the gateway origin followed by `/api/reporting`.
System invitation/recovery email requires a real sender; deployment does not
enable outbound delivery, charges or enterprise administration. Current delivery
evidence is in [the delivery tracker](student-workspace-delivery.md).

## Current audit snapshot — 10 October 2026

All ten private domain Workers were inspected and have targeted placement; none has a Hyperdrive binding. Platform and Notifications both have AUTH_MAIL_ENABLED=false; outbound campaigns and sandbox payments are false. Live PostgreSQL metadata verified ordinary roles and forced RLS on all 76 domain tables carrying business_id, with the two documented internal directories exempt. See the [audit](reviews/2026-10-10-platform-audit.md) for tests, measurements and limits. Earlier deployment counts above describe the initial installation, not today's resource inventory.
