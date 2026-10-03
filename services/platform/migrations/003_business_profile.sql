ALTER TABLE businesses ADD COLUMN business_profile_revision bigint NOT NULL DEFAULT 1 CHECK (business_profile_revision > 0);
