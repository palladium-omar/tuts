# Learning service

Independent NestJS process on port 4004 with its own PostgreSQL database. Requires `DATABASE_URL`, `RABBITMQ_URL`, `CONTEXT_PUBLIC_KEY` and the `learning` entitlement. All endpoints require owner/admin/tutor membership. Private resources are unavailable to student/parent roles until explicit resource relationship authorization is implemented.

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/v1/assignments` | `{items}`, optional clientId/status/limit; default 100, max 200 |
| GET | `/v1/assignments/:id` | Assignment plus attached resource metadata |
| POST | `/v1/assignments` | Create assignment; referenced resources must belong to the same business and student |
| POST | `/v1/assignments/:id/submit` | Staff records student submission text or HTTPS reference |
| POST | `/v1/assignments/:id/review` | Staff records completed/needs_revision and optional feedback |
| GET | `/v1/resources` | `{items}`, optional clientId/limit; default 100, max 200 |
| POST | `/v1/resources` | Create HTTPS link or pending file metadata |
| POST | `/v1/resources/upload` | Multipart `clientId`, `title`, `file`; validates and stores a private file |
| GET | `/v1/resources/:id/download` | Authorized same-business staff download as an attachment |

Assignment creation:

```json
{"clientId":"11111111-1111-4111-8111-111111111111","title":"Algebra practice","description":"Complete questions 1–10","dueAt":"2026-12-01T18:00:00.000Z","resourceIds":[]}
```

Resource creation:

```json
{"clientId":"11111111-1111-4111-8111-111111111111","title":"Worksheet","kind":"file_metadata","fileName":"algebra.pdf","mimeType":"application/pdf","sizeBytes":12345}
```

The resource response contains `storageStatus: "upload_pending"` and `url: null`. This endpoint still stores metadata only. Use the upload endpoint for actual file content. Link resources use `{clientId,title,kind:"link",url:"https://..."}` and return `storageStatus:"linked"`. References are not downloaded or fetched by the service.

Assignment list and detail include `resources` metadata alongside `resourceIds`. Assignments return `{item}` containing id/businessId/clientId/title/description/dueAt/status/resourceIds/submissionText/submissionUrl/submittedAt/feedback/reviewedAt/createdAt/updatedAt. Lifecycle: assigned → submitted → completed or needs_revision → submitted. Submission requires `{submissionText}` or `{submissionUrl}`; review uses `{status:"completed"|"needs_revision",feedback?}`. Finished assignments reject new submissions. Transaction row locks prevent competing progress updates.

Every domain table forces PostgreSQL tenant RLS. Request body tenant fields are rejected. Assignment creation atomically emits `learning.assignment-created.v1`. Student IDs are opaque references; membership and other services' records are not inferred from UUIDs. Direct student/parent portals, remote object storage, revision history and automatic grading are pending.

Run `pnpm --filter @palladium/learning typecheck`, `build`, or `test`. Database tests require `LEARNING_TEST_DATABASE_URL` for an isolated database using a non-superuser role without BYPASSRLS.

Actual file uploads accept nonempty PDF, PNG, JPEG, WebP, DOCX, PPTX and UTF-8 TXT files up to 20 MiB. The server derives content type from a supported extension and checks the binary signature rather than trusting the browser MIME. Office archives must be ordinary unencrypted ZIP files with the expected Office XML parts; validation bounds entries (1,000), per-entry output (20 MiB), total expanded content (50 MiB) and expansion ratio, rejects traversal paths and macro/executable entries, and inflates under a hard output cap. These checks do not replace malware scanning.

Uploaded resources retain `kind:"file_metadata"`, return `storageStatus:"stored"`, `url:null`, and service-relative `downloadUrl:"/v1/resources/:id/download"`; external clients prefix this with `/api/learning`. Attach their IDs through the existing assignment `resourceIds` field. No internal filesystem path or storage key is returned.

Set `UPLOAD_DIRECTORY` to persistent, private service storage outside any static web root; default `.local/uploads` resolves from the service working directory. The Docker workflow mounts a persistent learning volume. Files use random UUID names in tenant directories, permissions 0600, and an atomic temporary-file rename before SQL metadata becomes visible. Failed SQL writes clean up the file. A process crash between filesystem and database writes can leave an unreferenced file; backups and periodic orphan cleanup must be coordinated with this service database. Downloads verify tenant metadata and owner/admin/tutor roles, use `Content-Disposition:attachment`, `X-Content-Type-Options:nosniff`, and private/no-store caching. Existing pending metadata has no downloadable content.
