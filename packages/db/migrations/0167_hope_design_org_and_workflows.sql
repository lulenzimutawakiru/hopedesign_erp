-- ============================================================================
-- 0167 - Hope Design org chart: RBAC alignment and approval workflows
--
-- The Executive & Operational Structure the business actually runs on had
-- drifted away from what the database encodes. Three concrete symptoms:
--
--   * Four positions in the chart had no role at all (Operations Manager, MD
--     Assistant, Operations Assistant, Office Attendant), so the people doing
--     that work were carrying unrelated role codes instead.
--   * Every operational workflow ended at a finance or director sign-off and
--     none reached Accounting, so an approved document never actually became a
--     disbursement.
--   * The expense and claims workflows carried overlapping amount bands with
--     duplicate step numbers, so the same approver could be asked twice and
--     which band applied changed nothing about who approved it.
--
-- This file aligns RBAC and the workflow definitions with the stated operating
-- rule: the originator prepares a document, the Operations Manager verifies and
-- authorises it, the Managing Director gives final approval, and it is released
-- to Accounting. Where the Managing Director is absent, the Operations Manager
-- signs on their behalf - encoded by both people holding the operations_manager
-- role, which is what makes the MD step decidable rather than stranded.
--
-- Scope and boundaries worth knowing before reading the SQL:
--
--   * Nothing here rewrites history. Existing approval_tasks keep the
--     approver_role_id and step_seq they were created with; only the templates
--     that future instances are stamped from change.
--   * WF-SEC (security_printing.jobs) is deliberately untouched. Its two-step
--     shape is a hard requirement of handleSecureJobTaskApproved, which only
--     understands step 1 and step 2.
--   * Sections 6-8 (approval_fallback_rules, approval_limits, approval_levels)
--     are declarative records. approval_limits and acting_assignments have no
--     code references at all, and the fallback and level tables are read only
--     by the admin-only GET /approvals/resolve. They are written so the admin
--     screens show the real mandate, not because the engine consults them.
--   * Section 10 records the KCB joint-signatory mandate as a signature
--     authority scope. No code enforces dual signature today.
--
-- Idempotent: every insert is guarded, every update compares against its target
-- value, and re-running the file is a no-op. Forward-only: 0166 is already in
-- the schema_migrations ledger. The runner owns BEGIN/COMMIT and the ledger row,
-- so this file must contain neither.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The four roles the org chart names but the database never had.
--
--    Grants are declared as permission patterns rather than long explicit code
--    lists, so a pattern that matches nothing today is simply no rows - it can
--    never fail the migration. A trailing '.*' means the whole module, a '*' in
--    the middle (inventory.*.view) means the read-only codes in that module, and
--    a pattern with no '*' is one exact code.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tenant  BIGINT;
  v_company BIGINT;
  r         RECORD;
  v_role_id BIGINT;
  v_perms   JSONB;
