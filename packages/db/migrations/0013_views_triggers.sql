-- ============================================================
-- 0013 Views, verification functions, triggers, indexes
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------- updated_at triggers for every table with the column ----------
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'updated_at'
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;

-- ---------- audit row trigger ----------
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

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'customers','suppliers','products','product_batches','sales_quotations','sales_orders',
    'purchase_orders','goods_receipts','work_orders','security_jobs','inventory_adjustments',
    'inventory_transfers','journal_entries','customer_invoices','supplier_invoices','receipts',
    'supplier_payments','qr_codes','payrolls','assets','documents','users','roles','delivery_notes'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON %I
       FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP;
END $$;

-- ---------- Fuzzy search ----------
CREATE INDEX idx_products_name_trgm ON products USING gin (name gin_trgm_ops);
CREATE INDEX idx_customers_name_trgm ON customers USING gin (name gin_trgm_ops);
CREATE INDEX idx_suppliers_name_trgm ON suppliers USING gin (name gin_trgm_ops);
CREATE INDEX idx_employees_name_trgm ON employees USING gin ((first_name || ' ' || last_name) gin_trgm_ops);

-- ---------- Public QR verification (safe output only) ----------
CREATE OR REPLACE FUNCTION verify_qr_public(
  p_payload text, p_ip text DEFAULT NULL, p_user_agent text DEFAULT NULL, p_device text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_code text; v_secret text; v_hash text; v_qr record;
  v_result text; v_product text; v_is_first boolean := false;
  v_company bigint; v_tenant bigint;
BEGIN
  v_code := split_part(p_payload, '|', 1);
  v_secret := split_part(p_payload, '|', 2);
  IF v_code = '' OR v_secret = '' OR length(v_code) > 80 THEN
    INSERT INTO qr_scans (payload, scan_type, action, result, verified, ip, user_agent, device)
    VALUES (left(p_payload, 255), 'PUBLIC', 'VERIFY', 'UNKNOWN', false, p_ip, p_user_agent, p_device);
    RETURN jsonb_build_object('result', 'UNKNOWN', 'verified', false, 'message', 'QR code not recognized');
  END IF;
  v_hash := encode(digest(v_secret, 'sha256'), 'hex');
  SELECT * INTO v_qr FROM qr_codes WHERE code = v_code AND secret_hash = v_hash;
  IF v_qr.id IS NULL THEN
    INSERT INTO qr_scans (payload, scan_type, action, result, verified, ip, user_agent, device)
    VALUES (left(p_payload, 255), 'PUBLIC', 'VERIFY', 'UNKNOWN', false, p_ip, p_user_agent, p_device);
    RETURN jsonb_build_object('result', 'UNKNOWN', 'verified', false, 'message', 'QR code not recognized');
  END IF;

  IF v_qr.status = 'VOID' OR v_qr.status = 'DAMAGED' OR v_qr.status = 'LOST' OR v_qr.status = 'REPLACED' THEN
    v_result := 'VOID';
  ELSIF EXISTS (SELECT 1 FROM recalls WHERE qr_id = v_qr.id AND status = 'ACTIVE') THEN
    v_result := 'RECALLED';
  ELSIF v_qr.first_scan_at IS NOT NULL THEN
    v_result := 'ALREADY_VERIFIED';
  ELSE
    v_result := 'AUTHENTIC';
  END IF;

  IF v_result = 'AUTHENTIC' THEN
    UPDATE qr_codes SET first_scan_at = now(), last_scan_at = now(), scan_count = scan_count + 1 WHERE id = v_qr.id;
    v_is_first := true;
  ELSE
    UPDATE qr_codes SET last_scan_at = now(), scan_count = scan_count + 1 WHERE id = v_qr.id;
  END IF;

  SELECT name INTO v_product FROM products WHERE id = v_qr.product_id;
  v_company := v_qr.company_id; v_tenant := v_qr.tenant_id;
  INSERT INTO qr_scans (company_id, tenant_id, qr_id, payload, scan_type, action, result, verified, ip, user_agent, device, metadata)
  VALUES (v_company, v_tenant, v_qr.id, left(p_payload,255), 'PUBLIC', 'VERIFY', v_result,
          v_result IN ('AUTHENTIC','ALREADY_VERIFIED'), p_ip, p_user_agent, p_device,
          jsonb_build_object('first_verification', v_is_first));

  RETURN jsonb_build_object(
    'result', v_result,
    'verified', v_result IN ('AUTHENTIC','ALREADY_VERIFIED'),
    'product', COALESCE(v_product, 'Unknown product'),
    'code', v_qr.code,
    'verified_at', now()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------- QR anomaly detection ----------
CREATE OR REPLACE FUNCTION detect_qr_anomalies(
  p_qr_id bigint, p_scan_id bigint, p_location text DEFAULT NULL,
  p_window_min integer DEFAULT 60, p_threshold integer DEFAULT 10
) RETURNS void AS $$
DECLARE
  v_count int; v_prev record; v_company bigint; v_tenant bigint;
BEGIN
  SELECT company_id, tenant_id INTO v_company, v_tenant FROM qr_codes WHERE id = p_qr_id;

  -- Excessive scans
  SELECT count(*) INTO v_count FROM qr_scans
  WHERE qr_id = p_qr_id AND created_at > now() - (p_window_min || ' minutes')::interval;
  IF v_count > p_threshold THEN
    INSERT INTO qr_anomalies (company_id, tenant_id, qr_id, anomaly_type, severity, description, detected_from_scan_id)
    VALUES (v_company, v_tenant, p_qr_id, 'EXCESSIVE_SCANS', 'HIGH',
            format('%s scans within %s minutes', v_count, p_window_min), p_scan_id);
  END IF;

  -- Same QR in multiple locations (impossible movement)
  IF p_location IS NOT NULL THEN
    SELECT qr_id, location, created_at INTO v_prev FROM qr_scans
    WHERE qr_id = p_qr_id AND location IS NOT NULL AND location <> p_location
      AND created_at > now() - interval '15 minutes'
    ORDER BY created_at DESC LIMIT 1;
    IF v_prev.qr_id IS NOT NULL THEN
      INSERT INTO qr_anomalies (company_id, tenant_id, qr_id, anomaly_type, severity, description, detected_from_scan_id)
      VALUES (v_company, v_tenant, p_qr_id, 'SAME_QR_MULTIPLE_LOCATIONS', 'CRITICAL',
              format('QR scanned at %s after appearing at %s within 15 minutes', p_location, v_prev.location),
              p_scan_id);
    END IF;
  END IF;

  -- Voided QR scanned
  IF EXISTS (SELECT 1 FROM qr_codes WHERE id = p_qr_id AND status IN ('VOID','DAMAGED','LOST')) THEN
    INSERT INTO qr_anomalies (company_id, tenant_id, qr_id, anomaly_type, severity, description, detected_from_scan_id)
    VALUES (v_company, v_tenant, p_qr_id, 'VOIDED_QR_SCAN', 'CRITICAL',
            'A non-active QR code was scanned', p_scan_id);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------- Views ----------
CREATE OR REPLACE VIEW v_inventory_summary AS
SELECT i.id, i.company_id, i.tenant_id, i.product_id, p.code AS product_code, p.name AS product_name,
       p.type AS product_type, i.batch_id, pb.batch_no, i.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
       i.bin_id, i.quantity, i.reserved_qty, (i.quantity - i.reserved_qty) AS available_qty,
       i.avg_cost, (i.quantity * i.avg_cost) AS stock_value, i.valuation_method
FROM inventory i
JOIN products p ON p.id = i.product_id
LEFT JOIN product_batches pb ON pb.id = i.batch_id
LEFT JOIN warehouses w ON w.id = i.warehouse_id;

CREATE OR REPLACE VIEW v_work_order_summary AS
SELECT wo.id, wo.company_id, wo.tenant_id, wo.wo_no, wo.product_id, p.code AS product_code, p.name AS product_name,
       wo.quantity, wo.produced_qty, wo.scrapped_qty, wo.rework_qty, wo.waste_qty,
       wo.status, wo.priority, wo.start_date, wo.due_date, wo.started_at, wo.completed_at,
       wo.machine_id, m.code AS machine_code, m.name AS machine_name,
       wo.standard_cost, wo.actual_material_cost, wo.actual_labour_cost, wo.actual_machine_cost,
       wo.actual_overhead_cost, wo.actual_waste_cost, wo.actual_other_cost, wo.actual_cost,
       wo.cost_variance, wo.yield_percent, wo.efficiency_percent,
       CASE WHEN wo.quantity > 0 THEN round((wo.produced_qty / wo.quantity) * 100, 2) ELSE NULL END AS completion_percent
FROM work_orders wo
JOIN products p ON p.id = wo.product_id
LEFT JOIN machines m ON m.id = wo.machine_id;

CREATE OR REPLACE VIEW v_ar_aging AS
SELECT ci.id, ci.company_id, ci.tenant_id, ci.invoice_no, ci.customer_id, c.name AS customer_name,
       ci.invoice_date, ci.due_date, ci.total, ci.amount_paid, (ci.total - ci.amount_paid) AS balance,
       CASE
         WHEN ci.status = 'VOID' THEN 'VOID'
         WHEN ci.total - ci.amount_paid <= 0 THEN 'PAID'
         WHEN now()::date > ci.due_date THEN 'OVERDUE'
         WHEN now()::date > ci.due_date - 30 THEN 'AGING_1_30'
         ELSE 'CURRENT'
       END AS bucket
FROM customer_invoices ci
JOIN customers c ON c.id = ci.customer_id
WHERE ci.status <> 'VOID';

CREATE OR REPLACE VIEW v_ap_aging AS
SELECT si.id, si.company_id, si.tenant_id, si.supplier_invoice_no, si.supplier_id, s.name AS supplier_name,
       si.invoice_date, si.due_date, si.total, si.amount_paid, (si.total - si.amount_paid) AS balance,
       CASE
         WHEN si.status = 'VOID' THEN 'VOID'
         WHEN si.total - si.amount_paid <= 0 THEN 'PAID'
         WHEN now()::date > si.due_date THEN 'OVERDUE'
         ELSE 'CURRENT'
       END AS bucket
FROM supplier_invoices si
JOIN suppliers s ON s.id = si.supplier_id
WHERE si.status <> 'VOID';

CREATE OR REPLACE VIEW v_stock_value AS
SELECT company_id, tenant_id, warehouse_id, sum(stock_value) AS stock_value
FROM v_inventory_summary GROUP BY company_id, tenant_id, warehouse_id;

-- GL trial balance
CREATE OR REPLACE VIEW v_trial_balance AS
SELECT jl.account_id, a.code AS account_code, a.name AS account_name, a.account_type,
       sum(jl.debit) AS total_debit, sum(jl.credit) AS total_credit,
       sum(jl.debit - jl.credit) AS net_balance
FROM journal_lines jl
JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED'
JOIN chart_of_accounts a ON a.id = jl.account_id
GROUP BY jl.account_id, a.code, a.name, a.account_type;

-- Sales pipeline / dashboard aggregates
CREATE OR REPLACE VIEW v_sales_by_month AS
SELECT company_id, tenant_id, date_trunc('month', invoice_date) AS month,
       count(*) AS invoice_count, sum(total) AS revenue
FROM customer_invoices
WHERE status NOT IN ('DRAFT','VOID')
GROUP BY company_id, tenant_id, date_trunc('month', invoice_date);

CREATE OR REPLACE VIEW v_production_yield_by_month AS
SELECT company_id, tenant_id, date_trunc('month', created_at) AS month,
       sum(produced_qty) AS produced, sum(scrapped_qty) AS scrapped, sum(waste_qty) AS waste,
       CASE WHEN sum(quantity) > 0 THEN round(sum(produced_qty) / sum(quantity) * 100, 2) END AS yield_pct
FROM work_orders
WHERE status IN ('COMPLETED','CLOSED')
GROUP BY company_id, tenant_id, date_trunc('month', created_at);

-- Traceability: batch/QR lineage via movements
CREATE OR REPLACE VIEW v_qr_lineage AS
SELECT qc.id AS qr_id, qc.code AS qr_code, qc.tenant_id, qc.company_id,
       qc.entity_type, qc.entity_id, qc.product_id,
       p.name AS product_name, qc.batch_id, pb.batch_no, qc.status AS qr_status,
       qc.generated_at, qc.first_scan_at, qc.last_scan_at, qc.scan_count,
       w.code AS warehouse_code
FROM qr_codes qc
LEFT JOIN products p ON p.id = qc.product_id
LEFT JOIN product_batches pb ON pb.id = qc.batch_id
LEFT JOIN inventory i ON i.product_id = qc.product_id AND i.batch_id IS NOT DISTINCT FROM qc.batch_id
LEFT JOIN warehouses w ON w.id = i.warehouse_id;
