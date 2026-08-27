-- ============================================================
-- 0015 - Healthcare hardening
-- Fixes three latent bugs blocking the healthcare ops flows:
--   1. healthcare_bills.status CHECK lacks APPROVED/CONFIRMED
--      (postBill requires one of them before posting to GL).
--   2. prescription_items has no updated_at column (dispensing
--      SQL updates it).
--   3. journal_entries.journal_type CHECK lacks HEALTHCARE_BILL
--      (postBill posts GL with journalType HEALTHCARE_BILL).
-- ============================================================

-- 1. Extend healthcare_bills status
ALTER TABLE healthcare_bills DROP CONSTRAINT IF EXISTS healthcare_bills_status_check;
ALTER TABLE healthcare_bills ADD CONSTRAINT healthcare_bills_status_check
  CHECK (status IN ('DRAFT','PENDING','APPROVED','CONFIRMED','POSTED','PARTIALLY_PAID','PAID','VOID'));

-- 2. Add updated_at to prescription_items
ALTER TABLE prescription_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- 3. Extend journal_entries.journal_type
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_journal_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_journal_type_check
  CHECK (journal_type IN (
    'MANUAL','OPENING','SALES_INVOICE','CUSTOMER_RECEIPT','CREDIT_NOTE',
    'PURCHASE_INVOICE','SUPPLIER_PAYMENT','GRN_RECEIPT','PRODUCTION',
    'INVENTORY_ADJUSTMENT','EXPENSE','PAYROLL','ASSET','BANK','TAX','TRANSFER',
    'HEALTHCARE_BILL'));