BEGIN
  SELECT c.tenant_id, c.id INTO v_tenant, v_company
  FROM companies c
  WHERE c.code = 'HDG' AND c.status = 'ACTIVE'
  ORDER BY c.id
  LIMIT 1;

  IF v_company IS NULL THEN
    RAISE NOTICE '0167: Hope Design company not found; section 1 skipped.';
    RETURN;
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      (
        'operations_manager',
        'Operations Manager',
        'Directs manufacturing and facility workflows, oversees production line output, verifies and authorises operational workflows before Managing Director approval, and signs on behalf of the Managing Director in their absence.',
        ARRAY[
          'workflows.instances.*',
          'production.*', 'quality.*', 'maintenance.*', 'inventory.*',
          'procurement.*', 'expenditure.*', 'logistics.*', 'reports.*',
          'communication.*', 'documents.*', 'dashboard.*', 'notifications.*',
          'service_desk.*', 'hr.attendance.*',
          'organisation.manufacturing.manage', 'organisation.inventory.manage',
          'organisation.structure.manage', 'organisation.audit.view',
          'organisation.settings.view',
          'governance.delegations.view', 'governance.acting_roles.view',
          'governance.document_signatures.view',
          'governance.document_signatures.create',
          'governance.document_signatures.verify',
          'governance.signature_profiles.view',
          'governance.signature_authority_scopes.view'
        ]::text[]
      ),
      (
        'md_assistant',
        'Managing Director Assistant',
        'Manages executive schedules, administrative workflows and executive correspondence on behalf of the Managing Director.',
        ARRAY[
          'dashboard.*', 'notifications.*', 'documents.*', 'communication.*',
          'service_desk.*', 'workflows.instances.view',
          'reports.executive.*', 'reports.dashboards.*', 'reports.kpis.*',
          'organisation.settings.view', 'organisation.audit.view',
          'organisation.documents.manage',
          'governance.delegations.view', 'governance.acting_roles.view',
          'governance.document_signatures.view',
          'governance.signature_profiles.view',
          'governance.signature_authority_scopes.view'
        ]::text[]
      ),
      (
        'operations_assistant',
        'Operations Assistant',
        'Supports day-to-day operational activities and cross-departmental coordination; read-only across the operational modules.',
        ARRAY[
          'dashboard.*', 'notifications.*', 'documents.*', 'communication.*',
          'service_desk.*', 'workflows.instances.view',
          'reports.dashboards.*', 'reports.kpis.*', 'reports.operations.*',
          'inventory.*.view', 'production.*.view', 'procurement.*.view',
          'expenditure.*.view', 'logistics.*.view', 'quality.*.view'
        ]::text[]
      ),
      (
        'office_attendant',
        'Office Attendant',
        'General office upkeep and day-to-day clerical support.',
        ARRAY[
          'dashboard.*', 'notifications.*',
          'documents.documents.view', 'documents.library.view',
          'communication.announcements.view', 'communication.messages.view',
          'communication.messages.create',
          'service_desk.tickets.view', 'service_desk.tickets.create'
        ]::text[]
      )
    ) AS t(code, name, description, patterns)
  LOOP
    SELECT id INTO v_role_id
    FROM roles
    WHERE tenant_id = v_tenant AND company_id = v_company AND code = r.code;

    IF v_role_id IS NULL THEN
      INSERT INTO roles (tenant_id, company_id, code, name, description)
      VALUES (v_tenant, v_company, r.code, r.name, r.description)
      RETURNING id INTO v_role_id;
      RAISE NOTICE '0167: created role %.', r.code;
    ELSE
      UPDATE roles
      SET name = r.name, description = r.description, updated_at = now()
      WHERE id = v_role_id
        AND (name IS DISTINCT FROM r.name OR description IS DISTINCT FROM r.description);
    END IF;

    INSERT INTO role_permissions (role_id, permission_id)
    SELECT v_role_id, p.id
    FROM permissions p
    WHERE EXISTS (
      SELECT 1
      FROM unnest(r.patterns) AS pat
      WHERE (pat LIKE '%.*' AND p.code LIKE replace(pat, '*', '%'))
         OR (pat NOT LIKE '%.*' AND p.code = pat)
    )
    ON CONFLICT DO NOTHING;

    SELECT COALESCE(jsonb_agg(DISTINCT p.code), '[]'::jsonb) INTO v_perms
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
    WHERE rp.role_id = v_role_id;

    UPDATE roles
    SET permissions = v_perms, updated_at = now()
    WHERE id = v_role_id AND permissions IS DISTINCT FROM v_perms;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Any role that appears on a workflow step must be able to decide one.
--
--    decideTask authorises through role_permissions, not through the cosmetic
--    roles.permissions cache, so grants go to role_permissions and that cache is
--    rebuilt from it straight afterwards (organisationSettings/approvals.ts reads
--    the cache when rendering the approvals screen). Before this file the
--    accountant, asset_manager, production_supervisor and quality_inspector roles
--    held none of approve/reject/return/delegate, so a step assigned to them
--    could not be actioned by anyone.
-- ---------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.company_id = (SELECT c.id FROM companies c WHERE c.code = 'HDG' AND c.status = 'ACTIVE' ORDER BY c.id LIMIT 1)
  AND r.code IN (
        'accountant', 'asset_manager', 'production_supervisor',
        'quality_inspector', 'warehouse_manager', 'procurement_manager',
        'finance_manager', 'cfo', 'chief_accountant', 'hr_manager',
        'payroll_manager', 'sales_manager', 'secure_job_approver',
        'operations_manager'
      )
  AND p.code LIKE 'workflows.instances.%'
