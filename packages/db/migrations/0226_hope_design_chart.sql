-- Hope Design chart of accounts.
-- Replaces the seed chart with the 116 accounts from Hope Design_Chart of accounts.xlsx.
-- Historical journal amounts stay put. Two legacy accounts are split by
-- what the line was for: opening finished goods go to retained earnings,
-- and production output stays a capitalization (credit to labour).
-- Idempotent: a second run finds the new codes and no legacy codes.

BEGIN;

CREATE TEMP TABLE hope_tb_before AS
SELECT COALESCE(sum(debit), 0) AS debit,
       COALESCE(sum(credit), 0) AS credit,
       count(*) AS lines
FROM journal_lines;

DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT id, tenant_id FROM companies LOOP
    PERFORM set_app_context(c.tenant_id, c.id, NULL, NULL);
    INSERT INTO chart_of_accounts (
      company_id, tenant_id, code, name, account_type, subtype,
      parent_id, is_posting, is_active, currency, opening_balance, attributes
    )
    SELECT c.id, c.tenant_id, v.code, v.name, v.account_type, v.subtype,
           NULL, v.is_posting, true, 'UGX', 0, v.attributes
    FROM (VALUES
    ('10110000', 'Assets', 'ASSET', 'Assets', false, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10111000', 'Current assets', 'ASSET', 'Current assets', false, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10111100', 'Cash at hand', 'ASSET', 'Current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10111200', 'Petty cash', 'ASSET', 'Current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10111300', 'Bank', 'ASSET', 'Current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10111400', 'Inventory-Raw materials', 'ASSET', 'Current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10111500', 'Accounts receivables', 'ASSET', 'Current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10111600', 'Prepayments', 'ASSET', 'Current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10111700', 'Other receivables', 'ASSET', 'Current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10111800', 'Current tax asset', 'ASSET', 'Current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10111900', 'VAT claimable', 'ASSET', 'Current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10112000', 'Non-current assets', 'ASSET', 'Non-current assets', false, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10112100', 'Land', 'ASSET', 'Non-current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10112200', 'Buildings', 'ASSET', 'Non-current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10112300', 'Plant', 'ASSET', 'Non-current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10112400', 'Machinery', 'ASSET', 'Non-current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10112500', 'Motor vehicles', 'ASSET', 'Non-current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10112600', 'Computers and accessories', 'ASSET', 'Non-current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10112700', 'Computer Software', 'ASSET', 'Non-current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10112800', 'Office equipment', 'ASSET', 'Non-current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10112900', 'Furniture', 'ASSET', 'Non-current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10112910', 'Fittings', 'ASSET', 'Non-current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10112920', 'Deferred tax asset', 'ASSET', 'Non-current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10112925', 'Accumulated depreciation', 'CONTRA_ASSET', 'Non-current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx', 'renumberedFrom', '10112920')),
    ('10112930', 'Accumulated amortization', 'CONTRA_ASSET', 'Non-current assets', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10120000', 'Liabilities', 'LIABILITY', 'Liabilities', false, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10121100', 'Accounts payable', 'LIABILITY', 'Current liabilities', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10121200', 'Other payables', 'LIABILITY', 'Current liabilities', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10121300', 'Accrued expenses', 'LIABILITY', 'Current liabilities', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10121400', 'Current tax liability', 'LIABILITY', 'Current liabilities', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10121500', 'Short term loans', 'LIABILITY', 'Current liabilities', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10121600', 'Withholding tax', 'LIABILITY', 'Current liabilities', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10121700', 'VAT payable', 'LIABILITY', 'Current liabilities', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10121800', 'Other current liabilities', 'LIABILITY', 'Current liabilities', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx', 'sheetNameBlank', true)),
    ('10122100', 'Longterm loans', 'LIABILITY', 'Non-current liabilities', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10122200', 'Deferred tax liability', 'LIABILITY', 'Non-current liabilities', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10130000', 'Equity', 'EQUITY', 'Equity', false, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10131100', 'Share Capital', 'EQUITY', 'Share Capital', false, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10131200', 'Ordinary share capital', 'EQUITY', 'Share Capital', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10132100', 'Retained earnings', 'EQUITY', 'Retained earnings', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10132300', 'Share premium', 'EQUITY', 'Other reserves', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10132400', 'Capital reserves', 'EQUITY', 'Other reserves', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10132500', 'Revaluation reserves', 'EQUITY', 'Other reserves', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10240000', 'Income', 'REVENUE', 'Income', false, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10241200', 'Sales', 'REVENUE', 'Operating income', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10241300', 'Sales returns', 'CONTRA_REVENUE', 'Operating income', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10241400', 'VAT control account', 'REVENUE', 'Operating income', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10242100', 'Other income', 'REVENUE', 'Other income', false, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10242200', 'Other sales', 'REVENUE', 'Other income', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10250000', 'Expenses', 'EXPENSE', 'Expenses', false, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10251000', 'Direct costs', 'EXPENSE', 'Direct costs', false, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10251100', 'Raw materials', 'EXPENSE', 'Direct costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10251200', 'Labour', 'EXPENSE', 'Direct costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10251300', 'electricity', 'EXPENSE', 'Direct costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10251400', 'Salaries', 'EXPENSE', 'Direct costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10251410', 'Wages', 'EXPENSE', 'Direct costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10251420', 'Over time - production', 'EXPENSE', 'Direct costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10251500', 'Repairs and maintainance - Machinery', 'EXPENSE', 'Direct costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10251600', 'Depreciation and amortization', 'EXPENSE', 'Direct costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10251700', 'Impairment loss', 'EXPENSE', 'Direct costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10251800', 'Insurance', 'EXPENSE', 'Direct costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10251810', 'Import duties', 'EXPENSE', 'Direct costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10252000', 'Operating costs', 'EXPENSE', 'Operating costs', false, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10252100', 'Operating costs', 'EXPENSE', 'Operating costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx', 'sheetNameBlank', true)),
    ('10252200', 'Operating costs', 'EXPENSE', 'Operating costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx', 'sheetNameBlank', true)),
    ('10252300', 'Operating costs', 'EXPENSE', 'Operating costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx', 'sheetNameBlank', true)),
    ('10252400', 'Operating costs', 'EXPENSE', 'Operating costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx', 'sheetNameBlank', true)),
    ('10253000', 'Selling and distribution expenses', 'EXPENSE', 'Selling and distribution expenses', false, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10253100', 'Transport deliveries', 'EXPENSE', 'Selling and distribution expenses', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10253200', 'Packaging', 'EXPENSE', 'Selling and distribution expenses', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10253300', 'Sales commission', 'EXPENSE', 'Selling and distribution expenses', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10253400', 'Salaries and wages- Sales', 'EXPENSE', 'Selling and distribution expenses', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10253500', 'Overtime', 'EXPENSE', 'Selling and distribution expenses', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10253600', 'Training', 'EXPENSE', 'Selling and distribution expenses', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10253700', 'Transport', 'EXPENSE', 'Selling and distribution expenses', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10253800', 'Meals and accommodation', 'EXPENSE', 'Selling and distribution expenses', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10253900', 'Advertising and promotions', 'EXPENSE', 'Selling and distribution expenses', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10253910', 'Marketing and branding', 'EXPENSE', 'Selling and distribution expenses', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10254000', 'General and Administration', 'EXPENSE', 'General and Administration', false, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10254100', 'Telephone', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10254200', 'Airtime and data', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10254300', 'Printing and stationary', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10254400', 'Rent', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10254500', 'Salaries', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10254600', 'Insurance', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10254700', 'Utilities', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10254800', 'Transport', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10254900', 'Perduem', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10255000', 'Carbage collection', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10255100', 'Cleaning', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10255200', 'Signage', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10255300', 'Subscription licenses', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10255400', 'Legal', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10255500', 'Management fees', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10255600', 'Consultancy', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10255700', 'Audt fees', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10255800', 'Staff meals', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10255900', 'Medical care', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10256000', 'Depreciation & amortization', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10256100', 'Annual subscriptions', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10256200', 'Repairs and maintainance', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10256300', 'Computer accessories', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10256400', 'Electricity repairs', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10256500', 'Security', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10256600', 'Fuel', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10256700', 'Office supplies', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10256800', 'Fine and penalties', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10256900', 'Refreshments', 'EXPENSE', 'General and Administration', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10257000', 'Finance costs', 'EXPENSE', 'Finance costs', false, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10257100', 'Interest on borrowings', 'EXPENSE', 'Finance costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10257200', 'Foreign exchange gains', 'EXPENSE', 'Finance costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10257300', 'Foreign exchange loss', 'EXPENSE', 'Finance costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10257400', 'Bank charges', 'EXPENSE', 'Finance costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10257500', 'Mobile Money charges', 'EXPENSE', 'Finance costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10257600', 'Bounced cheques', 'EXPENSE', 'Finance costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx')),
    ('10257700', 'Funds transfer charges', 'EXPENSE', 'Finance costs', true, jsonb_build_object('source', 'Hope Design_Chart of accounts.xlsx'))
    ) AS v(code, name, account_type, subtype, is_posting, attributes)
    ON CONFLICT (company_id, code) DO NOTHING;
  END LOOP;
