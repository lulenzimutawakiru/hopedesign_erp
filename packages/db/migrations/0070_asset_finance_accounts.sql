-- ============================================================
-- 0070 Asset finance accounts & maintenance/impairment workflows
-- (HOPE DESIGN GROUP LTD)
-- 1. Fixed-asset chart of accounts: Plant/Property/Equipment,
--    Computer & IT Equipment, Accumulated Depreciation and the
--    Asset Disposal gain/loss clearing account.
-- 2. Approval workflows for maintenance work orders and
--    impairment postings (seeded per company when absent).
-- Idempotent: safe to re-apply.
-- ============================================================

-- ---- 1. Fixed-asset CoA accounts ----
INSERT INTO chart_of_accounts (company_id, tenant_id, code, name, account_type, subtype, parent_id, is_posting, is_active, currency, opening_balance, attributes)
SELECT DISTINCT company_id, tenant_id, '1600', 'Plant, Property & Equipment', 'ASSET', 'FIXED_ASSET', NULL::bigint, true, true, 'UGX', 0, '{}'::jsonb
FROM chart_of_accounts
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts a WHERE a.company_id = chart_of_accounts.company_id AND a.code = '1600');

INSERT INTO chart_of_accounts (company_id, tenant_id, code, name, account_type, subtype, parent_id, is_posting, is_active, currency, opening_balance, attributes)
SELECT DISTINCT c.company_id, c.tenant_id, '1610', 'Computer & IT Equipment', 'ASSET', 'FIXED_ASSET',
       (SELECT a.id FROM chart_of_accounts a WHERE a.company_id = c.company_id AND a.code = '1600'),
       true, true, 'UGX', 0, '{}'::jsonb
FROM chart_of_accounts c
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts a WHERE a.company_id = c.company_id AND a.code = '1610');

INSERT INTO chart_of_accounts (company_id, tenant_id, code, name, account_type, subtype, parent_id, is_posting, is_active, currency, opening_balance, attributes)
SELECT DISTINCT company_id, tenant_id, '1620', 'Accumulated Depreciation', 'CONTRA_ASSET', 'ACCUMULATED_DEPRECIATION', NULL::bigint, true, true, 'UGX', 0, '{}'::jsonb
FROM chart_of_accounts
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts a WHERE a.company_id = chart_of_accounts.company_id AND a.code = '1620');

INSERT INTO chart_of_accounts (company_id, tenant_id, code, name, account_type, subtype, parent_id, is_posting, is_active, currency, opening_balance, attributes)
SELECT DISTINCT company_id, tenant_id, '1690', 'Asset Disposal Gains & Losses', 'CONTRA_ASSET', 'ASSET_DISPOSAL', NULL::bigint, true, true, 'UGX', 0, '{}'::jsonb
FROM chart_of_accounts
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts a WHERE a.company_id = chart_of_accounts.company_id AND a.code = '1690');

-- ---- 2. Maintenance & impairment approval workflows ----
INSERT INTO workflows (company_id, tenant_id, code, name, entity_type, description, config, is_active)
SELECT DISTINCT w.company_id, w.tenant_id, 'WF-ASSET-MAINTENANCE', 'Asset Maintenance Approval', 'assets.maintenance',
       'Maintenance work orders require Asset Manager approval.',
       '[{"seq":1,"name":"Asset Manager Approval","approver_role":"asset_manager","amount_min":0,"amount_max":1000000000,"sla_hours":24}]'::jsonb,
       true
FROM workflows w
WHERE NOT EXISTS (SELECT 1 FROM workflows x WHERE x.company_id = w.company_id AND x.code = 'WF-ASSET-MAINTENANCE');

INSERT INTO workflows (company_id, tenant_id, code, name, entity_type, description, config, is_active)
SELECT DISTINCT w.company_id, w.tenant_id, 'WF-ASSET-IMPAIRMENT', 'Asset Impairment Approval', 'assets.impairments',
       'Impairment postings require Asset Manager then CFO approval (dual control).',
       '[{"seq":1,"name":"Asset Manager Approval","approver_role":"asset_manager","amount_min":0,"amount_max":1000000000,"sla_hours":24},{"seq":2,"name":"CFO Approval","approver_role":"cfo","amount_min":0,"amount_max":1000000000,"sla_hours":48}]'::jsonb,
       true
FROM workflows w
WHERE NOT EXISTS (SELECT 1 FROM workflows x WHERE x.company_id = w.company_id AND x.code = 'WF-ASSET-IMPAIRMENT');