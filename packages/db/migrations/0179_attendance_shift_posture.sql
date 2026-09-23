-- 0179_attendance_shift_posture.sql
--
-- Administrative staff keep a general day, 09:00 to 17:30.
-- Production staff are expected only while the factory is producing.
-- The managing director's driver may attend any day and is not marked late.
-- Idempotent.

INSERT INTO shifts (
  company_id, tenant_id, code, name, start_time, end_time,
  grace_minutes, break_minutes, work_hours, applies_to, status
)
SELECT s.company_id, s.tenant_id, v.code, v.name,
       v.start_time::time, v.end_time::time,
       0, v.break_minutes, v.work_hours, 'ALL', 'ACTIVE'
FROM shifts s
CROSS JOIN (VALUES
  ('GENERAL', 'General shift', '09:00', '17:30', 30, 8.50),
  ('PRODUCTION', 'Production', '06:00', '18:00', 0, 8.00),
  ('DRIVER', 'Managing director driver', '00:00', '23:59', 0, 8.00)
) AS v(code, name, start_time, end_time, break_minutes, work_hours)
WHERE s.code = 'A'
  AND NOT EXISTS (
    SELECT 1 FROM shifts x WHERE x.company_id = s.company_id AND x.code = v.code
  );

-- The system administrator was on the afternoon factory shift.
UPDATE shift_assignments sa
SET status = 'INACTIVE',
    effective_to = CASE
      WHEN sa.effective_to IS NULL OR sa.effective_to >= CURRENT_DATE THEN CURRENT_DATE - 1
      ELSE sa.effective_to
    END
WHERE sa.status = 'ACTIVE'
  AND sa.shift_id IN (SELECT id FROM shifts WHERE code IN ('A','B','C'))
  AND sa.employee_id IN (
    SELECT e.id
    FROM employees e
    LEFT JOIN departments d ON d.id = e.department_id
    WHERE e.position ILIKE '%driver%'
       OR d.code = 'PROD'
       OR d.code IN ('FIN','HR','IT','ADMIN','PROC','SAL')
       OR e.position ILIKE '%office%'
  );

INSERT INTO shift_assignments (company_id, tenant_id, employee_id, shift_id, effective_from, status)
SELECT e.company_id, e.tenant_id, e.id, s.id, CURRENT_DATE, 'ACTIVE'
FROM employees e
LEFT JOIN departments d ON d.id = e.department_id
JOIN shifts s ON s.company_id = e.company_id AND s.status = 'ACTIVE'
 AND s.code = CASE
       WHEN e.position ILIKE '%driver%' THEN 'DRIVER'
       WHEN d.code = 'PROD' THEN 'PRODUCTION'
       WHEN d.code IN ('FIN','HR','IT','ADMIN','PROC','SAL') OR e.position ILIKE '%office%' THEN 'GENERAL'
     END
WHERE e.status = 'ACTIVE'
  AND CASE
        WHEN e.position ILIKE '%driver%' THEN 'DRIVER'
        WHEN d.code = 'PROD' THEN 'PRODUCTION'
        WHEN d.code IN ('FIN','HR','IT','ADMIN','PROC','SAL') OR e.position ILIKE '%office%' THEN 'GENERAL'
      END IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM shift_assignments sa
    WHERE sa.employee_id = e.id
      AND sa.shift_id = s.id
      AND sa.status = 'ACTIVE'
      AND sa.effective_from <= CURRENT_DATE
      AND (sa.effective_to IS NULL OR sa.effective_to >= CURRENT_DATE)
  );