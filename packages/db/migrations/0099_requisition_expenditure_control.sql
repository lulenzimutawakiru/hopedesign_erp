-- ============================================================
-- 0099 Requisition, Daily Expenditure, Petty Cash & Ops Expense
-- ============================================================
-- Complete operational spend control chain:
--   REQUEST -> REQUISITION -> APPROVAL -> {STORE ISSUE | PROCUREMENT |
--   ASSET} -> EXPENDITURE -> PAYMENT -> ACCOUNTING -> RECONCILIATION
--   -> REPORTING
-- Reuses the generic workflow engine (workflows/approval_tasks),
-- budgets/budget_commitments, cost_centres, inventory engine and the
-- double-entry post_journal engine. Approval thresholds live in the
-- workflows.config JSONB (configurable, never hard-coded).

-- ============================================================
-- 1. Audit log (created first so triggers can write to it)
-- ============================================================
CREATE TABLE expense_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  entity_type TEXT NOT NULL,
  entity_id BIGINT NOT NULL,
  entity_code TEXT,
  action TEXT NOT NULL,
  actor_user_id BIGINT REFERENCES users(id),
  old_values JSONB,
  new_values JSONB,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_exp_audit_entity ON expense_audit_logs(entity_type, entity_id);
CREATE INDEX idx_exp_audit_actor ON expense_audit_logs(actor_user_id);

