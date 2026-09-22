-- 0175_silence_scheduled_nag_email.sql
--
-- Brings the notification rules into line with the scheduled checks.
--
-- The cron "nag" checks - stale and overdue work orders, expiring contracts,
-- due maintenance and inspections, overdue asset custody, escalated approvals -
-- notify once per matching record and re-run on their own schedule. On
-- 2026-09-21 the stale-work-order check alone queued 229 messages in a single
-- run. That family shares Resend's daily quota with the sign-in and password
-- mail, and the quota is what ran out on 2026-09-20/21, killing 41 messages
-- with `429 daily_quota_exceeded`.
--
-- cronJobs.ts now passes `channels: NAG_CHANNELS` (['IN_APP']) explicitly at
-- every one of those call sites. notifyUsers() prefers an explicit channel list
-- over the rule lookup, so that change is what actually stops the mail; this
-- migration makes the two layers agree so a later refactor cannot silently turn
-- it back on:
--
--   1. the three nag rules that still advertised EMAIL drop to in-app only;
--   2. the three nag event types that had no rule at all get one, because
--      notifyUsers() falls back to ['IN_APP','EMAIL'] when no rule matches.
--
-- Security mail is deliberately untouched: `system.password_expiry` keeps
-- ['IN_APP','EMAIL'] in code, because a user who must change their password has
-- to be told in their inbox.

-- 1. Scheduled checks whose rule still advertises EMAIL.
UPDATE notification_rules
   SET channels = '["IN_APP"]'::jsonb,
       updated_at = now()
 WHERE is_active = true
   AND event_type IN ('CONTRACT_EXPIRY', 'MAINTENANCE_DUE', 'WORK_ORDER_OVERDUE')
   AND channels @> '["EMAIL"]'::jsonb;

-- 2. Scheduled checks with no rule, which fell back to in-app *and* email.
--    Each mirrors the tenant and company of the rule it is modelled on.
INSERT INTO notification_rules
  (tenant_id, company_id, name, event_type, channels, role_codes, user_ids, is_active)
SELECT mirror.tenant_id,
       mirror.company_id,
       'Scheduled checks: in-app only (' || nag.event_type || ')',
       nag.event_type,
       '["IN_APP"]'::jsonb,
       '[]'::jsonb,
       '[]'::jsonb,
       true
  FROM (VALUES
          ('ASSET_INSPECTION_DUE',  'MAINTENANCE_DUE'),
          ('ASSET_CUSTODY_OVERDUE', 'MAINTENANCE_DUE'),
          ('APPROVAL_ESCALATED',    'APPROVAL_REQUIRED')
       ) AS nag(event_type, mirror_event_type)
  JOIN notification_rules mirror
    ON mirror.event_type = nag.mirror_event_type
   AND mirror.is_active = true
 WHERE NOT EXISTS (
   SELECT 1
     FROM notification_rules existing
    WHERE existing.event_type = nag.event_type
      AND existing.tenant_id = mirror.tenant_id
 );