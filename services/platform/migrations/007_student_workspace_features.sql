-- Feature installation for existing workspaces. No account roles, grants or
-- billing ownership change. New plans can disable these through entitlements.
-- The migration runner uses the owning ordinary SQL role and one transaction.
ALTER TABLE businesses NO FORCE ROW LEVEL SECURITY;
UPDATE businesses SET entitlements=array_append(entitlements,'planning'),updated_at=now()
WHERE 'learning'=ANY(entitlements) AND NOT 'planning'=ANY(entitlements);
UPDATE businesses SET entitlements=array_append(entitlements,'reporting'),updated_at=now()
WHERE 'clients'=ANY(entitlements) AND NOT 'reporting'=ANY(entitlements);
ALTER TABLE businesses FORCE ROW LEVEL SECURITY;