-- ============================================================
-- 2. Requisition Center
-- ============================================================
CREATE TABLE requisitions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  req_no TEXT NOT NULL,
  request_type TEXT NOT NULL DEFAULT 'MATERIAL'
    CHECK (request_type IN ('MATERIAL','PURCHASE','ASSET','SERVICE','EXPENSE',
      'PETTY_CASH','PRODUCTION_MATERIAL','MAINTENANCE','EMERGENCY','PROJECT')),
  department_id BIGINT NOT NULL REFERENCES departments(id),
  requested_by BIGINT NOT NULL REFERENCES users(id),
  employee_id BIGINT REFERENCES employees(id),
  required_date DATE NOT NULL DEFAULT CURRENT_DATE,
  priority TEXT NOT NULL DEFAULT 'NORMAL'
    CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT','CRITICAL')),
  purpose TEXT,
  cost_centre_id BIGINT REFERENCES cost_centres(id),
  project_id BIGINT REFERENCES projects(id),
  budget_id BIGINT REFERENCES budgets(id),
  account_id BIGINT REFERENCES chart_of_accounts(id),
  warehouse_id BIGINT REFERENCES warehouses(id),
  estimated_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'UGX',
  -- STORE_ISSUE | PROCUREMENT | ASSET_ASSIGN | ASSET_PURCHASE | PAYMENT | MIXED
  fulfillment_method TEXT,
  is_emergency BOOLEAN NOT NULL DEFAULT false,
  risk_score NUMERIC(6,2) NOT NULL DEFAULT 0,
  risk_level TEXT NOT NULL DEFAULT 'LOW'
    CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED',
      'PARTIALLY_FULFILLED','FULFILLED','CANCELLED','CLOSED')),
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  fulfilled_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  UNIQUE (company_id, req_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_req_department ON requisitions(department_id, status);
CREATE INDEX idx_req_requester ON requisitions(requested_by, status);
CREATE INDEX idx_req_dates ON requisitions(required_date);
CREATE INDEX idx_req_type_status ON requisitions(request_type, status);

CREATE TABLE requisition_lines (
  id BIGSERIAL PRIMARY KEY,
  requisition_id BIGINT NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  line_no INTEGER NOT NULL DEFAULT 1,
  item_type TEXT NOT NULL DEFAULT 'INVENTORY_ITEM'
    CHECK (item_type IN ('INVENTORY_ITEM','ASSET','SERVICE','EXPENSE')),
  product_id BIGINT REFERENCES products(id),
  asset_category TEXT,
  description TEXT NOT NULL,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
  unit_id BIGINT REFERENCES units(id),
  unit_code TEXT,
  unit_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  account_id BIGINT REFERENCES chart_of_accounts(id),
  expense_category_id BIGINT,
  warehouse_id BIGINT REFERENCES warehouses(id),
  -- Decision-engine snapshot at request time
  stock_on_hand NUMERIC(18,4) DEFAULT 0,
  reserved_qty NUMERIC(18,4) DEFAULT 0,
  available_to_issue NUMERIC(18,4) DEFAULT 0,
  reorder_status TEXT,
  recommendation TEXT
    CHECK (recommendation IN ('STORE_ISSUE','PURCHASE','ASSET_ASSIGN','ASSET_PURCHASE','PAYMENT')),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','RESERVED','ISSUED','PURCHASED','ASSIGNED','CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_req_lines_req ON requisition_lines(requisition_id);
CREATE INDEX idx_req_lines_product ON requisition_lines(product_id);

CREATE TABLE requisition_approvals (
  id BIGSERIAL PRIMARY KEY,
  requisition_id BIGINT NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  step_seq INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  approver_role TEXT,
  approver_user_id BIGINT REFERENCES users(id),
  decision TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (decision IN ('PENDING','APPROVED','REJECTED','CHANGES_REQUESTED','DELEGATED')),
  comment TEXT,
  decided_by BIGINT REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  delegated_to BIGINT REFERENCES users(id),
  is_current BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_req_approvals_req ON requisition_approvals(requisition_id);

CREATE TABLE requisition_fulfillments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  requisition_id BIGINT NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
  line_id BIGINT REFERENCES requisition_lines(id),
  fulfillment_type TEXT NOT NULL
    CHECK (fulfillment_type IN ('STORE_ISSUE','PURCHASE_REQUISITION','PURCHASE_ORDER',
      'ASSET_ASSIGNMENT','PAYMENT','EXPENSE')),
  ref_type TEXT,
  ref_id BIGINT,
  ref_code TEXT,
  quantity NUMERIC(18,4) DEFAULT 0,
  amount NUMERIC(18,2) DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','COMPLETED','CANCELLED')),
  fulfilled_by BIGINT REFERENCES users(id),
  fulfilled_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_req_fulfillments_req ON requisition_fulfillments(requisition_id);
CREATE INDEX idx_req_fulfillments_ref ON requisition_fulfillments(ref_type, ref_id);

-- ============================================================
-- 3. Expenditure Register (daily register; distinct from legacy expenses)
-- ============================================================
CREATE TABLE expense_categories (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category_group TEXT NOT NULL DEFAULT 'OPERATIONS'
    CHECK (category_group IN ('OPERATIONS','FACTORY','ADMINISTRATION','STAFF',
      'SALES_MARKETING','LOGISTICS')),
  account_id BIGINT REFERENCES chart_of_accounts(id),
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_exp_cat_group ON expense_categories(category_group);

CREATE TABLE expense_transactions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  exp_no TEXT NOT NULL,
  exp_date DATE NOT NULL DEFAULT CURRENT_DATE,
  department_id BIGINT REFERENCES departments(id),
  cost_centre_id BIGINT REFERENCES cost_centres(id),
  category_id BIGINT REFERENCES expense_categories(id),
  description TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'UGX',
  payment_method_id BIGINT,
  payee TEXT,
  supplier_id BIGINT REFERENCES suppliers(id),
  employee_id BIGINT REFERENCES employees(id),
  project_id BIGINT REFERENCES projects(id),
  budget_id BIGINT REFERENCES budgets(id),
  account_id BIGINT REFERENCES chart_of_accounts(id),
  tax_id BIGINT REFERENCES taxes(id),
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  vehicle TEXT,
  receipt_ref TEXT,
  reference TEXT,
  is_planned BOOLEAN NOT NULL DEFAULT false,
  requisition_id BIGINT REFERENCES requisitions(id),
  -- DRAFT -> SUBMITTED -> APPROVED -> PAID -> POSTED ; REJECTED / VOID
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','PAID','POSTED','REJECTED','VOID')),
  payment_status TEXT NOT NULL DEFAULT 'UNPAID'
    CHECK (payment_status IN ('UNPAID','PENDING','PAID','PARTIALLY_PAID')),
  accounting_status TEXT NOT NULL DEFAULT 'UNPOSTED'
    CHECK (accounting_status IN ('UNPOSTED','POSTED','REVERSED')),
  gl_posted BOOLEAN NOT NULL DEFAULT false,
  gl_journal_id BIGINT,
  duplicate_of_id BIGINT REFERENCES expense_transactions(id),
  risk_score NUMERIC(6,2) NOT NULL DEFAULT 0,
  risk_level TEXT NOT NULL DEFAULT 'LOW'
    CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  risk_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  paid_by BIGINT REFERENCES users(id),
  paid_at TIMESTAMPTZ,
  posted_by BIGINT REFERENCES users(id),
  posted_at TIMESTAMPTZ,
  voided_by BIGINT REFERENCES users(id),
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  UNIQUE (company_id, exp_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_exp_tx_date ON expense_transactions(exp_date);
CREATE INDEX idx_exp_tx_dept ON expense_transactions(department_id, exp_date);
CREATE INDEX idx_exp_tx_status ON expense_transactions(status);
CREATE INDEX idx_exp_tx_cat ON expense_transactions(category_id);
CREATE INDEX idx_exp_tx_supplier ON expense_transactions(supplier_id);
CREATE INDEX idx_exp_tx_project ON expense_transactions(project_id);

CREATE TABLE expense_lines (
  id BIGSERIAL PRIMARY KEY,
  expense_transaction_id BIGINT NOT NULL REFERENCES expense_transactions(id) ON DELETE CASCADE,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  line_no INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL,
  category_id BIGINT REFERENCES expense_categories(id),
  account_id BIGINT REFERENCES chart_of_accounts(id),
  cost_centre_id BIGINT REFERENCES cost_centres(id),
  project_id BIGINT REFERENCES projects(id),
  quantity NUMERIC(18,4) DEFAULT 1,
  unit_cost NUMERIC(18,2) DEFAULT 0,
  amount NUMERIC(18,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_exp_lines_tx ON expense_lines(expense_transaction_id);

CREATE TABLE expense_allocations (
  id BIGSERIAL PRIMARY KEY,
  expense_transaction_id BIGINT NOT NULL REFERENCES expense_transactions(id) ON DELETE CASCADE,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  allocation_type TEXT NOT NULL
    CHECK (allocation_type IN ('COST_CENTRE','PROJECT','BUDGET','ACCOUNT')),
  ref_id BIGINT,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_exp_alloc_tx ON expense_allocations(expense_transaction_id);

-- ============================================================
-- 4. Petty Cash
-- ============================================================
CREATE TABLE petty_cash_funds (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  custodian_user_id BIGINT REFERENCES users(id),
  currency TEXT NOT NULL DEFAULT 'UGX',
  float_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  opening_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE petty_cash_transactions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  fund_id BIGINT NOT NULL REFERENCES petty_cash_funds(id),
  tx_date DATE NOT NULL DEFAULT CURRENT_DATE,
  tx_type TEXT NOT NULL
    CHECK (tx_type IN ('RECEIPT','EXPENSE','TOP_UP','RETURN','ADJUSTMENT','REPLENISHMENT')),
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  reference TEXT,
  description TEXT,
  expense_transaction_id BIGINT REFERENCES expense_transactions(id),
  replenishment_id BIGINT,
  created_by BIGINT REFERENCES users(id),
  balance_after NUMERIC(18,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pc_tx_fund ON petty_cash_transactions(fund_id, tx_date);

CREATE TABLE petty_cash_replenishments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  rep_no TEXT NOT NULL,
  fund_id BIGINT NOT NULL REFERENCES petty_cash_funds(id),
  rep_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','PAID','REJECTED','VOID')),
  requested_by BIGINT REFERENCES users(id),
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  paid_by BIGINT REFERENCES users(id),
  paid_at TIMESTAMPTZ,
  payment_method_id BIGINT,
  gl_posted BOOLEAN NOT NULL DEFAULT false,
  gl_journal_id BIGINT,
  UNIQUE (company_id, rep_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pcr_fund ON petty_cash_replenishments(fund_id, status);

-- ============================================================
-- 5. Employee Expense Claims
-- ============================================================
CREATE TABLE employee_expense_claims (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  claim_no TEXT NOT NULL,
  employee_id BIGINT REFERENCES employees(id),
  created_by BIGINT NOT NULL REFERENCES users(id),
  trip TEXT,
  description TEXT,
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REIMBURSED','REJECTED','VOID')),
  payment_method_id BIGINT,
  gl_posted BOOLEAN NOT NULL DEFAULT false,
  gl_journal_id BIGINT,
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  reimbursed_by BIGINT REFERENCES users(id),
  reimbursed_at TIMESTAMPTZ,
  UNIQUE (company_id, claim_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_claims_emp ON employee_expense_claims(employee_id, status);

-- ============================================================
-- 6. Receipts & digital evidence
-- ============================================================
CREATE TABLE expense_receipts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  ref_type TEXT NOT NULL
    CHECK (ref_type IN ('EXPENSE','CLAIM','REQUISITION','REPLENISHMENT','SUPPLIER_INVOICE','PAYMENT')),
  ref_id BIGINT NOT NULL,
  document_id BIGINT REFERENCES documents(id),
  file_name TEXT,
  mime_type TEXT,
  file_url TEXT,
  content_hash TEXT,
  supplier TEXT,
  invoice_no TEXT,
  receipt_date DATE,
  tax_amount NUMERIC(18,2),
  total NUMERIC(18,2),
  currency TEXT DEFAULT 'UGX',
  ocr_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  verified BOOLEAN NOT NULL DEFAULT false,
  verified_by BIGINT REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_exp_receipts_ref ON expense_receipts(ref_type, ref_id);
CREATE INDEX idx_exp_receipts_hash ON expense_receipts(content_hash);
CREATE INDEX idx_exp_receipts_inv ON expense_receipts(invoice_no);

-- ============================================================
-- 7. Payment requests & methods
-- ============================================================
CREATE TABLE payment_methods (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  method_type TEXT NOT NULL DEFAULT 'CASH'
    CHECK (method_type IN ('CASH','BANK','MOBILE_MONEY','CARD','CREDIT',
      'REIMBURSEMENT','PETTY_CASH','DIRECT_SUPPLIER')),
  channel TEXT,
  bank_account_id BIGINT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pay_methods_type ON payment_methods(method_type);

CREATE TABLE payment_requests (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  pay_no TEXT NOT NULL,
  ref_type TEXT NOT NULL
    CHECK (ref_type IN ('EXPENSE','CLAIM','REPLENISHMENT','SUPPLIER_INVOICE','REQUISITION')),
  ref_id BIGINT NOT NULL,
  ref_code TEXT,
  payee TEXT,
  payee_type TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (payee_type IN ('SUPPLIER','EMPLOYEE','OTHER')),
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'UGX',
  payment_method_id BIGINT REFERENCES payment_methods(id),
  bank_account_id BIGINT,
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','PAID','REJECTED','VOID')),
  requested_by BIGINT REFERENCES users(id),
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  paid_by BIGINT REFERENCES users(id),
  paid_at TIMESTAMPTZ,
  gl_posted BOOLEAN NOT NULL DEFAULT false,
  gl_journal_id BIGINT,
  UNIQUE (company_id, pay_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pay_req_ref ON payment_requests(ref_type, ref_id);
CREATE INDEX idx_pay_req_status ON payment_requests(status);

-- ============================================================
-- 8. Approval actions & financial postings (generic audit spine)
-- ============================================================
CREATE TABLE approval_actions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  entity_type TEXT NOT NULL,
  entity_id BIGINT NOT NULL,
  entity_code TEXT,
  action TEXT NOT NULL
    CHECK (action IN ('SUBMIT','APPROVE','REJECT','CHANGES_REQUESTED','DELEGATE','COMMENT','VOID')),
  actor_user_id BIGINT REFERENCES users(id),
  comment TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_approval_actions_entity ON approval_actions(entity_type, entity_id);

CREATE TABLE financial_postings (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  ref_type TEXT NOT NULL,
  ref_id BIGINT NOT NULL,
  ref_code TEXT,
  journal_id BIGINT NOT NULL,
  posting_type TEXT NOT NULL DEFAULT 'EXPENSE'
    CHECK (posting_type IN ('EXPENSE','PAYMENT','REIMBURSEMENT','REPLENISHMENT','ACCRUAL')),
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  posted_by BIGINT REFERENCES users(id),
  posted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'POSTED'
    CHECK (status IN ('POSTED','REVERSED'))
);
CREATE INDEX idx_fin_postings_ref ON financial_postings(ref_type, ref_id);

-- ============================================================
-- 9. Daily cash close & reconciliation
-- ============================================================
CREATE TABLE daily_cash_closings (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  close_no TEXT NOT NULL,
  close_date DATE NOT NULL,
  opening_cash NUMERIC(18,2) NOT NULL DEFAULT 0,
  cash_received NUMERIC(18,2) NOT NULL DEFAULT 0,
  cash_spent NUMERIC(18,2) NOT NULL DEFAULT 0,
  cash_transfers NUMERIC(18,2) NOT NULL DEFAULT 0,
  expected_closing NUMERIC(18,2) NOT NULL DEFAULT 0,
  physical_cash NUMERIC(18,2) NOT NULL DEFAULT 0,
  variance NUMERIC(18,2) NOT NULL DEFAULT 0,
  variance_explanation TEXT,
  review_notes JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','VOID')),
  submitted_by BIGINT REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  UNIQUE (company_id, close_no),
  UNIQUE (company_id, close_date),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dcc_date ON daily_cash_closings(close_date);

CREATE TABLE cash_reconciliations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  ref_type TEXT NOT NULL
    CHECK (ref_type IN ('DAILY_CLOSE','PETTY_CASH','BANK','MOBILE_MONEY')),
  ref_id BIGINT NOT NULL,
  fund_id BIGINT REFERENCES petty_cash_funds(id),
  cash_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  counted_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  variance NUMERIC(18,2) NOT NULL DEFAULT 0,
  variance_explanation TEXT,
  reconciled_by BIGINT REFERENCES users(id),
  reconciled_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','MATCHED','VARIANCE','APPROVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_cash_recon_ref ON cash_reconciliations(ref_type, ref_id);


-- ============================================================
-- 10. Immutability & audit triggers
-- ============================================================
CREATE OR REPLACE FUNCTION guard_ops_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% records are immutable and cannot be deleted', TG_TABLE_NAME;
  END IF;
  -- Posted / closed financial records may only transition to VOID.
  IF OLD.status IN ('POSTED','CLOSED','PAID') AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status NOT IN ('VOID') THEN
    RAISE EXCEPTION '% record status % is immutable (only VOID is allowed)', TG_TABLE_NAME, OLD.status;
  END IF;
  IF OLD.status = 'VOID' AND NEW.status IS DISTINCT FROM 'VOID' THEN
    RAISE EXCEPTION 'Voided % records cannot be re-activated', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION log_expense_change() RETURNS trigger AS $$
BEGIN
  INSERT INTO expense_audit_logs
    (company_id, tenant_id, branch_id, entity_type, entity_id, entity_code,
     action, actor_user_id, old_values, new_values)
  VALUES
    (OLD.company_id, OLD.tenant_id, OLD.branch_id, 'expense_transactions', OLD.id, OLD.exp_no,
     'UPDATE', NEW.updated_by, to_jsonb(OLD), to_jsonb(NEW));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_exp_tx_immutable
  BEFORE UPDATE OR DELETE ON expense_transactions
  FOR EACH ROW EXECUTE FUNCTION guard_ops_immutable();
CREATE TRIGGER trg_exp_tx_audit
  AFTER UPDATE ON expense_transactions
  FOR EACH ROW EXECUTE FUNCTION log_expense_change();
CREATE TRIGGER trg_pay_req_immutable
  BEFORE UPDATE OR DELETE ON payment_requests
  FOR EACH ROW EXECUTE FUNCTION guard_ops_immutable();
CREATE TRIGGER trg_pcr_immutable
  BEFORE UPDATE OR DELETE ON petty_cash_replenishments
  FOR EACH ROW EXECUTE FUNCTION guard_ops_immutable();
CREATE TRIGGER trg_dcc_immutable
  BEFORE UPDATE OR DELETE ON daily_cash_closings
  FOR EACH ROW EXECUTE FUNCTION guard_ops_immutable();
CREATE TRIGGER trg_claims_immutable
  BEFORE UPDATE OR DELETE ON employee_expense_claims
  FOR EACH ROW EXECUTE FUNCTION guard_ops_immutable();

-- Append-only posting/audit tables
CREATE OR REPLACE FUNCTION guard_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; records cannot be updated or deleted', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_append_only
  BEFORE UPDATE OR DELETE ON expense_audit_logs
  FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER trg_postings_append_only
  BEFORE UPDATE OR DELETE ON financial_postings
  FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER trg_approval_actions_append_only
  BEFORE UPDATE OR DELETE ON approval_actions
  FOR EACH ROW EXECUTE FUNCTION guard_append_only();

-- updated_at maintenance
CREATE TRIGGER trg_requisitions_touch BEFORE UPDATE ON requisitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_exp_tx_touch BEFORE UPDATE ON expense_transactions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_pay_req_touch BEFORE UPDATE ON payment_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_pcr_touch BEFORE UPDATE ON petty_cash_replenishments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_dcc_touch BEFORE UPDATE ON daily_cash_closings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_claims_touch BEFORE UPDATE ON employee_expense_claims FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 11. Row-level security (tenant isolation)
-- ============================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['expense_audit_logs','requisitions','requisition_lines',
    'requisition_approvals','requisition_fulfillments','expense_categories',
    'expense_transactions','expense_lines','expense_allocations','petty_cash_funds',
    'petty_cash_transactions','petty_cash_replenishments','employee_expense_claims',
    'expense_receipts','payment_methods','payment_requests','approval_actions',
    'financial_postings','daily_cash_closings','cash_reconciliations']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id())', t);
  END LOOP;
END;
$$;

-- ============================================================
-- 12. Seed: expense categories (configurable, per company)
-- ============================================================
INSERT INTO expense_categories (company_id, tenant_id, code, name, category_group, description)
SELECT c.id, c.tenant_id, v.code, v.name, v.grp, v.description
FROM companies c
CROSS JOIN (VALUES
  ('EXP-OPR-FUEL','Fuel','OPERATIONS','Fuel for vehicles, generators and plant'),
  ('EXP-OPR-ELEC','Electricity','OPERATIONS','Electricity bills and prepaid power'),
  ('EXP-OPR-WATER','Water','OPERATIONS','Water bills and supply'),
  ('EXP-OPR-INET','Internet','OPERATIONS','Internet and data connectivity'),
  ('EXP-OPR-TEL','Telephone','OPERATIONS','Telephone and airtime'),
  ('EXP-OPR-TRANSP','Transport','OPERATIONS','Local transport and delivery'),
  ('EXP-OPR-REPAIR','Repairs','OPERATIONS','General repairs'),
  ('EXP-OPR-MAINT','Maintenance','OPERATIONS','Preventive and corrective maintenance'),
  ('EXP-OPR-CLEAN','Cleaning','OPERATIONS','Cleaning services and materials'),
  ('EXP-FAC-CONSUM','Production consumables','FACTORY','Production consumables and inputs'),
  ('EXP-FAC-MACHREP','Machine repairs','FACTORY','Repairs to production machinery'),
  ('EXP-FAC-LUBE','Lubricants','FACTORY','Lubricants and oils'),
  ('EXP-FAC-SPARES','Spare parts','FACTORY','Spare parts for plant and machinery'),
  ('EXP-FAC-PPE','PPE','FACTORY','Personal protective equipment'),
  ('EXP-FAC-PACK','Packaging','FACTORY','Packaging materials'),
  ('EXP-FAC-WASTE','Waste disposal','FACTORY','Waste collection and disposal'),
  ('EXP-ADM-OFFWATER','Office water','ADMINISTRATION','Office drinking water'),
  ('EXP-ADM-STATIONERY','Stationery','ADMINISTRATION','Stationery and printing'),
  ('EXP-ADM-TEA','Tea','ADMINISTRATION','Tea and beverages'),
  ('EXP-ADM-SUGAR','Sugar','ADMINISTRATION','Sugar and pantry items'),
  ('EXP-ADM-CLEANSUP','Cleaning supplies','ADMINISTRATION','Cleaning supplies for offices'),
  ('EXP-ADM-OFFSUP','Office supplies','ADMINISTRATION','General office supplies'),
  ('EXP-STAFF-WELFARE','Staff welfare','STAFF','Staff welfare activities'),
  ('EXP-STAFF-MEALS','Meals','STAFF','Meals and refreshments'),
  ('EXP-STAFF-TRANSP','Local transport','STAFF','Staff local transport'),
  ('EXP-STAFF-ALLOW','Allowances','STAFF','Staff allowances'),
  ('EXP-STAFF-TRAIN','Training','STAFF','Staff training and development'),
  ('EXP-SM-ADVERT','Advertising','SALES_MARKETING','Advertising and media'),
  ('EXP-SM-PROMO','Promotion','SALES_MARKETING','Sales promotions'),
  ('EXP-SM-CUSTVISIT','Customer visits','SALES_MARKETING','Customer visit expenses'),
  ('EXP-SM-MATERIALS','Marketing materials','SALES_MARKETING','Marketing and promotional materials'),
  ('EXP-LOG-FUEL','Delivery fuel','LOGISTICS','Fuel for delivery vehicles'),
  ('EXP-LOG-VEHREP','Vehicle repairs','LOGISTICS','Delivery vehicle repairs'),
  ('EXP-LOG-LOAD','Loading','LOGISTICS','Loading costs'),
  ('EXP-LOG-OFFLOAD','Offloading','LOGISTICS','Offloading costs'),
  ('EXP-LOG-DELIVERY','Delivery costs','LOGISTICS','Delivery and distribution costs'),
  ('EXP-LOG-TRANSP','Logistics transport','LOGISTICS','Third-party transport hire')
) AS v(code, name, grp, description)
WHERE NOT EXISTS (SELECT 1 FROM expense_categories ec WHERE ec.company_id = c.id AND ec.code = v.code);

-- ============================================================
-- 13. Seed: payment methods (Uganda-ready channels)
-- ============================================================
INSERT INTO payment_methods (company_id, tenant_id, code, name, method_type, channel)
SELECT c.id, c.tenant_id, v.code, v.name, v.mtype, v.channel
FROM companies c
CROSS JOIN (VALUES
  ('PETTY_CASH','Petty Cash','PETTY_CASH',NULL),
  ('CASH','Cash','CASH',NULL),
  ('BANK_TRANSFER','Bank Transfer','BANK','BANK'),
  ('MTN_MOMO','MTN Mobile Money','MOBILE_MONEY','MTN'),
  ('AIRTEL_MONEY','Airtel Money','MOBILE_MONEY','AIRTEL'),
  ('CARD','Card','CARD',NULL),
  ('DIRECT_SUPPLIER','Direct Supplier Payment','DIRECT_SUPPLIER',NULL),
  ('EMPLOYEE_REIMBURSEMENT','Employee Reimbursement','REIMBURSEMENT',NULL),
  ('CREDIT_ACCOUNT','Credit Account','CREDIT',NULL)
) AS v(code, name, mtype, channel)
WHERE NOT EXISTS (SELECT 1 FROM payment_methods pm WHERE pm.company_id = c.id AND pm.code = v.code);

-- ============================================================
-- 14. Seed: default petty cash funds (per company)
-- ============================================================
INSERT INTO petty_cash_funds (company_id, tenant_id, branch_id, code, name, float_amount, opening_balance)
SELECT c.id, c.tenant_id, (SELECT b.id FROM branches b WHERE b.company_id = c.id ORDER BY b.id LIMIT 1), v.code, v.name, v.float, v.float
FROM companies c
CROSS JOIN (VALUES
  ('PC-MAIN','Main Office',2000000),
  ('PC-FACTORY','Factory',3000000),
  ('PC-PRODUCTION','Production',2000000),
  ('PC-LOGISTICS','Logistics',1500000),
  ('PC-MAINTENANCE','Maintenance',1000000),
  ('PC-ADMIN','Administration',500000)
) AS v(code, name, float)
WHERE NOT EXISTS (SELECT 1 FROM petty_cash_funds f WHERE f.company_id = c.id AND f.code = v.code);

-- ============================================================
-- 15. Seed: permissions (module: expenditure)
-- ============================================================
INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, 'expenditure', v.resource, v.action, v.description
FROM (VALUES
  ('expenditure.dashboards.view','dashboards','view','View the expenditure command centre'),
  ('expenditure.requisitions.view','requisitions','view','View requisitions'),
  ('expenditure.requisitions.create','requisitions','create','Create requisitions'),
  ('expenditure.requisitions.update','requisitions','update','Update draft requisitions'),
  ('expenditure.requisitions.submit','requisitions','submit','Submit requisitions for approval'),
  ('expenditure.requisitions.approve','requisitions','approve','Approve requisitions'),
  ('expenditure.requisitions.fulfill','requisitions','fulfill','Fulfil approved requisitions'),
  ('expenditure.requisitions.cancel','requisitions','cancel','Cancel requisitions'),
  ('expenditure.expenses.view','expenses','view','View daily expenditure'),
  ('expenditure.expenses.create','expenses','create','Create expenditure entries'),
  ('expenditure.expenses.update','expenses','update','Update draft expenditure entries'),
  ('expenditure.expenses.submit','expenses','submit','Submit expenditure for approval'),
  ('expenditure.expenses.approve','expenses','approve','Approve expenditure'),
  ('expenditure.expenses.post','expenses','post','Post expenditure to the ledger'),
  ('expenditure.expenses.void','expenses','void','Void expenditure entries'),
  ('expenditure.petty_cash.view','petty_cash','view','View petty cash funds'),
  ('expenditure.petty_cash.create','petty_cash','create','Record petty cash transactions'),
  ('expenditure.petty_cash.update','petty_cash','update','Update petty cash funds'),
  ('expenditure.petty_cash.replenish','petty_cash','replenish','Request petty cash replenishment'),
  ('expenditure.petty_cash.reconcile','petty_cash','reconcile','Reconcile petty cash'),
  ('expenditure.claims.view','claims','view','View employee expense claims'),
  ('expenditure.claims.create','claims','create','Submit employee expense claims'),
  ('expenditure.claims.approve','claims','approve','Approve employee expense claims'),
  ('expenditure.claims.reimburse','claims','reimburse','Reimburse approved claims'),
  ('expenditure.receipts.view','receipts','view','View receipts'),
  ('expenditure.receipts.upload','receipts','upload','Upload receipts'),
  ('expenditure.receipts.verify','receipts','verify','Verify receipt data'),
  ('expenditure.payments.view','payments','view','View payment requests'),
  ('expenditure.payments.create','payments','create','Create payment requests'),
  ('expenditure.payments.approve','payments','approve','Approve payment requests'),
  ('expenditure.payments.post','payments','post','Record payments'),
  ('expenditure.daily_close.view','daily_close','view','View daily cash closing'),
  ('expenditure.daily_close.create','daily_close','create','Submit daily cash closing'),
  ('expenditure.daily_close.approve','daily_close','approve','Approve daily cash closing'),
  ('expenditure.reports.view','reports','view','View expenditure reports'),
  ('expenditure.settings.manage','settings','manage','Configure expense settings and categories')
) AS v(code, resource, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code LIKE 'expenditure.%'
WHERE r.code IN (
  'super_administrator','system_administrator','cfo','finance_manager',
  'chief_accountant','managing_director','executive_director','general_manager',
  'operations_director','procurement_manager','commercial_director'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ============================================================
-- 16. Seed: configurable approval workflows (threshold bands stored
--     in workflows.config JSONB - editable, never hard-coded)
-- ============================================================
-- Requisitions: 0-500k dept mgr | 500k-5M dept head + finance |
--               5M-20M finance + MD | >20M CFO + Executive
INSERT INTO workflows (company_id, tenant_id, code, name, entity_type, description, config, is_active)
SELECT c.id, c.tenant_id, 'WF-REQ', 'Requisition Approval', 'ops.requisitions',
  'Tiered requisition approval by value (configurable in this workflow).',
  '[{"seq":1,"name":"Department Manager Approval","approver_role":"finance_manager","amount_min":0,"amount_max":500000,"sla_hours":24},
    {"seq":1,"name":"Department Head Approval","approver_role":"operations_director","amount_min":500000,"amount_max":5000000,"sla_hours":24},
    {"seq":2,"name":"Finance Approval","approver_role":"finance_manager","amount_min":500000,"amount_max":5000000,"sla_hours":24},
    {"seq":1,"name":"Finance Manager Approval","approver_role":"finance_manager","amount_min":5000000,"amount_max":20000000,"sla_hours":24},
    {"seq":2,"name":"Managing Director Approval","approver_role":"managing_director","amount_min":5000000,"amount_max":20000000,"sla_hours":48},
    {"seq":1,"name":"CFO Approval","approver_role":"cfo","amount_min":20000000,"amount_max":1000000000,"sla_hours":24},
    {"seq":2,"name":"Executive Approval","approver_role":"executive_director","amount_min":20000000,"amount_max":1000000000,"sla_hours":48}]'::jsonb,
  true
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM workflows w WHERE w.company_id = c.id AND w.code = 'WF-REQ');

INSERT INTO workflows (company_id, tenant_id, code, name, entity_type, description, config, is_active)
SELECT c.id, c.tenant_id, 'WF-EXP', 'Expenditure Approval', 'ops.expenses',
  'Tiered daily expenditure approval by value (configurable in this workflow).',
  '[{"seq":1,"name":"Department Manager Approval","approver_role":"finance_manager","amount_min":0,"amount_max":500000,"sla_hours":24},
    {"seq":1,"name":"Finance Approval","approver_role":"finance_manager","amount_min":500000,"amount_max":5000000,"sla_hours":24},
    {"seq":2,"name":"Managing Director Approval","approver_role":"managing_director","amount_min":5000000,"amount_max":20000000,"sla_hours":48},
    {"seq":1,"name":"CFO Approval","approver_role":"cfo","amount_min":20000000,"amount_max":1000000000,"sla_hours":24},
    {"seq":2,"name":"Executive Approval","approver_role":"executive_director","amount_min":20000000,"amount_max":1000000000,"sla_hours":48}]'::jsonb,
  true
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM workflows w WHERE w.company_id = c.id AND w.code = 'WF-EXP');

INSERT INTO workflows (company_id, tenant_id, code, name, entity_type, description, config, is_active)
SELECT c.id, c.tenant_id, 'WF-CLAIM', 'Employee Expense Claim Approval', 'ops.claims',
  'Employee claims approved by finance; large claims need MD sign-off.',
  '[{"seq":1,"name":"Finance Approval","approver_role":"finance_manager","amount_min":0,"amount_max":1000000,"sla_hours":24},
    {"seq":1,"name":"Finance Manager Approval","approver_role":"finance_manager","amount_min":1000000,"amount_max":5000000,"sla_hours":24},
    {"seq":2,"name":"Managing Director Approval","approver_role":"managing_director","amount_min":1000000,"amount_max":5000000,"sla_hours":48},
    {"seq":1,"name":"CFO Approval","approver_role":"cfo","amount_min":5000000,"amount_max":1000000000,"sla_hours":24},
    {"seq":2,"name":"Executive Approval","approver_role":"executive_director","amount_min":5000000,"amount_max":1000000000,"sla_hours":48}]'::jsonb,
  true
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM workflows w WHERE w.company_id = c.id AND w.code = 'WF-CLAIM');

INSERT INTO workflows (company_id, tenant_id, code, name, entity_type, description, config, is_active)
SELECT c.id, c.tenant_id, 'WF-PCR', 'Petty Cash Replenishment Approval', 'ops.replenishments',
  'Petty cash replenishment approval by value.',
  '[{"seq":1,"name":"Finance Approval","approver_role":"finance_manager","amount_min":0,"amount_max":5000000,"sla_hours":24},
    {"seq":1,"name":"CFO Approval","approver_role":"cfo","amount_min":5000000,"amount_max":1000000000,"sla_hours":24},
    {"seq":2,"name":"Managing Director Approval","approver_role":"managing_director","amount_min":5000000,"amount_max":1000000000,"sla_hours":48}]'::jsonb,
  true
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM workflows w WHERE w.company_id = c.id AND w.code = 'WF-PCR');

INSERT INTO workflows (company_id, tenant_id, code, name, entity_type, description, config, is_active)
SELECT c.id, c.tenant_id, 'WF-DCLOSE', 'Daily Cash Close Approval', 'ops.daily_closings',
  'Daily cash close approved by finance.',
  '[{"seq":1,"name":"Finance Manager Approval","approver_role":"finance_manager","amount_min":0,"amount_max":1000000000,"sla_hours":24}]'::jsonb,
  true
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM workflows w WHERE w.company_id = c.id AND w.code = 'WF-DCLOSE');
