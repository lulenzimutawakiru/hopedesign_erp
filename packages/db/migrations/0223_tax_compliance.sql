-- ===========================================================================
-- 0223 - URA VAT return filing + tax report history (Spec 2: VAT & compliance)
--
-- tax_filings tracks the lifecycle of a VAT return (or other statutory
-- filing). Because URA exposes no authorised VAT-return filing API, SUBMITTED
-- and FILED are operator-confirmed transitions: a user records the URA
-- reference after actually filing on the portal. Nothing here is ever marked
-- SUBMITTED/FILED without explicit human confirmation.
--
-- report_history is a durable log of tax/EFRIS reports generated in the ERP
-- (source='ERP') or requested/received from the URA portal (source='EFRIS_PORTAL')
-- as part of the controlled manual process for portal-only functions.
--
-- No BEGIN/COMMIT and no schema_migrations row. migrate.js owns both.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS tax_filings (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  filing_type TEXT NOT NULL DEFAULT 'VAT_RETURN',   -- e.g. VAT_RETURN, WHT_RETURN
  period TEXT NOT NULL,                             -- e.g. '2026-10'
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','PREPARED','SUBMITTED','FILED','CLOSED','CANCELLED')),
  output_vat_base NUMERIC(18,2) NOT NULL DEFAULT 0,
  output_vat NUMERIC(18,2) NOT NULL DEFAULT 0,
  input_vat_base NUMERIC(18,2) NOT NULL DEFAULT 0,
  input_vat NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_vat_payable NUMERIC(18,2) NOT NULL DEFAULT 0,
  summary JSONB,                                    -- per-doc-type breakdown + snapshot
  ura_reference TEXT,                               -- URA filing/reference number
  notes TEXT,
  created_by BIGINT REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  submitted_by BIGINT REFERENCES users(id),
  filed_at TIMESTAMPTZ,
  filed_by BIGINT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  closed_by BIGINT REFERENCES users(id),
  cancelled_at TIMESTAMPTZ,
  cancelled_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, filing_type, period)
);

CREATE INDEX IF NOT EXISTS idx_tax_filings_status ON tax_filings (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_tax_filings_period ON tax_filings (tenant_id, filing_type, period_end);

CREATE TABLE IF NOT EXISTS report_history (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  report_type TEXT NOT NULL,                        -- VAT_RETURN, Z_REPORT, CREDIT_REGISTER, DEBIT_REGISTER, GOODS_REGISTER, ...
  source TEXT NOT NULL DEFAULT 'ERP'
    CHECK (source IN ('ERP','EFRIS_PORTAL')),
  status TEXT NOT NULL DEFAULT 'GENERATED'
    CHECK (status IN ('GENERATED','REQUESTED','RECEIVED','FAILED')),
  period TEXT,                                      -- optional period label
  title TEXT,
  summary JSONB,                                    -- e.g. counts, totals, params
  attachment_path TEXT,                             -- stored copy of a portal-issued report
  notes TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_history_type ON report_history (tenant_id, report_type);
CREATE INDEX IF NOT EXISTS idx_report_history_status ON report_history (tenant_id, status);

-- ---------- Row security, audit, privileges ----------
DO $$
BEGIN
  ALTER TABLE public.tax_filings ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.tax_filings FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON public.tax_filings;
  CREATE POLICY tenant_isolation ON public.tax_filings
    USING (tenant_id = app_tenant_id());

  DROP TRIGGER IF EXISTS trg_tax_filings_set_updated_at ON public.tax_filings;
  CREATE TRIGGER trg_tax_filings_set_updated_at BEFORE UPDATE ON public.tax_filings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

  DROP TRIGGER IF EXISTS trg_tax_filings_audit ON public.tax_filings;
  CREATE TRIGGER trg_tax_filings_audit AFTER INSERT OR UPDATE OR DELETE ON public.tax_filings
    FOR EACH ROW EXECUTE FUNCTION audit_row();

  ALTER TABLE public.report_history ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.report_history FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON public.report_history;
  CREATE POLICY tenant_isolation ON public.report_history
    USING (tenant_id = app_tenant_id());

  DROP TRIGGER IF EXISTS trg_report_history_set_updated_at ON public.report_history;
  CREATE TRIGGER trg_report_history_set_updated_at BEFORE UPDATE ON public.report_history
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

  DROP TRIGGER IF EXISTS trg_report_history_audit ON public.report_history;
  CREATE TRIGGER trg_report_history_audit AFTER INSERT OR UPDATE OR DELETE ON public.report_history
    FOR EACH ROW EXECUTE FUNCTION audit_row();
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON tax_filings TO hopedesign_app;
GRANT USAGE, SELECT ON SEQUENCE tax_filings_id_seq TO hopedesign_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON report_history TO hopedesign_app;
GRANT USAGE, SELECT ON SEQUENCE report_history_id_seq TO hopedesign_app;

-- ---------- Permissions + role grants (mirrored in packages/db/src/catalogue.js) ----------
INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, v.module, v.resource, v.action, v.description
FROM (VALUES
  ('finance.tax_filings.view','finance','tax_filings','view','View VAT returns and statutory filings'),
  ('finance.tax_filings.manage','finance','tax_filings','manage','Prepare, submit, file and manage VAT returns and statutory filings')
) AS v(code, module, resource, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

-- Tax officer and accountant own the filing lifecycle end-to-end; the auditor reads it.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('finance.tax_filings.view','finance.tax_filings.manage')
WHERE r.code IN ('tax_officer','accountant')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'finance.tax_filings.view'
WHERE r.code = 'internal_auditor'
ON CONFLICT (role_id, permission_id) DO NOTHING;
