-- ============================================================
-- 0041 User default recurring purchase flag + PR header flag
--      + configurable PR numbering (prefix / pad / year format)
-- Marks requisitions as standing / auto-reorder eligible.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_recurring_purchase BOOLEAN;

ALTER TABLE purchase_requisitions
  ADD COLUMN IF NOT EXISTS recurring_purchase BOOLEAN NOT NULL DEFAULT FALSE;

-- Procurement Manager: recurring-purchase default for the demo tenant.
UPDATE users
SET default_recurring_purchase = TRUE
WHERE id = 18 AND tenant_id = 2 AND default_recurring_purchase IS NULL;

-- Configurable PR numbering via app_settings (category 'procurement').
INSERT INTO app_settings (tenant_id, company_id, category, key, value, updated_by)
SELECT 2, 2, x.category, x.key, x.value::jsonb, NULL
FROM (VALUES
  ('procurement', 'pr_number_prefix',   '"PR"'),
  ('procurement', 'pr_number_pad',      '6'),
  ('procurement', 'pr_number_year_fmt', '"YYYY"')
) AS x(category, key, value)
WHERE NOT EXISTS (
  SELECT 1 FROM app_settings s
  WHERE s.tenant_id = 2 AND s.company_id = 2
    AND s.category = x.category AND s.key = x.key
);

-- PR numbering engine: reads settings, shares the document_numbers sequence.
CREATE OR REPLACE FUNCTION next_pr_no(p_tenant bigint, p_company bigint)
RETURNS text AS $$
DECLARE
  seq bigint;
  pfx text;
  pad integer;
  yfmt text;
  y integer;
BEGIN
  SELECT value #>> '{}' INTO pfx FROM app_settings
    WHERE tenant_id = p_tenant AND company_id = p_company
      AND category = 'procurement' AND key = 'pr_number_prefix';
  SELECT (value #>> '{}')::int INTO pad FROM app_settings
    WHERE tenant_id = p_tenant AND company_id = p_company
      AND category = 'procurement' AND key = 'pr_number_pad';
  SELECT value #>> '{}' INTO yfmt FROM app_settings
    WHERE tenant_id = p_tenant AND company_id = p_company
      AND category = 'procurement' AND key = 'pr_number_year_fmt';
  IF pfx IS NULL THEN pfx := 'PR'; END IF;
  IF pad IS NULL OR pad < 1 OR pad > 20 THEN pad := 6; END IF;
  IF yfmt IS NULL THEN yfmt := 'YYYY'; END IF;
  y := to_char(now(), yfmt)::int;
  INSERT INTO document_numbers (tenant_id, prefix, doc_year)
  VALUES (p_tenant, pfx, y)
  ON CONFLICT (tenant_id, prefix, doc_year) DO UPDATE SET last_seq = document_numbers.last_seq + 1
  RETURNING last_seq INTO seq;
  IF seq IS NULL THEN
    SELECT last_seq INTO seq FROM document_numbers
    WHERE tenant_id = p_tenant AND prefix = pfx AND doc_year = y;
  END IF;
  RETURN pfx || '-' || to_char(now(), yfmt) || '-' || lpad(seq::text, pad, '0');
END;
$$ LANGUAGE plpgsql;
