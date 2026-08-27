-- ============================================================
-- 0048 Off-cycle payroll runs
-- Extends the payrolls table so special payroll runs can be
-- independently identified, scoped to selected employees and audited
-- without touching closed normal-period payroll records.
-- ============================================================

ALTER TABLE payrolls
  ADD COLUMN run_type TEXT NOT NULL DEFAULT 'NORMAL'
    CHECK (run_type IN ('NORMAL','OFF_CYCLE','FINAL','ADJUSTMENT','REVERSAL','ARREARS')),
  ADD COLUMN off_cycle_type TEXT
    CHECK (off_cycle_type IN ('NEW_HIRE','TERMINATION','FINAL','BONUS','COMMISSION','CORRECTION','ARREARS','EMERGENCY')),
  ADD COLUMN reason TEXT,
  ADD COLUMN employee_ids BIGINT[] NOT NULL DEFAULT '{}',
  ADD COLUMN extra_earnings NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN extra_deductions NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN deduct_loans BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN payment_date DATE;

CREATE INDEX idx_payrolls_run_type ON payrolls (company_id, run_type, id DESC);
