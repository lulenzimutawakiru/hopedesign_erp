-- 0250_production_cost_wip_account.sql
-- Phase 4 (GL postings): give production WIP accounting a real home on the chart.
--
-- The Hope Design chart maps RAW_INV / FG_INV / WIP all to 10111400, so the
-- production reclassification (Raw -> WIP -> FG) posts a debit and a credit to
-- the same account and disappears (`postInventoryValueChange` returns null on the
-- collision). We add a distinct WIP asset account (10111410) — RAW_INV and FG_INV
-- intentionally stay on the single inventory account 10111400 — plus an
-- abnormal-loss expense account (10251820) for "abnormal loss -> expense".
--
-- The parent codes are resolved per-company so a row's parent_id always points at
-- the same company's chart (unlike the cross-company parent UPDATE in 0226).

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN SELECT id, tenant_id FROM companies LOOP
    PERFORM set_app_context(c.tenant_id, c.id, NULL, NULL);
    INSERT INTO chart_of_accounts (
      company_id, tenant_id, code, name, account_type, subtype,
      parent_id, is_posting, is_active, currency, opening_balance, attributes
    )
    SELECT c.id, c.tenant_id, v.code, v.name, v.account_type, v.subtype,
           (SELECT p.id FROM chart_of_accounts p
             WHERE p.company_id = c.id AND p.code = v.parent_code),
           v.is_posting, true, 'UGX', 0, v.attributes
    FROM (VALUES
      ('10111410', 'Inventory - Work in progress', 'ASSET', 'Current assets', '10111000', true,
        jsonb_build_object('source', 'Production cost accounting modernization')),
      ('10251820', 'Production abnormal loss', 'EXPENSE', 'Direct costs', '10251000', true,
        jsonb_build_object('source', 'Production cost accounting modernization'))
    ) AS v(code, name, account_type, subtype, parent_code, is_posting, attributes)
    ON CONFLICT (company_id, code) DO NOTHING;
  END LOOP;
END $$;
