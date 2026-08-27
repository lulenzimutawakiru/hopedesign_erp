-- 0086_exec_no_identity_admin.sql
-- Governance: Executive leadership roles are business/read-only.
-- CEO, Managing Director, Executive Director and General Manager must NOT
-- see or manage the identity administration modules under Administration
-- (Users, Roles, Permissions, Policies, SoD, Security, Sessions).
-- Super Administrator / System Administrator retain full identity admin.
-- Revokes only the admin identity/security families; dashboards, audit,
-- settings, imports/exports and database.* view permissions are retained.

-- 1. Remove role_permissions rows for the exec roles
DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.code IN ('ceo','managing_director','executive_director','general_manager')
  AND (
    p.code LIKE 'admin.users.%'
    OR p.code LIKE 'admin.roles.%'
    OR p.code LIKE 'admin.permissions.%'
    OR p.code LIKE 'admin.policies.%'
    OR p.code LIKE 'admin.sod.%'
    OR p.code LIKE 'admin.security.%'
    OR p.code LIKE 'admin.sessions.%'
  );

-- 2. Keep roles.permissions jsonb consistent with role_permissions
UPDATE roles
SET permissions = (
  SELECT COALESCE(jsonb_agg(x), '[]'::jsonb)
  FROM jsonb_array_elements_text(permissions) AS x
  WHERE x NOT LIKE 'admin.users.%'
    AND x NOT LIKE 'admin.roles.%'
    AND x NOT LIKE 'admin.permissions.%'
    AND x NOT LIKE 'admin.policies.%'
    AND x NOT LIKE 'admin.sod.%'
    AND x NOT LIKE 'admin.security.%'
    AND x NOT LIKE 'admin.sessions.%'
)
WHERE code IN ('ceo','managing_director','executive_director','general_manager');
