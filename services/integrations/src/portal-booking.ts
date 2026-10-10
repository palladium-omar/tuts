import { Body, Controller, Get, Header, Inject, Injectable, Put, Query, ForbiddenException, BadRequestException, ServiceUnavailableException, ConflictException } from '@nestjs/common';
import { CurrentContext, Database, Permissions, Roles, StudentScoped, assertStudentAccess, parseBody, serviceFetch } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { z } from 'zod';

export const calBookingUrl = z.url().max(2048).refine(value => {
  const url = new URL(value);
  return url.origin === 'https://cal.com' && !url.username && !url.password && !url.hash && !url.search &&
    /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+){0,2}\/?$/.test(url.pathname) &&
    !['api','docs','settings','auth','login','signup'].includes(url.pathname.split('/')[1]!);
}, 'Use a public https://cal.com booking link without query parameters');
const configSchema = z.object({displayName: z.string().trim().min(1).max(100), bookingUrl: calBookingUrl,
  connectionId: z.uuid().nullable().optional(), enabled: z.boolean()}).strict();
const querySchema = z.object({studentId: z.uuid()}).strict();
const studentSchema = z.object({item: z.object({id: z.uuid(),displayName: z.string(),contacts: z.array(z.object({
  relationship: z.string(), emails: z.array(z.object({value:z.email(),isPrimary:z.boolean().optional()})),
}))})});
function configItem(row: Record<string, any>) {
  return {id:row.id,ownerUserId:row.owner_user_id,displayName:row.display_name,bookingUrl:row.booking_url,
    connectionId:row.connection_id,enabled:row.enabled,createdAt:row.created_at,updatedAt:row.updated_at};
}

@Injectable()
export class PortalBookingService {
  constructor(@Inject(Database) private readonly db: Database) {}
  async own(ctx: RequestContext) {
    return this.db.withTenant(ctx.businessId,async tx => {
      const result=await tx.query('SELECT * FROM portal_booking_configs WHERE owner_user_id=$1',[ctx.sub]);
      return {item:result.rows[0] ? configItem(result.rows[0]) : null};
    });
  }
  async configure(ctx: RequestContext,body:unknown) {
    const input=parseBody(configSchema,body);
    return this.db.withTenant(ctx.businessId,async tx => {
      if(input.connectionId) {
        const connection=(await tx.query('SELECT provider,status,created_by FROM integration_connections WHERE id=$1',[input.connectionId])).rows[0];
        if(!connection || connection.provider!=='calcom' || connection.status==='disconnected' || connection.created_by!==ctx.sub)
          throw new ConflictException('Choose an active Cal.com connection owned by this tutor');
      }
      const result=await tx.query(`INSERT INTO portal_booking_configs(business_id,owner_user_id,display_name,booking_url,connection_id,enabled)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(business_id,owner_user_id) DO UPDATE SET display_name=EXCLUDED.display_name,
        booking_url=EXCLUDED.booking_url,connection_id=EXCLUDED.connection_id,enabled=EXCLUDED.enabled,updated_at=now() RETURNING *`,
        [ctx.businessId,ctx.sub,input.displayName,input.bookingUrl,input.connectionId??null,input.enabled]);
      return {item:configItem(result.rows[0])};
    });
  }
  async booking(ctx: RequestContext,query:unknown) {
    const {studentId}=parseBody(querySchema,query);
    assertStudentAccess(ctx,studentId);
    if(!ctx.entitlements.includes('clients') || !ctx.entitlements.includes('scheduling')) throw new ForbiddenException('Clients and Scheduling are required for student booking');
    const secret=process.env.PORTAL_INTERNAL_SECRET;
    if(!secret || secret.length<32) throw new ServiceUnavailableException('Student booking prefill is unavailable');
    let student: z.infer<typeof studentSchema>['item'];
    try {
      const response=await serviceFetch('clients','/internal/portal-students',{method:'POST',
        headers:{'Content-Type':'application/json','X-Portal-Internal-Secret':secret},
        body:JSON.stringify({businessId:ctx.businessId,studentId,protect:false}),signal:AbortSignal.timeout(5_000)});
      if(!response.ok) throw new Error('Student unavailable');
      const parsed=studentSchema.safeParse(await response.json());
      if(!parsed.success || parsed.data.item.id!==studentId) throw new Error('Student unavailable');
      student=parsed.data.item;
    } catch {throw new ServiceUnavailableException('Student booking prefill is unavailable');}
    const ownAddresses=student.contacts.filter(contact=>['student','self'].includes(contact.relationship)).flatMap(contact=>contact.emails);
    const uniqueEmails=[...new Set(ownAddresses.map(address=>address.value.trim().toLowerCase()))];
    // Shared or ambiguous contact data is never selected arbitrarily.
    const prefill={name:student.displayName,...(uniqueEmails.length===1 ? {email:uniqueEmails[0]} : {})};
    return this.db.withTenant(ctx.businessId,async tx=>{
      const rows=(await tx.query(`SELECT p.*,c.status AS connection_status,c.credentials_encrypted IS NOT NULL AS has_credentials,
        c.cal_webhook_secret_encrypted IS NOT NULL AS webhook_configured FROM portal_booking_configs p
        LEFT JOIN integration_connections c ON c.id=p.connection_id AND c.business_id=p.business_id
        WHERE p.enabled=true
        UNION ALL
        SELECT c.id,c.business_id,c.created_by,c.display_name,coalesce(c.config->>'bookingUrl',c.account->>'bookingUrl'),c.id,true,
          c.created_at,c.updated_at,c.status,c.credentials_encrypted IS NOT NULL,c.cal_webhook_secret_encrypted IS NOT NULL
        FROM integration_connections c WHERE c.provider='calcom' AND c.status<>'disconnected'
          AND NOT EXISTS (SELECT 1 FROM portal_booking_configs p WHERE p.owner_user_id=c.created_by)
        ORDER BY display_name,id LIMIT 50`)).rows;
      return {items:rows.filter(row=>calBookingUrl.safeParse(row.booking_url).success).map(row=>({
        id:row.id,ownerUserId:row.owner_user_id,displayName:row.display_name,bookingUrl:row.booking_url,connectionId:row.connection_id,
        syncAvailable:Boolean(row.has_credentials && row.connection_status!=='disconnected'),
        webhookConfigured:Boolean(row.webhook_configured && row.connection_status!=='disconnected'),
        associationMode:'staff_review' as const,prefill,
      }))};
    });
  }
}
@Controller('v1/portal')
export class PortalBookingController {
  constructor(@Inject(PortalBookingService) private readonly service:PortalBookingService) {}
  @Get('booking') @StudentScoped() @Roles('owner','admin','tutor','student','parent') @Permissions('integrations.read','scheduling.read')
  @Header('Cache-Control','no-store')
  booking(@CurrentContext() ctx:RequestContext,@Query() query:unknown){return this.service.booking(ctx,query);}
  @Get('booking-config') @StudentScoped() @Roles('owner','admin','tutor') @Permissions('integrations.read')
  own(@CurrentContext() ctx:RequestContext){return this.service.own(ctx);}
  @Put('booking-config') @StudentScoped() @Roles('owner','admin','tutor') @Permissions('integrations.write')
  configure(@CurrentContext() ctx:RequestContext,@Body() body:unknown){return this.service.configure(ctx,body);}
}
