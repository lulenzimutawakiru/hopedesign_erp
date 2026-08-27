-- ============================================================
-- 0083 Advanced Finance & Accounting - HOPE DESIGN GROUP LTD
-- Journal workflow lifecycle, posting rules engine, Uganda tax
-- engine + EFRIS adapter, budget control, manufacturing costing,
-- intercompany / consolidation, period close cockpit, audit logs
-- ============================================================

-- ---------- 1. Journal entry workflow lifecycle ----------
ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_status_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_status_check
  CHECK (status IN ('DRAFT','SUBMITTED','PENDING_APPROVAL','APPROVED','POSTED','REJECTED','VOID','VOIDED','REVERSED'));

ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_journal_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_journal_type_check
  CHECK (journal_type IN (
    'MANUAL','OPENING','SALES_INVOICE','CUSTOMER_RECEIPT','CREDIT_NOTE',
    'PURCHASE_INVOICE','SUPPLIER_PAYMENT','GRN_RECEIPT','PRODUCTION',
    'INVENTORY_ADJUSTMENT','EXPENSE','PAYROLL','ASSET','BANK','TAX','TRANSFER',
    'HEALTHCARE_BILL','CASH_ADVANCE','ADVANCE_SETTLEMENT',
    'REVERSAL','FX_REVALUATION','ACCRUAL','DEFERRAL','ALLOCATION',
    'INTERCOMPANY','CONSOLIDATION','PRODUCTION_COSTING','ASSET_DEPRECIATION',
    'BUDGET_ENCUMBRANCE','PERIOD_CLOSE'));

ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS submitted_by BIGINT,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by BIGINT,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by BIGINT,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS reversed_by BIGINT,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversal_entry_id BIGINT REFERENCES journal_entries(id),
  ADD COLUMN IF NOT EXISTS is_template BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recurring_frequency TEXT
    CHECK (recurring_frequency IS NULL OR recurring_frequency IN ('DAILY','WEEKLY','MONTHLY','QUARTERLY','ANNUAL')),
  ADD COLUMN IF NOT EXISTS next_run_date DATE,
  ADD COLUMN IF NOT EXISTS reverse_on_post BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_type TEXT,
  ADD COLUMN IF NOT EXISTS source_ref TEXT;

CREATE INDEX IF NOT EXISTS idx_journal_status ON journal_entries(status);
CREATE INDEX IF NOT EXISTS idx_journal_period ON journal_entries(period_id);

-- ---------- 2. Journal validation / posting / reversal (SQL invariants) ----------
CREATE OR REPLACE FUNCTION journal_balance(p_entry bigint) RETURNS numeric AS $$
  SELECT round(COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0), 2)
  FROM journal_lines WHERE entry_id = p_entry;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION post_journal_entry(p_entry bigint, p_user bigint) RETURNS void AS $$
DECLARE
  v_status text; v_company bigint; v_date date; v_pid bigint; v_diff numeric;
BEGIN
  SELECT status, company_id, entry_date, period_id INTO v_status, v_company, v_date, v_pid
  FROM journal_entries WHERE id = p_entry;
  IF NOT FOUND THEN RAISE EXCEPTION 'Journal entry % not found', p_entry; END IF;
  IF v_status NOT IN ('DRAFT','SUBMITTED','PENDING_APPROVAL','APPROVED') THEN
    RAISE EXCEPTION 'Journal % cannot be posted from status %', p_entry, v_status;
  END IF;
  v_diff := journal_balance(p_entry);
  IF v_diff <> 0 THEN RAISE EXCEPTION 'Journal does not balance: debit-credit = %', v_diff; END IF;
  IF (SELECT COUNT(*) FROM journal_lines WHERE entry_id = p_entry) < 2 THEN
    RAISE EXCEPTION 'A journal entry requires at least two lines';
  END IF;
  IF v_pid IS NULL THEN
    SELECT id INTO v_pid FROM financial_periods
    WHERE company_id = v_company AND start_date <= v_date AND end_date >= v_date
    ORDER BY start_date LIMIT 1;
  END IF;
  IF v_pid IS NULL THEN RAISE EXCEPTION 'No financial period covers %', v_date; END IF;
  IF EXISTS (SELECT 1 FROM financial_periods WHERE id = v_pid AND status NOT IN ('OPEN','SOFT_CLOSE')) THEN
    RAISE EXCEPTION 'Financial period is not open';
  END IF;
  UPDATE journal_entries
    SET status='POSTED', posted_by=p_user, posted_at=now(), period_id=v_pid,
        approved_by=COALESCE(approved_by, p_user), approved_at=COALESCE(approved_at, now())
  WHERE id = p_entry;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION reverse_journal(p_entry bigint, p_user bigint, p_reason text DEFAULT 'Correction') RETURNS bigint AS $$
