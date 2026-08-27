-- ============================================================
-- 0010 Finance ? double-entry accounting
-- ============================================================

CREATE TABLE currencies (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  is_base BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE exchange_rates (
  id BIGSERIAL PRIMARY KEY,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  rate_date DATE NOT NULL DEFAULT CURRENT_DATE,
  rate NUMERIC(18,6) NOT NULL,
  UNIQUE (currency_code, rate_date)
);

CREATE TABLE chart_of_accounts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL
    CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE','CONTRA_ASSET','CONTRA_LIABILITY','CONTRA_EQUITY','CONTRA_REVENUE','CONTRA_EXPENSE')),
  subtype TEXT,
  parent_id BIGINT REFERENCES chart_of_accounts(id),
  is_posting BOOLEAN NOT NULL DEFAULT true,
  is_active BOOLEAN NOT NULL DEFAULT true,
  currency TEXT NOT NULL DEFAULT 'UGX',
  opening_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_coa_type ON chart_of_accounts(account_type);

CREATE TABLE financial_periods (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','LOCKED','CLOSED')),
  opened_by BIGINT,
  closed_by BIGINT,
  closed_at TIMESTAMPTZ,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bank_accounts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  bank_name TEXT,
  account_no TEXT,
  account_type TEXT NOT NULL DEFAULT 'CURRENT' CHECK (account_type IN ('CURRENT','SAVINGS','MOBILE_MONEY','CASH')),
  currency TEXT NOT NULL DEFAULT 'UGX',
  opening_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  gl_account_id BIGINT REFERENCES chart_of_accounts(id),
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bank_transactions (
  id BIGSERIAL PRIMARY KEY,
  bank_account_id BIGINT NOT NULL REFERENCES bank_accounts(id),
  txn_date DATE NOT NULL,
  reference TEXT,
  description TEXT,
  debit NUMERIC(18,2) NOT NULL DEFAULT 0,
  credit NUMERIC(18,2) NOT NULL DEFAULT 0,
  balance_after NUMERIC(18,2),
  reconciled BOOLEAN NOT NULL DEFAULT false,
  statement_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE journal_entries (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  entry_no TEXT NOT NULL,
  entry_date DATE NOT NULL,
  period_id BIGINT REFERENCES financial_periods(id),
  journal_type TEXT NOT NULL DEFAULT 'MANUAL'
    CHECK (journal_type IN (
      'MANUAL','OPENING','SALES_INVOICE','CUSTOMER_RECEIPT','CREDIT_NOTE',
      'PURCHASE_INVOICE','SUPPLIER_PAYMENT','GRN_RECEIPT','PRODUCTION',
      'INVENTORY_ADJUSTMENT','EXPENSE','PAYROLL','ASSET','BANK','TAX','TRANSFER')),
  reference_type TEXT,
  reference_id BIGINT,
  reference_code TEXT,
  description TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'UGX',
  exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
  total_debit NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_credit NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED','VOID')),
  posted_by BIGINT,
  posted_at TIMESTAMPTZ,
  voided_by BIGINT,
  voided_at TIMESTAMPTZ,
  reversal_of_id BIGINT REFERENCES journal_entries(id),
  UNIQUE (company_id, entry_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_journal_ref ON journal_entries(reference_type, reference_id);
CREATE INDEX idx_journal_date ON journal_entries(entry_date DESC);

CREATE TABLE journal_lines (
  id BIGSERIAL PRIMARY KEY,
  entry_id BIGINT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL REFERENCES chart_of_accounts(id),
  cost_centre_id BIGINT REFERENCES cost_centres(id),
  profit_centre_id BIGINT REFERENCES profit_centres(id),
  debit NUMERIC(18,2) NOT NULL DEFAULT 0,
  credit NUMERIC(18,2) NOT NULL DEFAULT 0,
  description TEXT,
  reconciled BOOLEAN NOT NULL DEFAULT false,
  bank_transaction_id BIGINT REFERENCES bank_transactions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_journal_lines_entry ON journal_lines(entry_id);
CREATE INDEX idx_journal_lines_account ON journal_lines(account_id);

CREATE TABLE budgets (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  cost_centre_id BIGINT REFERENCES cost_centres(id),
  budget_no TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','ACTIVE','CLOSED')),
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  UNIQUE (company_id, budget_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE budget_lines (
  id BIGSERIAL PRIMARY KEY,
  budget_id BIGINT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL REFERENCES chart_of_accounts(id),
  amount NUMERIC(18,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE expenses (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  expense_no TEXT NOT NULL,
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
  account_id BIGINT NOT NULL REFERENCES chart_of_accounts(id),
  cost_centre_id BIGINT REFERENCES cost_centres(id),
  category TEXT,
  amount NUMERIC(18,2) NOT NULL,
  method TEXT NOT NULL DEFAULT 'CASH',
  reference TEXT,
  vendor TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','POSTED','VOID')),
  gl_posted BOOLEAN NOT NULL DEFAULT false,
  gl_journal_id BIGINT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  created_by BIGINT,
  UNIQUE (company_id, expense_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE taxes (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  tax_type TEXT NOT NULL DEFAULT 'VAT' CHECK (tax_type IN ('VAT','WHT','EXCISE','WITHHOLDING_VAT')),
  rate NUMERIC(8,4) NOT NULL,
  account_id BIGINT REFERENCES chart_of_accounts(id),
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Double-entry posting engine
-- ============================================================
CREATE OR REPLACE FUNCTION post_journal(
  p_company bigint, p_tenant bigint, p_branch bigint,
  p_entry_date date, p_journal_type text, p_description text,
  p_lines jsonb,            -- [{account_id, debit, credit, cost_centre_id, profit_centre_id, description}]
  p_ref_type text, p_ref_id bigint, p_ref_code text,
  p_user bigint,
  p_period_id bigint DEFAULT NULL,
  p_currency text DEFAULT 'UGX',
  p_rate numeric DEFAULT 1
) RETURNS bigint AS $$
DECLARE
  v_entry bigint;
  v_no text;
  v_total_d numeric := 0;
  v_total_c numeric := 0;
  line jsonb;
  v_pid bigint;
BEGIN
  IF jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'A journal entry requires at least two lines';
  END IF;
  FOR line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_total_d := v_total_d + COALESCE((line->>'debit')::numeric, 0);
    v_total_c := v_total_c + COALESCE((line->>'credit')::numeric, 0);
  END LOOP;
  IF round(v_total_d, 2) <> round(v_total_c, 2) THEN
    RAISE EXCEPTION 'Journal does not balance: debit % vs credit %', v_total_d, v_total_c;
  END IF;
  IF v_total_d <= 0 THEN
    RAISE EXCEPTION 'Journal entry amount must be positive';
  END IF;

  IF p_period_id IS NULL THEN
    SELECT id INTO v_pid FROM financial_periods
    WHERE company_id = p_company AND start_date <= p_entry_date AND end_date >= p_entry_date
    ORDER BY start_date LIMIT 1;
  ELSE
    v_pid := p_period_id;
  END IF;

  v_no := next_doc_no(p_tenant, 'GL');
  INSERT INTO journal_entries (
    company_id, tenant_id, branch_id, entry_no, entry_date, period_id,
    journal_type, reference_type, reference_id, reference_code, description,
    currency, exchange_rate, total_debit, total_credit, status, posted_by, posted_at
  ) VALUES (
    p_company, p_tenant, p_branch, v_no, p_entry_date, v_pid,
    p_journal_type, p_ref_type, p_ref_id, p_ref_code, p_description,
    p_currency, p_rate, v_total_d, v_total_c, 'POSTED', p_user, now()
  ) RETURNING id INTO v_entry;

  FOR line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO journal_lines (
      entry_id, account_id, cost_centre_id, profit_centre_id, debit, credit, description
    ) VALUES (
      v_entry,
      (line->>'account_id')::bigint,
      NULLIF(line->>'cost_centre_id','')::bigint,
      NULLIF(line->>'profit_centre_id','')::bigint,
      COALESCE((line->>'debit')::numeric, 0),
      COALESCE((line->>'credit')::numeric, 0),
      COALESCE(line->>'description', p_description)
    );
  END LOOP;

  RETURN v_entry;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE chart_of_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE taxes ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON chart_of_accounts USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON financial_periods USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON bank_accounts USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON bank_transactions USING (bank_account_id IN (SELECT id FROM bank_accounts));
CREATE POLICY tenant_isolation ON journal_entries USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON journal_lines USING (entry_id IN (SELECT id FROM journal_entries));
CREATE POLICY tenant_isolation ON budgets USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON budget_lines USING (budget_id IN (SELECT id FROM budgets));
CREATE POLICY tenant_isolation ON expenses USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON taxes USING (tenant_id = app_tenant_id());
