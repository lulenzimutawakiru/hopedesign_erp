-- ============================================================
-- 0049 Payroll arrears engine
-- Extends payroll_arrears so arrears records can be linked to an
-- active payroll run (legacy `payrolls` engine), carry their own
-- currency and reason, and are arithmetically self-consistent.
-- ============================================================

ALTER TABLE payroll_arrears
  ADD COLUMN payroll_id BIGINT REFERENCES payrolls(id) ON DELETE SET NULL,
  ADD COLUMN currency TEXT NOT NULL DEFAULT 'UGX',
  ADD COLUMN reason TEXT;

ALTER TABLE payroll_arrears
  ADD CONSTRAINT payroll_arrears_arithmetic_check
  CHECK (difference = correct_pay - original_pay
     AND net_arrears = difference - tax_impact);

-- The arrears approval workflow adds APPROVED/REJECTED lifecycle states;
-- widen the legacy check constraint that only allowed PENDING/PAID/CLOSED.
ALTER TABLE payroll_arrears DROP CONSTRAINT payroll_arrears_status_check;
ALTER TABLE payroll_arrears
  ADD CONSTRAINT payroll_arrears_status_check
  CHECK (status IN ('PENDING','APPROVED','REJECTED','PAID','CLOSED'));

CREATE INDEX idx_payroll_arrears_run ON payroll_arrears (payroll_id);
CREATE INDEX idx_payroll_arrears_scope ON payroll_arrears (tenant_id, company_id, status, to_period_end);
