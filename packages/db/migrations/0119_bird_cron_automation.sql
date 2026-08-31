-- ============================================================================
-- 0119 - Bird provider automation + extended cron jobs
--  * Notification templates for QC pending, stale work orders, dead stock,
--    document expiry, payment due, quarantine aging, password expiry
--  * Cron job seeding for the new automated checks + email queue flush
-- Idempotent: safe on fresh + existing DB.
-- ============================================================================

-- ------------------------------------------------------------
-- 1. Seed: notification templates (IN_APP + EMAIL variants)
-- ------------------------------------------------------------
INSERT INTO notification_templates (tenant_id, code, name, channel, subject, body, is_active)
SELECT t.id, v.code, v.name, v.channel, v.subject, v.body, true
FROM tenants t
CROSS JOIN (VALUES
  ('QUALITY_INSPECTION_PENDING','QC Inspection Pending','IN_APP','QC inspection pending: {{BATCH_NO}}','Inspection {{INSPECTION_NO}} ({{KIND}}) for {{PRODUCT_NAME}} has been submitted and is awaiting QC review.'),
  ('QUALITY_INSPECTION_PENDING','QC Inspection Pending','EMAIL','QC Inspection Pending - {{INSPECTION_NO}}','Hello {{RECIPIENT_NAME}}, inspection {{INSPECTION_NO}} ({{KIND}}) for {{PRODUCT_NAME}} (batch {{BATCH_NO}}) is awaiting QC review. Kind regards, {{COMPANY_NAME}}.'),
  ('WORK_ORDER_STALE','Work Order No Recent Activity','IN_APP','{{WORK_ORDER_NO}} has no recent activity','Work order {{WORK_ORDER_NO}} ({{PRODUCT_NAME}}) has not been updated for {{STALE_HOURS}} hours. Please review.'),
  ('WORK_ORDER_STALE','Work Order No Recent Activity','EMAIL','Work Order Inactive - {{WORK_ORDER_NO}}','Hello {{RECIPIENT_NAME}}, work order {{WORK_ORDER_NO}} for {{PRODUCT_NAME}} has not been updated for {{STALE_HOURS}} hours. Please review. Kind regards, {{COMPANY_NAME}}.'),
  ('INVENTORY_DEAD_STOCK','Dead Stock Detected','IN_APP','Dead stock: {{ITEM_NAME}}','{{ITEM_NAME}} ({{ITEM_CODE}}) has {{ON_HAND}} on hand with no movement for {{DAYS}} days.'),
  ('INVENTORY_DEAD_STOCK','Dead Stock Detected','EMAIL','Dead Stock - {{ITEM_NAME}}','Hello {{RECIPIENT_NAME}}, {{ITEM_NAME}} ({{ITEM_CODE}}) has {{ON_HAND}} on hand with no movement for {{DAYS}} days. Kind regards, {{COMPANY_NAME}}.'),
  ('DOCUMENT_EXPIRY','Document Expiry','IN_APP','{{TITLE}} expires soon','Document {{DOC_NO}} ({{TITLE}}) expires on {{EXPIRES_AT}}.'),
  ('DOCUMENT_EXPIRY','Document Expiry','EMAIL','Document Expiry - {{DOC_NO}}','Hello {{RECIPIENT_NAME}}, document {{DOC_NO}} ({{TITLE}}) expires on {{EXPIRES_AT}}. Kind regards, {{COMPANY_NAME}}.'),
  ('PAYMENT_DUE','Payment Due Reminder','IN_APP','Payment {{PAY_NO}} is due','Approved payment {{PAY_NO}} to {{PAYEE}} ({{AMOUNT}} {{CURRENCY}}) has not been paid within {{DAYS}} days.'),
  ('PAYMENT_DUE','Payment Due Reminder','EMAIL','Payment Due - {{PAY_NO}}','Hello {{RECIPIENT_NAME}}, approved payment {{PAY_NO}} to {{PAYEE}} of {{AMOUNT}} {{CURRENCY}} has not been paid within {{DAYS}} days. Kind regards, {{COMPANY_NAME}}.'),
  ('QUARANTINE_AGING','Quarantine Aging','IN_APP','Quarantine aging: {{PRODUCT_NAME}}','{{PRODUCT_NAME}} ({{QUANTITY}}) has been in quarantine for {{DAYS}} days. Reason: {{REASON}}.'),
  ('QUARANTINE_AGING','Quarantine Aging','EMAIL','Quarantine Aging - {{PRODUCT_NAME}}','Hello {{RECIPIENT_NAME}}, {{PRODUCT_NAME}} ({{QUANTITY}}) has been in quarantine for {{DAYS}} days. Reason: {{REASON}}. Kind regards, {{COMPANY_NAME}}.'),
  ('PASSWORD_EXPIRY','Password Change Required','IN_APP','Password change required for {{EMAIL}}','User {{DISPLAY_NAME}} ({{EMAIL}}) requires a password change ({{DAYS}} days since last change).'),
  ('PASSWORD_EXPIRY','Password Change Required','EMAIL','Password Change Required - {{EMAIL}}','Hello {{RECIPIENT_NAME}}, user {{DISPLAY_NAME}} ({{EMAIL}}) requires a password change ({{DAYS}} days since last change). Kind regards, {{COMPANY_NAME}}.')
) AS v(code, name, channel, subject, body)
WHERE t.code = 'HDG'
  AND NOT EXISTS (SELECT 1 FROM notification_templates nt WHERE nt.tenant_id = t.id AND nt.code = v.code AND nt.channel = v.channel);