END $$;

UPDATE chart_of_accounts child
SET parent_id = parent.id
FROM (VALUES
    ('10111000', '10110000'),
    ('10111100', '10111000'),
    ('10111200', '10111000'),
    ('10111300', '10111000'),
    ('10111400', '10111000'),
    ('10111500', '10111000'),
    ('10111600', '10111000'),
    ('10111700', '10111000'),
    ('10111800', '10111000'),
    ('10111900', '10111000'),
    ('10112000', '10110000'),
    ('10112100', '10112000'),
    ('10112200', '10112000'),
    ('10112300', '10112000'),
    ('10112400', '10112000'),
    ('10112500', '10112000'),
    ('10112600', '10112000'),
    ('10112700', '10112000'),
    ('10112800', '10112000'),
    ('10112900', '10112000'),
    ('10112910', '10112000'),
    ('10112920', '10112000'),
    ('10112925', '10112000'),
    ('10112930', '10112000'),
    ('10121100', '10120000'),
    ('10121200', '10120000'),
    ('10121300', '10120000'),
    ('10121400', '10120000'),
    ('10121500', '10120000'),
    ('10121600', '10120000'),
    ('10121700', '10120000'),
    ('10121800', '10120000'),
    ('10122100', '10120000'),
    ('10122200', '10120000'),
    ('10131100', '10130000'),
    ('10131200', '10131100'),
    ('10132100', '10130000'),
    ('10132300', '10130000'),
    ('10132400', '10130000'),
    ('10132500', '10130000'),
    ('10241200', '10240000'),
    ('10241300', '10240000'),
    ('10241400', '10240000'),
    ('10242100', '10240000'),
    ('10242200', '10242100'),
    ('10251000', '10250000'),
    ('10251100', '10251000'),
    ('10251200', '10251000'),
    ('10251300', '10251000'),
    ('10251400', '10251000'),
    ('10251410', '10251000'),
    ('10251420', '10251000'),
    ('10251500', '10251000'),
    ('10251600', '10251000'),
    ('10251700', '10251000'),
    ('10251800', '10251000'),
    ('10251810', '10251000'),
    ('10252000', '10250000'),
    ('10252100', '10252000'),
    ('10252200', '10252000'),
    ('10252300', '10252000'),
    ('10252400', '10252000'),
    ('10253000', '10250000'),
    ('10253100', '10253000'),
    ('10253200', '10253000'),
    ('10253300', '10253000'),
    ('10253400', '10253000'),
    ('10253500', '10253000'),
    ('10253600', '10253000'),
    ('10253700', '10253000'),
    ('10253800', '10253000'),
    ('10253900', '10253000'),
    ('10253910', '10253000'),
    ('10254000', '10250000'),
    ('10254100', '10254000'),
    ('10254200', '10254000'),
    ('10254300', '10254000'),
    ('10254400', '10254000'),
    ('10254500', '10254000'),
    ('10254600', '10254000'),
    ('10254700', '10254000'),
    ('10254800', '10254000'),
    ('10254900', '10254000'),
    ('10255000', '10254000'),
    ('10255100', '10254000'),
    ('10255200', '10254000'),
    ('10255300', '10254000'),
    ('10255400', '10254000'),
    ('10255500', '10254000'),
    ('10255600', '10254000'),
    ('10255700', '10254000'),
    ('10255800', '10254000'),
    ('10255900', '10254000'),
    ('10256000', '10254000'),
    ('10256100', '10254000'),
    ('10256200', '10254000'),
    ('10256300', '10254000'),
    ('10256400', '10254000'),
    ('10256500', '10254000'),
    ('10256600', '10254000'),
    ('10256700', '10254000'),
    ('10256800', '10254000'),
    ('10256900', '10254000'),
    ('10257000', '10250000'),
    ('10257100', '10257000'),
    ('10257200', '10257000'),
    ('10257300', '10257000'),
    ('10257400', '10257000'),
    ('10257500', '10257000'),
    ('10257600', '10257000'),
    ('10257700', '10257000')
) AS m(code, parent_code)
JOIN chart_of_accounts parent
  ON parent.code = m.parent_code
