-- HCM workforce planning: the service writes created_by for audit trails; the
-- original 0022 migration omitted the column. Add it now (idempotent).
ALTER TABLE workforce_plans
  ADD COLUMN IF NOT EXISTS created_by BIGINT;