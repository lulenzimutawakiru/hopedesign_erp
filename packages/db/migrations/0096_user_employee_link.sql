-- ============================================================
-- 0096 Bidirectional user account ↔ employee profile link
-- users.employee_id and employees.user_id already exist; keep them
-- in sync, add FKs, one-primary uniqueness, and backfill by email.
-- ============================================================

-- Drop orphan pointers before adding FKs
UPDATE users u
   SET employee_id = NULL
 WHERE u.employee_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = u.employee_id AND e.tenant_id = u.tenant_id);

UPDATE employees e
   SET user_id = NULL
 WHERE e.user_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = e.user_id AND u.tenant_id = e.tenant_id);

-- One primary user per employee (keep the lowest user id)
UPDATE users u
   SET employee_id = NULL
 WHERE u.employee_id IS NOT NULL
   AND u.id <> (
     SELECT min(u2.id) FROM users u2
     WHERE u2.employee_id = u.employee_id AND u2.tenant_id = u.tenant_id
   );

-- One primary employee per user (keep the lowest employee id)
UPDATE employees e
   SET user_id = NULL
 WHERE e.user_id IS NOT NULL
   AND e.id <> (
     SELECT min(e2.id) FROM employees e2
     WHERE e2.user_id = e.user_id AND e2.tenant_id = e.tenant_id
   );

-- Prefer users.employee_id when the two pointers disagree
UPDATE employees e
   SET user_id = u.id
  FROM users u
 WHERE u.employee_id = e.id
   AND u.tenant_id = e.tenant_id
   AND e.user_id IS DISTINCT FROM u.id;

-- Drop leftover employee.user_id rows that no longer match users.employee_id
UPDATE employees e
   SET user_id = NULL
 WHERE e.user_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM users u
      WHERE u.id = e.user_id AND u.tenant_id = e.tenant_id AND u.employee_id = e.id
   );

UPDATE users u
   SET employee_id = e.id
  FROM employees e
 WHERE e.user_id = u.id
   AND e.tenant_id = u.tenant_id
   AND u.employee_id IS NULL;

-- Match remaining pairs by email only when the address is unique on both sides
UPDATE users u
   SET employee_id = e.id
  FROM employees e
 WHERE e.tenant_id = u.tenant_id
   AND u.employee_id IS NULL
   AND e.user_id IS NULL
   AND e.email IS NOT NULL AND btrim(e.email) <> ''
   AND lower(btrim(e.email)) = lower(btrim(u.email))
   AND (SELECT count(*) FROM users u2 WHERE u2.tenant_id = u.tenant_id AND lower(btrim(u2.email)) = lower(btrim(u.email))) = 1
   AND (SELECT count(*) FROM employees e2 WHERE e2.tenant_id = e.tenant_id AND lower(btrim(e2.email)) = lower(btrim(e.email))) = 1;

UPDATE employees e
   SET user_id = u.id
  FROM users u
 WHERE u.employee_id = e.id
   AND u.tenant_id = e.tenant_id
   AND e.user_id IS NULL;

INSERT INTO user_employment_links (tenant_id, user_id, employee_id, is_primary, effective_from, employment_status)
SELECT u.tenant_id, u.id, u.employee_id, true, CURRENT_DATE, e.status
FROM users u
JOIN employees e ON e.id = u.employee_id
WHERE u.employee_id IS NOT NULL
ON CONFLICT (user_id, employee_id) DO UPDATE
  SET is_primary = true, updated_at = now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_employee_id_fkey'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_employee_id_fkey
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_user_id_fkey;
ALTER TABLE employees
  ADD CONSTRAINT employees_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee_id_uq
  ON users (employee_id) WHERE employee_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_user_id_uq
  ON employees (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_employee_id ON users (employee_id);
