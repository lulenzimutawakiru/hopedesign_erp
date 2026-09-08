-- ============================================================================
-- 0140 - Governance authority automatic-expiry sweep
-- Seeds a periodic background job that expires acting-authority delegations
-- and signature profiles whose end date has passed (0138/0139 provide the
-- SECURITY DEFINER expire functions; the API dispatcher handles the matching
-- GOVERNANCE_AUTHORITY_SWEEP job type in cronJobs.ts).
-- ============================================================================

INSERT INTO cron_jobs (tenant_id, company_id, branch_id, code, name, description, job_type,
                       schedule_type, run_time, day_of_week, day_of_month, interval_minutes,
                       params, enabled, timezone, next_run_at)
SELECT t.id, c.id, NULL::bigint, v.code, v.name, v.description, v.job_type,
       v.schedule_type, v.run_time, v.day_of_week::smallint, v.day_of_month::smallint, v.interval_minutes::int,
       v.params::jsonb, true, v.timezone, now()
FROM tenants t
JOIN companies c ON c.tenant_id = t.id AND c.code = 'HDG'
CROSS JOIN (VALUES
  ('CRON-GOVERNANCE','Governance Authority Expiry Sweep','Every 30 minutes, expires acting-authority delegations and signature profiles past their end date; each expiry is audited.','GOVERNANCE_AUTHORITY_SWEEP','INTERVAL',NULL,NULL,NULL,30,'{}','Africa/Kampala')
) AS v(code, name, description, job_type, schedule_type, run_time, day_of_week, day_of_month,
       interval_minutes, params, timezone)
WHERE NOT EXISTS (SELECT 1 FROM cron_jobs j WHERE j.tenant_id = t.id AND j.code = v.code);