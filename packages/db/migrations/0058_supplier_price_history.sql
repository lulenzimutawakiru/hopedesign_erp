-- Supplier price history: every PO line and supplier quotation line records the
-- agreed unit price so procurement can see price trends per supplier + product,
-- flag unusual increases, and give PO lines last-price context.

CREATE TABLE supplier_price_history (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  unit_price NUMERIC(18,4) NOT NULL CHECK (unit_price >= 0),
  currency TEXT NOT NULL DEFAULT 'UGX',
  effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  source TEXT NOT NULL DEFAULT 'PO' CHECK (source IN ('PO','QUOTATION')),
  source_id BIGINT NOT NULL,
  source_no TEXT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, source_id, product_id)
);
CREATE INDEX idx_sph_supplier_product ON supplier_price_history (supplier_id, product_id, effective_date DESC);
CREATE INDEX idx_sph_product_date ON supplier_price_history (product_id, effective_date DESC);
CREATE INDEX idx_sph_supplier_date ON supplier_price_history (supplier_id, effective_date DESC);

-- Backfill from purchase orders.
INSERT INTO supplier_price_history
  (tenant_id, company_id, supplier_id, product_id, unit_price, currency, effective_date, source, source_id, source_no, created_by)
SELECT po.tenant_id, po.company_id, po.supplier_id, i.product_id, i.unit_price, po.currency, po.order_date, 'PO', po.id, po.po_no, po.created_by
FROM purchase_orders po
JOIN purchase_order_items i ON i.order_id = po.id
ON CONFLICT (source, source_id, product_id) DO NOTHING;

-- Backfill from supplier quotations.
INSERT INTO supplier_price_history
  (tenant_id, company_id, supplier_id, product_id, unit_price, currency, effective_date, source, source_id, source_no, created_by)
SELECT sq.tenant_id, sq.company_id, sq.supplier_id, i.product_id, i.unit_price, sq.currency, sq.quote_date, 'QUOTATION', sq.id, sq.quote_no, NULL
FROM supplier_quotations sq
JOIN supplier_quotation_items i ON i.quotation_id = sq.id
ON CONFLICT (source, source_id, product_id) DO NOTHING;