-- ============================================================
-- 0084 Advanced finance accounts + posting rule account fixes
-- Adds GRNI, intercompany and FX accounts; points seeded
-- posting rules at the real GRNI account (2115).
-- ============================================================

INSERT INTO chart_of_accounts (company_id, tenant_id, code, name, account_type, is_posting, currency)
SELECT c.id, c.tenant_id, a.code, a.name, a.account_type, true, 'UGX'
FROM companies c
CROSS JOIN (VALUES
  ('2115','Goods Received Not Invoiced (GRNI)','LIABILITY'),
  ('1405','Due From Intercompany','ASSET'),
  ('2105','Due To Intercompany','LIABILITY'),
  ('4190','Foreign Exchange Gains','REVENUE'),
  ('6590','Foreign Exchange Losses','EXPENSE')
) AS a(code, name, account_type)
WHERE c.code = 'HDG'
ON CONFLICT (company_id, code) DO NOTHING;

-- Point seeded posting rules at the real GRNI account instead of the placeholder code
UPDATE posting_rules pr
SET lines = (
  SELECT jsonb_agg(
    CASE WHEN (line->>'account_code') = 'GRNI'
         THEN line || '{"account_code":"2115"}'::jsonb
         ELSE line END)
  FROM jsonb_array_elements(pr.lines) AS line
)
WHERE pr.event IN ('GOODS_RECEIPT','SUPPLIER_INVOICE');
