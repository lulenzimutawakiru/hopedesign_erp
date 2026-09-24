-- 0186_attendance_summary_email.sql
--
-- Seed: the daily attendance summary email.
--
-- HOPE DESIGN''s attendance terminal feeds attendance_records, but nothing ever
-- pushed that data to the people who act on it. HR, the Operations Manager and
-- the Managing Director had to open the ERP to notice an absence, a late
-- arrival or a shift that was never closed. This job renders the day''s
-- attendance as a branded PDF and mails it to those three roles every evening.
--
-- TIMEZONE - READ BEFORE CHANGING run_time.
--   The scheduler derives the next run from run_time with Date.setHours, which
--   reads the server clock, and every application container runs in UTC. The
--   cron_jobs.timezone column is stored ('Africa/Kampala') but the scheduler
--   does not apply it. So a 16:30 run_time fires at 16:30 UTC, which is 19:30
--   in Kampala. The value below is written that way on purpose: the number is
--   UTC, the intent is 7:30 pm Uganda time. Change it and you move the send.
--
-- The seed is tenant-scoped to HOPE DESIGN and guarded with NOT EXISTS, so
-- re-running it is a no-op and an administrator''s later edit is never
-- overwritten.
--
-- Recipients come from role codes at send time (params.notify_roles), not fixed
-- addresses, so the summary follows whoever holds the role. The handler
-- de-duplicates by mailbox, because one person can hold more than one of them.

-- ------------------------------------------------------------
-- Seed: the daily attendance summary email
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
  ('CRON-ATTENDANCE-SUMMARY','Daily Attendance Summary','Every evening, mails a branded PDF attendance summary for the Kampala workday to HR, the Operations Manager and the Managing Director. Fires at 19:30 Kampala time; read the note in this file before changing run_time.','ATTENDANCE_SUMMARY_EMAIL','DAILY','16:30',NULL,NULL,NULL,'{"notify_roles":["hr_manager","operations_manager","managing_director"]}','Africa/Kampala')
) AS v(code, name, description, job_type, schedule_type, run_time, day_of_week, day_of_month,
       interval_minutes, params, timezone)
WHERE NOT EXISTS (SELECT 1 FROM cron_jobs j WHERE j.tenant_id = t.id AND j.code = v.code);