-- Preserve source bytes and all raw sheet cells independently of normalization.
CREATE TABLE billing_history_sources (
  business_id uuid NOT NULL,
  id uuid NOT NULL,
  token uuid NOT NULL,
  content_hash text NOT NULL,
  options_hash text NOT NULL,
  file_name text NOT NULL,
  content_type text NOT NULL,
  file_bytes bytea NOT NULL CHECK(octet_length(file_bytes)>0 AND octet_length(file_bytes)<=5242880),
  options jsonb NOT NULL,
  raw_source jsonb NOT NULL,
  preview jsonb NOT NULL,
  kind text NOT NULL CHECK(kind IN ('work','invoices','archive')),
  staged_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  commit_result jsonb,
  PRIMARY KEY(business_id,id),
  UNIQUE(business_id,token),
  UNIQUE(business_id,content_hash,options_hash)
);
CREATE TABLE billing_work_log (
  business_id uuid NOT NULL,
  id uuid NOT NULL,
  import_id uuid NOT NULL,
  source_row integer NOT NULL CHECK(source_row>0),
  work_date date NOT NULL,
  student_name text NOT NULL,
  service_type text NOT NULL DEFAULT '',
  hours numeric(18,6) NOT NULL CHECK(hours>0 AND hours<=1000000),
  rate_minor bigint NOT NULL CHECK(rate_minor>=0 AND rate_minor<=9007199254740991),
  amount_minor bigint NOT NULL CHECK(amount_minor>=0 AND amount_minor<=9007199254740991),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK(status IN ('unsent','pending','paid')),
  paid_date date,
  invoice_number text,
  notes text NOT NULL DEFAULT '',
  count_as_classes boolean NOT NULL DEFAULT false,
  raw_columns jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(business_id,id),
  UNIQUE(business_id,import_id,source_row),
  FOREIGN KEY(business_id,import_id) REFERENCES billing_history_sources(business_id,id),
  CHECK(status='paid' OR paid_date IS NULL)
);
CREATE INDEX billing_work_log_filter ON billing_work_log(business_id,work_date DESC,status);
CREATE TABLE billing_invoice_history (
  business_id uuid NOT NULL,
  id uuid NOT NULL,
  import_id uuid,
  source_row integer,
  invoice_date date NOT NULL,
  student_name text NOT NULL,
  service_type text NOT NULL DEFAULT '',
  invoice_number text,
  amount_minor bigint NOT NULL CHECK(amount_minor>=0 AND amount_minor<=9007199254740991),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK(status IN ('unsent','pending','paid')),
  paid_date date,
  notes text NOT NULL DEFAULT '',
  raw_columns jsonb NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(business_id,id),
  UNIQUE(business_id,import_id,source_row),
  FOREIGN KEY(business_id,import_id) REFERENCES billing_history_sources(business_id,id),
  CHECK(status='paid' OR paid_date IS NULL)
);
CREATE INDEX billing_invoice_history_filter ON billing_invoice_history(business_id,invoice_date DESC,status);
ALTER TABLE billing_history_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_history_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_history_sources_tenant ON billing_history_sources USING (business_id = nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK (business_id = nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE billing_work_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_work_log FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_work_log_tenant ON billing_work_log USING (business_id = nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK (business_id = nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE billing_invoice_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_invoice_history FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_invoice_history_tenant ON billing_invoice_history USING (business_id = nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK (business_id = nullif(current_setting('app.business_id',true),'')::uuid);
CREATE UNIQUE INDEX billing_invoice_history_number_unique ON billing_invoice_history(business_id,lower(btrim(invoice_number))) WHERE invoice_number IS NOT NULL;