ON CONFLICT DO NOTHING;

UPDATE roles r
SET permissions = sub.codes, updated_at = now()
FROM (
  SELECT rp.role_id, to_jsonb(array_agg(DISTINCT p.code)) AS codes
  FROM role_permissions rp
  JOIN permissions p ON p.id = rp.permission_id
  GROUP BY rp.role_id
) sub
WHERE sub.role_id = r.id
  AND r.company_id = (SELECT c.id FROM companies c WHERE c.code = 'HDG' AND c.status = 'ACTIVE' ORDER BY c.id LIMIT 1)
  AND r.code IN (
        'accountant', 'asset_manager', 'production_supervisor',
        'quality_inspector', 'warehouse_manager', 'procurement_manager',
        'finance_manager', 'cfo', 'chief_accountant', 'hr_manager',
        'payroll_manager', 'sales_manager', 'secure_job_approver',
        'operations_manager'
      )
  AND r.permissions IS DISTINCT FROM sub.codes;

-- ---------------------------------------------------------------------------
-- 3. Put each named person on the roles the org chart gives them.
--
--    Existing grants for these eighteen people are cleared first, because the
--    chart is a statement about what each position holds and the current rows
--    had accumulated unrelated codes - the System Administrator alone held
--    seventeen roles, including managing_director and cfo. Everything is scoped
--    to the Hope Design tenant, so other tenants are untouched.
--
--    The Managing Director and the Operations Manager both hold
--    operations_manager on purpose: that shared code is the mechanism by which
--    the Operations Manager can sign the MD step when the MD is away.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tenant  BIGINT;
  v_company BIGINT;
  v_branch  BIGINT;
  r         RECORD;
  v_user_id BIGINT;
BEGIN
  SELECT c.tenant_id, c.id INTO v_tenant, v_company
  FROM companies c
  WHERE c.code = 'HDG' AND c.status = 'ACTIVE'
  ORDER BY c.id
  LIMIT 1;

  IF v_company IS NULL THEN
    RAISE NOTICE '0167: Hope Design company not found; section 3 skipped.';
    RETURN;
  END IF;

  SELECT b.id INTO v_branch
  FROM branches b
  WHERE b.company_id = v_company AND b.tenant_id = v_tenant
  ORDER BY b.id
  LIMIT 1;

  IF v_branch IS NULL THEN
    RAISE NOTICE '0167: no branch for Hope Design; section 3 skipped.';
    RETURN;
  END IF;

  DELETE FROM user_roles ur
  USING users u
  WHERE ur.user_id = u.id
    AND u.tenant_id = v_tenant
    AND u.username IN (
      'nkuzingoma.diuedonne', 'john.paul', 'dinah.hannah',
      'nyirinkindi.annonciata', 'dakyali', 'nanette.arakaza',
      'lulenzi.mutawakiru', 'anthony.chege', 'guillaume.niyonzima',
      'solomon.munyagwa', 'mbeba.sebikali', 'tabu.derrick',
      'emile.niyungeko', 'gloria.nakakawa', 'racheal.tagulwa',
      'lorraine.ninihazwe', 'shamirah.nantume', 'viola.akatikwasa'
    );

  FOR r IN
    SELECT * FROM (VALUES
      ('nkuzingoma.diuedonne',    ARRAY['managing_director', 'operations_manager', 'employee_self_service']::text[]),
      ('john.paul',               ARRAY['operations_manager', 'employee_self_service']::text[]),
      ('dinah.hannah',            ARRAY['md_assistant', 'employee_self_service']::text[]),
      ('nyirinkindi.annonciata',  ARRAY['hr_manager', 'employee_self_service']::text[]),
      ('dakyali',                 ARRAY['cfo', 'employee_self_service']::text[]),
      ('nanette.arakaza',         ARRAY['accountant', 'ap_officer', 'ar_officer', 'employee_self_service']::text[]),
      ('lulenzi.mutawakiru',      ARRAY['super_administrator', 'system_administrator', 'employee_self_service']::text[]),
      ('anthony.chege',           ARRAY['production_supervisor', 'employee_self_service']::text[]),
      ('guillaume.niyonzima',     ARRAY['driver', 'employee_self_service']::text[]),
      ('solomon.munyagwa',        ARRAY['operations_assistant', 'employee_self_service']::text[]),
      ('mbeba.sebikali',          ARRAY['office_attendant', 'employee_self_service']::text[]),
      ('tabu.derrick',            ARRAY['production_officer', 'employee_self_service']::text[]),
      ('emile.niyungeko',         ARRAY['production_officer', 'employee_self_service']::text[]),
      ('gloria.nakakawa',         ARRAY['production_officer', 'employee_self_service']::text[]),
      ('racheal.tagulwa',         ARRAY['production_officer', 'employee_self_service']::text[]),
      ('lorraine.ninihazwe',      ARRAY['production_officer', 'employee_self_service']::text[]),
      ('shamirah.nantume',        ARRAY['production_officer', 'employee_self_service']::text[]),
      ('viola.akatikwasa',        ARRAY['production_officer', 'employee_self_service']::text[])
    ) AS t(username, codes)
  LOOP
    SELECT u.id INTO v_user_id
    FROM users u
    WHERE u.tenant_id = v_tenant AND u.username = r.username
    ORDER BY u.id
    LIMIT 1;

    IF v_user_id IS NULL THEN
      RAISE NOTICE '0167: user % not found; roles left unchanged.', r.username;
      CONTINUE;
    END IF;

    INSERT INTO user_roles (user_id, role_id, company_id, branch_id)
    SELECT v_user_id, ro.id, v_company, v_branch
    FROM roles ro
    WHERE ro.tenant_id = v_tenant
      AND ro.company_id = v_company
      AND ro.code = ANY (r.codes)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
