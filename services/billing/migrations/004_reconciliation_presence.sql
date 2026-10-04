-- A complete monthly HTTP snapshot can invalidate stale rows while broker delivery catches up.
ALTER TABLE billing_classes ADD COLUMN reconciliation_missing boolean NOT NULL DEFAULT false;
