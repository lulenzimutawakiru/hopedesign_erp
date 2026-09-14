-- ============================================================================
-- 0157_service_desk_hardening.sql
--
-- HOPE DESIGN Service Desk & ITSM - two authorization defects closed.
--
-- DEFECT 1 - CREATION ON BEHALF OF ANOTHER EMPLOYEE (spec 3)
-- ----------------------------------------------------------
-- createTicket() decided whether the caller could name a different requester
-- by testing `service_desk.tickets.create`. That permission is also held by
-- `employee_self_service` (97) and `hr_manager` (88) - personas that must NOT
-- be able to raise a ticket in someone else's name. The ABAC ladder does not
-- compensate: at create time the resource does not exist yet, so
-- ABAC-SD-EMPLOYEE-OWN-TICKET cannot match and the request falls through to
-- ABAC-DEFAULT-ALLOW.
--
-- Fix: a dedicated, explicit permission. Raising a ticket FOR ANOTHER PERSON is
-- a desk capability, not a self-service one.
--
-- DEFECT 2 - ABAC-SD-AGENT-SCOPE COULD NEVER MATCH
-- ------------------------------------------------
-- Policy 996 is declared as
--     subject_attributes  = {"service_desk_agent": {"$eq": true}}
-- but the ABAC subject is built from users.attributes plus user_id / id /
-- company_id / branch_id / department_id / job_title / email / status /
-- mfa_enabled (apps/api/src/middleware/authorize.ts). Nothing ever publishes
-- `service_desk_agent` on the SUBJECT - the ticket and asset services publish
-- it on the RESOURCE (ticketResourceAttributes / assetResourceAttributes,
-- `service_desk_agent: scope.isAgent`). The allow was therefore dead code and
-- every agent trip through the ladder ended on ABAC-DEFAULT-ALLOW instead.
--
-- That is not exploitable today (the deny policies at 130-200 run first and
-- 999 allows), but it means agent reach is granted by a default-allow rather
-- than by intent: flipping 999 to deny would silently lock every agent out.
-- Fix: match the fact where it actually lives - on the resource.
--
-- Additive and idempotent: safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The on-behalf permission
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, module, resource, action, description)
VALUES (
  'service_desk.tickets.create_on_behalf',
  'service_desk',
  'tickets',
  'create_on_behalf',
  'Raise a Service Desk ticket on behalf of another employee'
)
ON CONFLICT (code) DO UPDATE SET
  module = EXCLUDED.module,
  resource = EXCLUDED.resource,
  action = EXCLUDED.action,
  description = EXCLUDED.description;

-- ---------------------------------------------------------------------------
-- 2. Grant it to every role that already works the desk.
--
-- The rule is deliberately derived from behaviour rather than from a hardcoded
-- role list, so custom roles are covered too: a role that can already read
-- internal notes, assign tickets or resolve tickets is desk staff and may
-- therefore log a call for someone else. Self-service personas (which hold none
-- of the three) are excluded by construction.
-- ---------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT r.id, p.id
FROM roles r
JOIN role_permissions mrp ON mrp.role_id = r.id
JOIN permissions marker
  ON marker.id = mrp.permission_id
 AND marker.code IN (
       'service_desk.internal_notes.view',
       'service_desk.tickets.assign',
       'service_desk.tickets.resolve'
     )
CROSS JOIN permissions p
WHERE p.code = 'service_desk.tickets.create_on_behalf'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Keep the denormalised roles.permissions JSON blob honest.
--    (Authorization reads role_permissions; the blob is descriptive, but a
--    stale blob misleads every administrator who reads the role screen.)
-- ---------------------------------------------------------------------------
UPDATE roles r
   SET permissions = r.permissions || '["service_desk.tickets.create_on_behalf"]'::jsonb,
       updated_at = now()
 WHERE r.permissions @> '["service_desk.tickets.create_on_behalf"]'::jsonb IS NOT TRUE
   AND EXISTS (
     SELECT 1 FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = r.id
       AND p.code = 'service_desk.tickets.create_on_behalf'
   );

-- ---------------------------------------------------------------------------
-- 4. Repair ABAC-SD-AGENT-SCOPE (priority 996).
--
-- Semantics are unchanged and intentionally so: "an agent whose resource is
-- not marked out of scope may proceed". Only the side of the decision the
-- attribute is read from changes. ABAC-SD-OUT-OF-SCOPE (165) still runs first
-- and still wins, so an agent who is genuinely out of scope is refused.
-- ---------------------------------------------------------------------------
UPDATE policies
   SET subject_attributes = '{}'::jsonb,
       resource_attributes = '{"module": "service_desk", "service_desk_agent": true, "scope_denied": {"$exists": false}}'::jsonb,
       description = 'Service Desk agents may work any ticket or asset in their company desk that is not explicitly marked out of scope. Matched on the resource because the caller fact service_desk_agent is published by ticketResourceAttributes() / assetResourceAttributes().',
       updated_at = now()
 WHERE code = 'ABAC-SD-AGENT-SCOPE';
