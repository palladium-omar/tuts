ALTER TABLE portal_student_access
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE portal_student_access ADD CONSTRAINT portal_student_access_id_unique UNIQUE (id);

CREATE TABLE portal_invitations (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  student_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  email_address_id uuid NOT NULL,
  recipient_email text NOT NULL CHECK (length(recipient_email) BETWEEN 3 AND 254),
  relationship text NOT NULL CHECK (relationship IN ('student', 'guardian')),
  token_hash text UNIQUE CHECK (token_hash IS NULL OR token_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('queued','delivery_failed','sent','accepted','revoked','expired')),
  delivery_error text CHECK (delivery_error IS NULL OR delivery_error IN ('sender_unavailable','delivery_failed')),
  delivery_revision integer NOT NULL DEFAULT 1 CHECK (delivery_revision > 0),
  provider_message_id text,
  expires_at timestamptz NOT NULL,
  created_by text NOT NULL REFERENCES "user"(id),
  accepted_by text REFERENCES "user"(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (recipient_email = lower(btrim(recipient_email))),
  CHECK (status <> 'accepted' OR (accepted_by IS NOT NULL AND accepted_at IS NOT NULL AND token_hash IS NULL)),
  CHECK (status <> 'revoked' OR (revoked_at IS NOT NULL AND token_hash IS NULL)),
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX portal_invitation_pending_identity
  ON portal_invitations (business_id,student_id,recipient_email,relationship)
  WHERE status IN ('queued','delivery_failed','sent');
CREATE INDEX portal_invitation_student_idx ON portal_invitations (business_id,student_id,created_at DESC);

CREATE TABLE portal_access_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES "user"(id),
  action text NOT NULL CHECK (action IN ('invitation_created','invitation_resent','invitation_revoked','invitation_accepted','access_revoked','delivery_accepted','delivery_failed')),
  invitation_id uuid REFERENCES portal_invitations(id),
  student_id uuid NOT NULL,
  subject_user_id text REFERENCES "user"(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE portal_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY portal_invitations_tenant ON portal_invitations
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
ALTER TABLE portal_access_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_access_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY portal_access_audit_tenant ON portal_access_audit
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
