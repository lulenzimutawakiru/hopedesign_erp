-- Resend inbound mail: pre-tenant resolution helpers.
--
-- Resend delivers an `email.received` webhook to an unauthenticated endpoint;
-- the message itself is what tells us the tenant. Everything here therefore has
-- to run BEFORE any tenant context exists, which is exactly the case 0128 was
-- written for: the runtime role (hopedesign_app) is subject to row-level
-- security with no tenant set, and RLS with no tenant context is fail-closed.
--
-- Two narrow SECURITY DEFINER helpers, owned by the migration/owner role and
-- executable only by hopedesign_app:
--
--   mail_inbound_resolve_mailbox  maps the addresses a message was delivered to
--                                 onto the mailbox that owns them. That mailbox
--                                 is the attribution: it names the tenant, the
--                                 company and the branch the message belongs
--                                 to, and it is the mailbox the message must
--                                 land in. A message whose destination matches
--                                 no active mailbox is unattributable and is
--                                 written nowhere.
--
--   mail_inbound_record_event     stores one webhook event row, attributed or
--                                 not. email_webhook_events.tenant_id is
--                                 nullable precisely so an unattributable
--                                 delivery can still be recorded - that row is
--                                 the only trace an operator has for "the mail
--                                 arrived and never showed up", which is the
--                                 failure this pipeline exists to prevent.
--
-- Deployment premise (unchanged from 0126/0127/0128): the object owner that
-- runs migrations owns these functions and is exempt from row security
-- (superuser or BYPASSRLS); the application role never receives BYPASSRLS.

-- Resolve the destination address of an inbound message to its mailbox.
--
-- The caller passes the addresses in priority order (Resend's received_for
-- first, then the To header), and the first one that names an active mailbox
-- wins. Order matters and is deliberate: received_for is what the provider
-- actually delivered to, while the To header is what the sender typed, and the
-- two disagree whenever a message is addressed to a display name or a list.
CREATE OR REPLACE FUNCTION public.mail_inbound_resolve_mailbox(p_addresses text[])
RETURNS TABLE (
  tenant_id bigint,
  company_id bigint,
  branch_id bigint,
  mailbox_id bigint,
  mailbox_address text,
  default_classification text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT m.tenant_id, m.company_id, m.branch_id, m.id, m.address, m.default_classification
    FROM unnest(p_addresses) WITH ORDINALITY AS a(addr, ord)
    JOIN public.mailboxes m
      ON m.is_active
     AND lower(m.address) = lower(btrim(a.addr))
   ORDER BY a.ord
   LIMIT 1;
$$;

-- Record one inbound webhook event. Always callable, including for a delivery
-- that could not be attributed to a tenant (p_tenant_id NULL).
CREATE OR REPLACE FUNCTION public.mail_inbound_record_event(
  p_tenant_id bigint,
  p_event_type text,
  p_provider_message_id text,
  p_email_id bigint,
  p_recipient_email text,
  p_payload jsonb,
  p_signature_valid boolean,
  p_process_error text
)
RETURNS bigint
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.email_webhook_events
    (tenant_id, provider, event_type, provider_message_id, email_id, recipient_email,
     payload, signature_valid, processed_at, process_error)
  VALUES
    (p_tenant_id, 'RESEND', p_event_type, p_provider_message_id, p_email_id, p_recipient_email,
     COALESCE(p_payload, '{}'::jsonb), COALESCE(p_signature_valid, false), now(), p_process_error)
  RETURNING id;
$$;

-- Narrow execution to the least-privilege role only (owner keeps implicit
-- EXECUTE; PUBLIC is stripped so arbitrary DB users cannot probe mailboxes).
REVOKE ALL ON FUNCTION public.mail_inbound_resolve_mailbox(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mail_inbound_record_event(bigint, text, text, bigint, text, jsonb, boolean, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.mail_inbound_resolve_mailbox(text[]) TO hopedesign_app;
GRANT EXECUTE ON FUNCTION public.mail_inbound_record_event(bigint, text, text, bigint, text, jsonb, boolean, text) TO hopedesign_app;