-- ---------------------------------------------------------------------------
-- 4. Departmental leadership and placement.
--
--    Department heads are set only where the establishment actually has a named
--    owner (Finance, Production, HR, IT, Admin). The seven departments with no
--    matching employee in production - Sales, Warehouse, Quality, Security,
--    Maintenance, Procurement, Logistics - have their dangling head pointers
--    cleared rather than left pointing at users that no longer exist, so the
--    org chart can never display a head who is not on the floor.
--
--    The Managing Director, the CEO's Assistant and the Office Attendant move
--    into ADMIN: they sit outside the operating departments they serve, and
--    leaving the MD inside HR made the HR manager look like the MD's manager.
-- ---------------------------------------------------------------------------

UPDATE departments d
SET head_user_id = u.id,
    updated_at   = now()
FROM (VALUES
        ('FIN',   'dakyali'),
        ('PROD',  'anthony.chege'),
        ('HR',    'nyirinkindi.annonciata'),
        ('IT',    'lulenzi.mutawakiru'),
        ('ADMIN', 'dinah.hannah')
     ) AS v(dept, username)
JOIN users u     ON u.username = v.username
JOIN companies c ON c.id = u.company_id
                AND c.code = 'HDG'
                AND c.status = 'ACTIVE'
WHERE d.company_id = c.id
  AND d.code = v.dept
  AND d.head_user_id IS DISTINCT FROM u.id;

UPDATE departments d
SET head_user_id = NULL,
    updated_at   = now()
FROM companies c
WHERE c.id = d.company_id
  AND c.code = 'HDG'
  AND c.status = 'ACTIVE'
  AND d.code IN ('SAL', 'WH', 'QC', 'SEC', 'MAINT', 'PROC', 'LOG')
  AND d.head_user_id IS NOT NULL;

UPDATE users u
SET department_id = d.id,
    updated_at    = now()
FROM (VALUES
        ('nkuzingoma.diuedonne', 'ADMIN'),
        ('dinah.hannah',         'ADMIN'),
        ('mbeba.sebikali',       'ADMIN')
     ) AS v(username, dept)
JOIN companies c   ON c.code = 'HDG' AND c.status = 'ACTIVE'
JOIN departments d ON d.company_id = c.id AND d.code = v.dept
WHERE u.username = v.username
  AND u.company_id = c.id
  AND u.department_id IS DISTINCT FROM d.id;
