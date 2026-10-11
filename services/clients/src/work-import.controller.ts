import { Body, Controller, Inject, Post } from '@nestjs/common';
import { CurrentContext, Permissions, Roles } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { WorkImportService } from './work-import.js';

@Controller('v1/clients/work-import')
@Roles('owner', 'admin', 'tutor')
export class WorkImportController {
  constructor(@Inject(WorkImportService) private readonly service: WorkImportService) {}
  @Post('preview')
  @Permissions('clients.read')
  async preview(@CurrentContext() ctx: RequestContext, @Body() body: unknown) { return { item: await this.service.preview(ctx, body) }; }
  @Post('resolve')
  @Permissions('clients.read', 'clients.write')
  async resolve(@CurrentContext() ctx: RequestContext, @Body() body: unknown) { return { item: await this.service.resolve(ctx, body) }; }
}
