-- Verified-context feature snapshot gates unattended dispatch; never supplied by request body.
ALTER TABLE integration_connections ADD COLUMN dispatch_entitlements text[] NOT NULL DEFAULT '{}';
