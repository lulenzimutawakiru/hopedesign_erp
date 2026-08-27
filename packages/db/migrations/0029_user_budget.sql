-- ============================================================
-- 0029 User default budget
-- Gives each user a default budget so purchase requisitions can
-- prefill the charging budget for budget validation.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS budget_id BIGINT REFERENCES budgets(id);

CREATE INDEX IF NOT EXISTS idx_users_budget
  ON users (budget_id);

-- FY-2026 procurement budget for tenant/company 2 (idempotent).
INSERT INTO budgets (company_id, tenant_id, cost_centre_id, budget_no,
                     period_start, period_end, amount, status)
SELECT 2, 2, cc.id, 'BUD-PROC-2026', DATE '2026-01-01', DATE '2026-12-31', 250000000, 'ACTIVE'
FROM cost_centres cc
WHERE cc.company_id = 2 AND cc.tenant_id = 2 AND cc.code = 'CC-PROC'
  AND NOT EXISTS (
    SELECT 1 FROM budgets WHERE company_id = 2 AND tenant_id = 2 AND budget_no = 'BUD-PROC-2026'
  );

-- Default budget for the Procurement Manager.
UPDATE users u
SET budget_id = b.id
FROM budgets b
WHERE u.id = 18
  AND u.tenant_id = 2
  AND u.budget_id IS NULL
  AND b.tenant_id = 2
  AND b.company_id = 2
  AND b.budget_no = 'BUD-PROC-2026';
