-- ============================================================
-- 0051 Payroll validation
-- Links payroll exceptions to live payroll runs (the legacy
-- `payrolls` engine) and adds a readiness score to each run.
-- The enterprise `payroll_exceptions` table previously only
-- referenced `payroll_runs` (unused by the live engine), so the
-- payroll_run_id FK is relaxed and a payroll_id FK added.
-- ============================================================

ALTER TABLE payroll_exceptions
  ALTER COLUMN payroll_run_id DROP NOT NULL;

ALTER TABLE payroll_exceptions
  ADD COLUMN payroll_id BIGINT REFERENCES payrolls(id) ON DELETE CASCADE;

CREATE INDEX idx_payroll_exceptions_payroll ON payroll_exceptions (payroll_id, status);

ALTER TABLE payrolls
  ADD COLUMN validation_score INT NOT NULL DEFAULT 100;

ALTER TABLE payrolls
  ADD CONSTRAINT payrolls_validation_score_range
  CHECK (validation_score BETWEEN 0 AND 100);