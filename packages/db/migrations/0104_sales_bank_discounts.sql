-- ============================================================
-- 0104 Sales bank details + document-level discounts
-- Bank info (name / account name / account number) defaults from
-- company settings and can be overridden per sales order/invoice.
-- Discounts can be entered as a fixed AMOUNT or a PERCENTage.
-- ============================================================

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS bank_name TEXT,
  ADD COLUMN IF NOT EXISTS bank_account_name TEXT,
  ADD COLUMN IF NOT EXISTS bank_account_number TEXT,
  ADD COLUMN IF NOT EXISTS discount_type TEXT NOT NULL DEFAULT 'PERCENT',
  ADD COLUMN IF NOT EXISTS discount_value NUMERIC(18,2) NOT NULL DEFAULT 0;

ALTER TABLE customer_invoices
  ADD COLUMN IF NOT EXISTS bank_name TEXT,
  ADD COLUMN IF NOT EXISTS bank_account_name TEXT,
  ADD COLUMN IF NOT EXISTS bank_account_number TEXT,
  ADD COLUMN IF NOT EXISTS discount_type TEXT NOT NULL DEFAULT 'PERCENT',
  ADD COLUMN IF NOT EXISTS discount_value NUMERIC(18,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sales_orders_discount_type_check'
      AND conrelid = 'sales_orders'::regclass
  ) THEN
    ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_discount_type_check
      CHECK (discount_type IN ('AMOUNT','PERCENT'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customer_invoices_discount_type_check'
      AND conrelid = 'customer_invoices'::regclass
  ) THEN
    ALTER TABLE customer_invoices ADD CONSTRAINT customer_invoices_discount_type_check
      CHECK (discount_type IN ('AMOUNT','PERCENT'));
  END IF;
END $$;

-- Seed default bank details for the demo tenant/company (idempotent)
INSERT INTO app_settings (tenant_id, company_id, category, key, value, updated_by)
SELECT 2, 2, 'general', x.key, x.value::jsonb, NULL
FROM (VALUES
  ('bank_name',             '""'),
  ('bank_account_name',     '""'),
  ('bank_account_number',   '""')
) AS x(key, value)
WHERE NOT EXISTS (
  SELECT 1 FROM app_settings s
  WHERE s.tenant_id = 2 AND s.company_id = 2
    AND s.category = 'general' AND s.key = x.key
);