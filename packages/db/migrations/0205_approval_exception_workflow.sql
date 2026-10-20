-- ===========================================================================
-- 0205 - Controlled approval exceptions: fields + RBAC + role grants
--
-- 0203 created the approval_exceptions ledger (APR-9) but only as a table; no
-- application surface could write to it and the prompt's required fields
-- (applicable scope, expiry, compensating control) were missing. This
-- migration completes the ledger and makes it usable from the API.
--
-- Additive only. No destructive change, no data mutation, no runtime rule
-- bypass. Exceptions remain a recorded, independently-reviewed, time-boxed
-- deviation - the engine's self-approval / segregation-of-duties checks in
-- decideTask are unchanged and are never silently overridden by this table.
--
-- No BEGIN/COMMIT and no schema_migrations row - migrate.js owns both.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Required exception fields (prompt Phase 6): scope, expiry, compensating
--    control. Nullable so existing rows (none today) and future partial drafts
--    never break; the service layer requires them before an exception is
--    authorised.
-- ---------------------------------------------------------------------------
ALTER TABLE approval_exceptions
  ADD COLUMN scope                text,
  ADD COLUMN expires_at           date,
  ADD COLUMN compensating_control text;

-- ---------------------------------------------------------------------------
-- 2. RBAC catalogue entries (mirrored in packages/db/src/catalogue.js so a
--    re-seed reproduces the same codes).
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, module, resource, action, description)
SELECT 'workflows.exceptions.' || v.action, 'workflows', 'exceptions', v.action, v.description
FROM (VALUES
  ('view',    'View controlled approval exceptions'),
  ('create',  'Raise a controlled approval exception (deviation request)'),
  ('approve', 'Authorise a controlled approval exception'),
  ('reject',  'Refuse a controlled approval exception'),
  ('resolve', 'Record the independent reviewer outcome for an exception'),
  ('expire',  'Expire a controlled approval exception')
) AS v(action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = 'workflows.exceptions.' || v.action);

-- ---------------------------------------------------------------------------
-- 3. Grants (the 0184 pattern - derive from permissions a role already holds).
--    View/raise goes to everyone already in the approval loop; authorisation
--    and review go to the governance administrators who already authorise
--    delegations (the independent authority for a deviation).
-- ---------------------------------------------------------------------------
-- Read + raise tier: everyone who can already view the approval queue.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p
  ON p.code IN ('workflows.exceptions.view', 'workflows.exceptions.create')
WHERE EXISTS (
  SELECT 1 FROM role_permissions rp
  JOIN permissions rp_perm ON rp_perm.id = rp.permission_id
  WHERE rp.role_id = r.id AND rp_perm.code = 'workflows.instances.view'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Authorisation + review tier: everyone who already authorises delegations.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p
  ON p.code IN (
    'workflows.exceptions.approve','workflows.exceptions.reject',
    'workflows.exceptions.resolve','workflows.exceptions.expire'
  )
WHERE EXISTS (
  SELECT 1 FROM role_permissions rp
  JOIN permissions rp_perm ON rp_perm.id = rp.permission_id
  WHERE rp.role_id = r.id AND rp_perm.code = 'governance.delegations.approve'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;
