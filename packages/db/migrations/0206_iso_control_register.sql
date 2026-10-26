-- ===========================================================================
-- 0206 - ISO control register permission
--
-- The register itself is the assessment in apps/api/src/services/iso. It is
-- not a tenant table: a caller must not be able to mark a control implemented.
-- This migration only lets the people who examine the system open that
-- assessment.
--
-- Mirrored in packages/db/src/catalogue.js (compliance.iso.view, and the role
-- grants below). A later db:seed rebuilds role_permissions from the catalogue,
-- so a grant that exists only here would disappear on the next seed.
--
-- No BEGIN/COMMIT and no schema_migrations row - migrate.js owns both.
-- ===========================================================================

INSERT INTO permissions (code, module, resource, action, description)
SELECT 'compliance.iso.view', 'compliance', 'iso', 'view',
       'View the ISO/IEC 27001:2022 and ISO 9001 alignment register'
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = 'compliance.iso.view');

INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'compliance.iso.view'
WHERE r.code IN (
  'super_administrator',
  'ceo',
  'system_administrator',
  'security_administrator',
  'audit_administrator',
  'internal_auditor',
  'data_protection_officer',
  'quality_director',
  'quality_manager',
  'qa_auditor'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- The role screen shows roles.permissions. Authorization does not read it.
UPDATE roles r
   SET permissions = r.permissions || '["compliance.iso.view"]'::jsonb,
       updated_at = now()
 WHERE r.code IN (
        'super_administrator',
        'ceo',
        'system_administrator',
        'security_administrator',
        'audit_administrator',
        'internal_auditor',
        'data_protection_officer',
        'quality_director',
        'quality_manager',
        'qa_auditor'
      )
   AND jsonb_typeof(r.permissions) = 'array'
   AND r.permissions @> '["compliance.iso.view"]'::jsonb IS NOT TRUE;
