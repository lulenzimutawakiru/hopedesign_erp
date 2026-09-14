-- ============================================================================
-- 0152 - HOPE DESIGN Service Desk & ITSM: ABAC policies (spec section 23)
-- ----------------------------------------------------------------------------
-- Policies are per-tenant and evaluated priority-ascending with first-match-wins
-- (apps/api/src/middleware/authorize.ts). Every policy below is scoped to
-- `module = service_desk`, so nothing outside the Service Desk is affected.
--
-- Priority layout (existing policies shown for context):
--   120  ABAC-FIN-HOURS            deny
--   130  ABAC-SD-CLASSIFIED        deny   <- new
--   140  ABAC-SD-INTERNAL-NOTES    deny   <- new
--   150  ABAC-NO-SELF-APPROVE      deny
--   160  ABAC-SD-READONLY          deny   <- new
--   165  ABAC-SD-OUT-OF-SCOPE      deny   <- new
--   200  ABAC-SEC-CLEARANCE        deny
--   995  ABAC-SD-EMPLOYEE-OWN      allow  <- new (declarative)
--   996  ABAC-SD-AGENT-SCOPE       allow  <- new (declarative)
--   999  ABAC-DEFAULT-ALLOW        allow
--
-- Guard-rail rules (INTERNAL-NOTES, READONLY) trigger only when an
-- administrator sets an explicit per-user attribute in users.attributes, so a
-- missing attribute can never lock an operator out of the Service Desk.
-- Route-provided resource attributes (data_classification, scope_denied) are
-- published by apps/api/src/routes/ops/serviceDesk.ts.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Confidentiality: classified service-desk records need a clearance.
--    Employee ticket creation is deliberately excluded (no `create` action
--    below) so a requester can still raise a confidential ticket.
-- ---------------------------------------------------------------------------
INSERT INTO policies (tenant_id, code, name, description, effect, priority,
                      subject_attributes, resource_attributes, environment_attributes, is_active)
SELECT t.id,
       'ABAC-SD-CLASSIFIED',
       'Service Desk classified records require clearance',
       'Subjects without a security_clearance attribute may not read or act on CONFIDENTIAL/RESTRICTED Service Desk records.',
       'deny',
       130,
       '{"security_clearance":{"$missing":true}}'::jsonb,
       '{"module":"service_desk","data_classification":{"$in":["CONFIDENTIAL","RESTRICTED"]},"action":{"$in":["view","view_own","update","reply","resolve","close","close_own","reopen","escalate","assign","export","print","investigate","approve","reject","grant","revoke","download"]}}'::jsonb,
       '{}'::jsonb,
       true
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM policies p WHERE p.tenant_id = t.id AND p.code = 'ABAC-SD-CLASSIFIED');

-- ---------------------------------------------------------------------------
-- 2. Internal notes: an explicit opt-out attribute denies the internal-note
--    surface entirely. RBAC (`service_desk.internal_notes.view`) is the primary
--    gate; this is defence in depth and never triggers by default.
-- ---------------------------------------------------------------------------
INSERT INTO policies (tenant_id, code, name, description, effect, priority,
                      subject_attributes, resource_attributes, environment_attributes, is_active)
SELECT t.id,
       'ABAC-SD-INTERNAL-NOTES',
       'Service Desk internal notes opt-out',
       'When users.attributes.service_desk_internal_notes is explicitly false the subject may never read or write internal notes.',
       'deny',
       140,
       '{"service_desk_internal_notes":{"$eq":false}}'::jsonb,
       '{"module":"service_desk","resource":"internal_notes"}'::jsonb,
       '{}'::jsonb,
       true
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM policies p WHERE p.tenant_id = t.id AND p.code = 'ABAC-SD-INTERNAL-NOTES');