-- ---------------------------------------------------------------------------
-- 5. The approval chain the business actually runs.
--
--    Every workflow is rewritten to one shape: the originating manager signs
--    off, the Operations Manager verifies and authorises on behalf of
--    operations, the Managing Director gives final approval, and the chain then
--    releases to Accounting so the accountant can disburse. In the MD's absence
--    the Operations Manager signs that step - which is why both hold the
--    operations_manager code - and the release step is what turns an approved
--    document into a payment instead of a dead end.
--
--    Two properties of the engine shape the encoding:
--
--      * startWorkflow takes the SLA for every task from the first applicable
--        step, so bands must not overlap and all steps are made unconditional
--        (amount_min 0, amount_max 0 means "no floor, no ceiling").
--      * decideTask completes an instance only when no PENDING task is left, so
--        every step is a real, unskippable sign-off. Adding the Accounting step
--        is what makes release mandatory rather than advisory.
--
--    The old tiered escalation bands (finance_manager -> chief_accountant ->
--    executive_director -> general_manager) are replaced rather than kept: those
--    codes are not held by anyone in the current establishment, so a band
--    guarded on them would have produced a step nobody could action. The
--    supervising steps collapse onto cfo, operations_manager and the MD, all of
--    whom are named in the chart and hold the code.
--
--    WF-SEC (security_printing.jobs) is deliberately excluded: its two steps are
--    condition-gated and handleSecureJobTaskApproved only understands step 1
--    and step 2, so any other shape would break secure job approval.
-- ---------------------------------------------------------------------------

UPDATE workflows w
SET config     = v.config,
    version    = w.version + 1,
    status     = 'PUBLISHED',
    updated_at = now()
