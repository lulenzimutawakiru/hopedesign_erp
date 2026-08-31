-- ============================================================================
-- 0118 - Communication templates expansion + enterprise cron job engine
--  * More email + notification templates (manufacturing / quality / inventory)
--  * cron_jobs + cron_job_runs tables (recurring background automation)
--  * get_due_cron_jobs() queue read + seeded HOPE DESIGN cron jobs
-- Idempotent: safe on fresh + existing DB.
-- ============================================================================

-- ------------------------------------------------------------
-- 1. Extend email template categories for manufacturing ops
-- ------------------------------------------------------------
ALTER TABLE email_templates DROP CONSTRAINT IF EXISTS email_templates_category_check;
ALTER TABLE email_templates ADD CONSTRAINT email_templates_category_check
  CHECK (category IN ('SALES','FINANCE','PROCUREMENT','LOGISTICS','HR','SYSTEM','GENERAL','MANUFACTURING','QUALITY','INVENTORY'));

-- ------------------------------------------------------------
-- 2. Seed: additional email templates (HDG)
-- ------------------------------------------------------------
INSERT INTO email_templates (tenant_id, company_id, code, name, category, subject, body, variables, is_active)
SELECT t.id, c.id, v.code, v.name, v.category, v.subject, v.body, v.variables::jsonb, true
FROM tenants t
JOIN companies c ON c.tenant_id = t.id AND c.code = 'HDG'
CROSS JOIN (VALUES
  ('PRODUCTION_ORDER_RELEASED','Production Order Released','MANUFACTURING','Production Order {{ORDER_NO}} Released','Hello {{RECIPIENT_NAME}}, Production Order {{ORDER_NO}} for {{PRODUCT_NAME}} ({{QUANTITY}} {{UOM}}) has been released for production. Scheduled start {{START_DATE}} on {{MACHINE_NAME}}. Kind regards, {{COMPANY_NAME}}','["ORDER_NO","PRODUCT_NAME","QUANTITY","UOM","START_DATE","MACHINE_NAME","RECIPIENT_NAME","COMPANY_NAME"]'),
  ('PRODUCTION_COMPLETED','Production Completed','MANUFACTURING','Production Order {{ORDER_NO}} Completed','Hello {{RECIPIENT_NAME}}, Production Order {{ORDER_NO}} for {{PRODUCT_NAME}} has been completed with {{GOOD_QTY}} {{UOM}} good output and {{WASTE_QTY}} {{UOM}} waste. Kind regards, {{COMPANY_NAME}}','["ORDER_NO","PRODUCT_NAME","GOOD_QTY","WASTE_QTY","UOM","RECIPIENT_NAME","COMPANY_NAME"]'),
  ('PRODUCTION_DELAYED','Production Delayed','MANUFACTURING','Production Delay - Order {{ORDER_NO}}','Hello {{RECIPIENT_NAME}}, Production Order {{ORDER_NO}} is currently behind schedule by {{DELAY_MINUTES}} minutes. Current progress is {{PROGRESS_PERCENT}}%. Please review. Kind regards, {{COMPANY_NAME}}','["ORDER_NO","DELAY_MINUTES","PROGRESS_PERCENT","RECIPIENT_NAME","COMPANY_NAME"]'),
  ('SHIFT_SUMMARY','Shift Summary','MANUFACTURING','Shift Summary - {{SHIFT_NAME}} {{SHIFT_DATE}}','Hello {{RECIPIENT_NAME}}, the {{SHIFT_NAME}} shift on {{SHIFT_DATE}} produced {{OUTPUT_QTY}} {{UOM}} against a target of {{TARGET_QTY}} {{UOM}} ({{ACHIEVEMENT_PERCENT}}%). Waste was {{WASTE_PERCENT}}%. Kind regards, {{COMPANY_NAME}}','["SHIFT_NAME","SHIFT_DATE","OUTPUT_QTY","TARGET_QTY","ACHIEVEMENT_PERCENT","WASTE_PERCENT","UOM","RECIPIENT_NAME","COMPANY_NAME"]'),
  ('QUALITY_INSPECTION_REQUEST','Quality Inspection Request','QUALITY','Quality Inspection Required - {{BATCH_NO}}','Hello {{RECIPIENT_NAME}}, batch {{BATCH_NO}} for {{PRODUCT_NAME}} is ready for {{INSPECTION_TYPE}} inspection at {{INSPECTION_POINT}}. Please complete the inspection before {{DEADLINE}}. Kind regards, {{COMPANY_NAME}}','["BATCH_NO","PRODUCT_NAME","INSPECTION_TYPE","INSPECTION_POINT","DEADLINE","RECIPIENT_NAME","COMPANY_NAME"]'),
  ('QUALITY_HOLD','Quality Hold','QUALITY','Quality Hold - {{BATCH_NO}}','Hello {{RECIPIENT_NAME}}, batch {{BATCH_NO}} for {{PRODUCT_NAME}} has been placed on hold due to {{REASON}}. Quantity {{QUANTITY}} {{UOM}} is blocked pending review. Kind regards, {{COMPANY_NAME}}','["BATCH_NO","PRODUCT_NAME","REASON","QUANTITY","UOM","RECIPIENT_NAME","COMPANY_NAME"]'),
  ('QUALITY_REJECTED','Quality Rejected','QUALITY','Quality Rejected - {{BATCH_NO}}','Hello {{RECIPIENT_NAME}}, batch {{BATCH_NO}} for {{PRODUCT_NAME}} has failed inspection. Rejected quantity {{QUANTITY}} {{UOM}}. Disposition: {{DISPOSITION}}. Kind regards, {{COMPANY_NAME}}','["BATCH_NO","PRODUCT_NAME","QUANTITY","UOM","DISPOSITION","RECIPIENT_NAME","COMPANY_NAME"]'),
  ('MACHINE_BREAKDOWN','Machine Breakdown','MANUFACTURING','Machine Breakdown - {{MACHINE_NAME}}','Hello {{RECIPIENT_NAME}}, machine {{MACHINE_NAME}} ({{MACHINE_CODE}}) has reported a breakdown. Downtime so far: {{DOWNTIME_MINUTES}} minutes. Affected order: {{ORDER_NO}}. Kind regards, {{COMPANY_NAME}}','["MACHINE_NAME","MACHINE_CODE","DOWNTIME_MINUTES","ORDER_NO","RECIPIENT_NAME","COMPANY_NAME"]'),
  ('MAINTENANCE_DUE','Maintenance Due','MANUFACTURING','Maintenance Due - {{MACHINE_NAME}}','Hello {{RECIPIENT_NAME}}, scheduled maintenance for {{MACHINE_NAME}} ({{MACHINE_CODE}}) is due on {{DUE_DATE}}. Please plan the maintenance window. Kind regards, {{COMPANY_NAME}}','["MACHINE_NAME","MACHINE_CODE","DUE_DATE","RECIPIENT_NAME","COMPANY_NAME"]'),
  ('MATERIAL_SHORTAGE','Material Shortage','MANUFACTURING','Material Shortage - {{ORDER_NO}}','Hello {{RECIPIENT_NAME}}, production order {{ORDER_NO}} requires {{REQUIRED_QTY}} {{UOM}} of {{MATERIAL_NAME}} but only {{AVAILABLE_QTY}} {{UOM}} is available. Please action before {{DEADLINE}}. Kind regards, {{COMPANY_NAME}}','["ORDER_NO","MATERIAL_NAME","REQUIRED_QTY","AVAILABLE_QTY","UOM","DEADLINE","RECIPIENT_NAME","COMPANY_NAME"]'),
  ('STOCK_REORDER','Stock Reorder Alert','INVENTORY','Reorder Alert - {{ITEM_NAME}}','Hello {{RECIPIENT_NAME}}, stock for {{ITEM_NAME}} ({{ITEM_CODE}}) has reached the reorder level. Available {{AVAILABLE_QTY}} {{UOM}}, reorder point {{REORDER_POINT}} {{UOM}}. Please create a purchase request. Kind regards, {{COMPANY_NAME}}','["ITEM_NAME","ITEM_CODE","AVAILABLE_QTY","REORDER_POINT","UOM","RECIPIENT_NAME","COMPANY_NAME"]'),
  ('LOW_STOCK','Low Stock Alert','INVENTORY','Low Stock Alert - {{ITEM_NAME}}','Hello {{RECIPIENT_NAME}}, {{ITEM_NAME}} ({{ITEM_CODE}}) is critically low with {{AVAILABLE_QTY}} {{UOM}} available against a safety stock of {{SAFETY_STOCK}} {{UOM}}. Kind regards, {{COMPANY_NAME}}','["ITEM_NAME","ITEM_CODE","AVAILABLE_QTY","SAFETY_STOCK","UOM","RECIPIENT_NAME","COMPANY_NAME"]'),
  ('GOODS_RECEIPT','Goods Receipt Notification','PROCUREMENT','Goods Receipt {{GRN_NO}}','Hello {{RECIPIENT_NAME}}, goods receipt {{GRN_NO}} for purchase order {{PO_NO}} has been received from {{SUPPLIER_NAME}}. Quantity received {{QUANTITY}} {{UOM}}. Status: {{STATUS}}. Kind regards, {{COMPANY_NAME}}','["GRN_NO","PO_NO","SUPPLIER_NAME","QUANTITY","UOM","STATUS","RECIPIENT_NAME","COMPANY_NAME"]'),
  ('PAYMENT_RECEIPT','Payment Receipt','FINANCE','Payment Received - {{DOCUMENT_NUMBER}}','Hello {{RECIPIENT_NAME}}, payment of {{AMOUNT}} has been received for {{DOCUMENT_NUMBER}} and posted on {{PAYMENT_DATE}}. Kind regards, {{COMPANY_NAME}}','["DOCUMENT_NUMBER","AMOUNT","PAYMENT_DATE","RECIPIENT_NAME","COMPANY_NAME"]'),
  ('CREDIT_NOTE','Credit Note','FINANCE','Credit Note {{DOCUMENT_NUMBER}}','Dear {{CUSTOMER_NAME}}, credit note {{DOCUMENT_NUMBER}} for {{AMOUNT}} has been issued for invoice {{INVOICE_NUMBER}}. Kind regards, {{COMPANY_NAME}}','["CUSTOMER_NAME","DOCUMENT_NUMBER","AMOUNT","INVOICE_NUMBER","COMPANY_NAME"]'),
  ('DELIVERY_DISPATCH','Delivery Dispatch','LOGISTICS','Delivery {{DOCUMENT_NUMBER}} Dispatched','Dear {{CUSTOMER_NAME}}, delivery {{DOCUMENT_NUMBER}} has been dispatched via {{TRANSPORT_MODE}} and is expected on {{DELIVERY_DATE}}. Tracking: {{TRACKING_NO}}. Kind regards, {{COMPANY_NAME}}','["CUSTOMER_NAME","DOCUMENT_NUMBER","TRANSPORT_MODE","DELIVERY_DATE","TRACKING_NO","COMPANY_NAME"]'),
  ('WORK_ORDER_OVERDUE','Work Order Overdue','MANUFACTURING','Work Order Overdue - {{WORK_ORDER_NO}}','Hello {{RECIPIENT_NAME}}, work order {{WORK_ORDER_NO}} for {{PRODUCT_NAME}} was due on {{DUE_DATE}} and is now overdue. Current status: {{STATUS}}. Kind regards, {{COMPANY_NAME}}','["WORK_ORDER_NO","PRODUCT_NAME","DUE_DATE","STATUS","RECIPIENT_NAME","COMPANY_NAME"]'),
  ('CUSTODY_OVERDUE','Asset Custody Overdue','MANUFACTURING','Asset Custody Overdue - {{ASSET_NO}}','Hello {{RECIPIENT_NAME}}, asset {{ASSET_NO}} ({{ASSET_NAME}}) assigned to {{CUSTODIAN_NAME}} was expected back on {{EXPECTED_RETURN_DATE}} and is now overdue. Kind regards, {{COMPANY_NAME}}','["ASSET_NO","ASSET_NAME","CUSTODIAN_NAME","EXPECTED_RETURN_DATE","RECIPIENT_NAME","COMPANY_NAME"]')
) AS v(code, name, category, subject, body, variables)
WHERE t.code = 'HDG'
  AND NOT EXISTS (SELECT 1 FROM email_templates et WHERE et.tenant_id = t.id AND et.code = v.code);


