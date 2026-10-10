# Learning service

Independent NestJS process on port 4004 with its own PostgreSQL database. Requires `DATABASE_URL`, `RABBITMQ_URL`, `CONTEXT_PUBLIC_KEY` and the `learning` entitlement. Staff endpoints require owner/admin/tutor membership plus learning.read or learning.write. Scoped tutors additionally require a grant for each referenced student. Dedicated portal endpoints admit student/parent roles with the same signed relationship scope; no portal endpoint creates assignments, reviews homework or creates tutor material.

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

Assignment list and detail include `resources` metadata alongside `resourceIds`. Assignments return `{item}` containing id/businessId/clientId/title/description/dueAt/status/resourceIds/submissionText/submissionUrl/submittedAt/feedback/reviewedAt/createdAt/updatedAt. Lifecycle: assigned → submitted → completed or needs_revision → submitted. Submission requires text, an HTTPS URL, or private `submissionResourceIds`; review uses `{status:"completed"|"needs_revision",feedback?}`. Finished assignments reject new submissions. Transaction row locks prevent competing progress updates.

Every domain table forces PostgreSQL tenant RLS. Request body tenant fields are rejected. Assignment creation atomically emits `learning.assignment-created.v1`. Student IDs are opaque references; membership and other services' records are not inferred from UUIDs. Student/parent portals use the relationship checks documented below. Automatic grading and submission version history remain unavailable.

Run `pnpm --filter @palladium/learning typecheck`, `build`, or `test`. Database tests require `LEARNING_TEST_DATABASE_URL` for an isolated database using a non-superuser role without BYPASSRLS.

Actual file uploads accept nonempty PDF, PNG, JPEG, WebP, DOCX, PPTX and UTF-8 TXT files up to 20 MiB. The server derives content type from a supported extension and checks the binary signature rather than trusting the browser MIME. Office archives must be ordinary unencrypted ZIP files with the expected Office XML parts; validation bounds entries (1,000), per-entry output (20 MiB), total expanded content (50 MiB) and expansion ratio, rejects traversal paths and macro/executable entries, and inflates under a hard output cap. These checks do not replace malware scanning.

Uploaded resources retain `kind:"file_metadata"`, return `storageStatus:"stored"`, `url:null`, and service-relative `downloadUrl:"/v1/resources/:id/download"`; external clients prefix this with `/api/learning`. Attach their IDs through the existing assignment `resourceIds` field. No internal filesystem path or storage key is returned.

Set `UPLOAD_DIRECTORY` to persistent, private service storage outside any static web root; default `.local/uploads` resolves from the service working directory. The Docker workflow mounts a persistent learning volume. Files use random UUID names in tenant directories, permissions 0600, and an atomic temporary-file rename before SQL metadata becomes visible. Failed SQL writes clean up the file. A process crash between filesystem and database writes can leave an unreferenced file; backups and periodic orphan cleanup must be coordinated with this service database. Downloads verify tenant metadata and owner/admin/tutor roles, use `Content-Disposition:attachment`, `X-Content-Type-Options:nosniff`, and private/no-store caching. Existing pending metadata has no downloadable content.


## Cloudflare runtime

`src/worker.ts` exports this domain as an independent Worker through the shared Nest runtime; `src/main.ts` remains the Node entrypoint. The service retains its own PostgreSQL database, signed caller context, tenant RLS and event contracts. Migrations are applied during deployment, outside requests. Worker secrets and bindings are supplied by the deployment configuration.
Workers require a private R2 bucket bound as `UPLOADS`. Validated bytes are stored under `<business UUID>/<storage UUID>`; download authorization queries tenant-scoped PostgreSQL metadata before bucket access. No public URL or bucket key is returned, and SQL failures delete the object. A crash between object and metadata writes can leave an orphan; reconciliation must account for the database. Local Node storage continues using the private disk directory and atomic rename described above.


## Scoped portal learning (Phase 3)

Migration 003 adds assignment/resource revisions, private submission file links,
resource purpose and a local student alias projection. It preserves existing
assignments, resource IDs, files and material links. New tables force tenant RLS.

| Method | Route | Body / response |
| --- | --- | --- |
| GET | `/v1/portal/assignments` | clientId?, status?, limit (1–200, default 100), offset; `{items,total,limit,offset}` |
| GET | `/v1/portal/assignments/:id` | `{item:Assignment}` |
| POST | `/v1/portal/assignments/:id/submit` | `{submissionText?,submissionUrl?,submissionResourceIds?:UUID[],expectedRevision?}`; `{item:Assignment}` |
| POST | `/v1/portal/assignments/:id/submission-upload` | Multipart title/file; `{item:Resource}` |
| GET | `/v1/portal/resources` | clientId?, limit, offset; `{items,total,limit,offset}`; tutor materials only |
| GET | `/v1/portal/resources/:id` | `{item:Resource}` |
| GET | `/v1/portal/resources/:id/download` | Private authorized attachment download |
| GET | `/v1/portal/resources/capabilities` | `{item:{googleDocs:{referenceLinks:true,createDocument:false,availability:'external_sharing',reason},privateUploads:{supported:true,maxBytes:20971520}}}` |

