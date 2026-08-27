-- ============================================================
-- 0095 Restore Database Management Center grants
-- 0085/0087 inserted database.* permissions, then seed reconcile
-- replaced role_permissions from the catalogue (which had no
-- database module). Super/system admins lost every database.*
-- grant, so /admin/database was Access Denied.
-- ============================================================

INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, 'database', v.resource, v.action, v.description
FROM (VALUES
  ('database.health.view','health','view','View database health and command center'),
  ('database.connections.view','connections','view','View database connections'),
  ('database.activity.view','activity','view','View database activity and query monitor'),
  ('database.performance.view','performance','view','View database performance metrics'),
  ('database.query.analyze','query','analyze','Analyze query plans and execution history'),
  ('database.schema.view','schema','view','View tables, schemas and relationships'),
  ('database.schema.manage','schema','manage','Manage schema objects'),
  ('database.index.view','index','view','View index insights'),
  ('database.index.manage','index','manage','Create, rebuild or drop indexes'),
  ('database.backup.view','backup','view','View backups'),
  ('database.backup.create','backup','create','Create backups'),
  ('database.backup.delete','backup','delete','Delete backups'),
  ('database.restore.request','restore','request','Request a database restore'),
  ('database.restore.approve','restore','approve','Approve database restores'),
  ('database.migration.view','migration','view','View migration history'),
  ('database.migration.execute','migration','execute','Execute database migrations'),
  ('database.integrity.run','integrity','run','Run data integrity checks'),
  ('database.data_quality.view','data_quality','view','View data quality center'),
  ('database.retention.manage','retention','manage','Manage retention policies'),
  ('database.archive.manage','archive','manage','Manage data archiving'),
  ('database.audit.view','audit','view','View database audit trail'),
  ('database.settings.manage','settings','manage','Manage database settings'),
  ('database.locks.view','locks','view','View database locks, blocking sessions and long transactions'),
  ('database.maintenance.run','maintenance','run','Run database maintenance (analyze, vacuum, reindex)')
) AS v(code, resource, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code LIKE 'database.%'
WHERE r.code IN ('super_administrator', 'system_administrator')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'database.health.view','database.connections.view','database.activity.view',
  'database.performance.view','database.schema.view','database.index.view',
  'database.backup.view','database.migration.view','database.data_quality.view',
  'database.audit.view','database.locks.view'
)
WHERE r.code IN ('it_support_administrator','security_administrator',
                 'ceo','executive_director','general_manager','managing_director')
ON CONFLICT (role_id, permission_id) DO NOTHING;
