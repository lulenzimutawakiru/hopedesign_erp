-- ============================================================================
-- 0184 - Payroll lifecycle, statutory, exception and self-service permissions
--
-- 0183 introduced release / close / reopen / simulation / variance and the
-- statutory compliance and exception workflow surfaces. This migration adds
-- the catalogue entries those surfaces authorise against, then grants them by
-- deriving from permissions a role already holds (the 0147 pattern) so the
-- grants land in step with the payroll duties each role already carries.
--
-- Additive only. No existing permission or role_permissions row is touched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Catalogue entries
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, module, resource, action, description)
SELECT 'hr.' || v.resource || '.' || v.action, 'hr', v.resource, v.action, v.description
FROM (VALUES
  ('payrolls', 'calculate', 'Run the payroll calculation engine'),
  ('payrolls', 'validate',  'Run payroll data validation and raise exceptions'),
  ('payrolls', 'review',    'Carry out HR / Finance payroll review'),
  ('payrolls', 'close',     'Close a payroll period and freeze its records'),
  ('payrolls', 'reopen',    'Reopen a locked or closed payroll with authorisation and reason'),
  ('payrolls', 'pay',       'Authorise and process payroll payment'),
  ('payrolls', 'export',    'Export payroll registers, reports and statutory returns'),
  ('payroll_periods', 'view',   'View the payroll calendar and period definitions'),
  ('payroll_periods', 'create', 'Create payroll periods'),
  ('payroll_periods', 'update', 'Update and open payroll periods'),
  ('payroll_periods', 'close',  'Close payroll periods'),
  ('statutory', 'view',    'View statutory liabilities, returns and reconciliation'),
  ('statutory', 'create',  'Create statutory submissions and returns'),
  ('statutory', 'update',  'Update statutory submissions and reconciliation evidence'),
  ('statutory', 'approve', 'Approve statutory submissions and reconciliation'),
  ('payroll_exceptions', 'view',    'View the payroll exception centre'),
  ('payroll_exceptions', 'resolve', 'Assign, review and resolve payroll exceptions'),
  ('payslips', 'generate', 'Generate employee payslips from a payroll snapshot'),
  ('employee_payroll', 'self_view', 'View own payslips, earnings, deductions and payroll queries')
) AS v(resource, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = 'hr.' || v.resource || '.' || v.action);

-- ---------------------------------------------------------------------------
-- 2. Read / operate tier - everyone who can already view payroll
-- ---------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p
  ON p.code IN (
    'hr.payrolls.calculate','hr.payrolls.validate','hr.payrolls.review',
    'hr.payrolls.export','hr.payroll_periods.view','hr.statutory.view',
    'hr.payroll_exceptions.view','hr.payslips.generate'
  )
WHERE EXISTS (
  SELECT 1 FROM role_permissions rp
  JOIN permissions rp_perm ON rp_perm.id = rp.permission_id
  WHERE rp.role_id = r.id AND rp_perm.code = 'hr.payrolls.view'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Approval tier - everyone who can already approve payroll
-- ---------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p
  ON p.code IN (
    'hr.payrolls.close','hr.payrolls.reopen','hr.payrolls.pay',
    'hr.payroll_exceptions.resolve',
    'hr.statutory.create','hr.statutory.update','hr.statutory.approve',
    'hr.payroll_periods.create','hr.payroll_periods.update','hr.payroll_periods.close'
  )
WHERE EXISTS (
  SELECT 1 FROM role_permissions rp
  JOIN permissions rp_perm ON rp_perm.id = rp.permission_id
  WHERE rp.role_id = r.id AND rp_perm.code = 'hr.payrolls.approve'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Self-service tier - everyone who can already view payslips
-- ---------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'hr.employee_payroll.self_view'
WHERE EXISTS (
  SELECT 1 FROM role_permissions rp
  JOIN permissions rp_perm ON rp_perm.id = rp.permission_id
  WHERE rp.role_id = r.id AND rp_perm.code = 'hr.payslips.view'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;
