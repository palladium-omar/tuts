import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from '@nestjs/common';
import { CurrentContext, Permissions, Roles, StudentScoped, parseBody } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { z } from 'zod';
import { ReportingService } from './reporting.service.js';
import { ReconcileService } from './reconcile.service.js';
import { summaryBatch, summaryQuery, reconcileSchema, activityBody, activityQuery } from './schemas.js';
@StudentScoped()
@Controller('v1')
export class ReportingController {
    constructor(
    @Inject(ReportingService)
    private readonly reports: ReportingService, 
    @Inject(ReconcileService)
    private readonly reconciliation: ReconcileService) {
    }
    @Post('summaries')
    @Permissions('reporting.read')
    summaries(
    @CurrentContext()
    ctx: RequestContext, 
    @Body()
    body: unknown) {
        const v = parseBody(summaryBatch, body);
        return this.reports.summaries(ctx, v.studentIds, v, v.includeFinancial);
    }
    @Get('students/:id/summary')
    @Permissions('reporting.read')
    async summary(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    value: string, 
    @Query()
    query: unknown) {
        const id = parseBody(z.uuid(), value), v = parseBody(summaryQuery, query);
        return {
            item: (await this.reports.summaries(ctx, [id], v, v.includeFinancial === 'true')).items[0]
        };
    }
    @Post('students/:id/reconcile')
    @Permissions('reporting.read', 'reporting.write')
    reconcile(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    value: string, 
    @Body()
    body: unknown, 
    @Headers('authorization')
    authorization: string) {
        const id = parseBody(z.uuid(), value), v = parseBody(reconcileSchema, body);
        return this.reconciliation.reconcile(ctx, id, v, authorization, v.includeFinancial);
    }
    @Post('activity')
    @Roles('student')
    @Permissions('reporting.write')
    activity(
    @CurrentContext()
    ctx: RequestContext, 
    @Body()
    body: unknown) {
        return this.reports.activity(ctx, parseBody(activityBody, body));
    }
    @Get('students/:id/activity')
    @Permissions('reporting.read')
    history(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    value: string, 
    @Query()
    query: unknown) {
        const id = parseBody(z.uuid(), value), v = parseBody(activityQuery, query);
        return this.reports.activityHistory(ctx, id, v, v.limit, v.offset);
    }
}
