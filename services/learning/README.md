# Learning service

Independent NestJS process on port 4004 with its own PostgreSQL database. Requires `DATABASE_URL`, `RABBITMQ_URL`, `CONTEXT_PUBLIC_KEY` and the `learning` entitlement. All endpoints require owner/admin/tutor membership. Private resources are unavailable to student/parent roles until explicit resource relationship authorization is implemented.

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/v1/assignments` | `{items}`, optional clientId/status/limit; default 100, max 200 |
| POST | `/v1/assignments` | Create assignment; referenced resources must belong to the same business and student |
| POST | `/v1/assignments/:id/submit` | Staff records student submission text or HTTPS reference |
| POST | `/v1/assignments/:id/review` | Staff records completed/needs_revision and optional feedback |
| GET | `/v1/resources` | `{items}`, optional clientId/limit; default 100, max 200 |
| POST | `/v1/resources` | Create HTTPS link or pending file metadata |

Assignment creation:

```json
{"clientId":"11111111-1111-4111-8111-111111111111","title":"Algebra practice","description":"Complete questions 1–10","dueAt":"2026-12-01T18:00:00.000Z","resourceIds":[]}
```

Resource creation:

```json
{"clientId":"11111111-1111-4111-8111-111111111111","title":"Worksheet","kind":"file_metadata","fileName":"algebra.pdf","mimeType":"application/pdf","sizeBytes":12345}
```

The resource response contains `storageStatus: "upload_pending"` and `url: null`. This stores metadata only; there is no actual upload or signed storage URL. Link resources use `{clientId,title,kind:"link",url:"https://..."}` and return `storageStatus:"linked"`. References are not downloaded or fetched by the service.

Assignments return `{item}` containing id/businessId/clientId/title/description/dueAt/status/resourceIds/submissionText/submissionUrl/submittedAt/feedback/reviewedAt/createdAt/updatedAt. Lifecycle: assigned → submitted → completed or needs_revision → submitted. Submission requires `{submissionText}` or `{submissionUrl}`; review uses `{status:"completed"|"needs_revision",feedback?}`. Finished assignments reject new submissions. Transaction row locks prevent competing progress updates.

Every domain table forces PostgreSQL tenant RLS. Request body tenant fields are rejected. Assignment creation atomically emits `learning.assignment-created.v1`. Student IDs are opaque references; membership and other services' records are not inferred from UUIDs. Direct student/parent portals, actual object storage uploads, revision history and automatic grading are pending.

Run `pnpm --filter @palladium/learning typecheck`, `build`, or `test`. Database tests require `LEARNING_TEST_DATABASE_URL` for an isolated database using a non-superuser role without BYPASSRLS.
