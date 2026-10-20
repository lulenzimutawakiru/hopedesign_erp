-- ============================================================
-- 0201 Inventory / finance audit coverage (INV-3, DB-10)
-- ============================================================
-- Attach the row-level audit trigger to high-value tables that were
-- previously missing it, so direct edits / deletes leave a trail.
-- `journal_lines` and `bank_transactions` carry no tenant/company columns of
-- their own; audit_row() records those as NULL (the parent row carries them),
-- but still captures who/what/when.
--
-- `product_batches` is already covered by 0013; the DROP IF EXISTS makes this
-- migration idempotent and harmless there.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'inventory','inventory_movements','inventory_layers',
    'product_batches','journal_lines','bank_transactions'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON %I
       FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP;
END $$;
