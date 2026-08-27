-- =====================================================================
-- Payroll payment processing, payslip publication and reconciliation.
-- Bridges the active payroll runs (legacy `payrolls` table) into the
-- enterprise payment batches, payment transactions, reconciliation and
-- payslip tables so the full Bank Payment -> Confirmation ->
-- Reconciliation lifecycle is auditable end-to-end.
-- =====================================================================

-- Payment batches can now reference a payroll run (`payrolls`) in addition
-- to the newer `payroll_runs` schema (used by final settlements).
ALTER TABLE payment_batches
  ADD COLUMN payroll_id BIGINT REFERENCES payrolls(id);
CREATE INDEX idx_payment_batches_payroll ON payment_batches(payroll_id);

-- Track who performed export/confirmation for separation-of-duties evidence.
ALTER TABLE payment_batches
  ADD COLUMN exported_by BIGINT REFERENCES users(id),
  ADD COLUMN confirmed_by BIGINT REFERENCES users(id);

-- Reusable JSONB for validation failures and processing notes.
ALTER TABLE payment_batches
  ADD COLUMN notes JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Reconciliation rows can reference a payroll run (`payrolls`) as well.
ALTER TABLE payment_reconciliations
  ADD COLUMN payroll_id BIGINT REFERENCES payrolls(id);
CREATE INDEX idx_payment_recon_payroll ON payment_reconciliations(payroll_id);

-- Payslips: legacy runs have no payroll_run_employees row, so the FK is
-- now optional and legacy payslips are uniquely keyed by (payroll_id, employee_id).
ALTER TABLE payslips ALTER COLUMN run_employee_id DROP NOT NULL;
ALTER TABLE payslips ALTER COLUMN payroll_run_id DROP NOT NULL;
ALTER TABLE payslips ADD COLUMN payroll_id BIGINT REFERENCES payrolls(id);
CREATE UNIQUE INDEX uq_payslips_legacy_run
  ON payslips(payroll_id, employee_id)
  WHERE payroll_id IS NOT NULL;
CREATE INDEX idx_payslips_payroll ON payslips(payroll_id);
