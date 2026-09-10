-- ============================================================================
-- HOPE DESIGN GROUP LTD ERP
-- 0142_efris_production.sql
-- URA EFRIS production fiscalization module (spec sections 74-103).
--
-- Adds taxpayer & integration configuration, hardens efris_transactions with
-- a real claim/retry state machine (PROCESSING/REJECTED/VOIDED added),
-- append-only integration error records, RLS + audit triggers, SECURITY
-- DEFINER claim bridges for the cross-tenant background worker, and the
-- granular efris.* RBAC permission set.
--
-- Design rules honoured here:
--   * No EFRIS secret ever lives in a table column that is readable by the
--     app; configurations store credentials_ref / client_id_ref pointers to
--     environment-backed keys resolved only server-side at submit time.
--   * efris_transactions is never deleted and never silently dropped.
--   * FISCALIZED may only be set by a confirmed backend/URA response path
--     (services/efris processor); migrations only widen the status set.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. efris_taxpayers - legal entities / places of business registered for
--    fiscalization. Tenant-scoped, multi-company, multi-branch.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS efris_taxpayers (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  legal_name TEXT NOT NULL,
  trading_name TEXT,
  tin TEXT NOT NULL,
  vat_registered BOOLEAN NOT NULL DEFAULT false,
  vat_number TEXT,
  taxpayer_type TEXT NOT NULL DEFAULT 'COMPANY',
  business_sector TEXT,
  place_of_business TEXT,
  address TEXT,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  efris_status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED'
    CHECK (efris_status IN ('NOT_CONFIGURED','PENDING_REGISTRATION','REGISTERED',
      'PENDING_INTEGRATION','TESTING','ACTIVE','SUSPENDED','ERROR','DISABLED')),
  environment TEXT NOT NULL DEFAULT 'DISABLED'
    CHECK (environment IN ('DISABLED','TEST','ACTIVE')),
  credentials_ref TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  effective_from DATE,
  effective_to DATE,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, tin)
);
CREATE INDEX IF NOT EXISTS idx_efris_taxpayers_tenant_status
  ON efris_taxpayers (tenant_id, efris_status);
CREATE INDEX IF NOT EXISTS idx_efris_taxpayers_company_branch
  ON efris_taxpayers (company_id, branch_id);

-- ---------------------------------------------------------------------------
-- 2. efris_configurations - runtime integration settings per company/taxpayer.
--    mode: DISABLED (no submission), TEST (URA sandbox), ACTIVE (live).
--    Secrets are never stored here: client_id_ref/credentials_ref point to
--    env-backed keys resolved server-side only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS efris_configurations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  taxpayer_id BIGINT REFERENCES efris_taxpayers(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'DISABLED'
    CHECK (mode IN ('DISABLED','TEST','ACTIVE')),
  base_url TEXT,
  token_url TEXT,
  auth_grant_type TEXT NOT NULL DEFAULT 'client_credentials',
  client_id_ref TEXT,
  credentials_ref TEXT,
  timeout_seconds INTEGER NOT NULL DEFAULT 20,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  retry_backoff_seconds INTEGER NOT NULL DEFAULT 120,
  poll_interval_seconds INTEGER NOT NULL DEFAULT 30,
  fiscalize_sales_on_post BOOLEAN NOT NULL DEFAULT false,
  auto_submit BOOLEAN NOT NULL DEFAULT false,
  notify_on_failure BOOLEAN NOT NULL DEFAULT true,
  notify_role_codes JSONB NOT NULL DEFAULT
    '["cfo","finance_manager","chief_accountant","financial_controller","tax_officer"]'::jsonb,
  duplicate_window_seconds INTEGER NOT NULL DEFAULT 300,
  payload_mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  security_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (taxpayer_id, code)
);
CREATE INDEX IF NOT EXISTS idx_efris_configs_tenant_mode
  ON efris_configurations (tenant_id, mode, is_active);
