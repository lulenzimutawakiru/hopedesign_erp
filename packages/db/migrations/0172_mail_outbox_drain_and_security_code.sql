-- 0172_mail_outbox_drain_and_security_code.sql
--
-- Two idempotent seeds that close the remaining mail-system gaps:
--
--   1. A recurring EMAIL_OUTBOX_DRAIN cron job. Until now `email_outbox` had no
--      automated drain: a row left behind by a provider outage stayed parked
--      until an administrator pressed retry by hand. The drain retries such a
--      row through the normal send pipeline and stops permanently once the
--      row's own `max_attempts` cap is reached, so automation can never turn a
--      poisonous message into an infinite retry loop.
--
--   2. The SECURITY_CODE email template. The one-time sign-in code was the last
--      system mail still hard-coded in the application; seeding it as a
--      template means the wording is editable by an administrator like every
--      other system message.
--
-- Both seeds are tenant-scoped to HOPE DESIGN and guarded with NOT EXISTS, so
-- re-running them is a no-op and a later edit by an administrator is never
-- overwritten.

-- ------------------------------------------------------------
-- 1. Seed: the email outbox drain
-- ------------------------------------------------------------
INSERT INTO cron_jobs (tenant_id, company_id, branch_id, code, name, description, job_type,
                       schedule_type, run_time, day_of_week, day_of_month, interval_minutes,
                       params, enabled, timezone, next_run_at)
SELECT t.id, c.id, NULL::bigint, v.code, v.name, v.description, v.job_type,
       v.schedule_type, v.run_time, v.day_of_week::smallint, v.day_of_month::smallint, v.interval_minutes::int,
       v.params::jsonb, true, v.timezone, now()
FROM tenants t
JOIN companies c ON c.tenant_id = t.id AND c.code = 'HDG'
CROSS JOIN (VALUES
  ('CRON-EMAIL-OUTBOX-DRAIN','Email Outbox Drain','Every 10 minutes, retries messages the provider left in the OUTBOX, up to each message''s max_attempts cap.','EMAIL_OUTBOX_DRAIN','INTERVAL',NULL,NULL,NULL,10,'{}','Africa/Kampala')
) AS v(code, name, description, job_type, schedule_type, run_time, day_of_week, day_of_month,
       interval_minutes, params, timezone)
WHERE NOT EXISTS (SELECT 1 FROM cron_jobs j WHERE j.tenant_id = t.id AND j.code = v.code);

-- ------------------------------------------------------------
-- 2. Seed: the sign-in verification code template (MFA-002)
-- ------------------------------------------------------------
-- {{PURPOSE}} is filled with a whole phrase ("sign in to HOPE DESIGN"), so the
-- sentence is written to read correctly once it lands. body_html is left NULL:
-- the application renders the branded HTML shell and drops the code panel in
-- itself, which plain text cannot express.
INSERT INTO email_templates (
  tenant_id, company_id, code, name, category, subject, body, variables,
  is_active, body_html, classification, scope, owner_mailbox_id,
  require_approval, description
)
SELECT t.id, c.id, v.code, v.name, v.category, v.subject,
       v.body, v.variables::jsonb, true, NULL,
       v.classification, 'SYSTEM',
       (SELECT m.id FROM mailboxes m WHERE m.tenant_id = t.id AND m.code = v.owner_mailbox),
       v.require_approval, v.description
FROM tenants t
JOIN companies c ON c.tenant_id = t.id AND c.code = 'HDG'
CROSS JOIN (VALUES
  ('SECURITY_CODE','Sign-in Verification Code','SECURITY',
   'Your HOPE DESIGN security code',
   E'Hello {{RECIPIENT_NAME}},\n\nHere is the security code needed to {{PURPOSE}}.\n\n{{CODE}}\n\nDo NOT share this code with anyone.\n\nIt expires in {{TTL_MINUTES}} minutes and can only be used once.\nIf you didn''t request this email, there''s nothing to worry about - you can safely ignore it. To keep your account secure, please don''t forward this email to anyone.\n\nHOPE DESIGN GROUP LTD',
   '["RECIPIENT_NAME","CODE","PURPOSE","TTL_MINUTES","COMPANY_NAME"]',
   'INTERNAL','MAIL-NOREPLY',false,
   'One-time sign-in verification code (MFA-002). System-owned: the application renders the live code into it.')
) AS v(code, name, category, subject, body, variables, classification,
       owner_mailbox, require_approval, description)
WHERE t.code = 'HDG'
  AND NOT EXISTS (
    SELECT 1 FROM email_templates x
    WHERE x.tenant_id = t.id AND x.code = v.code
  );