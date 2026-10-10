import { Controller, Get, Inject, Injectable, Query, UnprocessableEntityException, type OnModuleInit } from '@nestjs/common';
import { CurrentContext, Database, EventBus, Permissions, Roles, StudentScoped, assertStudentAccess, parseBody } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { z } from 'zod';
import { invoice } from './billing.js';

const querySchema = z.object({ studentId: z.uuid(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict();
function safeAmount(value: unknown): number {
  const number = Number(value);
  if (!/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(number) || number < 0)
    throw new UnprocessableEntityException('Financial amount exceeds the supported exact range');
  return number;
}
const mergeSchema = z.object({ sourceId: z.uuid(), targetId: z.uuid(), revision: z.number().int().positive() });

@Injectable()
export class StudentFinanceService implements OnModuleInit {
  constructor(@Inject(Database) private readonly db: Database, @Inject(EventBus) private readonly bus: EventBus) {}
  onModuleInit() {
    this.bus.subscribe('clients.student-merged.v1', async (event, tx) => {
      const merge = parseBody(mergeSchema, event.data);
      if (merge.sourceId === merge.targetId) throw new Error('Invalid merge');
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`monthly:${event.businessId}`]);
      const existing = await tx.query('SELECT target_id FROM billing_student_aliases WHERE source_id=$1', [merge.sourceId]);
      if (existing.rows[0] && existing.rows[0].target_id !== merge.targetId) throw new Error('Conflicting merge');
      const target = (await tx.query('SELECT billing_student_root($1) id', [merge.targetId])).rows[0].id;
      if (target === merge.sourceId) throw new Error('Merge cycle');
      await tx.query('INSERT INTO billing_student_aliases(business_id,source_id,target_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [event.businessId, merge.sourceId, merge.targetId]);
      await tx.query('UPDATE billing_classes SET client_id=billing_student_root(client_id) WHERE client_id IS DISTINCT FROM billing_student_root(client_id)');
      // Keep the survivor rate. An alias rate is retained but disabled for review;
      // silently choosing a different price could change the next invoice.
      await tx.query('UPDATE student_rates SET active=false,updated_at=now() WHERE client_id<>billing_student_root(client_id) AND active');
    });
  }
  async finance(ctx: RequestContext, query: unknown) {
    const input = parseBody(querySchema, query);
    assertStudentAccess(ctx, input.studentId);
    return this.db.withTenant(ctx.businessId, async tx => {
      const studentId = (await tx.query('SELECT billing_student_root($1) id', [input.studentId])).rows[0].id;
      assertStudentAccess(ctx, studentId);
      const values = [studentId, input.limit, input.offset];
      const selected = await tx.query('SELECT * FROM invoices WHERE billing_student_root(client_id)=$1 AND issued_at IS NOT NULL ORDER BY issued_at DESC,id LIMIT $2 OFFSET $3', values);
      const count = await tx.query('SELECT count(*) total FROM invoices WHERE billing_student_root(client_id)=$1 AND issued_at IS NOT NULL', [studentId]);
      const payments = await tx.query(`SELECT p.* FROM payment_allocations p JOIN invoices i ON i.id=p.invoice_id AND i.business_id=p.business_id WHERE billing_student_root(i.client_id)=$1 AND i.issued_at IS NOT NULL ORDER BY p.created_at DESC,p.payment_id LIMIT $2 OFFSET $3`, values);
      const paymentCount = await tx.query('SELECT count(*) total FROM payment_allocations p JOIN invoices i ON i.id=p.invoice_id AND i.business_id=p.business_id WHERE billing_student_root(i.client_id)=$1 AND i.issued_at IS NOT NULL', [studentId]);
      const totals = await tx.query(`WITH balances AS (
        SELECT i.id,i.currency,i.total_minor,COALESCE(sum(p.amount_minor) FILTER(WHERE NOT p.simulated),0) real_paid,COALESCE(sum(p.amount_minor) FILTER(WHERE p.simulated),0) simulated_paid
        FROM invoices i LEFT JOIN payment_allocations p ON p.invoice_id=i.id AND p.business_id=i.business_id
        WHERE billing_student_root(i.client_id)=$1 AND i.issued_at IS NOT NULL GROUP BY i.id
      ) SELECT currency,sum(total_minor) billed,sum(real_paid) collected,sum(simulated_paid) simulated,sum(greatest(total_minor-real_paid,0)) outstanding FROM balances GROUP BY currency ORDER BY currency`, [studentId]);
      return {
        studentId, items: selected.rows.map(row => ({...invoice(row), totalMinor: safeAmount(row.total_minor), paidMinor: safeAmount(row.paid_minor), studentId, revision: row.revision})), total: Number(count.rows[0].total),
        payments: payments.rows.map(row => ({id: row.payment_id, invoiceId: row.invoice_id, amountMinor: safeAmount(row.amount_minor), currency: row.currency, provider: row.provider, simulated: row.simulated, createdAt: row.created_at})),
        paymentTotal: Number(paymentCount.rows[0].total), limit: input.limit, offset: input.offset,
        totals: totals.rows.map(row => ({currency: row.currency,billedMinor: safeAmount(row.billed),collectedMinor: safeAmount(row.collected),simulatedMinor: safeAmount(row.simulated),outstandingMinor: safeAmount(row.outstanding)})),
        asOf: new Date().toISOString(), coverage: 'issued_invoices_and_recorded_payments',
      };
    });
  }
}

@Controller('v1/portal/finance')
@Roles('owner', 'admin', 'tutor')
@StudentScoped()
@Permissions('billing.read')
export class StudentFinanceController {
  constructor(@Inject(StudentFinanceService) private readonly service: StudentFinanceService) {}
  @Get() get(@CurrentContext() ctx: RequestContext, @Query() query: unknown) { return this.service.finance(ctx, query); }
}
