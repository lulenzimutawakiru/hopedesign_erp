-- ============================================================
-- 0107 Company Customization & Configuration Center
-- Data-driven, tenant-isolated, company-scoped configuration engine.
-- Reuses existing: app_settings, feature_flags,
--   document_numbering_rules, number_sequences, workflows,
--   notification_templates, configuration_history, audit_logs.
-- ============================================================

-- ---------- 1. Company branding ----------
CREATE TABLE IF NOT EXISTS company_branding (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  primary_color TEXT NOT NULL DEFAULT '#FF0000',
  secondary_color TEXT NOT NULL DEFAULT '#87CEEB',
  accent_color TEXT NOT NULL DEFAULT '#0F172A',
  background_color TEXT NOT NULL DEFAULT '#F8FAFC',
  surface_color TEXT NOT NULL DEFAULT '#FFFFFF',
  text_color TEXT NOT NULL DEFAULT '#0F172A',
  muted_text_color TEXT NOT NULL DEFAULT '#64748B',
  sidebar_bg TEXT NOT NULL DEFAULT '#0F172A',
  sidebar_text TEXT NOT NULL DEFAULT '#FFFFFF',
  sidebar_active_bg TEXT NOT NULL DEFAULT '#FF0000',
  header_bg TEXT NOT NULL DEFAULT '#FFFFFF',
  button_style TEXT NOT NULL DEFAULT 'solid' CHECK (button_style IN ('solid','outline','soft')),
  border_radius TEXT NOT NULL DEFAULT '10px',
  logo_url TEXT,
  favicon_url TEXT,
  logo_placement TEXT NOT NULL DEFAULT 'left' CHECK (logo_placement IN ('left','center','right','top')),
  login_bg TEXT,
  login_logo_url TEXT,
  email_branding JSONB NOT NULL DEFAULT '{}'::jsonb,
  document_branding JSONB NOT NULL DEFAULT '{}'::jsonb,
  report_branding JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_custom BOOLEAN NOT NULL DEFAULT false,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_company_branding_tenant ON company_branding(tenant_id);

-- ---------- 2. Company localization ----------
CREATE TABLE IF NOT EXISTS company_localization (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  country TEXT NOT NULL DEFAULT 'Uganda',
  country_code TEXT NOT NULL DEFAULT 'UG',
  language TEXT NOT NULL DEFAULT 'en',
  timezone TEXT NOT NULL DEFAULT 'Africa/Kampala',
  currency TEXT NOT NULL DEFAULT 'UGX',
  currency_symbol TEXT NOT NULL DEFAULT 'UGX',
  date_format TEXT NOT NULL DEFAULT 'DD/MM/YYYY',
  time_format TEXT NOT NULL DEFAULT '24h' CHECK (time_format IN ('12h','24h')),
  number_format TEXT NOT NULL DEFAULT '1,234.56',
  decimal_separator TEXT NOT NULL DEFAULT '.',
  thousands_separator TEXT NOT NULL DEFAULT ',',
  measurement_units JSONB NOT NULL DEFAULT '{"weight":"kg","length":"m","volume":"L"}'::jsonb,
  week_starts_on TEXT NOT NULL DEFAULT 'Monday',
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_company_localization_tenant ON company_localization(tenant_id);

-- ---------- 3. Company custom fields (no-code field engine) ----------
CREATE TABLE IF NOT EXISTS company_custom_fields (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  field_key TEXT NOT NULL,
  name TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('text','long_text','number','currency','percentage','date','datetime','time','checkbox','radio','dropdown','multi_select','email','phone','url','file','image','lookup','user','employee','customer','supplier','product','formula')),
  description TEXT,
  is_required BOOLEAN NOT NULL DEFAULT false,
  default_value JSONB,
  placeholder TEXT,
  validation JSONB NOT NULL DEFAULT '{}'::jsonb,
  min_value NUMERIC,
  max_value NUMERIC,
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  visibility TEXT NOT NULL DEFAULT 'everyone' CHECK (visibility IN ('everyone','admin','hr','manager','restricted')),
  is_searchable BOOLEAN NOT NULL DEFAULT true,
  is_filterable BOOLEAN NOT NULL DEFAULT true,
  is_sortable BOOLEAN NOT NULL DEFAULT true,
  is_reportable BOOLEAN NOT NULL DEFAULT false,
  is_sensitive BOOLEAN NOT NULL DEFAULT false,
  is_encrypted BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, entity, field_key)
);
CREATE INDEX IF NOT EXISTS idx_company_custom_fields_entity ON company_custom_fields(tenant_id, company_id, entity);

