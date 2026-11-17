-- ============================================================
-- 0246 Intelligence — permission codes & role grants
-- ============================================================
-- Migration 0240 created the discovery_campaigns / prospects tables and their
-- RLS, but did NOT seed the intelligence.* permission codes. The codes and the
-- role mapping exist only in the permission catalogue
-- (packages/db/src/catalogue.js → INTELLIGENCE_ROLE_EXTENSIONS), so they land
-- in a database only when it is re-seeded (reconcileRbac()). A database that is
-- migrated but not re-seeded therefore has no intelligence.* rows in
-- `permissions`, every `can(user, 'intelligence.dashboard.view')` is false, and
-- the Natex Intelligence nav item stays hidden for every role that does not
-- carry the `*` catch-all.
--
-- This migration repeats the grants for migrated-but-not-reseeded databases
-- (the same pattern as 0192 for system.cron.*) and is a no-op where the rows
-- already exist. It mirrors the catalogue's effective grants:
--
--   INTELLIGENCE_FULL → super_administrator, ceo, managing_director,
--                       executive_director, general_manager (their `*` base
--                       grant expands only at reseed time), sales_director,
--                       sales_manager, md_assistant, operations_manager,
--                       system_administrator
--   INTELLIGENCE_EXECUTIVE → sales_executive
--   INTELLIGENCE_REP       → sales_representative
--
-- Idempotent: the permission INSERT is guarded by NOT EXISTS and the role grants
-- use ON CONFLICT DO NOTHING.

BEGIN;

INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, v.module, v.resource, v.action, v.description
FROM (VALUES
  ('intelligence.dashboard.view','intelligence','dashboard','view','View the intelligence dashboard'),
  ('intelligence.campaigns.view','intelligence','campaigns','view','View discovery campaigns'),
  ('intelligence.campaigns.create','intelligence','campaigns','create','Create discovery campaigns'),
  ('intelligence.campaigns.update','intelligence','campaigns','update','Edit discovery campaigns'),
  ('intelligence.campaigns.delete','intelligence','campaigns','delete','Delete discovery campaigns'),
  ('intelligence.campaigns.run','intelligence','campaigns','run','Run a discovery campaign'),
  ('intelligence.prospects.view','intelligence','prospects','view','View prospects'),
  ('intelligence.prospects.create','intelligence','prospects','create','Create prospects'),
  ('intelligence.prospects.update','intelligence','prospects','update','Edit prospects'),
  ('intelligence.prospects.delete','intelligence','prospects','delete','Delete prospects'),
  ('intelligence.prospects.enrich','intelligence','prospects','enrich','Re-enrich a prospect'),
  ('intelligence.prospects.review','intelligence','prospects','review','Review a prospect'),
  ('intelligence.prospects.convert','intelligence','prospects','convert','Convert a prospect to CRM'),
  ('intelligence.providers.view','intelligence','providers','view','View AI/search provider status'),
  ('intelligence.providers.configure','intelligence','providers','configure','Configure AI/search providers')
) AS v(code, module, resource, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

-- Full module: sales leadership, the executive office and the system
-- administrator.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code LIKE 'intelligence.%'
WHERE r.code IN ('super_administrator','ceo','managing_director','executive_director','general_manager','sales_director','sales_manager','md_assistant','operations_manager','system_administrator')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Sales executive: discover, enrich, review and convert, but cannot reconfigure
-- providers or manage campaigns.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'intelligence.dashboard.view',
  'intelligence.campaigns.view',
  'intelligence.prospects.view',
  'intelligence.prospects.create',
  'intelligence.prospects.update',
  'intelligence.prospects.enrich',
  'intelligence.prospects.review',
  'intelligence.prospects.convert'
)
WHERE r.code = 'sales_executive'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Sales representative: read-only discovery visibility.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('intelligence.dashboard.view','intelligence.prospects.view')
WHERE r.code = 'sales_representative'
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;
