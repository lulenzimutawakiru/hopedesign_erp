-- ============================================================
-- 0053 Payroll group scoping for live payroll runs
-- A NORMAL run may optionally be scoped to a payroll group.
-- NULL = company-wide run; validation then skips the
-- "paid outside payroll group" check.
-- ============================================================

ALTER TABLE payrolls
  ADD COLUMN IF NOT EXISTS payroll_group_id BIGINT REFERENCES payroll_groups(id);

CREATE INDEX IF NOT EXISTS idx_payrolls_payroll_group
  ON payrolls (tenant_id, company_id, payroll_group_id);
