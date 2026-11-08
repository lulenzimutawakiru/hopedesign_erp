-- 0235 - Sales price lists (named, customer-assignable price sets)
--
-- Odoo-Sales parity: a reusable price list holds per-product sale prices and can
-- be assigned to a customer. When a quotation/order is raised for that customer
-- the line price defaults to the price-list price (falling back to the product's
-- standard price). The `customers.price_list_id` column has existed since the
-- original schema (0003) but was never bound to a table — this binds it.
--
-- Additive and idempotent. migrate.js owns transaction + schema_migrations.

CREATE TABLE IF NOT EXISTS price_lists (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'UGX',
  valid_from DATE,
  valid_to DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_price_lists_company ON price_lists(company_id, is_active);

CREATE TABLE IF NOT EXISTS price_list_items (
  id BIGSERIAL PRIMARY KEY,
  price_list_id BIGINT NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  unit_price NUMERIC(18,4) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'UGX',
  min_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  effective_from DATE,
  effective_to DATE,
  UNIQUE (price_list_id, product_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_price_list_items_list ON price_list_items(price_list_id);

-- Bind the pre-existing (and previously dangling) column.
ALTER TABLE customers
  ADD CONSTRAINT fk_customers_price_list
  FOREIGN KEY (price_list_id) REFERENCES price_lists(id) ON DELETE SET NULL;

-- RLS
ALTER TABLE price_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_list_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON price_lists USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON price_list_items USING (price_list_id IN (SELECT id FROM price_lists));

-- ============================================================
-- Permissions (catalogue.js is the source of truth for fresh
-- seeds; this keeps the live DB in step without a full re-seed)
-- ============================================================
INSERT INTO permissions (code, module, resource, action, description)
VALUES
  ('sales.price_lists.view',   'sales', 'price_lists', 'view',   'View sales price lists'),
  ('sales.price_lists.create', 'sales', 'price_lists', 'create', 'Create sales price lists'),
  ('sales.price_lists.update', 'sales', 'price_lists', 'update', 'Update sales price lists'),
  ('sales.price_lists.delete', 'sales', 'price_lists', 'delete', 'Delete sales price lists')
ON CONFLICT (code) DO NOTHING;

-- Full surface -> roles holding full sales access (sales.* or sales.orders.*).
-- Proxied by sales.orders.cancel, which is granted only by those wildcards.
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p.id
FROM role_permissions rp
JOIN permissions p ON p.code IN (
  'sales.price_lists.view','sales.price_lists.create',
  'sales.price_lists.update','sales.price_lists.delete'
)
WHERE rp.permission_id = (SELECT id FROM permissions WHERE code = 'sales.orders.cancel')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- View-only surface -> roles that can see quotations but not full sales access.
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p.id
FROM role_permissions rp
JOIN permissions p ON p.code = 'sales.price_lists.view'
WHERE rp.permission_id = (SELECT id FROM permissions WHERE code = 'sales.quotations.view')
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp2
    WHERE rp2.role_id = rp.role_id
      AND rp2.permission_id = (SELECT id FROM permissions WHERE code = 'sales.orders.cancel')
  )
ON CONFLICT (role_id, permission_id) DO NOTHING;
