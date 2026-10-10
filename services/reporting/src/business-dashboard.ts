import { Controller, ForbiddenException, Get, Headers, Inject, Injectable, Query, UnauthorizedException } from '@nestjs/common';
import { CurrentContext, Permissions, Roles, assertPermission, parseBody, serviceFetch } from '@palladium/service-kit';
import { canReadFinancial, hasPermission, type RequestContext } from '@palladium/contracts';
import { z } from 'zod';
import { monthSchema, timeZoneSchema } from './schemas.js';

const querySchema = z.object({ month: monthSchema.optional() }).strict();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const measure = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nullableCount = count.nullable();
const statsResponse = z.object({ item: z.object({ total: count, active: count, leads: count, inactive: count })
  .refine(value => value.total === value.active + value.leads + value.inactive) });
const currencySchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  totalRecordedRevenueMinor: nullableCount,
  historicalPaidMinor: nullableCount,
  verifiedCollectedMinor: nullableCount,
  pendingMinor: nullableCount,
  unsentMinor: nullableCount,
  expectedThisMonthMinor: nullableCount,
  ledgerTotalMinor: nullableCount.optional(), ledgerPaidMinor: nullableCount.optional(),
  ledgerPendingMinor: nullableCount.optional(), ledgerUnsentMinor: nullableCount.optional(),
  ledgerMonthMinor: nullableCount.optional(), nativeExpectedMinor: nullableCount.optional(),
});
const analyticsResponse = z.object({ item: z.object({
  month: monthSchema,
  timeZone: timeZoneSchema,
  asOf: z.string().datetime({ offset: true }),
  students: z.object({ tracked: nullableCount, activeThisMonth: nullableCount, activePreviousMonth: nullableCount, lostFromPreviousMonth: nullableCount }),
  engagement: z.object({
    totalHours: measure.nullable(), monthHours: measure.nullable(),
    averageCommitmentHours: measure.nullable(), averageClassFrequency: measure.nullable(),
    churnRate: z.number().finite().min(0).max(1).nullable(),
  }),
  currencies: z.array(currencySchema).max(200).refine(values => new Set(values.map(value => value.currency)).size === values.length),
  trend: z.array(z.object({ month: monthSchema, hours: measure.nullable(), activeStudents: nullableCount, classes: nullableCount })).max(2412)
    .refine(values => new Set(values.map(value => value.month)).size === values.length),
  coverage: z.object({
    workRows: nullableCount, importedInvoices: nullableCount, nativeInvoices: nullableCount,
    confirmedClasses: nullableCount, sourceFiles: nullableCount,
    studentIdentity: z.enum(['unlinked_source_names_and_native_student_ids','reviewed_work_rows_and_native_student_ids','partial_reviewed_work_identities']),
    payments: z.literal('verified_allocations_excluding_simulated'),
    churn: z.literal('inactivity'), provisional: z.boolean(),
    notes: z.array(z.string().max(300)).max(20),
  }),
}) });

export type BusinessAnalytics = z.infer<typeof analyticsResponse>['item'];
export type DashboardSource = { name: string; status: 'complete' | 'unavailable'; reason?: string };
type SourceResult<T> = { value: T; source: DashboardSource } | { value: null; source: DashboardSource };
type FetchSource = typeof serviceFetch;
const timeoutMs = 8000;
const responseLimit = 1024 * 1024;

class SourceUnavailable extends Error {}

// The deadline covers both fetching and body consumption. Some private bindings
// do not reject on abort, so the timer also races the entire source operation.
async function sourceJson(fetchSource: FetchSource, service: string, path: string, authorization: string, duration: number): Promise<unknown> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = async () => {
    const response = await fetchSource(service, path, { headers: { authorization }, signal: controller.signal });
    if (controller.signal.aborted) {
      await response.body?.cancel();
      throw new SourceUnavailable('Source request timed out');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceUnavailable(response.status === 401 ? 'Verified authorization expired; refresh the dashboard' : response.status === 403 ? 'Source capability or entitlement is unavailable' : 'Source service is unavailable');
    }
    if (!response.body) throw new SourceUnavailable('Source returned an invalid aggregate');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > responseLimit) {
          await reader.cancel();
          throw new SourceUnavailable('Source aggregate exceeds the response limit');
        }
        chunks.push(result.value);
      }
      if (controller.signal.aborted) throw new SourceUnavailable('Source request timed out');
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } finally { reader.releaseLock(); }
  };
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        void reader?.cancel().catch(() => {});
        reject(new SourceUnavailable('Source request timed out'));
      }, duration);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function unavailable(name: string, reason: string): SourceResult<never> {
  return { value: null, source: { name, status: 'unavailable', reason } };
}

