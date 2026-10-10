import {Body,Controller,Delete,Get,Header,Headers,Inject,Param,Patch,Post,Query} from '@nestjs/common';
import {CurrentContext,Permissions,Roles,StudentScoped,parseBody} from '@palladium/service-kit';
import type {RequestContext} from '@palladium/contracts';
import {PlanningService} from './planning.service.js';
import * as s from './schemas.js';
@Controller('v1')
@StudentScoped()
@Roles('owner','admin','tutor','student','parent')
export class PlanningController {
 constructor(@Inject(PlanningService) private readonly service:PlanningService) {}
 @Header('Cache-Control','no-store')
 @Get('templates') @Permissions('planning.read')
 templates(@CurrentContext() ctx:RequestContext,@Query() query:unknown) {return this.service.templates(ctx,parseBody(s.templateQuerySchema,query));}
 @Header('Cache-Control','no-store')
 @Get('templates/:key') @Permissions('planning.read')
 template(@CurrentContext() ctx:RequestContext,@Param('key') key:string,@Query() query:unknown) {return this.service.templateDetail(ctx,parseBody(s.templateKeySchema,key),parseBody(s.templateVersionQuery,query).version);}
 @Header('Cache-Control','no-store')
 @Post('templates') @Roles('owner','admin','tutor') @Permissions('planning.write')
 publish(@CurrentContext() ctx:RequestContext,@Body() body:unknown) {return this.service.createTemplate(ctx,parseBody(s.customTemplateSchema,body));}
 @Header('Cache-Control','no-store')
 @Post('templates/:key/instantiate') @Permissions('planning.write','clients.read')
 instantiate(@CurrentContext() ctx:RequestContext,@Param('key') key:string,@Body() body:unknown,@Headers('authorization') authorization:string) {return this.service.instantiate(ctx,parseBody(s.templateKeySchema,key),parseBody(s.instantiateSchema,body),authorization);}
 @Header('Cache-Control','no-store')
 @Get('boards') @Permissions('planning.read')
 boards(@CurrentContext() ctx:RequestContext,@Query() query:unknown) {return this.service.boards(ctx,parseBody(s.listSchema,query));}
 @Header('Cache-Control','no-store')
 @Post('boards') @Permissions('planning.write','clients.read')
 createBoard(@CurrentContext() ctx:RequestContext,@Body() body:unknown,@Headers('authorization') authorization:string) {return this.service.createBoard(ctx,parseBody(s.boardCreateSchema,body),authorization);}
 @Header('Cache-Control','no-store')
 @Get('boards/:id') @Permissions('planning.read')
 board(@CurrentContext() ctx:RequestContext,@Param('id') id:string) {return this.service.boardDetail(ctx,parseBody(s.idSchema,id));}
 @Header('Cache-Control','no-store')
 @Patch('boards/:id') @Permissions('planning.write')
 updateBoard(@CurrentContext() ctx:RequestContext,@Param('id') id:string,@Body() body:unknown) {return this.service.updateBoard(ctx,parseBody(s.idSchema,id),parseBody(s.boardUpdateSchema,body));}
 @Header('Cache-Control','no-store')
 @Delete('boards/:id') @Permissions('planning.write')
 deleteBoard(@CurrentContext() ctx:RequestContext,@Param('id') id:string,@Body() body:unknown) {return this.service.deleteBoard(ctx,parseBody(s.idSchema,id),parseBody(s.deleteSchema,body).expectedRevision);}
 @Header('Cache-Control','no-store')
 @Post('boards/:id/columns') @Permissions('planning.write')
 createColumn(@CurrentContext() ctx:RequestContext,@Param('id') id:string,@Body() body:unknown) {return this.service.createColumn(ctx,parseBody(s.idSchema,id),parseBody(s.columnCreateSchema,body));}
 @Header('Cache-Control','no-store')
 @Patch('boards/:id/columns/:columnId') @Permissions('planning.write')
 updateColumn(@CurrentContext() ctx:RequestContext,@Param('id') id:string,@Param('columnId') columnId:string,@Body() body:unknown) {return this.service.updateColumn(ctx,parseBody(s.idSchema,id),parseBody(s.idSchema,columnId),parseBody(s.columnUpdateSchema,body));}
 @Header('Cache-Control','no-store')
 @Delete('boards/:id/columns/:columnId') @Permissions('planning.write')
 deleteColumn(@CurrentContext() ctx:RequestContext,@Param('id') id:string,@Param('columnId') columnId:string,@Body() body:unknown) {return this.service.deleteColumn(ctx,parseBody(s.idSchema,id),parseBody(s.idSchema,columnId),parseBody(s.columnDeleteSchema,body));}
 @Header('Cache-Control','no-store')
 @Get('boards/:id/cards') @Permissions('planning.read')
 cards(@CurrentContext() ctx:RequestContext,@Param('id') id:string,@Query() query:unknown) {return this.service.cards(ctx,parseBody(s.idSchema,id),parseBody(s.listSchema,query));}
 @Header('Cache-Control','no-store')
 @Post('boards/:id/cards') @Permissions('planning.write')
 createCard(@CurrentContext() ctx:RequestContext,@Param('id') id:string,@Body() body:unknown) {return this.service.createCard(ctx,parseBody(s.idSchema,id),parseBody(s.cardCreateSchema,body));}
 @Header('Cache-Control','no-store')
 @Get('cards/:id') @Permissions('planning.read')
 card(@CurrentContext() ctx:RequestContext,@Param('id') id:string) {return this.service.cardDetail(ctx,parseBody(s.idSchema,id));}
 @Header('Cache-Control','no-store')
 @Patch('cards/:id') @Permissions('planning.write')
 updateCard(@CurrentContext() ctx:RequestContext,@Param('id') id:string,@Body() body:unknown) {return this.service.updateCard(ctx,parseBody(s.idSchema,id),parseBody(s.cardUpdateSchema,body));}
 @Header('Cache-Control','no-store')
 @Post('cards/:id/move') @Permissions('planning.write')
 move(@CurrentContext() ctx:RequestContext,@Param('id') id:string,@Body() body:unknown) {return this.service.moveCard(ctx,parseBody(s.idSchema,id),parseBody(s.cardMoveSchema,body));}
 @Header('Cache-Control','no-store')
 @Delete('cards/:id') @Permissions('planning.write')
 deleteCard(@CurrentContext() ctx:RequestContext,@Param('id') id:string,@Body() body:unknown) {return this.service.deleteCard(ctx,parseBody(s.idSchema,id),parseBody(s.deleteSchema,body).expectedRevision);}
 @Header('Cache-Control','no-store')
 @Get('boards/:id/template-review') @Permissions('planning.read')
 review(@CurrentContext() ctx:RequestContext,@Param('id') id:string,@Query() query:unknown) {return this.service.reviewTemplate(ctx,parseBody(s.idSchema,id),parseBody(s.templateReviewSchema,query).version);}
 @Header('Cache-Control','no-store')
 @Post('boards/:id/template-apply') @Permissions('planning.write')
 apply(@CurrentContext() ctx:RequestContext,@Param('id') id:string,@Body() body:unknown) {return this.service.applyTemplate(ctx,parseBody(s.idSchema,id),parseBody(s.templateApplySchema,body));}
}
