import { Controller, Get, Headers, Inject, Param, Query } from '@nestjs/common';
import { CurrentContext, Permissions, Roles, StudentScoped } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { StudentWorkHistoryService } from './student-work-history.js';

@Controller('v1/students')
@Roles('owner', 'admin', 'tutor')
@StudentScoped()
@Permissions('billing.read', 'reporting.financial', 'clients.read')
export class StudentWorkHistoryController {
  constructor(@Inject(StudentWorkHistoryService) private readonly service: StudentWorkHistoryService) {}
  @Get(':id/work-history')
  history(@CurrentContext() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown, @Headers('authorization') authorization: unknown) {
    return this.service.history(ctx, id, query, authorization);
  }
}
