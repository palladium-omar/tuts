CREATE TABLE business_seller_profiles (
  business_id uuid PRIMARY KEY,
  revision bigint NOT NULL CHECK (revision > 0),
  seller jsonb NOT NULL CHECK (jsonb_typeof(seller) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE business_seller_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_seller_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY business_seller_profiles_tenant ON business_seller_profiles
 USING (business_id = nullif(current_setting('app.business_id',true),'')::uuid)
 WITH CHECK (business_id = nullif(current_setting('app.business_id',true),'')::uuid);
ALTER TABLE invoices ADD COLUMN seller_snapshot jsonb CHECK (seller_snapshot IS NULL OR jsonb_typeof(seller_snapshot) = 'object');
-- Issued invoice identity is historical, even if the business changes later.
CREATE FUNCTION protect_issued_seller_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status <> 'draft' AND NEW.seller_snapshot IS DISTINCT FROM OLD.seller_snapshot THEN
   RAISE EXCEPTION 'Issued invoice seller snapshot is immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER protect_issued_seller_snapshot BEFORE UPDATE ON invoices
 FOR EACH ROW EXECUTE FUNCTION protect_issued_seller_snapshot();
