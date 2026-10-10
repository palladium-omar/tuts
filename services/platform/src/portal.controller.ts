import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { parseBody, Public } from '@palladium/service-kit';
import type { Request } from 'express';
import { IdentityService } from './identity.service.js';
import { PortalService } from './portal.service.js';
import { invitationSchema, portalAcceptSchema, portalBusinessSchema, portalIdSchema, portalListSchema } from './portal.schemas.js';

/** Cookie-authenticated Platform routes verify their own session and tenant policy. */
@Public()
@ApiTags('portal')
@Controller('v1/portal')
export class PortalController {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(PortalService) private readonly portal: PortalService) {}

  @Get('sender-status')
  @Header('Cache-Control', 'no-store')
  async senderStatus(@Req() req: Request, @Query() query: unknown) {
    const session = await this.identity.requireSession(req);
    const input = parseBody(portalBusinessSchema, query);
    return this.portal.senderStatus(session, input.businessId);
  }

  @Get('invitations')
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: Request, @Query() query: unknown) {
    const session = await this.identity.requireSession(req);
    return this.portal.list(session, parseBody(portalListSchema, query));
  }

  @Post('invitations')
  @Header('Cache-Control', 'no-store')
  async create(@Req() req: Request, @Body() body: unknown) {
    const session = await this.identity.requireSession(req);
    this.identity.assertMutationOrigin(req);
    return this.portal.create(session, parseBody(invitationSchema, body));
  }

  @Post('invitations/:id/resend')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async resend(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const session = await this.identity.requireSession(req);
    this.identity.assertMutationOrigin(req);
    const input = parseBody(portalBusinessSchema, body);
    return this.portal.resend(session, input.businessId, parseBody(portalIdSchema, id));
  }

  @Delete('invitations/:id')
  @Header('Cache-Control', 'no-store')
  async revokeInvitation(@Req() req: Request, @Param('id') id: string, @Query() query: unknown) {
    const session = await this.identity.requireSession(req);
    this.identity.assertMutationOrigin(req);
    const input = parseBody(portalBusinessSchema, query);
    return this.portal.revokeInvitation(session, input.businessId, parseBody(portalIdSchema, id));
  }

  @Post('accept')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async accept(@Req() req: Request, @Body() body: unknown) {
    const session = await this.identity.requireSession(req);
    this.identity.assertMutationOrigin(req);
    const input = parseBody(portalAcceptSchema, body);
    return this.portal.accept(session, input.businessId, input.token);
  }

  @Get('access')
  @Header('Cache-Control', 'no-store')
  async access(@Req() req: Request, @Query() query: unknown) {
    const session = await this.identity.requireSession(req);
    return this.portal.access(session, parseBody(portalListSchema, query));
  }

  @Delete('access/:id')
  @Header('Cache-Control', 'no-store')
  async revokeAccess(@Req() req: Request, @Param('id') id: string, @Query() query: unknown) {
    const session = await this.identity.requireSession(req);
    this.identity.assertMutationOrigin(req);
    const input = parseBody(portalBusinessSchema, query);
    return this.portal.revokeAccess(session, input.businessId, parseBody(portalIdSchema, id));
  }
}
