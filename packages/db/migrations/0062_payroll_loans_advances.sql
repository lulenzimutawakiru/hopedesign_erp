-- Payroll loans & salary advances: versioned columns needed for the
-- repayments integration (period tagging), the payroll run toggle that
-- controls whether approved advances are deducted automatically, and a
-- REJECTED state for loan applications (mirrors salary_advances).
ALTER TABLE employee_loans
  ADD COLUMN IF NOT EXISTS period_code TEXT;

ALTER TABLE salary_advances
  ADD COLUMN IF NOT EXISTS period_code TEXT;

ALTER TABLE payrolls
  ADD COLUMN IF NOT EXISTS deduct_advances BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE employee_loans DROP CONSTRAINT IF EXISTS employee_loans_status_check;
ALTER TABLE employee_loans ADD CONSTRAINT employee_loans_status_check
  CHECK (status IN ('PENDING','ACTIVE','PAUSED','CLOSED','REJECTED','WRITTEN_OFF','PAID'));