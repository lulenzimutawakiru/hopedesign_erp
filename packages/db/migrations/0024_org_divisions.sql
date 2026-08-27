-- ============================================================
-- 0024 Org divisions — link users to divisions, seed demo divisions
-- Tenant/company/branch scoped org hierarchy level (Company -> Division -> Department)
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS division_id BIGINT REFERENCES divisions(id);
CREATE INDEX IF NOT EXISTS idx_users_division ON users(division_id);

-- Seed divisions for the demo tenant/company (idempotent)
INSERT INTO divisions (company_id, tenant_id, branch_id, code, name, description, status)
SELECT 2, 2, 2, x.code, x.name, x.description, 'ACTIVE'
FROM (VALUES
  ('DSGN', 'Design & Creative', 'Brand, design and creative services'),
  ('PRNT', 'Print & Production', 'Print, production and finishing'),
  ('PUR', 'Procurement & Supply', 'Procurement, sourcing and supply chain'),
  ('CRPS', 'Corporate Services', 'Finance, HR, IT and administration')
) AS x(code, name, description)
WHERE NOT EXISTS (SELECT 1 FROM divisions d WHERE d.company_id = 2 AND d.code = x.code);

-- Link the demo procurement user to the Procurement & Supply division
UPDATE users u
SET division_id = d.id
FROM divisions d
WHERE u.email = 'percy.proc@hopedesign.co.ug'
  AND d.code = 'PUR'
  AND d.tenant_id = u.tenant_id
  AND d.company_id = u.company_id
  AND u.division_id IS NULL;
