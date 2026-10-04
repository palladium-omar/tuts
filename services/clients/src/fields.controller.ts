import {
  Body,
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { RequestContext } from "@palladium/contracts";
import {
  CurrentContext,
  Database,
  Roles,
  parseBody,
  emitEvent,
} from "@palladium/service-kit";
import { clientIdSchema } from "./schemas.js";
import {
  createFieldSchema,
  updateFieldSchema,
  loadFields,
  requireField,
  fieldItem,
  type FieldRow,
} from "./custom-fields.js";
import { lockContacts } from "./contact-store.js";

@Roles("owner", "admin", "tutor")
@Controller("v1/fields")
export class FieldsController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Get()
  async list(@CurrentContext() ctx: RequestContext) {
    return this.db.withTenant(ctx.businessId, async (tx) => ({
      items: (await loadFields(tx)).map(fieldItem),
    }));
  }
  @Post()
  @Roles("owner", "admin")
  async create(@CurrentContext() ctx: RequestContext, @Body() body: unknown) {
    const input = parseBody(createFieldSchema, body);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      await lockContacts(tx, ctx.businessId);
      if ((await loadFields(tx)).length >= 100)
        throw new BadRequestException("At most 100 CRM fields per business");
      const id = randomUUID();
      const row = (
        await tx.query<FieldRow>(
          "INSERT INTO client_fields(business_id,id,key,label,type,options) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *",
          [
            ctx.businessId,
            id,
            `field_${id.replaceAll("-", "")}`,
            input.label,
            input.type,
            input.options ? JSON.stringify(input.options) : null,
          ],
        )
      ).rows[0]!;
      await emitEvent(tx, {
        type: "clients.field-created.v1",
        producer: "clients",
        businessId: ctx.businessId,
        correlationId: ctx.requestId,
        data: { fieldId: row.id },
      });
      return { item: fieldItem(row) };
    });
  }
  @Patch(":id")
  @Roles("owner", "admin")
  async update(
    @CurrentContext() ctx: RequestContext,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    const id = parseBody(clientIdSchema, value),
      input = parseBody(updateFieldSchema, body);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      await lockContacts(tx, ctx.businessId);
      const current = await requireField(tx, id);
      if (input.options && current.type !== "select")
        throw new BadRequestException("Only select fields have options");
      if (input.options) {
        const used = await tx.query(
          "SELECT 1 FROM clients WHERE custom_fields ->> $1::text IS NOT NULL AND NOT (custom_fields ->> $1::text = ANY($2::text[])) LIMIT 1",
          [id, input.options],
        );
        if (used.rowCount)
          throw new ConflictException(
            "Options used by existing contacts cannot be removed",
          );
      }
      const row = (
        await tx.query<FieldRow>(
          "UPDATE client_fields SET label=$2,options=$3::jsonb WHERE id=$1 RETURNING *",
          [
            id,
            input.label ?? current.label,
            input.options
              ? JSON.stringify(input.options)
              : current.options
                ? JSON.stringify(current.options)
                : null,
          ],
        )
      ).rows[0]!;
      await emitEvent(tx, {
        type: "clients.field-updated.v1",
        producer: "clients",
        businessId: ctx.businessId,
        correlationId: ctx.requestId,
        data: { fieldId: row.id },
      });
      return { item: fieldItem(row) };
    });
  }
}
