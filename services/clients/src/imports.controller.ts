import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  Inject,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiConsumes, ApiOperation, ApiTags } from "@nestjs/swagger";
import { createHash } from "node:crypto";
import {
  CurrentContext,
  Database,
  parseBody,
  Roles,
  Permissions,
} from "@palladium/service-kit";
import type { RequestContext } from "@palladium/contracts";
import { importRequestSchema } from "./schemas.js";
import { commitImport, previewImport } from "./imports.js";
import { lockContacts } from "./contact-store.js";
import { parseImportFile, MAX_FILE_BYTES } from "./parse-import.js";

@ApiTags("CRM imports")
@Roles("owner", "admin", "tutor")
@Controller("v1/imports")
export class ImportsController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Post("parse")
  @Permissions("clients.write")
  @ApiConsumes("multipart/form-data")
  @ApiOperation({
    summary:
      "Parse CSV or XLSX into bounded headers and rows for column mapping",
  })
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 0, parts: 1 },
    }),
  )
  async parse(
    @UploadedFile()
    file?: {
      originalname: string;
      buffer: Buffer;
      size: number;
    },
  ) {
    if (!file)
      throw new BadRequestException(
        "Attach one CSV or XLSX file in the file field",
      );
    return { item: await parseImportFile(file.originalname, file.buffer) };
  }
  @Post("preview")
  @Permissions("clients.write")
  @ApiOperation({
    summary:
      "Validate mapped rows and preview create, update, skip and row errors",
  })
  async preview(@CurrentContext() ctx: RequestContext, @Body() body: unknown) {
    const input = parseBody(importRequestSchema, body);
    return this.db.withTenant(ctx.businessId, async (tx) => ({
      item: await previewImport(tx, input),
    }));
  }
  @Post("commit")
  @Permissions("clients.write")
  @ApiOperation({
    summary:
      "Commit mapped import; requires an Idempotency-Key scoped to this business",
  })
  async commit(
    @CurrentContext() ctx: RequestContext,
    @Body() body: unknown,
    @Headers("idempotency-key") rawKey: unknown,
  ) {
    const input = parseBody(importRequestSchema, body);
    if (
      typeof rawKey !== "string" ||
      !rawKey.trim() ||
      rawKey.length > 160 ||
      /[^\x20-\x7e]/.test(rawKey)
    )
      throw new BadRequestException(
        "Idempotency-Key must contain 1–160 printable characters",
      );
    const key = rawKey.trim();
    // Object key order is irrelevant; row order defines which duplicate wins.
    const canonical = {
      rows: input.rows.map((r) =>
        Object.fromEntries(
          Object.entries(r).sort(([a], [b]) => a.localeCompare(b)),
        ),
      ),
      mapping: Object.fromEntries(
        Object.entries(input.mapping).sort(([a], [b]) => a.localeCompare(b)),
      ),
      duplicateMode: input.duplicateMode,
      decisions: [...(input.decisions ?? [])].sort((a,b)=>a.rowNumber-b.rowNumber),
    };
    const digest = createHash("sha256")
      .update(JSON.stringify(canonical))
      .digest("hex");
    return this.db.withTenant(ctx.businessId, async (tx) => {
      await lockContacts(tx, ctx.businessId);
      const previous = await tx.query<{ digest: string; result: unknown }>(
        "SELECT digest,result FROM client_import_requests WHERE idempotency_key=$1",
        [key],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].digest !== digest)
          throw new ConflictException(
            "Idempotency-Key was already used for different import content",
          );
        return { item: previous.rows[0].result };
      }
      const result = await commitImport(
        tx,
        ctx.businessId,
        input,
        ctx.requestId,
      );
      await tx.query(
        "INSERT INTO client_import_requests(business_id,idempotency_key,digest,result) VALUES($1,$2,$3,$4)",
        [ctx.businessId, key, digest, JSON.stringify(result)],
      );
      return { item: result };
    });
  }
}
