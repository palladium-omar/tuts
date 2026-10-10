import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Headers, Inject, Injectable, NotFoundException, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { CurrentContext, Database, Permissions, Public, Roles, StudentScoped, emitEvent, parseBody, serviceFetch, assertStudentAccess } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import type { PoolClient } from 'pg';
import type { Response } from 'express';
import { z } from 'zod';
import { ReportingService, authorizedRoot } from './reporting.service.js';
import { lockReports } from './projections.js';
import { periodShape } from './schemas.js';
import { readJson } from './reconcile.service.js';
export const beaconsCapabilities = {
    provider: 'beacons', verifiedAt: '2026-10-10', creator: {
        directConversionWrite: {
            available: false, reason: 'No verified public creator conversion-ingestion API is documented. Tuts does not transmit conversions to Beacons.'
        },
        taggedLinks: {
            available: true
        }, csvExport: {
            available: true
        },
    }, brands: {
        directConversionWrite: {
            available: false, reason: 'Brands API setup is documented, but endpoint contracts are not published in the official guide; no connector is configured.'
        },
        analyticsMcp: {
            available: false, reason: 'Beacons for Brands supports account-specific Amplitude, Mixpanel and PostHog connections. Tuts has not configured or authorized an analytics destination.'
        },
    },
    sources: [
        'https://help.beacons.ai/en/articles/4698753', 'https://help.beacons.ai/en/articles/11826369', 'https://help.beacons.ai/en/articles/11826433'
    ],
};
const tag = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const createLink = z.object({
    label: z.string().trim().min(1).max(120), destinationUrl: z.string().url().max(1000), source: tag.default('beacons'), campaign: tag
}).strict();
const listQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0)
}).strict();
const updateLink = z.object({
    expectedRevision: z.number().int().positive(), enabled: z.boolean()
}).strict();
const association = z.object({
    studentId: z.uuid()
}).strict();
const reportBody = z.object({
    ...periodShape, studentIds: z.array(z.uuid()).min(1).max(100), linkIds: z.array(z.uuid()).max(100).default([]), includeFinancial: z.boolean().default(false)
}).strict();
type LinkRow = {
    business_id: string;
    id: string;
    public_token: string;
    created_by: string;
    label: string;
    destination_url: string;
    tagged_url: string;
    source: string;
    campaign: string;
    enabled: boolean;
    revision: number;
    created_at: Date;
    updated_at: Date;
};
function baseUrl(name: string): URL {
    const raw = process.env[name];
    if (!raw)
        throw new ConflictException(`${name} is not configured`);
    let url: URL;
    try {
        url = new URL(raw);
    }
    catch {
        throw new ConflictException(`${name} is not a valid URL`);
    }
    const localHttp = process.env.NODE_ENV !== 'production' && process.env.TUTS_RUNTIME !== 'cloudflare' && url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname);
    if ((!localHttp && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash)
        throw new ConflictException(`${name} must be an HTTPS URL without credentials or query`);
    return url;
}
function destination(raw: string): URL {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash)
        throw new BadRequestException('Use a destination without credentials, query parameters or fragment');
    if (url.hostname === 'cal.com') {
        if (url.protocol !== 'https:' || url.port) throw new BadRequestException('Cal.com booking URLs must use HTTPS without a custom port');
        if (!/^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_/-]+$/.test(url.pathname) || /^\/(api|auth|settings|login|reset-password)(\/|$)/i.test(url.pathname))
            throw new BadRequestException('Use a Cal.com booking event URL');
    }
    else {
        const app = baseUrl('PUBLIC_APP_URL');
        if (url.origin !== app.origin || ![
            '/', '/portal', '/portal/'
        ].includes(url.pathname))
            throw new BadRequestException('Use the configured Tuts homepage or portal URL, or a Cal.com booking event URL');
    }
    return url;
}
function dto(row: LinkRow) {
    const base = baseUrl('PUBLIC_REPORTING_BASE_URL');
    const root = base.toString().replace(/\/$/, '');
    return {
        id: row.id, label: row.label, destinationUrl: row.destination_url, taggedUrl: row.tagged_url, source: row.source, campaign: row.campaign, enabled: row.enabled, revision: row.revision, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), redirectUrl: `${root}/v1/public/links/${row.business_id}/${row.public_token}`
    };
}
function csvCell(value: unknown): string {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[=+@\-\t\r\n]/.test(text))
        text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}
