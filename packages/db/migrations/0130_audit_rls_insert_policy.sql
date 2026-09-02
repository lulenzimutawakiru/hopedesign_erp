-- 0130_audit_rls_insert_policy.sql
-- DB-002 Phase 2B: make the generic audit pipeline tenant-correct under the
-- least-privilege application role (hopedesign_app).
--
-- Problem
-- -------
-- With FORCE row-level security (0127) every write the application role
-- performs must satisfy RLS, including the writes issued by the generic audit
-- trigger audit_row(). Six audited child tables carry no tenant_id/company_id
-- of their own (employee_competencies, onboarding_instance_tasks,
-- offboarding_instance_tasks, performance_review_items,
-- performance_review_feedback, timesheet_lines). Their source-table RLS only
-- admits rows whose parent belongs to the acting tenant, so the business write
-- succeeds - but audit_row() then INSERTs into audit_logs with a NULL
-- tenant_id, which the audit_logs tenant_isolation policy rejects, aborting
-- the whole business transaction (e.g. HCM offer acceptance) with an RLS
-- violation.
--
-- Fix
-- ----
-- 1) audit_row() resolves tenant_id/company_id from the tenant-carrying parent
--    for those six child tables before writing the audit row. The acting
--    tenant (app_tenant_id()) is the authoritative fallback: source-table RLS
--    can only ever admit rows scoped to the acting tenant, so an audit row
--    with no resolvable parent still belongs to the tenant that performed the
--    write.
-- 2) Genuine business audit trails become append-only for the application role
--    (UPDATE/DELETE/TRUNCATE revoked and UPDATE/DELETE rejected by trigger) so
--    a compromised application connection cannot rewrite history. Asset-count
--    workflow tables (asset_audits/asset_audit_items/asset_audit_exceptions)
--    are deliberately NOT append-only: their lifecycle is legitimately updated
--    in place by the asset audit workflow.
-- 3) Explicit FOR INSERT tenant policies are added to every tenant-carried
--    audit/log table so the INSERT scoping invariant survives any future
--    refactor of the legacy FOR ALL tenant_isolation policy.

-- ---------- 1. audit_row(): resolve tenant scope for tenantless sources -----
CREATE OR REPLACE FUNCTION public.audit_row() RETURNS trigger AS $$
DECLARE
  v_tenant bigint; v_company bigint; v_branch bigint;
  v_changes jsonb; v_code text;
  v_old jsonb; v_new jsonb; v_row jsonb; k text;
BEGIN
  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);
  -- Never persist secrets in audit payloads (applies to every table).
  FOREACH k IN ARRAY ARRAY['password_hash','mfa_secret','token_hash','key_hash','code_hash','secret_hash','fingerprint_hash','backup_code_hash'] LOOP
    v_old := v_old - k;
    v_new := v_new - k;
  END LOOP;

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
    NULLIF(v_row->>'email',''), NULLIF(v_row->>'username',''),
    (v_row->>'id')::text
  );

  -- Audited child tables without a tenant/company column of their own resolve
  -- their audit scope from the tenant-carrying parent row they reference.
  IF v_tenant IS NULL THEN
    CASE TG_TABLE_NAME
      WHEN 'employee_competencies' THEN
        SELECT tenant_id, company_id INTO v_tenant, v_company FROM public.employees
         WHERE id = (v_row->>'employee_id')::bigint;
      WHEN 'onboarding_instance_tasks' THEN
        SELECT tenant_id, company_id INTO v_tenant, v_company FROM public.onboarding_instances
         WHERE id = (v_row->>'instance_id')::bigint;
      WHEN 'offboarding_instance_tasks' THEN
        SELECT tenant_id, company_id INTO v_tenant, v_company FROM public.offboarding_instances
         WHERE id = (v_row->>'instance_id')::bigint;
      WHEN 'performance_review_items' THEN
        SELECT tenant_id, company_id INTO v_tenant, v_company FROM public.performance_reviews
         WHERE id = (v_row->>'review_id')::bigint;
      WHEN 'performance_review_feedback' THEN
        SELECT tenant_id, company_id INTO v_tenant, v_company FROM public.performance_reviews
         WHERE id = (v_row->>'review_id')::bigint;
      WHEN 'timesheet_lines' THEN
        SELECT tenant_id, company_id INTO v_tenant, v_company FROM public.timesheets
         WHERE id = (v_row->>'timesheet_id')::bigint;
    END CASE;
    -- Source-table RLS only admits rows scoped to the acting tenant, so the
    -- acting tenant is the authoritative fallback when a parent cannot be
    -- resolved (e.g. a cascaded DELETE that already removed the parent).
    v_tenant := COALESCE(v_tenant, app_tenant_id());
  END IF;

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

-- ---------- 2. Explicit INSERT tenant policies on audit/log tables ----------
-- Behavior is identical to the legacy FOR ALL tenant_isolation policy today
-- (permissive policies are OR-ed), but stating FOR INSERT WITH CHECK pins the
-- invariant that the application role can never create an audit row outside
-- its own tenant, even if the FOR ALL policy is later replaced.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_logs','asset_audit_exceptions','asset_audit_items',
    'asset_audits','communication_audit_logs','db_migration_audit',
    'expense_audit_logs','financial_audit_logs','inventory_audit_logs',
    'payroll_audit_logs'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_insert ON public.%I', t);
    EXECUTE format('CREATE POLICY tenant_isolation_insert ON public.%I '
                   'FOR INSERT WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

-- ---------- 3. Append-only hardening of genuine audit trails ----------------
-- The application role is the only non-superuser writer (0126 grants
-- SELECT/INSERT/UPDATE/DELETE on all tables), so revoking UPDATE/DELETE here
-- closes the tamper path at the privilege layer. The BEFORE UPDATE OR DELETE
-- trigger is defense in depth and binds the table owner as well.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['expense_audit_logs','financial_audit_logs',
    'inventory_audit_logs','payroll_audit_logs','communication_audit_logs'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_trail_append_only ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_audit_trail_append_only '
                   'BEFORE UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.guard_append_only()', t);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM hopedesign_app', t);
  END LOOP;
END $$;

-- db_migration_audit is migration bookkeeping: the operator/owner may need to
-- correct rows, so it is protected by privilege revocation only (no trigger
-- that would bind the owner).
REVOKE UPDATE, DELETE, TRUNCATE ON public.db_migration_audit FROM hopedesign_app;
