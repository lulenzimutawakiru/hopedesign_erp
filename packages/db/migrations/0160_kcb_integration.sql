-- ============================================================================
-- 0160 - KCB bank integration (inbound payment notifications)
--
-- Scope of this migration: the inbound leg. KCB pushes payment notifications
-- (account credits and till / paybill receipts) to us, we verify the message
-- signature, land it, and post it to the bank ledger. The outbound leg
-- (FundsTransferAPIService, POST /api/v1/transfer) is deliberately NOT wired
-- up here: it needs KCB onboarding credentials and a real gateway host, and
-- the 12-character transactionReference limit has to be reconciled with our
-- numbering before it can be trusted with money.
--
-- Configuration contract. The integration row lives in `company_integrations`
-- exactly as every other provider does - no new settings table:
--
--   category = 'payments', code = 'KCB', status in the usual four states
--   config   = { environment: 'SANDBOX'|'PRODUCTION',
--                country: 'KE'|'UG'|..., currency: 'KES'|'UGX'|'USD'|...,
--                bank_account_id: <bank_accounts.id>,
--                organization_short_code: '522533', till_number: '...',
--                gateway_base_url: 'https://...',
--                kcb_public_key: <PEM used to verify the Signature header> }
--   secrets  = { kcb_private_key: <encrypted PEM, outbound only>,
--                consumer_key / consumer_secret: <encrypted, outbound only> }
--
-- The verification key sits in `config`, not `secrets`, for two reasons: a
-- public key is not a secret, and it has to be readable at a point where no
-- session exists (the signature is checked before we know which tenant the
-- message belongs to). An installation that prefers to keep it out of the
-- database entirely can set KCB_IPN_PUBLIC_KEY in the environment instead;
-- both sources are tried.
--
-- Note on country/currency: KCB is a Kenyan group bank but this ERP is
-- Ugandan, and the existing cash-transfer screens reference a "KCB Dollar"
-- account. Currency and country are therefore explicit configuration, never
-- assumed - the code reads them, it does not infer them.
--
-- Security posture. The notification endpoint is unauthenticated by nature
-- (KCB is the caller) and the table carries tenant_id, so 0127 forces RLS and
-- pushes everything into a pre-session lookup. The staging and posting steps
-- are narrow SECURITY DEFINER functions owned by the migration role that is
-- exempt from row security, mirroring 0128 / 0159 exactly: search_path is
-- pinned, PUBLIC is stripped, and EXECUTE is granted only to hopedesign_app.
--
-- Authentication of the caller is the RSA signature, not the transport: the
-- `Signature` header is a SHA256withRSA signature over the raw request body
-- made with KCB's private key and verified here with KCB's public key. The
-- public key is mandatory - an unconfigured integration cannot accept a
-- notification, it fails closed.
-- ============================================================================

