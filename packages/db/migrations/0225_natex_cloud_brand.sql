-- ===========================================================================
-- 0225 - Natex Cloud product branding
--
-- Rebrands the platform's display name to "Natex Cloud" while preserving the
-- legal issuer name ("Hope Design Group Ltd") for official documents. The
-- product brand surfaces through the app shell, sign-in chrome and nav; the
-- legal name remains on the branded-document footer and on the EFRIS taxpayer
-- record (which reads from the taxpayers table, untouched here).
--
-- loadCompanyProfile() already treats these as two distinct concepts:
--   name        <- general.company_name        (display / product brand)
--   legalName   <- general.company_legal_name  -> companies.legal_name
-- This migration only seeds/updates app_settings; it never rewrites companies.
--
-- Idempotent and conservative: it only rewrites the legacy "Hope Design Group
-- Ltd" display default, never an operator's custom value.
--
-- No BEGIN/COMMIT and no schema_migrations row. migrate.js owns both.
-- ===========================================================================

-- (a) Legal issuer name: seed from the companies table where no override exists,
--     so documents keep the registered legal identity after the rebrand.
INSERT INTO app_settings (tenant_id, company_id, category, key, value, updated_by)
SELECT c.tenant_id, c.id, 'general', 'company_legal_name',
       to_jsonb(COALESCE(NULLIF(c.legal_name, ''), c.name)), NULL
FROM companies c
WHERE c.name <> ''
  AND c.name ILIKE 'Hope Design%'
  AND NOT EXISTS (
    SELECT 1 FROM app_settings e
    WHERE e.tenant_id = c.tenant_id AND e.company_id = c.id
      AND e.category = 'general' AND e.key = 'company_legal_name'
  );

-- (b) Display/brand name: point every tenant whose company is still the legacy
--     "Hope Design" entity at the product brand, unless it already has an
--     explicit company_name override.
INSERT INTO app_settings (tenant_id, company_id, category, key, value, updated_by)
SELECT c.tenant_id, c.id, 'general', 'company_name', to_jsonb('Natex Cloud'::text), NULL
FROM companies c
WHERE c.name ILIKE 'Hope Design%'
  AND NOT EXISTS (
    SELECT 1 FROM app_settings e
    WHERE e.tenant_id = c.tenant_id AND e.company_id = c.id
      AND e.category = 'general' AND e.key = 'company_name'
  );

-- (c) Update any existing legacy display default to the product brand.
UPDATE app_settings
SET value = to_jsonb('Natex Cloud'::text), updated_at = now()
WHERE category = 'general' AND key = 'company_name'
  AND value = to_jsonb('Hope Design Group Ltd'::text);
