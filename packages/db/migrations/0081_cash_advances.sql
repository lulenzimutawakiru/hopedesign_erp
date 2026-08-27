-- Staff cash advances / imprest issued from a bank or cash account.
-- Posting: Dr 1510 Other Receivables (Staff Advances), Cr source bank/cash GL.
-- Settlements: Dr expense/asset account, Cr 1510. Partial settlements allowed.
CREATE TABLE cash_advances (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  advance_no TEXT NOT NULL,
  advance_date DATE NOT NULL DEFAULT CURRENT_DATE,
  employee_id BIGINT REFERENCES employees(id),
  holder_name TEXT,
  bank_id BIGINT NOT NULL REFERENCES bank_accounts(id),
  currency TEXT NOT NULL DEFAULT 'UGX',
  exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
  base_amount NUMERIC(18,2) NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  purpose TEXT,
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','SETTLED','VOID')),
  gl_posted BOOLEAN NOT NULL DEFAULT false,
  gl_journal_id BIGINT REFERENCES journal_entries(id),
  settled_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  voided_by BIGINT,
  voided_at TIMESTAMPTZ,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, advance_no)
);

ALTER TABLE cash_advances ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cash_advances USING (tenant_id = app_tenant_id());

CREATE INDEX idx_cash_advances_date ON cash_advances (advance_date DESC, id DESC);
CREATE INDEX idx_cash_advances_employee ON cash_advances (employee_id);
CREATE INDEX idx_cash_advances_bank ON cash_advances (bank_id);

CREATE TABLE advance_settlements (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  advance_id BIGINT NOT NULL REFERENCES cash_advances(id),
  settlement_no TEXT NOT NULL,
  settlement_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  account_id BIGINT NOT NULL REFERENCES chart_of_accounts(id),
  method TEXT NOT NULL DEFAULT 'CASH' CHECK (method IN ('CASH','BANK')),
  reference TEXT,
  notes TEXT,
  gl_posted BOOLEAN NOT NULL DEFAULT false,
  gl_journal_id BIGINT REFERENCES journal_entries(id),
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, settlement_no)
);

ALTER TABLE advance_settlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON advance_settlements USING (tenant_id = app_tenant_id());

CREATE INDEX idx_advance_settlements_advance ON advance_settlements (advance_id);
