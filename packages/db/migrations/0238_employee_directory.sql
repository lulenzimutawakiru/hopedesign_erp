-- ============================================================
-- 0238 Employee directory (Odoo Employees parity)
-- Adds the reporting/directory fields Odoo's hr.employee carries:
-- manager + coach, work contact details, work location already exists
-- (location_id), work permit / badge, and free-form tags.
-- ============================================================

ALTER TABLE employees ADD COLUMN IF NOT EXISTS manager_id BIGINT REFERENCES employees(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS coach_id BIGINT REFERENCES employees(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_email TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_phone TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS mobile_phone TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_permit_no TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS badge_id TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'::text[];

CREATE INDEX IF NOT EXISTS idx_employees_manager ON employees(manager_id);
CREATE INDEX IF NOT EXISTS idx_employees_coach ON employees(coach_id);
