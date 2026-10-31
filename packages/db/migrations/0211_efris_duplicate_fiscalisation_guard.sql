-- FIN-2 — prevent duplicate fiscalisation of the same ERP document.
--
-- Idempotency is currently keyed only on the client-supplied idempotency_key, so
-- the same (tenant, doc_ref_type, doc_ref_id) can be registered twice under two
-- different keys and fiscalised twice (two FDs from URA for one document). A
-- document is fiscalised once, so at most one "live" transaction — one that has
-- produced or will produce an FDN — may exist per document.
--
-- Terminal states are excluded so a genuine re-submission after a terminal
-- failure (FAILED/CANCELLED/VOIDED/REJECTED) can still create a fresh row; the
-- retry engine otherwise re-claims the SAME row rather than inserting a new one.

CREATE UNIQUE INDEX IF NOT EXISTS uq_efris_doc_live
  ON efris_transactions (tenant_id, doc_ref_type, doc_ref_id)
  WHERE status IN ('PENDING','QUEUED','PROCESSING','TRANSMITTED','FISCALIZED','RETRYING');
