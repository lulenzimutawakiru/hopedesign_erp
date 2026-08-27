-- ============================================================
-- 0021 Enterprise purchase requisitions
-- Adds the fields and controls required for a production-grade
-- PR lifecycle: categorisation, multi-currency, receiving,
-- budget validation, GL charging, delivery terms and audit trail.
-- ============================================================

-- ---------- Requisition header ----------
ALTER TABLE purchase_requisitions
  ADD COLUMN title TEXT,
  ADD COLUMN description TEXT,
  ADD COLUMN category TEXT NOT NULL DEFAULT 'GOODS'
    CHECK (category IN ('GOODS','SERVICES','ASSETS','SUBSCRIPTION','OTHER')),
  ADD COLUMN urgency TEXT NOT NULL DEFAULT 'NORMAL'
    CHECK (urgency IN ('LOW','NORMAL','HIGH','CRITICAL')),
  ADD COLUMN currency_code TEXT NOT NULL DEFAULT 'UGX',
  ADD COLUMN exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
  ADD COLUMN total_estimated NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN base_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN project_id BIGINT,
  ADD COLUMN warehouse_id BIGINT REFERENCES warehouses(id),
  ADD COLUMN delivery_location TEXT,
  ADD COLUMN incoterm TEXT,
  ADD COLUMN ship_to_address TEXT,
  ADD COLUMN delivery_instruction TEXT,
  ADD COLUMN payment_terms TEXT,
  ADD COLUMN cost_centre_id BIGINT REFERENCES cost_centres(id),
  ADD COLUMN account_id BIGINT REFERENCES chart_of_accounts(id),
  ADD COLUMN budget_check_status TEXT NOT NULL DEFAULT 'EXEMPT'
    CHECK (budget_check_status IN ('PASS','FAIL','EXEMPT')),
  ADD COLUMN budget_variance NUMERIC(18,2),
  ADD COLUMN rejection_reason TEXT,
  ADD COLUMN cancelled_by BIGINT,
  ADD COLUMN cancelled_at TIMESTAMPTZ,
  ADD COLUMN converted_by BIGINT,
  ADD COLUMN converted_at TIMESTAMPTZ;

-- ---------- Requisition lines ----------
ALTER TABLE purchase_requisition_items
  ADD COLUMN description TEXT,
  ADD COLUMN currency_code TEXT NOT NULL DEFAULT 'UGX',
  ADD COLUMN exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
  ADD COLUMN tax_rate NUMERIC(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN line_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN gl_account_id BIGINT REFERENCES chart_of_accounts(id),
  ADD COLUMN project_id BIGINT;

-- ---------- Indexes for desk filters and joins ----------
CREATE INDEX idx_pr_company_status ON purchase_requisitions(company_id, status);
CREATE INDEX idx_pr_category ON purchase_requisitions(category);
CREATE INDEX idx_pr_urgency ON purchase_requisitions(urgency);
CREATE INDEX idx_pr_currency ON purchase_requisitions(currency_code);
CREATE INDEX idx_pr_cost_centre ON purchase_requisitions(cost_centre_id);
CREATE INDEX idx_pr_warehouse ON purchase_requisitions(warehouse_id);
CREATE INDEX idx_pr_requested_by ON purchase_requisitions(requested_by);
CREATE INDEX idx_pr_items_requisition ON purchase_requisition_items(requisition_id);

-- ---------- Requisition approval workflow ----------
-- PRs under UGX 20M require Procurement Manager approval; above
-- that threshold they also require Operations Director sign-off.
-- Fail-closed: the API refuses to submit a PR when no active
-- workflow exists for the company, so approvals cannot be skipped.
INSERT INTO workflows (company_id, tenant_id, code, name, entity_type, description, config, is_active)
SELECT c.id, c.tenant_id, 'WF-PR', 'Purchase Requisition Approval', 'procurement.requisitions',
       'PRs under UGX 20M are approved by the Procurement Manager; above UGX 20M they also require the Operations Director.',
       '[{"seq":1,"name":"Procurement Manager Approval","approver_role":"procurement_manager","amount_min":0,"amount_max":20000000,"sla_hours":24},{"seq":2,"name":"Operations Director Approval","approver_role":"operations_director","amount_min":20000000,"amount_max":0,"sla_hours":48}]'::jsonb,
       true
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM workflows w WHERE w.company_id = c.id AND w.code = 'WF-PR');