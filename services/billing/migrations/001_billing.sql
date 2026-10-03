CREATE TABLE invoices (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL,
  client_id uuid,
  payer_name text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  total_minor bigint NOT NULL CHECK (total_minor > 0 AND total_minor <= 9007199254740991),
  paid_minor bigint NOT NULL DEFAULT 0 CHECK (paid_minor >= 0 AND paid_minor <= total_minor),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','settled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  issued_at timestamptz,
  UNIQUE (business_id, id),
  CHECK ((status = 'draft' AND issued_at IS NULL AND paid_minor = 0) OR
         (status = 'issued' AND issued_at IS NOT NULL AND paid_minor < total_minor) OR
         (status = 'settled' AND issued_at IS NOT NULL AND paid_minor = total_minor))
);
CREATE INDEX invoices_business_created_idx ON invoices(business_id,created_at DESC);
CREATE TABLE payment_allocations (
  business_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9007199254740991),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id,payment_id),
  FOREIGN KEY (business_id,invoice_id) REFERENCES invoices(business_id,id)
);
CREATE TABLE billing_idempotency (
  business_id uuid NOT NULL,
  operation text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id,operation,key)
);
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY invoices_tenant ON invoices USING (business_id = nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK (business_id = nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_allocations_tenant ON payment_allocations USING (business_id = nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK (business_id = nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE billing_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_idempotency_tenant ON billing_idempotency USING (business_id = nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK (business_id = nullif(current_setting('app.business_id',true),'')::uuid);
