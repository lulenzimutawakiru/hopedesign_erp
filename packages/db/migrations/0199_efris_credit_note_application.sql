-- A T110 credit note is a two-step workflow: the ERP posts an APPLICATION and
-- URA returns an application referenceNo; only after URA approval does the red
-- invoice FDN exist. Store the application reference + approval status on the
-- transaction so the fiscalization worker can poll T111 and apply the FDN.

ALTER TABLE efris_transactions
  ADD COLUMN IF NOT EXISTS application_ref_no TEXT,
  ADD COLUMN IF NOT EXISTS application_status TEXT;

CREATE INDEX IF NOT EXISTS idx_efris_credit_note_app
  ON efris_transactions (status, doc_type, application_ref_no)
  WHERE doc_type IN ('CREDIT_NOTE', 'CREDIT');
