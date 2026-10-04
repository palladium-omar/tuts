import { randomUUID } from "node:crypto";
import {
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { FileInterceptor } from "@nestjs/platform-express";
import { resourceStorage, type ResourceStorage } from "./storage.js";
import type { Response } from "express";
import {
  MAX_UPLOAD_BYTES,
  validateUpload,
  type UploadedResourceFile,
} from "./uploads.js";
import {
  CurrentContext,
  Database,
  emitEvent,
  parseBody,
  Roles,
} from "@palladium/service-kit";
import type { RequestContext } from "@palladium/contracts";
import {
  assignmentSchema,
  listSchema,
  resourceListSchema,
  resourceSchema,
  reviewSchema,
  submissionSchema,
  uploadSchema,
  uuid,
} from "./schemas.js";

type AssignmentRow = {
  id: string;
  business_id: string;
  client_id: string;
  title: string;
  description: string;
  due_at: Date | null;
  status: string;
  submission_text: string | null;
  submission_url: string | null;
  submitted_at: Date | null;
  feedback: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  resource_ids?: string[];
};
type ResourceRow = {
  id: string;
  business_id: string;
  client_id: string;
  title: string;
  kind: string;
  url: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: string | null;
  storage_status: string;
  storage_key?: string | null;
  created_at: Date;
};
export function assignmentView(row: AssignmentRow) {
  return {
    id: row.id,
    businessId: row.business_id,
    clientId: row.client_id,
    title: row.title,
    description: row.description,
    dueAt: row.due_at?.toISOString() ?? null,
    status: row.status,
    resourceIds: row.resource_ids ?? [],
    submissionText: row.submission_text,
    submissionUrl: row.submission_url,
    submittedAt: row.submitted_at?.toISOString() ?? null,
    feedback: row.feedback,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
export function resourceView(row: ResourceRow) {
  return {
    id: row.id,
    businessId: row.business_id,
    clientId: row.client_id,
    title: row.title,
    kind: row.kind,
    url: row.url,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    storageStatus: row.storage_status,
    downloadUrl:
      row.storage_status === "stored"
        ? `/v1/resources/${row.id}/download`
        : null,
    createdAt: row.created_at.toISOString(),
  };
}
const withResources = `SELECT a.*, ARRAY(SELECT ar.resource_id FROM assignment_resources ar WHERE ar.business_id=a.business_id AND ar.assignment_id=a.id ORDER BY ar.resource_id) AS resource_ids FROM assignments a`;
@Injectable()
export class LearningService {
  constructor(@Inject(Database) private readonly db: Database) {}
  // Optional test injection; production obtains request-local Worker bindings.
  storageFactory: () => ResourceStorage = resourceStorage;
  async listAssignments(ctx: RequestContext, query: unknown) {
    const q = parseBody(listSchema, query);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const assignments = (
        await tx.query<AssignmentRow>(
          `${withResources} WHERE a.business_id=$1 AND ($2::uuid IS NULL OR a.client_id=$2) AND ($3::text IS NULL OR a.status=$3) ORDER BY a.created_at DESC,a.id LIMIT $4`,
          [ctx.businessId, q.clientId ?? null, q.status ?? null, q.limit],
        )
      ).rows;
      const ids = [
        ...new Set(assignments.flatMap((row) => row.resource_ids ?? [])),
      ];
      const resources = ids.length
        ? (
            await tx.query<ResourceRow>(
              "SELECT * FROM resources WHERE business_id=$1 AND id=ANY($2::uuid[])",
              [ctx.businessId, ids],
            )
          ).rows
        : [];
      const byId = new Map(resources.map((row) => [row.id, resourceView(row)]));
      return {
        items: assignments.map((row) => ({
          ...assignmentView(row),
          resources: (row.resource_ids ?? [])
            .map((id) => byId.get(id))
            .filter(Boolean),
        })),
      };
    });
  }
  async getAssignment(ctx: RequestContext, id: string) {
    parseBody(uuid, id);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const row = (
        await tx.query<AssignmentRow>(
          `${withResources} WHERE a.business_id=$1 AND a.id=$2`,
          [ctx.businessId, id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("Assignment not found");
      const resources = (
        await tx.query<ResourceRow>(
          "SELECT r.* FROM resources r JOIN assignment_resources ar ON ar.business_id=r.business_id AND ar.resource_id=r.id WHERE ar.business_id=$1 AND ar.assignment_id=$2 ORDER BY r.created_at,r.id",
          [ctx.businessId, id],
        )
      ).rows.map(resourceView);
      return { item: { ...assignmentView(row), resources } };
    });
  }
  async createAssignment(ctx: RequestContext, body: unknown) {
    const v = parseBody(assignmentSchema, body);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      if (v.resourceIds.length) {
        const resources = await tx.query(
          "SELECT id FROM resources WHERE business_id=$1 AND client_id=$2 AND id=ANY($3::uuid[])",
          [ctx.businessId, v.clientId, v.resourceIds],
        );
        if (resources.rows.length !== v.resourceIds.length)
          throw new NotFoundException(
            "A resource is missing or does not belong to this student",
          );
      }
      const result = await tx.query<AssignmentRow>(
        "INSERT INTO assignments(id,business_id,client_id,title,description,due_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [
          randomUUID(),
          ctx.businessId,
          v.clientId,
          v.title,
          v.description,
          v.dueAt ?? null,
          ctx.sub,
        ],
      );
      const row = result.rows[0]!;
      for (const resourceId of v.resourceIds)
        await tx.query(
          "INSERT INTO assignment_resources(business_id,assignment_id,resource_id) VALUES($1,$2,$3)",
          [ctx.businessId, row.id, resourceId],
        );
      const item = assignmentView({ ...row, resource_ids: v.resourceIds });
      await emitEvent(tx, {
        type: "learning.assignment-created.v1",
        producer: "learning",
        businessId: ctx.businessId,
        correlationId: ctx.requestId,
        data: {
          assignmentId: item.id,
          clientId: item.clientId,
          dueAt: item.dueAt,
        },
      });
      return { item };
    });
  }
  async submit(ctx: RequestContext, id: string, body: unknown) {
    parseBody(uuid, id);
    const v = parseBody(submissionSchema, body);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const row = (
        await tx.query<AssignmentRow>(
          "SELECT * FROM assignments WHERE business_id=$1 AND id=$2 FOR UPDATE",
          [ctx.businessId, id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("Assignment not found");
      if (!["assigned", "needs_revision"].includes(row.status))
        throw new ConflictException(
          "Assignment must be assigned or need revision before submission",
        );
      await tx.query(
        `UPDATE assignments SET status='submitted',submission_text=$3,submission_url=$4,submitted_at=now(),feedback=NULL,reviewed_at=NULL,reviewed_by=NULL,updated_at=now() WHERE business_id=$1 AND id=$2`,
        [ctx.businessId, id, v.submissionText ?? null, v.submissionUrl ?? null],
      );
      return {
        item: assignmentView(
          (
            await tx.query<AssignmentRow>(
              `${withResources} WHERE a.business_id=$1 AND a.id=$2`,
              [ctx.businessId, id],
            )
          ).rows[0]!,
        ),
      };
    });
  }
  async review(ctx: RequestContext, id: string, body: unknown) {
    parseBody(uuid, id);
    const v = parseBody(reviewSchema, body);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const row = (
        await tx.query<AssignmentRow>(
          "SELECT * FROM assignments WHERE business_id=$1 AND id=$2 FOR UPDATE",
          [ctx.businessId, id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("Assignment not found");
      if (row.status !== "submitted")
        throw new ConflictException(
          "Only a submitted assignment can be reviewed",
        );
      await tx.query(
        "UPDATE assignments SET status=$3,feedback=$4,reviewed_at=now(),reviewed_by=$5,updated_at=now() WHERE business_id=$1 AND id=$2",
        [ctx.businessId, id, v.status, v.feedback, ctx.sub],
      );
      return {
        item: assignmentView(
          (
            await tx.query<AssignmentRow>(
              `${withResources} WHERE a.business_id=$1 AND a.id=$2`,
              [ctx.businessId, id],
            )
          ).rows[0]!,
        ),
      };
    });
  }
  async listResources(ctx: RequestContext, query: unknown) {
    const q = parseBody(resourceListSchema, query);
    return this.db.withTenant(ctx.businessId, async (tx) => ({
      items: (
        await tx.query<ResourceRow>(
          "SELECT * FROM resources WHERE business_id=$1 AND ($2::uuid IS NULL OR client_id=$2) ORDER BY created_at DESC,id LIMIT $3",
          [ctx.businessId, q.clientId ?? null, q.limit],
        )
      ).rows.map(resourceView),
    }));
  }
  async uploadResource(
    ctx: RequestContext,
    body: unknown,
    file: UploadedResourceFile | undefined,
  ) {
    const input = parseBody(uploadSchema, body),
      validated = validateUpload(file),
      id = randomUUID(),
      storageKey = randomUUID();
    const storage = this.storageFactory();
    try {
      await storage.put(ctx.businessId, storageKey, validated.buffer, validated.mimeType);
      return await this.db.withTenant(ctx.businessId, async (tx) => {
        const result = await tx.query<ResourceRow>(
          `INSERT INTO resources(id,business_id,client_id,title,kind,file_name,mime_type,size_bytes,storage_status,storage_key,created_by) VALUES($1,$2,$3,$4,'file_metadata',$5,$6,$7,'stored',$8,$9) RETURNING *`,
          [
            id,
            ctx.businessId,
            input.clientId,
            input.title,
            validated.fileName,
            validated.mimeType,
            validated.buffer.length,
            storageKey,
            ctx.sub,
          ],
        );
        return { item: resourceView(result.rows[0]!) };
      });
    } catch (error) {
      try { await storage.delete(ctx.businessId, storageKey); } catch {
        console.error("[learning] private upload cleanup failed; orphan reconciliation required");
      }
      throw error;
    }
  }
  async downloadResource(ctx: RequestContext, id: string, response: Response) {
    parseBody(uuid, id);
    const row = await this.db.withTenant(
      ctx.businessId,
      async (tx) =>
        (
          await tx.query<ResourceRow>(
            "SELECT * FROM resources WHERE business_id=$1 AND id=$2",
            [ctx.businessId, id],
          )
        ).rows[0],
    );
    if (!row || row.storage_status !== "stored" || !row.storage_key)
      throw new NotFoundException("Stored resource not found");
    const storageKey = parseBody(uuid, row.storage_key);
    const content = await this.storageFactory().read(ctx.businessId, storageKey);
    const fileName = row.file_name || "resource";
    const fallback = fileName
      .replace(/[^a-zA-Z0-9._ -]/g, "_")
      .replace(/["\\]/g, "_");
    response.setHeader(
      "Content-Type",
      row.mime_type || "application/octet-stream",
    );
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, (v) => `%${v.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "private, no-store");
    if (row.size_bytes !== null)
      response.setHeader("Content-Length", row.size_bytes);
    return Buffer.isBuffer(content) ? new StreamableFile(content) : new StreamableFile(content);
  }
  async createResource(ctx: RequestContext, body: unknown) {
    const v = parseBody(resourceSchema, body);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const result = await tx.query<ResourceRow>(
        "INSERT INTO resources(id,business_id,client_id,title,kind,url,file_name,mime_type,size_bytes,storage_status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
        [
          randomUUID(),
          ctx.businessId,
          v.clientId,
          v.title,
          v.kind,
          v.kind === "link" ? v.url : null,
          v.kind === "file_metadata" ? v.fileName : null,
          v.kind === "file_metadata" ? (v.mimeType ?? null) : null,
          v.kind === "file_metadata" ? (v.sizeBytes ?? null) : null,
          v.kind === "link" ? "linked" : "upload_pending",
          ctx.sub,
        ],
      );
      return { item: resourceView(result.rows[0]!) };
    });
  }
}
@ApiTags("assignments")
@Roles("owner", "admin", "tutor")
@Controller("v1/assignments")
export class AssignmentsController {
  constructor(
    @Inject(LearningService) private readonly learning: LearningService,
  ) {}
  @ApiQuery({ name: "clientId", required: false, type: String })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @Get()
  @ApiOperation({ summary: "List student assignments for authorized staff" })
  list(@CurrentContext() ctx: RequestContext, @Query() query: unknown) {
    return this.learning.listAssignments(ctx, query);
  }
  @Get(":id")
  @ApiOperation({ summary: "Get an assignment and its resource metadata" })
  get(@CurrentContext() ctx: RequestContext, @Param("id") id: string) {
    return this.learning.getAssignment(ctx, id);
  }
  @ApiBody({
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["clientId", "title"],
      properties: {
        clientId: { type: "string", format: "uuid" },
        title: { type: "string", maxLength: 200 },
        description: { type: "string", maxLength: 5000 },
        dueAt: { type: "string", format: "date-time", nullable: true },
        resourceIds: {
          type: "array",
          items: { type: "string", format: "uuid" },
          maxItems: 50,
        },
      },
    },
  })
  @Post()
  @ApiOperation({
    summary:
      "Create an assignment with resources belonging to the same student",
  })
  create(@CurrentContext() ctx: RequestContext, @Body() body: unknown) {
    return this.learning.createAssignment(ctx, body);
  }
  @ApiBody({
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        submissionText: { type: "string", maxLength: 10000 },
        submissionUrl: {
          type: "string",
          format: "uri",
          description: "HTTPS reference only",
        },
      },
      anyOf: [
        { required: ["submissionText"] },
        { required: ["submissionUrl"] },
      ],
    },
  })
  @Post(":id/submit")
  @ApiOperation({
    summary: "Staff records a student submission; no files are uploaded",
  })
  submit(
    @CurrentContext() ctx: RequestContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.learning.submit(ctx, id, body);
  }
  @ApiBody({
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["completed", "needs_revision"] },
        feedback: { type: "string", maxLength: 5000 },
      },
    },
  })
  @Post(":id/review")
  @ApiOperation({
    summary: "Review a submitted assignment and record progress",
  })
  review(
    @CurrentContext() ctx: RequestContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.learning.review(ctx, id, body);
  }
}
@ApiTags("resources")
@Roles("owner", "admin", "tutor")
@Controller("v1/resources")
export class ResourcesController {
  constructor(
    @Inject(LearningService) private readonly learning: LearningService,
  ) {}
  @ApiQuery({ name: "clientId", required: false, type: String })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @Get()
  @ApiOperation({
    summary: "List private student resource references for staff",
  })
  list(@CurrentContext() ctx: RequestContext, @Query() query: unknown) {
    return this.learning.listResources(ctx, query);
  }
  @Post("upload")
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["clientId", "title", "file"],
      properties: {
        clientId: { type: "string", format: "uuid" },
        title: { type: "string", maxLength: 200 },
        file: { type: "string", format: "binary" },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor("file", {
      limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: 1,
        fields: 2,
        parts: 3,
        fieldSize: 4096,
      },
    }),
  )
  @ApiOperation({
    summary:
      "Upload a private PDF, image, Office document or text file, at most 20 MiB",
  })
  upload(
    @CurrentContext() ctx: RequestContext,
    @Body() body: unknown,
    @UploadedFile() file: UploadedResourceFile | undefined,
  ) {
    return this.learning.uploadResource(ctx, body, file);
  }
  @Get(":id/download")
  @ApiOperation({
    summary:
      "Download a stored resource belonging to this business as authorized staff",
  })
  download(
    @CurrentContext() ctx: RequestContext,
    @Param("id") id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.learning.downloadResource(ctx, id, response);
  }
  @ApiBody({
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["clientId", "title", "kind"],
      properties: {
        clientId: { type: "string", format: "uuid" },
        title: { type: "string", maxLength: 200 },
        kind: { type: "string", enum: ["link", "file_metadata"] },
        url: {
          type: "string",
          format: "uri",
          description: "HTTPS URL required for link",
        },
        fileName: {
          type: "string",
          description:
            "Required for file_metadata; use /resources/upload for actual files",
        },
        mimeType: { type: "string" },
        sizeBytes: { type: "integer", minimum: 0 },
      },
    },
  })
  @Post()
  @ApiOperation({
    summary: "Create HTTPS link or file metadata marked upload_pending",
  })
  create(@CurrentContext() ctx: RequestContext, @Body() body: unknown) {
    return this.learning.createResource(ctx, body);
  }
}