CREATE INDEX IF NOT EXISTS idx_efris_configs_taxpayer
  ON efris_configurations (taxpayer_id);

-- ---------------------------------------------------------------------------
-- 3. Harden efris_transactions for the production claim/retry state machine.
--    Widens the status CHECK (adds PROCESSING / REJECTED / VOIDED) and adds the
--    worker columns used by the background fiscalization processor.
-- ---------------------------------------------------------------------------
ALTER TABLE efris_transactions
  ADD COLUMN IF NOT EXISTS taxpayer_id BIGINT REFERENCES efris_taxpayers(id),
  ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id),
  ADD COLUMN IF NOT EXISTS fiscal_mode TEXT NOT NULL DEFAULT 'DISABLED'
    CHECK (fiscal_mode IN ('DISABLED','TEST','ACTIVE')),
  ADD COLUMN IF NOT EXISTS request_payload JSONB,
  ADD COLUMN IF NOT EXISTS last_response JSONB,
  ADD COLUMN IF NOT EXISTS error_code TEXT,
  ADD COLUMN IF NOT EXISTS request_ref TEXT,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS requested_by BIGINT REFERENCES users(id);

ALTER TABLE efris_transactions
  DROP CONSTRAINT IF EXISTS efris_transactions_status_check;
ALTER TABLE efris_transactions
  ADD CONSTRAINT efris_transactions_status_check CHECK (status IN (
    'PENDING','QUEUED','PROCESSING','TRANSMITTED','FISCALIZED','FAILED',
    'RETRYING','REJECTED','CANCELLED','VOIDED'
  ));

