ALTER TABLE clients ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(custom_fields)='object');
ALTER TABLE clients ADD COLUMN email_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN whatsapp_opt_in boolean NOT NULL DEFAULT false;
CREATE TABLE client_fields (
  business_id uuid NOT NULL,
  id uuid NOT NULL,
  key text NOT NULL CHECK(length(key) BETWEEN 1 AND 160),
  label text NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
  type text NOT NULL CHECK(type IN ('text','number','date','select','boolean')),
  options jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id,id),
  UNIQUE (business_id,key),
  CHECK((type='select' AND options IS NOT NULL AND jsonb_typeof(options)='array') OR (type<>'select' AND options IS NULL))
);
ALTER TABLE client_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_fields FORCE ROW LEVEL SECURITY;
CREATE POLICY client_fields_tenant ON client_fields
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
