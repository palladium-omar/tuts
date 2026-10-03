import 'reflect-metadata';
import { BadRequestException, Catch, Controller, Get, HttpException, Inject, Module, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import type { ZodType } from 'zod';
import { Database } from './database.js';
import { EventBus } from './events.js';
import { ContextGuard, OPTIONS, Public, type ServiceOptions } from './auth.js';
export { Database } from './database.js';
export { EventBus, emitEvent } from './events.js';
export { Public, Roles, CurrentContext } from './auth.js';
export type { RequestContext, PlatformEvent } from '@palladium/contracts';
export function parseBody<T>(schema:ZodType<T>,input:unknown):T {
  const result=schema.safeParse(input);
  if(!result.success)throw new BadRequestException(result.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; '));
  return result.data;
}
@Catch()
class ApiErrors implements ExceptionFilter {
  catch(error:unknown,host:ArgumentsHost){
    const http=host.switchToHttp();const req=http.getRequest();const res=http.getResponse();
    let status=500; let code='internal_error';let message='Request could not be completed';
    if(error instanceof HttpException){status=error.getStatus();const body=error.getResponse();message=typeof body==='string'?body:(body as any).message ?? message;code=(typeof body==='object' && (body as any).code) || `http_${status}`;}
    else if(error && typeof error==='object' && 'code' in error && ['23505','23P01'].includes(String(error.code))){status=409;code='conflict';message='Operation conflicts with existing data';}
    else if(error && typeof error==='object' && 'code' in error && ['22P02','23514','22007'].includes(String(error.code))){status=400;code='invalid_input';message='Invalid request data';}
    if(status===500)console.error('Unhandled request failure',error instanceof Error ? error.name : typeof error);
    res.status(status).json({error:{code,message},requestId:req.context?.requestId ?? req.headers['x-request-id'] ?? null});
  }
}
@Public()
@Controller('health')
class HealthController {
  constructor(@Inject(Database) private readonly db:Database,@Inject(EventBus) private readonly events:EventBus,@Inject(OPTIONS) private readonly options:ServiceOptions){}
  @Get()async health(){await this.db.pool.query('SELECT 1');return {service:this.options.name,status:'ok',events:this.events.connected?'connected':'unavailable'};}
}
export async function bootstrap(options:ServiceOptions):Promise<void>{
  if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
  @Module({controllers:[HealthController,...options.controllers],providers:[{provide:OPTIONS,useValue:options},Database,EventBus,ContextGuard,...(options.providers??[])]})
  class ServiceModule{}
  const app=await NestFactory.create(ServiceModule,{rawBody:true});
  const db=app.get(Database);
  await db.migrate(options.migrationsDir);
  app.useGlobalGuards(app.get(ContextGuard));
  app.useGlobalFilters(new ApiErrors());
  app.enableShutdownHooks();
  await app.init();
  const doc=SwaggerModule.createDocument(app,new DocumentBuilder().setTitle(`Tuts ${options.name}`).setVersion('1').addBearerAuth().build());
  app.getHttpAdapter().get('/openapi.json',(_req:any,res:any)=>res.json(doc));
  await app.listen(Number(process.env.PORT ?? options.port),'0.0.0.0');
  await app.get(EventBus).start();
}