@Injectable()
export class AttributionService {
    constructor(
    @Inject(Database)
    private readonly db: Database, 
    @Inject(ReportingService)
    private readonly reports: ReportingService) {
    }
    private async owned(tx: PoolClient, ctx: RequestContext, id: string, update = false): Promise<LinkRow> {
        const rows = await tx.query<LinkRow>(`SELECT * FROM attribution_links WHERE id=$1${update ? ' FOR UPDATE' : ''}`, [
            id
        ]);
        const row = rows.rows[0];
        if (!row)
            throw new NotFoundException('Tracked link not found');
        if (row.created_by !== ctx.sub && !(ctx.accessScope !== 'students' && [
            'owner', 'admin'
        ].includes(ctx.role)))
            throw new ForbiddenException('Tracked link access is not granted');
        return row;
    }
    async create(ctx: RequestContext, v: z.infer<typeof createLink>) {
        baseUrl('PUBLIC_REPORTING_BASE_URL');
        const target = destination(v.destinationUrl), tagged = new URL(target);
        tagged.searchParams.set('utm_source', v.source);
        tagged.searchParams.set('utm_medium', 'link');
        tagged.searchParams.set('utm_campaign', v.campaign);
        const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
        return this.db.withTenant(ctx.businessId, async (tx) => {
            const rows = await tx.query<LinkRow>('INSERT INTO attribution_links(business_id,id,public_token,created_by,label,destination_url,tagged_url,source,campaign) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [
                ctx.businessId, crypto.randomUUID(), token, ctx.sub, v.label, target.toString(), tagged.toString(), v.source, v.campaign
            ]);
            await emitEvent(tx, {
                type: 'reporting.attribution-link-created.v1', producer: 'reporting', businessId: ctx.businessId, correlationId: ctx.requestId, data: {
                    linkId: rows.rows[0]!.id
                }
            });
            return {
                item: dto(rows.rows[0]!)
            };
        });
    }
    async list(ctx: RequestContext, limit: number, offset: number) {
        return this.db.withTenant(ctx.businessId, async (tx) => {
            const all = ctx.accessScope !== 'students' && [
                'owner', 'admin'
            ].includes(ctx.role);
            const rows = await tx.query<LinkRow>('SELECT * FROM attribution_links WHERE ($1 OR created_by=$2) ORDER BY created_at DESC,id LIMIT $3 OFFSET $4', [
                all, ctx.sub, limit, offset
            ]);
            const count = await tx.query<{
                total: string;
            }>('SELECT count(*) total FROM attribution_links WHERE ($1 OR created_by=$2)', [
                all, ctx.sub
            ]);
            return {
                items: rows.rows.map(dto), total: Number(count.rows[0]!.total), limit, offset
            };
        });
    }
    async update(ctx: RequestContext, id: string, v: z.infer<typeof updateLink>) {
        return this.db.withTenant(ctx.businessId, async (tx) => {
            const row = await this.owned(tx, ctx, id, true);
            if (row.revision !== v.expectedRevision)
                throw new ConflictException('Tracked link changed; refresh before updating');
            const rows = await tx.query<LinkRow>('UPDATE attribution_links SET enabled=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *', [
                id, v.enabled
            ]);
            await emitEvent(tx, {
                type: 'reporting.attribution-link-updated.v1', producer: 'reporting', businessId: ctx.businessId, correlationId: ctx.requestId, data: {
                    linkId: id, revision: rows.rows[0]!.revision, enabled: v.enabled
                }
            });
            return {
                item: dto(rows.rows[0]!)
            };
        });
    }
    async associate(ctx: RequestContext, id: string, studentId: string, remove = false, authorization?: string) {
        let verifiedStudentId = studentId;
        if (!remove) {
            assertStudentAccess(ctx, studentId);
            await this.db.withTenant(ctx.businessId, tx => this.owned(tx, ctx, id));
            const response = await serviceFetch('clients', `/v1/portal/students/${studentId}`, {
                headers: {
                    authorization: authorization ?? ''
                }, signal: AbortSignal.timeout(8000)
            });
            if (response.status === 404) {
                await response.body?.cancel();
                throw new NotFoundException('Student not found');
            }
            if (response.status === 403) {
                await response.body?.cancel();
                throw new ForbiddenException('Student access is not granted');
            }
            try {
                const result = z.object({
                    item: z.object({
                        id: z.uuid()
                    })
                }).parse(await readJson(response, {
                    remaining: 1024 * 1024
                }));
                verifiedStudentId = result.item.id;
                assertStudentAccess(ctx, verifiedStudentId);
            }
            catch (error) {
                if (error instanceof ForbiddenException)
                    throw error;
                throw new ConflictException('Student identity could not be verified; refresh and retry');
            }
        }
        return this.db.withTenant(ctx.businessId, async (tx) => {
            await lockReports(tx, ctx.businessId);
            await this.owned(tx, ctx, id, true);
            const canonical = await authorizedRoot(tx, ctx, verifiedStudentId);
            const result = remove ? await tx.query('DELETE FROM attribution_link_students WHERE link_id=$1 AND student_id=$2 RETURNING student_id', [
                id, canonical
            ]) : await tx.query('INSERT INTO attribution_link_students(business_id,link_id,student_id,linked_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING student_id', [
                ctx.businessId, id, canonical, ctx.sub
            ]);
            if (result.rowCount)
                await emitEvent(tx, {
                    type: 'reporting.attribution-student-linked.v1', producer: 'reporting', businessId: ctx.businessId, correlationId: ctx.requestId, data: {
                        linkId: id, studentId: canonical, linked: !remove, provenance: 'explicit_staff_selection'
                    }
                });
            return {
                item: {
                    linkId: id, studentId: canonical, linked: !remove, changed: Boolean(result.rowCount), provenance: 'explicit_staff_selection'
                }
            };
        });
    }
    async redirect(businessId: string, token: string, count: boolean) {
        return this.db.withTenant(businessId, async (tx) => {
            const rows = await tx.query<{
                id: string;
                tagged_url: string;
                destination_url: string;
            }>('SELECT id,tagged_url,destination_url FROM attribution_links WHERE public_token=$1 AND enabled=true', [
                token
            ]);
            const row = rows.rows[0];
            if (!row)
                throw new NotFoundException('Tracked link is unavailable');
            // Revalidate against current allowlist, including after environment changes.
            destination(row.destination_url);
            if (count) {
                await tx.query(`INSERT INTO attribution_link_daily(business_id,link_id,day,requests) VALUES($1,$2,(clock_timestamp() AT TIME ZONE 'UTC')::date,1) ON CONFLICT(business_id,link_id,day) DO UPDATE SET requests=attribution_link_daily.requests+1`, [
                    businessId, row.id
                ]);
                await emitEvent(tx, {
                    type: 'reporting.attribution-request-recorded.v1', producer: 'reporting', businessId, correlationId: crypto.randomUUID(), data: {
                        linkId: row.id, metric: 'redirect_requests', timeZone: 'UTC'
                    }
                });
            }
            return row.tagged_url;
        });
    }
    async report(ctx: RequestContext, v: z.infer<typeof reportBody>) {
        const summaries = await this.reports.summaries(ctx, v.studentIds, v, v.includeFinancial);
        const students = summaries.items.map(r => r.studentId);
        const links = await this.db.withTenant(ctx.businessId, async (tx) => {
            await lockReports(tx, ctx.businessId);
            const items = [];
            for (const id of [
                ...new Set(v.linkIds)
            ]) {
                const row = await this.owned(tx, ctx, id);
                const associated = await tx.query<{
                    student_id: string;
                }>('SELECT student_id FROM attribution_link_students WHERE link_id=$1 AND student_id=ANY($2::uuid[]) ORDER BY student_id', [
                    id, students
                ]);
                const requests = await tx.query<{
                    requests: string;
                }>(`SELECT coalesce(sum(requests),0)::text requests FROM attribution_link_daily WHERE link_id=$1 AND day>=($2||'-01')::date AND day<(($2||'-01')::date+interval '1 month')`, [
                    id, v.month
                ]);
                items.push({
                    id: row.id, label: row.label, source: row.source, campaign: row.campaign, requests: Number(requests.rows[0]!.requests), requestTimeZone: 'UTC', selectedStudentIds: associated.rows.map(r => r.student_id), provenance: 'explicit_staff_selection', conversionMatching: {
                        status: 'unmatched', matchedConversions: null, reason: 'Requests are anonymous; explicit student associations do not prove a click caused a booking or payment.'
                    }
                });
            }
            return items;
        });
        return {
            items: summaries.items, links, month: v.month, timeZone: v.timeZone, asOf: summaries.asOf, provenance: {
                metrics: 'verified_service_events_and_authorized_http_reconciliation', payments: 'billing_recorded_payments_real_and_simulated_separate', studentAssociation: 'explicit_staff_selection', clicks: 'anonymous_redirect_requests_utc_daily', providerTransmission: 'none'
            }, capabilities: beaconsCapabilities
        };
    }
    async csv(ctx: RequestContext, v: z.infer<typeof reportBody>) {
        const report = await this.report(ctx, v);
        const headers = [
            'record_type', 'student_id', 'link_id', 'month', 'time_zone', 'metric', 'value', 'currency', 'provenance', 'coverage', 'as_of'
        ];
        const rows: unknown[][] = [
            headers
        ];
        for (const item of report.items) {
            const metrics: Array<[
                string,
                unknown
            ]> = [
                ...Object.entries(item.bookings).map(([key, value]): [
                    string,
                    unknown
                ] => [
                    `bookings.${key}`, value
                ]),
                ...Object.entries(item.homework).map(([key, value]): [
                    string,
                    unknown
                ] => [
                    `homework.${key}`, value
                ]),
                [
                    'activity.activeSeconds', item.activity.activeSeconds
                ], [
                    'activity.lastSeenAt', item.activity.lastSeenAt
                ],
                [
                    'resources.materials', item.resources.materials
                ], [
                    'resources.submissionFiles', item.resources.submissionFiles
                ],
            ];
            for (const [key, value] of metrics)
                rows.push([
                    'student_metric', item.studentId, '', key.startsWith('resources.') ? 'all_time' : v.month, v.timeZone, key, value, '', report.provenance.metrics, JSON.stringify(item.coverage), item.asOf
                ]);
            if (item.financial)
                rows.push([
                    'student_finance', item.studentId, '', 'all_time', '', 'issuedInvoiceCount', item.financial.issuedInvoiceCount, '', report.provenance.payments, item.coverage.billing?.status, item.financial.asOf
                ]);
            for (const total of (item.financial?.totalsByCurrency ?? []) as Array<Record<string, unknown>>)
                for (const key of [
                    'billedMinor', 'collectedMinor', 'simulatedMinor', 'outstandingMinor'
                ])
                    rows.push([
                        'student_finance', item.studentId, '', 'all_time', '', key, total[key], total.currency, report.provenance.payments, item.coverage.billing?.status, item.financial?.asOf
                    ]);
        }
        for (const link of report.links)
            rows.push([
                'link_requests', '', link.id, v.month, 'UTC', 'requests', link.requests, '', report.provenance.clicks, 'unmatched', report.asOf
            ]);
        return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    }
}
@StudentScoped()
@Controller('v1/attribution')
export class AttributionController {
    constructor(
    @Inject(AttributionService)
    private readonly service: AttributionService) {
    }
    @Get('capabilities')
    @Permissions('reporting.read')
    capabilities() {
        return {
            item: beaconsCapabilities
        };
    }
    @Get('links')
    @Roles('owner', 'admin', 'tutor')
    @Permissions('reporting.read')
    list(
    @CurrentContext()
    ctx: RequestContext, 
    @Query()
    query: unknown) {
        const v = parseBody(listQuery, query);
        return this.service.list(ctx, v.limit, v.offset);
    }
    @Post('links')
    @Roles('owner', 'admin', 'tutor')
    @Permissions('reporting.write')
    create(
    @CurrentContext()
    ctx: RequestContext, 
    @Body()
    body: unknown) {
        return this.service.create(ctx, parseBody(createLink, body));
    }
    @Patch('links/:id')
    @Roles('owner', 'admin', 'tutor')
    @Permissions('reporting.write')
    update(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    id: string, 
    @Body()
    body: unknown) {
        return this.service.update(ctx, parseBody(z.uuid(), id), parseBody(updateLink, body));
    }
    @Post('links/:id/students')
    @Roles('owner', 'admin', 'tutor')
    @Permissions('reporting.write')
    associate(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @Headers('authorization')
    authorization: string) {
        return this.service.associate(ctx, parseBody(z.uuid(), id), parseBody(association, body).studentId, false, authorization);
    }
    @Delete('links/:id/students/:studentId')
    @Roles('owner', 'admin', 'tutor')
    @Permissions('reporting.write')
    remove(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    id: string, 
    @Param('studentId')
    studentId: string) {
        return this.service.associate(ctx, parseBody(z.uuid(), id), parseBody(z.uuid(), studentId), true);
    }
    @Post('report')
    @Roles('owner', 'admin', 'tutor')
    @Permissions('reporting.read')
    report(
    @CurrentContext()
    ctx: RequestContext, 
    @Body()
    body: unknown) {
        return this.service.report(ctx, parseBody(reportBody, body));
    }
    @Post('export.csv')
    @Roles('owner', 'admin', 'tutor')
    @Permissions('reporting.read')
    async csv(
    @CurrentContext()
    ctx: RequestContext, 
    @Body()
    body: unknown, 
    @Res()
    res: Response) {
        const content = await this.service.csv(ctx, parseBody(reportBody, body));
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="tuts-selected-report.csv"');
        res.send(content);
    }
}
@Controller('v1/public/links')
export class AttributionRedirectController {
    constructor(
    @Inject(AttributionService)
    private readonly service: AttributionService) {
    }
    @Public()
    @Get(':businessId/:token')
    async redirect(
    @Param('businessId')
    businessId: string, 
    @Param('token')
    token: string, 
    @Headers('purpose')
    purpose: string, 
    @Headers('sec-purpose')
    secPurpose: string, 
    @Res()
    res: Response) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        const id = parseBody(z.uuid(), businessId), opaque = parseBody(z.string().regex(/^[a-f0-9]{64}$/), token);
        const count = !/prefetch|preview/i.test(`${purpose ?? ''} ${secPurpose ?? ''}`) && res.req.method === 'GET';
        res.redirect(302, await this.service.redirect(id, opaque, count));
    }
}