FROM (VALUES
  ('WF-ADJ', '[{"seq":1,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-ASSET-DISPOSAL', '[{"seq":1,"name":"CFO Approval","approver_role":"cfo","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":4,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-ASSET-IMPAIRMENT', '[{"seq":1,"name":"CFO Approval","approver_role":"cfo","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":4,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-ASSET-MAINTENANCE', '[{"seq":1,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-ASSET-REGISTER', '[{"seq":1,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-ASSET-TRANSFER', '[{"seq":1,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-CLAIM', '[{"seq":1,"name":"CFO Approval","approver_role":"cfo","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":4,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-CN', '[{"seq":1,"name":"CFO Approval","approver_role":"cfo","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":4,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-DCLOSE', '[{"seq":1,"name":"CFO Approval","approver_role":"cfo","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":4,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-DNM', '[{"seq":1,"name":"CFO Approval","approver_role":"cfo","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":4,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-EXP', '[{"seq":1,"name":"CFO Approval","approver_role":"cfo","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":4,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-INV', '[{"seq":1,"name":"CFO Approval","approver_role":"cfo","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":4,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-PAY', '[{"seq":1,"name":"CFO Approval","approver_role":"cfo","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":4,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-PCR', '[{"seq":1,"name":"CFO Approval","approver_role":"cfo","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":4,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-PO', '[{"seq":1,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-POAM', '[{"seq":1,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-PR', '[{"seq":1,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-REQ', '[{"seq":1,"name":"HR Manager Approval","approver_role":"hr_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":4,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-REQOPS', '[{"seq":1,"name":"CFO Approval","approver_role":"cfo","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":4,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-SO', '[{"seq":1,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-SUP', '[{"seq":1,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-SUPPAY', '[{"seq":1,"name":"CFO Approval","approver_role":"cfo","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":4,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-WFP', '[{"seq":1,"name":"HR Manager Approval","approver_role":"hr_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":4,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-XFER', '[{"seq":1,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb)
     ) AS v(code, config)
WHERE w.company_id = (SELECT c.id FROM companies c WHERE c.code = 'HDG' AND c.status = 'ACTIVE' ORDER BY c.id LIMIT 1)
  AND w.code = v.code
  AND w.config IS DISTINCT FROM v.config;
-- ---------------------------------------------------------------------------
-- 6. MD absence: the Operations Manager signs on the MD's behalf.
--
--    Declarative. GET /approvals/resolve renders it; no runtime path consults
--    it when a task is decided. The behavioural half of the same rule lives in
--    section 3 - the Managing Director and the Operations Manager both hold
--    operations_manager - so the Operations Manager can action the "Managing
--    Director Final Approval" step directly. Without that shared code a
--    declared absence would still leave the step undecidable, because decideTask
--    authorises through user_roles and never consults fallback rules or
--    delegations. workflow_id and level_id are left NULL on purpose: this is a
--    standing, company-wide arrangement, not one bound to a single level.
-- ---------------------------------------------------------------------------

INSERT INTO approval_fallback_rules (
        tenant_id, company_id, workflow_id, level_id,
        primary_role_id, primary_user_id, fallback_role_id, fallback_user_id,
        reason, effective_from, effective_to, is_active, created_by, updated_by
)
SELECT c.tenant_id, c.id, NULL, NULL,
       md.id, NULL, om.id, NULL,
       'MD absence: the Operations Manager signs on behalf of the Managing Director',
       now(), now() + interval '10 years', true, md_user.id, md_user.id
FROM companies c
JOIN roles md
  ON md.tenant_id = c.tenant_id AND md.company_id = c.id AND md.code = 'managing_director'
JOIN roles om
  ON om.tenant_id = c.tenant_id AND om.company_id = c.id AND om.code = 'operations_manager'
LEFT JOIN users md_user
  ON md_user.company_id = c.id AND md_user.username = 'nkuzingoma.diuedonne'
WHERE c.code = 'HDG'
  AND c.status = 'ACTIVE'
  AND NOT EXISTS (
        SELECT 1
        FROM approval_fallback_rules f
        WHERE f.company_id = c.id
          AND f.primary_role_id = md.id
          AND f.fallback_role_id = om.id
          AND f.reason LIKE 'MD absence:%'
      );

-- ---------------------------------------------------------------------------
-- 7. Approval limits stop being no-ops.
--
--    Ids 1-6 and 14-16 carry max_amount 0, which reads as "may approve up to
--    nothing" - a limit row that silently forbids the very transactions it was
--    written to permit. They are re-based onto the CFO ceiling. The
--    security_printing.jobs row is left byte-identical so no part of secure job
--    authorisation is touched. Operations Director limit rows move to the
--    Operations Manager, the role the chart actually staffs, and the NOT EXISTS
--    guard keeps a module from ending up with two identical ceilings.
-- ---------------------------------------------------------------------------

UPDATE approval_limits al
SET max_amount = 1000000000
FROM roles r
JOIN companies c ON c.id = r.company_id
WHERE al.role_id = r.id
  AND c.code = 'HDG'
  AND c.status = 'ACTIVE'
  AND al.max_amount = 0
  AND al.module <> 'security_printing.jobs';

UPDATE approval_limits al
SET role_id = om.id
FROM roles od
JOIN companies c
  ON c.id = od.company_id
JOIN roles om
  ON om.tenant_id = od.tenant_id AND om.company_id = od.company_id
 AND om.code = 'operations_manager'
WHERE al.role_id = od.id
  AND od.code = 'operations_director'
  AND c.code = 'HDG'
  AND c.status = 'ACTIVE'
  AND NOT EXISTS (
        SELECT 1
        FROM approval_limits x
        WHERE x.role_id = om.id AND x.module = al.module
      );

-- ---------------------------------------------------------------------------
-- 8. The purchase order chain, expressed as levels on the PO_STANDARD standard.
--
--    approval_levels names its parent through approval_workflows, not through
--    the runtime workflows table. PO_STANDARD is an approval_workflows row and
--    has no counterpart in workflows, so joining on workflows.code would have
--    matched nothing and inserted nothing. Levels 1 and 2 already exist
--    (Procurement management, then Finance / executive), so the new levels start
--    at 3 and append verification, final approval and release in order - the
--    same three sign-offs section 5 writes into every operational workflow.
-- ---------------------------------------------------------------------------

INSERT INTO approval_levels (
        workflow_id, tenant_id, company_id, level_no, name,
        approver_role_id, required_approvals, is_optional, allow_delegation, sla_hours
)
SELECT aw.id, aw.tenant_id, aw.company_id, v.level_no, v.name,
       r.id, 1, false, true, 48
FROM approval_workflows aw
JOIN companies c
  ON c.id = aw.company_id
JOIN (VALUES
        (3, 'Operations Manager Verification', 'operations_manager'),
        (4, 'Managing Director Final Approval', 'operations_manager'),
        (5, 'Released to Accounting', 'accountant')
     ) AS v(level_no, name, code)
  ON true
JOIN roles r
  ON r.tenant_id = aw.tenant_id AND r.company_id = aw.company_id AND r.code = v.code
WHERE aw.code = 'PO_STANDARD'
  AND c.code = 'HDG'
  AND c.status = 'ACTIVE'
  AND NOT EXISTS (
        SELECT 1
        FROM approval_levels l
        WHERE l.workflow_id = aw.id AND l.level_no = v.level_no
      );
-- ---------------------------------------------------------------------------
-- 9. Retire the two test delegations.
--
--    DLG-2026-000001 (reason 'gh') and DLG-2026-000002 ('testing role
--    delegation') both hand the System Administrator's roles to the HR Manager -
--    an arrangement the chart does not describe. They are revoked rather than
--    deleted: middleware/auth.ts merges ACTIVE delegations into a live session,
--    so revoking is what actually withdraws the authority, and the row survives
--    as the audit record of what was granted and why it was taken back.
-- ---------------------------------------------------------------------------

UPDATE delegations d
SET status         = 'REVOKED',
    revoked_by     = md.id,
    revoked_at     = now(),
    revoked_reason = 'Withdrawn when the org chart was aligned: a test delegation between two positions the chart does not link.',
    updated_by     = md.id,
    updated_at     = now()
FROM companies c
LEFT JOIN users md
  ON md.company_id = c.id AND md.username = 'nkuzingoma.diuedonne'
WHERE d.company_id = c.id
  AND c.code = 'HDG'
  AND d.code IN ('DLG-2026-000001', 'DLG-2026-000002')
  AND d.status <> 'REVOKED';

-- ---------------------------------------------------------------------------
-- 10. The KCB banking mandate.
--
--     The mandate is that the Operations Manager and the Managing Director sign
--     jointly for the bank, after which the Accountant disburses. It is recorded
--     as APPROVED signature authority scopes on the two ACTIVE profiles of the
--     named holders - treasury payment and treasury transfer, no amount ceiling -
--     so the signing screen offers both and shows the mandate as their basis.
--
--     created_by is deliberately the System Administrator, not the signatory.
--     The governance service refuses to let a user approve a scope they own, so
--     a self-approved row would have been born unusable; here the company
--     mandate is the authority and the metadata records it. Nothing in code
--     enforces the second signature when a document is actually signed, so this
--     is a recorded control - the two-person rule stays a human one, and the
--     Accountant's release step in section 5 is the part that is enforced.
-- ---------------------------------------------------------------------------

INSERT INTO signature_authority_scopes (
        tenant_id, company_id, branch_id, department_id, profile_id,
        document_type, transaction_type, max_amount, status,
        approver_user_id, approved_at, created_by, metadata
)
SELECT p.tenant_id, p.company_id, p.branch_id, p.department_id, p.id,
       v.document_type, v.transaction_type, NULL, 'APPROVED',
       md.id, now(), admin.id,
       jsonb_build_object(
         'basis', CASE
                    WHEN owner.username = 'nkuzingoma.diuedonne'
                      THEN 'Company mandate: the Managing Director is a designated KCB signatory'
                    ELSE 'Approved by the Managing Director under the KCB joint-signature mandate'
                  END,
         'mandate', 'KCB joint authorization: the Operations Manager and the Managing Director sign jointly; the Accountant then disburses',
         'source', '0167_hope_design_org_and_workflows'
       )
FROM signature_profiles p
JOIN users owner
  ON owner.id = p.user_id
JOIN companies c
  ON c.id = p.company_id
JOIN users md
  ON md.company_id = c.id AND md.username = 'nkuzingoma.diuedonne'
JOIN users admin
  ON admin.company_id = c.id AND admin.username = 'lulenzi.mutawakiru'
JOIN (VALUES
        ('BANK_PAYMENT',  'TREASURY'),
        ('BANK_TRANSFER', 'TREASURY')
     ) AS v(document_type, transaction_type)
  ON true
WHERE c.code = 'HDG'
  AND c.status = 'ACTIVE'
  AND p.status = 'ACTIVE'
  AND owner.username IN ('nkuzingoma.diuedonne', 'john.paul')
  AND NOT EXISTS (
        SELECT 1
        FROM signature_authority_scopes s
        WHERE s.profile_id = p.id
          AND s.document_type = v.document_type
          AND s.transaction_type = v.transaction_type
      );
