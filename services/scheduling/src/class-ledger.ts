import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Query,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import {
  CurrentContext,
  Database,
  Roles,
  parseBody,
  emitEvent,
  Permissions,
  StudentScoped,
} from "@palladium/service-kit";
import {isStudentScope,requireStudentScope,assertCanonicalOverlap,canonicalStudent} from "./student-scope.js";
import type { RequestContext } from "@palladium/contracts";
import type { PoolClient } from "pg";
import { z } from "zod";
const month = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .refine(
    (v) => Number(v.slice(0, 4)) >= 2000 && Number(v.slice(0, 4)) <= 2200,
  );
const zone = z
  .string()
  .max(100)
  .refine((v) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }, "Invalid IANA time zone");
const filter = z.object({ month, timeZone: zone.default("UTC") }).strict();
const patch = z
  .object({
    clientId: z.uuid().nullable().optional(),
    status: z.enum(["completed", "cancelled", "scheduled", "no_show"]),
  })
  .strict();
const sourceSchema = z.enum(["internal", "external"]);
const iso = (value: Date | string) => new Date(value).toISOString();
export const ledgerItem = (r: Record<string, any>) => ({
  id: r.class_id,
  classId: r.class_id,
  source: r.source,
  title: r.title,
  clientId: r.client_id ?? null,
  studentId: r.client_id ?? null,
  assignedTutorId: r.assigned_tutor_id ?? null,
  connectionId: r.connection_id ?? null,
  attendanceSource: r.attendance_source ?? "session",
  attendeeEmail: r.attendee_email ?? null,
  startsAt: iso(r.starts_at),
  endsAt: iso(r.ends_at),
  status: r.status,
  providerStatus: r.provider_status ?? null,
  revision: Number(r.revision),
  updatedAt: iso(r.updated_at),
});
export const sourceUnion = `SELECT business_id,id AS class_id,'internal'::text AS source,scheduling_canonical_student(client_id) AS client_id,title,NULL::text AS attendee_email,starts_at,ends_at,status,NULL::text AS provider_status,assigned_tutor_id,NULL::uuid AS connection_id,'session'::text AS attendance_source FROM sessions
 UNION ALL SELECT e.business_id,e.id,'external',scheduling_canonical_student(a.client_id),e.title,e.attendee_email,e.starts_at,e.ends_at,coalesce(a.status,CASE WHEN e.status='completed' THEN 'scheduled' ELSE e.status END),e.status,e.owner_user_id,e.connection_id,CASE WHEN a.status IS NULL THEN 'provider' ELSE 'tutor' END FROM external_sessions e LEFT JOIN class_annotations a ON a.business_id=e.business_id AND a.source='external' AND a.class_id=e.id`;
export const ledgerColumns = 'business_id,class_id,source,client_id,title,attendee_email,starts_at,ends_at,status,provider_status,assigned_tutor_id,connection_id,attendance_source';
export const ledgerUpsert = `ON CONFLICT(business_id,source,class_id) DO UPDATE SET
 client_id=EXCLUDED.client_id,title=EXCLUDED.title,attendee_email=EXCLUDED.attendee_email,
 starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,status=EXCLUDED.status,
 provider_status=EXCLUDED.provider_status,assigned_tutor_id=EXCLUDED.assigned_tutor_id,
 connection_id=EXCLUDED.connection_id,attendance_source=EXCLUDED.attendance_source,
 revision=class_ledger.revision+1,updated_at=now()
 WHERE (class_ledger.client_id,class_ledger.title,class_ledger.attendee_email,class_ledger.starts_at,class_ledger.ends_at,class_ledger.status,class_ledger.provider_status,class_ledger.assigned_tutor_id,class_ledger.connection_id,class_ledger.attendance_source)
 IS DISTINCT FROM (EXCLUDED.client_id,EXCLUDED.title,EXCLUDED.attendee_email,EXCLUDED.starts_at,EXCLUDED.ends_at,EXCLUDED.status,EXCLUDED.provider_status,EXCLUDED.assigned_tutor_id,EXCLUDED.connection_id,EXCLUDED.attendance_source) RETURNING *`;
