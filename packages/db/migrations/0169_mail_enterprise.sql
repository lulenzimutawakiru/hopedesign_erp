-- ============================================================
-- Hope Design ERP - 0169 Company Mailing System (enterprise)
-- ------------------------------------------------------------
-- Extends the existing `communication` module. There is NO
-- parallel mail stack: `emails` (+ email_recipients /
-- email_attachments) remains the single content source of
-- truth; drafts / scheduled / outbox are folder+status on it.
--
-- Idempotent and additive. Safe to re-run.
-- ============================================================

-- NOTE: the class of defect where trg_set_updated_at is attached to a
-- table with no updated_at column is ALREADY repaired by
-- 0122_comm_updated_at_column_fix.sql. Verified against the live
-- schema: all 18 affected tables carry the column and accept UPDATE.
-- No duplicate repair is repeated here.

-- ------------------------------------------------------------
-- 0a. Mailboxes - individual, department, shared, system
--     MUST be created before anything that references it.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mailboxes (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  address TEXT NOT NULL,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'SHARED'
    CHECK (kind IN ('INDIVIDUAL','DEPARTMENT','SHARED','SYSTEM','DISTRIBUTION')),
  department_id BIGINT REFERENCES departments(id),
  owner_user_id BIGINT REFERENCES users(id),
  description TEXT,
  default_classification TEXT NOT NULL DEFAULT 'INTERNAL',
  default_sender_name TEXT,
  allow_external_send BOOLEAN NOT NULL DEFAULT true,
  require_approval BOOLEAN NOT NULL DEFAULT false,
  retention_days INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, address)
);
CREATE INDEX IF NOT EXISTS idx_mailboxes_kind ON mailboxes(tenant_id, kind, is_active);

