-- 0229 - Universal expense initiation for all ERP user roles
--
-- Every active account with an assigned role may initiate and submit an
-- expense. Read access is deliberately limited to the user's own expenses;
-- elevated existing expenditure.expenses.view remains the finance/management
-- permission for organisation-wide visibility.
--
-- Additive and idempotent. migrate.js owns transaction and schema_migrations.

INSERT INTO permissions (code, module, resource, action, description)
VALUES (
  'expenditure.expenses.view_own',
  'expenditure',
  'expenses',
  'view_own',
  'View expenses created by the signed-in user'
)
ON CONFLICT (code) DO NOTHING;

-- Backfill every existing role. This grants initiation only: it does not grant
-- approval, posting, payment, configuration, or organisation-wide visibility.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p
  ON p.code IN (
    'expenditure.expenses.create',
    'expenditure.expenses.submit',
    'expenditure.expenses.update',
    'expenditure.expenses.view_own'
  )
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Future roles receive the same minimum initiation capability. Elevated
-- financial permissions are never inherited by this trigger.
CREATE OR REPLACE FUNCTION grant_universal_expense_initiation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT NEW.id, p.id
  FROM permissions p
  WHERE p.code IN (
    'expenditure.expenses.create',
    'expenditure.expenses.submit',
    'expenditure.expenses.update',
    'expenditure.expenses.view_own'
  )
  ON CONFLICT (role_id, permission_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_roles_universal_expense_initiation ON roles;
CREATE TRIGGER trg_roles_universal_expense_initiation
AFTER INSERT ON roles
FOR EACH ROW
EXECUTE FUNCTION grant_universal_expense_initiation();
