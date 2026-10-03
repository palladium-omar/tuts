-- Provider projection intentionally accepts actual overlapping remote sessions.
CREATE TABLE external_sessions (
 id uuid PRIMARY KEY, business_id uuid NOT NULL, connection_id uuid NOT NULL,
 provider text NOT NULL CHECK(provider IN ('calendly','calcom')), external_id text NOT NULL,
 owner_user_id text NOT NULL, title text NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('scheduled','completed','cancelled')),
 attendee_name text, attendee_email text, booking_url text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(ends_at>starts_at), UNIQUE(business_id,connection_id,external_id)
);
CREATE INDEX external_sessions_tenant_starts ON external_sessions(business_id,starts_at,id);
ALTER TABLE external_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY external_sessions_tenant ON external_sessions
 USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
 WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
-- Reject delayed replay of a synchronization after a connection was disconnected.
CREATE TABLE disconnected_session_sources(business_id uuid NOT NULL,connection_id uuid NOT NULL,PRIMARY KEY(business_id,connection_id));
ALTER TABLE disconnected_session_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE disconnected_session_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY disconnected_session_sources_tenant ON disconnected_session_sources
 USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
 WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
