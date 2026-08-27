-- Tenant-level (company_id NULL) app_settings rows could not be upserted:
-- a plain UNIQUE constraint treats NULLs as distinct, so ON CONFLICT never
-- matched and every settings save inserted a new row. PG15+ NULLS NOT
-- DISTINCT makes the conflict target treat NULL company_id as equal.

-- Keep only the latest row per (tenant, company, category, key).
DELETE FROM app_settings a
USING app_settings b
WHERE a.tenant_id = b.tenant_id
  AND a.company_id IS NOT DISTINCT FROM b.company_id
  AND a.category = b.category
  AND a.key = b.key
  AND (a.updated_at, a.id) < (b.updated_at, b.id);

ALTER TABLE app_settings
  DROP CONSTRAINT app_settings_tenant_id_company_id_category_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_settings_tenant_company_category_key
  ON app_settings (tenant_id, company_id, category, key) NULLS NOT DISTINCT;
