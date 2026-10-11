-- Infrastructure routing registry: no account/student/reminder data. Published
-- outbox rows expire, so they cannot discover reminders scheduled months ahead.
CREATE TABLE notification_reminder_directory (
 business_id uuid PRIMARY KEY,
 last_scan_at timestamptz NOT NULL DEFAULT '-infinity'
);
CREATE TABLE student_reminders (
 id uuid PRIMARY KEY,
 business_id uuid NOT NULL,
 user_id text NOT NULL,
 student_id uuid NOT NULL,
 target_kind text NOT NULL CHECK(target_kind IN ('homework','planning')),
 assignment_id uuid,
 board_id uuid,
 card_id uuid,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 remind_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'scheduled' CHECK(state IN ('scheduled','due','read','cancelled')),
 email_enabled boolean NOT NULL DEFAULT false,
 email_status text NOT NULL DEFAULT 'disabled' CHECK(email_status IN ('disabled','pending','sending','accepted','failed','unknown','suppressed')),
 email_reason text CHECK(email_reason IN ('sender_unavailable','recipient_unavailable','access_revoked','resource_closed','provider_rejected','acceptance_unknown','lease_expired_acceptance_unknown','cancelled')),
 provider_message_id text,
 lease_token uuid,
 lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 read_at timestamptz,
 cancelled_at timestamptz,
 CHECK((target_kind='homework' AND assignment_id IS NOT NULL AND board_id IS NULL AND card_id IS NULL) OR (target_kind='planning' AND assignment_id IS NULL AND board_id IS NOT NULL AND card_id IS NOT NULL)),
 CHECK((email_enabled AND email_status<>'disabled') OR (NOT email_enabled AND email_status='disabled')),
 CHECK((email_status='sending')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX student_reminders_account ON student_reminders(business_id,user_id,student_id,remind_at,id);
CREATE INDEX student_reminders_due ON student_reminders(business_id,remind_at,id) WHERE state='scheduled' OR email_status IN ('pending','sending');
CREATE UNIQUE INDEX student_reminders_duplicate ON student_reminders(business_id,user_id,student_id,target_kind,coalesce(assignment_id,card_id),remind_at) WHERE state IN ('scheduled','due');
ALTER TABLE student_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_reminders FORCE ROW LEVEL SECURITY;
CREATE POLICY student_reminders_tenant ON student_reminders USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
CREATE TABLE student_reminder_attempts (
 id uuid PRIMARY KEY,
 business_id uuid NOT NULL,
 reminder_id uuid NOT NULL REFERENCES student_reminders(id),
 idempotency_key text NOT NULL,
 status text NOT NULL CHECK(status IN ('sending','accepted','failed','unknown','suppressed')),
 reason text,
 provider_message_id text,
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz
);
ALTER TABLE student_reminder_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_reminder_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY student_reminder_attempts_tenant ON student_reminder_attempts USING(business_id=nullif(current_setting('app.business_id',true),'')::uuid) WITH CHECK(business_id=nullif(current_setting('app.business_id',true),'')::uuid);
