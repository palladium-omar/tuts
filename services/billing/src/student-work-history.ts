import { ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { Database, assertPermission, assertStudentAccess, parseBody, serviceFetch } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { z } from 'zod';
import { dayView, safeHistoryMinor } from './history.js';
import { monthSchema } from './monthly.js';

const uuid = z.uuid().transform(value => value.toLowerCase());
const querySchema = z.object({ month: monthSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(1000000).default(0) }).strict();
const studentResponse = z.object({ item: z.object({ id: uuid, kind: z.literal('student') }) });
const freshWork = `SELECT w.id,w.work_date,w.service_type,w.hours,w.amount_minor,w.currency,w.status,w.count_as_classes
  FROM billing_work_log w JOIN billing_work_identities i ON i.business_id=w.business_id AND i.work_id=w.id
  WHERE i.status='linked' AND i.work_revision=w.revision AND billing_student_root(i.student_id)=$1`;
function hours(value: unknown): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > Number.MAX_SAFE_INTEGER) throw new UnprocessableEntityException('Work hours exceed the supported numeric range');
  return result;
}

@Injectable()
export class StudentWorkHistoryService {
  constructor(@Inject(Database) private readonly db: Database) {}
  fetchStudent: typeof serviceFetch = serviceFetch;

  private async verifyStudent(id: string, authorization: unknown): Promise<string> {
    if (typeof authorization !== 'string' || !/^Bearer \S+$/.test(authorization)) throw new UnauthorizedException('Verified authorization required');
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const lookup = async () => {
        const response = await this.fetchStudent('clients', `/v1/clients/${id}/identity`, { headers: { authorization }, signal: controller.signal });
        if (controller.signal.aborted) { await response.body?.cancel(); throw new ServiceUnavailableException('Student verification unavailable'); }
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 403) throw new ForbiddenException('Student verification is not permitted');
          if (response.status === 401) throw new UnauthorizedException('Verified authorization expired; refresh and retry');
          if (response.status === 404) throw new NotFoundException('Student is not available');
          throw new ServiceUnavailableException('Student verification unavailable');
        }
        if (!response.body) throw new ServiceUnavailableException('Student verification unavailable');
        reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.byteLength;
            if (size > 65536) throw new ServiceUnavailableException('Student verification exceeds the response limit');
            chunks.push(part.value);
          }
          if (controller.signal.aborted) throw new ServiceUnavailableException('Student verification unavailable');
          const parsed = studentResponse.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          if (!parsed.success) throw new NotFoundException('An accessible CRM student is required');
          return parsed.data.item.id;
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      };
      return await Promise.race([lookup(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => {}); reject(new ServiceUnavailableException('Student verification timed out')); }, 5000);
      })]);
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof UnauthorizedException || error instanceof NotFoundException || error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('Student verification unavailable');
    } finally { if (timer) clearTimeout(timer); }
  }

  async history(ctx: RequestContext, rawId: string, query: unknown, authorization: unknown) {
    if (!['owner', 'admin', 'tutor'].includes(ctx.role)) throw new ForbiddenException('Work history requires staff access');
    assertPermission(ctx, 'billing.read'); assertPermission(ctx, 'reporting.financial'); assertPermission(ctx, 'clients.read');
    if (!ctx.entitlements.includes('billing') || !ctx.entitlements.includes('clients')) throw new ForbiddenException('Billing and Clients must be enabled');
    const id = parseBody(uuid, rawId), input = parseBody(querySchema, query);
    assertStudentAccess(ctx, id);
    const verified = await this.verifyStudent(id, authorization);
    assertStudentAccess(ctx, verified);
    return this.db.withTenant(ctx.businessId, async tx => {
      const studentId: string = (await tx.query('SELECT billing_student_root($1) id', [verified])).rows[0].id;
      assertStudentAccess(ctx, studentId);
      const month = input.month ?? null, firstDay = month ? `${month}-01` : null;
      const aggregate = await tx.query(`WITH work AS (${freshWork}) SELECT currency,count(*) all_count,
        sum(hours) total_hours,sum(amount_minor) total_minor,
        COALESCE(sum(amount_minor) FILTER(WHERE status='paid'),0) paid_minor,
        COALESCE(sum(amount_minor) FILTER(WHERE status='pending'),0) pending_minor,
        COALESCE(sum(amount_minor) FILTER(WHERE status='unsent'),0) unsent_minor,
        count(*) FILTER(WHERE work_date>=$2::date AND work_date<($2::date+INTERVAL '1 month')) month_count,
        COALESCE(sum(hours) FILTER(WHERE work_date>=$2::date AND work_date<($2::date+INTERVAL '1 month')),0) month_hours,
        COALESCE(sum(amount_minor) FILTER(WHERE work_date>=$2::date AND work_date<($2::date+INTERVAL '1 month')),0) month_minor
        FROM work GROUP BY currency ORDER BY currency LIMIT 201`, [studentId, firstDay]);
      if (aggregate.rows.length > 200) throw new UnprocessableEntityException('Student work exceeds the supported currency count');
      let total = 0;
      const currencies = aggregate.rows.map(row => {
        total = safeHistoryMinor(BigInt(total) + BigInt(String(month ? row.month_count : row.all_count)));
        return { currency: row.currency, totalHours: hours(row.total_hours), totalMinor: safeHistoryMinor(row.total_minor), paidMinor: safeHistoryMinor(row.paid_minor), pendingMinor: safeHistoryMinor(row.pending_minor), unsentMinor: safeHistoryMinor(row.unsent_minor), monthHours: month ? hours(row.month_hours) : null, monthMinor: month ? safeHistoryMinor(row.month_minor) : null };
      });
      const selected = await tx.query(`WITH work AS (${freshWork}) SELECT * FROM work
        WHERE $2::date IS NULL OR (work_date>=$2::date AND work_date<($2::date+INTERVAL '1 month'))
        ORDER BY work_date DESC,id LIMIT $3 OFFSET $4`, [studentId, firstDay, input.limit, input.offset]);
      const rows = selected.rows.map(row => ({ id: row.id, date: dayView(row.work_date), serviceType: row.service_type, hours: hours(row.hours), amountMinor: safeHistoryMinor(row.amount_minor), currency: row.currency, status: row.status, countAsClasses: row.count_as_classes }));
      return { item: { studentId, month, currencies, rows, total, limit: input.limit, offset: input.offset, provenance: 'historical_work_declarations' as const } };
    }, { isolation: 'repeatable read' });
  }
}
