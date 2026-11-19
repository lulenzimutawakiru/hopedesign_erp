-- 0251_tax_filing_role_grants.sql
-- Migration 0223 created finance.tax_filings.view and finance.tax_filings.manage
-- and granted them only to tax_officer, accountant, and (view) internal_auditor.
-- Roles whose catalogue grant is finance.* or * pick up a new permission code
-- only when the database is re-seeded. A migrated database therefore lets a
-- finance user open Tax Compliance through finance.tax_transactions.view and
-- then rejects the filings desk with "Missing permission: finance.tax_filings.view".
--
-- View follows every role that can already read tax transactions, including
-- treasury_officer. Manage follows every role that can record a tax
-- transaction. Finance leadership and the executive catch-all roles are named
-- as well, so the grant matches the catalogue when an older seed expanded
-- finance.* before these codes existed. Idempotent.

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'finance.tax_filings.view'
WHERE r.code IN (
    'super_administrator', 'ceo', 'managing_director', 'executive_director', 'general_manager',
    'cfo', 'finance_manager', 'chief_accountant', 'financial_controller',
    'accountant', 'tax_officer', 'internal_auditor', 'treasury_officer'
  )
   OR EXISTS (
     SELECT 1
       FROM role_permissions rp
       JOIN permissions held ON held.id = rp.permission_id
      WHERE rp.role_id = r.id
        AND held.code = 'finance.tax_transactions.view'
   )
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'finance.tax_filings.manage'
WHERE r.code IN (
    'super_administrator', 'ceo', 'managing_director', 'executive_director', 'general_manager',
    'cfo', 'finance_manager', 'chief_accountant', 'financial_controller',
    'accountant', 'tax_officer'
  )
   OR EXISTS (
     SELECT 1
       FROM role_permissions rp
       JOIN permissions held ON held.id = rp.permission_id
      WHERE rp.role_id = r.id
        AND held.code = 'finance.tax_transactions.create'
   )
ON CONFLICT (role_id, permission_id) DO NOTHING;
