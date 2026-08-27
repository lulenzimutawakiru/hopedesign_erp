-- ============================================================
-- 0003 CRM + Sales
-- ============================================================

CREATE TABLE customers (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  customer_type TEXT NOT NULL DEFAULT 'COMPANY' CHECK (customer_type IN ('INDIVIDUAL','COMPANY','GOVERNMENT','NGO')),
  tin TEXT,
  vrn TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  address TEXT,
  billing_address TEXT,
  shipping_address TEXT,
  credit_limit NUMERIC(18,2) NOT NULL DEFAULT 0,
  payment_terms_days INTEGER NOT NULL DEFAULT 30,
  currency TEXT NOT NULL DEFAULT 'UGX',
  price_list_id BIGINT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','BLOCKED','PROSPECT')),
  owner_user_id BIGINT,
  security_classification TEXT NOT NULL DEFAULT 'NONE'
    CHECK (security_classification IN ('NONE','RESTRICTED','CONFIDENTIAL','SECRET')),
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_customers_name ON customers(company_id, name);

CREATE TABLE contacts (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  title TEXT,
  email TEXT,
  phone TEXT,
  mobile TEXT,
  department TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE leads (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  lead_no TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  company_name TEXT,
  email TEXT,
  phone TEXT,
  source TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (source IN ('WEBSITE','REFERRAL','COLD_CALL','TRADE_SHOW','SOCIAL','WALK_IN','EXISTING','OTHER')),
  status TEXT NOT NULL DEFAULT 'NEW'
    CHECK (status IN ('NEW','CONTACTED','QUALIFIED','DISQUALIFIED','CONVERTED','LOST')),
  stage TEXT NOT NULL DEFAULT 'NEW',
  value NUMERIC(18,2) NOT NULL DEFAULT 0,
  owner_user_id BIGINT,
  assigned_to BIGINT,
  converted_customer_id BIGINT,
  converted_at TIMESTAMPTZ,
  notes TEXT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (company_id, lead_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_leads_status ON leads(status);

CREATE TABLE opportunities (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  customer_id BIGINT REFERENCES customers(id),
  lead_id BIGINT REFERENCES leads(id),
  name TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'PROSPECTING'
    CHECK (stage IN ('PROSPECTING','QUALIFICATION','NEEDS_ANALYSIS','VALUE_PROPOSITION','NEGOTIATION','WON','LOST')),
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  probability INTEGER NOT NULL DEFAULT 10,
  expected_close DATE,
  owner_user_id BIGINT,
  currency TEXT NOT NULL DEFAULT 'UGX',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','WON','LOST','ON_HOLD')),
  notes TEXT,
  UNIQUE (company_id, name, customer_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE activities (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  entity_type TEXT NOT NULL,
  entity_id BIGINT NOT NULL,
  activity_type TEXT NOT NULL
    CHECK (activity_type IN ('CALL','MEETING','TASK','EMAIL','FOLLOW_UP','NOTE','SMS')),
  subject TEXT NOT NULL,
  notes TEXT,
  due_at TIMESTAMPTZ,
  done BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ,
  assigned_to BIGINT,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_activities_entity ON activities(entity_type, entity_id);

CREATE TABLE complaints (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  complaint_no TEXT NOT NULL,
  subject TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED','CLOSED','ESCALATED')),
  resolution TEXT,
  assigned_to BIGINT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  UNIQUE (company_id, complaint_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Sales ----------
CREATE TABLE sales_quotations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  quotation_no TEXT NOT NULL,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  contact_id BIGINT REFERENCES contacts(id),
  opportunity_id BIGINT REFERENCES opportunities(id),
  revision INTEGER NOT NULL DEFAULT 1,
  quotation_date DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until DATE,
  currency TEXT NOT NULL DEFAULT 'UGX',
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','CONVERTED','EXPIRED','REVISED','CANCELLED')),
  subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL DEFAULT 0,
  notes TEXT,
  terms TEXT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  created_by BIGINT,
  UNIQUE (company_id, quotation_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sales_quotation_items (
  id BIGSERIAL PRIMARY KEY,
  quotation_id BIGINT NOT NULL REFERENCES sales_quotations(id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES products(id),
  description TEXT NOT NULL,
  quantity NUMERIC(18,4) NOT NULL,
  unit_id BIGINT REFERENCES units(id),
  unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
  discount_percent NUMERIC(8,4) NOT NULL DEFAULT 0,
  tax_percent NUMERIC(8,4) NOT NULL DEFAULT 0,
  line_total NUMERIC(18,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sales_orders (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  order_no TEXT NOT NULL,
  quotation_id BIGINT REFERENCES sales_quotations(id),
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  contact_id BIGINT REFERENCES contacts(id),
  customer_po_no TEXT,
  order_date DATE NOT NULL DEFAULT CURRENT_DATE,
  requested_date DATE,
  delivery_date DATE,
  currency TEXT NOT NULL DEFAULT 'UGX',
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','ALLOCATED','PARTIALLY_DISPATCHED','DISPATCHED','INVOICED','COMPLETED','CANCELLED')),
  subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL DEFAULT 0,
  allocated BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  created_by BIGINT,
  UNIQUE (company_id, order_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_so_customer ON sales_orders(customer_id, status);

CREATE TABLE sales_order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  description TEXT NOT NULL,
  quantity NUMERIC(18,4) NOT NULL,
  unit_id BIGINT REFERENCES units(id),
  unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
  discount_percent NUMERIC(8,4) NOT NULL DEFAULT 0,
  tax_percent NUMERIC(8,4) NOT NULL DEFAULT 0,
  line_total NUMERIC(18,4) NOT NULL DEFAULT 0,
  allocated_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  dispatched_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  invoiced_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  delivery_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE delivery_notes (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  delivery_no TEXT NOT NULL,
  order_id BIGINT NOT NULL REFERENCES sales_orders(id),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','READY','DISPATCHED','IN_TRANSIT','DELIVERED','PARTIAL','FAILED','CANCELLED')),
  dispatch_date DATE,
  vehicle_id BIGINT,
  driver_id BIGINT,
  recipient_name TEXT,
  recipient_phone TEXT,
  delivered_at TIMESTAMPTZ,
  received_by TEXT,
  signature TEXT,
  notes TEXT,
  created_by BIGINT,
  UNIQUE (company_id, delivery_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE delivery_note_items (
  id BIGSERIAL PRIMARY KEY,
  delivery_note_id BIGINT NOT NULL REFERENCES delivery_notes(id) ON DELETE CASCADE,
  order_item_id BIGINT REFERENCES sales_order_items(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity NUMERIC(18,4) NOT NULL,
  batch_id BIGINT REFERENCES product_batches(id),
  qr_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customer_invoices (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  invoice_no TEXT NOT NULL,
  order_id BIGINT REFERENCES sales_orders(id),
  delivery_note_id BIGINT REFERENCES delivery_notes(id),
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE,
  currency TEXT NOT NULL DEFAULT 'UGX',
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','POSTED','PARTIALLY_PAID','PAID','VOID','OVERDUE')),
  subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(18,2) NOT NULL DEFAULT 0,
  gl_posted BOOLEAN NOT NULL DEFAULT false,
  gl_journal_id BIGINT,
  notes TEXT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  created_by BIGINT,
  UNIQUE (company_id, invoice_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_invoices_customer ON customer_invoices(customer_id, status);

CREATE TABLE invoice_items (
  id BIGSERIAL PRIMARY KEY,
  invoice_id BIGINT NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES products(id),
  description TEXT NOT NULL,
  quantity NUMERIC(18,4) NOT NULL,
  unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
  tax_percent NUMERIC(8,4) NOT NULL DEFAULT 0,
  line_total NUMERIC(18,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE receipts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  receipt_no TEXT NOT NULL,
  invoice_id BIGINT REFERENCES customer_invoices(id),
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  receipt_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC(18,2) NOT NULL,
  method TEXT NOT NULL DEFAULT 'CASH' CHECK (method IN ('CASH','BANK_TRANSFER','MOBILE_MONEY','CHEQUE','CARD','OTHER')),
  reference TEXT,
  bank_account_id BIGINT,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('DRAFT','POSTED','VOID')),
  gl_posted BOOLEAN NOT NULL DEFAULT false,
  gl_journal_id BIGINT,
  received_by BIGINT,
  UNIQUE (company_id, receipt_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE credit_notes (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  credit_no TEXT NOT NULL,
  invoice_id BIGINT REFERENCES customer_invoices(id),
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  credit_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC(18,2) NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','POSTED','VOID')),
  gl_posted BOOLEAN NOT NULL DEFAULT false,
  gl_journal_id BIGINT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  UNIQUE (company_id, credit_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sales_returns (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  return_no TEXT NOT NULL,
  order_id BIGINT REFERENCES sales_orders(id),
  delivery_note_id BIGINT REFERENCES delivery_notes(id),
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  return_date DATE NOT NULL DEFAULT CURRENT_DATE,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','INSPECTING','APPROVED','REJECTED','COMPLETED')),
  refund_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  qc_result TEXT,
  UNIQUE (company_id, return_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sales_return_items (
  id BIGSERIAL PRIMARY KEY,
  return_id BIGINT NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity NUMERIC(18,4) NOT NULL,
  batch_id BIGINT REFERENCES product_batches(id),
  qr_id BIGINT,
  condition TEXT NOT NULL DEFAULT 'RESALEABLE' CHECK (condition IN ('RESALEABLE','DAMAGED','SCRAP')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_quotation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_note_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_return_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON customers USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON contacts USING (customer_id IN (SELECT id FROM customers));
CREATE POLICY tenant_isolation ON leads USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON opportunities USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON activities USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON complaints USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON sales_quotations USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON sales_quotation_items USING (quotation_id IN (SELECT id FROM sales_quotations));
CREATE POLICY tenant_isolation ON sales_orders USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON sales_order_items USING (order_id IN (SELECT id FROM sales_orders));
CREATE POLICY tenant_isolation ON delivery_notes USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON delivery_note_items USING (delivery_note_id IN (SELECT id FROM delivery_notes));
CREATE POLICY tenant_isolation ON customer_invoices USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON invoice_items USING (invoice_id IN (SELECT id FROM customer_invoices));
CREATE POLICY tenant_isolation ON receipts USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON credit_notes USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON sales_returns USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON sales_return_items USING (return_id IN (SELECT id FROM sales_returns));
