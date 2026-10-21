-- ============================================================
-- 0197 WhatsApp: Meta Business Cloud API (send, receive, receipts) + WhatsApp OTP
-- ============================================================
-- Completes the WhatsApp channel. Previously the only sender was the Africa's
-- Talking Chat API (outbound only). This adds the Meta WhatsApp Business Cloud
-- API sender surface, an inbound + delivery-status webhook, and generalises the
-- emailed MFA sign-in code so it can also be delivered over WhatsApp.
--
-- All additive. Nothing here drops or rewrites the existing AT path.

-- ---------------------------------------------------------------------------
-- 1. Widen whatsapp_messages for two-way traffic and delivery receipts.
-- ---------------------------------------------------------------------------
ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'OUTBOUND'
    CHECK (direction IN ('INBOUND','OUTBOUND')),
  ADD COLUMN IF NOT EXISTS from_number TEXT,
  ADD COLUMN IF NOT EXISTS message_type TEXT,
  ADD COLUMN IF NOT EXISTS template_name TEXT,
  ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;

-- The Meta message id (wamid) from the send response / status callback. Not
-- unique: legacy rows and a small delivery-window race could collide, and the
-- status handler updates by id, so a plain index is the safe choice.
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_provider
  ON whatsapp_messages (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Thread lookup: everything to/from one customer number, newest first.
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_thread
  ON whatsapp_messages (tenant_id, from_number, created_at DESC)
  WHERE from_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_status
  ON whatsapp_messages (tenant_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Webhook ledger (mirrors email_webhook_events).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT REFERENCES tenants(id),
  provider TEXT NOT NULL DEFAULT 'META',
  event_type TEXT,
  provider_message_id TEXT,
  whatsapp_message_id BIGINT REFERENCES whatsapp_messages(id) ON DELETE SET NULL,
  from_number TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  signature_valid BOOLEAN NOT NULL DEFAULT false,
  processed_at TIMESTAMPTZ,
  process_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_webhook_events_msg
  ON whatsapp_webhook_events (provider_message_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_webhook_events_unprocessed
  ON whatsapp_webhook_events (processed_at) WHERE processed_at IS NULL;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['whatsapp_webhook_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'tenant_isolation') THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id())', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_set_updated_at' AND tgrelid = to_regclass(t)) THEN
      EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Pre-tenant attribution bridge (SECURITY DEFINER, same pattern as
--    0171_mail_inbound_resend.sql). The webhook arrives with no session; RLS is
--    fail-closed with no tenant set, so a narrow owner-run function resolves
--    which tenant/company owns the number before any row is written.
--
--    This deployment is single-company and the WhatsApp credentials live in
--    env vars, so the first company is the attribution. The p_display_phone
--    argument is kept so a multi-tenant deployment can later match it against
--    company_integrations.config->>'phone_number_id'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_inbound_resolve_number(p_display_phone text)
RETURNS TABLE (tenant_id bigint, company_id bigint, branch_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.tenant_id, c.id, NULL::bigint
    FROM public.companies c
   ORDER BY c.id ASC
   LIMIT 1;
$$;

-- Record one webhook event, attributed or not (p_tenant_id may be NULL).
CREATE OR REPLACE FUNCTION public.whatsapp_webhook_record_event(
  p_tenant_id bigint,
  p_event_type text,
  p_provider_message_id text,
  p_whatsapp_message_id bigint,
  p_from_number text,
  p_payload jsonb,
  p_signature_valid boolean,
  p_process_error text
)
RETURNS bigint
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.whatsapp_webhook_events
    (tenant_id, provider, event_type, provider_message_id, whatsapp_message_id,
     from_number, payload, signature_valid, processed_at, process_error)
  VALUES
    (p_tenant_id, 'META', p_event_type, p_provider_message_id, p_whatsapp_message_id,
     p_from_number, COALESCE(p_payload, '{}'::jsonb), COALESCE(p_signature_valid, false),
     now(), p_process_error)
  RETURNING id;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_inbound_resolve_number(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.whatsapp_webhook_record_event(bigint, text, text, bigint, text, jsonb, boolean, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.whatsapp_inbound_resolve_number(text) TO hopedesign_app;
GRANT EXECUTE ON FUNCTION public.whatsapp_webhook_record_event(bigint, text, text, bigint, text, jsonb, boolean, text) TO hopedesign_app;

-- ---------------------------------------------------------------------------
-- 4. WhatsApp sign-in codes: generalise mfa_email_codes across channels.
-- ---------------------------------------------------------------------------
ALTER TABLE mfa_email_codes
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'EMAIL'
    CHECK (channel IN ('EMAIL','WHATSAPP')),
  ADD COLUMN IF NOT EXISTS phone TEXT;

-- Hot path: newest still-open code for this user, per channel.
CREATE INDEX IF NOT EXISTS idx_mfa_email_codes_open_channel
  ON mfa_email_codes (user_id, purpose, channel)
  WHERE consumed_at IS NULL;
