import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { BadGatewayException, BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Injectable, NotFoundException, Param, Post } from '@nestjs/common';
import { CurrentContext, Database, assertPermission, emitEvent, parseBody, Permissions, Roles } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { z } from 'zod';
import { ConnectorError, decrypt, encrypt, hashSecret } from './security.js';
import { connectionView, type ConnectionRow } from './connection-view.js';
import type { ExternalSession } from './schemas.js';
import { exchangeGoogleCode, refreshGoogleCredentials, listGoogleCalendars, pullGoogleCalendar, type GoogleCalendarCredentials, type GoogleCalendarItem, type GoogleCalendarSnapshot } from './google-calendar-provider.js';

import { validateGoogleCalendarFeedUrl, googleCalendarFeedId, pullGoogleCalendarFeed } from './google-calendar-feed.js';

const uuid = z.string().uuid();
const displayName = z.string().trim().min(1).max(100);
const startSchema = z.object({ displayName: displayName.optional() }).strict();
const completeSchema = z.object({ state: z.string().max(100).regex(/^[a-fA-F0-9-]{36}\.[A-Za-z0-9_-]{43}$/), code: z.string().min(1).max(4096).regex(/^[^\r\n]+$/) }).strict();
const selectSchema = z.object({ calendarId: z.string().min(1).max(1024).regex(/^[^\r\n]+$/), importAttendees: z.boolean().optional(), includeEventsWithoutAttendees: z.boolean().optional(), displayName: displayName.optional() }).strict();
const privateFeedSchema = selectSchema.omit({ calendarId: true }).extend({ calendarUrl: z.string().min(1).max(2048) }).strict();
const storedCredentialsSchema = z.union([z.object({ kind: z.literal('ical'), calendarUrl: z.string().max(2048) }).strict(), z.object({ accessToken: z.string().min(1).max(8192), refreshToken: z.string().min(1).max(8192), expiresAt: z.number().finite(), scope: z.string().max(4096) }).strict()]);
type StoredGoogleCredentials = z.infer<typeof storedCredentialsSchema>;
const isFeed = (credentials: StoredGoogleCredentials): credentials is { kind: 'ical'; calendarUrl: string } => 'kind' in credentials && credentials.kind === 'ical';
const scopes = ['https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'];
const safeMessage = (error: unknown) => error instanceof ConnectorError ? error.safeMessage : 'Google Calendar could not be reached. Try again or reconnect.';
type LeasedRow = ConnectionRow & { revision: string; sync_lease_id: string; sync_lease_until: Date };
function readSnapshot(value: unknown): GoogleCalendarSnapshot {
  const stored = value as Record<string, unknown>;
  const source = (stored.session ?? stored) as ExternalSession;
  // Explicitly construct the public projection: private provider IDs/checkpoints never reach outbox.
  const session: ExternalSession = {
    externalId: source.externalId, title: source.title, startsAt: source.startsAt, endsAt: source.endsAt, status: source.status,
    attendeeName: source.attendeeName, attendeeEmail: source.attendeeEmail, bookingUrl: source.bookingUrl,
    providerUpdatedAt: source.providerUpdatedAt, providerObservedAt: source.providerObservedAt, revisionSource: source.revisionSource,
  };
  return { session, googleEventId: typeof stored.googleEventId === 'string' ? stored.googleEventId : undefined,
    repairCheckedAt: typeof stored.repairCheckedAt === 'string' ? stored.repairCheckedAt : undefined };
}

export function assertGoogleManage(ctx: RequestContext) {
  assertPermission(ctx, 'integrations.manage');
  if (!['owner', 'admin'].includes(ctx.role) || ctx.accessScope === 'students' || !ctx.entitlements.includes('integrations'))
    throw new ForbiddenException('Google Calendar requires business administrator access and Integrations');
}
function configuration() {
  if (process.env.NODE_ENV === 'production' && process.env.GOOGLE_CALENDAR_ENABLED !== 'true')
    throw new ConnectorError('Google sign-in setup is pending. You can connect with a private calendar link.');
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID ?? '';
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET ?? '';
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI ?? '';
  if (!clientId || !clientSecret || !redirectUri) throw new ConnectorError('Google Calendar is not configured for this deployment');
  let url: URL;
  try { url = new URL(redirectUri); } catch { throw new ConnectorError('Google Calendar callback is not configured correctly'); }
  const production = process.env.NODE_ENV === 'production';
  const local = !production && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!local && (url.protocol !== 'https:' || (url.port && url.port !== '443'))) || url.username || url.password || url.search || url.hash || url.pathname !== '/integrations/google-calendar/callback')
    throw new ConnectorError('Google Calendar callback is not configured correctly');
  if (production) {
    let appUrl: URL;
    try { appUrl = new URL(process.env.PUBLIC_APP_URL ?? ''); }
    catch { throw new ConnectorError('Google Calendar trusted app origin is not configured correctly'); }
    if (appUrl.protocol !== 'https:' || appUrl.username || appUrl.password || appUrl.search || appUrl.hash || (appUrl.port && appUrl.port !== '443') || url.origin !== appUrl.origin)
      throw new ConnectorError('Google Calendar callback must use the trusted app origin');
  }
  // Also fail availability closed if token storage is unavailable.
  encrypt({}, '00000000-0000-0000-0000-000000000000');
  return { clientId, redirectUri };
}