WHERE child.code = m.code
  AND parent.company_id = child.company_id
  AND child.parent_id IS DISTINCT FROM parent.id;

-- Refuse a legacy equity or production line the split rules do not recognise.
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
  FROM journal_lines jl
  JOIN chart_of_accounts a ON a.id = jl.account_id
  JOIN journal_entries je ON je.id = jl.entry_id
  WHERE a.code = '3000'
    AND COALESCE(jl.description, '') NOT ILIKE '%opening%'
    AND COALESCE(je.description, '') NOT ILIKE '%opening%'
    AND COALESCE(jl.description, '') NOT ILIKE '%capital%'
    AND COALESCE(je.description, '') NOT ILIKE '%capital%';
  IF bad > 0 THEN
    RAISE EXCEPTION 'legacy equity 3000 has % line(s) that are neither opening stock nor capital introduced', bad;
  END IF;

  SELECT count(*) INTO bad
  FROM journal_lines jl
  JOIN chart_of_accounts a ON a.id = jl.account_id
  JOIN journal_entries je ON je.id = jl.entry_id
  WHERE a.code = '5100'
    AND NOT (
      je.journal_type = 'PRODUCTION'
      OR COALESCE(jl.description, '') ILIKE '%production%'
      OR COALESCE(je.description, '') ILIKE '%production%'
      OR COALESCE(jl.description, '') ILIKE '%internet%'
      OR COALESCE(je.description, '') ILIKE '%internet%'
      OR COALESCE(jl.description, '') ILIKE '%reversal%'
      OR COALESCE(je.description, '') ILIKE '%reversal%'
    );
  IF bad > 0 THEN
    RAISE EXCEPTION 'legacy direct-production 5100 has % line(s) that are neither production nor internet', bad;
  END IF;
