-- Extend journal_entries.journal_type to support staff cash advances / imprest
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_journal_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_journal_type_check
  CHECK (journal_type IN (
    'MANUAL','OPENING','SALES_INVOICE','CUSTOMER_RECEIPT','CREDIT_NOTE',
    'PURCHASE_INVOICE','SUPPLIER_PAYMENT','GRN_RECEIPT','PRODUCTION',
    'INVENTORY_ADJUSTMENT','EXPENSE','PAYROLL','ASSET','BANK','TAX','TRANSFER',
    'HEALTHCARE_BILL','CASH_ADVANCE','ADVANCE_SETTLEMENT'));
