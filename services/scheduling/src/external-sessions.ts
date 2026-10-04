import { refreshClass } from "./class-ledger.js";
import { randomUUID } from "node:crypto";
import { Controller, Get, Inject, Injectable, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  CurrentContext,
  Database,
  EventBus,
  parseBody,
  Roles,
} from "@palladium/service-kit";
import type { RequestContext } from "@palladium/contracts";
import { z } from "zod";
const session = z
  .object({
    externalId: z.string().min(1).max(512),
    title: z.string().min(1).max(200),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    status: z.enum(["scheduled", "completed", "cancelled"]),
    attendeeName: z.string().max(200).optional(),
    attendeeEmail: z.string().email().max(254).optional(),
    bookingUrl: z
      .string()
      .url()
      .max(2048)
      .refine((v) => {
        try {
          const u = new URL(v);
          return u.protocol === "https:" && !u.username && !u.password;
        } catch {
          return false;
        }
      })
      .optional(),
  })
  .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt));
const sync = z.object({
  connectionId: z.string().uuid(),
  provider: z.enum(["calendly", "calcom"]),
  ownerUserId: z.string().min(1).max(128),
  sessions: z.array(session).max(200),
});
const disconnected = z.object({ connectionId: z.string().uuid() });
const maximumRangeMs = 93 * 24 * 60 * 60 * 1000;
const filter = z
  .object({
    status: z.enum(["scheduled", "completed", "cancelled"]).optional(),
    connectionId: z.string().uuid().optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.from === undefined) !== (value.to === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: [value.from === undefined ? "from" : "to"],
        message: "from and to must be supplied together",
      });
      return;
    }
    if (value.from !== undefined && value.to !== undefined) {
      const duration = Date.parse(value.to) - Date.parse(value.from);
      if (duration <= 0 || duration > maximumRangeMs)
        ctx.addIssue({
          code: "custom",
          path: ["to"],
          message:
            "to must be after from and the range must not exceed 93 days",
        });
    }
  });
@Injectable()
export class ExternalSessionsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(EventBus) private readonly events: EventBus,
  ) {}
  onModuleInit() {
    this.events.subscribe(
      "integrations.sessions-synced.v1",
      async (event, tx) => {
        if (event.producer !== "integrations")
          throw new Error("Invalid session source");
        const data = sync.parse(event.data);
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `external-sessions:${event.businessId}:${data.connectionId}`,
        ]);
        const revoked = await tx.query(
          "SELECT 1 FROM disconnected_session_sources WHERE business_id=$1 AND connection_id=$2",
          [event.businessId, data.connectionId],
        );
        if (revoked.rowCount) return;
        for (const item of data.sessions) {
          const changed = await tx.query(
            `INSERT INTO external_sessions(id,business_id,connection_id,provider,external_id,owner_user_id,title,starts_at,ends_at,status,attendee_name,attendee_email,booking_url,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(business_id,connection_id,external_id) DO UPDATE SET title=EXCLUDED.title,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,status=EXCLUDED.status,attendee_name=EXCLUDED.attendee_name,attendee_email=EXCLUDED.attendee_email,booking_url=EXCLUDED.booking_url,updated_at=EXCLUDED.updated_at WHERE external_sessions.updated_at<=EXCLUDED.updated_at RETURNING id`,
            [
              randomUUID(),
              event.businessId,
              data.connectionId,
              data.provider,
              item.externalId,
              data.ownerUserId,
              item.title,
              item.startsAt,
              item.endsAt,
              item.status,
              item.attendeeName ?? null,
              item.attendeeEmail ?? null,
              item.bookingUrl ?? null,
              event.occurredAt,
            ],
          );
          if (changed.rows[0])
            await refreshClass(
              tx,
              event.businessId,
              "external",
              changed.rows[0].id,
              event.correlationId,
            );
        }
      },
    );
    this.events.subscribe(
      "integrations.connection-disconnected.v1",
      async (event, tx) => {
        if (event.producer !== "integrations")
          throw new Error("Invalid session source");
        const data = disconnected.parse(event.data);
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `external-sessions:${event.businessId}:${data.connectionId}`,
        ]);
        await tx.query(
          "INSERT INTO disconnected_session_sources(business_id,connection_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [event.businessId, data.connectionId],
        );
        await tx.query(
          "DELETE FROM external_sessions WHERE business_id=$1 AND connection_id=$2",
          [event.businessId, data.connectionId],
        );
      },
    );
  }
  async list(ctx: RequestContext, query: unknown) {
    const parsed = parseBody(filter, query);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const conditions = `business_id=$1
        AND ($2::text IS NULL OR status=$2)
        AND ($3::uuid IS NULL OR connection_id=$3)
        AND ($4::text IS NULL OR owner_user_id=$4)
        AND ($5::timestamptz IS NULL OR (starts_at<$6::timestamptz AND ends_at>$5::timestamptz))`;
      const parameters = [
        ctx.businessId,
        parsed.status ?? null,
        parsed.connectionId ?? null,
        ctx.role === "tutor" ? ctx.sub : null,
        parsed.from ?? null,
        parsed.to ?? null,
      ];
      const total = Number(
        (
          await tx.query(
            `SELECT COUNT(*) AS total FROM external_sessions WHERE ${conditions}`,
            parameters,
          )
        ).rows[0].total,
      );
      const rows = (
        await tx.query(
          `SELECT * FROM external_sessions WHERE ${conditions} ORDER BY starts_at ${parsed.from === undefined ? "DESC" : "ASC"},id LIMIT $7 OFFSET $8`,
          [...parameters, parsed.limit, parsed.offset],
        )
      ).rows;
      return {
        items: rows.map((row) => ({
          id: row.id,
          businessId: row.business_id,
          connectionId: row.connection_id,
          provider: row.provider,
          externalId: row.external_id,
          ownerUserId: row.owner_user_id,
          title: row.title,
          startsAt: row.starts_at.toISOString(),
          endsAt: row.ends_at.toISOString(),
          status: row.status,
          attendeeName: row.attendee_name,
          attendeeEmail: row.attendee_email,
          bookingUrl: row.booking_url,
          source: "external",
          readOnly: true,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        })),
        total,
        limit: parsed.limit,
        offset: parsed.offset,
      };
    });
  }
}
@ApiTags("external-sessions")
@Roles("owner", "admin", "tutor")
@Controller("v1/external-sessions")
export class ExternalSessionsController {
  constructor(
    @Inject(ExternalSessionsService)
    private readonly service: ExternalSessionsService,
  ) {}
  @Get() list(@CurrentContext() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, query);
  }
}
