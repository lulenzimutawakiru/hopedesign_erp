-- ===========================================================================
-- 0209 - Quick stock entry
--
-- A single entry document a warehouse or stores operator fills in a few
-- steps: pick RECEIPT / ISSUE / TRANSFER, add one or more item lines by
-- search or scan, then Save Draft or Submit. Submission posts the lines
-- through post_inventory_move(), so balances, batches, FIFO/weighted-average
-- cost and the stock ledger stay identical to every other movement.
--
-- No BEGIN/COMMIT and no schema_migrations row. migrate.js owns both.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS stock_entries (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id),
  entry_no TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('RECEIPT','ISSUE','TRANSFER')),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED','CANCELLED')),
  -- RECEIPT: the warehouse the stock lands in. ISSUE: the warehouse it leaves.
  -- TRANSFER: the source warehouse (to_warehouse_id is the destination).
  warehouse_id BIGINT REFERENCES warehouses(id),
  to_warehouse_id BIGINT REFERENCES warehouses(id),
  supplier_id BIGINT REFERENCES suppliers(id),
  customer_id BIGINT REFERENCES customers(id),
  work_order_id BIGINT REFERENCES work_orders(id),
  department_id BIGINT REFERENCES departments(id),
  cost_centre_id BIGINT REFERENCES cost_centres(id),
  reference_no TEXT,
  notes TEXT,
  attachment_path TEXT,
  -- Idempotency token from the client. A retried submit with the same token
  -- must not post twice; the unique index enforces that at the database level.
  client_token UUID NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at TIMESTAMPTZ,
  posted_by BIGINT REFERENCES users(id),
  UNIQUE (tenant_id, client_token),
  UNIQUE (company_id, entry_no)
);

CREATE INDEX IF NOT EXISTS idx_stock_entries_creator
  ON stock_entries (tenant_id, created_by, status);
CREATE INDEX IF NOT EXISTS idx_stock_entries_status
  ON stock_entries (tenant_id, entry_type, status);
CREATE INDEX IF NOT EXISTS idx_stock_entries_warehouse
  ON stock_entries (warehouse_id, status);

CREATE TABLE IF NOT EXISTS stock_entry_lines (
  id BIGSERIAL PRIMARY KEY,
  entry_id BIGINT NOT NULL REFERENCES stock_entries(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL DEFAULT 1,
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  bin_id BIGINT REFERENCES warehouse_bins(id),
  to_bin_id BIGINT REFERENCES warehouse_bins(id),
  quantity NUMERIC(18,4) NOT NULL,
  unit_id BIGINT REFERENCES units(id),
  unit_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  expiry_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entry_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_stock_entry_lines_product
  ON stock_entry_lines (product_id);

-- ---------- Row security, audit, privileges ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_entries', 'stock_entry_lines'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    IF t = 'stock_entries' THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I USING (tenant_id = app_tenant_id())', t);
    ELSE
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I USING (entry_id IN (SELECT id FROM stock_entries))', t);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgname = 'trg_set_updated_at' AND tgrelid = to_regclass('public.' || t)
    ) AND t = 'stock_entries' THEN
      EXECUTE format(
        'CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_audit ON public.%I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%I_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION audit_row()', t, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON stock_entries, stock_entry_lines TO hopedesign_app;
GRANT USAGE, SELECT ON SEQUENCE stock_entries_id_seq, stock_entry_lines_id_seq TO hopedesign_app;
