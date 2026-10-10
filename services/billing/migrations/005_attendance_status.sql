ALTER TABLE billing_classes DROP CONSTRAINT billing_classes_status_check;
ALTER TABLE billing_classes ADD CONSTRAINT billing_classes_status_check CHECK(status IN ('scheduled','completed','cancelled','no_show'));
