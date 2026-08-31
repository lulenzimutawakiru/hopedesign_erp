-- ============================================================
-- 0109 Company Profiles & company-scoped notifications
-- Extended company identity fields + document asset storage,
-- plus company_id on notification templates for per-company
-- notification configuration.
-- ============================================================

CREATE TABLE IF NOT EXISTS company_profiles (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  registration_number TEXT,
  vat_number TEXT,
  industry TEXT,
  business_type TEXT,
  incorporation_date DATE,
  country TEXT,
  region TEXT,
  district TEXT,
  city TEXT,
  physical_address TEXT,
  postal_address TEXT,
  alternate_phone TEXT,
  general_contact TEXT,
  primary_contact_person TEXT,
  business_description TEXT,
  mission TEXT,
  vision TEXT,
  slogan TEXT,
  stamp_url TEXT,
  digital_signature_url TEXT,
  authorized_signature_url TEXT,
  letterhead_url TEXT,
  watermark_url TEXT,
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_company_profiles_tenant ON company_profiles(tenant_id);

-- Company-scoped notification templates (platform templates remain NULL company_id).
ALTER TABLE notification_templates ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_nt_company_scope
  ON notification_templates (tenant_id, company_id, code, channel)
  WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nt_company ON notification_templates(tenant_id, company_id);

-- Demo profile for HOPE DESIGN GROUP LTD (tenant 2 / company 2, idempotent).
INSERT INTO company_profiles (tenant_id, company_id, registration_number, vat_number, industry, business_type,
  incorporation_date, country, region, district, city, physical_address, postal_address, alternate_phone,
  general_contact, primary_contact_person, business_description, mission, vision, slogan)
SELECT 2, id, 'UGA-2020-REG-0001', 'VAT-0001-2020', 'Paper & Packaging', 'Private Limited Company',
  '2020-03-15', 'Uganda', 'Central', 'Kampala', 'Kampala', 'Plot 7, Industrial Area, Kampala',
  'P.O. Box 12345 Kampala', '+256 700 000 002', 'info@hopedesign.example', 'Company Secretary',
  'HOPE DESIGN GROUP LTD is a security printing and paper manufacturing company.',
  'To deliver trusted, high-quality print and packaging solutions.',
  'To be East Africa''s most trusted security print partner.',
  'Precision in Every Print'
FROM companies WHERE tenant_id = 2 AND id = 2
ON CONFLICT (tenant_id, company_id) DO NOTHING;
