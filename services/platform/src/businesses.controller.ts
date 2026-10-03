import { Body, Controller, ForbiddenException, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Database, emitEvent, parseBody, Public } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { IdentityService } from './identity.service.js';
import { businessIdSchema, businessSchema, internalContextSchema, settingsSchema, starterEntitlements } from './schemas.js';

type BusinessRow = { business_id: string; name: string; entitlements: string[]; settings: Record<string, unknown>; created_at: Date; role: RequestContext['role'] };
const businessItem = (row: BusinessRow) => ({ id: row.business_id, name: row.name, role: row.role, entitlements: row.entitlements, settings: row.settings, createdAt: row.created_at });

@Public()
@ApiTags('businesses')
@Controller('v1')
export class BusinessesController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(IdentityService) private readonly identity: IdentityService) {}

  @Get('session')
  @ApiOperation({ summary: 'Get the signed-in user without exposing the session token' })
  async session(@Req() req: Request) {
    const session = await this.identity.requireSession(req);
    return { item: { user: session.user, expiresAt: session.session.expiresAt } };
  }

  @Get('businesses')
  @ApiOperation({ summary: 'List up to 100 businesses the signed-in user belongs to' })
  async list(@Req() req: Request) {
    const session = await this.identity.requireSession(req);
    const directory = await this.db.pool.query<{business_id: string}>('SELECT business_id FROM identity_business_directory WHERE user_id = $1 ORDER BY business_id LIMIT 100', [session.user.id]);
    const items = [];
    for (const entry of directory.rows) {
      const item = await this.db.withTenant(entry.business_id, async (tx) => {
        const result = await tx.query<BusinessRow>('SELECT b.*, m.role FROM businesses b JOIN memberships m USING (business_id) WHERE m.user_id = $1', [session.user.id]);
        return result.rows[0] ? businessItem(result.rows[0]) : null;
      });
      if (item) items.push(item);
    }
    return { items };
  }

  @Post('businesses')
  @ApiOperation({ summary: 'Create a business and owner membership; development grants a starter feature set' })
  async create(@Req() req: Request, @Body() body: unknown) {
    const session = await this.identity.requireSession(req);
    this.identity.assertMutationOrigin(req);
    const input = parseBody(businessSchema, body);
    const id = randomUUID();
    const settings = { version: 1, timezone: input.timezone, language: 'en', branding: { displayName: input.name, primaryColor: '#2563eb' } };
    return this.db.withTenant(id, async (tx) => {
      const result = await tx.query<BusinessRow>('INSERT INTO businesses (business_id, name, entitlements, settings) VALUES ($1,$2,$3,$4) RETURNING *', [id, input.name, starterEntitlements(), settings]);
      await tx.query('INSERT INTO memberships (business_id, user_id, role) VALUES ($1,$2,$3)', [id, session.user.id, 'owner']);
      await tx.query('INSERT INTO identity_business_directory (user_id, business_id) VALUES ($1,$2)', [session.user.id, id]);
      await emitEvent(tx, { type: 'platform.business-created.v1', producer: 'platform', businessId: id, data: { businessId: id } });
      return { item: businessItem({ ...result.rows[0]!, role: 'owner' }) };
    });
  }

  @Patch('businesses/:businessId/settings')
  @ApiOperation({ summary: 'Update branding, timezone and language as owner/admin; entitlements cannot be changed' })
  async settings(@Req() req: Request, @Param('businessId') businessId: string, @Body() body: unknown) {
    const session = await this.identity.requireSession(req);
    this.identity.assertMutationOrigin(req);
    const id = parseBody(businessIdSchema, businessId);
    const input = parseBody(settingsSchema, body);
    return this.db.withTenant(id, async (tx) => {
      const result = await tx.query<BusinessRow>('SELECT b.*,m.role FROM businesses b JOIN memberships m USING (business_id) WHERE m.user_id = $1 FOR UPDATE OF b', [session.user.id]);
      const current = result.rows[0];
      if (!current) throw new ForbiddenException('Business membership is required');
      if (!['owner', 'admin'].includes(current.role)) throw new ForbiddenException('Owner or admin role is required');
      const settings = { ...current.settings, ...input, version: 1 };
      const updated = await tx.query<BusinessRow>('UPDATE businesses SET settings=$1, updated_at=now() WHERE business_id=$2 RETURNING *', [settings, id]);
      await emitEvent(tx, { type: 'platform.settings-updated.v1', producer: 'platform', businessId: id, data: { version: 1 } });
      return { item: businessItem({ ...updated.rows[0]!, role: current.role }) };
    });
  }
}

@Public()
@ApiTags('internal')
@Controller('internal')
export class ContextController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(IdentityService) private readonly identity: IdentityService) {}

  @Post('context')
  @ApiOperation({ summary: 'Gateway-only session and business membership verification' })
  async context(@Req() req: Request, @Body() body: unknown) {
    this.identity.assertInternalSecret(req);
    const session = await this.identity.requireSession(req);
    const { businessId } = parseBody(internalContextSchema, body);
    return this.db.withTenant(businessId, async (tx) => {
      const result = await tx.query<{role: RequestContext['role']; entitlements: string[]}>('SELECT m.role,b.entitlements FROM memberships m JOIN businesses b USING (business_id) WHERE m.user_id=$1', [session.user.id]);
      if (!result.rows[0]) throw new ForbiddenException('Business membership is required');
      return { item: { sub: session.user.id, businessId, role: result.rows[0].role, entitlements: result.rows[0].entitlements } };
    });
  }
}
