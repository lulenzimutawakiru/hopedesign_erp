-- Odoo Expenses completeness: category guideline, unit, sales price and
-- reinvoice policy; payslip flag; posting date; customer invoice link.
-- Additive. migrate.js owns the transaction and schema_migrations.

ALTER TABLE expense_categories
  ADD COLUMN IF NOT EXISTS guideline TEXT,
  ADD COLUMN IF NOT EXISTS uom_id BIGINT REFERENCES units(id),
  ADD COLUMN IF NOT EXISTS sales_price NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS sales_tax_id BIGINT REFERENCES taxes(id),
  ADD COLUMN IF NOT EXISTS reinvoice_mode TEXT NOT NULL DEFAULT 'none';

DO $$ BEGIN
  ALTER TABLE expense_categories
    ADD CONSTRAINT expense_categories_reinvoice_mode_check
    CHECK (reinvoice_mode IN ('none', 'at_cost', 'sales_price'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

UPDATE expense_categories
   SET reinvoice_mode = 'at_cost'
 WHERE reinvoice = true AND reinvoice_mode = 'none';

ALTER TABLE expense_transactions
  ADD COLUMN IF NOT EXISTS sales_price NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS payslip_reimburse BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payslip_reported_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payslip_reported_by BIGINT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS accounting_date DATE,
  ADD COLUMN IF NOT EXISTS journal_type TEXT,
  ADD COLUMN IF NOT EXISTS customer_invoice_id BIGINT REFERENCES customer_invoices(id);

CREATE INDEX IF NOT EXISTS idx_exp_tx_payslip
  ON expense_transactions (company_id, payslip_reimburse)
  WHERE payslip_reimburse;

CREATE INDEX IF NOT EXISTS idx_exp_tx_customer_invoice
  ON expense_transactions (customer_invoice_id);
