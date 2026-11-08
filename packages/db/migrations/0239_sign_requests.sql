-- ============================================================================
-- 0239 - E-Signature: Sign Requests (Odoo Sign parity)
-- General-purpose envelope signing. A sender attaches a document and adds any
-- number of signers - internal employees (linked to a user) or external
-- contacts (email only). On send, each signer is issued an unguessable signing
-- token; only its SHA-256 digest is stored. External signers open the public
-- portal at /sign/<token>, review the document, consent and sign or refuse.
-- Signing is validated and applied inside SECURITY DEFINER functions so the
-- unauthenticated portal can never be blocked by RLS, and never reads PII it
-- was not handed by the token. Idempotent. Tenant scoped.
-- ============================================================================

CREATE SEQUENCE IF NOT EXISTS sign_request_code_seq;

CREATE TABLE IF NOT EXISTS sign_requests (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  code TEXT NOT NULL DEFAULT ('SRQ-' || to_char(now(),'YYYY') || '-' || lpad(nextval('sign_request_code_seq')::text,6,'0')),
  title TEXT NOT NULL,
  message TEXT,
  document_type TEXT NOT NULL DEFAULT 'GENERAL',
  document_code TEXT,
  file_name TEXT,
  mime_type TEXT NOT NULL DEFAULT 'application/pdf',
  file_size BIGINT,
  storage_key TEXT,
  doc_hash TEXT,
  signature_order TEXT NOT NULL DEFAULT 'ANY' CHECK (signature_order IN ('ANY','SEQUENTIAL')),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT','SENT','PARTIALLY_SIGNED','COMPLETED','REFUSED','EXPIRED','REVOKED'
  )),
  expires_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by BIGINT REFERENCES users(id),
  revoked_reason TEXT,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
