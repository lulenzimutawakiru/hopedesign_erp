-- Receipt OCR writes expense_receipts and expects updated_at, but the table
-- was created without that column. The missing column aborted the upload
-- transaction, so the receipt never stuck and the expense was not submitted.
-- The touch trigger keeps the column current. migrate.js owns the transaction.

ALTER TABLE expense_receipts
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_set_updated_at' AND tgrelid = to_regclass('public.expense_receipts')
  ) THEN
    CREATE TRIGGER trg_set_updated_at
      BEFORE UPDATE ON public.expense_receipts
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
