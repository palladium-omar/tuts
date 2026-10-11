import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from '@nestjs/common';
import { CurrentContext, Permissions, Roles } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { HistoryStudentsService } from './history-students.js';

@Controller('v1/history-imports')
@Roles('owner', 'admin', 'tutor')
@Permissions('billing.read', 'reporting.financial', 'clients.read')
export class HistoryStudentsController {
  constructor(@Inject(HistoryStudentsService) private readonly service: HistoryStudentsService) {}
  @Get(':id/students')
  async students(@CurrentContext() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) { return { item: await this.service.students(ctx, id, query) }; }
  @Post(':id/students')
  @Permissions('billing.read', 'billing.write', 'reporting.financial', 'clients.read', 'clients.write')
  async review(@CurrentContext() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown, @Headers('authorization') authorization: unknown) { return { item: await this.service.review(ctx, id, body, authorization) }; }
}
