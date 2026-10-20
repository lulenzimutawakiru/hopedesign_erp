-- ============================================================
-- 0202 Restrict destructive deletes (DB-1, DB-2, DB-3)
-- ============================================================
-- Replace ON DELETE CASCADE with ON DELETE RESTRICT so that deleting a
-- header (a journal entry, a document, an employee) can no longer silently
-- destroy its history. The application never hard-deletes these headers; it
-- voids/reverses them, so RESTRICT is the correct, safe default.

-- ---- GL history (DB-1) ------------------------------------------------
ALTER TABLE journal_lines DROP CONSTRAINT journal_lines_entry_id_fkey;
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_entry_id_fkey
  FOREIGN KEY (entry_id) REFERENCES journal_entries(id) ON DELETE RESTRICT;

-- ---- Document line items (DB-3) --------------------------------------
ALTER TABLE purchase_order_items DROP CONSTRAINT purchase_order_items_order_id_fkey;
ALTER TABLE purchase_order_items ADD CONSTRAINT purchase_order_items_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES purchase_orders(id) ON DELETE RESTRICT;

ALTER TABLE goods_receipt_items DROP CONSTRAINT goods_receipt_items_grn_id_fkey;
ALTER TABLE goods_receipt_items ADD CONSTRAINT goods_receipt_items_grn_id_fkey
  FOREIGN KEY (grn_id) REFERENCES goods_receipts(id) ON DELETE RESTRICT;

ALTER TABLE supplier_invoice_items DROP CONSTRAINT supplier_invoice_items_invoice_id_fkey;
ALTER TABLE supplier_invoice_items ADD CONSTRAINT supplier_invoice_items_invoice_id_fkey
  FOREIGN KEY (invoice_id) REFERENCES supplier_invoices(id) ON DELETE RESTRICT;

ALTER TABLE sales_order_items DROP CONSTRAINT sales_order_items_order_id_fkey;
ALTER TABLE sales_order_items ADD CONSTRAINT sales_order_items_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES sales_orders(id) ON DELETE RESTRICT;

ALTER TABLE delivery_note_items DROP CONSTRAINT delivery_note_items_delivery_note_id_fkey;
ALTER TABLE delivery_note_items ADD CONSTRAINT delivery_note_items_delivery_note_id_fkey
  FOREIGN KEY (delivery_note_id) REFERENCES delivery_notes(id) ON DELETE RESTRICT;

ALTER TABLE invoice_items DROP CONSTRAINT invoice_items_invoice_id_fkey;
ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_invoice_id_fkey
  FOREIGN KEY (invoice_id) REFERENCES customer_invoices(id) ON DELETE RESTRICT;

ALTER TABLE bank_reconciliation_matches DROP CONSTRAINT bank_reconciliation_matches_reconciliation_id_fkey;
ALTER TABLE bank_reconciliation_matches ADD CONSTRAINT bank_reconciliation_matches_reconciliation_id_fkey
  FOREIGN KEY (reconciliation_id) REFERENCES bank_reconciliations(id) ON DELETE RESTRICT;

-- ---- Employee history (DB-2) ------------------------------------------
-- Every employee_id -> employees ON DELETE CASCADE becomes RESTRICT, so
-- deleting an employee no longer wipes their payroll, attendance, contract
-- and statutory history in one statement.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname AS name,
           c.conrelid::regclass::text AS tbl,
           a.attname AS col
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f'
      AND c.confdeltype = 'c'
      AND c.confrelid::regclass::text = 'employees'
      AND a.attname = 'employee_id'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tbl, r.name);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES employees(id) ON DELETE RESTRICT',
      r.tbl, r.name, r.col);
  END LOOP;
END $$;