END $$;

-- Opening finished-goods equity is retained earnings, not share capital.
UPDATE journal_lines jl
SET account_id = retained.id
FROM chart_of_accounts old, chart_of_accounts retained, journal_entries je
WHERE jl.account_id = old.id
  AND je.id = jl.entry_id
  AND retained.company_id = old.company_id
  AND retained.code = '10132100'
  AND old.code = '3000'
  AND (
    COALESCE(jl.description, '') ILIKE '%opening%'
    OR COALESCE(je.description, '') ILIKE '%opening%'
  );

-- Keep the production credit on labour so the finished-goods debit remains a capitalization.
UPDATE journal_lines jl
SET account_id = labour.id
FROM chart_of_accounts old, chart_of_accounts labour, journal_entries je
WHERE jl.account_id = old.id
  AND je.id = jl.entry_id
  AND labour.company_id = old.company_id
  AND labour.code = '10251200'
  AND old.code = '5100'
  AND (
    je.journal_type = 'PRODUCTION'
    OR COALESCE(jl.description, '') ILIKE '%production%'
    OR COALESCE(je.description, '') ILIKE '%production%'
  );

CREATE TEMP TABLE coa_code_map (old_code text PRIMARY KEY, new_code text);
INSERT INTO coa_code_map (old_code, new_code) VALUES
  ('1000', '10111300'),
  ('1100', '10111300'),
  ('1110', '10111300'),
  ('1120', '10111300'),
  ('1200', '10111200'),
  ('1310', '10111400'),
  ('1320', '10111400'),
  ('1330', '10111400'),
  ('1400', '10111500'),
  ('1405', '10111700'),
  ('1500', '10111600'),
  ('1510', '10111700'),
  ('1600', '10112400'),
  ('1610', '10112600'),
  ('1620', '10112925'),
  ('1690', '10251700'),
  ('2100', '10121100'),
  ('2105', '10121200'),
  ('2110', '10121700'),
  ('2115', '10121200'),
  ('2120', '10121400'),
  ('2200', '10121500'),
  ('2210', '10121300'),
  ('3000', '10131200'),
  ('3100', '10132100'),
  ('4000', '10241200'),
  ('4100', '10242200'),
  ('4190', '10257200'),
  ('5000', '10251100'),
  ('5100', '10254200'),
  ('6100', '10254500'),
  ('6200', '10253900'),
  ('6300', '10251300'),
  ('6400', '10256200'),
  ('6500', '10256000'),
  ('6590', '10257300');

