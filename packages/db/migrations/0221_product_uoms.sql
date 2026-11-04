-- ===========================================================================
-- 0221 - Product units of measure (multi-UOM) with per-purpose conversion
--
-- A product has ONE base/inventory unit (products.unit_id). Different
-- workflows buy, make, sell and fiscalise in different units, so this table
-- maps each purpose to a unit and a conversion factor. The factor is the
-- quantity of the product's BASE unit in one unit of the mapped UOM
-- (e.g. BASE = ream, SALES = carton of 5 reams -> conversion_factor = 5).
-- Factors are snapshotted per row, so historical conversions never drift when
-- a unit or factor changes later.
--
-- No BEGIN/COMMIT and no schema_migrations row. migrate.js owns both.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS product_uoms (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  unit_id BIGINT NOT NULL REFERENCES units(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('BASE','PURCHASE','PRODUCTION','SALES','EFRIS')),
  -- Quantity of the product's BASE unit (products.unit_id) in one unit of `unit_id`.
  conversion_factor NUMERIC(18,6) NOT NULL DEFAULT 1,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, product_id, purpose)
);

CREATE INDEX IF NOT EXISTS idx_product_uoms_product
  ON product_uoms (product_id, purpose);
CREATE INDEX IF NOT EXISTS idx_product_uoms_unit
  ON product_uoms (unit_id);

-- ---------- Row security, audit, privileges ----------
DO $$
BEGIN
  ALTER TABLE public.product_uoms ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.product_uoms FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON public.product_uoms;
  CREATE POLICY tenant_isolation ON public.product_uoms
    USING (tenant_id = app_tenant_id());

  DROP TRIGGER IF EXISTS trg_product_uoms_set_updated_at ON public.product_uoms;
  CREATE TRIGGER trg_product_uoms_set_updated_at BEFORE UPDATE ON public.product_uoms
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

  DROP TRIGGER IF EXISTS trg_product_uoms_audit ON public.product_uoms;
  CREATE TRIGGER trg_product_uoms_audit AFTER INSERT OR UPDATE OR DELETE ON public.product_uoms
    FOR EACH ROW EXECUTE FUNCTION audit_row();
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON product_uoms TO hopedesign_app;
GRANT USAGE, SELECT ON SEQUENCE product_uoms_id_seq TO hopedesign_app;
