-- 0192_cron_permissions_catalogue_grant.sql
-- Re-assert the cron permission grants that migration 0118 installed.
--
-- 0118 created system.cron.view / system.cron.manage and granted both to seven
-- roles. Those grants did not survive: reconcileRbac() rebuilds role_permissions
-- from ROLES[].grants on every reseed, and the two cron codes were absent from
-- the permission catalogue (packages/db/src/catalogue.js), so no grant could
-- resolve them and they were deleted, never restored. The practical effect was
-- that the Communication -> Cron Jobs tab was dead for every user, super
-- administrator included: the API answered 403 Missing permission: system.cron.view.
--
-- The catalogue now declares both codes in EXTRA_PERMISSIONS and grants them to
-- the same seven roles through CRON_ROLE_EXTENSIONS, so a reseed alone repairs
-- this. This migration repeats the grant for databases that are migrated but not
-- reseeded, and is a no-op where the rows already exist.
--
-- Idempotent: the permission INSERT is guarded by NOT EXISTS and the role grant
-- uses ON CONFLICT DO NOTHING, so a re-run changes nothing and no other role's
-- permissions are touched.

BEGIN;

INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, 'system', v.resource, v.action, v.description
FROM (VALUES
  ('system.cron.view','cron','view','View cron jobs and run history'),
  ('system.cron.manage','cron','manage','Create, edit, toggle and manually run cron jobs')
) AS v(code, resource, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code LIKE 'system.cron.%'
WHERE r.code IN (
  'super_administrator','system_administrator','managing_director','executive_director',
  'general_manager','operations_director','production_director'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;