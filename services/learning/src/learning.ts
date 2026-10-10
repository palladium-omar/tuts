import { Body, Controller, Get, Inject, Param, Post, Query, Res, UploadedFile, UseInterceptors } from "@nestjs/common";
import { ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { CurrentContext, Roles, Permissions, StudentScoped } from "@palladium/service-kit";
import type { RequestContext } from "@palladium/contracts";
import { MAX_UPLOAD_BYTES, type UploadedResourceFile } from "./uploads.js";
import { LearningService } from "./learning-service.js";
export { LearningService } from "./learning-service.js";
export { assignmentView, resourceView } from "./learning-model.js";
@ApiTags("assignments")
@StudentScoped()
@Roles("owner", "admin", "tutor")
@Controller("v1/assignments")
export class AssignmentsController {
  constructor(
    @Inject(LearningService) private readonly learning: LearningService,
  ) {}
  @ApiQuery({ name: "clientId", required: false, type: String })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @Get()
  @Permissions("learning.read")
  @ApiOperation({ summary: "List student assignments for authorized staff" })
  list(@CurrentContext() ctx: RequestContext, @Query() query: unknown) {
    return this.learning.listAssignments(ctx, query);
  }
  @Get(":id")
  @Permissions("learning.read")
  @ApiOperation({ summary: "Get an assignment and its resource metadata" })
  get(@CurrentContext() ctx: RequestContext, @Param("id") id: string) {
    return this.learning.getAssignment(ctx, id);
  }
  @Post(":id/submission-upload")
  @Permissions("learning.write")
  @UseInterceptors(FileInterceptor("file", {limits:{fileSize:MAX_UPLOAD_BYTES,files:1,fields:1,parts:2,fieldSize:4096}}))
  uploadSubmission(@CurrentContext() ctx:RequestContext,@Param("id") id:string,@Body() body:unknown,@UploadedFile() file:UploadedResourceFile|undefined) {
    return this.learning.uploadSubmission(ctx,id,body,file);
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
  @Permissions("learning.write")
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
  @Permissions("learning.write")
  @ApiOperation({
    summary: "Staff records a submission with text, URL or previously uploaded private files",
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
  @Permissions("learning.write")
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
@StudentScoped()
@Roles("owner", "admin", "tutor")
@Controller("v1/resources")
export class ResourcesController {
  constructor(
    @Inject(LearningService) private readonly learning: LearningService,
  ) {}
  @Get(":id")
  @Permissions("learning.read")
  get(@CurrentContext() ctx:RequestContext,@Param("id") id:string) {return this.learning.getResource(ctx,id);}
  @ApiQuery({ name: "clientId", required: false, type: String })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @Get()
  @Permissions("learning.read")
  @ApiOperation({
    summary: "List private student resource references for staff",
  })
  list(@CurrentContext() ctx: RequestContext, @Query() query: unknown) {
    return this.learning.listResources(ctx, query);
  }
  @Post("upload")
  @Permissions("learning.write")
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
  @Permissions("learning.read")
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
        kind: { type: "string", enum: ["link", "google_doc", "file_metadata"] },
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
  @Permissions("learning.write")
  @ApiOperation({
    summary: "Create HTTPS link or file metadata marked upload_pending",
  })
  create(@CurrentContext() ctx: RequestContext, @Body() body: unknown) {
    return this.learning.createResource(ctx, body);
  }
}
