-- ============================================================================
-- 0151 - HOPE DESIGN Service Desk & ITSM: permissions, roles and grants
-- Companion to 0150_service_desk.sql (schema + seed).
-- Generated from packages/db/src/catalogue.js so migration and catalogue agree.
-- Additive and idempotent: safe to re-run, safe on every tenant.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Service Desk permissions (RBAC catalogue, spec section 22)
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, v.module, v.resource, v.action, v.description
FROM (VALUES
  ('service_desk.command.view','service_desk','command','view','view command (service_desk)'),
  ('service_desk.tickets.view','service_desk','tickets','view','view tickets (service_desk)'),
  ('service_desk.tickets.view_own','service_desk','tickets','view_own','view_own tickets (service_desk)'),
  ('service_desk.tickets.create','service_desk','tickets','create','create tickets (service_desk)'),
  ('service_desk.tickets.update','service_desk','tickets','update','update tickets (service_desk)'),
  ('service_desk.tickets.delete','service_desk','tickets','delete','delete tickets (service_desk)'),
  ('service_desk.tickets.reply','service_desk','tickets','reply','reply tickets (service_desk)'),
  ('service_desk.tickets.assign','service_desk','tickets','assign','assign tickets (service_desk)'),
  ('service_desk.tickets.resolve','service_desk','tickets','resolve','resolve tickets (service_desk)'),
  ('service_desk.tickets.close','service_desk','tickets','close','close tickets (service_desk)'),
  ('service_desk.tickets.close_own','service_desk','tickets','close_own','close_own tickets (service_desk)'),
  ('service_desk.tickets.reopen','service_desk','tickets','reopen','reopen tickets (service_desk)'),
  ('service_desk.tickets.escalate','service_desk','tickets','escalate','escalate tickets (service_desk)'),
  ('service_desk.tickets.export','service_desk','tickets','export','export tickets (service_desk)'),
  ('service_desk.tickets.import','service_desk','tickets','import','import tickets (service_desk)'),
  ('service_desk.tickets.print','service_desk','tickets','print','print tickets (service_desk)'),
  ('service_desk.tickets.verify','service_desk','tickets','verify','verify tickets (service_desk)'),
  ('service_desk.internal_notes.view','service_desk','internal_notes','view','view internal_notes (service_desk)'),
  ('service_desk.internal_notes.create','service_desk','internal_notes','create','create internal_notes (service_desk)'),
  ('service_desk.queues.view','service_desk','queues','view','view queues (service_desk)'),
  ('service_desk.queues.create','service_desk','queues','create','create queues (service_desk)'),
  ('service_desk.queues.update','service_desk','queues','update','update queues (service_desk)'),
  ('service_desk.queues.delete','service_desk','queues','delete','delete queues (service_desk)'),
  ('service_desk.teams.view','service_desk','teams','view','view teams (service_desk)'),
  ('service_desk.teams.create','service_desk','teams','create','create teams (service_desk)'),
  ('service_desk.teams.update','service_desk','teams','update','update teams (service_desk)'),
  ('service_desk.teams.delete','service_desk','teams','delete','delete teams (service_desk)'),
  ('service_desk.skills.view','service_desk','skills','view','view skills (service_desk)'),
  ('service_desk.skills.create','service_desk','skills','create','create skills (service_desk)'),
  ('service_desk.skills.update','service_desk','skills','update','update skills (service_desk)'),
  ('service_desk.skills.delete','service_desk','skills','delete','delete skills (service_desk)'),
  ('service_desk.categories.view','service_desk','categories','view','view categories (service_desk)'),
  ('service_desk.categories.create','service_desk','categories','create','create categories (service_desk)'),
  ('service_desk.categories.update','service_desk','categories','update','update categories (service_desk)'),
  ('service_desk.categories.delete','service_desk','categories','delete','delete categories (service_desk)'),
  ('service_desk.sla.view','service_desk','sla','view','view sla (service_desk)'),
  ('service_desk.sla.manage','service_desk','sla','manage','manage sla (service_desk)'),
  ('service_desk.escalations.view','service_desk','escalations','view','view escalations (service_desk)'),
  ('service_desk.escalations.create','service_desk','escalations','create','create escalations (service_desk)'),
  ('service_desk.escalations.update','service_desk','escalations','update','update escalations (service_desk)'),
  ('service_desk.escalations.delete','service_desk','escalations','delete','delete escalations (service_desk)'),
  ('service_desk.escalations.manage','service_desk','escalations','manage','manage escalations (service_desk)'),
  ('service_desk.service_requests.view','service_desk','service_requests','view','view service_requests (service_desk)'),
  ('service_desk.service_requests.create','service_desk','service_requests','create','create service_requests (service_desk)'),
  ('service_desk.service_requests.update','service_desk','service_requests','update','update service_requests (service_desk)'),
  ('service_desk.service_requests.approve','service_desk','service_requests','approve','approve service_requests (service_desk)'),
  ('service_desk.service_requests.reject','service_desk','service_requests','reject','reject service_requests (service_desk)'),
  ('service_desk.service_requests.fulfil','service_desk','service_requests','fulfil','fulfil service_requests (service_desk)'),
  ('service_desk.service_requests.cancel','service_desk','service_requests','cancel','cancel service_requests (service_desk)'),
  ('service_desk.incidents.view','service_desk','incidents','view','view incidents (service_desk)'),
  ('service_desk.incidents.create','service_desk','incidents','create','create incidents (service_desk)'),
  ('service_desk.incidents.update','service_desk','incidents','update','update incidents (service_desk)'),
  ('service_desk.incidents.resolve','service_desk','incidents','resolve','resolve incidents (service_desk)'),
  ('service_desk.incidents.close','service_desk','incidents','close','close incidents (service_desk)'),
  ('service_desk.incidents.escalate','service_desk','incidents','escalate','escalate incidents (service_desk)'),
  ('service_desk.problems.view','service_desk','problems','view','view problems (service_desk)'),
  ('service_desk.problems.create','service_desk','problems','create','create problems (service_desk)'),
  ('service_desk.problems.update','service_desk','problems','update','update problems (service_desk)'),
  ('service_desk.problems.investigate','service_desk','problems','investigate','investigate problems (service_desk)'),
  ('service_desk.problems.resolve','service_desk','problems','resolve','resolve problems (service_desk)'),
  ('service_desk.problems.close','service_desk','problems','close','close problems (service_desk)'),
  ('service_desk.known_errors.view','service_desk','known_errors','view','view known_errors (service_desk)'),
  ('service_desk.known_errors.create','service_desk','known_errors','create','create known_errors (service_desk)'),
  ('service_desk.known_errors.update','service_desk','known_errors','update','update known_errors (service_desk)'),
  ('service_desk.known_errors.resolve','service_desk','known_errors','resolve','resolve known_errors (service_desk)'),
  ('service_desk.known_errors.archive','service_desk','known_errors','archive','archive known_errors (service_desk)'),
  ('service_desk.changes.view','service_desk','changes','view','view changes (service_desk)'),
  ('service_desk.changes.create','service_desk','changes','create','create changes (service_desk)'),
  ('service_desk.changes.update','service_desk','changes','update','update changes (service_desk)'),
  ('service_desk.changes.submit','service_desk','changes','submit','submit changes (service_desk)'),
  ('service_desk.changes.approve','service_desk','changes','approve','approve changes (service_desk)'),
  ('service_desk.changes.reject','service_desk','changes','reject','reject changes (service_desk)'),
  ('service_desk.changes.implement','service_desk','changes','implement','implement changes (service_desk)'),
  ('service_desk.changes.validate','service_desk','changes','validate','validate changes (service_desk)'),
  ('service_desk.changes.close','service_desk','changes','close','close changes (service_desk)'),
  ('service_desk.changes.cancel','service_desk','changes','cancel','cancel changes (service_desk)'),
  ('service_desk.change_approvals.view','service_desk','change_approvals','view','view change_approvals (service_desk)'),
  ('service_desk.change_approvals.create','service_desk','change_approvals','create','create change_approvals (service_desk)'),
  ('service_desk.change_approvals.approve','service_desk','change_approvals','approve','approve change_approvals (service_desk)'),
  ('service_desk.change_approvals.reject','service_desk','change_approvals','reject','reject change_approvals (service_desk)'),
  ('service_desk.access_requests.view','service_desk','access_requests','view','view access_requests (service_desk)'),
  ('service_desk.access_requests.view_own','service_desk','access_requests','view_own','view_own access_requests (service_desk)'),
  ('service_desk.access_requests.create','service_desk','access_requests','create','create access_requests (service_desk)'),
  ('service_desk.access_requests.update','service_desk','access_requests','update','update access_requests (service_desk)'),
  ('service_desk.access_requests.approve','service_desk','access_requests','approve','approve access_requests (service_desk)'),
  ('service_desk.access_requests.reject','service_desk','access_requests','reject','reject access_requests (service_desk)'),
  ('service_desk.access_requests.grant','service_desk','access_requests','grant','grant access_requests (service_desk)'),
  ('service_desk.access_requests.revoke','service_desk','access_requests','revoke','revoke access_requests (service_desk)'),
  ('service_desk.access_requests.cancel','service_desk','access_requests','cancel','cancel access_requests (service_desk)'),
  ('service_desk.knowledge.view','service_desk','knowledge','view','view knowledge (service_desk)'),
  ('service_desk.knowledge.create','service_desk','knowledge','create','create knowledge (service_desk)'),
  ('service_desk.knowledge.update','service_desk','knowledge','update','update knowledge (service_desk)'),
  ('service_desk.knowledge.delete','service_desk','knowledge','delete','delete knowledge (service_desk)'),
  ('service_desk.knowledge.submit','service_desk','knowledge','submit','submit knowledge (service_desk)'),
  ('service_desk.knowledge.approve','service_desk','knowledge','approve','approve knowledge (service_desk)'),
  ('service_desk.knowledge.publish','service_desk','knowledge','publish','publish knowledge (service_desk)'),
  ('service_desk.knowledge.archive','service_desk','knowledge','archive','archive knowledge (service_desk)'),
  ('service_desk.knowledge.rate','service_desk','knowledge','rate','rate knowledge (service_desk)'),
  ('service_desk.knowledge.manage','service_desk','knowledge','manage','manage knowledge (service_desk)'),
  ('service_desk.asset_scans.view','service_desk','asset_scans','view','view asset_scans (service_desk)'),
  ('service_desk.asset_scans.scan','service_desk','asset_scans','scan','scan asset_scans (service_desk)'),
  ('service_desk.asset_scans.report','service_desk','asset_scans','report','report asset_scans (service_desk)'),
  ('service_desk.assets.view','service_desk','assets','view','view assets (service_desk)'),
  ('service_desk.dashboards.employee','service_desk','dashboards','employee','employee dashboards (service_desk)'),
  ('service_desk.dashboards.agent','service_desk','dashboards','agent','agent dashboards (service_desk)'),
  ('service_desk.dashboards.manager','service_desk','dashboards','manager','manager dashboards (service_desk)'),
  ('service_desk.dashboards.executive','service_desk','dashboards','executive','executive dashboards (service_desk)'),
  ('service_desk.reports.view','service_desk','reports','view','view reports (service_desk)'),
  ('service_desk.reports.export','service_desk','reports','export','export reports (service_desk)'),
  ('service_desk.settings.view','service_desk','settings','view','view settings (service_desk)'),
  ('service_desk.settings.manage','service_desk','settings','manage','manage settings (service_desk)'),
  ('service_desk.audit.view','service_desk','audit','view','view audit (service_desk)'),
  ('service_desk.admin','service_desk','admin','admin','Administer the HOPE DESIGN Service Desk (taxonomy, queues, SLAs, escalation, settings)')
) AS v(code, module, resource, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

-- ---------------------------------------------------------------------------
-- 2. Service Desk roles, provisioned for every company that already has roles.
--    A migration-only deployment (SEED_ON_BOOT=false) must still get the roles;
--    `db:seed` reconciles the same definitions from the catalogue afterwards.
-- ---------------------------------------------------------------------------
INSERT INTO roles (tenant_id, company_id, code, name, description, is_system, is_customizable, permissions)
SELECT t.tenant_id, t.company_id, 'service_desk_agent', 'Service Desk Agent',
       'HOPE DESIGN Service Desk role (0151). Grants 37 permissions.', true, true, '["service_desk.command.view","service_desk.tickets.view","service_desk.tickets.create","service_desk.tickets.update","service_desk.tickets.reply","service_desk.tickets.assign","service_desk.tickets.resolve","service_desk.tickets.close","service_desk.tickets.reopen","service_desk.tickets.escalate","service_desk.tickets.print","service_desk.tickets.verify","service_desk.tickets.export","service_desk.internal_notes.view","service_desk.internal_notes.create","service_desk.queues.view","service_desk.teams.view","service_desk.categories.view","service_desk.assets.view","service_desk.asset_scans.view","service_desk.asset_scans.scan","service_desk.asset_scans.report","service_desk.knowledge.view","service_desk.knowledge.create","service_desk.knowledge.update","service_desk.knowledge.rate","service_desk.service_requests.view","service_desk.service_requests.update","service_desk.incidents.view","service_desk.incidents.update","service_desk.problems.view","service_desk.known_errors.view","service_desk.changes.view","service_desk.access_requests.view","service_desk.escalations.view","service_desk.dashboards.agent","service_desk.reports.view"]'::jsonb
FROM (SELECT DISTINCT tenant_id, company_id FROM roles WHERE company_id IS NOT NULL) t
WHERE NOT EXISTS (
  SELECT 1 FROM roles r WHERE r.tenant_id = t.tenant_id AND r.company_id = t.company_id AND r.code = 'service_desk_agent'
);

INSERT INTO roles (tenant_id, company_id, code, name, description, is_system, is_customizable, permissions)
SELECT t.tenant_id, t.company_id, 'service_desk_technician', 'Service Desk Technician',
       'HOPE DESIGN Service Desk role (0151). Grants 43 permissions.', true, true, '["service_desk.command.view","service_desk.tickets.view","service_desk.tickets.create","service_desk.tickets.update","service_desk.tickets.reply","service_desk.tickets.assign","service_desk.tickets.resolve","service_desk.tickets.close","service_desk.tickets.reopen","service_desk.tickets.escalate","service_desk.tickets.print","service_desk.internal_notes.view","service_desk.internal_notes.create","service_desk.queues.view","service_desk.teams.view","service_desk.skills.view","service_desk.categories.view","service_desk.assets.view","service_desk.asset_scans.view","service_desk.asset_scans.scan","service_desk.asset_scans.report","service_desk.knowledge.view","service_desk.knowledge.create","service_desk.knowledge.update","service_desk.knowledge.rate","service_desk.service_requests.view","service_desk.service_requests.update","service_desk.service_requests.fulfil","service_desk.incidents.view","service_desk.incidents.update","service_desk.incidents.resolve","service_desk.problems.view","service_desk.problems.update","service_desk.problems.investigate","service_desk.known_errors.view","service_desk.known_errors.create","service_desk.changes.view","service_desk.changes.update","service_desk.changes.implement","service_desk.access_requests.view","service_desk.escalations.view","service_desk.dashboards.agent","service_desk.reports.view"]'::jsonb
FROM (SELECT DISTINCT tenant_id, company_id FROM roles WHERE company_id IS NOT NULL) t
WHERE NOT EXISTS (
  SELECT 1 FROM roles r WHERE r.tenant_id = t.tenant_id AND r.company_id = t.company_id AND r.code = 'service_desk_technician'
);

INSERT INTO roles (tenant_id, company_id, code, name, description, is_system, is_customizable, permissions)
SELECT t.tenant_id, t.company_id, 'service_desk_manager', 'Service Desk Manager',
       'HOPE DESIGN Service Desk role (0151). Grants 113 permissions.', true, true, '["service_desk.command.view","service_desk.tickets.view","service_desk.tickets.view_own","service_desk.tickets.create","service_desk.tickets.update","service_desk.tickets.delete","service_desk.tickets.reply","service_desk.tickets.assign","service_desk.tickets.resolve","service_desk.tickets.close","service_desk.tickets.close_own","service_desk.tickets.reopen","service_desk.tickets.escalate","service_desk.tickets.export","service_desk.tickets.import","service_desk.tickets.print","service_desk.tickets.verify","service_desk.internal_notes.view","service_desk.internal_notes.create","service_desk.queues.view","service_desk.queues.create","service_desk.queues.update","service_desk.queues.delete","service_desk.teams.view","service_desk.teams.create","service_desk.teams.update","service_desk.teams.delete","service_desk.skills.view","service_desk.skills.create","service_desk.skills.update","service_desk.skills.delete","service_desk.categories.view","service_desk.categories.create","service_desk.categories.update","service_desk.categories.delete","service_desk.sla.view","service_desk.sla.manage","service_desk.escalations.view","service_desk.escalations.create","service_desk.escalations.update","service_desk.escalations.delete","service_desk.escalations.manage","service_desk.service_requests.view","service_desk.service_requests.create","service_desk.service_requests.update","service_desk.service_requests.approve","service_desk.service_requests.reject","service_desk.service_requests.fulfil","service_desk.service_requests.cancel","service_desk.incidents.view","service_desk.incidents.create","service_desk.incidents.update","service_desk.incidents.resolve","service_desk.incidents.close","service_desk.incidents.escalate","service_desk.problems.view","service_desk.problems.create","service_desk.problems.update","service_desk.problems.investigate","service_desk.problems.resolve","service_desk.problems.close","service_desk.known_errors.view","service_desk.known_errors.create","service_desk.known_errors.update","service_desk.known_errors.resolve","service_desk.known_errors.archive","service_desk.changes.view","service_desk.changes.create","service_desk.changes.update","service_desk.changes.submit","service_desk.changes.approve","service_desk.changes.reject","service_desk.changes.implement","service_desk.changes.validate","service_desk.changes.close","service_desk.changes.cancel","service_desk.change_approvals.view","service_desk.change_approvals.create","service_desk.change_approvals.approve","service_desk.change_approvals.reject","service_desk.access_requests.view","service_desk.access_requests.view_own","service_desk.access_requests.create","service_desk.access_requests.update","service_desk.access_requests.approve","service_desk.access_requests.reject","service_desk.access_requests.grant","service_desk.access_requests.revoke","service_desk.access_requests.cancel","service_desk.knowledge.view","service_desk.knowledge.create","service_desk.knowledge.update","service_desk.knowledge.delete","service_desk.knowledge.submit","service_desk.knowledge.approve","service_desk.knowledge.publish","service_desk.knowledge.archive","service_desk.knowledge.rate","service_desk.knowledge.manage","service_desk.assets.view","service_desk.asset_scans.view","service_desk.asset_scans.scan","service_desk.asset_scans.report","service_desk.dashboards.employee","service_desk.dashboards.agent","service_desk.dashboards.manager","service_desk.dashboards.executive","service_desk.reports.view","service_desk.reports.export","service_desk.settings.view","service_desk.settings.manage","service_desk.audit.view","service_desk.admin"]'::jsonb
FROM (SELECT DISTINCT tenant_id, company_id FROM roles WHERE company_id IS NOT NULL) t
WHERE NOT EXISTS (
  SELECT 1 FROM roles r WHERE r.tenant_id = t.tenant_id AND r.company_id = t.company_id AND r.code = 'service_desk_manager'
);

-- ---------------------------------------------------------------------------
-- 3. Grants for the Service Desk roles (explicit codes, no wildcards).
-- ---------------------------------------------------------------------------
-- service_desk_agent (37 permissions)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'service_desk.command.view', 'service_desk.tickets.view', 'service_desk.tickets.create', 'service_desk.tickets.update',
  'service_desk.tickets.reply', 'service_desk.tickets.assign', 'service_desk.tickets.resolve', 'service_desk.tickets.close',
  'service_desk.tickets.reopen', 'service_desk.tickets.escalate', 'service_desk.tickets.print', 'service_desk.tickets.verify',
  'service_desk.tickets.export', 'service_desk.internal_notes.view', 'service_desk.internal_notes.create', 'service_desk.queues.view',
  'service_desk.teams.view', 'service_desk.categories.view', 'service_desk.assets.view', 'service_desk.asset_scans.view',
  'service_desk.asset_scans.scan', 'service_desk.asset_scans.report', 'service_desk.knowledge.view', 'service_desk.knowledge.create',
  'service_desk.knowledge.update', 'service_desk.knowledge.rate', 'service_desk.service_requests.view', 'service_desk.service_requests.update',
  'service_desk.incidents.view', 'service_desk.incidents.update', 'service_desk.problems.view', 'service_desk.known_errors.view',
  'service_desk.changes.view', 'service_desk.access_requests.view', 'service_desk.escalations.view', 'service_desk.dashboards.agent',
  'service_desk.reports.view'
])
WHERE r.code = 'service_desk_agent'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- service_desk_technician (43 permissions)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'service_desk.command.view', 'service_desk.tickets.view', 'service_desk.tickets.create', 'service_desk.tickets.update',
  'service_desk.tickets.reply', 'service_desk.tickets.assign', 'service_desk.tickets.resolve', 'service_desk.tickets.close',
  'service_desk.tickets.reopen', 'service_desk.tickets.escalate', 'service_desk.tickets.print', 'service_desk.internal_notes.view',
  'service_desk.internal_notes.create', 'service_desk.queues.view', 'service_desk.teams.view', 'service_desk.skills.view',
  'service_desk.categories.view', 'service_desk.assets.view', 'service_desk.asset_scans.view', 'service_desk.asset_scans.scan',
  'service_desk.asset_scans.report', 'service_desk.knowledge.view', 'service_desk.knowledge.create', 'service_desk.knowledge.update',
  'service_desk.knowledge.rate', 'service_desk.service_requests.view', 'service_desk.service_requests.update', 'service_desk.service_requests.fulfil',
  'service_desk.incidents.view', 'service_desk.incidents.update', 'service_desk.incidents.resolve', 'service_desk.problems.view',
  'service_desk.problems.update', 'service_desk.problems.investigate', 'service_desk.known_errors.view', 'service_desk.known_errors.create',
  'service_desk.changes.view', 'service_desk.changes.update', 'service_desk.changes.implement', 'service_desk.access_requests.view',
  'service_desk.escalations.view', 'service_desk.dashboards.agent', 'service_desk.reports.view'
])
WHERE r.code = 'service_desk_technician'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- service_desk_manager (113 permissions)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'service_desk.command.view', 'service_desk.tickets.view', 'service_desk.tickets.view_own', 'service_desk.tickets.create',
  'service_desk.tickets.update', 'service_desk.tickets.delete', 'service_desk.tickets.reply', 'service_desk.tickets.assign',
  'service_desk.tickets.resolve', 'service_desk.tickets.close', 'service_desk.tickets.close_own', 'service_desk.tickets.reopen',
  'service_desk.tickets.escalate', 'service_desk.tickets.export', 'service_desk.tickets.import', 'service_desk.tickets.print',
  'service_desk.tickets.verify', 'service_desk.internal_notes.view', 'service_desk.internal_notes.create', 'service_desk.queues.view',
  'service_desk.queues.create', 'service_desk.queues.update', 'service_desk.queues.delete', 'service_desk.teams.view',
  'service_desk.teams.create', 'service_desk.teams.update', 'service_desk.teams.delete', 'service_desk.skills.view',
  'service_desk.skills.create', 'service_desk.skills.update', 'service_desk.skills.delete', 'service_desk.categories.view',
  'service_desk.categories.create', 'service_desk.categories.update', 'service_desk.categories.delete', 'service_desk.sla.view',
  'service_desk.sla.manage', 'service_desk.escalations.view', 'service_desk.escalations.create', 'service_desk.escalations.update',
  'service_desk.escalations.delete', 'service_desk.escalations.manage', 'service_desk.service_requests.view', 'service_desk.service_requests.create',
  'service_desk.service_requests.update', 'service_desk.service_requests.approve', 'service_desk.service_requests.reject', 'service_desk.service_requests.fulfil',
  'service_desk.service_requests.cancel', 'service_desk.incidents.view', 'service_desk.incidents.create', 'service_desk.incidents.update',
  'service_desk.incidents.resolve', 'service_desk.incidents.close', 'service_desk.incidents.escalate', 'service_desk.problems.view',
  'service_desk.problems.create', 'service_desk.problems.update', 'service_desk.problems.investigate', 'service_desk.problems.resolve',
  'service_desk.problems.close', 'service_desk.known_errors.view', 'service_desk.known_errors.create', 'service_desk.known_errors.update',
  'service_desk.known_errors.resolve', 'service_desk.known_errors.archive', 'service_desk.changes.view', 'service_desk.changes.create',
  'service_desk.changes.update', 'service_desk.changes.submit', 'service_desk.changes.approve', 'service_desk.changes.reject',
  'service_desk.changes.implement', 'service_desk.changes.validate', 'service_desk.changes.close', 'service_desk.changes.cancel',
  'service_desk.change_approvals.view', 'service_desk.change_approvals.create', 'service_desk.change_approvals.approve', 'service_desk.change_approvals.reject',
  'service_desk.access_requests.view', 'service_desk.access_requests.view_own', 'service_desk.access_requests.create', 'service_desk.access_requests.update',
  'service_desk.access_requests.approve', 'service_desk.access_requests.reject', 'service_desk.access_requests.grant', 'service_desk.access_requests.revoke',
  'service_desk.access_requests.cancel', 'service_desk.knowledge.view', 'service_desk.knowledge.create', 'service_desk.knowledge.update',
  'service_desk.knowledge.delete', 'service_desk.knowledge.submit', 'service_desk.knowledge.approve', 'service_desk.knowledge.publish',
  'service_desk.knowledge.archive', 'service_desk.knowledge.rate', 'service_desk.knowledge.manage', 'service_desk.assets.view',
  'service_desk.asset_scans.view', 'service_desk.asset_scans.scan', 'service_desk.asset_scans.report', 'service_desk.dashboards.employee',
  'service_desk.dashboards.agent', 'service_desk.dashboards.manager', 'service_desk.dashboards.executive', 'service_desk.reports.view',
  'service_desk.reports.export', 'service_desk.settings.view', 'service_desk.settings.manage', 'service_desk.audit.view',
  'service_desk.admin'
])
WHERE r.code = 'service_desk_manager'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Service Desk capability for pre-existing roles.
-- ---------------------------------------------------------------------------
-- super_administrator (113 permissions)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'service_desk.command.view', 'service_desk.tickets.view', 'service_desk.tickets.view_own', 'service_desk.tickets.create',
  'service_desk.tickets.update', 'service_desk.tickets.delete', 'service_desk.tickets.reply', 'service_desk.tickets.assign',
  'service_desk.tickets.resolve', 'service_desk.tickets.close', 'service_desk.tickets.close_own', 'service_desk.tickets.reopen',
  'service_desk.tickets.escalate', 'service_desk.tickets.export', 'service_desk.tickets.import', 'service_desk.tickets.print',
  'service_desk.tickets.verify', 'service_desk.internal_notes.view', 'service_desk.internal_notes.create', 'service_desk.queues.view',
  'service_desk.queues.create', 'service_desk.queues.update', 'service_desk.queues.delete', 'service_desk.teams.view',
  'service_desk.teams.create', 'service_desk.teams.update', 'service_desk.teams.delete', 'service_desk.skills.view',
  'service_desk.skills.create', 'service_desk.skills.update', 'service_desk.skills.delete', 'service_desk.categories.view',
  'service_desk.categories.create', 'service_desk.categories.update', 'service_desk.categories.delete', 'service_desk.sla.view',
  'service_desk.sla.manage', 'service_desk.escalations.view', 'service_desk.escalations.create', 'service_desk.escalations.update',
  'service_desk.escalations.delete', 'service_desk.escalations.manage', 'service_desk.service_requests.view', 'service_desk.service_requests.create',
  'service_desk.service_requests.update', 'service_desk.service_requests.approve', 'service_desk.service_requests.reject', 'service_desk.service_requests.fulfil',
  'service_desk.service_requests.cancel', 'service_desk.incidents.view', 'service_desk.incidents.create', 'service_desk.incidents.update',
  'service_desk.incidents.resolve', 'service_desk.incidents.close', 'service_desk.incidents.escalate', 'service_desk.problems.view',
  'service_desk.problems.create', 'service_desk.problems.update', 'service_desk.problems.investigate', 'service_desk.problems.resolve',
  'service_desk.problems.close', 'service_desk.known_errors.view', 'service_desk.known_errors.create', 'service_desk.known_errors.update',
  'service_desk.known_errors.resolve', 'service_desk.known_errors.archive', 'service_desk.changes.view', 'service_desk.changes.create',
  'service_desk.changes.update', 'service_desk.changes.submit', 'service_desk.changes.approve', 'service_desk.changes.reject',
  'service_desk.changes.implement', 'service_desk.changes.validate', 'service_desk.changes.close', 'service_desk.changes.cancel',
  'service_desk.change_approvals.view', 'service_desk.change_approvals.create', 'service_desk.change_approvals.approve', 'service_desk.change_approvals.reject',
  'service_desk.access_requests.view', 'service_desk.access_requests.view_own', 'service_desk.access_requests.create', 'service_desk.access_requests.update',
  'service_desk.access_requests.approve', 'service_desk.access_requests.reject', 'service_desk.access_requests.grant', 'service_desk.access_requests.revoke',
  'service_desk.access_requests.cancel', 'service_desk.knowledge.view', 'service_desk.knowledge.create', 'service_desk.knowledge.update',
  'service_desk.knowledge.delete', 'service_desk.knowledge.submit', 'service_desk.knowledge.approve', 'service_desk.knowledge.publish',
  'service_desk.knowledge.archive', 'service_desk.knowledge.rate', 'service_desk.knowledge.manage', 'service_desk.asset_scans.view',
  'service_desk.asset_scans.scan', 'service_desk.asset_scans.report', 'service_desk.assets.view', 'service_desk.dashboards.employee',
  'service_desk.dashboards.agent', 'service_desk.dashboards.manager', 'service_desk.dashboards.executive', 'service_desk.reports.view',
  'service_desk.reports.export', 'service_desk.settings.view', 'service_desk.settings.manage', 'service_desk.audit.view',
  'service_desk.admin'
])
WHERE r.code = 'super_administrator'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ceo (113 permissions)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'service_desk.command.view', 'service_desk.tickets.view', 'service_desk.tickets.view_own', 'service_desk.tickets.create',
  'service_desk.tickets.update', 'service_desk.tickets.delete', 'service_desk.tickets.reply', 'service_desk.tickets.assign',
  'service_desk.tickets.resolve', 'service_desk.tickets.close', 'service_desk.tickets.close_own', 'service_desk.tickets.reopen',
  'service_desk.tickets.escalate', 'service_desk.tickets.export', 'service_desk.tickets.import', 'service_desk.tickets.print',
  'service_desk.tickets.verify', 'service_desk.internal_notes.view', 'service_desk.internal_notes.create', 'service_desk.queues.view',
  'service_desk.queues.create', 'service_desk.queues.update', 'service_desk.queues.delete', 'service_desk.teams.view',
  'service_desk.teams.create', 'service_desk.teams.update', 'service_desk.teams.delete', 'service_desk.skills.view',
  'service_desk.skills.create', 'service_desk.skills.update', 'service_desk.skills.delete', 'service_desk.categories.view',
  'service_desk.categories.create', 'service_desk.categories.update', 'service_desk.categories.delete', 'service_desk.sla.view',
  'service_desk.sla.manage', 'service_desk.escalations.view', 'service_desk.escalations.create', 'service_desk.escalations.update',
  'service_desk.escalations.delete', 'service_desk.escalations.manage', 'service_desk.service_requests.view', 'service_desk.service_requests.create',
  'service_desk.service_requests.update', 'service_desk.service_requests.approve', 'service_desk.service_requests.reject', 'service_desk.service_requests.fulfil',
  'service_desk.service_requests.cancel', 'service_desk.incidents.view', 'service_desk.incidents.create', 'service_desk.incidents.update',
  'service_desk.incidents.resolve', 'service_desk.incidents.close', 'service_desk.incidents.escalate', 'service_desk.problems.view',
  'service_desk.problems.create', 'service_desk.problems.update', 'service_desk.problems.investigate', 'service_desk.problems.resolve',
  'service_desk.problems.close', 'service_desk.known_errors.view', 'service_desk.known_errors.create', 'service_desk.known_errors.update',
  'service_desk.known_errors.resolve', 'service_desk.known_errors.archive', 'service_desk.changes.view', 'service_desk.changes.create',
  'service_desk.changes.update', 'service_desk.changes.submit', 'service_desk.changes.approve', 'service_desk.changes.reject',
  'service_desk.changes.implement', 'service_desk.changes.validate', 'service_desk.changes.close', 'service_desk.changes.cancel',
  'service_desk.change_approvals.view', 'service_desk.change_approvals.create', 'service_desk.change_approvals.approve', 'service_desk.change_approvals.reject',
  'service_desk.access_requests.view', 'service_desk.access_requests.view_own', 'service_desk.access_requests.create', 'service_desk.access_requests.update',
  'service_desk.access_requests.approve', 'service_desk.access_requests.reject', 'service_desk.access_requests.grant', 'service_desk.access_requests.revoke',
  'service_desk.access_requests.cancel', 'service_desk.knowledge.view', 'service_desk.knowledge.create', 'service_desk.knowledge.update',
  'service_desk.knowledge.delete', 'service_desk.knowledge.submit', 'service_desk.knowledge.approve', 'service_desk.knowledge.publish',
  'service_desk.knowledge.archive', 'service_desk.knowledge.rate', 'service_desk.knowledge.manage', 'service_desk.asset_scans.view',
  'service_desk.asset_scans.scan', 'service_desk.asset_scans.report', 'service_desk.assets.view', 'service_desk.dashboards.employee',
  'service_desk.dashboards.agent', 'service_desk.dashboards.manager', 'service_desk.dashboards.executive', 'service_desk.reports.view',
  'service_desk.reports.export', 'service_desk.settings.view', 'service_desk.settings.manage', 'service_desk.audit.view',
  'service_desk.admin'
])
WHERE r.code = 'ceo'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- managing_director (113 permissions)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'service_desk.command.view', 'service_desk.tickets.view', 'service_desk.tickets.view_own', 'service_desk.tickets.create',
  'service_desk.tickets.update', 'service_desk.tickets.delete', 'service_desk.tickets.reply', 'service_desk.tickets.assign',
  'service_desk.tickets.resolve', 'service_desk.tickets.close', 'service_desk.tickets.close_own', 'service_desk.tickets.reopen',
  'service_desk.tickets.escalate', 'service_desk.tickets.export', 'service_desk.tickets.import', 'service_desk.tickets.print',
  'service_desk.tickets.verify', 'service_desk.internal_notes.view', 'service_desk.internal_notes.create', 'service_desk.queues.view',
  'service_desk.queues.create', 'service_desk.queues.update', 'service_desk.queues.delete', 'service_desk.teams.view',
  'service_desk.teams.create', 'service_desk.teams.update', 'service_desk.teams.delete', 'service_desk.skills.view',
  'service_desk.skills.create', 'service_desk.skills.update', 'service_desk.skills.delete', 'service_desk.categories.view',
  'service_desk.categories.create', 'service_desk.categories.update', 'service_desk.categories.delete', 'service_desk.sla.view',
  'service_desk.sla.manage', 'service_desk.escalations.view', 'service_desk.escalations.create', 'service_desk.escalations.update',
  'service_desk.escalations.delete', 'service_desk.escalations.manage', 'service_desk.service_requests.view', 'service_desk.service_requests.create',
  'service_desk.service_requests.update', 'service_desk.service_requests.approve', 'service_desk.service_requests.reject', 'service_desk.service_requests.fulfil',
  'service_desk.service_requests.cancel', 'service_desk.incidents.view', 'service_desk.incidents.create', 'service_desk.incidents.update',
  'service_desk.incidents.resolve', 'service_desk.incidents.close', 'service_desk.incidents.escalate', 'service_desk.problems.view',
  'service_desk.problems.create', 'service_desk.problems.update', 'service_desk.problems.investigate', 'service_desk.problems.resolve',
  'service_desk.problems.close', 'service_desk.known_errors.view', 'service_desk.known_errors.create', 'service_desk.known_errors.update',
  'service_desk.known_errors.resolve', 'service_desk.known_errors.archive', 'service_desk.changes.view', 'service_desk.changes.create',
  'service_desk.changes.update', 'service_desk.changes.submit', 'service_desk.changes.approve', 'service_desk.changes.reject',
  'service_desk.changes.implement', 'service_desk.changes.validate', 'service_desk.changes.close', 'service_desk.changes.cancel',
  'service_desk.change_approvals.view', 'service_desk.change_approvals.create', 'service_desk.change_approvals.approve', 'service_desk.change_approvals.reject',
  'service_desk.access_requests.view', 'service_desk.access_requests.view_own', 'service_desk.access_requests.create', 'service_desk.access_requests.update',
  'service_desk.access_requests.approve', 'service_desk.access_requests.reject', 'service_desk.access_requests.grant', 'service_desk.access_requests.revoke',
  'service_desk.access_requests.cancel', 'service_desk.knowledge.view', 'service_desk.knowledge.create', 'service_desk.knowledge.update',
  'service_desk.knowledge.delete', 'service_desk.knowledge.submit', 'service_desk.knowledge.approve', 'service_desk.knowledge.publish',
  'service_desk.knowledge.archive', 'service_desk.knowledge.rate', 'service_desk.knowledge.manage', 'service_desk.asset_scans.view',
  'service_desk.asset_scans.scan', 'service_desk.asset_scans.report', 'service_desk.assets.view', 'service_desk.dashboards.employee',
  'service_desk.dashboards.agent', 'service_desk.dashboards.manager', 'service_desk.dashboards.executive', 'service_desk.reports.view',
  'service_desk.reports.export', 'service_desk.settings.view', 'service_desk.settings.manage', 'service_desk.audit.view',
  'service_desk.admin'
])
WHERE r.code = 'managing_director'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- executive_director (113 permissions)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'service_desk.command.view', 'service_desk.tickets.view', 'service_desk.tickets.view_own', 'service_desk.tickets.create',
  'service_desk.tickets.update', 'service_desk.tickets.delete', 'service_desk.tickets.reply', 'service_desk.tickets.assign',
  'service_desk.tickets.resolve', 'service_desk.tickets.close', 'service_desk.tickets.close_own', 'service_desk.tickets.reopen',
  'service_desk.tickets.escalate', 'service_desk.tickets.export', 'service_desk.tickets.import', 'service_desk.tickets.print',
  'service_desk.tickets.verify', 'service_desk.internal_notes.view', 'service_desk.internal_notes.create', 'service_desk.queues.view',
  'service_desk.queues.create', 'service_desk.queues.update', 'service_desk.queues.delete', 'service_desk.teams.view',
  'service_desk.teams.create', 'service_desk.teams.update', 'service_desk.teams.delete', 'service_desk.skills.view',
  'service_desk.skills.create', 'service_desk.skills.update', 'service_desk.skills.delete', 'service_desk.categories.view',
  'service_desk.categories.create', 'service_desk.categories.update', 'service_desk.categories.delete', 'service_desk.sla.view',
  'service_desk.sla.manage', 'service_desk.escalations.view', 'service_desk.escalations.create', 'service_desk.escalations.update',
  'service_desk.escalations.delete', 'service_desk.escalations.manage', 'service_desk.service_requests.view', 'service_desk.service_requests.create',
  'service_desk.service_requests.update', 'service_desk.service_requests.approve', 'service_desk.service_requests.reject', 'service_desk.service_requests.fulfil',
  'service_desk.service_requests.cancel', 'service_desk.incidents.view', 'service_desk.incidents.create', 'service_desk.incidents.update',
  'service_desk.incidents.resolve', 'service_desk.incidents.close', 'service_desk.incidents.escalate', 'service_desk.problems.view',
  'service_desk.problems.create', 'service_desk.problems.update', 'service_desk.problems.investigate', 'service_desk.problems.resolve',
  'service_desk.problems.close', 'service_desk.known_errors.view', 'service_desk.known_errors.create', 'service_desk.known_errors.update',
  'service_desk.known_errors.resolve', 'service_desk.known_errors.archive', 'service_desk.changes.view', 'service_desk.changes.create',
  'service_desk.changes.update', 'service_desk.changes.submit', 'service_desk.changes.approve', 'service_desk.changes.reject',
  'service_desk.changes.implement', 'service_desk.changes.validate', 'service_desk.changes.close', 'service_desk.changes.cancel',
  'service_desk.change_approvals.view', 'service_desk.change_approvals.create', 'service_desk.change_approvals.approve', 'service_desk.change_approvals.reject',
  'service_desk.access_requests.view', 'service_desk.access_requests.view_own', 'service_desk.access_requests.create', 'service_desk.access_requests.update',
  'service_desk.access_requests.approve', 'service_desk.access_requests.reject', 'service_desk.access_requests.grant', 'service_desk.access_requests.revoke',
  'service_desk.access_requests.cancel', 'service_desk.knowledge.view', 'service_desk.knowledge.create', 'service_desk.knowledge.update',
  'service_desk.knowledge.delete', 'service_desk.knowledge.submit', 'service_desk.knowledge.approve', 'service_desk.knowledge.publish',
  'service_desk.knowledge.archive', 'service_desk.knowledge.rate', 'service_desk.knowledge.manage', 'service_desk.asset_scans.view',
  'service_desk.asset_scans.scan', 'service_desk.asset_scans.report', 'service_desk.assets.view', 'service_desk.dashboards.employee',
  'service_desk.dashboards.agent', 'service_desk.dashboards.manager', 'service_desk.dashboards.executive', 'service_desk.reports.view',
  'service_desk.reports.export', 'service_desk.settings.view', 'service_desk.settings.manage', 'service_desk.audit.view',
  'service_desk.admin'
])
WHERE r.code = 'executive_director'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- general_manager (113 permissions)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'service_desk.command.view', 'service_desk.tickets.view', 'service_desk.tickets.view_own', 'service_desk.tickets.create',
  'service_desk.tickets.update', 'service_desk.tickets.delete', 'service_desk.tickets.reply', 'service_desk.tickets.assign',
  'service_desk.tickets.resolve', 'service_desk.tickets.close', 'service_desk.tickets.close_own', 'service_desk.tickets.reopen',
  'service_desk.tickets.escalate', 'service_desk.tickets.export', 'service_desk.tickets.import', 'service_desk.tickets.print',
  'service_desk.tickets.verify', 'service_desk.internal_notes.view', 'service_desk.internal_notes.create', 'service_desk.queues.view',
  'service_desk.queues.create', 'service_desk.queues.update', 'service_desk.queues.delete', 'service_desk.teams.view',
  'service_desk.teams.create', 'service_desk.teams.update', 'service_desk.teams.delete', 'service_desk.skills.view',
  'service_desk.skills.create', 'service_desk.skills.update', 'service_desk.skills.delete', 'service_desk.categories.view',
  'service_desk.categories.create', 'service_desk.categories.update', 'service_desk.categories.delete', 'service_desk.sla.view',
  'service_desk.sla.manage', 'service_desk.escalations.view', 'service_desk.escalations.create', 'service_desk.escalations.update',
  'service_desk.escalations.delete', 'service_desk.escalations.manage', 'service_desk.service_requests.view', 'service_desk.service_requests.create',
  'service_desk.service_requests.update', 'service_desk.service_requests.approve', 'service_desk.service_requests.reject', 'service_desk.service_requests.fulfil',
  'service_desk.service_requests.cancel', 'service_desk.incidents.view', 'service_desk.incidents.create', 'service_desk.incidents.update',
  'service_desk.incidents.resolve', 'service_desk.incidents.close', 'service_desk.incidents.escalate', 'service_desk.problems.view',
  'service_desk.problems.create', 'service_desk.problems.update', 'service_desk.problems.investigate', 'service_desk.problems.resolve',
  'service_desk.problems.close', 'service_desk.known_errors.view', 'service_desk.known_errors.create', 'service_desk.known_errors.update',
  'service_desk.known_errors.resolve', 'service_desk.known_errors.archive', 'service_desk.changes.view', 'service_desk.changes.create',
  'service_desk.changes.update', 'service_desk.changes.submit', 'service_desk.changes.approve', 'service_desk.changes.reject',
  'service_desk.changes.implement', 'service_desk.changes.validate', 'service_desk.changes.close', 'service_desk.changes.cancel',
  'service_desk.change_approvals.view', 'service_desk.change_approvals.create', 'service_desk.change_approvals.approve', 'service_desk.change_approvals.reject',
  'service_desk.access_requests.view', 'service_desk.access_requests.view_own', 'service_desk.access_requests.create', 'service_desk.access_requests.update',
  'service_desk.access_requests.approve', 'service_desk.access_requests.reject', 'service_desk.access_requests.grant', 'service_desk.access_requests.revoke',
  'service_desk.access_requests.cancel', 'service_desk.knowledge.view', 'service_desk.knowledge.create', 'service_desk.knowledge.update',
  'service_desk.knowledge.delete', 'service_desk.knowledge.submit', 'service_desk.knowledge.approve', 'service_desk.knowledge.publish',
  'service_desk.knowledge.archive', 'service_desk.knowledge.rate', 'service_desk.knowledge.manage', 'service_desk.asset_scans.view',
  'service_desk.asset_scans.scan', 'service_desk.asset_scans.report', 'service_desk.assets.view', 'service_desk.dashboards.employee',
  'service_desk.dashboards.agent', 'service_desk.dashboards.manager', 'service_desk.dashboards.executive', 'service_desk.reports.view',
  'service_desk.reports.export', 'service_desk.settings.view', 'service_desk.settings.manage', 'service_desk.audit.view',
  'service_desk.admin'
])
WHERE r.code = 'general_manager'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- system_administrator (113 permissions)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'service_desk.command.view', 'service_desk.tickets.view', 'service_desk.tickets.view_own', 'service_desk.tickets.create',
  'service_desk.tickets.update', 'service_desk.tickets.delete', 'service_desk.tickets.reply', 'service_desk.tickets.assign',
  'service_desk.tickets.resolve', 'service_desk.tickets.close', 'service_desk.tickets.close_own', 'service_desk.tickets.reopen',
  'service_desk.tickets.escalate', 'service_desk.tickets.export', 'service_desk.tickets.import', 'service_desk.tickets.print',
  'service_desk.tickets.verify', 'service_desk.internal_notes.view', 'service_desk.internal_notes.create', 'service_desk.queues.view',
  'service_desk.queues.create', 'service_desk.queues.update', 'service_desk.queues.delete', 'service_desk.teams.view',
  'service_desk.teams.create', 'service_desk.teams.update', 'service_desk.teams.delete', 'service_desk.skills.view',
  'service_desk.skills.create', 'service_desk.skills.update', 'service_desk.skills.delete', 'service_desk.categories.view',
  'service_desk.categories.create', 'service_desk.categories.update', 'service_desk.categories.delete', 'service_desk.sla.view',
  'service_desk.sla.manage', 'service_desk.escalations.view', 'service_desk.escalations.create', 'service_desk.escalations.update',
  'service_desk.escalations.delete', 'service_desk.escalations.manage', 'service_desk.service_requests.view', 'service_desk.service_requests.create',
  'service_desk.service_requests.update', 'service_desk.service_requests.approve', 'service_desk.service_requests.reject', 'service_desk.service_requests.fulfil',
  'service_desk.service_requests.cancel', 'service_desk.incidents.view', 'service_desk.incidents.create', 'service_desk.incidents.update',
  'service_desk.incidents.resolve', 'service_desk.incidents.close', 'service_desk.incidents.escalate', 'service_desk.problems.view',
  'service_desk.problems.create', 'service_desk.problems.update', 'service_desk.problems.investigate', 'service_desk.problems.resolve',
  'service_desk.problems.close', 'service_desk.known_errors.view', 'service_desk.known_errors.create', 'service_desk.known_errors.update',
  'service_desk.known_errors.resolve', 'service_desk.known_errors.archive', 'service_desk.changes.view', 'service_desk.changes.create',
  'service_desk.changes.update', 'service_desk.changes.submit', 'service_desk.changes.approve', 'service_desk.changes.reject',
  'service_desk.changes.implement', 'service_desk.changes.validate', 'service_desk.changes.close', 'service_desk.changes.cancel',
  'service_desk.change_approvals.view', 'service_desk.change_approvals.create', 'service_desk.change_approvals.approve', 'service_desk.change_approvals.reject',
  'service_desk.access_requests.view', 'service_desk.access_requests.view_own', 'service_desk.access_requests.create', 'service_desk.access_requests.update',
  'service_desk.access_requests.approve', 'service_desk.access_requests.reject', 'service_desk.access_requests.grant', 'service_desk.access_requests.revoke',
  'service_desk.access_requests.cancel', 'service_desk.knowledge.view', 'service_desk.knowledge.create', 'service_desk.knowledge.update',
  'service_desk.knowledge.delete', 'service_desk.knowledge.submit', 'service_desk.knowledge.approve', 'service_desk.knowledge.publish',
  'service_desk.knowledge.archive', 'service_desk.knowledge.rate', 'service_desk.knowledge.manage', 'service_desk.asset_scans.view',
  'service_desk.asset_scans.scan', 'service_desk.asset_scans.report', 'service_desk.assets.view', 'service_desk.dashboards.employee',
  'service_desk.dashboards.agent', 'service_desk.dashboards.manager', 'service_desk.dashboards.executive', 'service_desk.reports.view',
  'service_desk.reports.export', 'service_desk.settings.view', 'service_desk.settings.manage', 'service_desk.audit.view',
  'service_desk.admin'
])
WHERE r.code = 'system_administrator'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- it_support_administrator (113 permissions)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'service_desk.command.view', 'service_desk.tickets.view', 'service_desk.tickets.view_own', 'service_desk.tickets.create',
  'service_desk.tickets.update', 'service_desk.tickets.delete', 'service_desk.tickets.reply', 'service_desk.tickets.assign',
  'service_desk.tickets.resolve', 'service_desk.tickets.close', 'service_desk.tickets.close_own', 'service_desk.tickets.reopen',
  'service_desk.tickets.escalate', 'service_desk.tickets.export', 'service_desk.tickets.import', 'service_desk.tickets.print',
  'service_desk.tickets.verify', 'service_desk.internal_notes.view', 'service_desk.internal_notes.create', 'service_desk.queues.view',
  'service_desk.queues.create', 'service_desk.queues.update', 'service_desk.queues.delete', 'service_desk.teams.view',
  'service_desk.teams.create', 'service_desk.teams.update', 'service_desk.teams.delete', 'service_desk.skills.view',
  'service_desk.skills.create', 'service_desk.skills.update', 'service_desk.skills.delete', 'service_desk.categories.view',
  'service_desk.categories.create', 'service_desk.categories.update', 'service_desk.categories.delete', 'service_desk.sla.view',
  'service_desk.sla.manage', 'service_desk.escalations.view', 'service_desk.escalations.create', 'service_desk.escalations.update',
  'service_desk.escalations.delete', 'service_desk.escalations.manage', 'service_desk.service_requests.view', 'service_desk.service_requests.create',
  'service_desk.service_requests.update', 'service_desk.service_requests.approve', 'service_desk.service_requests.reject', 'service_desk.service_requests.fulfil',
  'service_desk.service_requests.cancel', 'service_desk.incidents.view', 'service_desk.incidents.create', 'service_desk.incidents.update',
  'service_desk.incidents.resolve', 'service_desk.incidents.close', 'service_desk.incidents.escalate', 'service_desk.problems.view',
  'service_desk.problems.create', 'service_desk.problems.update', 'service_desk.problems.investigate', 'service_desk.problems.resolve',
  'service_desk.problems.close', 'service_desk.known_errors.view', 'service_desk.known_errors.create', 'service_desk.known_errors.update',
  'service_desk.known_errors.resolve', 'service_desk.known_errors.archive', 'service_desk.changes.view', 'service_desk.changes.create',
  'service_desk.changes.update', 'service_desk.changes.submit', 'service_desk.changes.approve', 'service_desk.changes.reject',
  'service_desk.changes.implement', 'service_desk.changes.validate', 'service_desk.changes.close', 'service_desk.changes.cancel',
  'service_desk.change_approvals.view', 'service_desk.change_approvals.create', 'service_desk.change_approvals.approve', 'service_desk.change_approvals.reject',
  'service_desk.access_requests.view', 'service_desk.access_requests.view_own', 'service_desk.access_requests.create', 'service_desk.access_requests.update',
  'service_desk.access_requests.approve', 'service_desk.access_requests.reject', 'service_desk.access_requests.grant', 'service_desk.access_requests.revoke',
  'service_desk.access_requests.cancel', 'service_desk.knowledge.view', 'service_desk.knowledge.create', 'service_desk.knowledge.update',
  'service_desk.knowledge.delete', 'service_desk.knowledge.submit', 'service_desk.knowledge.approve', 'service_desk.knowledge.publish',
  'service_desk.knowledge.archive', 'service_desk.knowledge.rate', 'service_desk.knowledge.manage', 'service_desk.asset_scans.view',
  'service_desk.asset_scans.scan', 'service_desk.asset_scans.report', 'service_desk.assets.view', 'service_desk.dashboards.employee',
  'service_desk.dashboards.agent', 'service_desk.dashboards.manager', 'service_desk.dashboards.executive', 'service_desk.reports.view',
  'service_desk.reports.export', 'service_desk.settings.view', 'service_desk.settings.manage', 'service_desk.audit.view',
  'service_desk.admin'
])
WHERE r.code = 'it_support_administrator'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- security_administrator (13 permissions)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'service_desk.command.view', 'service_desk.tickets.view', 'service_desk.tickets.escalate', 'service_desk.internal_notes.view',
  'service_desk.incidents.view', 'service_desk.incidents.create', 'service_desk.incidents.update', 'service_desk.incidents.resolve',
  'service_desk.incidents.close', 'service_desk.incidents.escalate', 'service_desk.asset_scans.view', 'service_desk.audit.view',
  'service_desk.dashboards.manager'
])
WHERE r.code = 'security_administrator'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- operations_director (20 permissions)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'service_desk.command.view', 'service_desk.tickets.view', 'service_desk.tickets.escalate', 'service_desk.internal_notes.view',
  'service_desk.incidents.view', 'service_desk.incidents.create', 'service_desk.incidents.update', 'service_desk.incidents.resolve',
  'service_desk.incidents.close', 'service_desk.incidents.escalate', 'service_desk.problems.view', 'service_desk.changes.view',
  'service_desk.escalations.view', 'service_desk.asset_scans.view', 'service_desk.dashboards.employee', 'service_desk.dashboards.agent',
  'service_desk.dashboards.manager', 'service_desk.dashboards.executive', 'service_desk.reports.view', 'service_desk.reports.export'
])
WHERE r.code = 'operations_director'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- hr_manager (4 permissions)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'service_desk.command.view', 'service_desk.tickets.view_own', 'service_desk.tickets.create', 'service_desk.tickets.reply'
])
WHERE r.code = 'hr_manager'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- employee_self_service (13 permissions)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'service_desk.command.view', 'service_desk.tickets.view_own', 'service_desk.tickets.create', 'service_desk.tickets.reply',
  'service_desk.tickets.close_own', 'service_desk.tickets.verify', 'service_desk.knowledge.view', 'service_desk.knowledge.rate',
  'service_desk.asset_scans.view', 'service_desk.asset_scans.scan', 'service_desk.access_requests.view_own', 'service_desk.access_requests.create',
  'service_desk.dashboards.employee'
])
WHERE r.code = 'employee_self_service'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. Verification helper: counts for the standard HDG tenant.
-- ---------------------------------------------------------------------------
-- SELECT module, count(*) FROM permissions WHERE module = 'service_desk' GROUP BY module;
-- SELECT r.code, count(*) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
--   JOIN permissions p ON p.id = rp.permission_id WHERE p.module = 'service_desk' GROUP BY r.code ORDER BY r.code;
