-- Credit and debit notes are queued for EFRIS with a currency and a tax
-- amount. Those columns were read by the posting path and did not exist,
-- so a posted note could not tell URA how much of the amount was VAT.
-- Defaults keep every existing note as a UGX document with no tax split.

ALTER TABLE credit_notes
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'UGX',
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0;

ALTER TABLE debit_notes
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'UGX',
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0;
