-- 0209 - Expense payment authorisation, execution and partial settlement controls
-- Additive: preserves existing payment_requests records and status vocabulary.
-- Existing direct-paid legacy rows remain historical; new requests use SUBMITTED -> APPROVED -> PAID.

ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS execution_reference TEXT,
  ADD COLUMN IF NOT EXISTS payment_date DATE,
  ADD COLUMN IF NOT EXISTS approval_comment TEXT;

CREATE INDEX IF NOT EXISTS idx_payment_requests_expense_outstanding
  ON payment_requests(company_id, tenant_id, ref_id, status)
  WHERE ref_type = 'EXPENSE';

-- Keep payment authority separate from expense approval and GL posting.
INSERT INTO permissions (code, module, resource, action, description)
VALUES
  ('expenditure.payments.approve', 'expenditure', 'payments', 'approve', 'Approve submitted expense payment requests'),
  ('expenditure.payments.post', 'expenditure', 'payments', 'post', 'Execute approved payments and post settlement journals')
ON CONFLICT (code) DO NOTHING;

-- Finance and executive control roles receive approval/execution permissions.
-- Ordinary roles retain request initiation only; the existing payment post
-- permission remains assigned to finance roles by migration 0099.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'expenditure.payments.approve'
WHERE r.code IN ('super_administrator','cfo','finance_manager','chief_accountant','managing_director','executive_director')
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMENT ON COLUMN payment_requests.approval_comment IS
  'Required rationale/reference recorded by the independent payment approver.';
COMMENT ON COLUMN payment_requests.execution_reference IS
  'Bank, mobile-money, cheque or cash transaction reference supplied at execution.';