@Injectable()
export class GoogleCalendarService {
  constructor(@Inject(Database) private readonly db: Database) {}
  status(ctx: RequestContext) {
    assertGoogleManage(ctx);
    try { encrypt({}, ctx.businessId); }
    catch (error) { return { available: false, privateFeedAvailable: false, reason: safeMessage(error) }; }
    try { configuration(); return { available: true, privateFeedAvailable: true }; }
    catch (error) { return { available: false, privateFeedAvailable: true, reason: safeMessage(error) }; }
  }
  async start(ctx: RequestContext, body: unknown) {
    assertGoogleManage(ctx);
    const input = parseBody(startSchema, body);
    let config: ReturnType<typeof configuration>;
    try { config = configuration(); } catch (error) { throw new ConflictException(safeMessage(error)); }
    const state = `${ctx.businessId}.${randomBytes(32).toString('base64url')}`;
    const verifier = randomBytes(32).toString('base64url');
    await this.db.withTenant(ctx.businessId, async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`integration-create:${ctx.businessId}`]);
      await tx.query('DELETE FROM google_calendar_oauth_states WHERE business_id=$1 AND expires_at<=now()', [ctx.businessId]);
      const counts = (await tx.query<{ active: string; pending: string; actor_pending: string }>(`SELECT
        (SELECT count(*) FROM integration_connections WHERE business_id=$1 AND status<>'disconnected') AS active,
        count(*) FILTER(WHERE consumed_at IS NULL) AS pending,
        count(*) FILTER(WHERE consumed_at IS NULL AND actor_id=$2) AS actor_pending
        FROM google_calendar_oauth_states WHERE business_id=$1`, [ctx.businessId, ctx.sub])).rows[0]!;
      if (Number(counts.active) + Number(counts.pending) >= 50 || Number(counts.pending) >= 20 || Number(counts.actor_pending) >= 5)
        throw new ConflictException('Connection or pending authorization limit reached. Finish an existing connection or wait ten minutes.');
      await tx.query('INSERT INTO integration_tenant_directory(business_id) VALUES($1) ON CONFLICT DO NOTHING', [ctx.businessId]);
      await tx.query(`INSERT INTO google_calendar_oauth_states(business_id,state_hash,actor_id,verifier_encrypted,display_name,expires_at)
        VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')`, [ctx.businessId, hashSecret(state), ctx.sub, encrypt({ verifier }, ctx.businessId), input.displayName ?? 'Google Calendar']);
    });
    const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorization.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: scopes.join(' '), access_type: 'offline', prompt: 'select_account consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    return { authorizationUrl: authorization.toString() };
  }
  async complete(ctx: RequestContext, body: unknown) {
    assertGoogleManage(ctx);
    const input = parseBody(completeSchema, body);
    if (input.state.split('.')[0] !== ctx.businessId) throw new BadRequestException('Authorization state does not belong to this business');
    let config: ReturnType<typeof configuration>;
    try { config = configuration(); } catch (error) { throw new ConflictException(safeMessage(error)); }
    // Consume before exchange. An uncertain network outcome requires a fresh consent flow.
    const grant = await this.db.withTenant(ctx.businessId, async tx => {
      const row = (await tx.query<{ verifier_encrypted: string; display_name: string }>(`UPDATE google_calendar_oauth_states SET consumed_at=now()
        WHERE business_id=$1 AND state_hash=$2 AND actor_id=$3 AND expires_at>now() AND consumed_at IS NULL RETURNING verifier_encrypted,display_name`, [ctx.businessId, hashSecret(input.state), ctx.sub])).rows[0];
      if (!row) throw new ConflictException('Authorization expired or was already used. Connect Google Calendar again.');
      await tx.query('UPDATE google_calendar_oauth_states SET verifier_encrypted=NULL WHERE business_id=$1 AND state_hash=$2', [ctx.businessId, hashSecret(input.state)]);
      return row;
    });
    let credentials: GoogleCalendarCredentials;
    try {
      const { verifier } = decrypt<{ verifier: string }>(grant.verifier_encrypted, ctx.businessId);
      credentials = await exchangeGoogleCode(input.code, verifier, config.redirectUri);
    } catch (error) { throw new BadGatewayException(safeMessage(error)); }
    return this.db.withTenant(ctx.businessId, async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`integration-create:${ctx.businessId}`]);
      const count = (await tx.query<{ count: string }>("SELECT count(*) FROM integration_connections WHERE business_id=$1 AND status<>'disconnected'", [ctx.businessId])).rows[0]!;
      if (Number(count.count) >= 50) throw new ConflictException('Connection limit reached. Disconnect a connection and authorize Google again.');
      const row = (await tx.query<ConnectionRow>(`INSERT INTO integration_connections(id,business_id,created_by,provider,display_name,credentials_encrypted,config,account,status,dispatch_entitlements,next_sync_at)
        VALUES($1,$2,$3,'google_calendar',$4,$5,'{}','{"authMode":"oauth"}','awaiting_selection',$6,NULL) RETURNING *`, [randomUUID(), ctx.businessId, ctx.sub, grant.display_name, encrypt(credentials, ctx.businessId), ctx.entitlements])).rows[0]!;
      return { item: connectionView(row) };
    });
  }
  async privateFeed(ctx: RequestContext, body: unknown) {
    assertGoogleManage(ctx);
    const input = parseBody(privateFeedSchema, body);
    if (input.importAttendees && !ctx.entitlements.includes('clients')) throw new ForbiddenException('Attendee import requires the CRM feature');
    let calendarId: string;
    try { calendarId = googleCalendarFeedId(validateGoogleCalendarFeedUrl(input.calendarUrl)); }
    catch (error) { throw new BadRequestException(safeMessage(error)); }
    const config = { calendarId, importAttendees: input.importAttendees ?? false, includeEventsWithoutAttendees: input.includeEventsWithoutAttendees ?? true };
    const encryptedCredentials = encrypt({ kind: 'ical', calendarUrl: input.calendarUrl }, ctx.businessId);
    // Fetch and parse the actual feed before claiming a connected source. URL remains encrypted only.
    let feed: Awaited<ReturnType<typeof pullGoogleCalendarFeed>>;
    try { feed = await pullGoogleCalendarFeed(input.calendarUrl, config, [], Date.now()+19000); }
    catch (error) { throw new BadGatewayException(safeMessage(error)); }
    return this.db.withTenant(ctx.businessId, async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`integration-create:${ctx.businessId}`]);
      const count = (await tx.query<{ count: string }>("SELECT count(*) FROM integration_connections WHERE business_id=$1 AND status<>'disconnected'", [ctx.businessId])).rows[0]!;
      if (Number(count.count) >= 50) throw new ConflictException('Connection limit reached');
      await tx.query('INSERT INTO integration_tenant_directory(business_id) VALUES($1) ON CONFLICT DO NOTHING', [ctx.businessId]);
      const row = (await tx.query<ConnectionRow>(`INSERT INTO integration_connections(id,business_id,created_by,provider,display_name,credentials_encrypted,config,account,status,dispatch_entitlements,next_sync_at)
        VALUES($1,$2,$3,'google_calendar',$4,$5,$6,$7,'connected',$8,now()) RETURNING *`,
        [randomUUID(),ctx.businessId,ctx.sub,input.displayName ?? 'Google Calendar',encryptedCredentials,JSON.stringify(config),JSON.stringify({authMode:'ical',calendarId,feedConnected:true,summary:feed.calendarName && !feed.calendarName.includes(input.calendarUrl) && !/private-[a-fA-F0-9]+/.test(feed.calendarName) ? feed.calendarName.slice(0,160) : 'Google Calendar',timeZone:feed.timeZone}),ctx.entitlements])).rows[0]!;
      return {item:connectionView(row)};
    });
  }
  private async claim(businessId: string, id: string, entitlements?: string[], force = false, selected = false) {
    return this.db.withTenant(businessId, async tx => {
      const row = (await tx.query<LeasedRow>('SELECT * FROM integration_connections WHERE business_id=$1 AND id=$2 FOR UPDATE', [businessId, id])).rows[0];
      if (!row || row.provider !== 'google_calendar') { if (force) throw new NotFoundException('Google Calendar connection not found'); return null; }
      if (row.status === 'disconnected' || !row.credentials_encrypted) return null;
      if (selected && !row.config.calendarId) { if (force) throw new ConflictException('Select a Google calendar before synchronizing'); return null; }
      if (!force && row.next_sync_at && row.next_sync_at.getTime() > Date.now()) return null;
      if (row.sync_lease_until && row.sync_lease_until.getTime() > Date.now()) return null;
      const effectiveEntitlements = entitlements ?? row.dispatch_entitlements;
      if (!effectiveEntitlements.includes('integrations')) { if (force) throw new ForbiddenException('Integrations is unavailable'); return null; }
      const leaseId = randomUUID();
      return (await tx.query<LeasedRow>(`UPDATE integration_connections SET sync_lease_id=$3,sync_lease_until=now()+interval '3 minutes',dispatch_entitlements=$4,
        last_attempt_at=CASE WHEN $5 THEN now() ELSE last_attempt_at END WHERE business_id=$1 AND id=$2 RETURNING *`, [businessId, id, leaseId, effectiveEntitlements, selected])).rows[0]!;
    });
  }
  private async credentials(row: LeasedRow, deadline: number): Promise<StoredGoogleCredentials> {
    const parsed = storedCredentialsSchema.safeParse(decrypt<unknown>(row.credentials_encrypted!, row.business_id));
    if (!parsed.success) throw new ConnectorError('Stored Google Calendar credentials are invalid; reconnect the calendar');
    const credentials = parsed.data;
    if (isFeed(credentials)) {
      const calendarId = googleCalendarFeedId(validateGoogleCalendarFeedUrl(credentials.calendarUrl));
      if (calendarId !== row.config.calendarId) throw new ConnectorError('Stored Google Calendar feed is invalid; reconnect the calendar');
      return credentials;
    }
    return credentials.expiresAt <= Date.now() + 60_000 ? refreshGoogleCredentials(credentials, Math.min(deadline, Date.now()+5000)) : credentials;
  }
  private async release(row: LeasedRow, credentials?: StoredGoogleCredentials, error?: string, sync = false) {
    return this.db.withTenant(row.business_id, async tx => (await tx.query(`UPDATE integration_connections SET sync_lease_id=NULL,sync_lease_until=NULL,
      credentials_encrypted=COALESCE($5,credentials_encrypted),last_error=CASE WHEN $6::text IS NULL THEN last_error ELSE $6 END,
      status=CASE WHEN $7 AND $6::text IS NOT NULL THEN 'error' ELSE status END,
      next_sync_at=CASE WHEN $7 AND $6::text IS NOT NULL THEN now()+interval '5 minutes' ELSE next_sync_at END
      WHERE business_id=$1 AND id=$2 AND revision=$3 AND sync_lease_id=$4 AND sync_lease_until>now() AND status<>'disconnected'`,
      [row.business_id, row.id, row.revision, row.sync_lease_id, credentials ? encrypt(credentials, row.business_id) : null, error ?? null, sync])).rowCount);
  }
  private feedCalendars(row: ConnectionRow): {items: GoogleCalendarItem[]; truncated: boolean} {
    return {items:[{id:row.config.calendarId!,summary:typeof row.account.summary === 'string' ? row.account.summary : row.display_name,
      primary:false,timeZone:typeof row.account.timeZone === 'string' ? row.account.timeZone : undefined,accessRole:'reader'}],truncated:false};
  }
  async calendars(ctx: RequestContext, id: string) {
    assertGoogleManage(ctx); parseBody(uuid, id);
    const row = await this.claim(ctx.businessId, id, ctx.entitlements, true);
    if (!row) throw new ConflictException('Connection is disconnected or another operation is running');
    let credentials: StoredGoogleCredentials | undefined;
    try {
      const deadline = Date.now()+19000;
      credentials = await this.credentials(row, deadline);
      const calendars = isFeed(credentials)
        ? this.feedCalendars(row)
        : await listGoogleCalendars(credentials, deadline);
      if (!await this.release(row, credentials)) throw new ConflictException('Connection changed. Try again.');
      return calendars;
    } catch (error) {
      await this.release(row, credentials, safeMessage(error));
      if (error instanceof ConflictException) throw error;
      throw new BadGatewayException(safeMessage(error));
    }
  }
  async select(ctx: RequestContext, id: string, body: unknown) {
    assertGoogleManage(ctx); parseBody(uuid, id);
    const input = parseBody(selectSchema, body);
    if (input.importAttendees && !ctx.entitlements.includes('clients')) throw new ForbiddenException('Attendee import requires the CRM feature');
    const row = await this.claim(ctx.businessId, id, ctx.entitlements, true);
    if (!row) throw new ConflictException('Connection is disconnected or another operation is running');
    let credentials: StoredGoogleCredentials | undefined;
    try {
      if (row.config.calendarId && row.config.calendarId !== input.calendarId) throw new ConflictException('Create a new connection to select a different calendar');
      const deadline = Date.now()+19000;
      credentials = await this.credentials(row, deadline);
      const calendars = isFeed(credentials)
        ? this.feedCalendars(row)
        : await listGoogleCalendars(credentials, deadline);
      const calendar = calendars.items.find(item => item.id === input.calendarId);
      if (!calendar) throw new BadRequestException('Choose a readable calendar from the calendar list');
      const config = { calendarId: calendar.id, importAttendees: input.importAttendees ?? row.config.importAttendees ?? false, includeEventsWithoutAttendees: input.includeEventsWithoutAttendees ?? row.config.includeEventsWithoutAttendees ?? true };
      if (config.importAttendees && !ctx.entitlements.includes('clients')) throw new ForbiddenException('Attendee import requires the CRM feature');
      const savedCredentials = credentials;
      return await this.db.withTenant(ctx.businessId, async tx => {
        const changed = (await tx.query<ConnectionRow>(`UPDATE integration_connections SET config=$5,account=$6,credentials_encrypted=$7,
          display_name=$8,status='connected',last_error=NULL,next_sync_at=now(),updated_at=now(),revision=revision+1,sync_lease_id=NULL,sync_lease_until=NULL
          WHERE business_id=$1 AND id=$2 AND revision=$3 AND sync_lease_id=$4 AND sync_lease_until>now() AND status<>'disconnected' RETURNING *`,
          [ctx.businessId, id, row.revision, row.sync_lease_id, JSON.stringify(config), JSON.stringify({ authMode: isFeed(savedCredentials) ? 'ical' : 'oauth', ...(isFeed(savedCredentials) ? {feedConnected:true} : {}), calendarId: calendar.id, summary: calendar.summary, timeZone: calendar.timeZone, primary: calendar.primary, accessRole: calendar.accessRole }), encrypt(savedCredentials, ctx.businessId), input.displayName ?? row.display_name])).rows[0];
        if (!changed) throw new ConflictException('Connection changed. Try again.');
        return { item: connectionView(changed) };
      });
    } catch (error) {
      await this.release(row, credentials);
      if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof ForbiddenException) throw error;
      throw new BadGatewayException(safeMessage(error));
    }
  }
  async syncTenant(businessId: string, id: string, force = false, requestId?: string, entitlements?: string[]) {
    const row = await this.claim(businessId, id, entitlements, force, true);
    if (!row) return null;
    let credentials: StoredGoogleCredentials | undefined;
    try {
      const deadline = Date.now()+19000;
      credentials = await this.credentials(row, deadline);
      const priorSnapshots = await this.db.withTenant(businessId, async tx => (await tx.query<{ snapshot: unknown }>(`SELECT snapshot FROM google_calendar_snapshots
        WHERE business_id=$1 AND connection_id=$2 AND ends_at>=now()-interval '120 days'
        ORDER BY COALESCE(snapshot->>'repairCheckedAt','') ASC,observed_at DESC LIMIT 5001`, [businessId, id])).rows.map(item => readSnapshot(item.snapshot)));
      const prior = priorSnapshots.slice(0,5000).map(item => item.session);
      const config = { ...row.config, calendarId: row.config.calendarId! };
      const result = isFeed(credentials)
        ? await pullGoogleCalendarFeed(credentials.calendarUrl, config, prior, deadline)
        : await pullGoogleCalendar(credentials, config, prior, deadline, priorSnapshots.slice(0,5000));
      if (priorSnapshots.length > 5000) result.truncated = true;
      const snapshots: GoogleCalendarSnapshot[] = 'privateSnapshots' in result ? result.privateSnapshots : result.sessions.map(session => ({session}));
      const encryptedCredentials = encrypt(credentials, businessId);
      return await this.db.withTenant(businessId, async tx => {
        // A lease/revision fence invalidates every in-flight result after edit/disconnect.
        const current = (await tx.query<LeasedRow>(`SELECT * FROM integration_connections WHERE business_id=$1 AND id=$2
          AND revision=$3 AND sync_lease_id=$4 AND sync_lease_until>now() AND status<>'disconnected' FOR UPDATE`, [businessId, id, row.revision, row.sync_lease_id])).rows[0];
        if (!current) return null;
        const contacts = current.config.importAttendees && current.dispatch_entitlements.includes('clients') ? result.contacts : [];
        if (contacts.length) for (let offset = 0; offset < contacts.length; offset += 200) await emitEvent(tx, { type: 'integrations.contacts-received.v1', producer: 'integrations', businessId, correlationId: requestId, data: { connectionId: id, source: 'google_calendar', contacts: contacts.slice(offset, offset + 200) } });
        if (current.dispatch_entitlements.includes('scheduling')) for (let offset = 0; offset < result.sessions.length; offset += 200) await emitEvent(tx, { type: 'integrations.sessions-synced.v1', producer: 'integrations', businessId, correlationId: requestId, data: { connectionId: id, provider: 'google_calendar', ownerUserId: current.created_by, sessions: result.sessions.slice(offset, offset + 200) } });
        if (snapshots.length) await tx.query(`INSERT INTO google_calendar_snapshots(business_id,connection_id,external_id,snapshot,ends_at)
          SELECT $1,$2,value->'session'->>'externalId',value,(value->'session'->>'endsAt')::timestamptz FROM jsonb_array_elements($3::jsonb)
          ON CONFLICT(business_id,connection_id,external_id) DO UPDATE SET snapshot=EXCLUDED.snapshot,ends_at=EXCLUDED.ends_at,observed_at=now()`, [businessId, id, JSON.stringify(snapshots)]);
        await tx.query("DELETE FROM google_calendar_snapshots WHERE business_id=$1 AND connection_id=$2 AND ends_at<now()-interval '120 days'", [businessId, id]);
        const counts = { contactsReceived: contacts.length, sessionsSynced: result.sessions.length, contactsDispatched: contacts.length, sessionsDispatched: current.dispatch_entitlements.includes('scheduling') ? result.sessions.length : 0, truncated: result.truncated, skippedEvents: result.skippedEvents,
          ...('repair' in result ? {repair:result.repair} : {}) };
        const updated = (await tx.query<{ last_sync_at: Date }>(`UPDATE integration_connections SET status='connected',credentials_encrypted=$3,last_error=NULL,last_sync_at=now(),
          next_sync_at=now()+interval '5 minutes',sync_counts=$4,updated_at=now(),sync_lease_id=NULL,sync_lease_until=NULL WHERE business_id=$1 AND id=$2 RETURNING last_sync_at`, [businessId, id, encryptedCredentials, JSON.stringify(counts)])).rows[0]!;
        return { connectionId: id, status: result.truncated ? 'partial' : 'synced', ...counts, syncedAt: updated.last_sync_at.toISOString() };
      });
    } catch (error) {
      const safe = safeMessage(error);
      const released = await this.release(row, credentials, safe, true);
      return released ? { connectionId: id, status: 'error', error: safe } : null;
    }
  }
}

@Roles('owner', 'admin')
@Permissions('integrations.manage')
@Controller('v1/google-calendar')
export class GoogleCalendarController {
  constructor(@Inject(GoogleCalendarService) private readonly service: GoogleCalendarService) {}
  @Get('status') status(@CurrentContext() ctx: RequestContext) { return this.service.status(ctx); }
  @Post('private-feed') privateFeed(@CurrentContext() ctx: RequestContext, @Body() body: unknown) { return this.service.privateFeed(ctx, body); }
  @Post('oauth/start') start(@CurrentContext() ctx: RequestContext, @Body() body: unknown) { return this.service.start(ctx, body); }
  @Post('oauth/complete') complete(@CurrentContext() ctx: RequestContext, @Body() body: unknown) { return this.service.complete(ctx, body); }
  @Get('connections/:id/calendars') calendars(@CurrentContext() ctx: RequestContext, @Param('id') id: string) { return this.service.calendars(ctx, id); }
  @Post('connections/:id/select') select(@CurrentContext() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) { return this.service.select(ctx, id, body); }
}
