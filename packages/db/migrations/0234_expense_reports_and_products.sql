-- 0234 - Expense Reports (batch reimbursement sheets) + Expense Products
--
-- Brings the spend module to full Odoo-Expenses parity:
--   1. Expense Reports  — group several approved employee expense claims into one
--      sheet, submit it, and reimburse the employee in one action. A report may be
--      reimbursed DIRECT (cash/bank journal) or via PAYSLIP (added to the next
--      payroll run as a pure net addition — not taxable, not NSSF/LST).
--   2. Expense Products — a company catalogue of commonly-expensed items with a
--      default price, expense category and GL account, to speed up capture.
--
-- Additive and idempotent. migrate.js owns transaction and schema_migrations.

-- ============================================================
-- 1. Expense Reports (batch sheets grouping employee claims)
-- ============================================================
CREATE TABLE IF NOT EXISTS expense_reports (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  report_no TEXT NOT NULL,
  employee_id BIGINT REFERENCES employees(id),
  title TEXT NOT NULL,
  description TEXT,
  reimbursement_mode TEXT NOT NULL DEFAULT 'DIRECT'
    CHECK (reimbursement_mode IN ('DIRECT','PAYSLIP')),
  currency TEXT NOT NULL DEFAULT 'UGX',
  -- DRAFT -> SUBMITTED -> APPROVED -> REIMBURSED ; REJECTED / VOID
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REIMBURSED','REJECTED','VOID')),
  submitted_by BIGINT REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  reimbursed_by BIGINT REFERENCES users(id),
  reimbursed_at TIMESTAMPTZ,
  gl_posted BOOLEAN NOT NULL DEFAULT false,
  gl_journal_id BIGINT,
  -- Set when a PAYSLIP-mode report is picked up into a payroll run; mirrors
  -- the payroll_arrears linkage pattern.
  reimbursement_payroll_id BIGINT REFERENCES payrolls(id),
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  UNIQUE (company_id, report_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exp_reports_emp ON expense_reports(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_exp_reports_status ON expense_reports(status);

-- A claim joins a report; the report (not the claim) then owns the batch's
-- reimbursement mode and lifecycle.
ALTER TABLE employee_expense_claims
  ADD COLUMN IF NOT EXISTS report_id BIGINT REFERENCES expense_reports(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_claims_report ON employee_expense_claims(report_id);

-- A lone claim (report_id IS NULL) can itself be reimbursed via payslip.
ALTER TABLE employee_expense_claims
  ADD COLUMN IF NOT EXISTS reimbursement_mode TEXT NOT NULL DEFAULT 'DIRECT'
    CHECK (reimbursement_mode IN ('DIRECT','PAYSLIP'));
ALTER TABLE employee_expense_claims
  ADD COLUMN IF NOT EXISTS reimbursement_payroll_id BIGINT REFERENCES payrolls(id);
CREATE INDEX IF NOT EXISTS idx_claims_reimb_payroll ON employee_expense_claims(reimbursement_payroll_id);

-- Net-addition line on each payslip for payroll-settled reimbursements.
-- Deliberately NOT part of gross/taxable/NSSF/LST: an expense reimbursement is a
-- return of the employee's own money, not remuneration.
ALTER TABLE payroll_items
  ADD COLUMN IF NOT EXISTS reimbursement NUMERIC(18,2) NOT NULL DEFAULT 0;

-- ============================================================
-- 2. Expense Products (productized, commonly-expensed items)
-- ============================================================
CREATE TABLE IF NOT EXISTS expense_products (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  default_price NUMERIC(18,2) NOT NULL DEFAULT 0,
  category_id BIGINT REFERENCES expense_categories(id),
  account_id BIGINT REFERENCES chart_of_accounts(id),
  tax_id BIGINT REFERENCES taxes(id),
  unit_code TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exp_products_cat ON expense_products(category_id);

-- ============================================================
-- 3. Permissions (seed parity: catalogue.js is the source of truth for
--    buildPermissions(); this keeps the live DB in step without a full re-seed)
-- ============================================================
INSERT INTO permissions (code, module, resource, action, description)
VALUES
  ('expenditure.expense_reports.view',      'expenditure', 'expense_reports', 'view',      'View expense reports'),
  ('expenditure.expense_reports.create',    'expenditure', 'expense_reports', 'create',    'Create expense reports'),
  ('expenditure.expense_reports.update',    'expenditure', 'expense_reports', 'update',    'Update draft expense reports'),
  ('expenditure.expense_reports.submit',    'expenditure', 'expense_reports', 'submit',    'Submit expense reports for approval'),
  ('expenditure.expense_reports.approve',   'expenditure', 'expense_reports', 'approve',   'Approve expense reports'),
  ('expenditure.expense_reports.reimburse', 'expenditure', 'expense_reports', 'reimburse', 'Reimburse approved expense reports'),
  ('expenditure.expense_products.view',     'expenditure', 'expense_products', 'view',      'View expense products'),
  ('expenditure.expense_products.create',   'expenditure', 'expense_products', 'create',    'Create expense products'),
  ('expenditure.expense_products.update',   'expenditure', 'expense_products', 'update',    'Update expense products')
ON CONFLICT (code) DO NOTHING;

-- Full surface -> roles already holding full expenditure access (expenditure.*).
-- Proxy: they hold expenditure.expenses.approve, which is granted only by the
-- full-module wildcard (never by the universal self-service initiation grants).
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p.id
FROM role_permissions rp
JOIN permissions p ON p.code IN (
  'expenditure.expense_reports.view','expenditure.expense_reports.create',
  'expenditure.expense_reports.update','expenditure.expense_reports.submit',
  'expenditure.expense_reports.approve','expenditure.expense_reports.reimburse',
  'expenditure.expense_products.view','expenditure.expense_products.create',
  'expenditure.expense_products.update'
)
WHERE rp.permission_id = (SELECT id FROM permissions WHERE code = 'expenditure.expenses.approve')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- View-only surface -> roles holding expenditure.*.view (they hold
-- expenditure.expenses.view but not expenditure.expenses.approve).
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p.id
FROM role_permissions rp
JOIN permissions p ON p.code IN ('expenditure.expense_reports.view','expenditure.expense_products.view')
WHERE rp.permission_id = (SELECT id FROM permissions WHERE code = 'expenditure.expenses.view')
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp2
    WHERE rp2.role_id = rp.role_id
      AND rp2.permission_id = (SELECT id FROM permissions WHERE code = 'expenditure.expenses.approve')
  )
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ============================================================
-- 4. Approval workflow for expense reports (submitReport calls startWorkflow,
--    which fails closed if no PUBLISHED workflow exists for the entity type)
-- ============================================================
INSERT INTO workflows (company_id, tenant_id, code, name, entity_type, description, config, is_active)
SELECT c.id, c.tenant_id, 'WF-EXPREPORT', 'Expense Report Approval', 'ops.expense_reports',
  'Batch employee expense reports approved by finance; large sheets need MD sign-off.',
  '[{"seq":1,"name":"Finance Approval","approver_role":"finance_manager","amount_min":0,"amount_max":1000000,"sla_hours":24},
    {"seq":1,"name":"Finance Manager Approval","approver_role":"finance_manager","amount_min":1000000,"amount_max":5000000,"sla_hours":24},
    {"seq":2,"name":"Managing Director Approval","approver_role":"managing_director","amount_min":1000000,"amount_max":5000000,"sla_hours":48},
    {"seq":1,"name":"CFO Approval","approver_role":"cfo","amount_min":5000000,"amount_max":1000000000,"sla_hours":24},
    {"seq":2,"name":"Executive Approval","approver_role":"executive_director","amount_min":5000000,"amount_max":1000000000,"sla_hours":48}]'::jsonb,
  true
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM workflows w WHERE w.company_id = c.id AND w.code = 'WF-EXPREPORT');
