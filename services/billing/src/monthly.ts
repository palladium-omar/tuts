import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  ServiceUnavailableException,
  type OnModuleInit,
  type OnApplicationShutdown,
} from "@nestjs/common";
import {
  isCloudflareRuntime,
  serviceFetch,
  CurrentContext,
  Database,
  EventBus,
  Roles,
  parseBody,
  emitEvent,
} from "@palladium/service-kit";
import type { RequestContext } from "@palladium/contracts";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { currencySchema, totalMinor, serviceMonthView } from "./financial.js";
import { invoice } from "./billing.js";
export const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .refine(
    (v) => Number(v.slice(0, 4)) >= 2000 && Number(v.slice(0, 4)) <= 2200,
  );
export const timeZoneSchema = z
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
const settingsSchema = z
  .object({
    timeZone: timeZoneSchema,
    autoDraft: z.boolean(),
    billDay: z.literal(1).optional(),
  })
  .strict();
const rateSchema = z
  .object({
    clientId: z.uuid(),
    payerName: z.string().trim().min(1).max(200),
    currency: currencySchema,
    unitPriceMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    active: z.boolean().default(true),
  })
  .strict();
const ratePatchSchema = rateSchema
  .omit({ clientId: true })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0);
const monthQuery = z.object({ month: monthSchema }).strict();
const reconcileSchema = z
  .object({ month: monthSchema, timeZone: timeZoneSchema.optional() })
  .strict();
export const classSnapshotSchema = z
  .object({
    classId: z.uuid(),
    source: z.enum(["internal", "external"]),
    clientId: z.uuid().nullable(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    status: z.enum(["scheduled", "completed", "cancelled"]),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    title: z.string().max(200).optional(),
    attendeeEmail: z.email().nullable().optional(),
  })
  .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt));
const ledgerResponseSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.uuid(),
        source: z.enum(["internal", "external"]),
        clientId: z.uuid().nullable(),
        startsAt: z.string().datetime(),
        endsAt: z.string().datetime(),
        status: z.enum(["scheduled", "completed", "cancelled"]),
        revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        title: z.string().max(200),
        attendeeEmail: z.email().nullable().optional(),
      }),
    )
    .max(10000),
  total: z.number().int().nonnegative(),
  truncated: z.literal(false),
});
export function previousMonth(month: string) {
  const [year, value] = month.split("-").map(Number);
  return value === 1
    ? `${year! - 1}-12`
    : `${year}-${String(value! - 1).padStart(2, "0")}`;
}
export function localDate(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    month: `${part("year")}-${part("month")}`,
    day: Number(part("day")),
  };
}
const monthCondition = `(c.starts_at AT TIME ZONE $2)::date >= $1::date AND (c.starts_at AT TIME ZONE $2)::date < ($1::date + INTERVAL '1 month')`;
const classKey = (r: Record<string, any>) => `${r.source}:${r.class_id}`;
const classView = (r: Record<string, any>) => ({
  id: r.class_id,
  source: r.source,
  clientId: r.client_id,
  title: r.title,
  attendeeEmail: r.attendee_email,
  startsAt: new Date(r.starts_at).toISOString(),
  endsAt: new Date(r.ends_at).toISOString(),
  status: r.status,
  revision: Number(r.revision),
});
const rateView = (r: Record<string, any>) => ({
  id: r.id,
  clientId: r.client_id,
  payerName: r.payer_name,
  currency: r.currency,
  unitPriceMinor: Number(r.unit_price_minor),
  active: r.active,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
export async function projectClass(
  tx: PoolClient,
  businessId: string,
  input: z.infer<typeof classSnapshotSchema>,
  authoritative = false,
  alreadyLocked = false,
) {
  if (!alreadyLocked)
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `monthly:${businessId}`,
    ]);
  await tx.query(
    `INSERT INTO billing_classes(business_id,class_id,source,client_id,title,attendee_email,starts_at,ends_at,status,revision,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp())
  ON CONFLICT(business_id,source,class_id) DO UPDATE SET client_id=EXCLUDED.client_id,title=CASE WHEN $11 THEN EXCLUDED.title ELSE billing_classes.title END,attendee_email=CASE WHEN $11 THEN EXCLUDED.attendee_email ELSE billing_classes.attendee_email END,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,status=EXCLUDED.status,revision=EXCLUDED.revision,reconciliation_missing=false,updated_at=clock_timestamp() WHERE billing_classes.revision < EXCLUDED.revision OR ($11 AND billing_classes.revision=EXCLUDED.revision)`,
    [
      businessId,
      input.classId,
      input.source,
      input.clientId,
      input.title ?? "Class",
      input.attendeeEmail ?? null,
      input.startsAt,
      input.endsAt,
      input.status,
      input.revision,
      authoritative,
    ],
  );
}
@Injectable()
export class MonthlyService implements OnModuleInit, OnApplicationShutdown {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    @Inject(Database)
    private readonly db: Database,
    @Inject(EventBus)
    private readonly bus: EventBus,
  ) {}
  onModuleInit() {
    this.bus.subscribe("scheduling.class-updated.v1", async (event, tx) => {
      if (event.producer !== "scheduling")
        throw new Error("class_producer_invalid");
      await projectClass(
        tx,
        event.businessId,
        parseBody(classSnapshotSchema, event.data),
      );
    });
    if (isCloudflareRuntime()) return;
    void this.runAutomatic().catch(() => {
      console.warn(
        "[billing] initial automatic draft check failed; next check will retry",
      );
    });
    this.timer = setInterval(() => {
      void this.runAutomatic().catch(() => {
        console.warn(
          "[billing] automatic draft check failed; next check will retry",
        );
      });
    }, 60000);
    this.timer.unref();
  }
  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
  private async settings(tx: PoolClient) {
    const r = (await tx.query("SELECT * FROM billing_settings")).rows[0];
    return {
      timeZone: r?.time_zone ?? "UTC",
      billDay: 1 as const,
      autoDraft: r?.auto_draft ?? false,
      automaticSupported: true,
      lastDraftMonth: serviceMonthView(r?.last_draft_month),
    };
  }
  getSettings(ctx: RequestContext) {
    return this.db.withTenant(ctx.businessId, (tx) => this.settings(tx));
  }
  updateSettings(ctx: RequestContext, body: unknown) {
    const input = parseBody(settingsSchema, body);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      await tx.query(
        "INSERT INTO billing_settings(business_id,time_zone,auto_draft) VALUES($1,$2,$3) ON CONFLICT(business_id) DO UPDATE SET time_zone=EXCLUDED.time_zone,auto_draft=EXCLUDED.auto_draft,updated_at=now()",
        [ctx.businessId, input.timeZone, input.autoDraft],
      );
      await emitEvent(tx, {
        type: "billing.settings-updated.v1",
        producer: "billing",
        businessId: ctx.businessId,
        correlationId: ctx.requestId,
        data: { autoDraft: input.autoDraft },
      });
      return this.settings(tx);
    });
  }
  listRates(ctx: RequestContext) {
    return this.db.withTenant(ctx.businessId, async (tx) =>
      (
        await tx.query("SELECT * FROM student_rates ORDER BY payer_name,id")
      ).rows.map(rateView),
    );
  }
  createRate(ctx: RequestContext, body: unknown) {
    const input = parseBody(rateSchema, body);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const r = await tx.query(
        "INSERT INTO student_rates(business_id,id,client_id,payer_name,currency,unit_price_minor,active) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(business_id,client_id) DO NOTHING RETURNING *",
        [
          ctx.businessId,
          randomUUID(),
          input.clientId,
          input.payerName,
          input.currency,
          input.unitPriceMinor,
          input.active,
        ],
      );
      if (!r.rows[0])
        throw new ConflictException(
          "Student already has a rate; edit it instead",
        );
      await emitEvent(tx, {
        type: "billing.student-rate-updated.v1",
        producer: "billing",
        businessId: ctx.businessId,
        correlationId: ctx.requestId,
        data: { clientId: input.clientId },
      });
      return rateView(r.rows[0]);
    });
  }
  updateRate(ctx: RequestContext, id: string, body: unknown) {
    parseBody(z.uuid(), id);
    const input = parseBody(ratePatchSchema, body);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const r = (
        await tx.query("SELECT * FROM student_rates WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      if (!r) throw new NotFoundException("Student rate not found");
      const changed = (
        await tx.query(
          "UPDATE student_rates SET payer_name=$2,currency=$3,unit_price_minor=$4,active=$5,updated_at=now() WHERE id=$1 RETURNING *",
          [
            id,
            input.payerName ?? r.payer_name,
            input.currency ?? r.currency,
            input.unitPriceMinor ?? r.unit_price_minor,
            input.active ?? r.active,
          ],
        )
      ).rows[0];
      await emitEvent(tx, {
        type: "billing.student-rate-updated.v1",
        producer: "billing",
        businessId: ctx.businessId,
        correlationId: ctx.requestId,
        data: { clientId: r.client_id },
      });
      return rateView(changed);
    });
  }
  async reconcile(ctx: RequestContext, body: unknown, authorization: unknown) {
    const input = parseBody(reconcileSchema, body),
      settings = await this.getSettings(ctx),
      timeZone = input.timeZone ?? settings.timeZone;
    if (
      typeof authorization !== "string" ||
      !authorization.startsWith("Bearer ")
    )
      throw new BadRequestException("Verified authorization required");
    const query = new URLSearchParams({ month: input.month, timeZone });
    const requestStartedAt = new Date();
    let response: Response;
    try {
      response = await serviceFetch("scheduling", `/v1/class-ledger?${query}`, {
        headers: { authorization },
        signal: AbortSignal.timeout(30000),
        redirect: "manual",
      });
    } catch {
      throw new ServiceUnavailableException(
        "Class ledger is unavailable; reconciliation was not applied",
      );
    }
    if (!response.ok)
      throw new ServiceUnavailableException(
        `Class ledger returned ${response.status}; reconciliation was not applied`,
      );
    const data = parseBody(ledgerResponseSchema, await response.json());
    if (data.total !== data.items.length)
      throw new ServiceUnavailableException(
        "Class ledger is incomplete; reconciliation was not applied",
      );
    return this.db.withTenant(ctx.businessId, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `monthly:${ctx.businessId}`,
      ]);
      for (const item of data.items)
        await projectClass(
          tx,
          ctx.businessId,
          classSnapshotSchema.parse({ ...item, classId: item.id }),
          true,
          true,
        );
      await tx.query(
        `UPDATE billing_classes c SET reconciliation_missing=true WHERE ${monthCondition} AND NOT ((source || ':' || class_id::text)=ANY($3::text[])) AND updated_at <= $4::timestamptz`,
        [
          `${input.month}-01`,
          timeZone,
          data.items.map((item) => `${item.source}:${item.id}`),
          requestStartedAt,
        ],
      );
      await tx.query(
        "INSERT INTO monthly_reconciliations(business_id,month,time_zone) VALUES($1,$2::date,$3) ON CONFLICT(business_id,month,time_zone) DO UPDATE SET reconciled_at=now()",
        [ctx.businessId, `${input.month}-01`, timeZone],
      );
      return {
        month: input.month,
        timeZone,
        reconciledCount: data.items.length,
      };
    });
  }
  private async previewTx(tx: PoolClient, month: string, timeZone: string) {
    const rows = (
      await tx.query(
        `SELECT c.*,r.payer_name,r.currency,r.unit_price_minor,r.active,b.invoice_id AS billed_invoice_id,i.client_id AS billed_client_id,i.service_month AS billed_month,b.revision AS billed_revision FROM billing_classes c LEFT JOIN student_rates r ON r.business_id=c.business_id AND r.client_id=c.client_id LEFT JOIN billed_classes b ON b.business_id=c.business_id AND b.source=c.source AND b.class_id=c.class_id LEFT JOIN invoices i ON i.business_id=b.business_id AND i.id=b.invoice_id WHERE ${monthCondition} ORDER BY c.starts_at,c.class_id`,
        [`${month}-01`, timeZone],
      )
    ).rows;
    const invoices = (
      await tx.query("SELECT * FROM invoices WHERE service_month=$1::date", [
        `${month}-01`,
      ])
    ).rows;
    const byClient = new Map(invoices.map((r) => [r.client_id, r]));
    const students = new Map<string, any>(),
      unrated: any[] = [],
      unmatched: any[] = [],
      requiresReview: any[] = [];
    for (const row of rows) {
      if (
        row.billed_invoice_id &&
        (row.reconciliation_missing ||
          row.status !== "completed" ||
          row.billed_client_id !== row.client_id ||
          serviceMonthView(row.billed_month) !== month ||
          Number(row.billed_revision) !== Number(row.revision))
      )
        requiresReview.push({
          classId: row.class_id,
          source: row.source,
          invoiceId: row.billed_invoice_id,
          reason: "Billed class changed; review the existing invoice",
        });
      if (row.reconciliation_missing || row.status !== "completed") continue;
      if (!row.client_id) {
        unmatched.push(classView(row));
        continue;
      }
      if (!row.active || !row.currency) {
        unrated.push(classView(row));
        continue;
      }
      let student = students.get(row.client_id);
      if (!student) {
        student = {
          clientId: row.client_id,
          payerName: row.payer_name,
          currency: row.currency,
          unitPriceMinor: Number(row.unit_price_minor),
          completedCount: 0,
          classIds: [],
          totalMinor: 0,
          existingInvoiceId: byClient.get(row.client_id)?.id ?? null,
          existingInvoiceTotalMinor: byClient.get(row.client_id)
            ? Number(byClient.get(row.client_id).total_minor)
            : null,
          billableCount: 0,
          lateClassIds: [],
        };
        students.set(row.client_id, student);
      }
      student.completedCount++;
      if (!row.billed_invoice_id) {
        student.classIds.push(classKey(row));
        if (student.existingInvoiceId) student.lateClassIds.push(classKey(row));
      }
    }
    for (const student of students.values()) {
      student.billableCount = student.classIds.length;
      student.totalMinor = student.classIds.length
        ? totalMinor([
            {
              description: "Completed classes",
              quantity: student.classIds.length,
              unitPriceMinor: student.unitPriceMinor,
            },
          ])
        : 0;
      if (student.lateClassIds.length)
        requiresReview.push({
          clientId: student.clientId,
          invoiceId: student.existingInvoiceId,
          classIds: student.lateClassIds,
          reason:
            "Additional completed classes arrived after the monthly draft",
        });
    }
    return {
      month,
      timeZone,
      students: [...students.values()],
      unrated,
      unmatched,
      requiresReview,
      automaticSupported: true,
    };
  }
  preview(ctx: RequestContext, query: unknown) {
    const { month } = parseBody(monthQuery, query);
    return this.db.withTenant(ctx.businessId, async (tx) =>
      this.previewTx(tx, month, (await this.settings(tx)).timeZone),
    );
  }
  private async generateTx(
    tx: PoolClient,
    businessId: string,
    month: string,
    correlationId?: string,
    now = new Date(),
  ) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `monthly:${businessId}`,
    ]);
    const settings = await this.settings(tx);
    const local = localDate(now, settings.timeZone);
    if (month >= local.month)
      throw new BadRequestException(
        "Monthly arrears billing requires a completed service month",
      );
    const preview = await this.previewTx(tx, month, settings.timeZone),
      created: any[] = [],
      existing: any[] = [];
    const seller =
      (await tx.query("SELECT seller FROM business_seller_profiles")).rows[0]
        ?.seller ?? null;
    for (const student of preview.students) {
      if (student.existingInvoiceId) {
        const row = (
          await tx.query("SELECT * FROM invoices WHERE id=$1", [
            student.existingInvoiceId,
          ])
        ).rows[0];
        existing.push(invoice(row));
        continue;
      }
      if (!student.classIds.length) continue;
      const id = randomUUID(),
        items = [
          {
            description: `Completed classes — ${month}`,
            quantity: student.classIds.length,
            unitPriceMinor: student.unitPriceMinor,
          },
        ];
      const row = (
        await tx.query(
          "INSERT INTO invoices(id,business_id,client_id,payer_name,currency,items,total_minor,seller_snapshot,service_month,due_at,class_ids) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::date,($9::date+INTERVAL '1 month') AT TIME ZONE $10,$11) RETURNING *",
          [
            id,
            businessId,
            student.clientId,
            student.payerName,
            student.currency,
            JSON.stringify(items),
            student.totalMinor,
            seller,
            `${month}-01`,
            settings.timeZone,
            student.classIds,
          ],
        )
      ).rows[0];
      for (const key of student.classIds) {
        const [source, classId] = key.split(":");
        await tx.query(
          "INSERT INTO billed_classes(business_id,source,class_id,invoice_id,revision) SELECT business_id,source,class_id,$4,revision FROM billing_classes WHERE business_id=$1 AND source=$2 AND class_id=$3",
          [businessId, source, classId, id],
        );
      }
      await emitEvent(tx, {
        type: "billing.monthly-draft-created.v1",
        producer: "billing",
        businessId,
        correlationId,
        data: {
          invoiceId: id,
          serviceMonth: month,
          clientId: student.clientId,
        },
      });
      created.push(invoice(row));
    }
    return {
      month,
      created,
      existing,
      requiresReview: preview.requiresReview,
      unratedCount: preview.unrated.length,
      unmatchedCount: preview.unmatched.length,
    };
  }
  generate(ctx: RequestContext, body: unknown) {
    const { month } = parseBody(monthQuery, body);
    return this.db.withTenant(ctx.businessId, (tx) =>
      this.generateTx(tx, ctx.businessId, month, ctx.requestId),
    );
  }
  async runAutomatic(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      // Outbox is service-owned, without tenant RLS; explicit settings events are the autonomous tenant catalogue.
      const businesses = (
        await this.db.pool.query(
          "SELECT DISTINCT event->>'businessId' AS business_id FROM service_outbox WHERE event->>'type'='billing.settings-updated.v1'",
        )
      ).rows;
      for (const row of businesses)
        await this.db.withTenant(row.business_id, async (tx) => {
          const settings = await this.settings(tx),
            date = localDate(now, settings.timeZone),
            month = previousMonth(date.month);
          if (
            !settings.autoDraft ||
            (settings.lastDraftMonth && settings.lastDraftMonth >= month)
          )
            return;
          await this.generateTx(tx, row.business_id, month, undefined, now);
          await tx.query(
            "UPDATE billing_settings SET last_draft_month=$2::date WHERE business_id=$1",
            [row.business_id, `${month}-01`],
          );
        });
    } finally {
      this.running = false;
    }
  }
  dashboard(ctx: RequestContext, query: unknown) {
    const { month } = parseBody(monthQuery, query);
    return this.db.withTenant(ctx.businessId, async (tx) => {
      const settings = await this.settings(tx),
        values = [`${month}-01`, settings.timeZone];
      const currencies = (
        await tx.query(
          `WITH billed AS (SELECT currency,sum(total_minor) AS amount FROM invoices WHERE issued_at IS NOT NULL AND (issued_at AT TIME ZONE $2)::date >= $1::date AND (issued_at AT TIME ZONE $2)::date < ($1::date+INTERVAL '1 month') GROUP BY currency), collected AS (SELECT currency,sum(amount_minor) FILTER(WHERE NOT simulated) AS amount,sum(amount_minor) FILTER(WHERE simulated) AS sandbox FROM payment_allocations WHERE (created_at AT TIME ZONE $2)::date >= $1::date AND (created_at AT TIME ZONE $2)::date < ($1::date+INTERVAL '1 month') GROUP BY currency), outstanding AS (SELECT i.currency,sum(i.total_minor-coalesce(p.real_paid,0)) AS amount FROM invoices i LEFT JOIN (SELECT invoice_id,sum(amount_minor) FILTER(WHERE NOT simulated) AS real_paid FROM payment_allocations GROUP BY invoice_id) p ON p.invoice_id=i.id WHERE i.issued_at IS NOT NULL GROUP BY i.currency), all_collected AS (SELECT currency,sum(amount_minor) FILTER(WHERE NOT simulated) AS amount,sum(amount_minor) FILTER(WHERE simulated) AS sandbox FROM payment_allocations GROUP BY currency), all_currencies AS (SELECT currency FROM billed UNION SELECT currency FROM collected UNION SELECT currency FROM outstanding UNION SELECT currency FROM all_collected) SELECT a.currency,coalesce(b.amount,0) AS billed_minor,coalesce(c.amount,0) AS collected_minor,coalesce(c.sandbox,0) AS sandbox_collected_minor,coalesce(o.amount,0) AS outstanding_minor,coalesce(ac.amount,0) AS all_time_collected_minor,coalesce(ac.sandbox,0) AS all_time_sandbox_collected_minor FROM all_currencies a LEFT JOIN billed b USING(currency) LEFT JOIN collected c USING(currency) LEFT JOIN outstanding o USING(currency) LEFT JOIN all_collected ac USING(currency) ORDER BY a.currency`,
          values,
        )
      ).rows;
      const students = (
        await tx.query(
          `WITH counts AS (SELECT c.client_id,count(*) FILTER(WHERE status='completed') AS completed_count,count(*) FILTER(WHERE status='scheduled') AS scheduled_count,count(*) FILTER(WHERE status='cancelled') AS cancelled_count FROM billing_classes c WHERE ${monthCondition} AND NOT c.reconciliation_missing AND c.client_id IS NOT NULL GROUP BY c.client_id), students AS (SELECT client_id FROM counts UNION SELECT client_id FROM student_rates), monthly_invoices AS (SELECT client_id,array_agg(id ORDER BY created_at) AS invoice_ids FROM invoices WHERE service_month=$1::date GROUP BY client_id) SELECT s.client_id,r.payer_name,r.currency,r.unit_price_minor,r.active,coalesce(c.completed_count,0) AS completed_count,coalesce(c.scheduled_count,0) AS scheduled_count,coalesce(c.cancelled_count,0) AS cancelled_count,coalesce(i.invoice_ids,'{}') AS invoice_ids FROM students s LEFT JOIN counts c USING(client_id) LEFT JOIN student_rates r USING(client_id) LEFT JOIN monthly_invoices i USING(client_id) ORDER BY r.payer_name NULLS LAST,s.client_id`,
          values,
        )
      ).rows;
      const unmatched = Number(
        (
          await tx.query(
            `SELECT count(*) AS total FROM billing_classes c WHERE ${monthCondition} AND NOT c.reconciliation_missing AND client_id IS NULL`,
            values,
          )
        ).rows[0].total,
      );
      const money = (v: unknown) => {
        const n = Number(v);
        if (!Number.isSafeInteger(n))
          throw new ConflictException(
            "Financial aggregate exceeds safe integer range",
          );
        return n;
      };
      return {
        month,
        timeZone: settings.timeZone,
        currencies: currencies.map((r) => ({
          currency: r.currency,
          billedMinor: money(r.billed_minor),
          collectedMinor: money(r.collected_minor),
          sandboxCollectedMinor: money(r.sandbox_collected_minor),
          outstandingMinor: money(r.outstanding_minor),
          allTimeCollectedMinor: money(r.all_time_collected_minor),
          allTimeSandboxCollectedMinor: money(
            r.all_time_sandbox_collected_minor,
          ),
        })),
        students: students.map((r) => ({
          clientId: r.client_id,
          payerName: r.payer_name ?? null,
          currency: r.currency ?? null,
          unitPriceMinor: r.unit_price_minor
            ? Number(r.unit_price_minor)
            : null,
          completedCount: Number(r.completed_count),
          scheduledCount: Number(r.scheduled_count),
          cancelledCount: Number(r.cancelled_count),
          estimatedMinor:
            r.active && Number(r.completed_count) > 0
              ? totalMinor([
                  {
                    description: "Estimate",
                    quantity: Number(r.completed_count),
                    unitPriceMinor: Number(r.unit_price_minor),
                  },
                ])
              : 0,
          invoiceIds: r.invoice_ids,
        })),
        unmatchedCount: unmatched,
      };
    });
  }
}
@Roles("owner", "admin", "tutor")
@Controller("v1")
export class MonthlyController {
  constructor(
    @Inject(MonthlyService)
    private readonly service: MonthlyService,
  ) {}
  @Get("billing-settings")
  async settings(
    @CurrentContext()
    ctx: RequestContext,
  ) {
    return { item: await this.service.getSettings(ctx) };
  }
  @Put("billing-settings")
  @Roles("owner", "admin")
  async saveSettings(
    @CurrentContext()
    ctx: RequestContext,
    @Body()
    body: unknown,
  ) {
    return { item: await this.service.updateSettings(ctx, body) };
  }
  @Get("student-rates")
  async rates(
    @CurrentContext()
    ctx: RequestContext,
  ) {
    return { items: await this.service.listRates(ctx) };
  }
  @Post("student-rates")
  @Roles("owner", "admin")
  async createRate(
    @CurrentContext()
    ctx: RequestContext,
    @Body()
    body: unknown,
  ) {
    return { item: await this.service.createRate(ctx, body) };
  }
  @Patch("student-rates/:id")
  @Roles("owner", "admin")
  async updateRate(
    @CurrentContext()
    ctx: RequestContext,
    @Param("id")
    id: string,
    @Body()
    body: unknown,
  ) {
    return { item: await this.service.updateRate(ctx, id, body) };
  }
  @Post("monthly/reconcile")
  async reconcile(
    @CurrentContext()
    ctx: RequestContext,
    @Body()
    body: unknown,
    @Headers("authorization")
    authorization: unknown,
  ) {
    return { item: await this.service.reconcile(ctx, body, authorization) };
  }
  @Get("monthly/preview")
  async preview(
    @CurrentContext()
    ctx: RequestContext,
    @Query()
    query: unknown,
  ) {
    return { item: await this.service.preview(ctx, query) };
  }
  @Post("monthly/generate")
  @Roles("owner", "admin")
  async generate(
    @CurrentContext()
    ctx: RequestContext,
    @Body()
    body: unknown,
  ) {
    return { item: await this.service.generate(ctx, body) };
  }
  @Get("dashboard")
  async dashboard(
    @CurrentContext()
    ctx: RequestContext,
    @Query()
    query: unknown,
  ) {
    return { item: await this.service.dashboard(ctx, query) };
  }
}
