-- ============================================================================
-- 0137 - Hikvision attendance read permission (hr.attendance.view)
-- 0135 referenced hr.attendance.view in the employee_self_service grant before
-- the permission row existed, so the role never received it. Additive only:
-- creates the missing permission and re-grants the standard HR role sets.
-- ============================================================================

-- 1. Create the missing permission (idempotent).
INSERT INTO permissions (code, module, resource, action, description)
SELECT 'hr.attendance.view','hr','attendance','view','View attendance records and attendance dashboards'
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = 'hr.attendance.view');

-- 2. Full administration + HR leadership scopes.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('hr.attendance.view','hr.attendance.view_own')
WHERE r.code IN (
  'super_administrator','system_administrator','security_administrator',
  'integration_administrator','hr_director','hr_manager','time_attendance_officer'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 3. HR officer: read attendance for assigned branch (0135 granted the rest of
--    the attendance workflow; ensure the read/view scope exists too).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('hr.attendance.view','hr.attendance.view_own')
WHERE r.code = 'hr_officer'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 4. Employee self-service: own attendance only (view_own + base view scope,
--    matching the original 0135 intent). Data scope remains enforced by ABAC.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('hr.attendance.view_own','hr.attendance.view')
WHERE r.code = 'employee_self_service'
ON CONFLICT (role_id, permission_id) DO NOTHING;