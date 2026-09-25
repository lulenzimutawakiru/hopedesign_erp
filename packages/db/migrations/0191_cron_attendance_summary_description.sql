-- 0191_cron_attendance_summary_description.sql
-- Tell the operator where to change the attendance-summary schedule, not a file.
--
-- 0186 seeded CRON-ATTENDANCE-SUMMARY with a description whose last sentence
-- told the reader to go and find a comment in the seed file before touching
-- run_time. That was good advice when the schedule was unreachable from the
-- product, but the Communication -> Cron Jobs editor now owns the value: it
-- shows run_time as the job's own local wall clock in the job's own time zone,
-- converts on save, and lets the recipient roles be picked from a list. The old
-- pointer at a file is now misleading, so it is replaced with the route an
-- operator actually takes.
--
-- Only the description changes. run_time is deliberately untouched: the row
-- already stores 16:30 against a timezone of Africa/Kampala, which the editor
-- presents as 19:30, so there is nothing to migrate. Do not "correct" it here.
--
-- Scoped by code and idempotent: the UPDATE matches the job's current text, so
-- a re-run is a no-op and an administrator's later edit is never overwritten.

BEGIN;

UPDATE cron_jobs
   SET description = 'Every evening, mails a branded PDF attendance summary for the Kampala workday to HR, the Operations Manager and the Managing Director. Edit it under Communication, Cron Jobs: Run time is the local clock in the job''s time zone, and Notify roles lists the recipients.'
 WHERE code = 'CRON-ATTENDANCE-SUMMARY'
   AND description = 'Every evening, mails a branded PDF attendance summary for the Kampala workday to HR, the Operations Manager and the Managing Director. Fires at 19:30 Kampala time; read the note in this file before changing run_time.';

COMMIT;