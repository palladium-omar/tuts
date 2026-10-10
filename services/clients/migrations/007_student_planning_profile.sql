-- Education facts remain attached to the existing student UUID. No default
-- cycle is assigned to older students whose grade/graduation is unknown.
ALTER TABLE clients ADD COLUMN planning_profile jsonb;
ALTER TABLE clients ADD CONSTRAINT clients_planning_profile_object
  CHECK (planning_profile IS NULL OR (kind='student' AND jsonb_typeof(planning_profile)='object'));
