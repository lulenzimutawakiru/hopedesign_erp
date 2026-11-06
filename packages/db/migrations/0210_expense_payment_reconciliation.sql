-- 0210 - Bank-statement reconciliation for executed expense payments
-- A reconciliation record is evidence of an external statement match, not a
-- replacement for the immutable general-ledger settlement journal.

CREATE TABLE IF NOT EXISTS expense_payment_reconciliations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  payment_request_id BIGINT NOT NULL REFERENCES payment_requests(id),
  statement_date DATE NOT NULL,
  statement_reference TEXT NOT NULL,
  statement_amount NUMERIC(18,2) NOT NULL CHECK (statement_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'UGX',
  matched_amount NUMERIC(18,2) NOT NULL,
  variance NUMERIC(18,2) NOT NULL,
  variance_explanation TEXT,
  status TEXT NOT NULL DEFAULT 'MATCHED'
    CHECK (status IN ('MATCHED','VARIANCE','APPROVED')),
  reconciled_by BIGINT REFERENCES users(id),
  reconciled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  approval_comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, statement_reference),
  UNIQUE (payment_request_id)
);

CREATE INDEX IF NOT EXISTS idx_exp_pay_recon_company_status
  ON expense_payment_reconciliations(company_id, tenant_id, status, statement_date);

ALTER TABLE expense_payment_reconciliations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON expense_payment_reconciliations;
CREATE POLICY tenant_isolation ON expense_payment_reconciliations
  USING (tenant_id = app_tenant_id());

INSERT INTO permissions (code, module, resource, action, description)
VALUES
  ('expenditure.payments.reconcile', 'expenditure', 'payments', 'reconcile', 'Match executed expense payments to bank or mobile-money statements'),
  ('expenditure.payments.reconcile_approve', 'expenditure', 'payments', 'reconcile_approve', 'Independently approve expense payment reconciliations')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('expenditure.payments.reconcile','expenditure.payments.reconcile_approve')
WHERE r.code IN ('super_administrator','system_administrator','chief_accountant','finance_manager','cfo','managing_director','executive_director')
ON CONFLICT (role_id, permission_id) DO NOTHING;