-- ------------------------------------------------------------
-- 3. Seed: notification templates (IN_APP + EMAIL variants)
-- ------------------------------------------------------------
INSERT INTO notification_templates (tenant_id, code, name, channel, subject, body, is_active)
SELECT t.id, v.code, v.name, v.channel, v.subject, v.body, true
FROM tenants t
CROSS JOIN (VALUES
  ('APPROVAL_REQUIRED','Approval Required','IN_APP','{{DOCUMENT_TYPE}} {{DOCUMENT_NUMBER}} requires your approval','{{REQUESTED_BY}} submitted {{DOCUMENT_TYPE}} {{DOCUMENT_NUMBER}} for {{AMOUNT}}. Please review before {{DUE_DATE}}.'),
  ('APPROVAL_REQUIRED','Approval Required','EMAIL','Action Required: Approve {{DOCUMENT_TYPE}} {{DOCUMENT_NUMBER}}','Hello {{RECIPIENT_NAME}}, {{DOCUMENT_TYPE}} {{DOCUMENT_NUMBER}} ({{AMOUNT}}) submitted by {{REQUESTED_BY}} requires your approval. Open {{APPROVAL_LINK}} to review. Kind regards, {{COMPANY_NAME}}.'),
  ('CONTRACT_EXPIRY','Contract Expiry','IN_APP','{{EMPLOYEE_NAME}}''s contract expires in {{DAYS_REMAINING}} days','Employment contract for {{EMPLOYEE_NAME}} ({{CONTRACT_TYPE}}) expires on {{EXPIRY_DATE}}. Please begin renewal.'),
  ('CONTRACT_EXPIRY','Contract Expiry','EMAIL','Contract Expiring Soon - {{EMPLOYEE_NAME}}','Hello {{RECIPIENT_NAME}}, the employment contract for {{EMPLOYEE_NAME}} ({{CONTRACT_TYPE}}) expires on {{EXPIRY_DATE}} ({{DAYS_REMAINING}} days). Please coordinate renewal. Kind regards, {{COMPANY_NAME}}.'),
  ('ASSET_MAINTENANCE_DUE','Asset Maintenance Due','IN_APP','Maintenance due for {{ASSET_NAME}}','{{ASSET_NAME}} ({{ASSET_NO}}) is due for scheduled maintenance on {{DUE_DATE}}.'),
  ('ASSET_MAINTENANCE_DUE','Asset Maintenance Due','EMAIL','Maintenance Due - {{ASSET_NAME}}','Hello {{RECIPIENT_NAME}}, {{ASSET_NAME}} ({{ASSET_NO}}) is due for scheduled maintenance on {{DUE_DATE}}. Please plan the maintenance window. Kind regards, {{COMPANY_NAME}}.'),
  ('ASSET_INSPECTION_DUE','Asset Inspection Due','IN_APP','Inspection due for {{ASSET_NAME}}','{{ASSET_NAME}} ({{ASSET_NO}}) is due for inspection on {{DUE_DATE}}.'),
  ('ASSET_INSPECTION_DUE','Asset Inspection Due','EMAIL','Inspection Due - {{ASSET_NAME}}','Hello {{RECIPIENT_NAME}}, {{ASSET_NAME}} ({{ASSET_NO}}) is due for inspection on {{DUE_DATE}}. Kind regards, {{COMPANY_NAME}}.'),
  ('APPROVAL_ESCALATED','Approval Escalated','IN_APP','{{DOCUMENT_TYPE}} {{DOCUMENT_NUMBER}} escalated','Approval for {{DOCUMENT_TYPE}} {{DOCUMENT_NUMBER}} has been pending since {{SUBMITTED_AT}} and is now escalated.'),
  ('APPROVAL_ESCALATED','Approval Escalated','EMAIL','Escalated: {{DOCUMENT_TYPE}} {{DOCUMENT_NUMBER}}','Hello {{RECIPIENT_NAME}}, approval for {{DOCUMENT_TYPE}} {{DOCUMENT_NUMBER}} has been pending since {{SUBMITTED_AT}} and requires management attention. Open {{APPROVAL_LINK}} to review. Kind regards, {{COMPANY_NAME}}.'),
  ('STOCK_REORDER','Stock Reorder','IN_APP','{{ITEM_NAME}} reached reorder level','{{ITEM_NAME}} ({{ITEM_CODE}}) has {{AVAILABLE_QTY}} {{UOM}} available, below the reorder point of {{REORDER_POINT}} {{UOM}}.'),
  ('STOCK_REORDER','Stock Reorder','EMAIL','Reorder Alert - {{ITEM_NAME}}','Hello {{RECIPIENT_NAME}}, {{ITEM_NAME}} ({{ITEM_CODE}}) has reached reorder level. Available {{AVAILABLE_QTY}} {{UOM}} vs reorder point {{REORDER_POINT}} {{UOM}}. Please create a purchase request. Kind regards, {{COMPANY_NAME}}.'),
  ('LOW_STOCK','Low Stock','IN_APP','Critical stock: {{ITEM_NAME}}','{{ITEM_NAME}} ({{ITEM_CODE}}) is critically low with {{AVAILABLE_QTY}} {{UOM}} available against safety stock of {{SAFETY_STOCK}} {{UOM}}.'),
  ('LOW_STOCK','Low Stock','EMAIL','Critical Stock Alert - {{ITEM_NAME}}','Hello {{RECIPIENT_NAME}}, {{ITEM_NAME}} ({{ITEM_CODE}}) is critically low with {{AVAILABLE_QTY}} {{UOM}} available. Safety stock is {{SAFETY_STOCK}} {{UOM}}. Kind regards, {{COMPANY_NAME}}.'),
  ('MATERIAL_SHORTAGE','Material Shortage','IN_APP','Material shortage on {{ORDER_NO}}','{{MATERIAL_NAME}} is short for {{ORDER_NO}}: {{AVAILABLE_QTY}} {{UOM}} available vs {{REQUIRED_QTY}} {{UOM}} required.'),
  ('MATERIAL_SHORTAGE','Material Shortage','EMAIL','Material Shortage - {{ORDER_NO}}','Hello {{RECIPIENT_NAME}}, production order {{ORDER_NO}} requires {{REQUIRED_QTY}} {{UOM}} of {{MATERIAL_NAME}} but only {{AVAILABLE_QTY}} {{UOM}} is available. Kind regards, {{COMPANY_NAME}}.'),
  ('PRODUCTION_ORDER_RELEASED','Production Order Released','IN_APP','{{ORDER_NO}} released','Production Order {{ORDER_NO}} for {{PRODUCT_NAME}} ({{QUANTITY}} {{UOM}}) has been released.'),
  ('PRODUCTION_ORDER_RELEASED','Production Order Released','EMAIL','Production Order {{ORDER_NO}} Released','Hello {{RECIPIENT_NAME}}, Production Order {{ORDER_NO}} for {{PRODUCT_NAME}} ({{QUANTITY}} {{UOM}}) has been released for production. Kind regards, {{COMPANY_NAME}}.'),
  ('PRODUCTION_COMPLETED','Production Completed','IN_APP','{{ORDER_NO}} completed','Production Order {{ORDER_NO}} completed with {{GOOD_QTY}} {{UOM}} good output and {{WASTE_QTY}} {{UOM}} waste.'),
  ('PRODUCTION_COMPLETED','Production Completed','EMAIL','Production Order {{ORDER_NO}} Completed','Hello {{RECIPIENT_NAME}}, Production Order {{ORDER_NO}} has been completed with {{GOOD_QTY}} {{UOM}} good output. Kind regards, {{COMPANY_NAME}}.'),
  ('PRODUCTION_DELAYED','Production Delayed','IN_APP','{{ORDER_NO}} is behind schedule','Production Order {{ORDER_NO}} is behind schedule by {{DELAY_MINUTES}} minutes ({{PROGRESS_PERCENT}}% complete).'),
  ('PRODUCTION_DELAYED','Production Delayed','EMAIL','Production Delay - {{ORDER_NO}}','Hello {{RECIPIENT_NAME}}, Production Order {{ORDER_NO}} is behind schedule by {{DELAY_MINUTES}} minutes. Progress {{PROGRESS_PERCENT}}%. Kind regards, {{COMPANY_NAME}}.'),
  ('QUALITY_INSPECTION_REQUEST','Quality Inspection Request','IN_APP','Inspection required for {{BATCH_NO}}','Batch {{BATCH_NO}} ({{PRODUCT_NAME}}) is ready for {{INSPECTION_TYPE}} inspection.'),
  ('QUALITY_INSPECTION_REQUEST','Quality Inspection Request','EMAIL','Quality Inspection Required - {{BATCH_NO}}','Hello {{RECIPIENT_NAME}}, batch {{BATCH_NO}} for {{PRODUCT_NAME}} is ready for {{INSPECTION_TYPE}} inspection at {{INSPECTION_POINT}}. Kind regards, {{COMPANY_NAME}}.'),
  ('QUALITY_HOLD','Quality Hold','IN_APP','Batch {{BATCH_NO}} placed on hold','Batch {{BATCH_NO}} ({{PRODUCT_NAME}}) is on hold: {{REASON}}.'),
  ('QUALITY_HOLD','Quality Hold','EMAIL','Quality Hold - {{BATCH_NO}}','Hello {{RECIPIENT_NAME}}, batch {{BATCH_NO}} for {{PRODUCT_NAME}} has been placed on hold due to {{REASON}}. Quantity {{QUANTITY}} {{UOM}} is blocked. Kind regards, {{COMPANY_NAME}}.'),
  ('MACHINE_BREAKDOWN','Machine Breakdown','IN_APP','{{MACHINE_NAME}} breakdown','{{MACHINE_NAME}} ({{MACHINE_CODE}}) has a breakdown. Downtime {{DOWNTIME_MINUTES}} minutes.'),
  ('MACHINE_BREAKDOWN','Machine Breakdown','EMAIL','Machine Breakdown - {{MACHINE_NAME}}','Hello {{RECIPIENT_NAME}}, machine {{MACHINE_NAME}} ({{MACHINE_CODE}}) has reported a breakdown. Downtime so far {{DOWNTIME_MINUTES}} minutes. Kind regards, {{COMPANY_NAME}}.'),
  ('MAINTENANCE_DUE','Maintenance Due','IN_APP','Maintenance due for {{MACHINE_NAME}}','Scheduled maintenance for {{MACHINE_NAME}} ({{MACHINE_CODE}}) is due on {{DUE_DATE}}.'),
  ('MAINTENANCE_DUE','Maintenance Due','EMAIL','Maintenance Due - {{MACHINE_NAME}}','Hello {{RECIPIENT_NAME}}, scheduled maintenance for {{MACHINE_NAME}} ({{MACHINE_CODE}}) is due on {{DUE_DATE}}. Kind regards, {{COMPANY_NAME}}.'),
  ('WORK_ORDER_OVERDUE','Work Order Overdue','IN_APP','{{WORK_ORDER_NO}} is overdue','Work order {{WORK_ORDER_NO}} ({{PRODUCT_NAME}}) was due on {{DUE_DATE}} and is now overdue.'),
  ('WORK_ORDER_OVERDUE','Work Order Overdue','EMAIL','Work Order Overdue - {{WORK_ORDER_NO}}','Hello {{RECIPIENT_NAME}}, work order {{WORK_ORDER_NO}} for {{PRODUCT_NAME}} was due on {{DUE_DATE}} and is now overdue. Kind regards, {{COMPANY_NAME}}.'),
  ('CUSTODY_OVERDUE','Custody Overdue','IN_APP','Asset {{ASSET_NO}} custody overdue','{{ASSET_NAME}} ({{ASSET_NO}}) expected back on {{EXPECTED_RETURN_DATE}} is now overdue.'),
  ('CUSTODY_OVERDUE','Custody Overdue','EMAIL','Asset Custody Overdue - {{ASSET_NO}}','Hello {{RECIPIENT_NAME}}, asset {{ASSET_NO}} ({{ASSET_NAME}}) was expected back on {{EXPECTED_RETURN_DATE}} and is now overdue. Kind regards, {{COMPANY_NAME}}.'),
  ('PAYMENT_RECEIVED','Payment Received','IN_APP','Payment received - {{DOCUMENT_NUMBER}}','Payment of {{AMOUNT}} has been received for {{DOCUMENT_NUMBER}} on {{PAYMENT_DATE}}.'),
  ('PAYMENT_RECEIVED','Payment Received','EMAIL','Payment Received - {{DOCUMENT_NUMBER}}','Hello {{RECIPIENT_NAME}}, payment of {{AMOUNT}} has been received for {{DOCUMENT_NUMBER}} and posted on {{PAYMENT_DATE}}. Kind regards, {{COMPANY_NAME}}.'),
  ('DELIVERY_DISPATCHED','Delivery Dispatched','IN_APP','{{DOCUMENT_NUMBER}} dispatched','Delivery {{DOCUMENT_NUMBER}} has been dispatched and is expected on {{DELIVERY_DATE}}.'),
  ('DELIVERY_DISPATCHED','Delivery Dispatched','EMAIL','Delivery {{DOCUMENT_NUMBER}} Dispatched','Dear {{CUSTOMER_NAME}}, delivery {{DOCUMENT_NUMBER}} has been dispatched and is expected on {{DELIVERY_DATE}}. Kind regards, {{COMPANY_NAME}}.'),
  ('DOCUMENT_UPLOADED','Document Uploaded','IN_APP','Document uploaded to {{ENTITY_TYPE}}','{{DOCUMENT_NAME}} was uploaded to {{ENTITY_TYPE}} {{ENTITY_CODE}} by {{UPLOADED_BY}}.'),
  ('DOCUMENT_UPLOADED','Document Uploaded','EMAIL','New Document - {{DOCUMENT_NAME}}','Hello {{RECIPIENT_NAME}}, {{DOCUMENT_NAME}} was uploaded to {{ENTITY_TYPE}} {{ENTITY_CODE}} by {{UPLOADED_BY}}. Kind regards, {{COMPANY_NAME}}.')
) AS v(code, name, channel, subject, body)
WHERE t.code = 'HDG'
  AND NOT EXISTS (SELECT 1 FROM notification_templates nt WHERE nt.tenant_id = t.id AND nt.code = v.code AND nt.channel = v.channel);


