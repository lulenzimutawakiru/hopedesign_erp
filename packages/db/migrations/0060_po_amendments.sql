-- PO amendments: formal, audited, re-approvable changes to commercial purchase
-- orders. Approved orders are frozen; amendments are the controlled path for
-- quantity/price deltas and additional lines. Each amendment is re-approved
-- through the standard workflow engine (entity: procurement.po_amendments)
-- and applied as a single audited transaction.

CREATE TABLE po_amendments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  order_id BIGINT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  amendment_no TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','CANCELLED')),
  subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL DEFAULT 0,
  workflow_instance_id BIGINT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  decided_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, amendment_no)
);
CREATE INDEX idx_po_amendments_order ON po_amendments(order_id, status);
CREATE INDEX idx_po_amendments_tenant_status ON po_amendments(tenant_id, status);

CREATE TABLE po_amendment_items (
  id BIGSERIAL PRIMARY KEY,
  amendment_id BIGINT NOT NULL REFERENCES po_amendments(id) ON DELETE CASCADE,
  po_item_id BIGINT REFERENCES purchase_order_items(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  change_type TEXT NOT NULL CHECK (change_type IN ('QTY','PRICE','QTY_PRICE','NEW_LINE')),
  prev_qty NUMERIC(18,4),
  prev_unit_price NUMERIC(18,4),
  new_qty NUMERIC(18,4),
  new_unit_price NUMERIC(18,4),
  new_line_qty NUMERIC(18,4),
  new_line_unit_price NUMERIC(18,4),
  tax_percent NUMERIC(8,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_po_amendment_items_amendment ON po_amendment_items(amendment_id);

-- Default amendment approval workflow: mirrors the PO bands so a delta under
-- UGX 20M needs the Procurement Manager and a larger delta also needs the
-- Operations Director. Configurable per company by administrators.
INSERT INTO workflows (company_id, tenant_id, code, name, entity_type, description, config, is_active)
SELECT c.id, c.tenant_id, 'WF-POAM', 'Purchase Order Amendment Approval', 'procurement.po_amendments',
       'PO amendments under UGX 20M are approved by the Procurement Manager; above UGX 20M they also require the Operations Director.',
       '[{"seq":1,"name":"Procurement Manager Approval","approver_role":"procurement_manager","amount_min":0,"amount_max":20000000,"sla_hours":24},{"seq":2,"name":"Operations Director Approval","approver_role":"operations_director","amount_min":20000000,"amount_max":0,"sla_hours":48}]'::jsonb,
       true
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM workflows w WHERE w.company_id = c.id AND w.code = 'WF-POAM');