CREATE TEMP TABLE coa_remap AS
SELECT old.id AS old_id, neu.id AS new_id, old.company_id, old.code AS old_code
FROM chart_of_accounts old
JOIN coa_code_map m ON m.old_code = old.code
JOIN chart_of_accounts neu ON neu.company_id = old.company_id AND neu.code = m.new_code;

DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
  FROM journal_lines jl
  JOIN chart_of_accounts a ON a.id = jl.account_id
  WHERE a.code = ANY(ARRAY['1000', '1100', '1110', '1120', '1200', '1310', '1320', '1330', '1400', '1405', '1500', '1510', '1600', '1610', '1620', '1690', '2100', '2105', '2110', '2115', '2120', '2200', '2210', '3000', '3100', '4000', '4100', '4190', '5000', '5100', '6100', '6200', '6300', '6400', '6500', '6590', '1300', '2000', '6000'])
    AND NOT EXISTS (SELECT 1 FROM coa_remap m WHERE m.old_id = a.id);
  IF bad > 0 THEN
    RAISE EXCEPTION 'legacy chart still has % journal line(s) with no Hope Design account', bad;
  END IF;

  SELECT count(*) INTO bad
  FROM journal_lines jl
  JOIN chart_of_accounts a ON a.id = jl.account_id
  WHERE a.code = ANY(ARRAY['1300', '2000', '6000']);
  IF bad > 0 THEN
    RAISE EXCEPTION 'non-posting legacy header has % journal line(s); refusing to drop it', bad;
  END IF;
END $$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (con.conkey)
    WHERE con.contype = 'f'
      AND con.confrelid = 'chart_of_accounts'::regclass
      AND n.nspname = 'public'
      AND NOT (c.relname = 'chart_of_accounts' AND a.attname = 'parent_id')
  LOOP
    EXECUTE format(
      'UPDATE %I.%I AS t SET %I = m.new_id FROM coa_remap m WHERE t.%I = m.old_id',
      r.schema_name, r.table_name, r.column_name, r.column_name
    );
  END LOOP;
END $$;

UPDATE posting_rules pr
SET lines = (
  SELECT COALESCE(jsonb_agg(
    CASE
      WHEN mapped.new_code IS NULL THEN line
      ELSE jsonb_set(line, '{account_code}', to_jsonb(mapped.new_code))
    END
    ORDER BY ord
  ), '[]'::jsonb)
  FROM jsonb_array_elements(pr.lines) WITH ORDINALITY AS t(line, ord)
  LEFT JOIN (VALUES
    ('1310', '10111400'),
    ('1320', '10111400'),
    ('1330', '10111400'),
    ('2115', '10121300'),
    ('GRNI', '10121300'),
    ('2210', '10121300'),
    ('2100', '10121100'),
    ('1100', '10111300'),
    ('1200', '10111200'),
    ('1400', '10111500'),
    ('4000', '10241200'),
    ('2110', '10121700'),
    ('6100', '10254500'),
    ('1510', '10111700'),
    ('2120', '10121400'),
    ('5000', '10251100'),
    ('5100', '10251200'),
    ('1405', '10111700'),
    ('2105', '10121200')
  ) AS mapped(old_code, new_code) ON mapped.old_code = line->>'account_code'
);

