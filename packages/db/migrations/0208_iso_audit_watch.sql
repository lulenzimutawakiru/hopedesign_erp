-- ===========================================================================
-- 0208 - Watch the audit log and raise a security event.
--
-- A.8.16 stays unimplemented while sensitive audit rows can pass with nobody
-- told. This job reads the last twenty minutes of deletes, revokes, disables
-- and disposal approvals and opens one security event per row.
--
-- No BEGIN/COMMIT and no schema_migrations row. migrate.js owns both.
-- ===========================================================================

INSERT INTO cron_jobs (tenant_id, company_id, branch_id, code, name, description, job_type,
                       schedule_type, run_time, day_of_week, day_of_month, interval_minutes,
                       params, enabled, timezone, next_run_at)
SELECT t.id, c.id, NULL::bigint,
       'CRON-AUDIT-WATCH',
       'Audit log watch',
       'Every 15 minutes, opens a security event for a recent delete, revoke, disable or disposal approval that has not already been alerted.',
       'AUDIT_LOG_WATCH',
       'INTERVAL', NULL, NULL, NULL, 15, '{}'::jsonb, true, 'Africa/Kampala', now()
  FROM tenants t
  JOIN companies c ON c.tenant_id = t.id AND c.code = 'HDG'
 WHERE NOT EXISTS (
   SELECT 1 FROM cron_jobs j WHERE j.tenant_id = t.id AND j.code = 'CRON-AUDIT-WATCH'
 );
