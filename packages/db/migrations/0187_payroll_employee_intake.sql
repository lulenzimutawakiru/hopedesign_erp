-- ============================================================================
-- 0187 - Payroll employee intake
--
-- The payroll register can only ever list the people already inside a run, so
-- a payroll officer who spots a missing hire has nowhere to go. 27910e5 added
-- the action that fixes that to the register panel, its empty state and the run
-- header, gated on hr.employees.create.
--
-- The gate was the whole defect. payroll_accountant, payroll_manager and
-- payroll_officer can all view payroll runs and view the employee file, but
-- none of them held hr.employees.create, so the action they needed was never
-- drawn. They were left with an empty run that told them to recalculate and no
-- way to add the person it was asking about.
--
-- Granted by deriving from what the role already holds (the 0147 / 0184
-- pattern): whoever can change a payroll run can onboard a person into it.
-- That selects exactly the three payroll roles and is a no-op everywhere else,
-- because every other role able to write a payroll run - HR, operations and the
-- executive roles - already holds both employee grants.
--
-- Additive only. No existing permission or role_permissions row is touched, and
-- re-running is a no-op.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Catalogue entries - belt and braces; these predate this migration
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, module, resource, action, description)
SELECT 'hr.employees.' || v.action, 'hr', 'employees', v.action, v.description
FROM (VALUES
  ('create', 'Hire a new person onto the employee and payroll file'),
  ('update', 'Update an employee record and its payroll enrolment')
) AS v(action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = 'hr.employees.' || v.action);

-- ---------------------------------------------------------------------------
-- 2. Intake tier - everyone who can already change a payroll run
-- ---------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p
  ON p.code IN ('hr.employees.create','hr.employees.update')
WHERE EXISTS (
  SELECT 1 FROM role_permissions rp
  JOIN permissions rp_perm ON rp_perm.id = rp.permission_id
  WHERE rp.role_id = r.id AND rp_perm.code = 'hr.payrolls.update'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;
