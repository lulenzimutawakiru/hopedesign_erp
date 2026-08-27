-- ============================================================
-- 0030 User default fiscal year
-- Org fiscal calendar (multi-tenant). Users get a default fiscal
-- year so purchase requisitions prefill the charging period for
-- budget validation. Budgets are tied to the fiscal calendar.
-- ============================================================

CREATE TABLE IF NOT EXISTS fiscal_years (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  fiscal_year_start DATE NOT NULL,
  fiscal_year_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  is_current BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_fiscal_years_tenant
  ON fiscal_years (tenant_id, company_id);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS fiscal_year_id BIGINT REFERENCES fiscal_years(id);

CREATE INDEX IF NOT EXISTS idx_users_fiscal_year
  ON users (fiscal_year_id);

-- Budgets belong to a fiscal year (additive; existing rows keep NULL until linked).
ALTER TABLE budgets
  ADD COLUMN IF NOT EXISTS fiscal_year_id BIGINT REFERENCES fiscal_years(id);

-- FY-2026 for tenant/company 2 (idempotent).
INSERT INTO fiscal_years (company_id, tenant_id, code, name,
                          fiscal_year_start, fiscal_year_end, status, is_current)
SELECT 2, 2, 'FY-2026', 'Fiscal Year 2026', DATE '2026-01-01', DATE '2026-12-31', 'ACTIVE', true
WHERE NOT EXISTS (
  SELECT 1 FROM fiscal_years WHERE company_id = 2 AND tenant_id = 2 AND code = 'FY-2026'
);

-- Link the procurement budget and default fiscal year.
UPDATE budgets b
SET fiscal_year_id = fy.id
FROM fiscal_years fy
WHERE b.budget_no = 'BUD-PROC-2026'
  AND b.company_id = 2 AND b.tenant_id = 2
  AND fy.code = 'FY-2026' AND fy.company_id = 2 AND fy.tenant_id = 2
  AND b.fiscal_year_id IS NULL;

UPDATE users u
SET fiscal_year_id = fy.id
FROM fiscal_years fy
WHERE u.id = 18
  AND u.tenant_id = 2
  AND u.fiscal_year_id IS NULL
  AND fy.tenant_id = 2
  AND fy.company_id = 2
  AND fy.code = 'FY-2026';
