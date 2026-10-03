import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  CurrentContext,
  Database,
  emitEvent,
  parseBody,
  Roles,
} from "@palladium/service-kit";
import type { RequestContext } from "@palladium/contracts";
import {
  clientIdSchema,
  createClientSchema,
  listClientsSchema,
  payerRelationshipSchema,
  updateClientSchema,
} from "./schemas.js";

import {
  createContact,
  item,
  lockContacts,
  requireClient,
  updateContact,
  type ClientRow,
} from "./contact-store.js";

@ApiTags("clients")
@Roles("owner", "admin", "tutor")
@Controller("v1/clients")
export class ClientsController {
  constructor(@Inject(Database) private readonly db: Database) {}

  @Get()
  @ApiOperation({
    summary: "List student/payer records, bounded to 100 items; staff only",
  })
  async list(@CurrentContext() ctx: RequestContext, @Query() query: unknown) {
    const { kind, status, search, limit, offset } = parseBody(
      listClientsSchema,
      query,
    );
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const pattern = search ? `%${search.replace(/[\\%_]/g, "\\$&")}%` : null;
      const filter = `($1::text IS NULL OR kind=$1) AND ($2::text IS NULL OR status=$2)
        AND ($3::text IS NULL OR display_name ILIKE $3 OR first_name ILIKE $3 OR last_name ILIKE $3
          OR email ILIKE $3 OR phone ILIKE $3 OR array_to_string(tags,', ') ILIKE $3)`;
      const values = [kind ?? null, status ?? null, pattern];
      const result = await tx.query<ClientRow>(
        `SELECT * FROM clients WHERE ${filter} ORDER BY created_at DESC,id LIMIT $4 OFFSET $5`,
        [...values, limit, offset],
      );
      const count = await tx.query<{ total: string }>(
        `SELECT count(*) AS total FROM clients WHERE ${filter}`,
        values,
      );
      return {
        items: result.rows.map(item),
        total: Number(count.rows[0]!.total),
        limit,
        offset,
      };
    });
  }

  @Post()
  @ApiOperation({ summary: "Create a contact with editable CRM properties" })
  async create(@CurrentContext() ctx: RequestContext, @Body() body: unknown) {
    const input = parseBody(createClientSchema, body);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      await lockContacts(tx, ctx.businessId);
      return {
        item: item(
          await createContact(tx, ctx.businessId, input, ctx.requestId),
        ),
      };
    });
  }

  @Get(":id")
  @ApiOperation({ summary: "Get one client within the verified business" })
  async get(@CurrentContext() ctx: RequestContext, @Param("id") value: string) {
    const id = parseBody(clientIdSchema, value);
    return this.db.withTenant(ctx.businessId, async (tx) => ({
      item: item(await requireClient(tx, id)),
    }));
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a client; student/payer kind is immutable" })
  async update(
    @CurrentContext() ctx: RequestContext,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    const id = parseBody(clientIdSchema, value);
    const input = parseBody(updateClientSchema, body);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      await lockContacts(tx, ctx.businessId);
      return {
        item: item(
          await updateContact(tx, ctx.businessId, id, input, ctx.requestId),
        ),
      };
    });
  }

  @Delete(":id")
  @Roles("owner", "admin")
  @ApiOperation({
    summary:
      "Delete a contact and its local payer/source links; owner/admin only",
  })
  async remove(
    @CurrentContext() ctx: RequestContext,
    @Param("id") value: string,
  ) {
    const id = parseBody(clientIdSchema, value);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      await lockContacts(tx, ctx.businessId);
      await requireClient(tx, id);
      await tx.query("DELETE FROM clients WHERE id=$1", [id]);
      await emitEvent(tx, {
        type: "clients.client-deleted.v1",
        producer: "clients",
        businessId: ctx.businessId,
        correlationId: ctx.requestId,
        data: { clientId: id },
      });
      return { item: { id, deleted: true } };
    });
  }

  @Get(":id/payers")
  @ApiOperation({
    summary: "List payer relationships for a student; staff only",
  })
  async payers(
    @CurrentContext() ctx: RequestContext,
    @Param("id") value: string,
  ) {
    const id = parseBody(clientIdSchema, value);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const student = await requireClient(tx, id);
      if (student.kind !== "student")
        throw new ConflictException("Payer relationships require a student");
      const result = await tx.query<ClientRow & { relationship: string }>(
        `SELECT c.*, cp.relationship FROM client_payers cp JOIN clients c ON c.business_id=cp.business_id AND c.id=cp.payer_id WHERE cp.student_id=$1 ORDER BY cp.created_at DESC,c.id LIMIT 100`,
        [id],
      );
      return {
        items: result.rows.map((row) => ({
          studentId: id,
          payerId: row.id,
          relationship: row.relationship,
          payer: item(row),
        })),
      };
    });
  }

  @Post(":id/payers")
  @ApiOperation({
    summary:
      "Create or revise a relationship between a student and a payer in the same business",
  })
  async linkPayer(
    @CurrentContext() ctx: RequestContext,
    @Param("id") value: string,
    @Body() body: unknown,
  ) {
    const studentId = parseBody(clientIdSchema, value);
    const input = parseBody(payerRelationshipSchema, body);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      await lockContacts(tx, ctx.businessId);
      const student = await requireClient(tx, studentId);
      const payer = await requireClient(tx, input.payerId);
      if (student.kind !== "student" || payer.kind !== "payer")
        throw new ConflictException(
          "A relationship requires a student and a separate payer record",
        );
      await tx.query(
        `INSERT INTO client_payers (business_id,student_id,payer_id,relationship) VALUES ($1,$2,$3,$4) ON CONFLICT (business_id,student_id,payer_id) DO UPDATE SET relationship=EXCLUDED.relationship`,
        [ctx.businessId, studentId, input.payerId, input.relationship],
      );
      await emitEvent(tx, {
        type: "clients.payer-linked.v1",
        producer: "clients",
        businessId: ctx.businessId,
        correlationId: ctx.requestId,
        data: { clientId: studentId, payerId: input.payerId },
      });
      return {
        item: {
          studentId,
          payerId: input.payerId,
          relationship: input.relationship,
        },
      };
    });
  }
}
