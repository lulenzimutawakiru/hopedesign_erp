-- 0236 - Reordering rules (Odoo Inventory parity)
--
-- The `replenishment_rules` table has existed since 0098 (MIN_MAX / ROP / EOQ /
-- FORECAST_DRIVEN) but was never exposed: nothing wrote to it and no screen
-- managed it. This migration (a) adds the two Odoo reordering-rule fields the
-- table lacked — order multiple and a preferred supplier — and (b) provisions
-- the `inventory.reorder_rules.*` permissions that the new screen and routes use.
--
-- Additive and idempotent. migrate.js owns transaction + schema_migrations.

ALTER TABLE replenishment_rules
  ADD COLUMN IF NOT EXISTS multiple_qty NUMERIC(18,4) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS preferred_supplier_id BIGINT REFERENCES suppliers(id);

-- ============================================================
-- Permissions (catalogue.js is the source of truth for fresh
-- seeds; this keeps the live DB in step without a full re-seed)
-- ============================================================
INSERT INTO permissions (code, module, resource, action, description)
VALUES
  ('inventory.reorder_rules.view',   'inventory', 'reorder_rules', 'view',   'View inventory reordering rules'),
  ('inventory.reorder_rules.create', 'inventory', 'reorder_rules', 'create', 'Create inventory reordering rules'),
  ('inventory.reorder_rules.update', 'inventory', 'reorder_rules', 'update', 'Update inventory reordering rules'),
  ('inventory.reorder_rules.delete', 'inventory', 'reorder_rules', 'delete', 'Delete inventory reordering rules')
ON CONFLICT (code) DO NOTHING;

-- Full surface -> inventory master-data managers. Proxied by inventory.items.update,
-- which is granted only by inventory.* (warehouse_manager) and inventory.items.*
-- (inventory_controller) — the roles that own stock master data.
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p.id
FROM role_permissions rp
JOIN permissions p ON p.code IN (
  'inventory.reorder_rules.view','inventory.reorder_rules.create',
  'inventory.reorder_rules.update','inventory.reorder_rules.delete'
)
WHERE rp.permission_id = (SELECT id FROM permissions WHERE code = 'inventory.items.update')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- View-only surface -> roles that see reorder recommendations but cannot edit
-- master data (catch any read-only inventory role the wildcard missed).
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p.id
FROM role_permissions rp
JOIN permissions p ON p.code = 'inventory.reorder_rules.view'
WHERE rp.permission_id = (SELECT id FROM permissions WHERE code = 'inventory.reorder_recommendations.view')
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp2
    WHERE rp2.role_id = rp.role_id
      AND rp2.permission_id = (SELECT id FROM permissions WHERE code = 'inventory.items.update')
  )
ON CONFLICT (role_id, permission_id) DO NOTHING;
