-- Permissions for debit notes (catalogue already lists sales.debit_notes.*).
INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, 'sales', 'debit_notes', v.action, v.description
FROM (VALUES
  ('sales.debit_notes.view', 'view', 'View customer debit notes'),
  ('sales.debit_notes.create', 'create', 'Create customer debit notes'),
  ('sales.debit_notes.update', 'update', 'Update draft debit notes'),
  ('sales.debit_notes.submit', 'submit', 'Submit debit notes for approval'),
  ('sales.debit_notes.approve', 'approve', 'Approve debit notes'),
  ('sales.debit_notes.post', 'post', 'Post approved debit notes to the ledger'),
  ('sales.debit_notes.void', 'void', 'Void debit notes'),
  ('sales.debit_notes.print', 'print', 'Print debit notes'),
  ('sales.debit_notes.export', 'export', 'Export debit notes')
) AS v(code, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code LIKE 'sales.debit_notes.%'
WHERE r.code IN (
  'super_administrator','system_administrator',
  'ceo','managing_director','executive_director','general_manager',
  'commercial_director','sales_director','cfo','finance_manager','chief_accountant','ar_officer'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;