DECLARE
  v_rev bigint; v_company bigint; v_tenant bigint; v_branch bigint; v_date date;
  v_type text; v_desc text; v_cur text; v_rate numeric; v_ref text; v_no text; v_line record;
BEGIN
  SELECT company_id, tenant_id, branch_id, entry_date, journal_type, description,
         currency, exchange_rate, entry_no
    INTO v_company, v_tenant, v_branch, v_date, v_type, v_desc, v_cur, v_rate, v_no
  FROM journal_entries WHERE id = p_entry;
  IF NOT FOUND THEN RAISE EXCEPTION 'Journal % not found', p_entry; END IF;
  IF (SELECT status FROM journal_entries WHERE id = p_entry) <> 'POSTED' THEN
    RAISE EXCEPTION 'Only posted journals can be reversed';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_entries WHERE reversal_of_id = p_entry) THEN
    RAISE EXCEPTION 'Journal % already has a reversal', p_entry;
  END IF;
  v_ref := next_doc_no(v_tenant, 'GL');
  INSERT INTO journal_entries (
    company_id, tenant_id, branch_id, entry_no, entry_date, period_id, journal_type,
    reference_type, reference_id, reference_code, description, currency, exchange_rate,
    total_debit, total_credit, status, posted_by, posted_at, reversal_of_id
  )
  SELECT v_company, v_tenant, v_branch, v_ref, v_date,
         (SELECT id FROM financial_periods WHERE company_id = v_company AND start_date <= v_date AND end_date >= v_date ORDER BY start_date LIMIT 1),
         'REVERSAL', 'JOURNAL', p_entry, v_no,
         'Reversal of ' || v_no || ' - ' || v_desc || COALESCE(' (' || p_reason || ')',''),
         v_cur, v_rate, total_credit, total_debit, 'POSTED', p_user, now(), p_entry
  FROM journal_entries WHERE id = p_entry
  RETURNING id INTO v_rev;
  FOR v_line IN SELECT account_id, cost_centre_id, profit_centre_id, debit, credit, description
               FROM journal_lines WHERE entry_id = p_entry LOOP
    INSERT INTO journal_lines (entry_id, account_id, cost_centre_id, profit_centre_id, debit, credit, description)
    VALUES (v_rev, v_line.account_id, v_line.cost_centre_id, v_line.profit_centre_id,
            v_line.credit, v_line.debit, v_line.description);
  END LOOP;
  UPDATE journal_entries SET status='REVERSED', reversed_by=p_user, reversed_at=now(), reversal_entry_id=v_rev
  WHERE id = p_entry;
  RETURN v_rev;
END; $$ LANGUAGE plpgsql;

