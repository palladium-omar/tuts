import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentContext, Permissions, Roles } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import type { Response } from 'express';
import { MAX_HISTORY_BYTES } from './history-parser.js';
import { HistoryService } from './history.js';
import { HistoryAnalyticsService } from './history-analytics.js';

@Controller('v1/history-imports')
@Roles('owner','admin','tutor')
@Permissions('billing.read','reporting.financial')
export class HistoryImportsController {
  constructor(@Inject(HistoryService) private readonly service:HistoryService){}
  @Post('preview')
  @Permissions('billing.read','reporting.financial','billing.write')
  @UseInterceptors(FileInterceptor('file',{limits:{fileSize:MAX_HISTORY_BYTES,files:1,fields:1,parts:2,fieldSize:32768},fileFilter:(_req,file,done)=>done(null,/\.(csv|xlsx|pdf)$/i.test(file.originalname))}))
  async preview(@CurrentContext() ctx:RequestContext,@UploadedFile() file:{originalname:string;buffer:Buffer}|undefined,@Body('options') options:unknown){return {item:await this.service.preview(ctx,file,options)};}
  @Post('commit')
  @Permissions('billing.read','reporting.financial','billing.write')
  async commit(@CurrentContext() ctx:RequestContext,@Body() body:unknown,@Headers('idempotency-key') key:unknown){return {item:await this.service.commit(ctx,body,key)};}
  @Get() list(@CurrentContext() ctx:RequestContext,@Query() query:unknown){return this.service.sources(ctx,query);}
  @Get(':id/download')
  async download(@CurrentContext() ctx:RequestContext,@Param('id') id:string,@Res({passthrough:true}) response:Response){
    const source=await this.service.download(ctx,id),fallback=source.file_name.replace(/[^a-zA-Z0-9._ -]/g,'_');
    response.setHeader('Content-Type',source.content_type);response.setHeader('Content-Disposition',`attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(source.file_name).replace(/['()*]/g,v=>`%${v.charCodeAt(0).toString(16).toUpperCase()}`)}`);response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Cache-Control','private, no-store');response.setHeader('Content-Length',source.file_bytes.length);return new StreamableFile(source.file_bytes);
  }
}
@Controller('v1/work-log')
@Roles('owner','admin','tutor')
@Permissions('billing.read','reporting.financial')
export class WorkLogController {
  constructor(@Inject(HistoryService) private readonly service:HistoryService){}
  @Get() list(@CurrentContext() ctx:RequestContext,@Query() query:unknown){return this.service.workLog(ctx,query);}
  @Get('summary') async summary(@CurrentContext() ctx:RequestContext,@Query() query:unknown){return {item:await this.service.workSummary(ctx,query)};}
  @Patch(':id') @Permissions('billing.read','reporting.financial','billing.write')
  async edit(@CurrentContext() ctx:RequestContext,@Param('id') id:string,@Body() body:unknown){return {item:await this.service.editWork(ctx,id,body)};}
}
@Controller('v1/invoice-history')
@Roles('owner','admin','tutor')
@Permissions('billing.read','reporting.financial')
export class InvoiceHistoryController {
  constructor(@Inject(HistoryService) private readonly service:HistoryService){}
  @Get() list(@CurrentContext() ctx:RequestContext,@Query() query:unknown){return this.service.invoiceHistory(ctx,query);}
  @Post() @Permissions('billing.read','reporting.financial','billing.write')
  async create(@CurrentContext() ctx:RequestContext,@Body() body:unknown,@Headers('idempotency-key') key:unknown){return {item:await this.service.manualInvoice(ctx,body,key)};}
  @Patch(':id') @Permissions('billing.read','reporting.financial','billing.write')
  async edit(@CurrentContext() ctx:RequestContext,@Param('id') id:string,@Body() body:unknown){return {item:await this.service.editInvoice(ctx,id,body)};}
}
@Controller('v1/business-analytics')
@Roles('owner','admin','tutor')
@Permissions('billing.read','reporting.financial')
export class BusinessAnalyticsController {
  constructor(@Inject(HistoryAnalyticsService) private readonly service:HistoryAnalyticsService){}
  @Get() async get(@CurrentContext() ctx:RequestContext,@Query() query:unknown){return {item:await this.service.analytics(ctx,query)};}
}
