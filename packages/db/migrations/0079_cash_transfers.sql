-- Internal cash / bank transfers between bank accounts (e.g. KCB USD -> Petty Cash).
-- The GL movement is a single TRANSFER journal: debit target GL, credit source GL.
CREATE TABLE cash_transfers (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  transfer_no TEXT NOT NULL,
  transfer_date DATE NOT NULL,
  from_bank_id BIGINT NOT NULL REFERENCES bank_accounts(id),
  to_bank_id BIGINT NOT NULL REFERENCES bank_accounts(id),
  amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (amount > 0),
  reference TEXT,
  notes TEXT,
  journal_id BIGINT REFERENCES journal_entries(id),
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, transfer_no)
);

ALTER TABLE cash_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cash_transfers USING (tenant_id = app_tenant_id());

CREATE INDEX idx_cash_transfers_date ON cash_transfers (transfer_date DESC, id DESC);
CREATE INDEX idx_cash_transfers_from ON cash_transfers (from_bank_id);
CREATE INDEX idx_cash_transfers_to ON cash_transfers (to_bank_id);
