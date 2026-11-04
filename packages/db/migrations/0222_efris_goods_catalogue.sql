-- ===========================================================================
-- 0222 - EFRIS goods catalogue + product registration status
--
-- A searchable copy of the URA goods & services catalogue (imported from the
-- official list) plus an explicit per-product registration lifecycle. Mapping
-- a product to a catalogue entry is an ERP-side action; the REGISTERED state is
-- only ever set by an operator confirming URA's acceptance (there is no
-- authorised registration API to poll), so it is never auto-derived.
--
-- No BEGIN/COMMIT and no schema_migrations row. migrate.js owns both.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS efris_goods (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  goods_code TEXT NOT NULL,        -- URA "My Product Code"
  goods_name TEXT NOT NULL,        -- URA registered goods name
  category_id TEXT,                -- URA goods category id
  category_name TEXT,              -- URA goods category name
  unit_of_measure TEXT,            -- URA unit-of-measure code
  vat_rate NUMERIC(8,4) NOT NULL DEFAULT 0,
  excise_rate NUMERIC(8,4) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, goods_code)
);

CREATE INDEX IF NOT EXISTS idx_efris_goods_name ON efris_goods (tenant_id, goods_name);
CREATE INDEX IF NOT EXISTS idx_efris_goods_category ON efris_goods (tenant_id, category_id);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS efris_registration_status TEXT NOT NULL DEFAULT 'UNMAPPED'
    CHECK (efris_registration_status IN ('UNMAPPED','MAPPED','SUBMITTED','REGISTERED','EXCLUDED')),
  ADD COLUMN IF NOT EXISTS efris_registered_at TIMESTAMPTZ;

-- Products already carrying a goods code are mapped, not unmapped.
UPDATE products
   SET efris_registration_status = 'MAPPED'
 WHERE efris_goods_code IS NOT NULL AND efris_goods_code <> ''
   AND efris_registration_status = 'UNMAPPED';

CREATE INDEX IF NOT EXISTS idx_products_efris_registration
  ON products (company_id, efris_registration_status);

-- ---------- Row security, audit, privileges ----------
DO $$
BEGIN
  ALTER TABLE public.efris_goods ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.efris_goods FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON public.efris_goods;
  CREATE POLICY tenant_isolation ON public.efris_goods
    USING (tenant_id = app_tenant_id());

  DROP TRIGGER IF EXISTS trg_efris_goods_set_updated_at ON public.efris_goods;
  CREATE TRIGGER trg_efris_goods_set_updated_at BEFORE UPDATE ON public.efris_goods
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

  DROP TRIGGER IF EXISTS trg_efris_goods_audit ON public.efris_goods;
  CREATE TRIGGER trg_efris_goods_audit AFTER INSERT OR UPDATE OR DELETE ON public.efris_goods
    FOR EACH ROW EXECUTE FUNCTION audit_row();
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON efris_goods TO hopedesign_app;
GRANT USAGE, SELECT ON SEQUENCE efris_goods_id_seq TO hopedesign_app;
