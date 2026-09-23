-- 0174_notification_dispatch_worker.sql
--
-- Lets the notification delivery worker see its own queue.
--
-- `notification_deliveries`, `notifications` and `users` each carry FORCE row
-- level security with the tenant_isolation policy - `tenant_id =
-- app_tenant_id()`, which is `current_setting('app.tenant_id')`. The delivery
-- worker (processNotificationDeliveries) is a background worker: it runs on a
-- timer from the API server with no request context, so `app.tenant_id` is
-- unset and row security is fail-closed. Every statement it makes - the
-- reading SELECT and all six following UPDATE/INSERT branches - therefore
-- matched zero rows.
--
-- The consequence was invisible and expensive: no queued EMAIL/SMS/WHATSAPP
-- delivery was ever dispatched. The queue only ever drained for EMAIL, and
-- only because notifyUsers() sends that copy synchronously and closes the
-- delivery row itself. Everything queued before that synchronous close-out
-- existed, and everything on SMS, accumulated forever - 1043 EMAIL and 153 SMS
-- rows were sitting QUEUED when this migration was written.
--
-- The worker legitimately is cross-tenant: it must see every tenant's queue
-- and it writes back with each row's own tenant. So:
--
--   1. `get_dispatchable_notification_deliveries` - a narrow SECURITY DEFINER
--      reader, owned by the migration/owner role (BYPASSRLS) and executable
--      only by hopedesign_app. It exposes exactly what is needed to send one
--      message - the delivery identity, its tenant, the recipient, the
--      notification copy and the user's email/phone - and nothing else. It only
--      ever returns rows already addressed to an external channel and already
--      due (QUEUED/RETRYING with no future retry time).
--
--   2. The application now runs every write in that worker with
--      `ctx = { tenantId: <row tenant> }`, so `app.tenant_id` names the row's
--      own tenant and tenant_isolation applies to the worker exactly as it does
--      to a request. The reader above is the only cross-tenant object.
--
-- Deployment premise matches 0126/0127/0128/0171: the role that runs
-- migrations owns this function and is exempt from row security (BYPASSRLS),
-- and the application role never receives BYPASSRLS.

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
   ORDER BY d.created_at ASC
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
$$;

-- Narrow execution to the least-privilege role only (owner keeps implicit
-- EXECUTE; PUBLIC is stripped so no other DB user can read the queue).
REVOKE ALL ON FUNCTION public.get_dispatchable_notification_deliveries(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dispatchable_notification_deliveries(integer) TO hopedesign_app;