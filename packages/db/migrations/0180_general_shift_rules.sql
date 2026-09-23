-- 0180_general_shift_rules.sql
-- Operations manager joins the general day and can be late.
-- The managing director is not required to clock in.
-- General staff already end at 17:30; minutes after that are overtime.

INSERT INTO shifts (
  company_id, tenant_id, code, name, start_time, end_time,
  grace_minutes, break_minutes, work_hours, applies_to, status
)
SELECT s.company_id, s.tenant_id, 'OPTIONAL', 'Not required to clock in',
       '00:00'::time, '23:59'::time, 0, 0, 0, 'ALL', 'ACTIVE'
FROM shifts s
WHERE s.code = 'GENERAL'
  AND NOT EXISTS (
    SELECT 1 FROM shifts x WHERE x.company_id = s.company_id AND x.code = 'OPTIONAL'
  );

UPDATE shift_assignments sa
SET status = 'INACTIVE'
WHERE sa.status = 'ACTIVE'
  AND sa.employee_id IN (
    SELECT id FROM employees
    WHERE position ILIKE '%operations manager%'
       OR position ILIKE '%managing director%'
  );

INSERT INTO shift_assignments (company_id, tenant_id, employee_id, shift_id, effective_from, status)
SELECT e.company_id, e.tenant_id, e.id, s.id, CURRENT_DATE, 'ACTIVE'
FROM employees e
JOIN shifts s ON s.company_id = e.company_id AND s.status = 'ACTIVE'
 AND s.code = CASE
       WHEN e.position ILIKE '%managing director%' THEN 'OPTIONAL'
       WHEN e.position ILIKE '%operations manager%' THEN 'GENERAL'
     END
WHERE e.status = 'ACTIVE'
  AND (
    e.position ILIKE '%managing director%'
    OR e.position ILIKE '%operations manager%'
  )
  AND NOT EXISTS (
    SELECT 1 FROM shift_assignments sa
    WHERE sa.employee_id = e.id
      AND sa.status = 'ACTIVE'
      AND sa.effective_from <= CURRENT_DATE
      AND (sa.effective_to IS NULL OR sa.effective_to >= CURRENT_DATE)
  );

SELECT e.first_name, e.last_name, e.position, s.code, s.start_time, s.end_time
FROM employees e
JOIN shift_assignments sa ON sa.employee_id = e.id AND sa.status = 'ACTIVE'
  AND sa.effective_from <= CURRENT_DATE
  AND (sa.effective_to IS NULL OR sa.effective_to >= CURRENT_DATE)
JOIN shifts s ON s.id = sa.shift_id
WHERE e.position ILIKE '%operations manager%' OR e.position ILIKE '%managing director%';