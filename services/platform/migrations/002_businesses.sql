CREATE TABLE businesses (
  business_id uuid PRIMARY KEY, name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  entitlements text[] NOT NULL DEFAULT '{}',
  settings jsonb NOT NULL DEFAULT '{"version":1,"timezone":"UTC","language":"en","branding":{"displayName":"","primaryColor":"#2563eb"}}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
  business_id uuid NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','tutor','student','parent')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (business_id, user_id)
);
-- A global identity index permits discovery of a user's business IDs before a
-- tenant is selected. It conveys no role or entitlement; both are checked under
-- tenant RLS against memberships and businesses on each request.
CREATE TABLE identity_business_directory (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, business_id)
);
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses FORCE ROW LEVEL SECURITY;
CREATE POLICY business_tenant ON businesses
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_tenant ON memberships
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
