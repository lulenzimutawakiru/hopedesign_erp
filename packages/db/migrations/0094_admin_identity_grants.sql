-- ============================================================
-- 0094 Restore identity-administration grants
-- Seed reconcile expands catalogue wildcards and dropped 0072 extras
-- (admin.dashboard.view, sessions, security, user activate/suspend).
-- Without admin.dashboard.view the Administration nav hid Users.
-- ============================================================

INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, split_part(v.code, '.', 1), split_part(v.code, '.', 2), split_part(v.code, '.', 3), v.description
FROM (VALUES
  ('admin.dashboard.view', 'View the administration dashboard'),
  ('admin.users.activate', 'Activate user accounts'),
  ('admin.users.suspend', 'Suspend user accounts'),
  ('admin.users.invite', 'Invite users'),
  ('admin.users.view_sessions', 'View a user sessions'),
  ('admin.users.revoke_sessions', 'Revoke a user sessions'),
  ('admin.sessions.view', 'View active sessions'),
  ('admin.sessions.revoke', 'Revoke sessions'),
  ('admin.security.view', 'View the security centre'),
  ('admin.feature_flags.view', 'View feature flags'),
  ('admin.feature_flags.update', 'Update feature flags'),
  ('admin.backups.view', 'View backups'),
  ('admin.backups.restore', 'Restore backups'),
  ('admin.health.view', 'View system health'),
  ('admin.audit_logs.view', 'View audit logs')
) AS v(code, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code LIKE 'admin.%'
WHERE r.code IN ('super_administrator', 'system_administrator')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'admin.dashboard.view',
  'admin.users.view', 'admin.users.create', 'admin.users.update', 'admin.users.assign_roles',
  'admin.users.activate', 'admin.users.suspend', 'admin.users.invite',
  'admin.users.reset_password', 'admin.users.view_sessions', 'admin.users.revoke_sessions',
  'admin.roles.view', 'admin.policies.view', 'admin.sod.view',
  'admin.sessions.view', 'admin.sessions.revoke', 'admin.security.view',
  'admin.audit.view', 'admin.audit_logs.view'
)
WHERE r.code = 'security_administrator'
ON CONFLICT (role_id, permission_id) DO NOTHING;
