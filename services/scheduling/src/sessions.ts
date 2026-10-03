import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import {
  CurrentContext,
  Database,
  emitEvent,
  parseBody,
  Roles,
} from "@palladium/service-kit";
import type { PoolClient } from "pg";
import type { RequestContext } from "@palladium/contracts";
import {
  createSessionSchema,
  listSessionsSchema,
  SessionInput,
  updateSessionSchema,
  uuid,
  validInterval,
} from "./schemas.js";

type Row = {
  id: string;
  business_id: string;
  client_id: string;
  assigned_tutor_id: string | null;
  title: string;
  subject: string;
  starts_at: Date;
  ends_at: Date;
  status: string;
  created_at: Date;
  updated_at: Date;
};
export function sessionView(row: Row) {
  return {
    id: row.id,
    businessId: row.business_id,
    clientId: row.client_id,
    assignedTutorId: row.assigned_tutor_id,
    title: row.title,
    subject: row.subject,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
async function lockBusiness(tx: PoolClient, businessId: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `${businessId}:scheduling`,
  ]);
}
function rethrowConflict(error: unknown): never {
  if ((error as { code?: string }).code === "23P01")
    throw new ConflictException(
      "The student or assigned tutor already has a session during this time",
    );
  throw error;
}
@Injectable()
export class SessionsService {
  constructor(@Inject(Database) private readonly db: Database) {}
  async list(ctx: RequestContext, query: unknown) {
    const filter = parseBody(listSessionsSchema, query);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const result = await tx.query<Row>(
        `SELECT * FROM sessions WHERE business_id=$1 AND ($2::uuid IS NULL OR client_id=$2) AND ($3::text IS NULL OR status=$3) ORDER BY starts_at DESC, id LIMIT $4`,
        [
          ctx.businessId,
          filter.clientId ?? null,
          filter.status ?? null,
          filter.limit,
        ],
      );
      return { items: result.rows.map(sessionView) };
    });
  }
  async create(ctx: RequestContext, body: unknown) {
    const parsed = parseBody(createSessionSchema, body);
    if (parsed.assignedTutorId && parsed.assignedTutorId !== ctx.sub)
      throw new ForbiddenException(
        "Assigning other tutors requires a verified membership lookup, which is not available yet",
      );
    const input = {
      ...parsed,
      assignedTutorId:
        parsed.assignedTutorId === undefined ? ctx.sub : parsed.assignedTutorId,
    };
    try {
      return await this.db.withTenant(ctx.businessId, async (tx) => {
        await lockBusiness(tx, ctx.businessId);
        const result = await tx.query<Row>(
          `INSERT INTO sessions(id,business_id,client_id,assigned_tutor_id,title,subject,starts_at,ends_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [
            randomUUID(),
            ctx.businessId,
            input.clientId,
            input.assignedTutorId ?? null,
            input.title,
            input.subject ?? "General",
            input.startsAt,
            input.endsAt,
            ctx.sub,
          ],
        );
        const item = sessionView(result.rows[0]!);
        await emitEvent(tx, {
          type: "scheduling.session-created.v1",
          producer: "scheduling",
          businessId: ctx.businessId,
          correlationId: ctx.requestId,
          data: {
            sessionId: item.id,
            clientId: item.clientId,
            startsAt: item.startsAt,
          },
        });
        return { item };
      });
    } catch (error) {
      rethrowConflict(error);
    }
  }
  async update(ctx: RequestContext, id: string, body: unknown) {
    parseBody(uuid, id);
    const patch = parseBody(updateSessionSchema, body);
    if (patch.assignedTutorId && patch.assignedTutorId !== ctx.sub)
      throw new ForbiddenException(
        "Assigning other tutors requires a verified membership lookup, which is not available yet",
      );
    try {
      return await this.db.withTenant(ctx.businessId, async (tx) => {
        await lockBusiness(tx, ctx.businessId);
        const existing = await tx.query<Row>(
          "SELECT * FROM sessions WHERE business_id=$1 AND id=$2 FOR UPDATE",
          [ctx.businessId, id],
        );
        const row = existing.rows[0];
        if (!row) throw new NotFoundException("Session not found");
        if (row.status !== "scheduled")
          throw new ConflictException("Only scheduled sessions can be edited");
        const previous = sessionView(row);
        const next: SessionInput = { ...previous, ...patch };
        if (!validInterval(next.startsAt, next.endsAt))
          throw new BadRequestException("endsAt must be after startsAt");
        const updated = await tx.query<Row>(
          `UPDATE sessions SET client_id=$3,assigned_tutor_id=$4,title=$5,subject=$6,starts_at=$7,ends_at=$8,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *`,
          [
            ctx.businessId,
            id,
            next.clientId,
            next.assignedTutorId ?? null,
            next.title,
            next.subject ?? "General",
            next.startsAt,
            next.endsAt,
          ],
        );
        return { item: sessionView(updated.rows[0]!) };
      });
    } catch (error) {
      rethrowConflict(error);
    }
  }
  async transition(
    ctx: RequestContext,
    id: string,
    status: "cancelled" | "completed",
  ) {
    parseBody(uuid, id);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      await lockBusiness(tx, ctx.businessId);
      const result = await tx.query<Row>(
        "SELECT * FROM sessions WHERE business_id=$1 AND id=$2 FOR UPDATE",
        [ctx.businessId, id],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException("Session not found");
      if (row.status === status) return { item: sessionView(row) };
      if (row.status !== "scheduled")
        throw new ConflictException(
          `Cannot mark a ${row.status} session ${status}`,
        );
      const changed = await tx.query<Row>(
        "UPDATE sessions SET status=$3,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *",
        [ctx.businessId, id, status],
      );
      const item = sessionView(changed.rows[0]!);
      if (status === "completed")
        await emitEvent(tx, {
          type: "scheduling.session-completed.v1",
          producer: "scheduling",
          businessId: ctx.businessId,
          correlationId: ctx.requestId,
          data: { sessionId: item.id, clientId: item.clientId },
        });
      return { item };
    });
  }
}
const sessionProperties = {
  clientId: { type: "string", format: "uuid" },
  title: { type: "string", maxLength: 200 },
  subject: { type: "string", maxLength: 100 },
  startsAt: {
    type: "string",
    format: "date-time",
    description: "ISO 8601 UTC with Z",
  },
  endsAt: {
    type: "string",
    format: "date-time",
    description: "After startsAt",
  },
  assignedTutorId: {
    type: "string",
    nullable: true,
    description:
      "Defaults to authenticated user; other tutor assignment unavailable",
  },
} as const;
@ApiTags("sessions")
@Roles("owner", "admin", "tutor")
@Controller("v1/sessions")
export class SessionsController {
  constructor(
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}
  @ApiQuery({ name: "clientId", required: false, type: String })
  @ApiQuery({
    name: "status",
    required: false,
    enum: ["scheduled", "cancelled", "completed"],
  })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @Get()
  @ApiOperation({
    summary: "List one-on-one sessions for the selected business",
  })
  list(@CurrentContext() ctx: RequestContext, @Query() query: unknown) {
    return this.sessions.list(ctx, query);
  }
  @ApiBody({
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["clientId", "title", "startsAt", "endsAt"],
      properties: sessionProperties,
    },
  })
  @Post()
  @ApiOperation({
    summary: "Schedule a one-on-one session; conflicting time returns 409",
  })
  create(@CurrentContext() ctx: RequestContext, @Body() body: unknown) {
    return this.sessions.create(ctx, body);
  }
  @ApiBody({
    schema: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: sessionProperties,
    },
  })
  @Patch(":id")
  @ApiOperation({ summary: "Edit a scheduled session" })
  update(
    @CurrentContext() ctx: RequestContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.sessions.update(ctx, id, body);
  }
  @Post(":id/cancel")
  @ApiOperation({ summary: "Cancel a scheduled session" })
  cancel(@CurrentContext() ctx: RequestContext, @Param("id") id: string) {
    return this.sessions.transition(ctx, id, "cancelled");
  }
  @Post(":id/complete")
  @ApiOperation({ summary: "Complete a scheduled session" })
  complete(@CurrentContext() ctx: RequestContext, @Param("id") id: string) {
    return this.sessions.transition(ctx, id, "completed");
  }
}