// Exported orchestration keeps bounded service contracts testable without a DB
// or any external provider. Production always supplies the private serviceFetch.
export async function composeBusinessDashboard(ctx: RequestContext, query: unknown, authorization: string, fetchSource: FetchSource = serviceFetch, duration = timeoutMs) {
  if (!['owner', 'admin', 'tutor'].includes(ctx.role) || ctx.accessScope === 'students')
    throw new ForbiddenException('Business dashboard requires business access');
  assertPermission(ctx, 'reporting.read');
  if (!ctx.entitlements.includes('reporting')) throw new ForbiddenException('Reporting is not enabled for this business');
  if (typeof authorization !== 'string' || !/^Bearer \S+$/.test(authorization)) throw new UnauthorizedException('Verified service context required');
  const input = parseBody(querySchema, query);
  const load = async <T>(name: string, service: string, path: string, schema: z.ZodType<T>): Promise<SourceResult<T>> => {
    try {
      const parsed = schema.safeParse(await sourceJson(fetchSource, service, path, authorization, duration));
      if (!parsed.success) throw new SourceUnavailable('Source returned an invalid aggregate');
      return { value: parsed.data, source: { name, status: 'complete' } };
    } catch (error) {
      return unavailable(name, error instanceof SourceUnavailable ? error.message : 'Source aggregate is unavailable');
    }
  };
  const clientAccess = hasPermission(ctx, 'clients.read') && ctx.entitlements.includes('clients');
  const financialAccess = canReadFinancial(ctx) && ctx.entitlements.includes('billing');
  const keys = ['total', 'active', 'leads', 'inactive'] as const;
  const countsPromise = clientAccess
    ? load('clients', 'clients', '/v1/clients/student-stats', statsResponse)
    : Promise.resolve(unavailable('clients', 'Student counts require Clients access'));
  const analyticsPromise = financialAccess
    ? load('billing', 'billing', `/v1/business-analytics${input.month ? `?month=${input.month}` : ''}`, analyticsResponse)
    : Promise.resolve(unavailable('billing', 'Financial analytics require Billing access and financial reporting permission'));
  const [counts, financial] = await Promise.all([countsPromise, analyticsPromise]);
  let analytics = financial.value?.item ?? null;
  if (analytics && input.month && analytics.month !== input.month) {
    analytics = null;
    financial.source = { name: 'billing', status: 'unavailable', reason: 'Source returned a different reporting month' };
  }
  return { item: {
    month: analytics?.month ?? input.month ?? new Date().toISOString().slice(0, 7),
    timeZone: analytics?.timeZone ?? null,
    asOf: new Date().toISOString(),
    students: Object.fromEntries(keys.map(key => [key, counts.value?.item[key] ?? null])) as Record<typeof keys[number], number | null>,
    analytics,
    sources: [counts.source, financial.source],
  } };
}

@Injectable()
export class BusinessDashboardService {
  dashboard(ctx: RequestContext, query: unknown, authorization: string) {
    return composeBusinessDashboard(ctx, query, authorization);
  }
}

@Roles('owner', 'admin', 'tutor')
@Controller('v1/business-dashboard')
export class BusinessDashboardController {
  constructor(@Inject(BusinessDashboardService) private readonly service: BusinessDashboardService) {}
  @Get()
  @Permissions('reporting.read')
  dashboard(@CurrentContext() ctx: RequestContext, @Query() query: unknown, @Headers('authorization') authorization: string) {
    return this.service.dashboard(ctx, query, authorization);
  }
}