UPDATE posting_rules
SET is_active = false
WHERE event = 'PRODUCTION_COMPLETE';

UPDATE expense_categories ec
SET account_id = a.id
FROM (VALUES
  ('EXP-ADM-CLEANSUP', '10255100'),
  ('EXP-ADM-OFFSUP', '10256700'),
  ('EXP-ADM-OFFWATER', '10254700'),
  ('EXP-ADM-STATIONERY', '10254300'),
  ('EXP-ADM-SUGAR', '10256900'),
  ('EXP-ADM-TEA', '10256900'),
  ('EXP-FAC-CONSUM', '10251100'),
  ('EXP-FAC-LUBE', '10251500'),
  ('EXP-FAC-MACHREP', '10251500'),
  ('EXP-FAC-PACK', '10253200'),
  ('EXP-FAC-PPE', '10256700'),
  ('EXP-FAC-SPARES', '10251500'),
  ('EXP-FAC-WASTE', '10255000'),
  ('EXP-LOG-DELIVERY', '10253100'),
  ('EXP-LOG-LOAD', '10253100'),
  ('EXP-LOG-OFFLOAD', '10253100'),
  ('EXP-LOG-TRANSP', '10253100'),
  ('EXP-LOG-FUEL', '10256600'),
  ('EXP-LOG-VEHREP', '10256200'),
  ('EXP-OPR-CLEAN', '10255100'),
  ('EXP-OPR-ELEC', '10251300'),
  ('EXP-OPR-FUEL', '10256600'),
  ('EXP-OPR-INET', '10254200'),
  ('EXP-OPR-MAINT', '10256200'),
  ('EXP-OPR-REPAIR', '10256200'),
  ('EXP-OPR-TEL', '10254100'),
  ('EXP-OPR-TRANSP', '10254800'),
  ('EXP-OPR-WATER', '10254700'),
  ('EXP-SM-ADVERT', '10253900'),
  ('EXP-SM-PROMO', '10253900'),
  ('EXP-SM-CUSTVISIT', '10253800'),
  ('EXP-SM-MATERIALS', '10253910'),
  ('EXP-STAFF-ALLOW', '10254900'),
  ('EXP-STAFF-MEALS', '10255800'),
  ('EXP-STAFF-TRAIN', '10253600'),
  ('EXP-STAFF-TRANSP', '10254800'),
  ('EXP-STAFF-WELFARE', '10255800')
) AS m(code, gl_code)
JOIN chart_of_accounts a ON a.code = m.gl_code
WHERE ec.code = m.code
  AND a.company_id = ec.company_id
  AND ec.account_id IS DISTINCT FROM a.id;

UPDATE taxes t
SET account_id = a.id
FROM chart_of_accounts a
WHERE a.company_id = t.company_id
  AND a.code = '10121700'
  AND t.code = 'VAT18'
  AND t.account_id IS DISTINCT FROM a.id;

INSERT INTO payroll_gl_mappings (
  company_id, tenant_id, mapping_role, debit_account_id, credit_account_id, is_default, effective_from
)
SELECT c.id, c.tenant_id, r.role, a.id, a.id, true, DATE '2026-01-01'
FROM companies c
JOIN (VALUES
  ('EARNING_EXPENSE', '10254500'),
  ('EMPLOYER_NSSF_EXPENSE', '10254500'),
  ('EMPLOYER_PENSION_EXPENSE', '10254500'),
  ('PAYE_PAYABLE', '10121400'),
  ('NSSF_PAYABLE', '10121300'),
  ('LST_PAYABLE', '10121300'),
  ('STAFF_RECOVERIES', '10111700'),
  ('NET_PAY', '10111300')
) AS r(role, gl_code) ON true
JOIN chart_of_accounts a ON a.company_id = c.id AND a.code = r.gl_code
WHERE NOT EXISTS (
  SELECT 1 FROM payroll_gl_mappings m
  WHERE m.company_id = c.id
    AND m.mapping_role = r.role
    AND m.payroll_group_id IS NULL
);

