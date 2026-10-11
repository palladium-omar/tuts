-- An attempt must refer to a reminder within its own tenant, even through a
-- privileged referential-integrity check. Domain runtime still enforces RLS.
ALTER TABLE student_reminders ADD CONSTRAINT student_reminders_tenant_id UNIQUE(business_id,id);
ALTER TABLE student_reminder_attempts DROP CONSTRAINT student_reminder_attempts_reminder_id_fkey;
ALTER TABLE student_reminder_attempts ADD CONSTRAINT student_reminder_attempts_tenant_reminder
 FOREIGN KEY(business_id,reminder_id) REFERENCES student_reminders(business_id,id);
CREATE INDEX notification_reminder_directory_scan ON notification_reminder_directory(last_scan_at,business_id);
CREATE INDEX student_reminder_attempts_reminder ON student_reminder_attempts(business_id,reminder_id);
