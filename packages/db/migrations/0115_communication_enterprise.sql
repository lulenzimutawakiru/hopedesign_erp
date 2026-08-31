-- ============================================================================
-- 0115 - Enterprise communication: email, messaging, instant notifications
-- Unified communication layer for HOPE DESIGN ERP.
-- Idempotent: safe on fresh + existing DB.
-- ============================================================================

-- ------------------------------------------------------------
-- 1. Upgrade notifications with priority + channel + actions
-- ------------------------------------------------------------
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'NORMAL'
    CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT','CRITICAL')),
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'IN_APP'
    CHECK (channel IN ('IN_APP','EMAIL','SMS','PUSH','WHATSAPP')),
  ADD COLUMN IF NOT EXISTS action_label TEXT,
  ADD COLUMN IF NOT EXISTS action_target TEXT,
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_notifications_priority ON notifications(user_id, priority, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(tenant_id, type, created_at);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'notifications' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON notifications USING (tenant_id = app_tenant_id());
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. Communication channels + membership
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS communication_channels (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'DEPT' CHECK (kind IN ('DEPT','PROJECT','GROUP','ANNOUNCEMENT')),
  description TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS channel_members (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  channel_id BIGINT NOT NULL REFERENCES communication_channels(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('MEMBER','MODERATOR','OWNER')),
  muted BOOLEAN NOT NULL DEFAULT false,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members(user_id);

-- ------------------------------------------------------------
-- 3. Conversations + members + messages (internal messaging)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  kind TEXT NOT NULL DEFAULT 'DIRECT' CHECK (kind IN ('DIRECT','GROUP','CHANNEL','RECORD')),
  title TEXT,
  entity_type TEXT,
  entity_id BIGINT,
  channel_id BIGINT REFERENCES communication_channels(id) ON DELETE SET NULL,
  created_by BIGINT REFERENCES users(id),
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_member ON conversations(id);

CREATE TABLE IF NOT EXISTS conversation_members (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('MEMBER','MODERATOR','OWNER')),
  muted BOOLEAN NOT NULL DEFAULT false,
  pinned BOOLEAN NOT NULL DEFAULT false,
  last_read_at TIMESTAMPTZ,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members(user_id, last_read_at);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'TEXT' CHECK (message_type IN ('TEXT','SYSTEM','IMAGE','FILE','LINK')),
  reply_to BIGINT REFERENCES conversation_messages(id),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conv_messages_conv ON conversation_messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS message_attachments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  message_id BIGINT NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_type TEXT,
  file_size BIGINT,
  storage_path TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message_reactions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  message_id BIGINT NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id, reaction)
);

CREATE TABLE IF NOT EXISTS message_mentions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  message_id BIGINT NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS message_reads (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  message_id BIGINT NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_msg_reads_user ON message_reads(user_id, read_at);
-- ------------------------------------------------------------
-- 4. Email centre: templates, threads, emails, recipients, attachments
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_templates (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'GENERAL'
    CHECK (category IN ('SALES','FINANCE','PROCUREMENT','LOGISTICS','HR','SYSTEM','GENERAL')),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  variables JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS email_threads (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  subject TEXT,
  entity_type TEXT,
  entity_id BIGINT,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS emails (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  thread_id BIGINT REFERENCES email_threads(id) ON DELETE SET NULL,
  direction TEXT NOT NULL DEFAULT 'OUT' CHECK (direction IN ('IN','OUT')),
  subject TEXT NOT NULL,
  body TEXT,
  "to" JSONB NOT NULL DEFAULT '[]'::jsonb,
  cc JSONB NOT NULL DEFAULT '[]'::jsonb,
  bcc JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SCHEDULED','QUEUED','SENT','FAILED')),
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  entity_type TEXT,
  entity_id BIGINT,
  template_code TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_emails_tenant ON emails(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_emails_entity ON emails(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS email_recipients (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  email_id BIGINT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'TO' CHECK (kind IN ('TO','CC','BCC')),
  email TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','SENT','DELIVERED','READ','FAILED','BOUNCED')),
  provider_message_id TEXT,
  error TEXT,
  sent_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_attachments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  email_id BIGINT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_type TEXT,
  file_size BIGINT,
  storage_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 5. Notification engine: rules + deliveries
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_rules (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
  channels JSONB NOT NULL DEFAULT '["IN_APP"]'::jsonb,
  role_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  notification_id BIGINT REFERENCES notifications(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'IN_APP'
    CHECK (channel IN ('IN_APP','EMAIL','SMS','PUSH','WHATSAPP')),
  recipient TEXT,
  status TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','SENT','DELIVERED','READ','FAILED','BOUNCED','RETRYING','CANCELLED')),
  provider TEXT,
  provider_message_id TEXT,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_deliveries_user ON notification_deliveries(user_id, status);

-- ------------------------------------------------------------
-- 6. Announcements
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS announcements (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'GENERAL'
    CHECK (category IN ('GENERAL','EMERGENCY','DEPARTMENT','BRANCH','SYSTEM')),
  priority TEXT NOT NULL DEFAULT 'NORMAL'
    CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT','CRITICAL')),
  audience JSONB NOT NULL DEFAULT '{}'::jsonb,
  requires_ack BOOLEAN NOT NULL DEFAULT false,
  published_by BIGINT REFERENCES users(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS announcement_recipients (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  announcement_id BIGINT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (announcement_id, user_id)
);

CREATE TABLE IF NOT EXISTS announcement_reads (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  announcement_id BIGINT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  UNIQUE (announcement_id, user_id)
);

-- ------------------------------------------------------------
-- 7. Events, audit, push, SMS, WhatsApp
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS communication_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id BIGINT,
  actor_id BIGINT REFERENCES users(id),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comm_events_type ON communication_events(tenant_id, event_type, created_at);

CREATE TABLE IF NOT EXISTS communication_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  user_id BIGINT REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id BIGINT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comm_audit_tenant ON communication_audit_logs(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT UNIQUE NOT NULL,
  keys JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sms_messages (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT REFERENCES users(id),
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,
  provider TEXT,
  status TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','SENT','DELIVERED','FAILED','RETRYING','CANCELLED')),
  provider_message_id TEXT,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT REFERENCES users(id),
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,
  provider TEXT,
  status TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','SENT','DELIVERED','READ','FAILED','RETRYING','CANCELLED')),
  provider_message_id TEXT,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 8. Communication settings (digest, retry, escalation, smtp)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS communication_settings (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  category TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, category, key)
);

-- ------------------------------------------------------------
-- 9. RLS + updated_at triggers for new tables
-- ------------------------------------------------------------
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'communication_channels','channel_members','conversations','conversation_members',
    'conversation_messages','message_attachments','message_reactions','message_mentions',
    'message_reads','email_templates','email_threads','emails','email_recipients',
    'email_attachments','notification_rules','notification_deliveries','announcements',
    'announcement_recipients','announcement_reads','communication_events',
    'communication_audit_logs','push_subscriptions','sms_messages','whatsapp_messages',
    'communication_settings'
  ] LOOP
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
-- 10. Permissions (module: communication)
-- ------------------------------------------------------------
INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, 'communication', v.resource, v.action, v.description
FROM (VALUES
  ('communication.command.view','command','view','View the communication command centre'),
  ('communication.messages.view','messages','view','View conversations and messages'),
  ('communication.messages.send','messages','send','Send internal messages and replies'),
  ('communication.messages.manage','messages','manage','Manage conversations, channels and members'),
  ('communication.notifications.view','notifications','view','View notifications'),
  ('communication.notifications.read','notifications','read','Mark notifications as read or acknowledged'),
  ('communication.notifications.manage','notifications','manage','Manage notification rules and preferences'),
  ('communication.emails.view','emails','view','View the email centre'),
  ('communication.emails.send','emails','send','Compose and send emails'),
  ('communication.emails.manage','emails','manage','Manage email templates and threads'),
  ('communication.announcements.view','announcements','view','View announcements'),
  ('communication.announcements.create','announcements','create','Publish announcements'),
  ('communication.announcements.manage','announcements','manage','Manage announcements'),
  ('communication.templates.view','templates','view','View communication templates'),
  ('communication.templates.manage','templates','manage','Manage communication templates'),
  ('communication.delivery_logs.view','delivery_logs','view','View delivery logs'),
  ('communication.settings.manage','settings','manage','Configure communication settings')
) AS v(code, resource, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code LIKE 'communication.%'
WHERE r.code IN (
  'super_administrator','system_administrator','managing_director','executive_director',
  'general_manager','operations_director','production_director','production_manager',
  'production_planner','production_scheduler','production_supervisor','quality_manager',
  'quality_inspector','warehouse_manager','storekeeper','cfo','finance_manager',
  'chief_accountant','hr_manager','procurement_manager','maintenance_manager',
  'logistics_manager','sales_manager','commercial_director','internal_auditor'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ------------------------------------------------------------
-- 11. Seed: department channels + membership (HDG tenant)
-- ------------------------------------------------------------
INSERT INTO communication_channels (tenant_id, company_id, branch_id, code, name, kind, description, is_default, created_by)
SELECT t.id, c.id, b.id, v.code, v.name, 'DEPT', v.description, v.is_default,
       (SELECT u.id FROM users u WHERE u.tenant_id = t.id AND u.username = 'admin' LIMIT 1)
FROM tenants t
JOIN companies c ON c.tenant_id = t.id AND c.code = 'HDG'
JOIN branches b ON b.company_id = c.id AND b.code = 'KAMPALA-HQ'
CROSS JOIN (VALUES
  ('CH-MANAGEMENT','#management','Executive and management communications', true),
  ('CH-PRODUCTION','#production','Production, shop floor and manufacturing', false),
  ('CH-WAREHOUSE','#warehouse','Warehouse, inventory and material handling', false),
  ('CH-QUALITY','#quality','Quality control and inspections', false),
  ('CH-FINANCE','#finance','Finance and accounting', false),
  ('CH-HR','#hr','Human resources and administration', false),
  ('CH-MAINTENANCE','#maintenance','Maintenance and engineering', false),
  ('CH-LOGISTICS','#logistics','Logistics and deliveries', false),
  ('CH-SALES','#sales','Sales and customer management', false),
  ('CH-PROCUREMENT','#procurement','Procurement and supply chain', false),
  ('CH-SECURITY-PRINTING','#security-printing','Security printing and QR jobs', false),
  ('CH-ICT','#ict','ICT and system support', false)
) AS v(code, name, description, is_default)
WHERE t.code = 'HDG'
  AND NOT EXISTS (SELECT 1 FROM communication_channels ch WHERE ch.tenant_id = t.id AND ch.code = v.code);

INSERT INTO channel_members (tenant_id, channel_id, user_id, role)
SELECT ch.tenant_id, ch.id, u.id, CASE WHEN u.username = 'admin' THEN 'OWNER' ELSE 'MEMBER' END
FROM communication_channels ch
JOIN users u ON u.tenant_id = ch.tenant_id AND u.status = 'ACTIVE'
WHERE ch.tenant_id = (SELECT id FROM tenants WHERE code = 'HDG')
  AND ch.kind = 'DEPT'
  AND NOT EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = ch.id AND cm.user_id = u.id);

-- ------------------------------------------------------------
-- 12. Seed: production channel conversation + messages
-- ------------------------------------------------------------
INSERT INTO conversations (tenant_id, company_id, branch_id, kind, title, channel_id, created_by, last_message_at)
SELECT t.id, c.id, b.id, 'CHANNEL', '#production', ch.id,
       (SELECT u.id FROM users u WHERE u.tenant_id = t.id AND u.username = 'admin' LIMIT 1), now()
FROM tenants t
JOIN companies c ON c.tenant_id = t.id AND c.code = 'HDG'
JOIN branches b ON b.company_id = c.id AND b.code = 'KAMPALA-HQ'
JOIN communication_channels ch ON ch.tenant_id = t.id AND ch.code = 'CH-PRODUCTION'
WHERE t.code = 'HDG'
  AND NOT EXISTS (SELECT 1 FROM conversations cv WHERE cv.tenant_id = t.id AND cv.title = '#production');

INSERT INTO conversation_members (tenant_id, conversation_id, user_id, role)
SELECT cv.tenant_id, cv.id, u.id,
       CASE WHEN u.username = 'admin' THEN 'OWNER'
            WHEN u.username = 'peter.prod' THEN 'MODERATOR'
            ELSE 'MEMBER' END
FROM conversations cv
JOIN users u ON u.tenant_id = cv.tenant_id AND u.status = 'ACTIVE'
WHERE cv.title = '#production'
  AND u.username IN ('admin','peter.prod','qiana.qc','willy.wh')
  AND NOT EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = cv.id AND cm.user_id = u.id);

INSERT INTO conversation_messages (tenant_id, conversation_id, sender_id, body, message_type, created_at)
SELECT t.id, cv.id, u.id, v.body, 'TEXT', now() - v.ago
FROM tenants t
CROSS JOIN (VALUES
  ('peter.prod', 'Production Order MO-2026-0045 is running on SCA4-1100. Target 10,000 reams.', interval '3 hours'),
  ('qiana.qc', 'Copy that. I will run the QC sampling plan when the first batch is out.', interval '2 hours 45 minutes'),
  ('admin', 'Great. Keep the waste logs updated - we are tracking variance closely this week.', interval '2 hours 30 minutes'),
  ('peter.prod', 'Output is at 7,650 reams, quality checks passing. On track.', interval '1 hour'),
  ('qiana.qc', 'Batch BATCH-2026-0045 passed sheet count and dimensions. Final inspection pending.', interval '30 minutes')
) AS v(sender, body, ago)
JOIN conversations cv ON cv.tenant_id = t.id AND cv.title = '#production'
JOIN users u ON u.tenant_id = t.id AND u.username = v.sender
WHERE t.code = 'HDG'
  AND NOT EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = cv.id AND m.body = v.body);

-- ------------------------------------------------------------
-- 13. Seed: direct conversation admin <-> peter.prod
-- ------------------------------------------------------------
INSERT INTO conversations (tenant_id, company_id, branch_id, kind, title, created_by, last_message_at)
SELECT t.id, c.id, b.id, 'DIRECT', 'Admin / Peter (Production)',
       (SELECT u.id FROM users u WHERE u.tenant_id = t.id AND u.username = 'admin' LIMIT 1), now()
FROM tenants t
JOIN companies c ON c.tenant_id = t.id AND c.code = 'HDG'
JOIN branches b ON b.company_id = c.id AND b.code = 'KAMPALA-HQ'
WHERE t.code = 'HDG'
  AND NOT EXISTS (SELECT 1 FROM conversations cv WHERE cv.tenant_id = t.id AND cv.kind = 'DIRECT' AND cv.title = 'Admin / Peter (Production)');

INSERT INTO conversation_members (tenant_id, conversation_id, user_id, role)
SELECT cv.tenant_id, cv.id, u.id, 'MEMBER'
FROM conversations cv
JOIN users u ON u.tenant_id = cv.tenant_id
WHERE cv.title = 'Admin / Peter (Production)'
  AND u.username IN ('admin','peter.prod')
  AND NOT EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = cv.id AND cm.user_id = u.id);

INSERT INTO conversation_messages (tenant_id, conversation_id, sender_id, body, message_type, created_at)
SELECT t.id, cv.id, u.id, v.body, 'TEXT', now() - v.ago
FROM tenants t
CROSS JOIN (VALUES
  ('admin', 'Peter, please confirm the SCA4-1100 setup time for tomorrow morning.', interval '5 hours'),
  ('peter.prod', 'Setup takes about 40 minutes. I will start at 07:30 so we hit the 08:15 first cut.', interval '4 hours'),
  ('admin', 'Perfect. I have released the material reservation for the jumbo rolls.', interval '3 hours 50 minutes')
) AS v(sender, body, ago)
JOIN conversations cv ON cv.tenant_id = t.id AND cv.title = 'Admin / Peter (Production)'
JOIN users u ON u.tenant_id = t.id AND u.username = v.sender
WHERE t.code = 'HDG'
  AND NOT EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = cv.id AND m.body = v.body);

UPDATE conversations cv
SET last_message_at = (SELECT MAX(m.created_at) FROM conversation_messages m WHERE m.conversation_id = cv.id)
WHERE cv.tenant_id = (SELECT id FROM tenants WHERE code = 'HDG')
  AND cv.last_message_at IS DISTINCT FROM (SELECT MAX(m2.created_at) FROM conversation_messages m2 WHERE m2.conversation_id = cv.id);

-- ------------------------------------------------------------
-- 14. Seed: notifications + deliveries for admin (HDG)
-- ------------------------------------------------------------
INSERT INTO notifications (company_id, tenant_id, user_id, type, title, body, link, severity, action_required, priority, channel, action_label, action_target, data, created_at)
SELECT c.id, t.id, u.id, v.type, v.title, v.body, v.link, v.severity, v.action_required, v.priority, 'IN_APP', v.action_label, v.action_target, '{}'::jsonb, now() - v.ago
FROM tenants t
JOIN companies c ON c.tenant_id = t.id AND c.code = 'HDG'
CROSS JOIN (VALUES
  ('MACHINE_DOWN', 'Machine SCA4-1100 Down', 'SCA4-1100 reported a breakdown 32 minutes ago on the morning shift.', '/shop-floor/machines/1', 'ERROR', true, 'CRITICAL', 'View Machine', '/shop-floor/machines/1', interval '32 minutes'),
  ('PRODUCTION_DELAYED', 'Production Order Delayed', 'Production Order MO-2026-0045 is running 45 minutes behind schedule.', '/production/orders/452', 'WARN', true, 'URGENT', 'View Order', '/production/orders/452', interval '2 hours'),
  ('LOW_STOCK', 'Raw Material Running Low', '880mm Jumbo Paper is below reorder level. 4 MT remaining.', '/inventory/stock', 'WARN', true, 'HIGH', 'Review Stock', '/inventory/stock', interval '3 hours'),
  ('QUALITY_PENDING', 'QC Inspection Pending', 'Batch BATCH-2026-0045 is waiting for final inspection.', '/quality/inspections', 'INFO', false, 'NORMAL', 'Open Inspection', '/quality/inspections', interval '5 hours'),
  ('APPROVAL_REQUIRED', 'Requisition Requires Approval', 'Requisition HDG-REQ-2026-00125 requires your approval.', '/expenditure/requisitions', 'WARN', true, 'NORMAL', 'Approve', '/expenditure/requisitions', interval '8 hours'),
  ('PAYROLL_PROCESSED', 'Payroll Processed', 'The August payroll has been processed and approved.', '/hr/payroll', 'SUCCESS', false, 'LOW', 'View Payslips', '/hr/payroll', interval '1 day')
) AS v(type, title, body, link, severity, action_required, priority, action_label, action_target, ago)
JOIN users u ON u.tenant_id = t.id AND u.username = 'admin'
WHERE t.code = 'HDG'
  AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.tenant_id = t.id AND n.user_id = u.id AND n.type = v.type);

INSERT INTO notification_deliveries (tenant_id, notification_id, user_id, channel, recipient, status, provider, sent_at, created_at)
SELECT n.tenant_id, n.id, n.user_id, 'IN_APP', u.email, 'DELIVERED', 'in_app', n.created_at, n.created_at
FROM notifications n
JOIN users u ON u.id = n.user_id
WHERE n.tenant_id = (SELECT id FROM tenants WHERE code = 'HDG')
  AND u.username = 'admin'
  AND NOT EXISTS (SELECT 1 FROM notification_deliveries nd WHERE nd.notification_id = n.id);

-- ------------------------------------------------------------
-- 15. Seed: announcements + recipients
-- ------------------------------------------------------------
INSERT INTO announcements (tenant_id, company_id, branch_id, title, body, category, priority, audience, requires_ack, published_by, published_at)
SELECT t.id, c.id, b.id, v.title, v.body, 'GENERAL', v.priority, '{"scope":"company"}'::jsonb, false,
       (SELECT u.id FROM users u WHERE u.tenant_id = t.id AND u.username = 'admin' LIMIT 1), now() - v.ago
FROM tenants t
JOIN companies c ON c.tenant_id = t.id AND c.code = 'HDG'
JOIN branches b ON b.company_id = c.id AND b.code = 'KAMPALA-HQ'
CROSS JOIN (VALUES
  ('Scheduled Factory Maintenance', 'The production facility will undergo scheduled maintenance on Saturday. All production orders should be planned accordingly.', 'HIGH', interval '6 hours'),
  ('New NATEX A4 Production Line', 'HOPE DESIGN has commissioned a new NATEX A4 production line. Operator training sessions start Monday morning.', 'NORMAL', interval '1 day')
) AS v(title, body, priority, ago)
WHERE t.code = 'HDG'
  AND NOT EXISTS (SELECT 1 FROM announcements a WHERE a.tenant_id = t.id AND a.title = v.title);

INSERT INTO announcement_recipients (tenant_id, announcement_id, user_id)
SELECT a.tenant_id, a.id, u.id
FROM announcements a
JOIN users u ON u.tenant_id = a.tenant_id AND u.status = 'ACTIVE'
WHERE a.tenant_id = (SELECT id FROM tenants WHERE code = 'HDG')
  AND NOT EXISTS (SELECT 1 FROM announcement_recipients ar WHERE ar.announcement_id = a.id AND ar.user_id = u.id);

-- ------------------------------------------------------------
-- 16. Seed: email templates
-- ------------------------------------------------------------
INSERT INTO email_templates (tenant_id, company_id, code, name, category, subject, body, variables, is_active)
SELECT t.id, c.id, v.code, v.name, v.category, v.subject, v.body, v.variables::jsonb, true
FROM tenants t
JOIN companies c ON c.tenant_id = t.id AND c.code = 'HDG'
CROSS JOIN (VALUES
  ('QUOTATION','Quotation Email','SALES','Quotation {{DOCUMENT_NUMBER}}','Dear {{CUSTOMER_NAME}}, please find attached our quotation {{DOCUMENT_NUMBER}} for {{AMOUNT}}. We look forward to your confirmation. Kind regards, {{COMPANY_NAME}}','["CUSTOMER_NAME","DOCUMENT_NUMBER","AMOUNT","COMPANY_NAME"]'),
  ('INVOICE','Invoice Email','FINANCE','Invoice {{DOCUMENT_NUMBER}}','Dear {{CUSTOMER_NAME}}, your invoice {{DOCUMENT_NUMBER}} for {{AMOUNT}} is due on {{DUE_DATE}}. Kind regards, {{COMPANY_NAME}}','["CUSTOMER_NAME","DOCUMENT_NUMBER","AMOUNT","DUE_DATE","COMPANY_NAME"]'),
  ('PAYMENT_REMINDER','Payment Reminder','FINANCE','Payment Reminder {{DOCUMENT_NUMBER}}','Dear {{CUSTOMER_NAME}}, this is a reminder that invoice {{DOCUMENT_NUMBER}} of {{AMOUNT}} is overdue since {{DUE_DATE}}. Kind regards, {{COMPANY_NAME}}','["CUSTOMER_NAME","DOCUMENT_NUMBER","AMOUNT","DUE_DATE","COMPANY_NAME"]'),
  ('PURCHASE_ORDER','Purchase Order','PROCUREMENT','Purchase Order {{DOCUMENT_NUMBER}}','Dear {{SUPPLIER_NAME}}, please find attached purchase order {{DOCUMENT_NUMBER}} for {{AMOUNT}}. Kind regards, {{COMPANY_NAME}}','["SUPPLIER_NAME","DOCUMENT_NUMBER","AMOUNT","COMPANY_NAME"]'),
  ('ORDER_CONFIRMATION','Order Confirmation','SALES','Order Confirmation {{DOCUMENT_NUMBER}}','Dear {{CUSTOMER_NAME}}, your order {{DOCUMENT_NUMBER}} has been confirmed. Expected delivery {{DELIVERY_DATE}}. Kind regards, {{COMPANY_NAME}}','["CUSTOMER_NAME","DOCUMENT_NUMBER","DELIVERY_DATE","COMPANY_NAME"]'),
  ('DELIVERY_NOTIFICATION','Delivery Notification','LOGISTICS','Delivery {{DOCUMENT_NUMBER}} Dispatched','Dear {{CUSTOMER_NAME}}, delivery {{DOCUMENT_NUMBER}} has been dispatched and is expected on {{DELIVERY_DATE}}. Kind regards, {{COMPANY_NAME}}','["CUSTOMER_NAME","DOCUMENT_NUMBER","DELIVERY_DATE","COMPANY_NAME"]'),
  ('CONTRACT_NOTIFICATION','Contract Notification','HR','Contract Notification for {{EMPLOYEE_NAME}}','Dear {{EMPLOYEE_NAME}}, your contract {{DOCUMENT_NUMBER}} expires on {{EXPIRY_DATE}}. Please contact HR to begin renewal. Kind regards, {{COMPANY_NAME}}','["EMPLOYEE_NAME","DOCUMENT_NUMBER","EXPIRY_DATE","COMPANY_NAME"]'),
  ('LEAVE_APPROVAL','Leave Approval','HR','Leave Approved - {{EMPLOYEE_NAME}}','Dear {{EMPLOYEE_NAME}}, your leave request has been approved from {{START_DATE}} to {{END_DATE}}. Kind regards, {{COMPANY_NAME}}','["EMPLOYEE_NAME","START_DATE","END_DATE","COMPANY_NAME"]'),
  ('PAYSLIP_NOTIFICATION','Payslip Notification','HR','Payslip for {{MONTH}}','Dear {{EMPLOYEE_NAME}}, your payslip for {{MONTH}} is now available in the portal. Kind regards, {{COMPANY_NAME}}','["EMPLOYEE_NAME","MONTH","COMPANY_NAME"]'),
  ('WELCOME','Welcome Email','SYSTEM','Welcome to {{COMPANY_NAME}}','Dear {{EMPLOYEE_NAME}}, your account has been created. Please sign in and change your password on first login. Kind regards, {{COMPANY_NAME}}','["EMPLOYEE_NAME","COMPANY_NAME"]')
) AS v(code, name, category, subject, body, variables)
WHERE t.code = 'HDG'
  AND NOT EXISTS (SELECT 1 FROM email_templates et WHERE et.tenant_id = t.id AND et.code = v.code);

-- ------------------------------------------------------------
-- 17. Seed: communication settings
-- ------------------------------------------------------------
INSERT INTO communication_settings (tenant_id, company_id, category, key, value)
SELECT t.id, c.id, v.category, v.key, v.value::jsonb
FROM tenants t
JOIN companies c ON c.tenant_id = t.id AND c.code = 'HDG'
CROSS JOIN (VALUES
  ('digest','default_digest','{"mode":"INSTANT","daily_at":"08:00","weekly_day":"MONDAY"}'),
  ('retry','policy','{"max_attempts":3,"backoff_seconds":[30,120,600]}'),
  ('escalation','approval','{"remind_hours":24,"manager_hours":48,"head_hours":72,"executive_hours":120}'),
  ('smtp','default','{"host":"smtp.hopedesign.co.ug","port":587,"secure":true,"sender":"notifications@hopedesign.co.ug","name":"HOPE DESIGN ERP"}'),
  ('providers','sms','{"provider":"NONE","enabled":false}'),
  ('providers','whatsapp','{"provider":"NONE","enabled":false}'),
  ('providers','push','{"enabled":true}')
) AS v(category, key, value)
WHERE t.code = 'HDG'
  AND NOT EXISTS (SELECT 1 FROM communication_settings cs WHERE cs.tenant_id = t.id AND cs.company_id = c.id AND cs.category = v.category AND cs.key = v.key);

-- ------------------------------------------------------------
-- 18. Seed: notification rules
-- ------------------------------------------------------------
INSERT INTO notification_rules (tenant_id, company_id, name, event_type, conditions, channels, role_codes, user_ids, is_active)
SELECT t.id, c.id, v.name, v.event_type, v.conditions::jsonb, v.channels::jsonb, v.role_codes::jsonb, '[]'::jsonb, true
FROM tenants t
JOIN companies c ON c.tenant_id = t.id AND c.code = 'HDG'
CROSS JOIN (VALUES
  ('High Value Purchase Approvals','APPROVAL_REQUIRED','{"entity_type":"purchase_order","min_amount":10000000}','["IN_APP","EMAIL"]','["cfo","finance_manager","managing_director"]'),
  ('Low Stock Alert','STOCK_LOW','{"condition":"available_lt_reorder_point"}','["IN_APP"]','["warehouse_manager","storekeeper","procurement_manager"]'),
  ('Machine Breakdown','MACHINE_DOWN','{"entity_type":"machine","status":"BREAKDOWN"}','["IN_APP","EMAIL","SMS"]','["maintenance_manager","operations_director","production_manager"]'),
  ('Quality Failure','QUALITY_FAILED','{"entity_type":"batch","result":"FAIL"}','["IN_APP","EMAIL"]','["quality_manager","quality_inspector","production_manager"]')
) AS v(name, event_type, conditions, channels, role_codes)
WHERE t.code = 'HDG'
  AND NOT EXISTS (SELECT 1 FROM notification_rules nr WHERE nr.tenant_id = t.id AND nr.name = v.name);
