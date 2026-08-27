-- ============================================================
-- 0091 Sales document chain: receipt allocations, debit notes
-- Packing list / POD are print layouts of delivery_notes (no extra tables).
-- ============================================================

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS unallocated_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS description TEXT;

CREATE TABLE receipt_allocations (
  id BIGSERIAL PRIMARY KEY,
  receipt_id BIGINT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  invoice_id BIGINT NOT NULL REFERENCES customer_invoices(id),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (receipt_id, invoice_id)
);
CREATE INDEX idx_receipt_allocations_invoice ON receipt_allocations(invoice_id);

ALTER TABLE receipt_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON receipt_allocations
  USING (receipt_id IN (SELECT id FROM receipts));

CREATE TABLE debit_notes (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  debit_no TEXT NOT NULL,
  invoice_id BIGINT REFERENCES customer_invoices(id),
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  debit_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  reason_code TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (reason_code IN ('UNDERBILLING','ADDITIONAL_CHARGES','PRICE_CORRECTION','FREIGHT','TAX','OTHER')),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','POSTED','VOID','REJECTED')),
  gl_posted BOOLEAN NOT NULL DEFAULT false,
  gl_journal_id BIGINT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  UNIQUE (company_id, debit_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_debit_notes_customer ON debit_notes(customer_id, status);

ALTER TABLE debit_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON debit_notes USING (tenant_id = app_tenant_id());

ALTER TABLE credit_notes
  ADD COLUMN IF NOT EXISTS reason_code TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'credit_notes_reason_code_check'
  ) THEN
    ALTER TABLE credit_notes
      ADD CONSTRAINT credit_notes_reason_code_check
      CHECK (reason_code IS NULL OR reason_code IN (
        'RETURNED_GOODS','PRICING_CORRECTION','OVERBILLING','DAMAGED_GOODS',
        'QUANTITY_CORRECTION','DISCOUNT','TAX_CORRECTION','CANCELLATION','OTHER'
      ));
  END IF;
END $$;

ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_journal_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_journal_type_check
  CHECK (journal_type IN (
    'MANUAL','OPENING','SALES_INVOICE','CUSTOMER_RECEIPT','CREDIT_NOTE','DEBIT_NOTE',
    'PURCHASE_INVOICE','SUPPLIER_PAYMENT','GRN_RECEIPT','PRODUCTION',
    'INVENTORY_ADJUSTMENT','EXPENSE','PAYROLL','ASSET','BANK','TAX','TRANSFER',
    'HEALTHCARE_BILL','CASH_ADVANCE','ADVANCE_SETTLEMENT',
    'REVERSAL','FX_REVALUATION','ACCRUAL','DEFERRAL','ALLOCATION',
    'INTERCOMPANY','CONSOLIDATION','PRODUCTION_COSTING','ASSET_DEPRECIATION',
    'BUDGET_ENCUMBRANCE','PERIOD_CLOSE'));

INSERT INTO workflows (company_id, tenant_id, code, name, entity_type, description, config, is_active)
SELECT c.id, c.tenant_id, 'WF-DNM', 'Debit Note Approval', 'sales.debit_notes',
       'Debit notes require Finance Manager then CFO approval, matching credit notes.',
       '[{"seq":1,"name":"Finance Manager Approval","approver_role":"finance_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"CFO Approval","approver_role":"cfo","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb,
       true
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM workflows w WHERE w.company_id = c.id AND w.code = 'WF-DNM');