UPDATE elimination_entries e
SET account_code = m.new_code
FROM coa_code_map m
WHERE e.account_code = m.old_code
  AND e.account_code IS DISTINCT FROM m.new_code;

UPDATE chart_of_accounts
SET parent_id = NULL
WHERE code = ANY(ARRAY['1000', '1100', '1110', '1120', '1200', '1310', '1320', '1330', '1400', '1405', '1500', '1510', '1600', '1610', '1620', '1690', '2100', '2105', '2110', '2115', '2120', '2200', '2210', '3000', '3100', '4000', '4100', '4190', '5000', '5100', '6100', '6200', '6300', '6400', '6500', '6590', '1300', '2000', '6000'])
   OR parent_id IN (SELECT id FROM chart_of_accounts WHERE code = ANY(ARRAY['1000', '1100', '1110', '1120', '1200', '1310', '1320', '1330', '1400', '1405', '1500', '1510', '1600', '1610', '1620', '1690', '2100', '2105', '2110', '2115', '2120', '2200', '2210', '3000', '3100', '4000', '4100', '4190', '5000', '5100', '6100', '6200', '6300', '6400', '6500', '6590', '1300', '2000', '6000']));

DELETE FROM chart_of_accounts
WHERE code = ANY(ARRAY['1000', '1100', '1110', '1120', '1200', '1310', '1320', '1330', '1400', '1405', '1500', '1510', '1600', '1610', '1620', '1690', '2100', '2105', '2110', '2115', '2120', '2200', '2210', '3000', '3100', '4000', '4100', '4190', '5000', '5100', '6100', '6200', '6300', '6400', '6500', '6590', '1300', '2000', '6000']);

DO $$
DECLARE
  debit_before numeric;
  credit_before numeric;
  lines_before bigint;
  debit_after numeric;
  credit_after numeric;
  lines_after bigint;
  missing int;
  leftover int;
  bad_parents int;
