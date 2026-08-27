-- ============================================================
-- 0028 User default project
-- Gives each user a default project so requisitions, timesheets
-- and cost documents can prefill the charging project.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id);

CREATE INDEX IF NOT EXISTS idx_users_project
  ON users (project_id);

-- Default project for tenant/company 2 (idempotent).
INSERT INTO projects (company_id, tenant_id, branch_id, code, name, description,
                      start_date, end_date, budget, currency, manager_user_id, status)
SELECT 2, 2, 2, 'PROJ-PROC', 'Procurement & Supply Transformation',
       'Enterprise procurement digitisation and PR engine rollout',
       CURRENT_DATE, NULL, 0, 'UGX', 18, 'ACTIVE'
WHERE NOT EXISTS (
  SELECT 1 FROM projects WHERE company_id = 2 AND tenant_id = 2 AND code = 'PROJ-PROC'
);

-- Default project for the Procurement Manager.
UPDATE users u
SET project_id = p.id
FROM projects p
WHERE u.id = 18
  AND u.tenant_id = 2
  AND u.project_id IS NULL
  AND p.tenant_id = 2
  AND p.company_id = 2
  AND p.code = 'PROJ-PROC';