CREATE INDEX IF NOT EXISTS idx_sign_requests_status ON sign_requests(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_sign_requests_created ON sign_requests(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sign_request_signers (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  sign_request_id BIGINT NOT NULL REFERENCES sign_requests(id) ON DELETE CASCADE,
  signer_type TEXT NOT NULL DEFAULT 'CONTACT' CHECK (signer_type IN ('EMPLOYEE','CONTACT')),
  signer_user_id BIGINT REFERENCES users(id),
  signer_name TEXT NOT NULL,
  signer_email TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  token_hash TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'NOT_SENT' CHECK (status IN (
    'NOT_SENT','SENT','VIEWED','SIGNED','REFUSED','EXPIRED','REVOKED'
  )),
  sent_at TIMESTAMPTZ,
  viewed_at TIMESTAMPTZ,
  signed_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  decline_reason TEXT,
  signature TEXT,
  signature_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  consent JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip TEXT,
  user_agent TEXT,
  device TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sign_request_signers_req ON sign_request_signers(sign_request_id, order_index);
CREATE INDEX IF NOT EXISTS idx_sign_request_signers_user ON sign_request_signers(signer_user_id, status);

-- ============================================================================
-- Public signing functions (SECURITY DEFINER: bypass RLS, resolve by token hash)
-- ============================================================================

-- Resolve the safe, non-PII projection a signer is entitled to from their token.
CREATE OR REPLACE FUNCTION public.sign_public_session(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER STABLE AS $$
DECLARE
  v JSONB;
BEGIN
  SELECT jsonb_build_object(
    'tenantId', s.tenant_id,
    'companyId', s.company_id,
    'requestId', s.sign_request_id,
    'signerId', s.id,
    'signerName', s.signer_name,
    'signerEmail', s.signer_email,
    'signerStatus', s.status,
    'requestStatus', r.status,
    'title', r.title,
    'message', r.message,
    'fileName', r.file_name,
    'mimeType', r.mime_type,
    'storageKey', r.storage_key,
    'signatureOrder', r.signature_order,
    'expiresAt', r.expires_at
  ) INTO v
  FROM sign_request_signers s
  JOIN sign_requests r ON r.id = s.sign_request_id
  WHERE s.token_hash = p_token_hash;
  RETURN v;
END;
$$;

-- Record the first view of the signing page. Idempotent.
CREATE OR REPLACE FUNCTION public.sign_public_mark_viewed(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_signer sign_request_signers%ROWTYPE;
BEGIN
  SELECT * INTO v_signer FROM sign_request_signers WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'INVALID_TOKEN');
  END IF;
  IF v_signer.status IN ('SENT','VIEWED') THEN
    UPDATE sign_request_signers
       SET status = 'VIEWED',
           viewed_at = COALESCE(viewed_at, now()),
           updated_at = now()
     WHERE id = v_signer.id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', 'VIEWED');
END;
$$;

-- Submit a signature + consent. Validates token, status, expiry and (for
-- SEQUENTIAL envelopes) that every earlier signer has signed. Then recomputes
-- the request status.
CREATE OR REPLACE FUNCTION public.sign_public_submit(
  p_token_hash TEXT,
  p_signature TEXT,
  p_signature_data JSONB,
  p_consent JSONB,
  p_ip TEXT,
  p_user_agent TEXT,
  p_device TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_signer RECORD;
  v_completed BOOLEAN;
BEGIN
  SELECT s.*, r.status AS req_status, r.expires_at AS req_expires, r.signature_order AS req_order
    INTO v_signer
    FROM sign_request_signers s
    JOIN sign_requests r ON r.id = s.sign_request_id
   WHERE s.token_hash = p_token_hash
     FOR UPDATE OF s, r;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'INVALID_TOKEN');
  END IF;
  IF v_signer.status IN ('SIGNED','REFUSED') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ALREADY_DECIDED', 'status', v_signer.status);
  END IF;
  IF v_signer.req_status NOT IN ('SENT','PARTIALLY_SIGNED') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'REQUEST_NOT_ACTIVE', 'requestStatus', v_signer.req_status);
  END IF;
  IF v_signer.req_expires IS NOT NULL AND v_signer.req_expires <= now() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'EXPIRED');
  END IF;
  IF v_signer.req_order = 'SEQUENTIAL' THEN
    IF EXISTS (
      SELECT 1 FROM sign_request_signers
       WHERE sign_request_id = v_signer.sign_request_id
         AND order_index < v_signer.order_index
         AND status <> 'SIGNED'
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'AWAITING_PRIOR_SIGNER');
    END IF;
  END IF;

  UPDATE sign_request_signers
     SET status = 'SIGNED',
         signed_at = now(),
         signature = COALESCE(NULLIF(p_signature, ''), signature),
         signature_data = COALESCE(p_signature_data, '{}'::jsonb),
         consent = COALESCE(p_consent, '{}'::jsonb),
         ip = COALESCE(NULLIF(p_ip, ''), ip),
         user_agent = COALESCE(NULLIF(p_user_agent, ''), user_agent),
         device = COALESCE(NULLIF(p_device, ''), device),
         viewed_at = COALESCE(viewed_at, now()),
         updated_at = now()
   WHERE id = v_signer.id;

  SELECT NOT EXISTS (
    SELECT 1 FROM sign_request_signers
     WHERE sign_request_id = v_signer.sign_request_id AND status <> 'SIGNED'
  ) INTO v_completed;

  IF v_completed THEN
    UPDATE sign_requests
       SET status = 'COMPLETED', completed_at = now(), updated_at = now()
     WHERE id = v_signer.sign_request_id;
  ELSE
    UPDATE sign_requests
       SET status = 'PARTIALLY_SIGNED', updated_at = now()
     WHERE id = v_signer.sign_request_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'status', 'SIGNED', 'completed', v_completed);
END;
$$;

-- Refuse to sign. A refusal fails the whole envelope (documented behaviour).
CREATE OR REPLACE FUNCTION public.sign_public_refuse(
  p_token_hash TEXT,
  p_reason TEXT,
  p_ip TEXT,
  p_user_agent TEXT,
  p_device TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_signer RECORD;
BEGIN
  SELECT s.*, r.status AS req_status
    INTO v_signer
    FROM sign_request_signers s
    JOIN sign_requests r ON r.id = s.sign_request_id
   WHERE s.token_hash = p_token_hash
     FOR UPDATE OF s, r;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'INVALID_TOKEN');
  END IF;
  IF v_signer.status IN ('SIGNED','REFUSED') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ALREADY_DECIDED', 'status', v_signer.status);
  END IF;
  IF v_signer.req_status NOT IN ('SENT','PARTIALLY_SIGNED') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'REQUEST_NOT_ACTIVE', 'requestStatus', v_signer.req_status);
  END IF;

  UPDATE sign_request_signers
     SET status = 'REFUSED',
         declined_at = now(),
         decline_reason = NULLIF(p_reason, ''),
         ip = COALESCE(NULLIF(p_ip, ''), ip),
         user_agent = COALESCE(NULLIF(p_user_agent, ''), user_agent),
         device = COALESCE(NULLIF(p_device, ''), device),
         viewed_at = COALESCE(viewed_at, now()),
         updated_at = now()
   WHERE id = v_signer.id;

  UPDATE sign_requests
     SET status = 'REFUSED', updated_at = now()
   WHERE id = v_signer.sign_request_id;

  RETURN jsonb_build_object('ok', true, 'status', 'REFUSED');
END;
$$;

GRANT EXECUTE ON FUNCTION public.sign_public_session(TEXT) TO hopedesign_app;
GRANT EXECUTE ON FUNCTION public.sign_public_mark_viewed(TEXT) TO hopedesign_app;
GRANT EXECUTE ON FUNCTION public.sign_public_submit(TEXT, TEXT, JSONB, JSONB, TEXT, TEXT, TEXT) TO hopedesign_app;
GRANT EXECUTE ON FUNCTION public.sign_public_refuse(TEXT, TEXT, TEXT, TEXT, TEXT) TO hopedesign_app;

-- ============================================================================
-- RLS + triggers
-- ============================================================================
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['sign_requests','sign_request_signers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I USING (tenant_id = app_tenant_id())', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_insert ON public.%I', t);
    EXECUTE format('CREATE POLICY tenant_isolation_insert ON public.%I FOR INSERT WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_isolation_update ON public.%I FOR UPDATE USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_isolation_delete ON public.%I FOR DELETE USING (tenant_id = app_tenant_id())', t);
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_set_updated_at' AND tgrelid = to_regclass(t)) THEN
      EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit' AND tgrelid = to_regclass(t)) THEN
      EXECUTE format('CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
    END IF;
  END LOOP;
END $$;
