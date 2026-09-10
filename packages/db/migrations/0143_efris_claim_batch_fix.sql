-- ============================================================================
-- HOPE DESIGN GROUP LTD ERP
-- 0143_efris_claim_batch_fix.sql
-- Repairs efris_claim_fiscal_batch() introduced by 0142_efris_production.sql.
--
-- DEFECT
--   The per-row configuration lookup re-read the taxpayer with an unqualified
--   reference:
--
--       SELECT ... FROM efris_configurations c
--        WHERE c.id = (SELECT c2.id FROM efris_configurations c2
--                       WHERE c2.taxpayer_id = taxpayer_id    <-- ambiguous
--                         AND c2.is_active = true
--                         AND c2.mode IN ('TEST','ACTIVE')
--                       ORDER BY c2.id DESC LIMIT 1)
--
--   "taxpayer_id" is at once a RETURNS TABLE output column (and therefore a
--   FOR-loop target variable) and a column of c2. PL/pgSQL's default name
--   resolution (#variable_conflict error) refuses to guess, so the statement
--   failed the first time the loop body was parsed with
--   SQLSTATE 42702 'column reference "taxpayer_id" is ambiguous'.
--
-- IMPACT
--   The outer claim scan succeeded, so rows were locked FOR UPDATE SKIP LOCKED
--   and the loop was entered - but the body aborted before the PROCESSING
--   update. The background worker could therefore never claim a batch and
--   every fiscal transaction stalled at PENDING/QUEUED indefinitely.
--   No data was fabricated or lost; nothing ever reached FISCALIZED.
--
-- FIX
--   1. The function opts into #variable_conflict use_variable, which is the
--      documented PL/pgSQL resolution rule for this exact situation: an
--      unqualified name that matches both a variable and a column is read as
--      the variable.
--   2. Every column reference is then alias-qualified (r./c./c2./t.) so the
--      only unqualified fiscal names left in any SQL statement are the loop
--      variables themselves - which is precisely what use_variable resolves.
--   3. The per-row lookup is flattened into a single aliased join against the
--      claimed row instead of a nested scalar subquery, removing the scope in
--      which the ambiguity could reappear.
--   4. The claim UPDATE now increments t.attempts (explicitly the column)
--      rather than the previously unqualified attempts.
--
-- The signature, RETURNS TABLE column list, SECURITY DEFINER context,
-- search_path, stale-claim recovery and the claim/retry state-machine
-- semantics are unchanged, so the compiled worker keeps binding to the same
-- function and the same row shape.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.efris_claim_fiscal_batch(
  p_batch INTEGER DEFAULT 10,
  p_stale_seconds INTEGER DEFAULT 300
) RETURNS TABLE (
  id BIGINT, tenant_id BIGINT, company_id BIGINT, branch_id BIGINT, taxpayer_id BIGINT,
  config_id BIGINT, config_code TEXT, fiscal_mode TEXT, base_url TEXT, token_url TEXT,
  auth_grant_type TEXT, client_id_ref TEXT, credentials_ref TEXT, timeout_seconds INTEGER,
  max_attempts INTEGER, retry_backoff_seconds INTEGER, duplicate_window_seconds INTEGER,
  doc_type TEXT, doc_ref_type TEXT, doc_ref_id BIGINT, doc_ref_code TEXT,
  txn_date DATE, currency TEXT, gross_amount NUMERIC, tax_amount NUMERIC,
  attempts INTEGER, request_ref TEXT, request_payload JSONB
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_variable
DECLARE
  v_config_id BIGINT;
  v_config_code TEXT;
  v_mode TEXT;
  v_base_url TEXT;
  v_token_url TEXT;
  v_grant_type TEXT;
  v_client_ref TEXT;
  v_cred_ref TEXT;
  v_timeout INTEGER;
  v_max_attempts INTEGER;
  v_backoff INTEGER;
  v_duplicate_window INTEGER;
BEGIN
  -- Re-queue stale PROCESSING claims first (worker died mid-flight).
  UPDATE efris_transactions t
     SET status = 'QUEUED',
         claimed_at = NULL,
         next_attempt_at = now(),
         updated_at = now()
   WHERE t.status = 'PROCESSING'
     AND t.claimed_at IS NOT NULL
     AND t.claimed_at < now() - make_interval(secs => p_stale_seconds);

  -- Claim the next due batch across every tenant.
  FOR id, tenant_id, company_id, branch_id, taxpayer_id, doc_type, doc_ref_type,
      doc_ref_id, doc_ref_code, txn_date, currency, gross_amount, tax_amount,
      attempts, request_ref, request_payload IN
    SELECT r.id, r.tenant_id, r.company_id, r.branch_id, r.taxpayer_id,
           r.doc_type, r.doc_ref_type, r.doc_ref_id, r.doc_ref_code,
           r.txn_date, r.currency, r.gross_amount, r.tax_amount,
           r.attempts, r.request_ref, r.request_payload
      FROM efris_transactions r
      JOIN efris_configurations c
        ON c.id = (
             SELECT c2.id FROM efris_configurations c2
              WHERE c2.taxpayer_id = r.taxpayer_id
                AND c2.is_active = true
                AND c2.mode IN ('TEST','ACTIVE')
              ORDER BY c2.id DESC
              LIMIT 1
           )
     WHERE r.taxpayer_id IS NOT NULL
       AND r.fiscal_mode IN ('TEST','ACTIVE')
       AND r.status IN ('PENDING','QUEUED','RETRYING','FAILED')
       AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= now())
     ORDER BY r.created_at
     LIMIT p_batch
     FOR UPDATE OF r SKIP LOCKED
  LOOP
    -- Re-read the live configuration for the row just claimed. Every column is
    -- alias-qualified; the only unqualified fiscal name is the loop variable
    -- id, which #variable_conflict use_variable resolves to the variable.
    SELECT c.id, c.code, c.mode, c.base_url, c.token_url, c.auth_grant_type,
           c.client_id_ref, c.credentials_ref, c.timeout_seconds,
           c.max_attempts, c.retry_backoff_seconds, c.duplicate_window_seconds
      INTO v_config_id, v_config_code, v_mode, v_base_url, v_token_url,
           v_grant_type, v_client_ref, v_cred_ref, v_timeout, v_max_attempts,
           v_backoff, v_duplicate_window
      FROM efris_transactions r
      JOIN efris_configurations c
        ON c.taxpayer_id = r.taxpayer_id
       AND c.is_active = true
       AND c.mode IN ('TEST','ACTIVE')
     WHERE r.id = id
     ORDER BY c.id DESC
     LIMIT 1;

    IF v_config_id IS NULL THEN
      CONTINUE; -- configuration toggled off since the outer scan: leave row.
    END IF;

    UPDATE efris_transactions t
       SET status = 'PROCESSING',
           claimed_at = now(),
           attempts = t.attempts + 1,
           next_attempt_at = NULL,
           error_code = NULL,
           last_error = NULL,
           updated_at = now()
     WHERE t.id = id;

    config_id := v_config_id;
    config_code := v_config_code;
    fiscal_mode := v_mode;
    base_url := v_base_url;
    token_url := v_token_url;
    auth_grant_type := v_grant_type;
    client_id_ref := v_client_ref;
    credentials_ref := v_cred_ref;
    timeout_seconds := v_timeout;
    max_attempts := v_max_attempts;
    retry_backoff_seconds := v_backoff;
    duplicate_window_seconds := v_duplicate_window;
    attempts := attempts + 1;
    RETURN NEXT;
  END LOOP;
  RETURN;
END;
$fn$;

-- CREATE OR REPLACE preserves the existing ACL; the grant is restated so a
-- database that reached this revision by some other path still converges.
GRANT EXECUTE ON FUNCTION public.efris_claim_fiscal_batch(INTEGER, INTEGER) TO hopedesign_app;