Staff `/v1/assignments/:id/submission-upload` supports the same multipart fields;
`GET /v1/resources/:id` returns authorized resource metadata. Existing staff
list/get/create/submit/review/upload/download routes retain their shapes, adding
revisions, submission resources and bounded offset pagination. Review accepts
optional expectedRevision and remains staff-only. Optional revision checks return
409 after a concurrent change. Lifecycle still requires assigned or needs_revision
before submitted, then a staff review before completed or needs_revision. Uploading
a file alone never submits or completes the assignment.

Assignment shape is the existing shape plus `revision`,
`submissionResourceIds:UUID[]`, and `submissionResources:Resource[]`. `resources`
remain tutor material references; submission resources are separate. Submission
accepts at most 20 uploaded file IDs and validates every file against the same
assignment and student. Files upload only while the assignment accepts submission;
there is a 100-file lifetime upload cap per assignment. Existing linked material
cannot be claimed as a student upload. Upload/download uses the existing private
R2/disk adapter, binary format validation and 20 MiB bound; neither storage keys
nor public bucket URLs are exposed. SQL/outbox failure deletes the newly stored
object; orphan reconciliation remains required after an interrupted process.

Resource shape adds `revision`, `purpose:'material'|'submission'`,
`assignmentId:string|null`, `referenceProvider:'google_docs'|null`, and
`sharingNotice:string|null`. Portal download URLs use
`/v1/portal/resources/:id/download`. All lists filter exact signed studentIds for
student/parent or student scope, including empty grants. Detail, submission,
upload, review, referenced files and downloads check the object's student before
storage access. Foreign material or submission attachments are rejected even
inside the same business. Staff assignment create/review authority is never
available on portal routes. Tenant IDs remain server-derived.

### Selected Google documents

The tutor's student tracker has an **Essays & Google Docs** tab. It lists that
student's selected Google documents and lets staff with `learning.write` save a
named document link without first creating homework. The tab uses Learning's
existing resource API; Clients does not own a separate essay-link field or table.
GET `/v1/resources?clientId=<student>&kind=google_doc&limit=20&offset=0`
filters before pagination and returns the same `{items,total,limit,offset}` shape.
The optional `kind` filter also accepts `link` and `file_metadata`, on staff and
portal resource lists. Tenant and student access checks still apply.
Saved documents are material resources and appear in the existing student portal.
Google document sharing remains external; saving a reference neither creates a
Google document nor changes its permissions or sends an email.

Staff POST `/v1/resources` accepts
`{clientId,title,kind:'google_doc',url:'https://docs.google.com/document/d/<id>/edit'}`.
Only exact docs.google.com HTTPS document paths without URL credentials are
accepted; arbitrary hostnames, provider OAuth credentials and public sharing
claims are rejected. The resource is a selected external reference. The response
states that Google controls document access and saving the link does not grant
sharing. This service does not fetch document content or create documents; OAuth
creation is explicitly unavailable. General HTTPS links remain supported through
the existing `kind:'link'` route.

### Lifecycle events and merged students

Every assignment lifecycle mutation emits a transactional versioned event:
`learning.assignment-created.v1`, `learning.assignment-submitted.v1`, or
`learning.assignment-reviewed.v1`, with
`{assignmentId,studentId,clientId,status,dueAt,revision}`. Material/submission
resource creation emits `learning.resource-created.v1` with
`{resourceId,studentId,clientId,kind,revision,assignmentId}`. Events exclude names,
submission text, URLs, feedback and file content.

The LearningIdentity subscriber consumes `clients.student-merged.v1` only from
the Clients producer. Under a local tenant identity lock it retains a revisioned
alias, flattens known alias chains and repoints assignment/resource client IDs.
Service-kit inbox deduplicates delivery in the same transaction. Creates and
mutations use this lock and canonicalize IDs, so subsequent writes through an old
ID resolve locally; delayed merge delivery also repoints any records written
before consumption. Scoped access checks both requested and canonical student IDs,
so an alias cannot transfer access. Remapped rows increment revisions and emit
`learning.assignment-updated.v1` and `learning.resource-updated.v1` with the same
projection fields. Reporting can rebuild without cross-service SQL. Resources
retain their private storage keys; assignment/resource IDs and historical content
are preserved.