-- ---------- 3. Journal templates + configurable posting rules ----------
CREATE TABLE journal_templates (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  journal_type TEXT NOT NULL DEFAULT 'MANUAL',
  description TEXT,
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE posting_rules (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  event TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  journal_type TEXT NOT NULL DEFAULT 'MANUAL',
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (company_id, event, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the core Uganda manufacturing posting rules (configurable, not hardcoded in UI)
INSERT INTO posting_rules (company_id, tenant_id, event, code, name, journal_type, lines)
SELECT c.id, c.tenant_id, v.event, v.code, v.name, v.journal_type, v.lines::jsonb
FROM companies c
CROSS JOIN (VALUES
  ('GOODS_RECEIPT','GRN_INVENTORY','Goods received - inventory vs GRNI','GRN_RECEIPT',
   '[{"account_code":"1310","debit":"{{amount}}","credit":"0"},{"account_code":"GRNI","debit":"0","credit":"{{amount}}"}]'),
  ('SUPPLIER_INVOICE','AP_GRNI_CLEAR','Supplier invoice - GRNI to Accounts Payable','PURCHASE_INVOICE',
   '[{"account_code":"GRNI","debit":"{{amount}}","credit":"0"},{"account_code":"2100","debit":"0","credit":"{{amount}}"}]'),
  ('CUSTOMER_RECEIPT','AR_CASH','Customer receipt - cash vs AR','CUSTOMER_RECEIPT',
   '[{"account_code":"1100","debit":"{{amount}}","credit":"0"},{"account_code":"1400","debit":"0","credit":"{{amount}}"}]'),
  ('PRODUCTION_COMPLETE','FG_WIP','Production complete - finished goods vs WIP','PRODUCTION_COSTING',
   '[{"account_code":"1320","debit":"{{amount}}","credit":"0"},{"account_code":"1330","debit":"0","credit":"{{amount}}"}]'),
  ('SALES_INVOICE','AR_REVENUE','Sales invoice - AR vs revenue and VAT','SALES_INVOICE',
   '[{"account_code":"1400","debit":"{{amount}}","credit":"0"},{"account_code":"4000","debit":"0","credit":"{{net}}"},{"account_code":"2110","debit":"0","credit":"{{tax}}"}]')
) AS v(event, code, name, journal_type, lines)
WHERE c.code = 'HDG'
ON CONFLICT (company_id, event, code) DO NOTHING;

-- ---------- 4. Tax engine ----------
CREATE TABLE tax_jurisdictions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'UG',
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tax_rules (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  jurisdiction_id BIGINT NOT NULL REFERENCES tax_jurisdictions(id),
  tax_id BIGINT NOT NULL REFERENCES taxes(id),
  applies_to TEXT NOT NULL DEFAULT 'BOTH'
    CHECK (applies_to IN ('SALES','PURCHASE','BOTH','PAYROLL','IMPORT')),
  rate_override NUMERIC(8,4),
  threshold_amount NUMERIC(18,2),
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (company_id, jurisdiction_id, tax_id, applies_to),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tax_transactions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  tax_id BIGINT NOT NULL REFERENCES taxes(id),
  jurisdiction_id BIGINT REFERENCES tax_jurisdictions(id),
  doc_type TEXT NOT NULL,
  doc_ref_type TEXT,
  doc_ref_id BIGINT,
  doc_ref_code TEXT,
  txn_date DATE NOT NULL,
  base_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  rate NUMERIC(8,4) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'POSTED',
  period_id BIGINT REFERENCES financial_periods(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, doc_type, doc_ref_type, doc_ref_id, tax_id)
);

INSERT INTO tax_jurisdictions (company_id, tenant_id, code, name, country)
SELECT c.id, c.tenant_id, 'UG-EFRIS', 'Uganda - URA EFRIS', 'UG'
FROM companies c WHERE c.code = 'HDG'
ON CONFLICT (company_id, code) DO NOTHING;

-- ---------- 5. URA EFRIS integration (ERP records and fiscal records linked but separate) ----------
CREATE TABLE efris_transactions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  doc_type TEXT NOT NULL,
  doc_ref_type TEXT NOT NULL,
  doc_ref_id BIGINT NOT NULL,
  doc_ref_code TEXT NOT NULL,
  txn_date DATE NOT NULL,
  currency TEXT NOT NULL DEFAULT 'UGX',
  gross_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','QUEUED','TRANSMITTED','FISCALIZED','FAILED','RETRYING','CANCELLED')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  transmitted_at TIMESTAMPTZ,
  fiscalized_at TIMESTAMPTZ,
  UNIQUE (tenant_id, idempotency_key),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE efris_documents (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  efris_transaction_id BIGINT NOT NULL UNIQUE REFERENCES efris_transactions(id),
  erp_doc_no TEXT NOT NULL,
  fdn TEXT,
  verification_code TEXT,
  qr_ref TEXT,
  response_payload JSONB,
  transmitted_at TIMESTAMPTZ,
  fiscalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE efris_sync_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  efris_transaction_id BIGINT NOT NULL REFERENCES efris_transactions(id),
  status TEXT NOT NULL,
  request_payload JSONB,
  response_payload JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_efris_status ON efris_transactions(status);
CREATE INDEX IF NOT EXISTS idx_efris_doc ON efris_transactions(doc_ref_type, doc_ref_id);

-- ---------- 6. Budget control: revisions + commitments + availability check ----------
CREATE TABLE budget_revisions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  budget_id BIGINT NOT NULL REFERENCES budgets(id),
  amount NUMERIC(18,2) NOT NULL,
  reason TEXT,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE budget_commitments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  budget_id BIGINT NOT NULL REFERENCES budgets(id),
  account_id BIGINT NOT NULL REFERENCES chart_of_accounts(id),
  doc_type TEXT NOT NULL,
  doc_ref_type TEXT,
  doc_ref_id BIGINT,
  doc_ref_code TEXT,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'COMMITTED'
    CHECK (status IN ('COMMITTED','RELEASED','EXPIRED')),
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  UNIQUE (tenant_id, doc_type, doc_ref_type, doc_ref_id, account_id)
);

CREATE OR REPLACE FUNCTION check_budget_available(
  p_company bigint, p_tenant bigint, p_account bigint, p_amount numeric,
  p_doc_type text, p_doc_ref_type text, p_doc_ref_id bigint
) RETURNS text AS $$
DECLARE
  v_budget_total numeric := 0; v_committed numeric := 0; v_spent numeric := 0; v_available numeric;
BEGIN
  SELECT COALESCE(SUM(b.amount),0) INTO v_budget_total
  FROM budgets b JOIN budget_lines bl ON bl.budget_id = b.id
  WHERE b.company_id = p_company AND b.tenant_id = p_tenant
    AND b.status IN ('APPROVED','ACTIVE')
    AND bl.account_id = p_account
    AND b.period_start <= CURRENT_DATE AND b.period_end >= CURRENT_DATE;
  IF v_budget_total = 0 THEN RETURN 'ALLOW'; END IF;
  SELECT COALESCE(SUM(c.amount),0) INTO v_committed
  FROM budget_commitments c
  WHERE c.tenant_id = p_tenant AND c.account_id = p_account AND c.status = 'COMMITTED'
    AND NOT (c.doc_type = p_doc_type
             AND c.doc_ref_type IS NOT DISTINCT FROM p_doc_ref_type
             AND c.doc_ref_id IS NOT DISTINCT FROM p_doc_ref_id);
  SELECT COALESCE(SUM(jl.debit - jl.credit),0) INTO v_spent
  FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
  WHERE je.tenant_id = p_tenant AND je.status = 'POSTED' AND jl.account_id = p_account;
  v_available := v_budget_total - v_committed - v_spent;
  IF v_available >= p_amount THEN RETURN 'ALLOW';
  ELSIF v_available >= 0 THEN RETURN 'WARNING';
  ELSE RETURN 'BLOCK'; END IF;
END; $$ LANGUAGE plpgsql;

-- ---------- 7. Manufacturing costing ----------
CREATE TABLE allocation_rules (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  source_cost_centre_id BIGINT REFERENCES cost_centres(id),
  driver TEXT NOT NULL DEFAULT 'MACHINE_HOURS'
    CHECK (driver IN ('MACHINE_HOURS','LABOUR_HOURS','PRODUCTION_QUANTITY','MATERIAL_COST','FLOOR_SPACE','REVENUE','CUSTOM')),
  rate NUMERIC(18,6) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE production_costs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  work_order_id BIGINT REFERENCES work_orders(id),
  product_id BIGINT REFERENCES products(id),
  period_id BIGINT REFERENCES financial_periods(id),
  cost_date DATE NOT NULL DEFAULT CURRENT_DATE,
  quantity NUMERIC(18,2) NOT NULL DEFAULT 0,
  expected_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  actual_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  variance NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','CALCULATED','POSTED')),
  journal_id BIGINT REFERENCES journal_entries(id),
  calculated_by BIGINT,
  calculated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE production_cost_components (
  id BIGSERIAL PRIMARY KEY,
  production_cost_id BIGINT NOT NULL REFERENCES production_costs(id) ON DELETE CASCADE,
  component_type TEXT NOT NULL
    CHECK (component_type IN ('MATERIAL','LABOUR','MACHINE','POWER','CONSUMABLES','PACKAGING','QUALITY','OVERHEAD','WASTE')),
  cost_centre_id BIGINT REFERENCES cost_centres(id),
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  quantity NUMERIC(18,4),
  rate NUMERIC(18,6),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cost_variances (
  id BIGSERIAL PRIMARY KEY,
  production_cost_id BIGINT NOT NULL REFERENCES production_costs(id) ON DELETE CASCADE,
  variance_type TEXT NOT NULL
    CHECK (variance_type IN ('MATERIAL_PRICE','MATERIAL_USAGE','LABOUR_RATE','LABOUR_EFFICIENCY','MACHINE','OVERHEAD','TOTAL')),
  expected NUMERIC(18,2) NOT NULL DEFAULT 0,
  actual NUMERIC(18,2) NOT NULL DEFAULT 0,
  variance NUMERIC(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wip_ledger (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  work_order_id BIGINT REFERENCES work_orders(id),
  txn_type TEXT NOT NULL
    CHECK (txn_type IN ('MATERIAL_ISSUE','LABOUR','MACHINE','OVERHEAD','COMPLETE','SCRAP','ADJUSTMENT')),
  txn_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  account_id BIGINT REFERENCES chart_of_accounts(id),
  journal_id BIGINT REFERENCES journal_entries(id),
  notes TEXT,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prodcost_wo ON production_costs(work_order_id);
CREATE INDEX IF NOT EXISTS idx_wip_wo ON wip_ledger(work_order_id);

-- ---------- 8. Intercompany + consolidation ----------
CREATE TABLE intercompany_transactions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  from_company_id BIGINT NOT NULL REFERENCES companies(id),
  to_company_id BIGINT NOT NULL REFERENCES companies(id),
  doc_no TEXT NOT NULL,
  txn_date DATE NOT NULL,
  currency TEXT NOT NULL DEFAULT 'UGX',
  exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','POSTED','VOID')),
  from_journal_id BIGINT,
  to_journal_id BIGINT,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, doc_no)
);

CREATE TABLE consolidation_runs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  target_currency TEXT NOT NULL DEFAULT 'UGX',
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','VALIDATED','COMPLETED','FAILED')),
  results JSONB,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE elimination_entries (
  id BIGSERIAL PRIMARY KEY,
  consolidation_run_id BIGINT NOT NULL REFERENCES consolidation_runs(id) ON DELETE CASCADE,
  company_id BIGINT REFERENCES companies(id),
  account_code TEXT NOT NULL,
  debit NUMERIC(18,2) NOT NULL DEFAULT 0,
  credit NUMERIC(18,2) NOT NULL DEFAULT 0,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 9. Period close cockpit ----------
ALTER TABLE financial_periods DROP CONSTRAINT financial_periods_status_check;
ALTER TABLE financial_periods ADD CONSTRAINT financial_periods_status_check
  CHECK (status IN ('OPEN','SOFT_CLOSE','LOCKED','CLOSED'));

CREATE TABLE financial_close_tasks (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  period_id BIGINT NOT NULL REFERENCES financial_periods(id),
  task_key TEXT NOT NULL,
  task_name TEXT NOT NULL,
  owner_role TEXT,
  deadline DATE,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','BLOCKED','WAIVED')),
  dependency_task_key TEXT,
  reviewer_role TEXT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  notes TEXT,
  UNIQUE (company_id, period_id, task_key),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION seed_close_tasks(p_period_id bigint) RETURNS void AS $$
DECLARE v_company bigint; v_tenant bigint;
BEGIN
  SELECT company_id, tenant_id INTO v_company, v_tenant FROM financial_periods WHERE id = p_period_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Period % not found', p_period_id; END IF;
  INSERT INTO financial_close_tasks
    (company_id, tenant_id, period_id, task_key, task_name, owner_role, dependency_task_key, reviewer_role, status)
  VALUES
    (v_company, v_tenant, p_period_id, 'BANK_RECONCILIATION','Bank Reconciliation','cashier',NULL,'finance_manager','PENDING'),
    (v_company, v_tenant, p_period_id, 'AR_RECONCILIATION','AR Reconciliation','ar_officer',NULL,'finance_manager','PENDING'),
    (v_company, v_tenant, p_period_id, 'AP_RECONCILIATION','AP Reconciliation','ap_officer',NULL,'finance_manager','PENDING'),
    (v_company, v_tenant, p_period_id, 'INVENTORY_VALUATION','Inventory Valuation','accountant','BANK_RECONCILIATION','chief_accountant','PENDING'),
    (v_company, v_tenant, p_period_id, 'DEPRECIATION','Depreciation Run','accountant','INVENTORY_VALUATION','chief_accountant','PENDING'),
    (v_company, v_tenant, p_period_id, 'ACCRUALS','Accruals & Deferrals','accountant','DEPRECIATION','chief_accountant','PENDING'),
    (v_company, v_tenant, p_period_id, 'FX_REVALUATION','FX Revaluation','treasury_officer','ACCRUALS','chief_accountant','PENDING'),
    (v_company, v_tenant, p_period_id, 'FINANCIAL_REVIEW','Financial Review','chief_accountant','FX_REVALUATION','cfo','PENDING')
  ON CONFLICT (company_id, period_id, task_key) DO NOTHING;
END; $$ LANGUAGE plpgsql;

-- ---------- 10. Financial audit logs ----------
CREATE TABLE financial_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT,
  user_id BIGINT,
  action TEXT NOT NULL,
  module TEXT NOT NULL,
  doc_type TEXT,
  doc_id BIGINT,
  doc_code TEXT,
  previous_value JSONB,
  new_value JSONB,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_audit_doc ON financial_audit_logs(module, doc_type, doc_id);
CREATE INDEX IF NOT EXISTS idx_fin_audit_created ON financial_audit_logs(created_at DESC);

CREATE OR REPLACE FUNCTION journal_audit_trigger() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO financial_audit_logs
      (tenant_id, company_id, user_id, action, module, doc_type, doc_id, doc_code,
       previous_value, new_value, ip, user_agent)
    VALUES (
      NEW.tenant_id, NEW.company_id, app_user_id(),
      'JOURNAL_' || NEW.status, 'finance', 'JOURNAL_ENTRY', NEW.id, NEW.entry_no,
      CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_object('status', OLD.status) ELSE NULL END,
      jsonb_build_object('status', NEW.status, 'journal_type', NEW.journal_type,
                         'total_debit', NEW.total_debit, 'total_credit', NEW.total_credit),
      current_setting('app.ip', true), current_setting('app.user_agent', true)
    );
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_audit ON journal_entries;
CREATE TRIGGER trg_journal_audit
  AFTER INSERT OR UPDATE OF status ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_audit_trigger();

-- ---------- 11. RLS ----------
ALTER TABLE journal_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE posting_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_jurisdictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE efris_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE efris_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE efris_sync_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE allocation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_cost_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_variances ENABLE ROW LEVEL SECURITY;
ALTER TABLE wip_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE intercompany_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE consolidation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE elimination_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_close_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON journal_templates USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON posting_rules USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON tax_jurisdictions USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON tax_rules USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON tax_transactions USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON efris_transactions USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON efris_documents USING (tenant_id = (SELECT tenant_id FROM efris_transactions WHERE id = efris_transaction_id));
CREATE POLICY tenant_isolation ON efris_sync_logs USING (tenant_id = (SELECT tenant_id FROM efris_transactions WHERE id = efris_transaction_id));
CREATE POLICY tenant_isolation ON budget_revisions USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON budget_commitments USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON allocation_rules USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON production_costs USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON production_cost_components USING (production_cost_id IN (SELECT id FROM production_costs));
CREATE POLICY tenant_isolation ON cost_variances USING (production_cost_id IN (SELECT id FROM production_costs));
CREATE POLICY tenant_isolation ON wip_ledger USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON intercompany_transactions USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON consolidation_runs USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON elimination_entries USING (consolidation_run_id IN (SELECT id FROM consolidation_runs));
CREATE POLICY tenant_isolation ON financial_close_tasks USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON financial_audit_logs USING (tenant_id = app_tenant_id());

-- Seed close tasks for all existing open periods
SELECT seed_close_tasks(id) FROM financial_periods WHERE status = 'OPEN';
