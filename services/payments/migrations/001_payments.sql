CREATE TABLE payment_connections (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('sandbox','stripe','paypal','bank')),
  display_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('enabled','unavailable')),
  credentials_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(business_id,id)
);
CREATE TABLE invoice_snapshots (
  invoice_id uuid NOT NULL,
  business_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=9007199254740991),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  confirmed_minor bigint NOT NULL DEFAULT 0 CHECK(confirmed_minor>=0 AND confirmed_minor<=amount_minor),
  issued_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(business_id,invoice_id)
);
CREATE TABLE payment_attempts (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider text NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=9007199254740991),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK(status IN ('pending','confirmed')),
  provider_reference text NOT NULL,
  simulated boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  UNIQUE(business_id,id),
  UNIQUE(business_id,invoice_id),
  UNIQUE(business_id,connection_id,provider_reference),
  FOREIGN KEY(business_id,connection_id) REFERENCES payment_connections(business_id,id),
  FOREIGN KEY(business_id,invoice_id) REFERENCES invoice_snapshots(business_id,invoice_id),
  CHECK((status='pending' AND confirmed_at IS NULL) OR (status='confirmed' AND confirmed_at IS NOT NULL))
);
CREATE TABLE provider_events (
  business_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  event_reference text NOT NULL,
  attempt_id uuid NOT NULL,
  event_type text NOT NULL,
  simulated boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(business_id,connection_id,event_reference),
  FOREIGN KEY(business_id,connection_id) REFERENCES payment_connections(business_id,id),
  FOREIGN KEY(business_id,attempt_id) REFERENCES payment_attempts(business_id,id)
);
CREATE TABLE payments_idempotency (
  business_id uuid NOT NULL,
  operation text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(business_id,operation,key)
);
ALTER TABLE payment_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_connections_tenant ON payment_connections USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE invoice_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_snapshots_tenant ON invoice_snapshots USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_attempts_tenant ON payment_attempts USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE provider_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_events FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_events_tenant ON provider_events USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE payments_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments_idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY payments_idempotency_tenant ON payments_idempotency USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