-- ------------------------------------------------------------
-- 3. Cron job engine tables
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cron_jobs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  job_type TEXT NOT NULL,
  schedule_type TEXT NOT NULL DEFAULT 'DAILY'
    CHECK (schedule_type IN ('DAILY','WEEKLY','MONTHLY','INTERVAL','ONCE')),
  cron_expr TEXT,
  run_time TEXT,
  day_of_week SMALLINT CHECK (day_of_week IS NULL OR day_of_week BETWEEN 1 AND 7),
  day_of_month SMALLINT CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 31),
  interval_minutes INT CHECK (interval_minutes IS NULL OR interval_minutes > 0),
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  timezone TEXT NOT NULL DEFAULT 'Africa/Kampala',
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_status TEXT CHECK (last_status IS NULL OR last_status IN ('SUCCESS','FAILED')),
  last_error TEXT,
  last_run_duration_ms INT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cron_jobs_tenant_code_key UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS cron_job_runs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  job_id BIGINT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'SUCCESS' CHECK (status IN ('SUCCESS','FAILED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  duration_ms INT,
  error TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_due ON cron_jobs (next_run_at) WHERE enabled;
CREATE INDEX IF NOT EXISTS idx_cron_job_runs_job ON cron_job_runs (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_job_runs_tenant ON cron_job_runs (tenant_id, created_at DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['cron_jobs','cron_job_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'tenant_isolation') THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id())', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_set_updated_at' AND tgrelid = to_regclass(t)) THEN
      EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END IF;
  END LOOP;
END $$;


-- ------------------------------------------------------------
-- 4. Due-job queue reader
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_due_cron_jobs()
RETURNS TABLE (
  id BIGINT,
  tenant_id BIGINT,
  company_id BIGINT,
  branch_id BIGINT,
  code TEXT,
  name TEXT,
  job_type TEXT,
  schedule_type TEXT,
  run_time TEXT,
  day_of_week SMALLINT,
  day_of_month SMALLINT,
  interval_minutes INT,
  params JSONB,
  timezone TEXT,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id, tenant_id, company_id, branch_id, code, name, job_type, schedule_type,
         run_time, day_of_week, day_of_month, interval_minutes, params, timezone,
         next_run_at, last_run_at
    FROM cron_jobs
   WHERE enabled
     AND (next_run_at IS NULL OR next_run_at <= now())
   ORDER BY next_run_at NULLS FIRST
   LIMIT 50;
$$;


-- ------------------------------------------------------------
-- 5. Seed: HOPE DESIGN cron jobs
-- ------------------------------------------------------------
INSERT INTO cron_jobs (tenant_id, company_id, branch_id, code, name, description, job_type,
                       schedule_type, run_time, day_of_week, day_of_month, interval_minutes,
                       params, enabled, timezone, next_run_at)
SELECT t.id, c.id, NULL::bigint, v.code, v.name, v.description, v.job_type,
       v.schedule_type, v.run_time, v.day_of_week::smallint, v.day_of_month::smallint, v.interval_minutes::int,
       v.params::jsonb, true, v.timezone, now()
FROM tenants t
JOIN companies c ON c.tenant_id = t.id AND c.code = 'HDG'
CROSS JOIN (VALUES
  ('CRON-STOCK-REORDER','Stock Reorder Check','Daily check of items at or below their reorder point; notifies warehouse and procurement roles.','STOCK_REORDER_CHECK','DAILY','08:00',NULL,NULL,NULL,'{"window_days":7,"notify_roles":["warehouse_manager","storekeeper","procurement_manager"]}','Africa/Kampala'),
  ('CRON-CONTRACT-EXPIRY','Contract Expiry Check','Daily check of employment contracts expiring within the configured window; notifies HR roles.','CONTRACT_EXPIRY_CHECK','DAILY','07:00',NULL,NULL,NULL,'{"window_days":30,"notify_roles":["hr_manager","hr_officer"]}','Africa/Kampala'),
  ('CRON-ASSET-MAINT','Asset Maintenance Due Check','Daily check of assets with maintenance due within the configured window; notifies maintenance roles.','ASSET_MAINTENANCE_CHECK','DAILY','07:30',NULL,NULL,NULL,'{"window_days":14,"notify_roles":["maintenance_manager","warehouse_manager"]}','Africa/Kampala'),
  ('CRON-ASSET-INSPECT','Asset Inspection Due Check','Daily check of assets with inspections due within the configured window; notifies maintenance roles.','ASSET_INSPECTION_CHECK','DAILY','08:30',NULL,NULL,NULL,'{"window_days":14,"notify_roles":["maintenance_manager"]}','Africa/Kampala'),
  ('CRON-CUSTODY-OVERDUE','Asset Custody Overdue Check','Daily check of assets with custody past their expected return date; notifies warehouse and maintenance roles.','CUSTODY_OVERDUE_CHECK','DAILY','09:00',NULL,NULL,NULL,'{"notify_roles":["warehouse_manager","maintenance_manager"]}','Africa/Kampala'),
  ('CRON-WO-OVERDUE','Work Order Overdue Check','Daily check of work orders past their due date; notifies production roles.','WORK_ORDER_OVERDUE_CHECK','DAILY','10:00',NULL,NULL,NULL,'{"notify_roles":["production_manager","production_supervisor"]}','Africa/Kampala'),
  ('CRON-APPROVAL-ESCALATION','Approval Escalation','Every 30 minutes, escalates approval tasks pending beyond the grace period; notifies senior management.','APPROVAL_ESCALATION','INTERVAL',NULL,NULL,NULL,30,'{"grace_hours":24,"notify_roles":["general_manager","managing_director"]}','Africa/Kampala')
) AS v(code, name, description, job_type, schedule_type, run_time, day_of_week, day_of_month,
       interval_minutes, params, timezone)
WHERE NOT EXISTS (SELECT 1 FROM cron_jobs j WHERE j.tenant_id = t.id AND j.code = v.code);


-- ------------------------------------------------------------
-- 6. Permissions (module: system / cron)
-- ------------------------------------------------------------
INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, 'system', v.resource, v.action, v.description
FROM (VALUES
  ('system.cron.view','cron','view','View cron jobs and run history'),
  ('system.cron.manage','cron','manage','Create, edit, toggle and manually run cron jobs')
) AS v(code, resource, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code LIKE 'system.cron.%'
WHERE r.code IN (
  'super_administrator','system_administrator','managing_director','executive_director',
  'general_manager','operations_director','production_director'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;