-- ---------- 4. Company document templates ----------
CREATE TABLE IF NOT EXISTS company_document_templates (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  layout JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default BOOLEAN NOT NULL DEFAULT false,
  version INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  effective_from DATE,
  created_by BIGINT REFERENCES users(id),
  approved_by BIGINT REFERENCES users(id),
  published_by BIGINT REFERENCES users(id),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, doc_type, code)
);
CREATE INDEX IF NOT EXISTS idx_company_doc_templates_type ON company_document_templates(tenant_id, company_id, doc_type);


-- ---------- 5. Company dashboards ----------
CREATE TABLE IF NOT EXISTS company_dashboards (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  scope TEXT NOT NULL DEFAULT 'company' CHECK (scope IN ('company','department','branch','role','user')),
  scope_id BIGINT,
  role_code TEXT,
  layout JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, code)
);
CREATE INDEX IF NOT EXISTS idx_company_dashboards_tenant ON company_dashboards(tenant_id, company_id);

-- ---------- 6. Company email settings ----------
CREATE TABLE IF NOT EXISTS company_email_settings (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'smtp' CHECK (provider IN ('smtp','sendgrid','mailgun','ses','postmark','other')),
  smtp_host TEXT,
  smtp_port INT,
  smtp_secure BOOLEAN NOT NULL DEFAULT true,
  smtp_username TEXT,
  smtp_password_encrypted TEXT,
  sender_name TEXT,
  sender_email TEXT,
  reply_to TEXT,
  email_signature TEXT,
  cc_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  bcc_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_company_email_tenant ON company_email_settings(tenant_id);

-- ---------- 7. Company integrations ----------
CREATE TABLE IF NOT EXISTS company_integrations (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('payments','communication','accounting','tax','storage','analytics','other')),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  secrets JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'DISCONNECTED' CHECK (status IN ('CONNECTED','DISCONNECTED','ERROR','TESTING')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_tested_at TIMESTAMPTZ,
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, code)
);
CREATE INDEX IF NOT EXISTS idx_company_integrations_cat ON company_integrations(tenant_id, company_id, category);

-- ---------- 8. Company policies ----------
CREATE TABLE IF NOT EXISTS company_policies (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','ACTIVE','ARCHIVED','EXPIRED')),
  effective_date DATE,
  expiry_date DATE,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, code)
);
CREATE INDEX IF NOT EXISTS idx_company_policies_cat ON company_policies(tenant_id, company_id, category);

-- ---------- 9. Company configuration versions ----------
CREATE TABLE IF NOT EXISTS company_config_versions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version INT NOT NULL,
  category TEXT NOT NULL DEFAULT 'all',
  label TEXT,
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  notes TEXT,
  created_by BIGINT REFERENCES users(id),
  approved_by BIGINT REFERENCES users(id),
  published_by BIGINT REFERENCES users(id),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, version, category)
);
CREATE INDEX IF NOT EXISTS idx_company_config_versions_tenant ON company_config_versions(tenant_id, company_id);

-- ---------- 10. Extend existing engines ----------
-- Document numbering rules: suffix, reset frequency, description
ALTER TABLE document_numbering_rules ADD COLUMN IF NOT EXISTS suffix TEXT;
ALTER TABLE document_numbering_rules ADD COLUMN IF NOT EXISTS reset_frequency TEXT NOT NULL DEFAULT 'YEAR';
ALTER TABLE document_numbering_rules ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE document_numbering_rules ADD CONSTRAINT chk_dnr_reset_frequency CHECK (reset_frequency IN ('NONE','MONTH','QUARTER','YEAR','FISCAL_YEAR'));

-- Workflow definitions: versioning + publish lifecycle
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'PUBLISHED';
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS effective_from DATE;
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS published_by BIGINT REFERENCES users(id);
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE workflows ADD CONSTRAINT chk_wf_status CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED'));