BEGIN
  SELECT debit, credit, lines INTO debit_before, credit_before, lines_before FROM hope_tb_before;
  SELECT COALESCE(sum(debit), 0), COALESCE(sum(credit), 0), count(*)
    INTO debit_after, credit_after, lines_after
  FROM journal_lines;
  IF debit_after <> debit_before OR credit_after <> credit_before OR lines_after <> lines_before THEN
    RAISE EXCEPTION 'chart cutover changed journal totals (debit % -> %, credit % -> %, lines % -> %)',
      debit_before, debit_after, credit_before, credit_after, lines_before, lines_after;
  END IF;
  IF debit_after <> credit_after THEN
    RAISE EXCEPTION 'trial balance does not balance after chart cutover (debit %, credit %)', debit_after, credit_after;
  END IF;

  SELECT count(*) INTO missing
  FROM companies c
  CROSS JOIN (VALUES ('10110000'), ('10111000'), ('10111100'), ('10111200'), ('10111300'), ('10111400'), ('10111500'), ('10111600'), ('10111700'), ('10111800'), ('10111900'), ('10112000'), ('10112100'), ('10112200'), ('10112300'), ('10112400'), ('10112500'), ('10112600'), ('10112700'), ('10112800'), ('10112900'), ('10112910'), ('10112920'), ('10112925'), ('10112930'), ('10120000'), ('10121100'), ('10121200'), ('10121300'), ('10121400'), ('10121500'), ('10121600'), ('10121700'), ('10121800'), ('10122100'), ('10122200'), ('10130000'), ('10131100'), ('10131200'), ('10132100'), ('10132300'), ('10132400'), ('10132500'), ('10240000'), ('10241200'), ('10241300'), ('10241400'), ('10242100'), ('10242200'), ('10250000'), ('10251000'), ('10251100'), ('10251200'), ('10251300'), ('10251400'), ('10251410'), ('10251420'), ('10251500'), ('10251600'), ('10251700'), ('10251800'), ('10251810'), ('10252000'), ('10252100'), ('10252200'), ('10252300'), ('10252400'), ('10253000'), ('10253100'), ('10253200'), ('10253300'), ('10253400'), ('10253500'), ('10253600'), ('10253700'), ('10253800'), ('10253900'), ('10253910'), ('10254000'), ('10254100'), ('10254200'), ('10254300'), ('10254400'), ('10254500'), ('10254600'), ('10254700'), ('10254800'), ('10254900'), ('10255000'), ('10255100'), ('10255200'), ('10255300'), ('10255400'), ('10255500'), ('10255600'), ('10255700'), ('10255800'), ('10255900'), ('10256000'), ('10256100'), ('10256200'), ('10256300'), ('10256400'), ('10256500'), ('10256600'), ('10256700'), ('10256800'), ('10256900'), ('10257000'), ('10257100'), ('10257200'), ('10257300'), ('10257400'), ('10257500'), ('10257600'), ('10257700')) AS v(code)
  LEFT JOIN chart_of_accounts a ON a.company_id = c.id AND a.code = v.code
  WHERE a.id IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION 'Hope Design chart is missing % account row(s)', missing;
  END IF;

  SELECT count(*) INTO leftover
  FROM chart_of_accounts
  WHERE code = ANY(ARRAY['1000', '1100', '1110', '1120', '1200', '1310', '1320', '1330', '1400', '1405', '1500', '1510', '1600', '1610', '1620', '1690', '2100', '2105', '2110', '2115', '2120', '2200', '2210', '3000', '3100', '4000', '4100', '4190', '5000', '5100', '6100', '6200', '6300', '6400', '6500', '6590', '1300', '2000', '6000']);
  IF leftover > 0 THEN
    RAISE EXCEPTION 'legacy chart codes still present (% row(s))', leftover;
  END IF;

  SELECT count(*) INTO bad_parents
  FROM chart_of_accounts child
  LEFT JOIN chart_of_accounts parent ON parent.id = child.parent_id
  WHERE child.code = ANY(ARRAY['10110000', '10111000', '10111100', '10111200', '10111300', '10111400', '10111500', '10111600', '10111700', '10111800', '10111900', '10112000', '10112100', '10112200', '10112300', '10112400', '10112500', '10112600', '10112700', '10112800', '10112900', '10112910', '10112920', '10112925', '10112930', '10120000', '10121100', '10121200', '10121300', '10121400', '10121500', '10121600', '10121700', '10121800', '10122100', '10122200', '10130000', '10131100', '10131200', '10132100', '10132300', '10132400', '10132500', '10240000', '10241200', '10241300', '10241400', '10242100', '10242200', '10250000', '10251000', '10251100', '10251200', '10251300', '10251400', '10251410', '10251420', '10251500', '10251600', '10251700', '10251800', '10251810', '10252000', '10252100', '10252200', '10252300', '10252400', '10253000', '10253100', '10253200', '10253300', '10253400', '10253500', '10253600', '10253700', '10253800', '10253900', '10253910', '10254000', '10254100', '10254200', '10254300', '10254400', '10254500', '10254600', '10254700', '10254800', '10254900', '10255000', '10255100', '10255200', '10255300', '10255400', '10255500', '10255600', '10255700', '10255800', '10255900', '10256000', '10256100', '10256200', '10256300', '10256400', '10256500', '10256600', '10256700', '10256800', '10256900', '10257000', '10257100', '10257200', '10257300', '10257400', '10257500', '10257600', '10257700'])
    AND (
      (child.parent_id IS NOT NULL AND parent.id IS NULL)
      OR (parent.id IS NOT NULL AND parent.company_id <> child.company_id)
      OR (parent.id IS NOT NULL AND parent.is_posting)
    );
  IF bad_parents > 0 THEN
    RAISE EXCEPTION 'Hope Design chart has % bad parent link(s)', bad_parents;
  END IF;
END $$;

COMMIT;
