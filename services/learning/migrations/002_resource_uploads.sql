ALTER TABLE resources DROP CONSTRAINT resources_storage_status_check;
-- Replace the original combined link/file invariant; retain pending legacy metadata.
DO $$
DECLARE resource_constraint record;
BEGIN
 FOR resource_constraint IN SELECT conname FROM pg_constraint
 WHERE conrelid='resources'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%storage_status%' LOOP
  EXECUTE format('ALTER TABLE resources DROP CONSTRAINT %I', resource_constraint.conname);
 END LOOP;
END;
$$;
ALTER TABLE resources ADD COLUMN storage_key uuid;
ALTER TABLE resources ADD CONSTRAINT resources_storage_status_check CHECK (storage_status IN ('linked','upload_pending','stored'));
ALTER TABLE resources ADD CONSTRAINT resources_storage_invariant CHECK (
 (kind='link' AND url IS NOT NULL AND storage_status='linked' AND storage_key IS NULL) OR
 (kind='file_metadata' AND file_name IS NOT NULL AND url IS NULL AND (
  (storage_status='upload_pending' AND storage_key IS NULL) OR
  (storage_status='stored' AND storage_key IS NOT NULL AND mime_type IS NOT NULL AND size_bytes > 0)
 ))
);
