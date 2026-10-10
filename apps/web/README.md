# Web composition app

Next/React provides tutor and student interfaces. Production exports static assets to Cloudflare; local development runs Next on port 3000. Domain persistence goes through gateway APIs, not browser database access or Next server actions.

Tutor views compose dashboard/history, CRM, groups/student tracker, calendars, learning, invoices/payments and connections. Student views expose scoped homework/resources/essays, booking/sessions and multiple planning boards. Staff financial/administrative reporting is excluded from student access on the server.

Business branding, feature entitlements and resolved action/resource capabilities drive presentation. Permissions are enforced again by gateway/domain APIs. Education profiles drive application cycles; Planning owns templates/cards, while the UI owns optimistic move queues and error recovery. CRM address retention is an explicit merge choice. Google Docs sharing remains Google's responsibility.

Read [system](../../docs/architecture/system.md), [learner/planning UX](../../docs/architecture/learner-planning-ux.md), [tutor UX](../../docs/architecture/tutor-workspace-ux.md), [history/analytics](../../docs/architecture/business-history-analytics.md) and [performance](../../docs/architecture/performance.md). Eager feature imports, serial bootstrap and mounted-view snapshot/cache gaps remain open; a functioning background Kanban queue does not fix initial page loading.

Run `pnpm --filter @palladium/web test`, build and typecheck. Installed Next documentation must be consulted before changing routing/build behavior, as required by this folder's AGENTS.md. Browser tests should use synthetic accounts/data and record local versus hosted verification separately.
