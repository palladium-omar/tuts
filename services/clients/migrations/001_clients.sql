CREATE TABLE clients (
  business_id uuid NOT NULL, id uuid NOT NULL, kind text NOT NULL CHECK (kind IN ('student','payer')),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  email text, phone text, notes text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id)
);
CREATE INDEX clients_list_idx ON clients (business_id, created_at DESC, id);
CREATE TABLE client_payers (
  business_id uuid NOT NULL, student_id uuid NOT NULL, payer_id uuid NOT NULL,
  relationship text NOT NULL CHECK (relationship IN ('parent','guardian','sponsor','self','other')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (business_id, student_id, payer_id),
  FOREIGN KEY (business_id, student_id) REFERENCES clients(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, payer_id) REFERENCES clients(business_id, id) ON DELETE CASCADE,
  CHECK (student_id <> payer_id)
);
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;
CREATE POLICY clients_tenant ON clients
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
ALTER TABLE client_payers ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_payers FORCE ROW LEVEL SECURITY;
CREATE POLICY client_payers_tenant ON client_payers
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
