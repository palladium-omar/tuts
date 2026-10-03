CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL,
  client_id uuid NOT NULL,
  assigned_tutor_id text,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  subject text NOT NULL DEFAULT 'General',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled','completed')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CONSTRAINT sessions_client_overlap EXCLUDE USING gist (
    business_id WITH =, client_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'scheduled'),
  CONSTRAINT sessions_tutor_overlap EXCLUDE USING gist (
    business_id WITH =, assigned_tutor_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'scheduled' AND assigned_tutor_id IS NOT NULL)
);
CREATE INDEX sessions_tenant_starts ON sessions (business_id, starts_at, id);
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_tenant ON sessions
 USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
 WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
