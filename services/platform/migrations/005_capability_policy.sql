-- Null means use the role preset; an explicit empty array denies all actions.
ALTER TABLE memberships
  ADD COLUMN permissions_override text[],
  ADD COLUMN access_scope text NOT NULL DEFAULT 'business'
    CHECK (access_scope IN ('business', 'students'));

-- Apply this through tenant-scoped updates because memberships forces RLS.
DO $$
DECLARE tenant_id uuid;
BEGIN
  FOR tenant_id IN SELECT DISTINCT business_id FROM identity_business_directory LOOP
    PERFORM set_config('app.business_id', tenant_id::text, true);
    UPDATE memberships SET access_scope = 'students'
      WHERE business_id = tenant_id AND role IN ('student', 'parent');
  END LOOP;
  PERFORM set_config('app.business_id', '', true);
END $$;
ALTER TABLE memberships ADD CONSTRAINT portal_membership_student_scope
  CHECK (role NOT IN ('student', 'parent') OR access_scope = 'students');

-- Students are authoritative in Clients; only their opaque IDs are stored here.
-- A membership or group alone never creates one of these relationship grants.
CREATE TABLE portal_student_access (
  business_id uuid NOT NULL,
  user_id text NOT NULL,
  student_id uuid NOT NULL,
  relationship text NOT NULL CHECK (relationship IN ('student', 'guardian')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (business_id, user_id, student_id),
  FOREIGN KEY (business_id, user_id) REFERENCES memberships(business_id, user_id)
    ON DELETE CASCADE
);
CREATE INDEX portal_student_access_student_idx
  ON portal_student_access (business_id, student_id) WHERE revoked_at IS NULL;
ALTER TABLE portal_student_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_student_access FORCE ROW LEVEL SECURITY;
CREATE POLICY portal_student_access_tenant ON portal_student_access
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
