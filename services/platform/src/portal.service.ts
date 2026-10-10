import {
  BadRequestException, ConflictException, ForbiddenException, Inject, Injectable,
  NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { hasPermission } from '@palladium/contracts';
import { assertStudentAccess, Database, emitEvent, serviceFetch } from '@palladium/service-kit';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { IdentityService } from './identity.service.js';
import { portalStudentResponseSchema } from './portal.schemas.js';

type Session = {user: {id: string; email: string}};
type Policy = Awaited<ReturnType<IdentityService['requireBusinessContext']>>;
type Relationship = 'student' | 'guardian';
type InviteInput = {businessId: string; studentId: string; contactId: string; emailAddressId: string; relationship: Relationship};
type InvitationRow = {
  id: string; business_id: string; student_id: string; contact_id: string; email_address_id: string;
  recipient_email: string; relationship: Relationship; token_hash: string | null;
  status: 'queued' | 'delivery_failed' | 'sent' | 'accepted' | 'revoked' | 'expired';
  delivery_error: 'sender_unavailable' | 'delivery_failed' | null; delivery_revision: number;
  expires_at: Date; created_at: Date; updated_at: Date; accepted_at: Date | null;
  revoked_at: Date | null; created_by: string; accepted_by: string | null;
};
type GrantRow = {id: string; user_id: string; student_id: string; relationship: Relationship; created_at: Date; updated_at: Date; revoked_at: Date | null};
const normalizeEmail = (email: string) => email.trim().toLowerCase();
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const activeStatuses = ['queued', 'delivery_failed', 'sent'];
const invitationItem = (row: InvitationRow) => ({
  id: row.id, businessId: row.business_id, studentId: row.student_id,
  contactId: row.contact_id, emailAddressId: row.email_address_id,
  recipientEmail: row.recipient_email, relationship: row.relationship,
  status: activeStatuses.includes(row.status) && new Date(row.expires_at).getTime() <= Date.now() ? 'expired' : row.status,
  deliveryError: row.delivery_error, expiresAt: row.expires_at, createdAt: row.created_at,
  updatedAt: row.updated_at, acceptedAt: row.accepted_at, revokedAt: row.revoked_at,
});
const grantItem = (row: GrantRow) => ({
  id: row.id, userId: row.user_id, studentId: row.student_id, relationship: row.relationship,
  createdAt: row.created_at, updatedAt: row.updated_at, revokedAt: row.revoked_at,
});

@Injectable()
export class PortalService {
  constructor(@Inject(Database) private readonly db: Database,
    @Inject(IdentityService) private readonly identity: IdentityService) {}

  private assertManager(policy: Policy, studentId?: string) {
    if (!policy.entitlements.includes('clients')) throw new ForbiddenException('Clients is not enabled for this business');
    if (!hasPermission(policy, 'platform.invites.manage')) throw new ForbiddenException('Portal invitation management permission is required');
    if (studentId) assertStudentAccess({...policy, requestId: randomUUID()}, studentId);
  }

  private async manager(session: Session, businessId: string, studentId?: string) {
    const policy = await this.identity.requireBusinessContext(session, businessId);
    this.assertManager(policy, studentId);
    return policy;
  }

  private async audit(tx: PoolClient, policy: {sub: string; businessId: string},
    action: string, studentId: string, invitationId?: string, subjectUserId?: string) {
    await tx.query('INSERT INTO portal_access_audit (business_id,actor_id,action,invitation_id,student_id,subject_user_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [policy.businessId, policy.sub, action, invitationId ?? null, studentId, subjectUserId ?? null]);
    await emitEvent(tx, {type: `platform.portal-${action.replaceAll('_', '-')}.v1`,
      producer: 'platform', businessId: policy.businessId,
      data: {studentId, ...(invitationId ? {invitationId} : {}), ...(subjectUserId ? {userId: subjectUserId} : {})}});
  }

  private async lockAccess(tx: PoolClient, businessId: string, studentId: string, recipientEmail: string) {
    // Acceptance, revocation and explicit issuance serialize for this recipient.
    // An older pending token cannot race a revocation and restore the grant.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',
      [`portal-access:${businessId}:${studentId}:${normalizeEmail(recipientEmail)}`]);
  }

  private async student(businessId: string, studentId: string, protect: boolean) {
    const secret = process.env.PORTAL_INTERNAL_SECRET;
    if (!secret || secret.length < 32) throw new ServiceUnavailableException('Portal student validation is unavailable');
    try {
      const response = await serviceFetch('clients', '/internal/portal-students', {
        method: 'POST', headers: {'Content-Type': 'application/json', 'X-Portal-Internal-Secret': secret},
        body: JSON.stringify({businessId, studentId, protect}), signal: AbortSignal.timeout(8_000),
      });
      if (response.status === 404) throw new NotFoundException('Student is unavailable');
      if (response.status === 409) throw new ConflictException('Inactive or merged students cannot receive portal access');
      if (!response.ok) throw new ServiceUnavailableException('Portal student validation is unavailable');
      const parsed = portalStudentResponseSchema.safeParse(await response.json());
      if (!parsed.success || (protect && (!parsed.data.item.portalProtected || parsed.data.item.id !== studentId)))
        throw new ServiceUnavailableException('Portal student validation is unavailable');
      return parsed.data.item;
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ConflictException || error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('Portal student validation is unavailable');
    }
  }

  private async recipient(input: InviteInput) {
    const student = await this.student(input.businessId, input.studentId, true);
    const contact = student.contacts.find(contact => contact.id === input.contactId);
    const address = contact?.emails.find(address => address.id === input.emailAddressId);
    const allowed = input.relationship === 'student' ? ['student', 'self'] : ['parent', 'guardian'];
    if (!contact || !address || !allowed.includes(contact.relationship))
      throw new BadRequestException('Choose a student email or a linked parent/guardian email');
    return normalizeEmail(address.value);
  }

  private mailHeaders() {
    return {'Content-Type': 'application/json', 'X-Auth-Mail-Secret': process.env.AUTH_MAIL_INTERNAL_SECRET ?? ''};
  }

  private async mailStatus() {
    if (process.env.AUTH_MAIL_ENABLED !== 'true' || !/^[A-Za-z0-9+/_=-]{32,512}$/.test(process.env.AUTH_MAIL_INTERNAL_SECRET ?? ''))
      return {available: false, provider: null, reason: 'sender_unavailable', manualDeliveryAvailable: true} as const;
    try {
      const response = await serviceFetch('notifications', '/internal/auth-mail/status', {
        method: 'GET', headers: this.mailHeaders(), signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error('Unavailable');
      const data = await response.json() as {available?: unknown; provider?: unknown};
      return {available: data.available === true, provider: data.provider === 'resend' ? 'resend' : null,
        reason: data.available === true ? null : 'sender_unavailable', manualDeliveryAvailable: true} as const;
    } catch {
      return {available: false, provider: null, reason: 'status_unavailable', manualDeliveryAvailable: true} as const;
    }
  }

  async senderStatus(session: Session, businessId: string) {
    await this.manager(session, businessId);
    return {item: await this.mailStatus()};
  }

  async list(session: Session, input: {businessId: string; studentId?: string}) {
    const policy = await this.manager(session, input.businessId, input.studentId);
    return this.db.withTenant(input.businessId, async tx => {
      const result = await tx.query<InvitationRow>(
        'SELECT * FROM portal_invitations WHERE ($1::boolean OR student_id=ANY($2::uuid[])) AND ($3::uuid IS NULL OR student_id=$3) ORDER BY created_at DESC,id LIMIT 100',
        [policy.accessScope === 'business', policy.studentIds, input.studentId ?? null]);
      return {items: result.rows.map(invitationItem)};
    });
  }

  private manualUrl(token: string, businessId: string) {
    const origin = new URL(process.env.PUBLIC_APP_URL || 'http://localhost:3000').origin;
    return `${origin}/portal/invite#token=${encodeURIComponent(token)}&business=${encodeURIComponent(businessId)}`;
  }

  async create(session: Session, input: InviteInput) {
    await this.manager(session, input.businessId, input.studentId);
    const recipientEmail = await this.recipient(input);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    const prepared = await this.db.withTenant(input.businessId, async tx => {
      const policy = await this.identity.requireBusinessContext(session, input.businessId, tx);
      this.assertManager(policy, input.studentId);
      await this.lockAccess(tx, input.businessId, input.studentId, recipientEmail);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`portal-invite:${input.businessId}:${input.studentId}:${recipientEmail}:${input.relationship}`]);
      await tx.query("UPDATE portal_invitations SET status='expired',token_hash=NULL,updated_at=now() WHERE student_id=$1 AND recipient_email=$2 AND relationship=$3 AND status IN ('queued','delivery_failed','sent') AND expires_at<=now()",
        [input.studentId, recipientEmail, input.relationship]);
      const existing = await tx.query<InvitationRow>(
        `SELECT i.* FROM portal_invitations i WHERE i.student_id=$1 AND i.recipient_email=$2 AND i.relationship=$3 AND
          (i.status IN ('queued','delivery_failed','sent') OR (i.status='accepted' AND EXISTS (
            SELECT 1 FROM portal_student_access a WHERE a.user_id=i.accepted_by AND a.student_id=i.student_id AND a.revoked_at IS NULL
          ))) ORDER BY i.created_at DESC LIMIT 1`, [input.studentId, recipientEmail, input.relationship]);
      if (existing.rows[0]) return {row: existing.rows[0], deduplicated: true};
      const result = await tx.query<InvitationRow>(
        `INSERT INTO portal_invitations (id,business_id,student_id,contact_id,email_address_id,recipient_email,relationship,token_hash,status,expires_at,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10) RETURNING *`,
        [randomUUID(), input.businessId, input.studentId, input.contactId, input.emailAddressId, recipientEmail, input.relationship, hashToken(token), expiresAt, session.user.id]);
      const row = result.rows[0]!;
      await this.audit(tx, policy, 'invitation_created', row.student_id, row.id);
      return {row, deduplicated: false};
    });
    if (prepared.deduplicated) return {item: invitationItem(prepared.row), deduplicated: true};
    return this.deliver(prepared.row, token, session);
  }

  private async deliver(row: InvitationRow, token: string, session: Session) {
    const status = await this.mailStatus();
    let accepted = false;
    let messageId: string | null = null;
    let deliveryError: InvitationRow['delivery_error'] = status.available ? 'delivery_failed' : 'sender_unavailable';
    if (status.available) {
      try {
        const response = await serviceFetch('notifications', '/internal/auth-mail/portal-invitation', {
          method: 'POST', headers: this.mailHeaders(), signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({recipientEmail: row.recipient_email, token, businessId: row.business_id,
            invitationId: row.id, deliveryRevision: row.delivery_revision}),
        });
        if (response.ok) {
          const receipt = await response.json() as {accepted?: unknown; messageId?: unknown};
          if (receipt.accepted === true && typeof receipt.messageId === 'string' && /^[A-Za-z0-9_-]{1,300}$/.test(receipt.messageId)) {
            accepted = true; messageId = receipt.messageId; deliveryError = null;
          }
        }
      } catch { /* Persist a fixed actionable failure, never provider contents or tokens. */ }
    }
    const current = await this.db.withTenant(row.business_id, async tx => {
      const update = await tx.query<InvitationRow>(
        "UPDATE portal_invitations SET status=$1,delivery_error=$2,provider_message_id=$3,updated_at=now() WHERE id=$4 AND token_hash=$5 AND delivery_revision=$6 AND status='queued' RETURNING *",
        [accepted ? 'sent' : 'delivery_failed', deliveryError, messageId, row.id, hashToken(token), row.delivery_revision]);
      if (update.rows[0]) {
        await this.audit(tx, {sub: session.user.id, businessId: row.business_id}, accepted ? 'delivery_accepted' : 'delivery_failed', row.student_id, row.id);
        return update.rows[0];
      }
      const result = await tx.query<InvitationRow>('SELECT * FROM portal_invitations WHERE id=$1', [row.id]);
      if (!result.rows[0]) throw new NotFoundException('Invitation is unavailable');
      return result.rows[0];
    });
    // A concurrent revocation/acceptance/rotation makes this raw link obsolete.
    return {item: invitationItem(current), deduplicated: false,
      ...(current.token_hash === hashToken(token) && activeStatuses.includes(current.status)
        ? {manualInviteUrl: this.manualUrl(token, row.business_id)} : {})};
  }

  async resend(session: Session, businessId: string, invitationId: string) {
    const policy = await this.manager(session, businessId);
    const previous = await this.db.withTenant(businessId, async tx => {
      const result = await tx.query<InvitationRow>('SELECT * FROM portal_invitations WHERE id=$1', [invitationId]);
      if (!result.rows[0]) throw new NotFoundException('Invitation is unavailable');
      this.assertManager(policy, result.rows[0].student_id);
      return result.rows[0];
    });
    if (previous.status === 'accepted') throw new ConflictException('Access was accepted; revoke the access grant before inviting again');
    if (previous.status === 'revoked') throw new ConflictException('Create a new invitation after revocation');
    if (previous.status === 'queued' && Date.now() - new Date(previous.updated_at).getTime() < 60_000)
      throw new ConflictException('Delivery is in progress; retry after one minute');
    const email = await this.recipient({businessId, studentId: previous.student_id, contactId: previous.contact_id,
      emailAddressId: previous.email_address_id, relationship: previous.relationship});
    if (email !== previous.recipient_email) throw new ConflictException('The linked email changed; revoke this invitation and create a new one');
    const token = randomBytes(32).toString('base64url');
    const next = await this.db.withTenant(businessId, async tx => {
      const currentPolicy = await this.identity.requireBusinessContext(session, businessId, tx);
      this.assertManager(currentPolicy, previous.student_id);
      await this.lockAccess(tx, businessId, previous.student_id, email);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`portal-invite:${businessId}:${previous.student_id}:${email}:${previous.relationship}`]);
      const duplicate = await tx.query<{id: string}>(
        "SELECT id FROM portal_invitations WHERE student_id=$1 AND recipient_email=$2 AND relationship=$3 AND id<>$4 AND status IN ('queued','delivery_failed','sent') LIMIT 1",
        [previous.student_id, email, previous.relationship, invitationId]);
      if (duplicate.rows[0]) throw new ConflictException('A newer invitation exists; use that invitation');
      const result = await tx.query<InvitationRow>(
        "UPDATE portal_invitations SET token_hash=$1,expires_at=$2,status='queued',delivery_error=NULL,provider_message_id=NULL,delivery_revision=delivery_revision+1,updated_at=now() WHERE id=$3 AND delivery_revision=$4 AND status NOT IN ('accepted','revoked') RETURNING *",
        [hashToken(token), new Date(Date.now() + 7 * 24 * 60 * 60_000), invitationId, previous.delivery_revision]);
      const row = result.rows[0];
      if (!row) throw new ConflictException('Invitation changed; refresh before retrying');
      await this.audit(tx, currentPolicy, 'invitation_resent', row.student_id, row.id);
      return row;
    });
    return this.deliver(next, token, session);
  }

  async revokeInvitation(session: Session, businessId: string, invitationId: string) {
    await this.manager(session, businessId);
    return this.db.withTenant(businessId, async tx => {
      const policy = await this.identity.requireBusinessContext(session, businessId, tx);
      const selected = await tx.query<InvitationRow>('SELECT * FROM portal_invitations WHERE id=$1 FOR UPDATE', [invitationId]);
      const row = selected.rows[0];
      if (!row) throw new NotFoundException('Invitation is unavailable');
      this.assertManager(policy, row.student_id);
      if (row.status === 'accepted') throw new ConflictException('Revoke the accepted access grant instead');
      if (row.status === 'revoked') return {item: invitationItem(row)};
      const updated = await tx.query<InvitationRow>("UPDATE portal_invitations SET status='revoked',token_hash=NULL,revoked_at=now(),delivery_error=NULL,updated_at=now() WHERE id=$1 RETURNING *", [invitationId]);
      await this.audit(tx, policy, 'invitation_revoked', row.student_id, row.id);
      return {item: invitationItem(updated.rows[0]!)};
    });
  }

  async accept(session: Session, businessId: string, token: string) {
    return this.db.withTenant(businessId, async tx => {
      const preview = await tx.query<InvitationRow>(
        "SELECT * FROM portal_invitations WHERE token_hash=$1 AND status IN ('queued','delivery_failed','sent') AND expires_at>now()", [hashToken(token)]);
      const candidate = preview.rows[0];
      if (!candidate || normalizeEmail(session.user.email) !== candidate.recipient_email)
        throw new ForbiddenException('Invitation is invalid, expired, or belongs to another email');
      await this.lockAccess(tx, businessId, candidate.student_id, candidate.recipient_email);
      const result = await tx.query<InvitationRow>(
        "SELECT * FROM portal_invitations WHERE token_hash=$1 AND status IN ('queued','delivery_failed','sent') AND expires_at>now() FOR UPDATE", [hashToken(token)]);
      const row = result.rows[0];
      if (!row || normalizeEmail(session.user.email) !== row.recipient_email)
        throw new ForbiddenException('Invitation is invalid, expired, or belongs to another email');
      const business = await tx.query<{entitlements: string[]}>('SELECT entitlements FROM businesses WHERE business_id=$1', [businessId]);
      if (!business.rows[0]?.entitlements.includes('clients')) throw new ForbiddenException('Clients is not enabled for this business');
      const role = row.relationship === 'guardian' ? 'parent' : 'student';
      await tx.query(`INSERT INTO memberships (business_id,user_id,role,access_scope) VALUES ($1,$2,$3,'students')
        ON CONFLICT (business_id,user_id) DO UPDATE SET
          role=CASE WHEN memberships.role IN ('owner','admin','tutor','parent') THEN memberships.role ELSE EXCLUDED.role END,
          access_scope=CASE WHEN memberships.role IN ('owner','admin','tutor') THEN memberships.access_scope ELSE 'students' END`,
        [businessId, session.user.id, role]);
      await tx.query('INSERT INTO identity_business_directory (user_id,business_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [session.user.id, businessId]);
      const grant = await tx.query<GrantRow>(`INSERT INTO portal_student_access (business_id,user_id,student_id,relationship) VALUES ($1,$2,$3,$4)
        ON CONFLICT (business_id,user_id,student_id) DO UPDATE SET
          relationship=CASE WHEN portal_student_access.relationship='guardian' THEN 'guardian' ELSE EXCLUDED.relationship END,
          revoked_at=NULL,updated_at=now() RETURNING *`, [businessId, session.user.id, row.student_id, row.relationship]);
      await tx.query("UPDATE portal_invitations SET status='accepted',token_hash=NULL,accepted_by=$1,accepted_at=now(),delivery_error=NULL,updated_at=now() WHERE id=$2", [session.user.id, row.id]);
      await this.audit(tx, {sub: session.user.id, businessId}, 'invitation_accepted', row.student_id, row.id, session.user.id);
      return {item: {businessId, studentId: row.student_id, relationship: grant.rows[0]!.relationship, access: grantItem(grant.rows[0]!)}};
    });
  }

  async access(session: Session, input: {businessId: string; studentId?: string}) {
    const policy = await this.identity.requireBusinessContext(session, input.businessId);
    if (!policy.entitlements.includes('clients') || !hasPermission(policy, 'clients.read')) throw new ForbiddenException('Student access read permission is required');
    if (input.studentId) assertStudentAccess({...policy, requestId: randomUUID()}, input.studentId);
    const manage = Boolean(input.studentId && hasPermission(policy, 'platform.invites.manage'));
    return this.db.withTenant(input.businessId, async tx => {
      const result = await tx.query<GrantRow>(
        'SELECT * FROM portal_student_access WHERE revoked_at IS NULL AND ($1::boolean OR user_id=$2) AND ($3::uuid IS NULL OR student_id=$3) ORDER BY student_id,user_id LIMIT 500',
        [manage, session.user.id, input.studentId ?? null]);
      return {items: result.rows.map(grantItem)};
    });
  }

  async revokeAccess(session: Session, businessId: string, grantId: string) {
    await this.manager(session, businessId);
    return this.db.withTenant(businessId, async tx => {
      const policy = await this.identity.requireBusinessContext(session, businessId, tx);
      const preview = await tx.query<GrantRow & {recipient_email: string}>(
        'SELECT a.*,lower(btrim(u.email)) AS recipient_email FROM portal_student_access a JOIN "user" u ON u.id=a.user_id WHERE a.id=$1', [grantId]);
      const candidate = preview.rows[0];
      if (!candidate) throw new NotFoundException('Access grant is unavailable');
      this.assertManager(policy, candidate.student_id);
      await this.lockAccess(tx, businessId, candidate.student_id, candidate.recipient_email);
      const result = await tx.query<GrantRow>('SELECT * FROM portal_student_access WHERE id=$1 FOR UPDATE', [grantId]);
      const row = result.rows[0];
      if (!row) throw new NotFoundException('Access grant is unavailable');
      this.assertManager(policy, row.student_id);
      if (row.revoked_at) return {item: grantItem(row)};
      const updated = await tx.query<GrantRow>('UPDATE portal_student_access SET revoked_at=now(),updated_at=now() WHERE id=$1 RETURNING *', [grantId]);
      // Invalidate pending invitations for this recipient/student, so an older
      // unconsumed link cannot silently restore access after explicit revocation.
      const revokedInvites = await tx.query<InvitationRow>(`UPDATE portal_invitations SET status='revoked',token_hash=NULL,revoked_at=now(),delivery_error=NULL,updated_at=now()
        WHERE student_id=$1 AND recipient_email=(SELECT lower(btrim(email)) FROM "user" WHERE id=$2) AND status IN ('queued','delivery_failed','sent') RETURNING *`, [row.student_id, row.user_id]);
      for (const invitation of revokedInvites.rows)
        await this.audit(tx, policy, 'invitation_revoked', invitation.student_id, invitation.id);
      await this.audit(tx, policy, 'access_revoked', row.student_id, undefined, row.user_id);
      return {item: grantItem(updated.rows[0]!)};
    });
  }
}
