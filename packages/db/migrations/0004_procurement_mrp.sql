-- ============================================================
-- 0004 Procurement + Demand Planning + MRP
-- ============================================================

CREATE TABLE suppliers (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  supplier_type TEXT NOT NULL DEFAULT 'RAW_MATERIAL'
    CHECK (supplier_type IN ('RAW_MATERIAL','PACKAGING','SERVICE','CONSUMABLE','SECURITY_MATERIAL','MACHINERY','OTHER')),
  tin TEXT,
  vrn TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  address TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 30,
  currency TEXT NOT NULL DEFAULT 'UGX',
  default_lead_time_days INTEGER NOT NULL DEFAULT 7,
  rating NUMERIC(3,1),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','BLOCKED','PENDING','APPROVED','REJECTED')),
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  security_cleared BOOLEAN NOT NULL DEFAULT false,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_suppliers_name ON suppliers(company_id, name);

CREATE TABLE supplier_contacts (
  id BIGSERIAL PRIMARY KEY,
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  title TEXT,
  email TEXT,
  phone TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE supplier_evaluations (
  id BIGSERIAL PRIMARY KEY,
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
  evaluated_by BIGINT NOT NULL REFERENCES users(id),
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  quality_score NUMERIC(5,2),
  delivery_score NUMERIC(5,2),
  price_score NUMERIC(5,2),
  compliance_score NUMERIC(5,2),
  overall_score NUMERIC(5,2),
  comments TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE supplier_contracts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
  contract_no TEXT NOT NULL,
  title TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE,
  value NUMERIC(18,2) NOT NULL DEFAULT 0,
  terms TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','ACTIVE','EXPIRED','TERMINATED')),
  UNIQUE (company_id, contract_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE supplier_price_lists (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  unit_price NUMERIC(18,4) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'UGX',
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  lead_time_days INTEGER,
  minimum_order_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  notes TEXT,
  UNIQUE (supplier_id, product_id, effective_from),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Purchase requisitions ----------
CREATE TABLE purchase_requisitions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  pr_no TEXT NOT NULL,
  requested_by BIGINT NOT NULL REFERENCES users(id),
  requested_date DATE NOT NULL DEFAULT CURRENT_DATE,
  required_date DATE,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','CONVERTED','CANCELLED','PARTIALLY_ORDERED')),
  budget_code TEXT,
  budget_validated BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  UNIQUE (company_id, pr_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_requisition_items (
  id BIGSERIAL PRIMARY KEY,
  requisition_id BIGINT NOT NULL REFERENCES purchase_requisitions(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity NUMERIC(18,4) NOT NULL,
  unit_id BIGINT REFERENCES units(id),
  suggested_supplier_id BIGINT REFERENCES suppliers(id),
  estimated_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  need_by DATE,
  ordered_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- RFQ ----------
CREATE TABLE rfqs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  rfq_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','ISSUED','RECEIVING_QUOTES','EVALUATING','AWARDED','CANCELLED')),
  issue_date DATE,
  closing_date DATE,
  notes TEXT,
  UNIQUE (company_id, rfq_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rfq_items (
  id BIGSERIAL PRIMARY KEY,
  rfq_id BIGINT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity NUMERIC(18,4) NOT NULL,
  unit_id BIGINT REFERENCES units(id),
  target_price NUMERIC(18,4),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rfq_suppliers (
  id BIGSERIAL PRIMARY KEY,
  rfq_id BIGINT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
  invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, supplier_id)
);

CREATE TABLE supplier_quotations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  rfq_id BIGINT REFERENCES rfqs(id),
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
  quote_no TEXT NOT NULL,
  quote_date DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until DATE,
  currency TEXT NOT NULL DEFAULT 'UGX',
  status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED','EVALUATED','SELECTED','REJECTED','EXPIRED')),
  total NUMERIC(18,2) NOT NULL DEFAULT 0,
  notes TEXT,
  UNIQUE (company_id, quote_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE supplier_quotation_items (
  id BIGSERIAL PRIMARY KEY,
  quotation_id BIGINT NOT NULL REFERENCES supplier_quotations(id) ON DELETE CASCADE,
  rfq_item_id BIGINT REFERENCES rfq_items(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity NUMERIC(18,4) NOT NULL,
  unit_price NUMERIC(18,4) NOT NULL,
  lead_time_days INTEGER,
  line_total NUMERIC(18,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Purchase orders ----------
CREATE TABLE purchase_orders (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  po_no TEXT NOT NULL,
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
  supplier_quotation_id BIGINT REFERENCES supplier_quotations(id),
  requisition_id BIGINT REFERENCES purchase_requisitions(id),
  order_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_date DATE,
  currency TEXT NOT NULL DEFAULT 'UGX',
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','PARTIALLY_RECEIVED','RECEIVED','CLOSED','REJECTED','CANCELLED')),
  subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL DEFAULT 0,
  budget_code TEXT,
  budget_validated BOOLEAN NOT NULL DEFAULT false,
  three_way_matched BOOLEAN NOT NULL DEFAULT false,
  security_classification TEXT NOT NULL DEFAULT 'NONE'
    CHECK (security_classification IN ('NONE','RESTRICTED','CONFIDENTIAL','SECRET')),
  notes TEXT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  created_by BIGINT,
  UNIQUE (company_id, po_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_po_supplier ON purchase_orders(supplier_id, status);

CREATE TABLE purchase_order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity NUMERIC(18,4) NOT NULL,
  received_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  invoiced_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
  tax_percent NUMERIC(8,4) NOT NULL DEFAULT 0,
  line_total NUMERIC(18,4) NOT NULL DEFAULT 0,
  expected_date DATE,
  need_by DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Goods receipts (GRN) ----------
CREATE TABLE goods_receipts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  grn_no TEXT NOT NULL,
  po_id BIGINT NOT NULL REFERENCES purchase_orders(id),
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_by BIGINT NOT NULL REFERENCES users(id),
  delivery_ref TEXT,
  status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED','INSPECTING','QUARANTINED','APPROVED','REJECTED','PARTIALLY_APPROVED')),
  notes TEXT,
  UNIQUE (company_id, grn_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE goods_receipt_items (
  id BIGSERIAL PRIMARY KEY,
  grn_id BIGINT NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  po_item_id BIGINT REFERENCES purchase_order_items(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity_received NUMERIC(18,4) NOT NULL,
  quantity_accepted NUMERIC(18,4),
  quantity_rejected NUMERIC(18,4) NOT NULL DEFAULT 0,
  unit_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  batch_id BIGINT REFERENCES product_batches(id),
  batch_no TEXT,
  expiry_date DATE,
  qc_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (qc_status IN ('PENDING','INSPECTING','PASSED','FAILED','QUARANTINED')),
  qc_inspection_id BIGINT,
  warehouse_id BIGINT REFERENCES warehouses(id),
  bin_id BIGINT REFERENCES warehouse_bins(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Supplier invoices + returns ----------
CREATE TABLE supplier_invoices (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  supplier_invoice_no TEXT NOT NULL,
  po_id BIGINT REFERENCES purchase_orders(id),
  grn_id BIGINT REFERENCES goods_receipts(id),
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
  invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE,
  currency TEXT NOT NULL DEFAULT 'UGX',
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','MATCHED','PARTIALLY_PAID','PAID','VOID')),
  subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(18,2) NOT NULL DEFAULT 0,
  three_way_matched BOOLEAN NOT NULL DEFAULT false,
  gl_posted BOOLEAN NOT NULL DEFAULT false,
  gl_journal_id BIGINT,
  notes TEXT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  UNIQUE (company_id, supplier_invoice_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE supplier_invoice_items (
  id BIGSERIAL PRIMARY KEY,
  invoice_id BIGINT NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  po_item_id BIGINT REFERENCES purchase_order_items(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity NUMERIC(18,4) NOT NULL,
  unit_price NUMERIC(18,4) NOT NULL,
  tax_percent NUMERIC(8,4) NOT NULL DEFAULT 0,
  line_total NUMERIC(18,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE supplier_payments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  payment_no TEXT NOT NULL,
  supplier_invoice_id BIGINT REFERENCES supplier_invoices(id),
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC(18,2) NOT NULL,
  method TEXT NOT NULL DEFAULT 'BANK_TRANSFER'
    CHECK (method IN ('CASH','BANK_TRANSFER','CHEQUE','MOBILE_MONEY','CARD','OTHER')),
  reference TEXT,
  bank_account_id BIGINT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','SUBMITTED','APPROVED','RELEASED','VOID')),
  gl_posted BOOLEAN NOT NULL DEFAULT false,
  gl_journal_id BIGINT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  released_by BIGINT,
  released_at TIMESTAMPTZ,
  UNIQUE (company_id, payment_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_returns (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  return_no TEXT NOT NULL,
  grn_id BIGINT REFERENCES goods_receipts(id),
  po_id BIGINT REFERENCES purchase_orders(id),
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
  return_date DATE NOT NULL DEFAULT CURRENT_DATE,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','APPROVED','SHIPPED','CREDITED','CLOSED')),
  UNIQUE (company_id, return_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_return_items (
  id BIGSERIAL PRIMARY KEY,
  return_id BIGINT NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity NUMERIC(18,4) NOT NULL,
  batch_id BIGINT REFERENCES product_batches(id),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Demand planning + MRP ----------
CREATE TABLE demand_forecasts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  forecast_no TEXT NOT NULL,
  product_id BIGINT NOT NULL REFERENCES products(id),
  customer_id BIGINT REFERENCES customers(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  quantity NUMERIC(18,4) NOT NULL,
  confidence NUMERIC(5,2),
  scenario TEXT NOT NULL DEFAULT 'BASE' CHECK (scenario IN ('BASE','OPTIMISTIC','PESSIMISTIC','ACTUAL')),
  source TEXT NOT NULL DEFAULT 'MANUAL'
    CHECK (source IN ('MANUAL','SALES_FORECAST','HISTORICAL','MRP','CUSTOMER')),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','USED','ARCHIVED')),
  notes TEXT,
  UNIQUE (company_id, forecast_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mrp_runs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  run_no TEXT NOT NULL,
  run_type TEXT NOT NULL DEFAULT 'MANUAL' CHECK (run_type IN ('MANUAL','SCHEDULED','DEMAND_TRIGGERED')),
  horizon_start DATE,
  horizon_end DATE,
  status TEXT NOT NULL DEFAULT 'RUNNING'
    CHECK (status IN ('RUNNING','COMPLETED','FAILED','PURCHASE_ORDERS_CREATED','WORK_ORDERS_CREATED')),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  run_by BIGINT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (company_id, run_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mrp_requirements (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES mrp_runs(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  requirement_type TEXT NOT NULL CHECK (requirement_type IN ('GROSS','AVAILABLE','RESERVED','SCHEDULED_RECEIPT','SAFETY_STOCK','NET','SUGGESTION')),
  quantity NUMERIC(18,4) NOT NULL,
  period_date DATE,
  suggestion_type TEXT CHECK (suggestion_type IN ('PURCHASE','PRODUCTION','NONE')),
  suggested_quantity NUMERIC(18,4),
  suggested_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_price_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_requisitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_requisition_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfqs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfq_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfq_suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_quotation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_return_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE demand_forecasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrp_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrp_requirements ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON suppliers USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON supplier_contacts USING (supplier_id IN (SELECT id FROM suppliers));
CREATE POLICY tenant_isolation ON supplier_evaluations USING (supplier_id IN (SELECT id FROM suppliers));
CREATE POLICY tenant_isolation ON supplier_contracts USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON supplier_price_lists USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON purchase_requisitions USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON purchase_requisition_items USING (requisition_id IN (SELECT id FROM purchase_requisitions));
CREATE POLICY tenant_isolation ON rfqs USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON rfq_items USING (rfq_id IN (SELECT id FROM rfqs));
CREATE POLICY tenant_isolation ON rfq_suppliers USING (rfq_id IN (SELECT id FROM rfqs));
CREATE POLICY tenant_isolation ON supplier_quotations USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON supplier_quotation_items USING (quotation_id IN (SELECT id FROM supplier_quotations));
CREATE POLICY tenant_isolation ON purchase_orders USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON purchase_order_items USING (order_id IN (SELECT id FROM purchase_orders));
CREATE POLICY tenant_isolation ON goods_receipts USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON goods_receipt_items USING (grn_id IN (SELECT id FROM goods_receipts));
CREATE POLICY tenant_isolation ON supplier_invoices USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON supplier_invoice_items USING (invoice_id IN (SELECT id FROM supplier_invoices));
CREATE POLICY tenant_isolation ON supplier_payments USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON purchase_returns USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON purchase_return_items USING (return_id IN (SELECT id FROM purchase_returns));
CREATE POLICY tenant_isolation ON demand_forecasts USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON mrp_runs USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON mrp_requirements USING (run_id IN (SELECT id FROM mrp_runs));