CREATE TABLE IF NOT EXISTS mailbox_members (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  mailbox_id BIGINT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_role TEXT NOT NULL DEFAULT 'MEMBER'
    CHECK (member_role IN ('OWNER','MANAGER','MEMBER','READ_ONLY')),
  can_view BOOLEAN NOT NULL DEFAULT true,
  can_send BOOLEAN NOT NULL DEFAULT true,
  can_reply BOOLEAN NOT NULL DEFAULT true,
  can_delete BOOLEAN NOT NULL DEFAULT false,
  can_archive BOOLEAN NOT NULL DEFAULT false,
  can_delegate BOOLEAN NOT NULL DEFAULT false,
  can_export BOOLEAN NOT NULL DEFAULT false,
  can_admin BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mailbox_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_mailbox_members_user ON mailbox_members(tenant_id, user_id, is_active);

CREATE TABLE IF NOT EXISTS mailbox_delegations (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  mailbox_id BIGINT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  delegator_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delegate_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  can_send_on_behalf BOOLEAN NOT NULL DEFAULT false,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','EXPIRED','REVOKED','PENDING')),
  revoked_at TIMESTAMPTZ,
  revoked_by BIGINT REFERENCES users(id),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mailbox_delegations_delegate
  ON mailbox_delegations(tenant_id, delegate_user_id, status, ends_at);
CREATE INDEX IF NOT EXISTS idx_mailbox_delegations_mailbox
  ON mailbox_delegations(mailbox_id, status);
-- ------------------------------------------------------------
-- 1. Widen `emails` into the mail content of record
-- ------------------------------------------------------------
ALTER TABLE emails DROP CONSTRAINT IF EXISTS emails_status_check;
ALTER TABLE emails ADD CONSTRAINT emails_status_check
  CHECK (status IN ('DRAFT','PENDING_APPROVAL','SCHEDULED','QUEUED','SENDING','SENT','FAILED','RECEIVED'));

ALTER TABLE emails ADD COLUMN IF NOT EXISTS mailbox_id BIGINT REFERENCES mailboxes(id) ON DELETE SET NULL;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS body_html TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS from_email TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS from_name TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS reply_to TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS sent_by BIGINT REFERENCES users(id);
ALTER TABLE emails ADD COLUMN IF NOT EXISTS on_behalf_of BIGINT REFERENCES users(id);
ALTER TABLE emails ADD COLUMN IF NOT EXISTS classification TEXT NOT NULL DEFAULT 'INTERNAL';
ALTER TABLE emails ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'NORMAL';
ALTER TABLE emails ADD COLUMN IF NOT EXISTS approval_state TEXT NOT NULL DEFAULT 'NOT_REQUIRED';
ALTER TABLE emails ADD COLUMN IF NOT EXISTS signature_id BIGINT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS is_starred BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS is_important BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS is_spam BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS has_attachments BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS in_reply_to TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS references_header TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS rfc_message_id TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS source_ip TEXT;

ALTER TABLE emails DROP CONSTRAINT IF EXISTS emails_priority_check;
ALTER TABLE emails ADD CONSTRAINT emails_priority_check
  CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT'));
ALTER TABLE emails DROP CONSTRAINT IF EXISTS emails_approval_state_check;
ALTER TABLE emails ADD CONSTRAINT emails_approval_state_check
  CHECK (approval_state IN ('NOT_REQUIRED','PENDING','APPROVED','REJECTED','RETURNED'));

-- folder added defensively, then backfilled from direction/status
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='emails' AND column_name='folder'
  ) THEN
    EXECUTE 'ALTER TABLE public.emails ADD COLUMN folder TEXT NOT NULL DEFAULT ''DRAFTS''';
    EXECUTE $bk$
      UPDATE public.emails SET folder = CASE
        WHEN direction = 'IN' THEN 'INBOX'
        WHEN status = 'SENT' THEN 'SENT'
        WHEN status = 'SCHEDULED' THEN 'SCHEDULED'
        WHEN status IN ('QUEUED','SENDING','FAILED') THEN 'OUTBOX'
        ELSE 'DRAFTS'
      END
    $bk$;
  END IF;
END $$;

ALTER TABLE emails DROP CONSTRAINT IF EXISTS emails_folder_check;
ALTER TABLE emails ADD CONSTRAINT emails_folder_check
  CHECK (folder IN ('INBOX','SENT','DRAFTS','SCHEDULED','OUTBOX','ARCHIVE','TRASH','SPAM'));

CREATE INDEX IF NOT EXISTS idx_emails_folder ON emails(tenant_id, folder, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_mailbox_folder ON emails(mailbox_id, folder, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_classification ON emails(tenant_id, classification);
CREATE INDEX IF NOT EXISTS idx_emails_unread ON emails(tenant_id, is_read) WHERE direction = 'IN';
CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_emails_provider_msg ON emails(provider_message_id);
-- ------------------------------------------------------------
-- 2. Recipients + attachments
-- ------------------------------------------------------------
ALTER TABLE email_recipients DROP CONSTRAINT IF EXISTS email_recipients_status_check;
ALTER TABLE email_recipients ADD CONSTRAINT email_recipients_status_check
  CHECK (status IN ('QUEUED','SENT','DELIVERED','READ','FAILED','BOUNCED','COMPLAINED'));

ALTER TABLE email_recipients ADD COLUMN IF NOT EXISTS mailbox_id BIGINT REFERENCES mailboxes(id) ON DELETE SET NULL;
ALTER TABLE email_recipients ADD COLUMN IF NOT EXISTS contact_id BIGINT;
ALTER TABLE email_recipients ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_email_recipients_email ON email_recipients(tenant_id, email);
CREATE INDEX IF NOT EXISTS idx_email_recipients_provider ON email_recipients(provider_message_id);

-- email_attachments goes live: ERP-document attachments, scanning, DMS link
ALTER TABLE email_attachments ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'UPLOAD';
ALTER TABLE email_attachments ADD COLUMN IF NOT EXISTS dms_document_id BIGINT REFERENCES dms_documents(id) ON DELETE SET NULL;
ALTER TABLE email_attachments ADD COLUMN IF NOT EXISTS entity_type TEXT;
ALTER TABLE email_attachments ADD COLUMN IF NOT EXISTS entity_id BIGINT;
ALTER TABLE email_attachments ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE email_attachments ADD COLUMN IF NOT EXISTS uploaded_by BIGINT REFERENCES users(id);
ALTER TABLE email_attachments ADD COLUMN IF NOT EXISTS scan_status TEXT NOT NULL DEFAULT 'NOT_SCANNED';
ALTER TABLE email_attachments ADD COLUMN IF NOT EXISTS is_inline BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE email_attachments ADD COLUMN IF NOT EXISTS content_id TEXT;
ALTER TABLE email_attachments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE email_attachments DROP CONSTRAINT IF EXISTS email_attachments_source_check;
ALTER TABLE email_attachments ADD CONSTRAINT email_attachments_source_check
  CHECK (source IN ('UPLOAD','ERP_DOCUMENT','INBOUND'));
ALTER TABLE email_attachments DROP CONSTRAINT IF EXISTS email_attachments_scan_status_check;
ALTER TABLE email_attachments ADD CONSTRAINT email_attachments_scan_status_check
  CHECK (scan_status IN ('NOT_SCANNED','PENDING','CLEAN','INFECTED','FAILED','SKIPPED'));

CREATE INDEX IF NOT EXISTS idx_email_attachments_email ON email_attachments(email_id);
CREATE INDEX IF NOT EXISTS idx_email_attachments_dms ON email_attachments(dms_document_id);
CREATE INDEX IF NOT EXISTS idx_email_attachments_hash ON email_attachments(tenant_id, content_hash);

-- ------------------------------------------------------------
-- 3. Threads + templates
-- ------------------------------------------------------------
ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS mailbox_id BIGINT REFERENCES mailboxes(id) ON DELETE SET NULL;
ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS message_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS unread_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS last_direction TEXT;
ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS normalized_subject TEXT;

CREATE INDEX IF NOT EXISTS idx_email_threads_mailbox
  ON email_threads(tenant_id, mailbox_id, last_message_at DESC);

ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS body_html TEXT;
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS classification TEXT NOT NULL DEFAULT 'INTERNAL';
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'SYSTEM';
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS owner_mailbox_id BIGINT REFERENCES mailboxes(id) ON DELETE SET NULL;
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS require_approval BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS description TEXT;

ALTER TABLE email_templates DROP CONSTRAINT IF EXISTS email_templates_scope_check;
ALTER TABLE email_templates ADD CONSTRAINT email_templates_scope_check
  CHECK (scope IN ('SYSTEM','DEPARTMENT','SHARED','PERSONAL'));

-- superset of the 0118 category list
ALTER TABLE email_templates DROP CONSTRAINT IF EXISTS email_templates_category_check;
ALTER TABLE email_templates ADD CONSTRAINT email_templates_category_check
  CHECK (category IN (
    'SALES','FINANCE','PROCUREMENT','LOGISTICS','HR','SYSTEM','GENERAL',
    'MANUFACTURING','QUALITY','INVENTORY',
    'OFFICIAL','SERVICE_DESK','MANAGEMENT','SECURITY'
  ));
-- ------------------------------------------------------------
-- 4. Labels + classification policy
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_labels (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  mailbox_id BIGINT REFERENCES mailboxes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'slate',
  kind TEXT NOT NULL DEFAULT 'USER' CHECK (kind IN ('USER','SYSTEM','CLASSIFICATION')),
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, mailbox_id, name)
);
CREATE INDEX IF NOT EXISTS idx_email_labels_mailbox ON email_labels(tenant_id, mailbox_id);

CREATE TABLE IF NOT EXISTS email_message_labels (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  email_id BIGINT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  label_id BIGINT NOT NULL REFERENCES email_labels(id) ON DELETE CASCADE,
  applied_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (email_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_email_message_labels_email ON email_message_labels(email_id);

CREATE TABLE IF NOT EXISTS email_classifications (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  rank INTEGER NOT NULL DEFAULT 1,
  color TEXT NOT NULL DEFAULT 'slate',
  description TEXT,
  allow_forward BOOLEAN NOT NULL DEFAULT true,
  allow_download BOOLEAN NOT NULL DEFAULT true,
  allow_print BOOLEAN NOT NULL DEFAULT true,
  allow_export BOOLEAN NOT NULL DEFAULT true,
  allow_external BOOLEAN NOT NULL DEFAULT true,
  require_approval BOOLEAN NOT NULL DEFAULT false,
  require_encryption BOOLEAN NOT NULL DEFAULT false,
  min_role_rank INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_email_classifications_rank ON email_classifications(tenant_id, rank);

-- ------------------------------------------------------------
-- 5. Signatures, rules, distribution lists
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_signatures (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id BIGINT REFERENCES mailboxes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  body_text TEXT,
  body_html TEXT,
  logo_path TEXT,
  job_title TEXT,
  department TEXT,
  phone TEXT,
  website TEXT,
  social JSONB NOT NULL DEFAULT '{}'::jsonb,
  disclaimer TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_shared BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_signatures_user ON email_signatures(tenant_id, user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_email_signatures_mailbox ON email_signatures(tenant_id, mailbox_id, is_active);

CREATE TABLE IF NOT EXISTS email_rules (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  mailbox_id BIGINT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  match_field TEXT NOT NULL DEFAULT 'SUBJECT'
    CHECK (match_field IN ('SUBJECT','FROM','TO','BODY','HEADERS','CLASSIFICATION','HAS_ATTACHMENT')),
  match_operator TEXT NOT NULL DEFAULT 'CONTAINS'
    CHECK (match_operator IN ('CONTAINS','EQUALS','STARTS_WITH','ENDS_WITH','REGEX','NOT_CONTAINS')),
  match_value TEXT,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  stop_processing BOOLEAN NOT NULL DEFAULT false,
  run_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_rules_mailbox ON email_rules(tenant_id, mailbox_id, is_active, priority);

CREATE TABLE IF NOT EXISTS email_distribution_lists (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, address)
);

CREATE TABLE IF NOT EXISTS email_distribution_members (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  list_id BIGINT NOT NULL REFERENCES email_distribution_lists(id) ON DELETE CASCADE,
  member_type TEXT NOT NULL DEFAULT 'USER'
    CHECK (member_type IN ('USER','EMAIL','MAILBOX','DEPARTMENT')),
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id BIGINT REFERENCES mailboxes(id) ON DELETE CASCADE,
  department_id BIGINT REFERENCES departments(id) ON DELETE SET NULL,
  email TEXT,
  name TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_distribution_members_list ON email_distribution_members(list_id, is_active);
-- ------------------------------------------------------------
-- 6. Contacts, approvals, outbox, scheduling
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_contacts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  contact_type TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (contact_type IN ('CUSTOMER','SUPPLIER','EMPLOYEE','PARTNER','DEPARTMENT','OTHER')),
  entity_type TEXT,
  entity_id BIGINT,
  name TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  job_title TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_contacts_email ON email_contacts(tenant_id, lower(email));
CREATE INDEX IF NOT EXISTS idx_email_contacts_entity ON email_contacts(tenant_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS email_approvals (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  email_id BIGINT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  required_level INTEGER NOT NULL DEFAULT 1,
  approver_role TEXT,
  approver_user_id BIGINT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','REJECTED','RETURNED','CANCELLED')),
  classification TEXT,
  reason TEXT,
  decision_note TEXT,
  requested_by BIGINT REFERENCES users(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by BIGINT REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_approvals_email ON email_approvals(email_id, required_level);
CREATE INDEX IF NOT EXISTS idx_email_approvals_pending ON email_approvals(tenant_id, status, requested_at DESC);

CREATE TABLE IF NOT EXISTS email_outbox (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  email_id BIGINT NOT NULL REFERENCES emails(id) ON DELETE CASCADE UNIQUE,
  mailbox_id BIGINT REFERENCES mailboxes(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','SENDING','SENT','FAILED','CANCELLED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,
  provider TEXT,
  provider_message_id TEXT,
  queued_by BIGINT REFERENCES users(id),
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_outbox_ready ON email_outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS email_scheduled_messages (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  mailbox_id BIGINT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  template_code TEXT,
  subject TEXT,
  body TEXT,
  recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  cc JSONB NOT NULL DEFAULT '[]'::jsonb,
  bcc JSONB NOT NULL DEFAULT '[]'::jsonb,
  classification TEXT NOT NULL DEFAULT 'INTERNAL',
  recurrence TEXT NOT NULL DEFAULT 'ONCE'
    CHECK (recurrence IN ('ONCE','DAILY','WEEKLY','MONTHLY')),
  timezone TEXT NOT NULL DEFAULT 'Africa/Kampala',
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  run_count INTEGER NOT NULL DEFAULT 0,
  variables JSONB NOT NULL DEFAULT '{}'::jsonb,
  attach_document_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  require_approval BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','PAUSED','COMPLETED','FAILED','CANCELLED')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_scheduled_due ON email_scheduled_messages(tenant_id, status, next_run_at);
-- ------------------------------------------------------------
-- 7. Delivery events, provider config, webhooks, audit widen
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_delivery_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  email_id BIGINT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  recipient_id BIGINT REFERENCES email_recipients(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('QUEUED','SENT','DELIVERED','OPENED','CLICKED','BOUNCED','FAILED','COMPLAINED')),
  provider TEXT,
  provider_message_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Only a verified provider callback may set this true. Never infer
  -- delivery/open state locally (AC-MAIL-011).
  confirmed_by_provider BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_email ON email_delivery_events(email_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_provider ON email_delivery_events(provider_message_id);

CREATE TABLE IF NOT EXISTS email_provider_configs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  environment TEXT NOT NULL DEFAULT 'PRODUCTION'
    CHECK (environment IN ('SANDBOX','PRODUCTION')),
  provider TEXT NOT NULL DEFAULT 'RESEND'
    CHECK (provider IN ('RESEND','SMTP','MICROSOFT365','GOOGLE_WORKSPACE')),
  label TEXT NOT NULL DEFAULT 'default',
  from_name TEXT,
  from_address TEXT,
  reply_to TEXT,
  inbound_address TEXT,
  -- Encrypted at rest via companyConfig.encryptSecret(). Never selected
  -- into an API response.
  credentials_encrypted TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  last_verified_at TIMESTAMPTZ,
  last_error TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, environment, provider, label)
);

CREATE TABLE IF NOT EXISTS email_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT REFERENCES tenants(id),
  provider TEXT NOT NULL,
  event_type TEXT,
  provider_message_id TEXT,
  email_id BIGINT REFERENCES emails(id) ON DELETE SET NULL,
  recipient_email TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  signature_valid BOOLEAN NOT NULL DEFAULT false,
  processed_at TIMESTAMPTZ,
  process_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_webhook_events_msg ON email_webhook_events(provider_message_id);
CREATE INDEX IF NOT EXISTS idx_email_webhook_events_unprocessed
  ON email_webhook_events(processed_at) WHERE processed_at IS NULL;

-- Widen the EXISTING communication audit trail. No parallel audit table.
ALTER TABLE communication_audit_logs ADD COLUMN IF NOT EXISTS mailbox_id BIGINT REFERENCES mailboxes(id) ON DELETE SET NULL;
ALTER TABLE communication_audit_logs ADD COLUMN IF NOT EXISTS message_id TEXT;
ALTER TABLE communication_audit_logs ADD COLUMN IF NOT EXISTS device TEXT;
ALTER TABLE communication_audit_logs ADD COLUMN IF NOT EXISTS result TEXT NOT NULL DEFAULT 'SUCCESS';
CREATE INDEX IF NOT EXISTS idx_comm_audit_mailbox ON communication_audit_logs(mailbox_id, created_at DESC);

-- ------------------------------------------------------------
-- 8. RLS + updated_at triggers for the new mail tables
--    All 17 carry tenant_id and updated_at by construction.
-- ------------------------------------------------------------
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'mailboxes','mailbox_members','mailbox_delegations',
    'email_labels','email_message_labels','email_classifications',
    'email_signatures','email_rules',
    'email_distribution_lists','email_distribution_members',
    'email_contacts','email_approvals','email_outbox',
    'email_scheduled_messages','email_delivery_events',
    'email_provider_configs','email_webhook_events'
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
-- 9. Permissions (module: communication) - 62 new mail codes
--    NOTE: communication.settings.manage is deliberately NOT in
--    this set; mail configuration is governed by mail_providers.*
--    and mail_admin.* instead.
-- ------------------------------------------------------------
INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, 'communication', v.resource, v.action, v.description
FROM (VALUES  ('communication.mailboxes.view','mailboxes','view','view Mailbox'),
  ('communication.mailboxes.create','mailboxes','create','create Mailbox'),
  ('communication.mailboxes.update','mailboxes','update','update Mailbox'),
  ('communication.mailboxes.delete','mailboxes','delete','delete Mailbox'),
  ('communication.mailboxes.manage','mailboxes','manage','manage Mailbox'),
  ('communication.mailbox_members.view','mailbox_members','view','view Mailbox membership'),
  ('communication.mailbox_members.create','mailbox_members','create','create Mailbox membership'),
  ('communication.mailbox_members.update','mailbox_members','update','update Mailbox membership'),
  ('communication.mailbox_members.delete','mailbox_members','delete','delete Mailbox membership'),
  ('communication.mailbox_members.manage','mailbox_members','manage','manage Mailbox membership'),
  ('communication.mailbox_delegations.view','mailbox_delegations','view','view Mailbox delegation'),
  ('communication.mailbox_delegations.create','mailbox_delegations','create','create Mailbox delegation'),
  ('communication.mailbox_delegations.revoke','mailbox_delegations','revoke','revoke Mailbox delegation'),
  ('communication.mailbox_delegations.manage','mailbox_delegations','manage','manage Mailbox delegation'),
  ('communication.mail_drafts.view','mail_drafts','view','view Mail draft'),
  ('communication.mail_drafts.create','mail_drafts','create','create Mail draft'),
  ('communication.mail_drafts.update','mail_drafts','update','update Mail draft'),
  ('communication.mail_drafts.delete','mail_drafts','delete','delete Mail draft'),
  ('communication.mail_scheduled.view','mail_scheduled','view','view Scheduled message'),
  ('communication.mail_scheduled.create','mail_scheduled','create','create Scheduled message'),
  ('communication.mail_scheduled.update','mail_scheduled','update','update Scheduled message'),
  ('communication.mail_scheduled.cancel','mail_scheduled','cancel','cancel Scheduled message'),
  ('communication.mail_labels.view','mail_labels','view','view Mail label'),
  ('communication.mail_labels.create','mail_labels','create','create Mail label'),
  ('communication.mail_labels.update','mail_labels','update','update Mail label'),
  ('communication.mail_labels.delete','mail_labels','delete','delete Mail label'),
  ('communication.mail_rules.view','mail_rules','view','view Mail rule'),
  ('communication.mail_rules.create','mail_rules','create','create Mail rule'),
  ('communication.mail_rules.update','mail_rules','update','update Mail rule'),
  ('communication.mail_rules.delete','mail_rules','delete','delete Mail rule'),
  ('communication.mail_rules.manage','mail_rules','manage','manage Mail rule'),
  ('communication.mail_signatures.view','mail_signatures','view','view Email signature'),
  ('communication.mail_signatures.create','mail_signatures','create','create Email signature'),
  ('communication.mail_signatures.update','mail_signatures','update','update Email signature'),
  ('communication.mail_signatures.delete','mail_signatures','delete','delete Email signature'),
  ('communication.mail_signatures.manage','mail_signatures','manage','manage Email signature'),
  ('communication.mail_distribution_lists.view','mail_distribution_lists','view','view Distribution list'),
  ('communication.mail_distribution_lists.create','mail_distribution_lists','create','create Distribution list'),
  ('communication.mail_distribution_lists.update','mail_distribution_lists','update','update Distribution list'),
  ('communication.mail_distribution_lists.delete','mail_distribution_lists','delete','delete Distribution list'),
  ('communication.mail_distribution_lists.manage','mail_distribution_lists','manage','manage Distribution list'),
  ('communication.mail_approvals.view','mail_approvals','view','view Mail approval'),
  ('communication.mail_approvals.submit','mail_approvals','submit','submit Mail approval'),
  ('communication.mail_approvals.approve','mail_approvals','approve','approve Mail approval'),
  ('communication.mail_approvals.reject','mail_approvals','reject','reject Mail approval'),
  ('communication.mail_approvals.manage','mail_approvals','manage','manage Mail approval'),
  ('communication.mail_classifications.view','mail_classifications','view','view Mail classification'),
  ('communication.mail_classifications.manage','mail_classifications','manage','manage Mail classification'),
  ('communication.mail_contacts.view','mail_contacts','view','view Mail contact'),
  ('communication.mail_contacts.export','mail_contacts','export','export Mail contact'),
  ('communication.mail_attachments.view','mail_attachments','view','view Mail attachment'),
  ('communication.mail_attachments.upload','mail_attachments','upload','upload Mail attachment'),
  ('communication.mail_attachments.download','mail_attachments','download','download Mail attachment'),
  ('communication.mail_attachments.delete','mail_attachments','delete','delete Mail attachment'),
  ('communication.mail_scheduler.view','mail_scheduler','view','view Mail scheduler'),
  ('communication.mail_scheduler.manage','mail_scheduler','manage','manage Mail scheduler'),
  ('communication.mail_providers.view','mail_providers','view','view Mail provider'),
  ('communication.mail_providers.manage','mail_providers','manage','manage Mail provider'),
  ('communication.mail_audit.view','mail_audit','view','view Mail audit'),
  ('communication.mail_audit.export','mail_audit','export','export Mail audit'),
  ('communication.mail_admin.view','mail_admin','view','view Mail administration'),
  ('communication.mail_admin.manage','mail_admin','manage','manage Mail administration')

) AS v(code, resource, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

-- Bootstrap-only grants. The durable source of truth is ROLES[].grants
-- + MAIL_ROLE_EXTENSIONS in packages/db/src/catalogue.js; reconcileRbac()
-- rebuilds role_permissions from them on every reseed.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p
  ON p.module = 'communication'
 AND p.resource IN (
   'mailboxes','mailbox_members','mailbox_delegations','mail_drafts','mail_scheduled',
   'mail_labels','mail_rules','mail_signatures','mail_distribution_lists','mail_approvals',
   'mail_classifications','mail_contacts','mail_attachments','mail_scheduler','mail_providers',
   'mail_audit','mail_admin'
 )
WHERE r.code IN (
  'super_administrator','system_administrator','ceo','managing_director','executive_director',
  'general_manager','operations_director','cfo','finance_manager','hr_manager','sales_director',
  'procurement_director','security_administrator','it_support_administrator',
  'integration_administrator','audit_administrator','data_protection_officer'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;
-- ------------------------------------------------------------
-- 10. Seed reference data
--     Every statement is idempotent (WHERE NOT EXISTS) and
--     resolves the organisation by business key (tenants.code =
--     'HDG'), never by a hardcoded integer id.
--
--     NOTE: app_settings mail-identity rows are deliberately NOT
--     seeded here. `mailboxes` + `email_provider_configs` are the
--     authoritative source for mail identity; the legacy
--     organisation.communication settings keys remain readable
--     for backward compatibility only.
-- ------------------------------------------------------------

-- 10.1 Classification handling ladder
INSERT INTO email_classifications (
  tenant_id, code, label, "rank", color, description,
  allow_forward, allow_download, allow_print, allow_export, allow_external,
  require_approval, require_encryption, is_active
)
SELECT t.id, v.code, v.label, v."rank", v.color, v.description,
       v.allow_forward, v.allow_download, v.allow_print, v.allow_export, v.allow_external,
       v.require_approval, v.require_encryption, true
FROM tenants t
CROSS JOIN (VALUES
  ('PUBLIC','Public',1,'emerald',
   'Publishable material with no handling restriction. Safe for external release.',
   true,  true,  true,  true,  true,  false, false),
  ('INTERNAL','Internal',2,'sky',
   'Default working classification for routine internal and external business correspondence.',
   true,  true,  true,  true,  true,  false, false),
  ('CONFIDENTIAL','Confidential',3,'amber',
   'Commercially sensitive. Release outside the company requires approval. Export is restricted.',
   true,  true,  true,  false, true,  true,  false),
  ('RESTRICTED','Restricted',4,'orange',
   'Named-recipient material. Forwarding and external release are prohibited and approvals plus transport encryption are required.',
   false, true,  true,  false, false, true,  true),
  ('HIGHLY_RESTRICTED','Highly Restricted',5,'red',
   'Highest handling tier for security-printing and statutory material. No forward, download, print or external release.',
   false, false, false, false, false, true,  true)
) AS v(code, label, "rank", color, description,
       allow_forward, allow_download, allow_print, allow_export, allow_external,
       require_approval, require_encryption)
WHERE t.code = 'HDG'
  AND NOT EXISTS (
    SELECT 1 FROM email_classifications x
    WHERE x.tenant_id = t.id AND x.code = v.code
  );

-- 10.2 Company mailboxes (individual mailboxes are created per user,
--      never seeded here). Domain is the live tenant domain.
INSERT INTO mailboxes (
  tenant_id, company_id, branch_id, code, address, display_name, kind,
  department_id, owner_user_id, description, default_classification,
  default_sender_name, allow_external_send, require_approval, retention_days,
  is_active, created_by
)
SELECT t.id, c.id, b.id, v.code,
       v.local_part || '@' || dom.d,
       v.display_name, v.kind, d.id, NULL, v.description,
       v.default_classification, v.default_sender_name,
       v.allow_external_send, v.require_approval, v.retention_days,
       true, NULL
FROM tenants t
JOIN companies c ON c.code = 'HDG'
LEFT JOIN branches b ON b.code = 'KAMPALA-HQ' AND b.company_id = c.id
CROSS JOIN (VALUES ('hopedesign.jorlentech.com')) AS dom(d)
CROSS JOIN (VALUES
  ('MAIL-INFO','info','SHARED',NULL,
   'HOPE DESIGN Enquiries','General public enquiries and reception correspondence.',
   'INTERNAL','HOPE DESIGN GROUP LTD',true,false,2555),
  ('MAIL-ACCOUNTS','accounts','SHARED',NULL,
   'HOPE DESIGN Accounts','Shared receivable and payable correspondence.',
   'CONFIDENTIAL','HOPE DESIGN Accounts',true,false,3650),
  ('MAIL-ADMIN','admin','SHARED',NULL,
   'HOPE DESIGN Administration','Central administration and corporate correspondence.',
   'INTERNAL','HOPE DESIGN GROUP LTD',true,false,2555),
  ('MAIL-HR','hr','DEPARTMENT','HR',
   'Human Resources','Recruitment, employee relations and statutory HR correspondence.',
   'CONFIDENTIAL','HOPE DESIGN Human Resources',true,false,3650),
  ('MAIL-FINANCE','finance','DEPARTMENT','FIN',
   'Finance Department','Invoicing, statements and statutory financial correspondence.',
   'CONFIDENTIAL','HOPE DESIGN Finance',true,true,3650),
  ('MAIL-SALES','sales','DEPARTMENT','SAL',
   'Sales Department','Quotations, sales orders and customer correspondence.',
   'INTERNAL','HOPE DESIGN Sales',true,false,2555),
  ('MAIL-PROCUREMENT','procurement','DEPARTMENT','PROC',
   'Procurement Department','Requisitions, RFQs, purchase orders and supplier correspondence.',
   'INTERNAL','HOPE DESIGN Procurement',true,true,2555),
  ('MAIL-SUPPORT','support','DEPARTMENT','IT',
   'Service Desk','Incident, request and service-desk correspondence.',
   'INTERNAL','HOPE DESIGN Service Desk',true,false,1095),
  ('MAIL-NOTIFICATIONS','notifications','SYSTEM',NULL,
   'ERP Notifications','Outbound-only notifications generated by ERP workflows.',
   'INTERNAL','HOPE DESIGN ERP',true,false,365),
  ('MAIL-NOREPLY','noreply','SYSTEM',NULL,
   'ERP No-Reply','Automated outbound only. Inbound mail to this address is not monitored.',
   'INTERNAL','HOPE DESIGN ERP',true,false,365)
) AS v(code, local_part, kind, dept, display_name, description,
       default_classification, default_sender_name,
       allow_external_send, require_approval, retention_days)
LEFT JOIN departments d ON d.company_id = c.id AND d.code = v.dept
WHERE t.code = 'HDG'
  AND NOT EXISTS (
    SELECT 1 FROM mailboxes x
    WHERE x.tenant_id = t.id AND x.code = v.code
  );

-- 10.3 Distribution lists (membership is administered in the UI)
INSERT INTO email_distribution_lists (
  tenant_id, code, name, address, description, is_active, created_by
)
SELECT t.id, v.code, v.name, v.local_part || '@' || dom.d,
       v.description, true, NULL
FROM tenants t
CROSS JOIN (VALUES ('hopedesign.jorlentech.com')) AS dom(d)
CROSS JOIN (VALUES
  ('DL-ALLSTAFF','All Staff','all-staff','Every active member of staff.'),
  ('DL-MANAGEMENT','Management','management','Executive and senior management.'),
  ('DL-FINANCE','Finance Team','finance-team','Finance department members.'),
  ('DL-HR','HR Team','hr-team','Human resources members.'),
  ('DL-PRODUCTION','Production','production','Production and plant supervision.'),
  ('DL-IT','IT Team','it','Information technology members.'),
  ('DL-SALES','Sales Team','sales-team','Sales and customer-facing staff.'),
  ('DL-PROCUREMENT','Procurement Team','procurement-team','Procurement and supply-chain members.'),
  ('DL-FACTORY','Factory Floor','factory','Factory floor and shift supervisors.')
) AS v(code, name, local_part, description)
WHERE t.code = 'HDG'
  AND NOT EXISTS (
    SELECT 1 FROM email_distribution_lists x
    WHERE x.tenant_id = t.id AND x.code = v.code
  );

-- 10.4 Official correspondence templates
--      The 28 ERP transaction templates seeded by 0115 are left
--      untouched; these are the official/correspondence set.
INSERT INTO email_templates (
  tenant_id, company_id, code, name, category, subject, body, variables,
  is_active, body_html, classification, scope, owner_mailbox_id,
  require_approval, description
)
SELECT t.id, c.id, v.code, v.name, v.category, v.subject,
       v.body, v.variables::jsonb, true, NULL,
       v.classification, 'SYSTEM',
       (SELECT m.id FROM mailboxes m WHERE m.tenant_id = t.id AND m.code = v.owner_mailbox),
       v.require_approval, v.description
FROM tenants t
JOIN companies c ON c.code = 'HDG'
CROSS JOIN (VALUES
  ('MAIL-OFFICIAL-LETTER','Official Letter','OFFICIAL',
   '{{subject}}',
   E'{{recipient_name}}\n{{recipient_address}}\n\nDear {{recipient_name}},\n\n{{body}}\n\nYours faithfully,\n{{sender_name}}\n{{sender_title}}\nHOPE DESIGN GROUP LTD',
   '["recipient_name","recipient_address","subject","body","sender_name","sender_title"]',
   'CONFIDENTIAL','MAIL-ADMIN',true,
   'Formal external correspondence issued under the company name. Requires approval before sending.'),
  ('MAIL-MEETING-REQUEST','Meeting Request','MANAGEMENT',
   'Meeting invitation: {{meeting_title}} - {{meeting_date}}',
   E'Dear {{recipient_name}},\n\nYou are invited to {{meeting_title}}.\n\nDate: {{meeting_date}}\nTime: {{meeting_time}}\nVenue: {{meeting_venue}}\n\nAgenda:\n{{agenda}}\n\nPlease confirm your attendance.\n\nRegards,\n{{sender_name}}\nHOPE DESIGN GROUP LTD',
   '["recipient_name","meeting_title","meeting_date","meeting_time","meeting_venue","agenda","sender_name"]',
   'INTERNAL','MAIL-ADMIN',false,
   'Internal or external meeting invitation with agenda.'),
  ('MAIL-INTERNAL-MEMO','Internal Memorandum','MANAGEMENT',
   'INTERNAL MEMO: {{memo_subject}}',
   E'TO: {{recipients}}\nFROM: {{sender_name}}, {{sender_title}}\nDATE: {{memo_date}}\nREF: {{reference}}\nSUBJECT: {{memo_subject}}\n\n{{body}}\n\n________________________\n{{sender_name}}\n{{sender_title}}',
   '["recipients","sender_name","sender_title","memo_date","reference","memo_subject","body"]',
   'INTERNAL','MAIL-ADMIN',false,
   'Formal internal memorandum for company-wide or departmental communication.'),
  ('MAIL-TICKET-ACK','Service Desk Acknowledgement','SERVICE_DESK',
   'Ticket {{ticket_number}} received - {{ticket_subject}}',
   E'Dear {{requester_name}},\n\nYour request has been logged with HOPE DESIGN Service Desk.\n\nTicket: {{ticket_number}}\nSubject: {{ticket_subject}}\nPriority: {{priority}}\nLogged: {{logged_at}}\n\nYou will be notified as the ticket progresses. Please quote the ticket number in any follow-up.\n\nRegards,\nHOPE DESIGN Service Desk',
   '["requester_name","ticket_number","ticket_subject","priority","logged_at"]',
   'INTERNAL','MAIL-SUPPORT',false,
   'Automatic acknowledgement sent when a service desk ticket is created.'),
  ('MAIL-STATEMENT-OUTSTANDING','Statement of Outstanding Balance','FINANCE',
   'Statement of account - {{customer_name}} - balance {{balance}}',
   E'Dear {{contact_name}},\n\nPlease find below your account position with HOPE DESIGN GROUP LTD as at {{statement_date}}.\n\nAccount: {{customer_name}}\nOutstanding balance: {{balance}}\nOldest overdue item: {{oldest_invoice}}\nDue date: {{due_date}}\n\nA detailed statement is attached. Kindly arrange settlement or contact our accounts team to discuss.\n\nRegards,\nHOPE DESIGN Accounts\n{{company_phone}}',
   '["contact_name","customer_name","statement_date","balance","oldest_invoice","due_date","company_phone"]',
   'CONFIDENTIAL','MAIL-ACCOUNTS',false,
   'Account statement sent to a customer with an outstanding balance.'),
  ('MAIL-SECURITY-ACK','Security Print Acknowledgement','SECURITY',
   'Secure job {{job_number}} acknowledgement',
   E'Dear {{recipient_name}},\n\nThis acknowledges secure print job {{job_number}}.\n\nJob: {{job_number}}\nProduct: {{product_name}}\nQuantity: {{quantity}}\nClassification: {{classification}}\nCustody holder: {{custodian}}\n\nThis correspondence is controlled. Do not forward or reproduce it.\n\nRegards,\nHOPE DESIGN GROUP LTD',
   '["recipient_name","job_number","product_name","quantity","classification","custodian"]',
   'RESTRICTED',NULL,true,
   'Controlled acknowledgement for security-printing jobs. Requires approval and is not forwardable.')
) AS v(code, name, category, subject, body, variables, classification,
       owner_mailbox, require_approval, description)
WHERE t.code = 'HDG'
  AND NOT EXISTS (
    SELECT 1 FROM email_templates x
    WHERE x.tenant_id = t.id AND x.code = v.code
  );
