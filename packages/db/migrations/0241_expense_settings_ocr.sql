-- 0241 - Expense settings (configurable posting accounts + policies) and
--         receipt OCR status tracking.
--
-- Additive and idempotent. migrate.js owns transaction and schema_migrations.
--
-- 1. Two new permissions so the expenditure posting accounts and policies can
--    be managed by the same roles that already hold organisation-wide expense
--    visibility (`expenditure.expenses.view`), without granting any approval,
--    posting or payment capability.
--
-- 2. `expense_receipts` gains an OCR status lifecycle and a confidence score so
--    receipts can be triaged between "extracted", "needs manual entry" and
--    "failed", independently of the `ocr_data` JSON the field already holds.

INSERT INTO permissions (code, module, resource, action, description)
VALUES
  ('expenditure.settings.view',   'expenditure', 'settings', 'view',   'View expenditure policies and posting configuration'),
  ('expenditure.settings.update', 'expenditure', 'settings', 'update', 'Update expenditure policies and posting configuration')
ON CONFLICT (code) DO NOTHING;

-- Roles that can already see all expenses are the natural custodians of the
-- module's posting configuration. Initiation-only roles are deliberately
-- excluded (they only receive create/submit/view_own, never settings).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN role_permissions rp ON rp.role_id = r.id
JOIN permissions base ON base.id = rp.permission_id AND base.code = 'expenditure.expenses.view'
JOIN permissions p ON p.code IN ('expenditure.settings.view', 'expenditure.settings.update')
ON CONFLICT (role_id, permission_id) DO NOTHING;

ALTER TABLE expense_receipts ADD COLUMN IF NOT EXISTS ocr_status TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE expense_receipts ADD COLUMN IF NOT EXISTS ocr_confidence NUMERIC(4,3);

-- Receipts that already carry extraction data are not "pending".
UPDATE expense_receipts
   SET ocr_status = 'EXTRACTED'
 WHERE ocr_data IS NOT NULL AND ocr_data <> '{}'::jsonb;
