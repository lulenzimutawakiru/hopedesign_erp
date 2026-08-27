-- ============================================================
-- 0038 Document branding - branded, secure export defaults
-- Seeds document branding + tamper-evident verification settings
-- for the demo tenant/company (idempotent, mirrors 0027 pattern).
-- ============================================================

INSERT INTO app_settings (tenant_id, company_id, category, key, value, updated_by)
SELECT 2, 2, x.category, x.key, x.value::jsonb, NULL
FROM (VALUES
  ('general',       'company_tagline',         '"Paper Manufacturing & Security Printing"'),
  ('documents',     'brand_enabled',           'true'),
  ('documents',     'verify_enabled',          'true'),
  ('documents',     'footer_text',             '"Hope Design Group Ltd · Paper Manufacturing & Security Printing"'),
  ('documents',     'pdf_stamp',               'false')
) AS x(category, key, value)
WHERE NOT EXISTS (
  SELECT 1 FROM app_settings s
  WHERE s.tenant_id = 2 AND s.company_id = 2
    AND s.category = x.category AND s.key = x.key
);