-- ------------------------------------------------------------
-- 2. Seed: extended HOPE DESIGN cron jobs
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
  ('CRON-QUALITY-PENDING','QC Pending Check','Flags inspections submitted but pending QC review beyond the grace window; notifies quality roles.','QUALITY_QC_PENDING_CHECK','INTERVAL',NULL,NULL,NULL,15,'{"grace_hours":4,"notify_roles":["quality_inspector","quality_manager"]}','Africa/Kampala'),
  ('CRON-WO-STALE','Work Order Stale Check','Flags approved/released/in-progress work orders with no recent activity; notifies production roles.','PRODUCTION_ORDER_STALE_CHECK','INTERVAL',NULL,NULL,NULL,60,'{"stale_hours":12,"notify_roles":["production_manager","production_supervisor"]}','Africa/Kampala'),
  ('CRON-DEAD-STOCK','Dead Stock Check','Daily check of active items with on-hand stock and no movement beyond the window; notifies warehouse roles.','INVENTORY_DEAD_STOCK_CHECK','DAILY','07:00',NULL,NULL,NULL,'{"days":90,"notify_roles":["warehouse_manager","storekeeper"]}','Africa/Kampala'),
  ('CRON-DOC-EXPIRY','Document Expiry Check','Daily check of approved documents expiring within the window; notifies administrators.','DOCUMENT_EXPIRY_CHECK','DAILY','06:00',NULL,NULL,NULL,'{"window_days":30,"notify_roles":["super_administrator"]}','Africa/Kampala'),
  ('CRON-PAYMENT-DUE','Payment Due Reminder','Daily reminder for approved payments unpaid beyond the window; notifies finance roles.','PAYMENT_DUE_REMINDER','DAILY','09:00',NULL,NULL,NULL,'{"days":2,"notify_roles":["finance_manager","chief_accountant","treasury_officer"]}','Africa/Kampala'),
  ('CRON-QUARANTINE-AGING','Quarantine Aging Check','Daily check of quarantine records older than the window; notifies warehouse and quality roles.','QUARANTINE_AGING_CHECK','DAILY','10:30',NULL,NULL,NULL,'{"days":7,"notify_roles":["warehouse_manager","quality_manager","quality_inspector"]}','Africa/Kampala'),
  ('CRON-PWD-EXPIRY','Password Expiry Check','Daily check of active users due for a password change; notifies system administrators.','PASSWORD_EXPIRY_CHECK','DAILY','05:00',NULL,NULL,NULL,'{"days":90,"notify_roles":["system_administrator","super_administrator"]}','Africa/Kampala'),
  ('CRON-EMAIL-FLUSH','Email Queue Flush','Every 5 minutes, sends QUEUED emails whose scheduled time has arrived via the configured provider.','EMAIL_QUEUE_FLUSH','INTERVAL',NULL,NULL,NULL,5,'{}','Africa/Kampala')
) AS v(code, name, description, job_type, schedule_type, run_time, day_of_week, day_of_month,
       interval_minutes, params, timezone)
WHERE NOT EXISTS (SELECT 1 FROM cron_jobs j WHERE j.tenant_id = t.id AND j.code = v.code);