DROP INDEX IF EXISTS idx_efris_status;
DROP INDEX IF EXISTS idx_efris_doc;
CREATE INDEX IF NOT EXISTS idx_efris_queue
  ON efris_transactions (tenant_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_efris_doc
  ON efris_transactions (doc_ref_type, doc_ref_id);
CREATE INDEX IF NOT EXISTS idx_efris_txn_taxpayer
  ON efris_transactions (tenant_id, taxpayer_id);
CREATE INDEX IF NOT EXISTS idx_efris_txn_idem
  ON efris_transactions (tenant_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_efris_txn_claim
  ON efris_transactions (status, claimed_at)
  WHERE status = 'PROCESSING';

-- ---------------------------------------------------------------------------
-- 4. efris_integration_errors - append-only record of every fiscalization
--    failure for the EFRIS Error Centre (view / retry / archive / escalate).
--    request_payload/response_payload may contain transactional (non-secret)
--    data; it is deliberately NOT row-audited to avoid duplicating payloads.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS efris_integration_errors (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  efris_transaction_id BIGINT REFERENCES efris_transactions(id) ON DELETE CASCADE,
  taxpayer_id BIGINT REFERENCES efris_taxpayers(id),
  config_id BIGINT REFERENCES efris_configurations(id),
  stage TEXT NOT NULL,
  error_code TEXT NOT NULL,
  error_message TEXT,
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  retry_count INTEGER NOT NULL DEFAULT 0,
  resolved BOOLEAN NOT NULL DEFAULT false,
  resolved_by BIGINT REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  resolution TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_efris_ierr_txn
  ON efris_integration_errors (efris_transaction_id);
CREATE INDEX IF NOT EXISTS idx_efris_ierr_open
  ON efris_integration_errors (tenant_id, resolved, created_at DESC);
-- ---------------------------------------------------------------------------
-- 5. RLS isolation + triggers for the new governance tables.
--    Mirrors the hikvision (0135) sweep: tenant_isolation policy using the app
--    tenant context; updated_at maintenance on mutable tables; row audit on the
--    configuration tables (integration_errors excluded to avoid duplicating
--    request/response payloads into the generic audit log).
-- ---------------------------------------------------------------------------
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'efris_taxpayers','efris_configurations','efris_integration_errors'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'tenant_isolation') THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id())', t);
    END IF;
  END LOOP;
END $$;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'efris_taxpayers','efris_configurations'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_set_updated_at' AND tgrelid = to_regclass(t)) THEN
      EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit' AND tgrelid = to_regclass(t)) THEN
      EXECUTE format('CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
    END IF;
  END LOOP;
END $$;
-- ---------------------------------------------------------------------------
-- 6. SECURITY DEFINER claim bridge for the cross-tenant background worker.
--    efris_claim_fiscal_batch() re-queues stale PROCESSING claims, then claims
--    a batch of due PENDING/QUEUED/RETRYING/FAILED transactions that have an
--    active TEST/ACTIVE configuration, marking them PROCESSING and returning
--    the configuration context needed by the worker. The worker resolves
--    credentials server-side from client_id_ref/credentials_ref only.
-- ---------------------------------------------------------------------------
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
  UPDATE efris_transactions
     SET status = 'QUEUED',
         claimed_at = NULL,
         next_attempt_at = now(),
         updated_at = now()
   WHERE status = 'PROCESSING'
     AND claimed_at IS NOT NULL
     AND claimed_at < now() - make_interval(secs => p_stale_seconds);

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
    SELECT c.id, c.code, c.mode, c.base_url, c.token_url, c.auth_grant_type,
           c.client_id_ref, c.credentials_ref, c.timeout_seconds,
           c.max_attempts, c.retry_backoff_seconds, c.duplicate_window_seconds
      INTO v_config_id, v_config_code, v_mode, v_base_url, v_token_url,
           v_grant_type, v_client_ref, v_cred_ref, v_timeout, v_max_attempts,
           v_backoff, v_duplicate_window
      FROM efris_configurations c
     WHERE c.id = (
           SELECT c2.id FROM efris_configurations c2
            WHERE c2.taxpayer_id = taxpayer_id
              AND c2.is_active = true
              AND c2.mode IN ('TEST','ACTIVE')
            ORDER BY c2.id DESC
            LIMIT 1
     );

    IF v_config_id IS NULL THEN
      CONTINUE; -- configuration toggled off since the outer scan: leave row.
    END IF;

    UPDATE efris_transactions
       SET status = 'PROCESSING',
           claimed_at = now(),
           attempts = attempts + 1,
           next_attempt_at = NULL,
           error_code = NULL,
           last_error = NULL,
           updated_at = now()
     WHERE efris_transactions.id = id;

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

GRANT EXECUTE ON FUNCTION public.efris_claim_fiscal_batch(INTEGER, INTEGER) TO hopedesign_app;
-- ---------------------------------------------------------------------------
-- 7. EFRIS permissions + role grants (spec section 95-96).
--    Every efris.* code below is mirrored in packages/db/src/catalogue.js so a
--    re-seed (reconcileRbac) reproduces the same grants from the catalogue.
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, v.module, v.resource, v.action, v.description
FROM (VALUES
  ('efris.dashboard.view','efris','dashboard','view','View the EFRIS fiscalization dashboard'),
  ('efris.transactions.view','efris','transactions','view','View EFRIS fiscal transactions'),
  ('efris.transactions.submit','efris','transactions','submit','Submit transactions for EFRIS fiscalization'),
  ('efris.transactions.retry','efris','transactions','retry','Retry failed EFRIS fiscalization'),
  ('efris.transactions.reprocess','efris','transactions','reprocess','Reprocess an EFRIS transaction'),
  ('efris.transactions.reject','efris','transactions','reject','Reject an EFRIS transaction'),
  ('efris.configuration.view','efris','configuration','view','View EFRIS taxpayer and integration configuration'),
  ('efris.configuration.manage','efris','configuration','manage','Manage EFRIS taxpayer and integration configuration'),
  ('efris.reconciliation.view','efris','reconciliation','view','View ERP vs EFRIS reconciliation'),
  ('efris.reconciliation.manage','efris','reconciliation','manage','Manage EFRIS reconciliation'),
  ('efris.credit_notes.view','efris','credit_notes','view','View EFRIS fiscal credit notes'),
  ('efris.credit_notes.create','efris','credit_notes','create','Create EFRIS fiscal credit notes'),
  ('efris.credit_notes.approve','efris','credit_notes','approve','Approve EFRIS fiscal credit notes'),
  ('efris.debit_notes.view','efris','debit_notes','view','View EFRIS fiscal debit notes'),
  ('efris.debit_notes.create','efris','debit_notes','create','Create EFRIS fiscal debit notes'),
  ('efris.debit_notes.approve','efris','debit_notes','approve','Approve EFRIS fiscal debit notes'),
  ('efris.reports.view','efris','reports','view','View EFRIS fiscal reports'),
  ('efris.reports.export','efris','reports','export','Export EFRIS fiscal reports'),
  ('efris.errors.view','efris','errors','view','View EFRIS integration errors'),
  ('efris.errors.retry','efris','errors','retry','Retry EFRIS integration errors'),
  ('efris.errors.archive','efris','errors','archive','Archive EFRIS integration errors')
) AS v(code, module, resource, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

-- Full EFRIS scope: super/executive and finance-director roles.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code LIKE 'efris.%'
WHERE r.code IN (
  'super_administrator','ceo','managing_director','executive_director',
  'general_manager','cfo','finance_manager','chief_accountant','financial_controller'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- System/integration administrators: configuration managers + transaction ops.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'efris.dashboard.view','efris.transactions.view','efris.transactions.retry',
  'efris.transactions.reprocess','efris.transactions.reject',
  'efris.configuration.view','efris.configuration.manage',
  'efris.reconciliation.view','efris.errors.view','efris.errors.retry',
  'efris.reports.view'
)
WHERE r.code IN ('system_administrator','integration_administrator')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Security administrator: monitor/read scope only.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'efris.dashboard.view','efris.transactions.view','efris.configuration.view',
  'efris.reconciliation.view','efris.errors.view','efris.reports.view'
)
WHERE r.code = 'security_administrator'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Accountant: prepare/submit/retry + reports + credit/debit creation. No config.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'efris.dashboard.view','efris.transactions.view','efris.transactions.submit',
  'efris.transactions.retry','efris.transactions.reprocess',
  'efris.reconciliation.view','efris.credit_notes.view','efris.credit_notes.create',
  'efris.debit_notes.view','efris.debit_notes.create',
  'efris.reports.view','efris.reports.export','efris.errors.view','efris.errors.retry'
)
WHERE r.code = 'accountant'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Tax officer: full transaction/reconciliation/report + error retry + config view.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'efris.dashboard.view','efris.transactions.view','efris.transactions.submit',
  'efris.transactions.retry','efris.transactions.reprocess',
  'efris.configuration.view','efris.reconciliation.view',
  'efris.credit_notes.view','efris.credit_notes.create',
  'efris.debit_notes.view','efris.debit_notes.create',
  'efris.reports.view','efris.reports.export','efris.errors.view','efris.errors.retry'
)
WHERE r.code = 'tax_officer'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- AR officer: transaction visibility + fiscal credit/debit note creation.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'efris.dashboard.view','efris.transactions.view','efris.reconciliation.view',
  'efris.credit_notes.view','efris.credit_notes.create',
  'efris.debit_notes.view','efris.debit_notes.create'
)
WHERE r.code = 'ar_officer'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Treasury officer: read/monitor scope.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'efris.dashboard.view','efris.transactions.view','efris.reconciliation.view',
  'efris.reports.view','efris.errors.view'
)
WHERE r.code = 'treasury_officer'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Internal auditor: read-only across the whole EFRIS surface.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'efris.dashboard.view','efris.transactions.view','efris.configuration.view',
  'efris.reconciliation.view','efris.credit_notes.view','efris.debit_notes.view',
  'efris.reports.view','efris.reports.export','efris.errors.view'
)
WHERE r.code = 'internal_auditor'
ON CONFLICT (role_id, permission_id) DO NOTHING;