export async function emitClassSnapshot(tx: PoolClient,businessId:string,row:Record<string,any>,correlationId?:string) {
 const item=ledgerItem(row);
 await emitEvent(tx,{type:'scheduling.class-updated.v1',producer:'scheduling',businessId,correlationId,
  data:{classId:item.id,source:item.source,clientId:item.clientId,studentId:item.studentId,title:item.title,
   assignedTutorId:item.assignedTutorId,connectionId:item.connectionId,attendanceSource:item.attendanceSource,
   startsAt:item.startsAt,endsAt:item.endsAt,status:item.status,providerStatus:item.providerStatus,revision:item.revision}});
 return item;
}
export async function normalizeLegacyAttendance(tx:PoolClient,businessId:string,where:string,values:unknown[],correlationId?:string) {
  // Retained disconnected classes have no live provider row to refresh. Preserve
  // any explicit annotation; elapsed-time completion alone remains unverified.
  const changed=await tx.query(`UPDATE class_ledger l SET
    status=coalesce((SELECT a.status FROM class_annotations a WHERE a.source=l.source AND a.class_id=l.class_id),
      CASE WHEN l.provider_status='completed' THEN 'scheduled' ELSE l.status END),
    attendance_source=CASE WHEN EXISTS (SELECT 1 FROM class_annotations a WHERE a.source=l.source AND a.class_id=l.class_id AND a.status IS NOT NULL) THEN 'tutor' ELSE 'provider' END,
    revision=revision+1,updated_at=now()
    WHERE source='external' AND attendance_source='session' AND (${where}) RETURNING *`,values);
  for(const row of changed.rows) await emitClassSnapshot(tx,businessId,row,correlationId);
}

export async function refreshClass(
  tx: PoolClient,
  businessId: string,
  source: "internal" | "external",
  id: string,
  correlationId?: string,
) {
  const result=await tx.query(`INSERT INTO class_ledger(${ledgerColumns})
    SELECT ${ledgerColumns} FROM (${sourceUnion}) s WHERE source=$1 AND class_id=$2 ${ledgerUpsert}`,[source,id]);
  return result.rows[0] ? emitClassSnapshot(tx,businessId,result.rows[0],correlationId) : undefined;
}