-- ---------- 1. Inbound notification landing table ----------
-- Every accepted notification is stored whole (payload JSONB) so a disputed
-- or unparsed field can always be re-read from the original message, and the
-- parsed columns exist for matching and reporting.
CREATE TABLE IF NOT EXISTS public.kcb_payment_notifications (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES public.tenants(id),
  company_id BIGINT NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  branch_id BIGINT REFERENCES public.branches(id),
  integration_id BIGINT REFERENCES public.company_integrations(id) ON DELETE SET NULL,
  bank_account_id BIGINT REFERENCES public.bank_accounts(id) ON DELETE SET NULL,

  notification_type TEXT NOT NULL CHECK (notification_type IN ('ACCOUNT','TILL','VALIDATION')),

  kcb_transaction_id TEXT,
  request_id TEXT,
  transaction_reference TEXT,
  customer_name TEXT,
  customer_reference TEXT,
  customer_msisdn TEXT,
  amount NUMERIC(18,2),
  currency TEXT,
  narration TEXT,
  channel_code TEXT,
  till_number TEXT,
  organization_short_code TEXT,
  credit_account_identifier TEXT,
  balance_after NUMERIC(18,2),
  transaction_at TIMESTAMPTZ,

  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  signature_verified BOOLEAN NOT NULL DEFAULT false,
  source_ip TEXT,

  status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED','POSTED','MATCHED','REJECTED')),
  reject_reason TEXT,
  bank_transaction_id BIGINT REFERENCES public.bank_transactions(id) ON DELETE SET NULL,
  matched_at TIMESTAMPTZ,
  matched_by BIGINT REFERENCES public.users(id),
  -- The invoice a payment was reconciled against. This is the link, not the
  -- posting: applying money to an invoice still moves amount_paid and the
  -- ledger, and that stays a deliberate finance action.
  matched_invoice_id BIGINT REFERENCES public.customer_invoices(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Replay defence lives in the database, not in the service: KCB retries, and
-- the same message must never become two ledger lines. Both identifiers are
-- scoped to the company so two group companies cannot shadow each other.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kcb_notifications_txn
  ON public.kcb_payment_notifications(company_id, kcb_transaction_id)
  WHERE kcb_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_kcb_notifications_request
  ON public.kcb_payment_notifications(company_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kcb_notifications_tenant_created
  ON public.kcb_payment_notifications(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kcb_notifications_account_created
  ON public.kcb_payment_notifications(bank_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kcb_notifications_company_status
  ON public.kcb_payment_notifications(company_id, status, created_at DESC);
-- "Which bank payments settle this invoice?" is the other half of
-- reconciliation, so the link is indexed from the invoice side too.
CREATE INDEX IF NOT EXISTS idx_kcb_notifications_matched_invoice
  ON public.kcb_payment_notifications(company_id, matched_invoice_id)
  WHERE matched_invoice_id IS NOT NULL;

-- ---------- 2. Row security ----------
ALTER TABLE public.kcb_payment_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kcb_payment_notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.kcb_payment_notifications;
CREATE POLICY tenant_isolation ON public.kcb_payment_notifications
  USING (tenant_id = app_tenant_id());

-- ---------- 3. Audit ----------
-- The shared audit_row() trigger, not a bespoke one: it resolves tenant and
-- company from the row itself (so it also works for the pre-session inserts),
-- strips the project's known secret columns, and keeps the action/resource
-- shape identical to every other audited table. Its record code falls back to
-- the row id because audit_row() does not know the kcb_transaction_id column,
-- so the KCB reference travels in old_values/new_values instead.
DROP TRIGGER IF EXISTS trg_kcb_notifications_audit ON public.kcb_payment_notifications;
CREATE TRIGGER trg_kcb_notifications_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.kcb_payment_notifications
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- ---------- 4. Pre-session helpers ----------
-- Resolve the destination account from the identifiers KCB actually sends,
-- then stage the message idempotently. Returns one row either way.
--
-- The caller hands in the company whose verification key accepted the message
-- as p_company_hint. That binding is a control, not a convenience: every lookup
-- below is confined to that company, so a notification signed with one
-- company's key can never resolve into another company's account.
--
-- When the account cannot be resolved the message is still stored - against the
-- hinted company - with resolved = false and reject_reason = 'UNMAPPED_ACCOUNT'
-- rather than raising. A bank feed must retain the raw message when money
-- arrives that we cannot place; that row is what an operator reconciles later.
-- Only when there is no company to attribute the message to at all (no account
-- match and no hint) is nothing written.
DROP FUNCTION IF EXISTS public.kcb_ipn_stage(text, text, text, text, text, text, text, numeric, text, text, text, text, text, text, numeric, timestamptz, jsonb, boolean, text);

CREATE OR REPLACE FUNCTION public.kcb_ipn_stage(
  p_notification_type text,
  p_kcb_transaction_id text,
  p_request_id text,
  p_transaction_reference text,
  p_customer_name text,
  p_customer_reference text,
  p_customer_msisdn text,
  p_amount numeric,
  p_currency text,
  p_narration text,
  p_channel_code text,
  p_till_number text,
  p_organization_short_code text,
  p_credit_account_identifier text,
  p_balance numeric,
  p_transaction_at timestamptz,
  p_payload jsonb,
  p_signature_verified boolean,
  p_source_ip text,
  p_company_hint bigint DEFAULT NULL
)
RETURNS TABLE (
  notification_id bigint,
  resolved boolean,
  is_duplicate boolean,
  tenant_id bigint,
  company_id bigint,
  branch_id bigint,
  integration_id bigint,
  bank_account_id bigint,
  notification_status text,
  reject_reason text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_acct public.bank_accounts;
  v_int  public.company_integrations;
  v_row  public.kcb_payment_notifications;
  v_cmp  public.companies;
  v_company_id bigint;
  v_tenant_id  bigint;
  v_unmapped boolean := false;
BEGIN
  -- (a) Preferred match: the credited account number, which is unique per
  -- company in bank_accounts and is what KCB echoes back to us.
  IF NULLIF(p_credit_account_identifier, '') IS NOT NULL THEN
    SELECT * INTO v_acct FROM public.bank_accounts ba
     WHERE ba.account_no = p_credit_account_identifier
       AND ba.is_active
       AND (p_company_hint IS NULL OR ba.company_id = p_company_hint)
     ORDER BY ba.id
     LIMIT 1;
  END IF;

  -- (b) Till / paybill flows: map the short code to the integration, then to
  -- the settlement account the administrator pinned in its config.
  IF v_acct.id IS NULL
     AND (NULLIF(p_till_number, '') IS NOT NULL OR NULLIF(p_organization_short_code, '') IS NOT NULL) THEN
    SELECT * INTO v_int FROM public.company_integrations ci
     WHERE ci.code = 'KCB'
       AND ci.is_active
       AND (p_company_hint IS NULL OR ci.company_id = p_company_hint)
       AND ((NULLIF(p_till_number, '') IS NOT NULL AND ci.config->>'till_number' = p_till_number)
         OR (NULLIF(p_organization_short_code, '') IS NOT NULL
             AND ci.config->>'organization_short_code' = p_organization_short_code))
     ORDER BY ci.id
     LIMIT 1;

    IF v_int.id IS NOT NULL THEN
      SELECT * INTO v_acct FROM public.bank_accounts ba
       WHERE ba.id = NULLIF(v_int.config->>'bank_account_id', '')::bigint
         AND ba.is_active
         AND (p_company_hint IS NULL OR ba.company_id = p_company_hint);
    END IF;
  END IF;

  -- Settle who owns the message before anything is written: a resolved account
  -- wins, otherwise the caller's verified company keeps the record.
  IF v_acct.id IS NOT NULL THEN
    v_company_id := v_acct.company_id;
    v_tenant_id  := v_acct.tenant_id;
  ELSE
    v_unmapped := true;
    IF p_company_hint IS NOT NULL THEN
      SELECT * INTO v_cmp FROM public.companies c WHERE c.id = p_company_hint;
      v_company_id := v_cmp.id;
      v_tenant_id  := v_cmp.tenant_id;
    END IF;
  END IF;

  IF v_company_id IS NULL THEN
    RETURN QUERY SELECT NULL::bigint, false, false, NULL::bigint, NULL::bigint,
                        NULL::bigint, NULL::bigint, NULL::bigint, NULL::text,
                        'UNMAPPED_ACCOUNT'::text;
    RETURN;
  END IF;

  -- (c) Complete the integration link when the short code path did not run or
  -- did not match.
  IF v_int.id IS NULL THEN
    SELECT * INTO v_int FROM public.company_integrations ci
     WHERE ci.code = 'KCB' AND ci.company_id = v_company_id
     ORDER BY ci.is_active DESC, ci.id
     LIMIT 1;
  END IF;

  -- (d) Replay defence before insert, scoped to the owning company.
  IF NULLIF(p_kcb_transaction_id, '') IS NOT NULL THEN
    SELECT * INTO v_row FROM public.kcb_payment_notifications n
     WHERE n.company_id = v_company_id
       AND n.kcb_transaction_id = p_kcb_transaction_id
     ORDER BY n.id
     LIMIT 1;
  END IF;
  IF v_row.id IS NULL AND NULLIF(p_request_id, '') IS NOT NULL THEN
    SELECT * INTO v_row FROM public.kcb_payment_notifications n
     WHERE n.company_id = v_company_id
       AND n.request_id = p_request_id
     ORDER BY n.id
     LIMIT 1;
  END IF;

  -- resolved reports whether the message landed on a real bank account, read
  -- back from the stored row so a replayed unmapped message stays unmapped.
  IF v_row.id IS NOT NULL THEN
    RETURN QUERY SELECT v_row.id, (v_row.bank_account_id IS NOT NULL), true,
                        v_row.tenant_id, v_row.company_id, v_row.branch_id,
                        v_row.integration_id, v_row.bank_account_id,
                        v_row.status, v_row.reject_reason;
    RETURN;
  END IF;

  INSERT INTO public.kcb_payment_notifications (
    tenant_id, company_id, integration_id, bank_account_id, notification_type,
    kcb_transaction_id, request_id, transaction_reference, customer_name,
    customer_reference, customer_msisdn, amount, currency, narration, channel_code,
    till_number, organization_short_code, credit_account_identifier, balance_after,
    transaction_at, payload, signature_verified, source_ip, reject_reason
  ) VALUES (
    v_tenant_id, v_company_id, v_int.id, v_acct.id, p_notification_type,
    NULLIF(p_kcb_transaction_id, ''), NULLIF(p_request_id, ''),
    NULLIF(p_transaction_reference, ''), NULLIF(p_customer_name, ''),
    NULLIF(p_customer_reference, ''), NULLIF(p_customer_msisdn, ''), p_amount,
    NULLIF(p_currency, ''), NULLIF(p_narration, ''), NULLIF(p_channel_code, ''),
    NULLIF(p_till_number, ''), NULLIF(p_organization_short_code, ''),
    NULLIF(p_credit_account_identifier, ''), p_balance, p_transaction_at,
    COALESCE(p_payload, '{}'::jsonb), COALESCE(p_signature_verified, false),
    NULLIF(p_source_ip, ''),
    CASE WHEN v_unmapped THEN 'UNMAPPED_ACCOUNT' END
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_row;

  -- A concurrent retry may have won the unique index between the check above
  -- and this insert; read back the winner rather than failing the request.
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM public.kcb_payment_notifications n
     WHERE n.company_id = v_company_id
       AND ((NULLIF(p_kcb_transaction_id, '') IS NOT NULL AND n.kcb_transaction_id = p_kcb_transaction_id)
         OR (NULLIF(p_request_id, '') IS NOT NULL AND n.request_id = p_request_id))
     ORDER BY n.id
     LIMIT 1;
    IF v_row.id IS NULL THEN
      RETURN QUERY SELECT NULL::bigint, false, false, NULL::bigint, NULL::bigint,
                          NULL::bigint, NULL::bigint, NULL::bigint, NULL::text,
                          'STAGE_CONFLICT'::text;
      RETURN;
    END IF;
    RETURN QUERY SELECT v_row.id, (v_row.bank_account_id IS NOT NULL), true,
                        v_row.tenant_id, v_row.company_id, v_row.branch_id,
                        v_row.integration_id, v_row.bank_account_id,
                        v_row.status, v_row.reject_reason;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_row.id, (v_row.bank_account_id IS NOT NULL), false,
                      v_row.tenant_id, v_row.company_id, v_row.branch_id,
                      v_row.integration_id, v_row.bank_account_id,
                      v_row.status, v_row.reject_reason;
END;
$$;

-- Post a staged notification to the bank ledger. Idempotent: a notification
-- that already carries a bank_transaction_id returns it untouched, which is
-- what makes a KCB retry safe.
CREATE OR REPLACE FUNCTION public.kcb_ipn_post_transaction(
  p_notification_id bigint,
  p_txn_date date DEFAULT NULL
)
RETURNS TABLE (bank_transaction_id bigint, already_posted boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_n  public.kcb_payment_notifications;
  v_id bigint;
BEGIN
  SELECT * INTO v_n FROM public.kcb_payment_notifications
   WHERE id = p_notification_id
   FOR UPDATE;

  IF v_n.id IS NULL THEN
    RETURN QUERY SELECT NULL::bigint, false;
    RETURN;
  END IF;

  IF v_n.bank_transaction_id IS NOT NULL THEN
    RETURN QUERY SELECT v_n.bank_transaction_id, true;
    RETURN;
  END IF;

  -- A VALIDATION leg is an authorisation check, not money: nothing to post.
  -- An unresolved account must never be posted against a null bank account.
  IF v_n.bank_account_id IS NULL OR v_n.notification_type = 'VALIDATION' THEN
    RETURN QUERY SELECT NULL::bigint, false;
    RETURN;
  END IF;

  INSERT INTO public.bank_transactions (
    bank_account_id, txn_date, reference, description, debit, credit,
    balance_after, statement_ref
  ) VALUES (
    v_n.bank_account_id,
    COALESCE(p_txn_date, (v_n.transaction_at AT TIME ZONE 'UTC')::date, v_n.created_at::date),
    COALESCE(v_n.transaction_reference, v_n.kcb_transaction_id, v_n.request_id),
    v_n.narration,
    0,
    COALESCE(v_n.amount, 0),
    v_n.balance_after,
    'KCB:' || COALESCE(v_n.kcb_transaction_id, v_n.request_id, v_n.id::text)
  )
  RETURNING id INTO v_id;

  UPDATE public.kcb_payment_notifications
     SET bank_transaction_id = v_id, status = 'POSTED', updated_at = now()
   WHERE id = v_n.id;

  RETURN QUERY SELECT v_id, false;
END;
$$;

-- Read-only companion to the staging function: resolves the same destination
-- account without writing anything. The endpoint uses it to confirm, before a
-- row is ever stored, that the company the Signature verified against is the
-- company the payload actually resolves to - a key issued for one company can
-- never be used to push a notification into another company's ledger.
CREATE OR REPLACE FUNCTION public.kcb_ipn_resolve_account(
  p_credit_account_identifier text,
  p_till_number text,
  p_organization_short_code text
)
RETURNS TABLE (
  tenant_id bigint,
  company_id bigint,
  bank_account_id bigint,
  integration_id bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH by_account AS (
    SELECT ba.tenant_id, ba.company_id, ba.id AS bank_account_id,
           NULL::bigint AS integration_id, 1 AS priority
      FROM public.bank_accounts ba
     WHERE NULLIF(p_credit_account_identifier, '') IS NOT NULL
       AND ba.account_no = p_credit_account_identifier
       AND ba.is_active
     ORDER BY ba.id
     LIMIT 1
  ), by_short_code AS (
    SELECT ba.tenant_id, ba.company_id, ba.id, ci.id, 2
      FROM public.company_integrations ci
      JOIN public.bank_accounts ba
        ON ci.config->>'bank_account_id' ~ '^[0-9]+$'
       AND ba.id = (ci.config->>'bank_account_id')::bigint
       AND ba.is_active
     WHERE ci.code = 'KCB'
       AND ci.category = 'payments'
       AND ci.is_active
       AND ((NULLIF(p_till_number, '') IS NOT NULL
             AND ci.config->>'till_number' = p_till_number)
         OR (NULLIF(p_organization_short_code, '') IS NOT NULL
             AND ci.config->>'organization_short_code' = p_organization_short_code))
     ORDER BY ci.id
     LIMIT 1
  )
  SELECT x.tenant_id, x.company_id, x.bank_account_id, x.integration_id
    FROM (SELECT * FROM by_account UNION ALL SELECT * FROM by_short_code) x
   ORDER BY x.priority
   LIMIT 1;
$$;

-- The candidate verification keys for inbound notifications. Returns only the
-- public half, only for active KCB integrations, and only where a key is
-- actually configured - an integration without a key can never accept a
-- message, which is the fail-closed posture this endpoint needs.
CREATE OR REPLACE FUNCTION public.kcb_ipn_active_keys()
RETURNS TABLE (company_id bigint, tenant_id bigint, public_key_pem text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT ci.company_id, ci.tenant_id, NULLIF(ci.config->>'kcb_public_key', '')
    FROM public.company_integrations ci
   WHERE ci.code = 'KCB'
     AND ci.category = 'payments'
     AND ci.is_active
     AND NULLIF(ci.config->>'kcb_public_key', '') IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.kcb_ipn_stage(text, text, text, text, text, text, text, numeric, text, text, text, text, text, text, numeric, timestamptz, jsonb, boolean, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kcb_ipn_post_transaction(bigint, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kcb_ipn_resolve_account(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kcb_ipn_active_keys() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.kcb_ipn_stage(text, text, text, text, text, text, text, numeric, text, text, text, text, text, text, numeric, timestamptz, jsonb, boolean, text, bigint) TO hopedesign_app;
GRANT EXECUTE ON FUNCTION public.kcb_ipn_post_transaction(bigint, date) TO hopedesign_app;
GRANT EXECUTE ON FUNCTION public.kcb_ipn_resolve_account(text, text, text) TO hopedesign_app;
GRANT EXECUTE ON FUNCTION public.kcb_ipn_active_keys() TO hopedesign_app;

-- ---------- 5. Permissions ----------
-- Mirrored in packages/db/src/catalogue.js (finance.kcb) so the catalogue and
-- the database agree, the same rule 0151 states for the Service Desk.
INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, 'finance', 'kcb', v.action, v.description
FROM (VALUES
  ('finance.kcb.view',   'view',   'View the KCB bank integration: configuration posture, signing-key state and inbound payment notifications'),
  ('finance.kcb.manage', 'manage', 'Configure the KCB bank integration, rotate the notification signing key and map the settlement bank account'),
  ('finance.kcb.test',   'test',   'Run a KCB integration connection and signature self-test')
) AS v(code, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

-- Read follows bank-account read; configure and test follow the ability to
-- reconcile bank accounts, so the people already trusted with the ledger are
-- the people trusted with its feed.
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'finance.kcb.view'
WHERE EXISTS (
  SELECT 1 FROM role_permissions rp
  JOIN permissions s ON s.id = rp.permission_id
  WHERE rp.role_id = r.id AND s.code = 'finance.banks.view'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('finance.kcb.manage', 'finance.kcb.test')
WHERE EXISTS (
  SELECT 1 FROM role_permissions rp
  JOIN permissions s ON s.id = rp.permission_id
  WHERE rp.role_id = r.id AND s.code = 'finance.banks.reconcile'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;
