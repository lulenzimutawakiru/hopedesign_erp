-- ============================================================================
-- 0147 - Finance cost-centre / profit-centre read permissions
--
-- The grouped Finance workspace exposes "Cost & Profit Centres", and global
-- search targets cost_centres / profit_centres, but neither permission existed
-- in the catalogue. The nav entry and the search hits were therefore invisible
-- to every role. Additive only: creates the two permissions and grants them to
-- exactly the roles that can already read financial reports, so cost/profit
-- centre analytics land in step with the rest of finance reporting.
-- ============================================================================

INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, 'finance', v.resource, 'view', v.description
FROM (VALUES
  ('finance.cost_centres.view',   'cost_centres',   'View cost-centre structure and activity'),
  ('finance.profit_centres.view', 'profit_centres', 'View profit-centre structure and activity')
) AS v(code, resource, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p
  ON p.code IN ('finance.cost_centres.view','finance.profit_centres.view')
WHERE EXISTS (
  SELECT 1
  FROM role_permissions rp
  JOIN permissions rp_perm ON rp_perm.id = rp.permission_id
  WHERE rp.role_id = r.id
    AND rp_perm.code = 'finance.reports.view'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;