-- ---------------------------------------------------------------------------
-- 3. Read-only persona: auditors with users.attributes.service_desk_readonly
--    may read but never mutate Service Desk records.
-- ---------------------------------------------------------------------------
INSERT INTO policies (tenant_id, code, name, description, effect, priority,
                      subject_attributes, resource_attributes, environment_attributes, is_active)
SELECT t.id,
       'ABAC-SD-READONLY',
       'Service Desk read-only persona',
       'When users.attributes.service_desk_readonly is true the subject may only read; every mutating Service Desk action is denied.',
       'deny',
       160,
       '{"service_desk_readonly":{"$eq":true}}'::jsonb,
       '{"module":"service_desk","action":{"$in":["create","update","delete","reply","assign","resolve","close","close_own","reopen","escalate","import","verify","approve","reject","implement","validate","grant","revoke","fulfil","investigate","publish","archive","rate","scan","manage","admin"]}}'::jsonb,
       '{}'::jsonb,
       true
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM policies p WHERE p.tenant_id = t.id AND p.code = 'ABAC-SD-READONLY');

-- ---------------------------------------------------------------------------
-- 4. Organisational scope: the service layer resolves the caller's authorized
--    queue/department scope and publishes the verdict as
--    ctx.resourceAttributes.scope_denied. ABAC then enforces it as a second
--    gate, so a scoping bug in a route cannot silently widen access.
-- ---------------------------------------------------------------------------
INSERT INTO policies (tenant_id, code, name, description, effect, priority,
                      subject_attributes, resource_attributes, environment_attributes, is_active)
SELECT t.id,
       'ABAC-SD-OUT-OF-SCOPE',
       'Service Desk organizational scope',
       'Denies Service Desk access when the resolved organizational scope check marks the record as out of scope.',
       'deny',
       165,
       '{}'::jsonb,
       '{"module":"service_desk","scope_denied":true}'::jsonb,
       '{}'::jsonb,
       true
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM policies p WHERE p.tenant_id = t.id AND p.code = 'ABAC-SD-OUT-OF-SCOPE');

-- ---------------------------------------------------------------------------
-- 5. Employee: an employee is allowed to reach their own ticket. Declarative
--    mirror of the self-service row scoping; the agent/manager queues are
--    additionally narrowed in SQL by ticketScope().
-- ---------------------------------------------------------------------------
INSERT INTO policies (tenant_id, code, name, description, effect, priority,
                      subject_attributes, resource_attributes, environment_attributes, is_active)
SELECT t.id,
       'ABAC-SD-EMPLOYEE-OWN-TICKET',
       'Service Desk employee own ticket',
       'An employee reaching a Service Desk record where they are the requester is allowed by policy.',
       'allow',
       995,
       '{}'::jsonb,
       '{"module":"service_desk","requester_user_id":{"$ref":"subject.user_id"}}'::jsonb,
       '{}'::jsonb,
       true
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM policies p WHERE p.tenant_id = t.id AND p.code = 'ABAC-SD-EMPLOYEE-OWN-TICKET');

-- ---------------------------------------------------------------------------
-- 6. Agent: a service-desk agent acting inside their authorized queue scope.
--    Declarative mirror of the queue/technician scope resolved in SQL.
-- ---------------------------------------------------------------------------
INSERT INTO policies (tenant_id, code, name, description, effect, priority,
                      subject_attributes, resource_attributes, environment_attributes, is_active)
SELECT t.id,
       'ABAC-SD-AGENT-SCOPE',
       'Service Desk agent authorized queue scope',
       'A service desk agent acting on a record inside their authorized queue or organizational scope is allowed by policy.',
       'allow',
       996,
       '{}'::jsonb,
       '{"module":"service_desk","scope_denied":{"$exists":false}}'::jsonb,
       '{}'::jsonb,
       true
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM policies p WHERE p.tenant_id = t.id AND p.code = 'ABAC-SD-AGENT-SCOPE');

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
-- SELECT code, effect, priority FROM policies WHERE tenant_id = 2 ORDER BY priority;
