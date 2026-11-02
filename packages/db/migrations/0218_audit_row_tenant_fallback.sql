-- ============================================================================
-- 0218 - Restore tenant/company fallback in audit_row()
--
-- Regression: 0130 taught audit_row() to resolve tenant_id/company_id for
-- audited child tables that carry no tenant_id/company_id column of their own
-- (falling back to the acting tenant). 0150 (Service Desk) later redefined
-- audit_row() with CREATE OR REPLACE to add its v_code fields, but that body
-- was based on the pre-0130 version and silently dropped the fallback.
--
-- With the least-privilege application role (hopedesign_app) and FORCE row
-- level security, audit_logs enforces
--   WITH CHECK (tenant_id = app_tenant_id()).
-- A trigger insert from a tenantless child table (e.g. stock_entry_lines,
-- receipt_allocations, journal_lines, budget_lines) therefore wrote
-- tenant_id = NULL, the RLS policy rejected the row, and the whole business
-- transaction rolled back as an "Internal server error" — the exact failure
-- seen on Quick Stock Entry and on Collection/Receipts.
--
-- Fix: resolve the scope from the acting tenant/company for any child table
-- without its own tenant column. Source-table RLS already guarantees the child
-- belongs to the acting tenant, so app_tenant_id()/app_company_id() are
-- authoritative here. Tables that do carry tenant_id/company_id are unchanged
-- (COALESCE keeps the row's own value).
-- ============================================================================

CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger AS $$
DECLARE
  v_tenant bigint; v_company bigint; v_branch bigint;
  v_changes jsonb; v_code text;
  v_old jsonb; v_new jsonb; v_row jsonb; k text;
BEGIN
  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);
  -- Never persist secrets in audit payloads
  IF TG_TABLE_NAME IN ('users','sessions') THEN
    FOREACH k IN ARRAY ARRAY['password_hash','mfa_secret','token_hash'] LOOP
      v_old := v_old - k;
      v_new := v_new - k;
    END LOOP;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_tenant := NULLIF(v_old->>'tenant_id','')::bigint;
    v_company := NULLIF(v_old->>'company_id','')::bigint;
    v_branch := NULLIF(v_old->>'branch_id','')::bigint;
    v_changes := v_old;
    v_row := v_old;
  ELSE
    v_tenant := NULLIF(v_new->>'tenant_id','')::bigint;
    v_company := NULLIF(v_new->>'company_id','')::bigint;
    v_branch := NULLIF(v_new->>'branch_id','')::bigint;
    v_row := v_new;
    IF TG_OP = 'INSERT' THEN
      v_changes := v_new;
    ELSE
      v_changes := jsonb_diff(v_old, v_new);
    END IF;
  END IF;

  -- Tenantless child tables have no tenant_id/company_id of their own; scope
  -- their audit row to the acting tenant so it satisfies the audit_logs RLS
  -- WITH CHECK (tenant_id = app_tenant_id()).
  v_tenant := COALESCE(v_tenant, app_tenant_id());
  v_company := COALESCE(v_company, app_company_id());

  v_code := COALESCE(
    NULLIF(v_row->>'code',''), NULLIF(v_row->>'document_no',''),
    NULLIF(v_row->>'doc_no',''), NULLIF(v_row->>'entry_no',''),
    NULLIF(v_row->>'wo_no',''), NULLIF(v_row->>'order_no',''),
    NULLIF(v_row->>'po_no',''), NULLIF(v_row->>'job_no',''),
    NULLIF(v_row->>'invoice_no',''), NULLIF(v_row->>'grn_no',''),
    NULLIF(v_row->>'quote_no',''), NULLIF(v_row->>'quotation_no',''),
    NULLIF(v_row->>'transfer_no',''), NULLIF(v_row->>'adjustment_no',''),
    NULLIF(v_row->>'payment_no',''), NULLIF(v_row->>'receipt_no',''),
    NULLIF(v_row->>'ncr_no',''), NULLIF(v_row->>'capa_no',''),
    NULLIF(v_row->>'return_no',''), NULLIF(v_row->>'contract_no',''),
    NULLIF(v_row->>'pr_no',''), NULLIF(v_row->>'rfq_no',''),
    NULLIF(v_row->>'delivery_no',''), NULLIF(v_row->>'credit_no',''),
    NULLIF(v_row->>'complaint_no',''), NULLIF(v_row->>'lead_no',''),
    NULLIF(v_row->>'mwo_no',''), NULLIF(v_row->>'request_no',''),
    NULLIF(v_row->>'trip_no',''), NULLIF(v_row->>'payroll_no',''),
    NULLIF(v_row->>'employee_no',''), NULLIF(v_row->>'label_no',''),
    NULLIF(v_row->>'plan_no',''), NULLIF(v_row->>'inspection_no',''),
    -- Service desk (0150)
    NULLIF(v_row->>'ticket_number',''), NULLIF(v_row->>'incident_no',''),
    NULLIF(v_row->>'problem_number',''), NULLIF(v_row->>'change_number',''),
    NULLIF(v_row->>'article_number',''), NULLIF(v_row->>'request_number',''),
    NULLIF(v_row->>'email',''), NULLIF(v_row->>'username',''),
    (v_row->>'id')::text
  );

  INSERT INTO audit_logs (tenant_id, company_id, branch_id, user_id, correlation_id, action, resource, record_id, record_code, old_values, new_values, changes, ip, user_agent, device, metadata)
  VALUES (
    v_tenant, v_company, v_branch, app_user_id(), current_setting('app.correlation_id', true),
    lower(TG_OP), TG_TABLE_NAME, COALESCE(NEW.id, OLD.id), v_code,
    CASE WHEN TG_OP = 'UPDATE' THEN v_old ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN v_new ELSE NULL END,
    v_changes,
    current_setting('app.ip', true), current_setting('app.user_agent', true), current_setting('app.device', true),
    jsonb_build_object('table', TG_TABLE_NAME)
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
