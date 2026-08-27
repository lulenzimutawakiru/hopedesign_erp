-- Per-signatory uploaded signature images (public URL stored on the signature row).
ALTER TABLE contract_signatures ADD COLUMN IF NOT EXISTS signature_url TEXT;
