-- 0182_premises_from_settings.sql
-- Factory clock-in reads premises_latitude, premises_longitude and
-- premises_radius_m from the location recorded in Organisation settings.
-- The coordinates previously planted on Namanve Factory are removed.

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS premises_latitude double precision,
  ADD COLUMN IF NOT EXISTS premises_longitude double precision,
  ADD COLUMN IF NOT EXISTS premises_radius_m numeric(8,2);

UPDATE locations
SET geo = '{}'::jsonb
WHERE (geo->>'lat') = '0.34306'
  AND (geo->>'lng') = '32.69861';
