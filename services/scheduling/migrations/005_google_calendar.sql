-- Expand the existing external projection; Integrations still owns Google OAuth.
ALTER TABLE external_sessions DROP CONSTRAINT external_sessions_provider_check;
ALTER TABLE external_sessions ADD CONSTRAINT external_sessions_provider_check
  CHECK (provider IN ('calendly', 'calcom', 'google_calendar'));
-- Serialized Google pulls can contain sparse cancellation records without an
-- updated timestamp. Keep observation ordering separate from provider metadata.
ALTER TABLE external_sessions ADD COLUMN provider_observed_at timestamptz;
