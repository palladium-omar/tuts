import { Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentContext, Database, emitEvent, parseBody, Roles } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { clientIdSchema, createClientSchema, listClientsSchema, payerRelationshipSchema, updateClientSchema } from './schemas.js';

type ClientRow = { id: string; kind: 'student' | 'payer'; display_name: string; email: string | null; phone: string | null; notes: string | null; created_at: Date; updated_at: Date };
const item = (row: ClientRow) => ({ id: row.id, kind: row.kind, displayName: row.display_name, email: row.email, phone: row.phone, notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at });
async function requireClient(tx: PoolClient, id: string): Promise<ClientRow> {
  const result = await tx.query<ClientRow>('SELECT * FROM clients WHERE id=$1', [id]);
  if (!result.rows[0]) throw new NotFoundException('Client was not found');
  return result.rows[0];
}

@ApiTags('clients')
@Roles('owner', 'admin', 'tutor')
@Controller('v1/clients')
export class ClientsController {
  constructor(@Inject(Database) private readonly db: Database) {}

  @Get()
  @ApiOperation({ summary: 'List student/payer records, bounded to 100 items; staff only' })
  async list(@CurrentContext() ctx: RequestContext, @Query() query: unknown) {
    const { kind, limit, offset } = parseBody(listClientsSchema, query);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const result = await tx.query<ClientRow>('SELECT * FROM clients WHERE ($1::text IS NULL OR kind=$1) ORDER BY created_at DESC,id LIMIT $2 OFFSET $3', [kind ?? null, limit, offset]);
      return { items: result.rows.map(item) };
    });
  }

  @Post()
  @ApiOperation({ summary: 'Create a student or payer and transactionally emit clients.client-created.v1' })
  async create(@CurrentContext() ctx: RequestContext, @Body() body: unknown) {
    const input = parseBody(createClientSchema, body);
    const id = randomUUID();
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const result = await tx.query<ClientRow>('INSERT INTO clients (business_id,id,kind,display_name,email,phone,notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [ctx.businessId, id, input.kind, input.displayName, input.email ?? null, input.phone ?? null, input.notes ?? null]);
      await emitEvent(tx, { type: 'clients.client-created.v1', producer: 'clients', businessId: ctx.businessId, correlationId: ctx.requestId, data: { clientId: id } });
      return { item: item(result.rows[0]!) };
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one client within the verified business' })
  async get(@CurrentContext() ctx: RequestContext, @Param('id') value: string) {
    const id = parseBody(clientIdSchema, value);
    return this.db.withTenant(ctx.businessId, async (tx) => ({ item: item(await requireClient(tx, id)) }));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a client; student/payer kind is immutable' })
  async update(@CurrentContext() ctx: RequestContext, @Param('id') value: string, @Body() body: unknown) {
    const id = parseBody(clientIdSchema, value);
    const input = parseBody(updateClientSchema, body);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      // One SQL statement avoids lost updates between independent partial changes.
      const result = await tx.query<ClientRow>(`UPDATE clients SET
        display_name=CASE WHEN $2::boolean THEN $3::text ELSE display_name END,
        email=CASE WHEN $4::boolean THEN $5::text ELSE email END,
        phone=CASE WHEN $6::boolean THEN $7::text ELSE phone END,
        notes=CASE WHEN $8::boolean THEN $9::text ELSE notes END,
        updated_at=now() WHERE id=$1 RETURNING *`,
      [id, 'displayName' in input, input.displayName ?? null, 'email' in input, input.email ?? null, 'phone' in input, input.phone ?? null, 'notes' in input, input.notes ?? null]);
      if (!result.rows[0]) throw new NotFoundException('Client was not found');
      await emitEvent(tx, { type: 'clients.client-updated.v1', producer: 'clients', businessId: ctx.businessId, correlationId: ctx.requestId, data: { clientId: id } });
      return { item: item(result.rows[0]) };
    });
  }

  @Get(':id/payers')
  @ApiOperation({ summary: 'List payer relationships for a student; staff only' })
  async payers(@CurrentContext() ctx: RequestContext, @Param('id') value: string) {
    const id = parseBody(clientIdSchema, value);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const student = await requireClient(tx, id);
      if (student.kind !== 'student') throw new ConflictException('Payer relationships require a student');
      const result = await tx.query<ClientRow & {relationship: string}>(`SELECT c.*, cp.relationship FROM client_payers cp JOIN clients c ON c.business_id=cp.business_id AND c.id=cp.payer_id WHERE cp.student_id=$1 ORDER BY cp.created_at DESC,c.id LIMIT 100`, [id]);
      return { items: result.rows.map((row) => ({ studentId: id, payerId: row.id, relationship: row.relationship, payer: item(row) })) };
    });
  }

  @Post(':id/payers')
  @ApiOperation({ summary: 'Create or revise a relationship between a student and a payer in the same business' })
  async linkPayer(@CurrentContext() ctx: RequestContext, @Param('id') value: string, @Body() body: unknown) {
    const studentId = parseBody(clientIdSchema, value);
    const input = parseBody(payerRelationshipSchema, body);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const student = await requireClient(tx, studentId);
      const payer = await requireClient(tx, input.payerId);
      if (student.kind !== 'student' || payer.kind !== 'payer') throw new ConflictException('A relationship requires a student and a separate payer record');
      await tx.query(`INSERT INTO client_payers (business_id,student_id,payer_id,relationship) VALUES ($1,$2,$3,$4) ON CONFLICT (business_id,student_id,payer_id) DO UPDATE SET relationship=EXCLUDED.relationship`, [ctx.businessId, studentId, input.payerId, input.relationship]);
      await emitEvent(tx, { type: 'clients.payer-linked.v1', producer: 'clients', businessId: ctx.businessId, correlationId: ctx.requestId, data: { clientId: studentId, payerId: input.payerId } });
      return { item: { studentId, payerId: input.payerId, relationship: input.relationship } };
    });
  }
}
