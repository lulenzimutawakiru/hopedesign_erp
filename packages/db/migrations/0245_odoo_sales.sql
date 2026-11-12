-- Odoo 19 Sales app fields: quotation addresses, validity context, teams,
-- templates, optional products, and section/note lines.
-- Additive. migrate.js owns the transaction and schema_migrations.
-- Invoicing stays on dispatched quantities. This migration does not add a
-- payment provider, signature portal, or marketplace connector.

CREATE TABLE IF NOT EXISTS sales_teams (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  leader_user_id BIGINT REFERENCES users(id),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS sales_team_members (
  team_id BIGINT NOT NULL REFERENCES sales_teams(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id),
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS quotation_templates (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  validity_days INTEGER,
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quotation_template_lines (
  id BIGSERIAL PRIMARY KEY,
  template_id BIGINT NOT NULL REFERENCES quotation_templates(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL DEFAULT 0,
  line_kind TEXT NOT NULL DEFAULT 'PRODUCT',
  product_id BIGINT REFERENCES products(id),
  description TEXT NOT NULL DEFAULT '',
  quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
  unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
  discount_percent NUMERIC(8,4) NOT NULL DEFAULT 0
);

ALTER TABLE sales_quotations
  ADD COLUMN IF NOT EXISTS invoice_address TEXT,
  ADD COLUMN IF NOT EXISTS delivery_address TEXT,
  ADD COLUMN IF NOT EXISTS price_list_id BIGINT REFERENCES price_lists(id),
  ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER,
  ADD COLUMN IF NOT EXISTS customer_reference TEXT,
  ADD COLUMN IF NOT EXISTS salesperson_id BIGINT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS sales_team_id BIGINT REFERENCES sales_teams(id),
  ADD COLUMN IF NOT EXISTS source_document TEXT,
  ADD COLUMN IF NOT EXISTS tags TEXT,
  ADD COLUMN IF NOT EXISTS shipping_policy TEXT NOT NULL DEFAULT 'ASAP',
  ADD COLUMN IF NOT EXISTS incoterm TEXT,
  ADD COLUMN IF NOT EXISTS incoterm_location TEXT,
  ADD COLUMN IF NOT EXISTS campaign TEXT,
  ADD COLUMN IF NOT EXISTS medium TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS template_id BIGINT REFERENCES quotation_templates(id),
  ADD COLUMN IF NOT EXISTS delivery_date DATE;

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS invoice_address TEXT,
  ADD COLUMN IF NOT EXISTS delivery_address TEXT,
  ADD COLUMN IF NOT EXISTS price_list_id BIGINT REFERENCES price_lists(id),
  ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER,
  ADD COLUMN IF NOT EXISTS salesperson_id BIGINT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS sales_team_id BIGINT REFERENCES sales_teams(id),
  ADD COLUMN IF NOT EXISTS source_document TEXT,
  ADD COLUMN IF NOT EXISTS tags TEXT,
  ADD COLUMN IF NOT EXISTS shipping_policy TEXT NOT NULL DEFAULT 'ASAP',
  ADD COLUMN IF NOT EXISTS incoterm TEXT,
  ADD COLUMN IF NOT EXISTS incoterm_location TEXT,
  ADD COLUMN IF NOT EXISTS campaign TEXT,
  ADD COLUMN IF NOT EXISTS medium TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT;

ALTER TABLE sales_quotation_items
  ADD COLUMN IF NOT EXISTS line_kind TEXT NOT NULL DEFAULT 'PRODUCT',
  ADD COLUMN IF NOT EXISTS sequence INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sales_order_items
  ALTER COLUMN product_id DROP NOT NULL;
ALTER TABLE sales_order_items
  ADD COLUMN IF NOT EXISTS line_kind TEXT NOT NULL DEFAULT 'PRODUCT',
  ADD COLUMN IF NOT EXISTS sequence INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sales_quotation_optionals (
  id BIGSERIAL PRIMARY KEY,
  quotation_id BIGINT NOT NULL REFERENCES sales_quotations(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  description TEXT,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
  unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
  sequence INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sales_order_optionals (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  description TEXT,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
  unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
  sequence INTEGER NOT NULL DEFAULT 0
);

DO $$ BEGIN
  ALTER TABLE sales_quotations
    ADD CONSTRAINT sales_quotations_shipping_policy_check
    CHECK (shipping_policy IN ('ASAP', 'WHEN_ALL'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE sales_orders
    ADD CONSTRAINT sales_orders_shipping_policy_check
    CHECK (shipping_policy IN ('ASAP', 'WHEN_ALL'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE sales_quotation_items
    ADD CONSTRAINT sales_quotation_items_line_kind_check
    CHECK (line_kind IN ('PRODUCT', 'SECTION', 'NOTE'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE sales_order_items
    ADD CONSTRAINT sales_order_items_line_kind_check
    CHECK (line_kind IN ('PRODUCT', 'SECTION', 'NOTE'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE quotation_template_lines
    ADD CONSTRAINT quotation_template_lines_line_kind_check
    CHECK (line_kind IN ('PRODUCT', 'SECTION', 'NOTE'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_sales_quotations_salesperson
  ON sales_quotations (company_id, salesperson_id, status);
CREATE INDEX IF NOT EXISTS idx_sales_orders_salesperson
  ON sales_orders (company_id, salesperson_id, status);

ALTER TABLE sales_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotation_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotation_template_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_quotation_optionals ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_optionals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON sales_teams;
CREATE POLICY tenant_isolation ON sales_teams USING (tenant_id = app_tenant_id());
DROP POLICY IF EXISTS tenant_isolation ON sales_team_members;
CREATE POLICY tenant_isolation ON sales_team_members
  USING (team_id IN (SELECT id FROM sales_teams));
DROP POLICY IF EXISTS tenant_isolation ON quotation_templates;
CREATE POLICY tenant_isolation ON quotation_templates USING (tenant_id = app_tenant_id());
DROP POLICY IF EXISTS tenant_isolation ON quotation_template_lines;
CREATE POLICY tenant_isolation ON quotation_template_lines
  USING (template_id IN (SELECT id FROM quotation_templates));
DROP POLICY IF EXISTS tenant_isolation ON sales_quotation_optionals;
CREATE POLICY tenant_isolation ON sales_quotation_optionals
  USING (quotation_id IN (SELECT id FROM sales_quotations));
DROP POLICY IF EXISTS tenant_isolation ON sales_order_optionals;
CREATE POLICY tenant_isolation ON sales_order_optionals
  USING (order_id IN (SELECT id FROM sales_orders));

INSERT INTO permissions (code, module, resource, action, description)
VALUES
  ('sales.templates.view',   'sales', 'templates', 'view',   'View quotation templates'),
  ('sales.templates.create', 'sales', 'templates', 'create', 'Create quotation templates'),
  ('sales.templates.update', 'sales', 'templates', 'update', 'Update quotation templates'),
  ('sales.templates.delete', 'sales', 'templates', 'delete', 'Delete quotation templates'),
  ('sales.teams.view',       'sales', 'teams', 'view',       'View sales teams'),
  ('sales.teams.create',     'sales', 'teams', 'create',     'Create sales teams'),
  ('sales.teams.update',     'sales', 'teams', 'update',     'Update sales teams'),
  ('sales.teams.delete',     'sales', 'teams', 'delete',     'Delete sales teams'),
  ('sales.settings.view',    'sales', 'settings', 'view',    'View sales settings'),
  ('sales.settings.update',  'sales', 'settings', 'update',  'Update sales settings')
ON CONFLICT (code) DO NOTHING;

-- Full sales access, proxied by sales.orders.cancel (granted only by sales.* / sales.orders.*).
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p.id
FROM role_permissions rp
JOIN permissions p ON p.code IN (
  'sales.templates.view','sales.templates.create','sales.templates.update','sales.templates.delete',
  'sales.teams.view','sales.teams.create','sales.teams.update','sales.teams.delete',
  'sales.settings.view','sales.settings.update'
)
WHERE rp.permission_id = (SELECT id FROM permissions WHERE code = 'sales.orders.cancel')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Quotation readers can open templates, teams, and settings.
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p.id
FROM role_permissions rp
JOIN permissions p ON p.code IN ('sales.templates.view','sales.teams.view','sales.settings.view')
WHERE rp.permission_id = (SELECT id FROM permissions WHERE code = 'sales.quotations.view')
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp2
    WHERE rp2.role_id = rp.role_id
      AND rp2.permission_id = (SELECT id FROM permissions WHERE code = 'sales.orders.cancel')
  )
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- People who can create a quotation can edit a draft. Confirming into an order
-- still requires sales.quotations.convert, which this grant does not add.
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p.id
FROM role_permissions rp
JOIN permissions p ON p.code = 'sales.quotations.update'
WHERE rp.permission_id = (SELECT id FROM permissions WHERE code = 'sales.quotations.create')
ON CONFLICT (role_id, permission_id) DO NOTHING;