@Roles("owner", "admin", "tutor")
@StudentScoped()
@Controller("v1/class-ledger")
export class ClassLedgerController {
  constructor(
    @Inject(Database)
    private readonly db: Database,
  ) {}
  @Permissions("scheduling.read")
  @Get()
  async list(
    @CurrentContext()
    ctx: RequestContext,
    @Query()
    query: unknown,
  ) {
    const input = parseBody(filter, query);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const values = [`${input.month}-01`, input.timeZone,!isStudentScope(ctx),ctx.studentIds??[]];
      const sourceTotal = Number(
        (
          await tx.query(
            `SELECT count(*) AS total FROM (${sourceUnion}) s WHERE (starts_at AT TIME ZONE $2)::date >= $1::date AND (starts_at AT TIME ZONE $2)::date < ($1::date + INTERVAL '1 month') AND ($3::boolean OR client_id=ANY($4::uuid[]))`,
            values,
          )
        ).rows[0].total,
      );
      if (sourceTotal > 10000)
        throw new BadRequestException(
          "Monthly class ledger exceeds 10000 classes; narrow the business data before billing",
        );
      const seeded = await tx.query(
        `INSERT INTO class_ledger(${ledgerColumns})
       SELECT ${ledgerColumns} FROM (${sourceUnion}) s WHERE (starts_at AT TIME ZONE $2)::date >= $1::date AND (starts_at AT TIME ZONE $2)::date < ($1::date + INTERVAL '1 month') AND ($3::boolean OR client_id=ANY($4::uuid[])) LIMIT 10001 ${ledgerUpsert}`,
        values,
      );
      for (const row of seeded.rows)
        await emitClassSnapshot(tx,ctx.businessId,row,ctx.requestId);
      const where = `(starts_at AT TIME ZONE $2)::date >= $1::date AND (starts_at AT TIME ZONE $2)::date < ($1::date + INTERVAL '1 month') AND ($3::boolean OR client_id=ANY($4::uuid[]))`;
      const total = Number(
        (
          await tx.query(
            `SELECT count(*) AS total FROM class_ledger WHERE ${where}`,
            values,
          )
        ).rows[0].total,
      );
      if (total > 10000)
        throw new BadRequestException(
          "Monthly class ledger exceeds 10000 classes; narrow the business data before billing",
        );
      await normalizeLegacyAttendance(tx,ctx.businessId,where,values,ctx.requestId);
      const rows = (
        await tx.query(
          `SELECT * FROM class_ledger WHERE ${where} ORDER BY starts_at,source,class_id LIMIT 10000`,
          values,
        )
      ).rows;
      return { items: rows.map(ledgerItem), total, truncated: false, ...input };
    });
  }
  @Permissions("scheduling.write")
  @Patch(":source/:id")
  async annotate(
    @CurrentContext()
    ctx: RequestContext,
    @Param("source")
    sourceValue: string,
    @Param("id")
    idValue: string,
    @Body()
    body: unknown,
  ) {
    const source = parseBody(sourceSchema, sourceValue),
      id = parseBody(z.uuid(), idValue),
      input = parseBody(patch, body);
    return this.db
      .withTenant(ctx.businessId, async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `${ctx.businessId}:scheduling`,
        ]);
        let row = (
          await tx.query(
            `SELECT * FROM ${source === "internal" ? "sessions" : "external_sessions"} WHERE id=$1 FOR UPDATE`,
            [id],
          )
        ).rows[0];
        const liveSource = Boolean(row);
        if (!row && source === "external")
          row = (
            await tx.query(
              "SELECT * FROM class_ledger WHERE source='external' AND class_id=$1 FOR UPDATE",
              [id],
            )
          ).rows[0];
        if (!row) throw new NotFoundException("Class not found");
        let currentStudent:string|null=null;
        if(source==='internal') currentStudent=await canonicalStudent(tx,row.client_id);
        else {
          const annotation=(await tx.query('SELECT scheduling_canonical_student(client_id) AS client_id FROM class_annotations WHERE source=$1 AND class_id=$2',[source,id])).rows[0];
          currentStudent=annotation?.client_id ?? row.client_id ?? null;
        }
        if(currentStudent) await requireStudentScope(tx,ctx,currentStudent);
        else if(isStudentScope(ctx) && (!input.clientId || (row.owner_user_id??row.assigned_tutor_id)!==ctx.sub))
          throw new ForbiddenException('Only the connected tutor or a business-scoped staff account can associate an unmatched booking');
        if(input.clientId) input.clientId=await requireStudentScope(tx,ctx,input.clientId);
        if (source === "internal") {
          if (input.clientId === null)
            throw new BadRequestException(
              "Internal sessions require a student",
            );
          if(input.status==='scheduled') await assertCanonicalOverlap(tx,input.clientId??currentStudent!,row.starts_at.toISOString(),row.ends_at.toISOString(),id);
          await tx.query(
            "UPDATE sessions SET client_id=$2,status=$3,updated_at=now() WHERE id=$1",
            [id, input.clientId ?? row.client_id, input.status],
          );
        } else {
          await tx.query(
            "INSERT INTO class_annotations(business_id,source,class_id,client_id,status,updated_by) VALUES($1,$2,$3,$4,$5,$7) ON CONFLICT(business_id,source,class_id) DO UPDATE SET client_id=CASE WHEN $6 THEN EXCLUDED.client_id ELSE class_annotations.client_id END,status=EXCLUDED.status,updated_by=EXCLUDED.updated_by,updated_at=now()",
            [
              ctx.businessId,
              source,
              id,
              input.clientId ?? null,
              input.status,
              input.clientId !== undefined,
              ctx.sub,
            ],
          );
        }
        if (
          source === "internal" &&
          input.status === "completed" &&
          row.status !== "completed"
        )
          await emitEvent(tx, {
            type: "scheduling.session-completed.v1",
            producer: "scheduling",
            businessId: ctx.businessId,
            correlationId: ctx.requestId,
            data: { sessionId: id, clientId: input.clientId ?? row.client_id },
          });
        if (!liveSource && source === "external") {
          const changed = (
            await tx.query(
              `UPDATE class_ledger SET client_id=CASE WHEN $4 THEN scheduling_canonical_student($3::uuid) ELSE client_id END,status=$2,attendance_source='tutor',revision=revision+1,updated_at=now() WHERE source='external' AND class_id=$1 AND (status IS DISTINCT FROM $2 OR ($4 AND client_id IS DISTINCT FROM $3::uuid)) RETURNING *`,
              [
                id,
                input.status,
                input.clientId ?? null,
                input.clientId !== undefined,
              ],
            )
          ).rows[0];
          if (!changed) return { item: ledgerItem(row) };
          const snapshot=await emitClassSnapshot(tx,ctx.businessId,changed,ctx.requestId);
          return { item: snapshot };
        }
        const refreshed = await refreshClass(
          tx,
          ctx.businessId,
          source,
          id,
          ctx.requestId,
        );
        const current =
          refreshed ??
          ledgerItem(
            (
              await tx.query(
                "SELECT * FROM class_ledger WHERE source=$1 AND class_id=$2",
                [source, id],
              )
            ).rows[0],
          );
        return { item: current };
      })
      .catch((error) => {
        if (
          (
            error as {
              code?: string;
            }
          ).code === "23P01"
        )
          throw new ConflictException(
            "The student or tutor has an overlapping scheduled class",
          );
        throw error;
      });
  }
}
