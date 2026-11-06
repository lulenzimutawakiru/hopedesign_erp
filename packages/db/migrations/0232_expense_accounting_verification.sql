-- 0232 - Independent accounting verification before expense posting
ALTER TABLE expense_transactions
  ADD COLUMN IF NOT EXISTS accounting_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verified_by BIGINT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_comment TEXT;

INSERT INTO permissions (code, module, resource, action, description)
VALUES ('expenditure.expenses.verify', 'expenditure', 'expenses', 'verify', 'Verify expense coding, tax, evidence and totals before GL posting')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'expenditure.expenses.verify'
WHERE r.code IN ('super_administrator','system_administrator','chief_accountant','finance_manager','cfo')
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMENT ON COLUMN expense_transactions.accounting_verified IS
  'Independent accounting review completed before the expense can be posted to the general ledger.';
