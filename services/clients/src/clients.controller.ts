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
  Permissions,
} from "@palladium/service-kit";
import type { RequestContext } from "@palladium/contracts";
import {
  clientIdSchema,
  createClientSchema,
  listClientsSchema,
  payerRelationshipSchema,
  updateClientSchema,
} from "./schemas.js";

import { buildClientQuery } from "./client-query.js";

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
  @Permissions("clients.read")
  @ApiOperation({
    summary: "List student/payer records, bounded to 100 items; staff only",
  })
  async list(@CurrentContext() ctx: RequestContext, @Query() query: unknown) {
    const input = parseBody(listClientsSchema, query);
    const { limit, offset } = input;
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const filter = await buildClientQuery(tx, input);
      const count = await tx.query<{ total: string }>(
        `SELECT count(*) AS total FROM clients WHERE ${filter.where}`,
        filter.countValues,
      );
      const result = await tx.query<ClientRow>(
        `SELECT * FROM clients WHERE ${filter.where} ORDER BY ${filter.order} LIMIT $${filter.values.length + 1} OFFSET $${filter.values.length + 2}`,
        [...filter.values, limit, offset],
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
  @Permissions("clients.write")
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
  @Permissions("clients.read")
  @ApiOperation({ summary: "Get one client within the verified business" })
  async get(@CurrentContext() ctx: RequestContext, @Param("id") value: string) {
    const id = parseBody(clientIdSchema, value);
    return this.db.withTenant(ctx.businessId, async (tx) => ({
      item: item(await requireClient(tx, id)),
    }));
  }

  @Patch(":id")
  @Permissions("clients.write")
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
  @Permissions("clients.write")
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
      const client=await requireClient(tx, id);
      if(client.id!==id) throw new ConflictException("Merged identities must be retained");
      if(client.portal_protected_at) throw new ConflictException("Portal protected students cannot be deleted");
      const aliases=await tx.query("SELECT 1 FROM clients WHERE merged_into=$1 LIMIT 1",[id]);
      if(aliases.rowCount) throw new ConflictException("A merge survivor must be retained");
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
  @Permissions("clients.read")
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
        [student.id],
      );
      return {
        items: result.rows.map((row) => ({
          studentId: student.id,
          payerId: row.id,
          relationship: row.relationship,
          payer: item(row),
        })),
      };
    });
  }

  @Post(":id/payers")
  @Permissions("clients.write")
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
        [ctx.businessId, student.id, payer.id, input.relationship],
      );
      await tx.query(`INSERT INTO student_contacts(business_id,student_id,contact_id,relationship) VALUES($1,$2,$3,$4) ON CONFLICT(business_id,student_id,contact_id) DO UPDATE SET relationship=EXCLUDED.relationship`,[ctx.businessId,student.id,payer.id,input.relationship]);
      await tx.query("UPDATE clients SET revision=revision+1 WHERE id=$1",[student.id]);
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