-- ---------- 11. Permissions for the configuration centre ----------
INSERT INTO permissions (code, module, resource, action, description, is_system)
SELECT x.code, 'admin', 'company_config', x.action, x.description, true
FROM (VALUES
  ('admin.company_config.view',        'view',        'View company configuration, branding and settings'),
  ('admin.company_config.update',      'update',      'Create and update company configuration'),
  ('admin.company_config.administer',  'administer',  'Publish configuration versions, import/export and manage the configuration lifecycle')
) AS x(code, action, description)
ON CONFLICT (code) DO NOTHING;


-- ---------- 12. Configuration health function ----------
CREATE OR REPLACE FUNCTION company_configuration_health(p_tenant bigint, p_company bigint)
RETURNS jsonb AS $$
DECLARE
  v_checks jsonb := '[]'::jsonb;
  v_score int := 0;
  v_total int := 0;
  v_branding int;
  v_locale int;
  v_currency text;
  v_tax text;
  v_numbering int;
  v_invoice_templates int;
  v_wf_total int;
  v_wf_bad int;
  v_sec int;
  v_features int;
  v_integration_err int;
  v_policies int;
  v_color text;
BEGIN
  -- Branding
  v_total := v_total + 1;
  SELECT count(*), max(primary_color) INTO v_branding, v_color
  FROM company_branding WHERE tenant_id = p_tenant AND company_id = p_company;
  IF v_branding > 0 AND v_color ~ '^#[0-9A-Fa-f]{6}$' THEN
    v_score := v_score + 1;
    v_checks := v_checks || '{"key":"branding","label":"Branding","status":"ok","message":"Company branding is configured with a valid palette"}'::jsonb;
  ELSIF v_branding > 0 THEN
    v_checks := v_checks || '{"key":"branding","label":"Branding","status":"warn","message":"Branding exists but the primary colour is not a valid hex value"}'::jsonb;
  ELSE
    v_checks := v_checks || '{"key":"branding","label":"Branding","status":"warn","message":"Company branding not configured - platform defaults are in use"}'::jsonb;
  END IF;

  -- Localization
  v_total := v_total + 1;
  SELECT count(*) INTO v_locale FROM company_localization WHERE tenant_id = p_tenant AND company_id = p_company;
  IF v_locale > 0 THEN
    v_score := v_score + 1;
    v_checks := v_checks || '{"key":"localization","label":"Localization","status":"ok","message":"Country, timezone, currency and formats are configured"}'::jsonb;
  ELSE
    v_checks := v_checks || '{"key":"localization","label":"Localization","status":"warn","message":"Localization uses platform defaults"}'::jsonb;
  END IF;

  -- Financial / tax
  v_total := v_total + 1;
  SELECT (value #>> '{}') INTO v_currency FROM app_settings
  WHERE tenant_id = p_tenant AND company_id = p_company AND category = 'general' AND key = 'currency';
  SELECT (value #>> '{}') INTO v_tax FROM app_settings
  WHERE tenant_id = p_tenant AND company_id = p_company AND category = 'general' AND key = 'default_tax_rate';
  IF v_currency IS NOT NULL AND v_tax IS NOT NULL THEN
    v_score := v_score + 1;
    v_checks := v_checks || '{"key":"financial","label":"Financial Settings","status":"ok","message":"Base currency and default tax rate are configured"}'::jsonb;
  ELSE
    v_checks := v_checks || '{"key":"financial","label":"Financial Settings","status":"warn","message":"Currency or default tax rate missing - check Financial Settings"}'::jsonb;
  END IF;

  -- Numbering
  v_total := v_total + 1;
  SELECT count(*) INTO v_numbering FROM document_numbering_rules
  WHERE tenant_id = p_tenant AND (company_id = p_company OR company_id IS NULL) AND is_active = true;
  IF v_numbering > 0 THEN
    v_score := v_score + 1;
    v_checks := v_checks || jsonb_build_object('key','numbering','label','Numbering','status','ok','message', v_numbering || ' active document numbering rule(s)');
  ELSE
    v_checks := v_checks || '{"key":"numbering","label":"Numbering","status":"warn","message":"No document numbering rules configured"}'::jsonb;
  END IF;

  -- Document templates
  v_total := v_total + 1;
  SELECT count(*) INTO v_invoice_templates FROM company_document_templates
  WHERE tenant_id = p_tenant AND company_id = p_company AND doc_type = 'INVOICE' AND status = 'PUBLISHED';
  IF v_invoice_templates > 0 THEN
    v_score := v_score + 1;
    v_checks := v_checks || '{"key":"documents","label":"Documents","status":"ok","message":"At least one published invoice template exists"}'::jsonb;
  ELSE
    v_checks := v_checks || '{"key":"documents","label":"Documents","status":"warn","message":"No published invoice template - document branding may fall back to defaults"}'::jsonb;
  END IF;

  -- Workflows
  v_total := v_total + 1;
  SELECT count(*) INTO v_wf_total FROM workflows WHERE tenant_id = p_tenant AND company_id = p_company AND is_active = true;
  SELECT count(*) INTO v_wf_bad FROM workflows
  WHERE tenant_id = p_tenant AND company_id = p_company AND is_active = true
    AND (config = '[]'::jsonb OR config IS NULL OR jsonb_typeof(config) <> 'array' OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(config) s
      WHERE (s->>'approver_role') IS NOT NULL OR (s->>'approver_user') IS NOT NULL));
  IF v_wf_total > 0 AND v_wf_bad = 0 THEN
    v_score := v_score + 1;
    v_checks := v_checks || jsonb_build_object('key','workflows','label','Workflows','status','ok','message', v_wf_total || ' workflow(s) with valid approval steps');
  ELSIF v_wf_total > 0 THEN
    v_checks := v_checks || jsonb_build_object('key','workflows','label','Workflows','status','warn','message', v_wf_bad || ' workflow(s) have no approver assigned to any step');
  ELSE
    v_checks := v_checks || '{"key":"workflows","label":"Workflows","status":"warn","message":"No approval workflows configured"}'::jsonb;
  END IF;

  -- Security
  v_total := v_total + 1;
  SELECT count(*) INTO v_sec FROM app_settings
  WHERE tenant_id = p_tenant AND company_id = p_company AND category = 'security' AND key = 'password_min_length';
  IF v_sec > 0 THEN
    v_score := v_score + 1;
    v_checks := v_checks || '{"key":"security","label":"Security","status":"ok","message":"Security policy settings are present"}'::jsonb;
  ELSE
    v_checks := v_checks || '{"key":"security","label":"Security","status":"warn","message":"Security policy settings use platform defaults"}'::jsonb;
  END IF;

  -- Features
  v_total := v_total + 1;
  SELECT count(*) INTO v_features FROM feature_flags WHERE tenant_id = p_tenant AND company_id = p_company;
  IF v_features > 0 THEN
    v_score := v_score + 1;
    v_checks := v_checks || jsonb_build_object('key','features','label','Modules & Features','status','ok','message', v_features || ' feature flag(s) configured');
  ELSE
    v_checks := v_checks || '{"key":"features","label":"Modules & Features","status":"ok","message":"Feature flags use platform defaults"}'::jsonb;
  END IF;

  -- Integrations
  v_total := v_total + 1;
  SELECT count(*) INTO v_integration_err FROM company_integrations
  WHERE tenant_id = p_tenant AND company_id = p_company AND status = 'ERROR';
  IF v_integration_err = 0 THEN
    v_score := v_score + 1;
    v_checks := v_checks || '{"key":"integrations","label":"Integrations","status":"ok","message":"No integration is in an error state"}'::jsonb;
  ELSE
    v_checks := v_checks || jsonb_build_object('key','integrations','label','Integrations','status','warn','message', v_integration_err || ' integration(s) are in an error state');
  END IF;

  -- Policies
  v_total := v_total + 1;
  SELECT count(*) INTO v_policies FROM company_policies
  WHERE tenant_id = p_tenant AND company_id = p_company AND status IN ('APPROVED','ACTIVE');
  IF v_policies > 0 THEN
    v_score := v_score + 1;
    v_checks := v_checks || jsonb_build_object('key','policies','label','Policies','status','ok','message', v_policies || ' active company policy/policies');
  ELSE
    v_checks := v_checks || '{"key":"policies","label":"Policies","status":"warn","message":"No approved company policies on record"}'::jsonb;
  END IF;

  RETURN jsonb_build_object(
    'score', CASE WHEN v_total = 0 THEN 0 ELSE round((v_score::numeric / v_total::numeric) * 100) END,
    'passed', v_score,
    'total', v_total,
    'computed_at', now(),
    'checks', v_checks
  );
END;
$$ LANGUAGE plpgsql;
