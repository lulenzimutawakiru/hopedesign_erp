-- Identity rows several later migrations hard-code (tenant/company/branch id = 2).
-- Safe on a fresh database and a no-op when those ids already exist.
INSERT INTO tenants (id, code, name, status, settings)
VALUES (2, 'HDG', 'Hope Design Group Ltd', 'ACTIVE', '{"timezone":"Africa/Kampala","locale":"en-UG"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO companies (
  id, tenant_id, code, name, legal_name, tin, vrn, currency, address, phone, email, website, fiscal_year_start, status
) VALUES (
  2, 2, 'HDG', 'Hope Design Group Ltd', 'Hope Design Group Ltd',
  '1012345678', 'VAT-UG-1020304', 'UGX',
  'Plot 12, Namanve Industrial Park, Kampala, Uganda',
  '+256 414 000 000', 'info@hopedesign.jorlentech.com', 'https://hopedesign.jorlentech.com',
  '07-01', 'ACTIVE'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO branches (id, company_id, tenant_id, code, name, status)
VALUES (2, 2, 2, 'KAMPALA-HQ', 'Kampala Headquarters', 'ACTIVE')
ON CONFLICT (id) DO NOTHING;

SELECT setval('tenants_id_seq', GREATEST((SELECT last_value FROM tenants_id_seq), 2), true);
SELECT setval('companies_id_seq', GREATEST((SELECT last_value FROM companies_id_seq), 2), true);
SELECT setval('branches_id_seq', GREATEST((SELECT last_value FROM branches_id_seq), 2), true);
