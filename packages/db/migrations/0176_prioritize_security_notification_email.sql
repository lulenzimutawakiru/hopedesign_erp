-- 0176_prioritize_security_notification_email.sql
--
-- Auth and security mail goes to the front of the delivery queue.
--
-- processNotificationDeliveries reads one batch per cycle and sends it in the
-- order the reader returns. That order was strictly `created_at` - oldest
-- first, whatever the message was about - so a scheduled production nag queued
-- at 00:22 was sent ahead of a password-expiry notice queued at 05:00. Under a
-- spent provider allowance or a short cycle, the mail a person has to act on to
-- keep their account safe is the first thing starved.
--
-- Rank is a property of the notification, not of the delivery row, so it is
-- computed at read time: the reader already joins `notifications`, and keeping
-- the classification here means it also applies to rows that were queued before
-- it changed, and cannot drift out of sync with them.
--
--   0  auth / security  - credentials, sign-in, account-security mail
--   1  CRITICAL/URGENT  - the producer marked it as needing someone now
--   2  HIGH             - the producer marked it important
--   3  everything else  - the ordinary queue
--
-- Rank 0 matches on the notification *type*, not on `severity` or `priority`:
-- `system.password_expiry` carries severity INFO and priority NORMAL today, and
-- a future producer choosing those fields differently must not be able to
-- demote sign-in mail behind a work-order nag.

CREATE OR REPLACE FUNCTION public.notification_delivery_rank(p_type text, p_priority text)
RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN lower(coalesce(p_type, '')) IN (
           'system.password_expiry',
           'system.password_expiring',
           'password_expiry',
           'password_expired',
           'account_locked',
           'account.email_changed',
           'account_email_changed',
           'security_code',
           'mfa_code',
           'mfa.email_code'
         )
      OR lower(coalesce(p_type, '')) LIKE 'auth.%'
      OR lower(coalesce(p_type, '')) LIKE 'security.%'
      THEN 0
    WHEN upper(coalesce(p_priority, '')) IN ('CRITICAL', 'URGENT') THEN 1
    WHEN upper(coalesce(p_priority, '')) = 'HIGH' THEN 2
    ELSE 3
  END;
$$;

-- Same return shape, owner and SECURITY DEFINER contract as 0174; only the
-- ORDER BY changes, so this is a straight CREATE OR REPLACE. `id` is the final
-- tiebreak so equal-rank, equal-timestamp rows keep a stable order across
-- cycles.
CREATE OR REPLACE FUNCTION public.get_dispatchable_notification_deliveries(p_limit integer DEFAULT 100)
RETURNS TABLE (
  id bigint,
  tenant_id bigint,
  user_id bigint,
  channel text,
  recipient text,
  retry_count integer,
  title text,
  body text,
  action_label text,
  action_target text,
  email text,
  phone text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT d.id,
         d.tenant_id,
         d.user_id,
         d.channel,
         d.recipient,
         d.retry_count,
         n.title,
         n.body,
         n.action_label,
         n.action_target,
         u.email,
         u.phone
    FROM public.notification_deliveries d
    JOIN public.notifications n ON n.id = d.notification_id
    JOIN public.users u ON u.id = d.user_id
   WHERE d.channel IN ('EMAIL', 'SMS', 'WHATSAPP')
     AND d.status IN ('QUEUED', 'RETRYING')
     AND (d.next_retry_at IS NULL OR d.next_retry_at <= now())
   ORDER BY public.notification_delivery_rank(n.type, n.priority) ASC,
            d.created_at ASC,
            d.id ASC
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
$$;

-- Narrow execution to the least-privilege role only, exactly as 0174 did.
-- CREATE OR REPLACE preserves the existing ACL, so this re-states it for a
-- database where 0176 is the first migration to create either object.
REVOKE ALL ON FUNCTION public.get_dispatchable_notification_deliveries(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dispatchable_notification_deliveries(integer) TO hopedesign_app;

REVOKE ALL ON FUNCTION public.notification_delivery_rank(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notification_delivery_rank(text, text) TO hopedesign_app;