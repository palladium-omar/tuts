import { Inject, Injectable } from '@nestjs/common';
import { Database, serviceFetch, emitEvent } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { lockReports, projectAssignment, projectClass, projectInvoice, projectResource, studentRoot } from './projections.js';
import { assertFinancial, authorizedRoot, ReportingService } from './reporting.service.js';
import { financialTotalSchema, type Period } from './schemas.js';
const listResponse = z.object({
    items: z.array(z.record(z.string(), z.unknown())).max(200), total: z.number().int().nonnegative(), limit: z.number().int().positive().max(200), offset: z.number().int().nonnegative()
});
const financeResponse = z.object({
    studentId: z.uuid(), items: z.array(z.record(z.string(), z.unknown())).max(200), total: z.number().int().nonnegative(), totals: z.array(financialTotalSchema).max(200), asOf: z.string().datetime(), coverage: z.literal('issued_invoices_and_recorded_payments')
});
class SourceUnavailable extends Error {
    constructor(readonly reason: string) {
        super(reason);
    }
}
type ReadBudget = {
    remaining: number;
};
export async function readJson(response: Response, budget: ReadBudget) {
    if (!response.ok) {
        await response.body?.cancel();
        throw new SourceUnavailable(response.status === 403 ? 'Source capability or entitlement is unavailable' : response.status === 401 ? 'Verified authorization expired; retry reconciliation' : 'Source service unavailable');
    }
    if (!response.body)
        throw new SourceUnavailable('Source returned no response body');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const result = await reader.read();
            if (result.done)
                break;
            size += result.value.byteLength;
            budget.remaining -= result.value.byteLength;
            if (size > 8 * 1024 * 1024 || budget.remaining < 0) {
                await reader.cancel();
                throw new SourceUnavailable('Source response exceeds reconciliation limit');
            }
            chunks.push(result.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    }
    finally {
        reader.releaseLock();
    }
}
async function fetchPage(service: string, path: string, authorization: string, deadline: number, budget: ReadBudget) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
        throw new SourceUnavailable('Reconciliation time limit reached; retry a smaller history window');
    try {
        return await readJson(await serviceFetch(service, path, {
            headers: {
                authorization
            }, signal: AbortSignal.timeout(Math.min(remaining, 8000))
        }), budget);
    }
    catch (error) {
        if (error instanceof SourceUnavailable)
            throw error;
        throw new SourceUnavailable('Source response unavailable or invalid');
    }
}
type PageResult = {
    rows: Record<string, unknown>[];
    complete: boolean;
    reason?: string;
};
async function pages(service: string, path: string, authorization: string, deadline: number, budget: ReadBudget): Promise<PageResult> {
    const rows: Record<string, unknown>[] = [];
    let total: number | null = null;
    for (let page = 0; page < 10; page++) {
        const data = listResponse.parse(await fetchPage(service, `${path}${path.includes('?') ? '&' : '?'}limit=200&offset=${page * 200}`, authorization, deadline, budget));
        if (data.offset !== page * 200 || data.limit !== 200)
            throw new SourceUnavailable('Source pagination contract is unavailable');
        if (total !== null && data.total !== total)
            return {
                rows: [...rows, ...data.items], complete: false, reason: 'Source changed during pagination; reconcile again'
            };
        total = data.total;
        rows.push(...data.items);
        if (rows.length >= data.total)
            return {
                rows, complete: true
            };
        if (!data.items.length)
            return {
                rows, complete: false, reason: 'Source history is incomplete'
            };
    }
    return {
        rows, complete: false, reason: 'More than 2000 source records; observed history is partial'
    };
}
@Injectable()
export class ReconcileService {
    constructor(
    @Inject(Database)
    private readonly db: Database, 
    @Inject(ReportingService)
    private readonly reports: ReportingService) {
    }
    async reconcile(ctx: RequestContext, id: string, period: Period, authorization: string, includeFinancial: boolean) {
        if (includeFinancial)
            assertFinancial(ctx);
        const studentId = await this.db.withTenant(ctx.businessId, tx => authorizedRoot(tx, ctx, id));
        const deadline = Date.now() + 25000, budget: ReadBudget = {
            remaining: 12 * 1024 * 1024
        };
        const syncSource = async (source: 'scheduling' | 'learning' | 'billing') => {
            try {
                let result: PageResult = {
                    rows: [], complete: true
                }, materials: PageResult | undefined, finance: z.infer<typeof financeResponse> | undefined;
                if (source === 'scheduling')
                    result = await pages('scheduling', `/v1/portal/classes?studentId=${studentId}&month=${period.month}&timeZone=${encodeURIComponent(period.timeZone)}`, authorization, deadline, budget);
                else if (source === 'learning') {
                    const values = await Promise.all([pages('learning', `/v1/portal/assignments?clientId=${studentId}`, authorization, deadline, budget), pages('learning', `/v1/portal/resources?clientId=${studentId}`, authorization, deadline, budget)]);
                    result = values[0];
                    materials = values[1];
                }
                else
                    finance = financeResponse.parse(await fetchPage('billing', `/v1/portal/finance?studentId=${studentId}&limit=200&offset=0`, authorization, deadline, budget));
                await this.db.withTenant(ctx.businessId, async (tx) => {
                    await lockReports(tx, ctx.businessId);
                    const current = await authorizedRoot(tx, ctx, id);
                    const validateIdentity = async (record: Record<string, unknown>) => {
                        const recordId = record.studentId ?? record.clientId;
                        if (typeof recordId !== 'string' || await studentRoot(tx, recordId) !== current)
                            throw new SourceUnavailable('Student identity changed at source; wait for identity synchronization and retry');
                    };
                    if (source === 'scheduling')
                        for (const row of result.rows) {
                            await validateIdentity(row);
                            await projectClass(tx, ctx.businessId, {
                                ...row, classId: row.classId ?? row.id
                            });
                        }
                    if (source === 'learning') {
                        for (const row of result.rows) {
                            await validateIdentity(row);
                            await projectAssignment(tx, ctx.businessId, {
                                ...row, assignmentId: row.id
                            });
                            for (const property of ['resources', 'submissionResources']) {
                                const refs = z.array(z.record(z.string(), z.unknown())).max(50).parse(row[property] ?? []);
                                for (const resource of refs) {
                                    await validateIdentity(resource);
                                    await projectResource(tx, ctx.businessId, {
                                        ...resource, resourceId: resource.id, assignmentId: property === 'submissionResources' ? row.id : null
                                    });
                                }
                            }
                        }
                        for (const resource of materials!.rows) {
                            await validateIdentity(resource);
                            await projectResource(tx, ctx.businessId, {
                                ...resource, resourceId: resource.id, assignmentId: null
                            });
                        }
                    }
                    if (finance) {
                        if (await studentRoot(tx, finance.studentId) !== current)
                            throw new SourceUnavailable('Student financial identity changed; retry after synchronization');
                        for (const invoice of finance.items) {
                            await validateIdentity(invoice);
                            await projectInvoice(tx, ctx.businessId, {
                                ...invoice, invoiceId: invoice.id, studentId: current, amountMinor: invoice.totalMinor, eventAt: finance.asOf, revision: invoice.revision ?? 1
                            });
                        }
                        await tx.query('INSERT INTO report_finance_snapshots(business_id,student_id,totals,invoice_count,as_of,complete) VALUES($1,$2,$3::jsonb,$4,$5,true) ON CONFLICT(business_id,student_id) DO UPDATE SET totals=EXCLUDED.totals,invoice_count=EXCLUDED.invoice_count,as_of=EXCLUDED.as_of,complete=true', [ctx.businessId, current, JSON.stringify(finance.totals), finance.total, finance.asOf]);
                    }
                    let complete = result.complete && (materials?.complete ?? true), reason = result.reason ?? materials?.reason ?? null;
                    if (source === 'scheduling') {
                        const known = await tx.query<{
                            count: string;
                        }>(`SELECT count(*) FROM report_classes WHERE student_id=$1 AND (starts_at AT TIME ZONE $2)::date>=($3||'-01')::date AND (starts_at AT TIME ZONE $2)::date<(($3||'-01')::date+interval '1 month')`, [current, period.timeZone, period.month]);
                        if (Number(known.rows[0]!.count) > new Set(result.rows.map(r => `${r.source}:${r.classId ?? r.id}`)).size) {
                            complete = false;
                            reason = 'Source history or identity projection is catching up; reconcile again';
                        }
                    }
                    if (source === 'learning') {
                        const known = await tx.query<{
                            count: string;
                        }>('SELECT count(*) FROM report_assignments WHERE student_id=$1', [current]);
                        if (Number(known.rows[0]!.count) > new Set(result.rows.map(r => r.id)).size) {
                            complete = false;
                            reason = 'Source homework history or identity projection is catching up; reconcile again';
                        }
                    }
                    if (finance) {
                        const known = await tx.query<{
                            count: string;
                        }>('SELECT count(*) FROM report_invoices WHERE student_id=$1 AND issued_at IS NOT NULL', [current]);
                        if (Number(known.rows[0]!.count) > finance.total) {
                            complete = false;
                            reason = 'Billing identity projection is catching up; reconcile again';
                            await tx.query('UPDATE report_finance_snapshots SET complete=false WHERE student_id=$1', [current]);
                        }
                        const newer = await tx.query('SELECT 1 FROM report_invoices WHERE student_id=$1 AND event_at>$2::timestamptz LIMIT 1', [current, finance.asOf]);
                        if (newer.rowCount) {
                            complete = false;
                            reason = 'Billing changed during reconciliation; refresh again';
                            await tx.query('UPDATE report_finance_snapshots SET complete=false WHERE student_id=$1', [current]);
                        }
                    }
                    await this.coverage(tx, ctx, current, source, period, complete ? 'complete' : 'partial', reason);
                    await emitEvent(tx, {
                        type: 'reporting.student-reconciled.v1', producer: 'reporting', businessId: ctx.businessId, correlationId: ctx.requestId, data: {
                            studentId: current, source, month: period.month, timeZone: period.timeZone, complete
                        }
                    });
                });
            }
            catch (error) {
                const reason = error instanceof SourceUnavailable ? error.reason : 'Source response could not be reconciled';
                await this.db.withTenant(ctx.businessId, async (tx) => {
                    await lockReports(tx, ctx.businessId);
                    const current = await authorizedRoot(tx, ctx, id);
                    await this.coverage(tx, ctx, current, source, period, 'unavailable', reason);
                    if (source === 'billing')
                        await tx.query('UPDATE report_finance_snapshots SET complete=false WHERE student_id=$1', [current]);
                });
            }
        };
        await Promise.all([syncSource('scheduling'), syncSource('learning'), ...includeFinancial ? [syncSource('billing')] : []]);
        const response = await this.reports.summaries(ctx, [id], period, includeFinancial);
        return {
            item: response.items[0]
        };
    }
    private async coverage(tx: PoolClient, ctx: RequestContext, id: string, source: string, period: Period, status: string, reason: string | null) {
        await tx.query(`INSERT INTO report_coverage(business_id,student_id,source,month,time_zone,status,as_of,reason) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6='unavailable' THEN NULL ELSE now() END,$7) ON CONFLICT(business_id,student_id,source,month,time_zone) DO UPDATE SET status=EXCLUDED.status,as_of=COALESCE(EXCLUDED.as_of,report_coverage.as_of),attempted_at=now(),reason=EXCLUDED.reason`, [ctx.businessId, id, source, period.month, period.timeZone, status, reason]);
    }
}
