ALTER TABLE payment_connections DROP CONSTRAINT payment_connections_status_check;
ALTER TABLE payment_connections ADD CONSTRAINT payment_connections_status_check CHECK(status IN ('enabled','unavailable','disabled'));
ALTER TABLE payment_connections ADD COLUMN config jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE payment_connections ADD COLUMN verified_at timestamptz;
ALTER TABLE payment_attempts ADD COLUMN checkout_url text;
ALTER TABLE payment_attempts ADD COLUMN creation_status text NOT NULL DEFAULT 'ready' CHECK(creation_status IN ('creating','ready','unknown','failed','expired'));
ALTER TABLE payment_attempts ADD COLUMN last_error text;
ALTER TABLE payment_attempts ADD COLUMN expires_at timestamptz;
ALTER TABLE payment_attempts ADD COLUMN last_refreshed_at timestamptz;
ALTER TABLE payment_attempts ADD COLUMN current_generation integer NOT NULL DEFAULT 1;
CREATE TABLE stripe_checkout_sessions (
 business_id uuid NOT NULL,attempt_id uuid NOT NULL,generation integer NOT NULL,provider_reference text,
 payload jsonb NOT NULL,status text NOT NULL CHECK(status IN ('creating','ready','unknown','failed','expired')),
 lease_token uuid,lease_until timestamptz,last_error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,attempt_id,generation),UNIQUE(business_id,provider_reference),
 FOREIGN KEY(business_id,attempt_id) REFERENCES payment_attempts(business_id,id)
);
ALTER TABLE stripe_checkout_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_checkout_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY stripe_checkout_sessions_tenant ON stripe_checkout_sessions USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
