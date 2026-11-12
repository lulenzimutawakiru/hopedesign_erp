-- Odoo Expenses fields: who paid, quantity pricing, reinvoice link, category price/tax.

ALTER TABLE expense_transactions
  ADD COLUMN IF NOT EXISTS payment_mode TEXT NOT NULL DEFAULT 'employee',
  ADD COLUMN IF NOT EXISTS quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS unit_price NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS customer_id BIGINT REFERENCES customers(id),
  ADD COLUMN IF NOT EXISTS sales_order_id BIGINT REFERENCES sales_orders(id);

DO $$ BEGIN
  ALTER TABLE expense_transactions
    ADD CONSTRAINT expense_transactions_payment_mode_check
    CHECK (payment_mode IN ('employee', 'company'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE expense_categories
  ADD COLUMN IF NOT EXISTS unit_price NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS tax_id BIGINT REFERENCES taxes(id),
  ADD COLUMN IF NOT EXISTS reinvoice BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_exp_tx_payment_mode ON expense_transactions(payment_mode, status);
CREATE INDEX IF NOT EXISTS idx_exp_tx_employee ON expense_transactions(employee_id);
