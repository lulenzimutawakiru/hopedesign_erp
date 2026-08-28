-- ============================================================
-- 0108 Company Customization seed data — HOPE DESIGN GROUP LTD
-- Demo configuration for tenant 2 / company 2 (idempotent).
-- ============================================================

-- ---------- 1. Sections entity (org structure) ----------
CREATE TABLE IF NOT EXISTS sections (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  branch_id BIGINT REFERENCES branches(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  head_user_id BIGINT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
CREATE INDEX IF NOT EXISTS idx_sections_tenant ON sections(tenant_id);

-- ---------- 2. Branding ----------
INSERT INTO company_branding (tenant_id, company_id, primary_color, secondary_color, accent_color, background_color, surface_color, text_color, muted_text_color, sidebar_bg, sidebar_text, sidebar_active_bg, header_bg, button_style, border_radius, logo_placement, is_custom)
SELECT 2, id, '#FF0000', '#87CEEB', '#0F172A', '#F8FAFC', '#FFFFFF', '#0F172A', '#64748B', '#0F172A', '#FFFFFF', '#FF0000', '#FFFFFF', 'solid', '10px', 'left', true
FROM companies WHERE tenant_id = 2 AND id = 2
ON CONFLICT (tenant_id, company_id) DO UPDATE SET
  primary_color = EXCLUDED.primary_color, secondary_color = EXCLUDED.secondary_color,
  accent_color = EXCLUDED.accent_color, is_custom = true, updated_at = now();

-- ---------- 3. Localization (Uganda defaults) ----------
INSERT INTO company_localization (tenant_id, company_id, country, country_code, language, timezone, currency, currency_symbol, date_format, time_format, number_format, decimal_separator, thousands_separator, measurement_units, week_starts_on)
SELECT 2, id, 'Uganda', 'UG', 'en', 'Africa/Kampala', 'UGX', 'UGX', 'DD/MM/YYYY', '24h', '1,234.56', '.', ',', '{"weight":"kg","length":"m","volume":"L"}'::jsonb, 'Monday'
FROM companies WHERE tenant_id = 2 AND id = 2
ON CONFLICT (tenant_id, company_id) DO UPDATE SET timezone = EXCLUDED.timezone, currency = EXCLUDED.currency, updated_at = now();

-- ---------- 4. Financial & tax app settings ----------
INSERT INTO app_settings (tenant_id, company_id, category, key, value, updated_by)
SELECT 2, id, x.category, x.key, x.value, 1
FROM companies CROSS JOIN (VALUES
  ('general','currency','"UGX"'::jsonb),
  ('general','currency_symbol','"UGX"'::jsonb),
  ('general','default_tax_rate','18'::jsonb),
  ('general','tax_inclusive','false'::jsonb),
  ('general','tax_id','"TIN-1012345678"'::jsonb),
  ('general','vat_number','"VAT-2026-00123"'::jsonb),
  ('general','fiscal_year_start','"07-01"'::jsonb),
  ('general','decimal_precision','2'::jsonb),
  ('general','payment_terms','"30 days"'::jsonb),
  ('general','withholding_tax_rate','6'::jsonb),
  ('general','rounding_rule','"round"'::jsonb),
  ('security','password_min_length','10'::jsonb),
  ('security','session_timeout_minutes','60'::jsonb),
  ('security','mfa_required_for_admins','true'::jsonb),
  ('documents','document_retention_years','7'::jsonb)
) AS x(category, key, value)
WHERE tenant_id = 2 AND id = 2
ON CONFLICT (tenant_id, company_id, category, key) DO NOTHING;

-- ---------- 5. Document numbering rules ----------
INSERT INTO document_numbering_rules (tenant_id, company_id, doc_type, prefix, format, include_year, include_branch, include_department, pad, start_seq, suffix, reset_frequency, description, is_active)
SELECT 2, id, x.doc_type, x.prefix, x.format, true, false, false, x.pad, 1, NULL, 'YEAR', x.description, true
FROM companies CROSS JOIN (VALUES
  ('QUOTATION','HD-QTN','{PREFIX}-{YYYY}-{####}', 4, 'Customer quotations'),
  ('SALES_ORDER','HD-SO','{PREFIX}-{YYYY}-{####}', 4, 'Sales orders'),
  ('INVOICE','HD-INV','{PREFIX}-{YYYY}-{####}', 4, 'Sales invoices'),
  ('RECEIPT','HD-RCP','{PREFIX}-{YYYY}-{####}', 4, 'Payment receipts'),
  ('CREDIT_NOTE','HD-CN','{PREFIX}-{YYYY}-{####}', 4, 'Credit notes'),
  ('DEBIT_NOTE','HD-DN','{PREFIX}-{YYYY}-{####}', 4, 'Debit notes'),
  ('DELIVERY_NOTE','HD-DN','{PREFIX}-{YYYY}-{####}', 4, 'Delivery notes'),
  ('PURCHASE_REQUISITION','HD-PR','{PREFIX}-{YYYY}-{####}', 4, 'Purchase requisitions'),
  ('PURCHASE_ORDER','HD-PO','{PREFIX}-{YYYY}-{####}', 4, 'Purchase orders'),
  ('GRN','HD-GRN','{PREFIX}-{YYYY}-{####}', 4, 'Goods received notes'),
  ('PAYMENT_VOUCHER','HD-PV','{PREFIX}-{YYYY}-{####}', 4, 'Payment vouchers'),
  ('JOURNAL_VOUCHER','HD-JV','{PREFIX}-{YYYY}-{####}', 4, 'Journal vouchers'),
  ('STOCK_TRANSFER','HD-ST','{PREFIX}-{YYYY}-{####}', 4, 'Stock transfers'),
  ('MATERIAL_ISSUE','HD-MI','{PREFIX}-{YYYY}-{####}', 4, 'Material issues'),
  ('PRODUCTION_ORDER','HD-PRD','{PREFIX}-{YYYY}-{####}', 4, 'Production orders'),
  ('JOB_CARD','HD-JC','{PREFIX}-{YYYY}-{####}', 4, 'Job cards'),
  ('EMPLOYEE','HD-EMP','{PREFIX}-{####}', 5, 'Employee numbers'),
  ('CONTRACT','HD-CON','{PREFIX}-{YYYY}-{####}', 4, 'Employment contracts'),
  ('PAYSLIP','HD-PSL','{PREFIX}-{YYYY}-{MM}-{####}', 4, 'Payslips'),
  ('LEAVE','HD-LV','{PREFIX}-{YYYY}-{####}', 4, 'Leave forms'),
  ('ASSET','HD-AST','{PREFIX}-{YYYY}-{####}', 4, 'Asset registers'),
  ('STATEMENT','HD-STM','{PREFIX}-{YYYY}-{####}', 4, 'Customer statements'),
  ('REPORT','HD-RPT','{PREFIX}-{YYYY}-{####}', 4, 'Generated reports')
) AS x(doc_type, prefix, format, pad, description)
WHERE tenant_id = 2 AND id = 2
ON CONFLICT (tenant_id, doc_type, COALESCE(company_id,0), COALESCE(branch_id,0)) DO NOTHING;

-- ---------- 6. Document templates ----------
INSERT INTO company_document_templates (tenant_id, company_id, doc_type, code, name, description, layout, is_default, version, status, effective_from)
SELECT 2, id, x.doc_type, x.code, x.name, x.description, x.layout, true, 1, 'PUBLISHED', '2026-01-01'
FROM companies CROSS JOIN (VALUES
  ('INVOICE','TPL-INV-STD','Standard Invoice','HOPE DESIGN branded invoice with header, line items, tax and totals', '{"header":{"show_logo":true,"show_company":true},"footer":{"show_terms":true},"sections":["header","meta","lines","totals","tax","footer"],"watermark":""}'::jsonb),
  ('QUOTATION','TPL-QTN-STD','Standard Quotation','Standard quotation layout', '{"header":{"show_logo":true},"sections":["header","meta","lines","totals","footer"]}'::jsonb),
  ('CONTRACT','TPL-CON-STD','Standard Employment Contract','Standard employment contract with clauses, compensation and signature blocks', '{"header":{"show_logo":true},"sections":["parties","employment","compensation","terms","signatures"]}'::jsonb),
  ('PAYSLIP','TPL-PSL-STD','Standard Payslip','Monthly payslip layout', '{"header":{"show_logo":true},"sections":["header","earnings","deductions","totals","footer"]}'::jsonb)
) AS x(doc_type, code, name, description, layout)
WHERE tenant_id = 2 AND id = 2
ON CONFLICT (tenant_id, company_id, doc_type, code) DO NOTHING;

-- ---------- 7. Feature flags (company overrides) ----------
INSERT INTO feature_flags (tenant_id, company_id, module, feature, enabled, environment, rollout)
SELECT 2, id, x.module, x.feature, true, 'production', 100
FROM companies CROSS JOIN (VALUES
  ('finance','accounting'), ('finance','multi_currency'), ('sales','orders'), ('sales','invoices'),
  ('crm','customers'), ('procurement','purchase_orders'), ('inventory','stock'), ('inventory','warehouses'),
  ('manufacturing','production'), ('hr','employees'), ('hr','contracts'), ('hr','payroll'),
  ('assets','register'), ('reports','analytics'), ('payroll','processing')
) AS x(module, feature)
WHERE tenant_id = 2 AND id = 2
ON CONFLICT (tenant_id, module, feature, COALESCE(company_id,0), COALESCE(branch_id,0)) DO NOTHING;

-- ---------- 8. Notification templates ----------
INSERT INTO notification_templates (tenant_id, code, name, channel, subject, body, is_active)
SELECT 2, x.code, x.name, x.channel, x.subject, x.body, true
FROM (VALUES
  ('APPROVAL_REQUESTED','Approval Requested','IN_APP','Approval required','A document has been submitted for your approval.'),
  ('APPROVAL_COMPLETED','Approval Completed','IN_APP','Approval decision recorded','Your document was approved.'),
  ('APPROVAL_REJECTED','Approval Rejected','IN_APP','Approval decision recorded','Your document was rejected.'),
  ('CONTRACT_EXPIRY','Contract Expiry','IN_APP','Contract expiring soon','An employment contract will expire soon.'),
  ('CONTRACT_SIGNED','Contract Signed','IN_APP','Contract executed','The contract has been signed by all parties.'),
  ('INVOICE_CREATED','Invoice Created','IN_APP','New invoice issued','A new invoice has been issued.'),
  ('PAYMENT_RECEIVED','Payment Received','IN_APP','Payment received','A payment was received against an invoice.'),
  ('LOW_STOCK','Low Stock','IN_APP','Low stock alert','A stock item has reached its reorder level.'),
  ('LEAVE_APPROVED','Leave Approved','IN_APP','Leave request approved','Your leave request has been approved.'),
  ('PAYROLL_PROCESSED','Payroll Processed','IN_APP','Payroll processed','Payroll for the period has been processed.'),
  ('SECURITY_EVENT','Security Event','IN_APP','Security event','A security event was detected on your account.')
) AS x(code, name, channel, subject, body)
ON CONFLICT (tenant_id, code, channel) DO NOTHING;

-- ---------- 9. Company policies ----------
INSERT INTO company_policies (tenant_id, company_id, category, code, name, description, content, version, status, effective_date, expiry_date)
SELECT 2, id, x.category, x.code, x.name, x.description, x.content, 1, 'ACTIVE', '2026-01-01', '2026-12-31'
FROM companies CROSS JOIN (VALUES
  ('leave','POL-LEAVE-001','Annual Leave Policy','Annual leave accrual and booking rules', '{"accrual_days":20,"carry_over_days":5,"notice_days":7}'::jsonb),
  ('procurement','POL-PROC-001','Procurement Policy','Purchasing thresholds and approval rules', '{"single_quote_limit":500000,"three_quote_limit":5000000,"tender_limit":50000000}'::jsonb),
  ('payroll','POL-PAY-001','Payroll Policy','Payroll processing and disbursement rules', '{"pay_day":25,"month_end_close":5,"direct_deposit":true}'::jsonb),
  ('asset','POL-AST-001','Asset Management Policy','Asset acquisition, tagging and disposal rules', '{"tagging_required":true,"disposal_approval":"MD"}'::jsonb)
) AS x(category, code, name, description, content)
WHERE tenant_id = 2 AND id = 2
ON CONFLICT (tenant_id, company_id, code) DO NOTHING;

-- ---------- 10. Initial configuration version ----------
INSERT INTO company_config_versions (tenant_id, company_id, version, category, label, snapshot, status, notes, created_by)
SELECT 2, id, 1, 'all', 'Initial company configuration', '{"branding":true,"localization":true,"numbering":true}'::jsonb, 'PUBLISHED', 'Baseline configuration captured at setup', 1
FROM companies WHERE tenant_id = 2 AND id = 2
ON CONFLICT (tenant_id, company_id, version, category) DO NOTHING;
