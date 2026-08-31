-- ============================================================================
-- 0120 - Notification rules engine + personal preferences
--  * notification_preferences: per-user channel + digest settings per event type
--  * Row level security + updated_at trigger for the new table
--  * Extended notification rule seeds for HOPE DESIGN
-- Idempotent: safe on fresh + existing DB.
-- ============================================================================

-- ------------------------------------------------------------
-- 1. Personal notification preferences
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_preferences (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  in_app BOOLEAN NOT NULL DEFAULT true,
  email BOOLEAN NOT NULL DEFAULT true,
  push BOOLEAN NOT NULL DEFAULT true,
  sms BOOLEAN NOT NULL DEFAULT false,
  whatsapp BOOLEAN NOT NULL DEFAULT false,
  digest TEXT NOT NULL DEFAULT 'INSTANT'
    CHECK (digest IN ('INSTANT','15_MIN','HOURLY','DAILY','WEEKLY')),
  critical_bypass BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_notification_preferences_user
  ON notification_preferences(tenant_id, user_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification_preferences'] LOOP
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
-- 2. Seed: extended notification rules for HOPE DESIGN
-- ------------------------------------------------------------
INSERT INTO notification_rules (tenant_id, company_id, name, event_type, conditions, channels, role_codes, user_ids, is_active)
SELECT t.id, c.id, v.name, v.event_type, v.conditions::jsonb, v.channels::jsonb, v.role_codes::jsonb, '[]'::jsonb, true
FROM tenants t
JOIN companies c ON c.tenant_id = t.id AND c.code = 'HDG'
CROSS JOIN (VALUES
  ('Contract Expiry','CONTRACT_EXPIRY','{"window_days":30}','["IN_APP","EMAIL"]','["hr_manager","system_administrator","super_administrator"]'),
  ('Production Delayed','PRODUCTION_DELAYED','{"entity_type":"production_order"}','["IN_APP","EMAIL"]','["production_manager","production_supervisor"]'),
  ('Delivery Dispatched','DELIVERY_DISPATCHED','{"entity_type":"delivery"}','["IN_APP"]','["logistics_manager","warehouse_manager"]'),
  ('Payment Received','PAYMENT_RECEIVED','{"entity_type":"payment"}','["IN_APP"]','["finance_manager","accountant"]'),
  ('Document Uploaded','DOCUMENT_UPLOADED','{}','["IN_APP"]','[]'),
  ('Material Shortage','MATERIAL_SHORTAGE','{}','["IN_APP","EMAIL"]','["production_manager","procurement_manager","warehouse_manager"]'),
  ('Maintenance Due','MAINTENANCE_DUE','{}','["IN_APP","EMAIL"]','["maintenance_manager","maintenance_engineer"]'),
  ('Work Order Overdue','WORK_ORDER_OVERDUE','{}','["IN_APP","EMAIL"]','["production_manager","maintenance_manager"]'),
  ('Quality Rejected','QUALITY_REJECTED','{"entity_type":"batch"}','["IN_APP","EMAIL"]','["quality_manager","quality_inspector","production_manager"]'),
  ('Stock Reorder','STOCK_REORDER','{}','["IN_APP"]','["procurement_manager","warehouse_manager","storekeeper"]')
) AS v(name, event_type, conditions, channels, role_codes)
WHERE t.code = 'HDG'
  AND NOT EXISTS (SELECT 1 FROM notification_rules nr WHERE nr.tenant_id = t.id AND nr.name = v.name);