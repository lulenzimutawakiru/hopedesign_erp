-- ============================================================================
-- 0163 - Personal Data Protection Office (PDPO) integration
--
-- Scope of this migration: the compliance register. The bank migrations (0160,
-- 0162) model money arriving from outside; this one models an obligation going
-- the other way. Hope Design is a data controller under the Data Protection and
-- Privacy Act, 2019 and the Data Protection and Privacy Regulations, 2021, and
-- the Personal Data Protection Office is the regulator it answers to.
--
-- What a controller is actually asked to produce - and therefore what is built
-- here - is evidence:
--
--   1. a record of processing activities (the accountability register),
--   2. a consent register that can show what a data subject agreed to, when,
--      and on which wording,
--   3. the data subject requests received and how each one was answered,
--   4. every personal data breach, when it was discovered, and when (or
--      whether) it was notified,
--   5. the filings themselves, with the artefact that went to the regulator.
--
-- Configuration contract. As with every other external system, the integration
-- is a row in `company_integrations` and no new settings table is introduced:
--
--   category = 'regulatory', code = 'PDPO', status in the usual four states
--   config   = { environment: 'SANDBOX'|'PRODUCTION',
--                registration_number: '<PDPO certificate number>',
--                registration_expires_on: 'YYYY-MM-DD',
--                dpo_name / dpo_email / dpo_phone: <the appointed officer>,
--                portal_base_url: 'https://...',
--                breach_notification_hours: 72,
--                subject_request_days: 30 }
--   secrets  = { portal_api_key: <encrypted, unused today> }
--
-- 'regulatory' is a new integration category. The CHECK on
-- company_integrations.category is extended below rather than reusing 'other',
-- so that "what does this company report to a regulator?" stays a question the
-- database can answer.
--
-- On the deadline constants. The Act requires notification "without
-- unreasonable delay" and the Regulations prescribe the periods, so the widely
-- used 72 hours for a breach and 30 days for a data subject request are
-- DEFAULTS, not assumptions. Both are carried on the very row the clock applies
-- to (`notification_window_hours`, `response_window_days`) and stamped from
-- there, so an installation operating under a different regime changes
-- configuration rather than code - and every row records the window that was
-- actually applied to it, which is itself evidential.
--
-- The outbound leg is evidence, not an API call. PDPO has no public submission
-- interface to POST to: registration, breach notification and subject-request
-- responses are filed through the Office's portal or on prescribed forms. What
-- this integration does is produce the filing, record that it was made, and
-- retain the acknowledgement - which is the artefact an inspector asks to see.
-- Nothing here claims to have transmitted anything to the regulator, and the
-- status vocabulary ('DRAFT'/'FILED'/'ACKNOWLEDGED'/'REJECTED') says exactly
-- what is known rather than what is hoped.
--
-- Security posture. Unlike the bank feeds there is no unauthenticated ingress
-- here: every table is reached through an authenticated operator session, so
-- all five take the ordinary tenant RLS policy and the shared audit_row()
-- trigger, and no SECURITY DEFINER helper is needed. Access is deliberately
-- narrow - a breach register is not something every role that can read an audit
-- log should be able to open - so the grants at the foot of this file name
-- roles explicitly instead of following an anchor permission the way 0160 did.
-- Those same grants are declared in packages/db/src/catalogue.js, because
-- `npm run db:seed` replaces every role's grants from the catalogue and would
-- otherwise erase what this migration granted.
-- ============================================================================

-- ---------- 0. Allow a 'regulatory' integration category ----------
ALTER TABLE public.company_integrations
  DROP CONSTRAINT IF EXISTS company_integrations_category_check;
ALTER TABLE public.company_integrations
  ADD CONSTRAINT company_integrations_category_check
  CHECK (category IN ('payments','communication','accounting','tax','storage','analytics','regulatory','other'));

-- ---------- 1. Record of processing activities (RoPA) ----------
-- The accountability register: one row per activity that touches personal data.
-- This is the table that answers "what do you do with personal data, why, and
-- for how long?" without anybody having to reconstruct it from memory.
CREATE TABLE IF NOT EXISTS public.pdpo_processing_activities (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES public.tenants(id),
  company_id BIGINT NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  code TEXT NOT NULL,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  lawful_basis TEXT NOT NULL
    CHECK (lawful_basis IN ('CONSENT','CONTRACT','LEGAL_OBLIGATION','VITAL_INTERESTS','PUBLIC_TASK','LEGITIMATE_INTERESTS')),

  -- Constrained rather than free text: "which activities involve health data?"
  -- is the question this register exists to answer, and it is only answerable
  -- if the vocabulary is fixed. array_position(..., NULL) closes the hole where
  -- a NULL element would make the containment test silently pass.
  data_categories TEXT[] NOT NULL DEFAULT '{}'
    CHECK (data_categories <@ ARRAY['IDENTIFIERS','CONTACT','FINANCIAL','EMPLOYMENT','HEALTH','BIOMETRIC','GENETIC','CRIMINAL','CHILDREN','LOCATION','BEHAVIOURAL','TECHNICAL','SPECIAL_CATEGORY','OTHER']::text[]
           AND array_position(data_categories, NULL) IS NULL),
  subject_categories TEXT[] NOT NULL DEFAULT '{}'
    CHECK (subject_categories <@ ARRAY['CUSTOMERS','EMPLOYEES','APPLICANTS','SUPPLIERS','CONTRACTORS','NEXT_OF_KIN','WEBSITE_VISITORS','PATIENTS','STUDENTS','OTHER']::text[]
           AND array_position(subject_categories, NULL) IS NULL),

  recipients TEXT,
  retention_period TEXT,
  cross_border BOOLEAN NOT NULL DEFAULT false,
  transfer_countries TEXT[] NOT NULL DEFAULT '{}',
  transfer_safeguards TEXT,
  security_measures TEXT,
  dpia_completed BOOLEAN NOT NULL DEFAULT false,

  owner_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('DRAFT','ACTIVE','SUSPENDED','RETIRED')),
  last_reviewed_at TIMESTAMPTZ,
  review_due_at TIMESTAMPTZ,

  created_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Cross-border transfer fields move together: a flag with no destination is
  -- not a transfer record, and a destination without the flag is a silent one.
  CONSTRAINT pdpo_activities_transfer_consistent
    CHECK (cross_border = (array_length(transfer_countries, 1) IS NOT NULL)),
  CONSTRAINT pdpo_activities_code_unique UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_pdpo_activities_tenant
  ON public.pdpo_processing_activities(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_pdpo_activities_company_status
  ON public.pdpo_processing_activities(company_id, status, name);
-- "Everything that touches health data" is asked directly, so it is indexed
-- directly rather than scanned for.
CREATE INDEX IF NOT EXISTS idx_pdpo_activities_data_categories
  ON public.pdpo_processing_activities USING gin (data_categories);
CREATE INDEX IF NOT EXISTS idx_pdpo_activities_subject_categories
  ON public.pdpo_processing_activities USING gin (subject_categories);
CREATE INDEX IF NOT EXISTS idx_pdpo_activities_review_due
  ON public.pdpo_processing_activities(company_id, review_due_at)
  WHERE status = 'ACTIVE' AND review_due_at IS NOT NULL;

-- ---------- 2. Consent register ----------
-- What a data subject agreed to, on which words, and when they took it back.
-- subject_reference is a pseudonymous key: the register has to be able to find
-- a subject's consents without the register itself becoming a new copy of the
-- personal data it is meant to govern.
CREATE TABLE IF NOT EXISTS public.pdpo_consents (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES public.tenants(id),
  company_id BIGINT NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  subject_reference TEXT NOT NULL,
  subject_type TEXT NOT NULL
    CHECK (subject_type IN ('CUSTOMER','EMPLOYEE','APPLICANT','SUPPLIER_CONTACT','WEBSITE_VISITOR','OTHER')),
  processing_activity_id BIGINT REFERENCES public.pdpo_processing_activities(id) ON DELETE SET NULL,

  purpose TEXT NOT NULL,
  lawful_basis TEXT NOT NULL DEFAULT 'CONSENT'
    CHECK (lawful_basis IN ('CONSENT','CONTRACT','LEGAL_OBLIGATION','VITAL_INTERESTS','PUBLIC_TASK','LEGITIMATE_INTERESTS')),

  status TEXT NOT NULL DEFAULT 'GRANTED'
    CHECK (status IN ('GRANTED','WITHDRAWN','EXPIRED')),
  channel TEXT
    CHECK (channel IS NULL OR channel IN ('WEB_FORM','SIGNED_FORM','EMAIL','PHONE','PORTAL','IN_PERSON')),
  wording_version TEXT,

  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  withdrawal_reason TEXT,

  -- The artefact behind the consent: the form reference, the IP and user agent
  -- it was captured from, the wording hash. Retained because proving consent is
  -- the controller's burden, not the data subject's.
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  captured_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A withdrawal is a timestamped event or it did not happen; and a date cannot
  -- be held without the status that explains it.
  CONSTRAINT pdpo_consents_withdrawal_consistent
    CHECK ((status = 'WITHDRAWN') = (withdrawn_at IS NOT NULL)),
  CONSTRAINT pdpo_consents_expiry_after_grant
    CHECK (expires_at IS NULL OR expires_at > granted_at)
);

CREATE INDEX IF NOT EXISTS idx_pdpo_consents_subject
  ON public.pdpo_consents(company_id, subject_reference, purpose);
CREATE INDEX IF NOT EXISTS idx_pdpo_consents_company_status
  ON public.pdpo_consents(company_id, status, granted_at DESC);
-- At most one live consent per subject, per purpose - the invariant that makes
-- "is there consent for this?" a lookup instead of a judgement call. Withdrawn
-- and expired rows are outside the predicate, so re-consenting is simply a new
-- row and the history stays intact.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pdpo_consents_active
  ON public.pdpo_consents(company_id, subject_reference, purpose)
  WHERE status = 'GRANTED';
CREATE INDEX IF NOT EXISTS idx_pdpo_consents_activity
  ON public.pdpo_consents(processing_activity_id)
  WHERE processing_activity_id IS NOT NULL;

-- ---------- 3. Data subject rights requests ----------
-- Access, correction, erasure, objection, restriction, portability - the rights
-- the Act grants, each with a clock attached. The clock is stamped on write by
-- the trigger in section 6, from the window carried on the row.
CREATE TABLE IF NOT EXISTS public.pdpo_subject_requests (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES public.tenants(id),
  company_id BIGINT NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  reference TEXT NOT NULL,
  request_type TEXT NOT NULL
    CHECK (request_type IN ('ACCESS','CORRECTION','ERASURE','OBJECTION','RESTRICTION','PORTABILITY')),
  subject_reference TEXT NOT NULL,
  subject_type TEXT NOT NULL
    CHECK (subject_type IN ('CUSTOMER','EMPLOYEE','APPLICANT','SUPPLIER_CONTACT','WEBSITE_VISITOR','OTHER')),

  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  response_window_days INTEGER NOT NULL DEFAULT 30
    CHECK (response_window_days BETWEEN 1 AND 365),
  -- A statutory extension is recorded as days, never by editing received_at:
  -- the date the clock started has to stay the date the subject wrote in.
  extension_days INTEGER NOT NULL DEFAULT 0
    CHECK (extension_days >= 0 AND extension_days <= 180),
  due_at TIMESTAMPTZ,

  status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED','IN_PROGRESS','AWAITING_SUBJECT','COMPLETED','REFUSED','EXTENDED')),
  acknowledged_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  extension_reason TEXT,
  refusal_reason TEXT,
  outcome_summary TEXT,

  handled_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT pdpo_subject_requests_completion_consistent
    CHECK ((status IN ('COMPLETED','REFUSED')) = (completed_at IS NOT NULL)),
  CONSTRAINT pdpo_subject_requests_refusal_consistent
    CHECK ((status = 'REFUSED') = (refusal_reason IS NOT NULL)),
  CONSTRAINT pdpo_subject_requests_extension_consistent
    CHECK ((extension_days > 0) = (extension_reason IS NOT NULL)),
  CONSTRAINT pdpo_subject_requests_reference_unique UNIQUE (company_id, reference)
);

CREATE INDEX IF NOT EXISTS idx_pdpo_subject_requests_tenant
  ON public.pdpo_subject_requests(tenant_id, status);
-- The open-work queue, ordered by the date the law cares about.
CREATE INDEX IF NOT EXISTS idx_pdpo_subject_requests_due
  ON public.pdpo_subject_requests(company_id, due_at)
  WHERE status IN ('RECEIVED','IN_PROGRESS','AWAITING_SUBJECT','EXTENDED');
CREATE INDEX IF NOT EXISTS idx_pdpo_subject_requests_subject
  ON public.pdpo_subject_requests(company_id, subject_reference);

-- ---------- 4. Personal data breach register ----------
-- every breach, the 72-hour clock that runs from DISCOVERY (not from when the
-- ticket was raised), and whether the notification beat it. late_notification
-- is computed by the trigger so it cannot be quietly set to false.
CREATE TABLE IF NOT EXISTS public.pdpo_breaches (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES public.tenants(id),
  company_id BIGINT NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  reference TEXT NOT NULL,
  title TEXT NOT NULL,
  nature TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'MEDIUM'
    CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),

  occurred_at TIMESTAMPTZ,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notification_window_hours INTEGER NOT NULL DEFAULT 72
    CHECK (notification_window_hours BETWEEN 1 AND 720),
  notification_due_at TIMESTAMPTZ,

  data_categories TEXT[] NOT NULL DEFAULT '{}'
    CHECK (data_categories <@ ARRAY['IDENTIFIERS','CONTACT','FINANCIAL','EMPLOYMENT','HEALTH','BIOMETRIC','GENETIC','CRIMINAL','CHILDREN','LOCATION','BEHAVIOURAL','TECHNICAL','SPECIAL_CATEGORY','OTHER']::text[]
           AND array_position(data_categories, NULL) IS NULL),
  affected_subjects INTEGER NOT NULL DEFAULT 0 CHECK (affected_subjects >= 0),
  affected_records INTEGER NOT NULL DEFAULT 0 CHECK (affected_records >= 0),
  likely_consequences TEXT,
  containment_measures TEXT,

  -- notifiable=false is a documented decision that the Office need not be
  -- told, which is itself a decision an inspector will ask to see justified.
  notifiable BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','CONTAINED','REPORTED','NOT_NOTIFIABLE','CLOSED')),
  notified_at TIMESTAMPTZ,
  notification_reference TEXT,
  late_notification BOOLEAN NOT NULL DEFAULT false,
  subject_notified_at TIMESTAMPTZ,

  reported_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT pdpo_breaches_report_consistent
    CHECK (NOT (status = 'REPORTED' AND notified_at IS NULL)),
  CONSTRAINT pdpo_breaches_late_consistent
    CHECK (NOT late_notification OR notified_at IS NOT NULL),
  CONSTRAINT pdpo_breaches_notifiable_consistent
    CHECK (NOT (status = 'NOT_NOTIFIABLE' AND notifiable)),
  CONSTRAINT pdpo_breaches_discovered_after_occurred
    CHECK (occurred_at IS NULL OR discovered_at >= occurred_at),
  CONSTRAINT pdpo_breaches_reference_unique UNIQUE (company_id, reference)
);

CREATE INDEX IF NOT EXISTS idx_pdpo_breaches_tenant
  ON public.pdpo_breaches(tenant_id, status, discovered_at DESC);
-- The regulator's own queue: notifiable breaches ordered by the deadline that
-- is running out.
CREATE INDEX IF NOT EXISTS idx_pdpo_breaches_due
  ON public.pdpo_breaches(company_id, notification_due_at)
  WHERE status IN ('OPEN','CONTAINED');
CREATE INDEX IF NOT EXISTS idx_pdpo_breaches_late
  ON public.pdpo_breaches(company_id, notified_at)
  WHERE late_notification;

-- ---------- 5. Filing evidence ledger ----------
-- One row per thing that was filed with the Office, of any kind. This is the
-- cover sheet an inspection starts from: what was sent, when, by whom, over
-- which channel, and what came back.
CREATE TABLE IF NOT EXISTS public.pdpo_submissions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES public.tenants(id),
  company_id BIGINT NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  submission_type TEXT NOT NULL
    CHECK (submission_type IN ('REGISTRATION','RENEWAL','BREACH_NOTIFICATION','SUBJECT_REQUEST_RESPONSE','ANNUAL_RETURN','CONSENT_WITHDRAWAL_REPORT','OTHER')),
  subject TEXT NOT NULL,

  -- The register row this filing is about, when there is one. A registration
  -- filing has none, so the pair is allowed to be empty - but only as a pair.
  related_table TEXT
    CHECK (related_table IS NULL OR related_table IN ('pdpo_breaches','pdpo_subject_requests','pdpo_processing_activities','pdpo_consents')),
  related_id BIGINT,

  channel TEXT NOT NULL DEFAULT 'PORTAL'
    CHECK (channel IN ('PORTAL','EMAIL','POST','IN_PERSON')),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','FILED','ACKNOWLEDGED','REJECTED')),

  filed_at TIMESTAMPTZ,
  filed_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  acknowledgement_reference TEXT,
  acknowledged_at TIMESTAMPTZ,
  rejection_reason TEXT,

  -- The regulator-ready extract exactly as filed, plus the receipt, screenshot
  -- reference or courier note that proves the filing happened.
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT pdpo_submissions_related_pair
    CHECK ((related_table IS NULL) = (related_id IS NULL)),
  CONSTRAINT pdpo_submissions_filed_consistent
    CHECK (NOT (status IN ('FILED','ACKNOWLEDGED') AND filed_at IS NULL)),
  CONSTRAINT pdpo_submissions_ack_consistent
    CHECK (NOT (status = 'ACKNOWLEDGED' AND acknowledged_at IS NULL)),
  CONSTRAINT pdpo_submissions_rejection_consistent
    CHECK ((status = 'REJECTED') = (rejection_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_pdpo_submissions_tenant
  ON public.pdpo_submissions(tenant_id, status, filed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pdpo_submissions_type
  ON public.pdpo_submissions(company_id, submission_type, filed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pdpo_submissions_related
  ON public.pdpo_submissions(related_table, related_id)
  WHERE related_id IS NOT NULL;
-- A registration that lapses is a compliance failure, so renewals are tracked
-- from the ledger rather than from somebody's calendar.
CREATE INDEX IF NOT EXISTS idx_pdpo_submissions_ack_ref
  ON public.pdpo_submissions(company_id, acknowledgement_reference)
  WHERE acknowledgement_reference IS NOT NULL;

-- ---------- 6. Statutory clocks ----------
-- The deadlines are stamped by the database, not by the caller. A service that
-- forgets to set due_at would otherwise create a request with no clock, and a
-- caller that dislikes a deadline could simply omit it. Both columns are
-- recomputed on every write from the window carried on the row, so an UPDATE
-- that moves received_at moves the deadline with it, honestly.
CREATE OR REPLACE FUNCTION public.pdpo_stamp_request_deadline()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.due_at := NEW.received_at
    + make_interval(days => NEW.response_window_days + COALESCE(NEW.extension_days, 0));
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pdpo_subject_requests_deadline ON public.pdpo_subject_requests;
CREATE TRIGGER trg_pdpo_subject_requests_deadline
  BEFORE INSERT OR UPDATE ON public.pdpo_subject_requests
  FOR EACH ROW EXECUTE FUNCTION public.pdpo_stamp_request_deadline();

-- The breach clock runs from discovery, because that is when the controller
-- became able to act, and lateness is derived from the notification timestamp
-- rather than asserted - a breach that was notified late cannot be recorded as
-- though it were on time.
CREATE OR REPLACE FUNCTION public.pdpo_stamp_breach_clock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.notification_due_at := NEW.discovered_at
    + make_interval(hours => NEW.notification_window_hours);
  NEW.late_notification := NEW.notified_at IS NOT NULL
    AND NEW.notified_at > NEW.notification_due_at;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pdpo_breaches_clock ON public.pdpo_breaches;
CREATE TRIGGER trg_pdpo_breaches_clock
  BEFORE INSERT OR UPDATE ON public.pdpo_breaches
  FOR EACH ROW EXECUTE FUNCTION public.pdpo_stamp_breach_clock();

-- updated_at is maintained in the database for the same reason: the register
-- is evidence, so "when was this last touched" must not depend on the caller
-- remembering to say so. The shared set_updated_at() helper from 0001 is
-- attached under the same trigger name every other module uses (0099, 0150),
-- so the register behaves like the rest of the schema instead of growing a
-- private convention of its own.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pdpo_processing_activities','pdpo_consents','pdpo_subject_requests',
    'pdpo_breaches','pdpo_submissions'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgname = 'trg_set_updated_at' AND tgrelid = to_regclass('public.' || t)
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END IF;
  END LOOP;
END $$;

-- ---------- 7. Row security ----------
ALTER TABLE public.pdpo_processing_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pdpo_processing_activities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.pdpo_processing_activities;
CREATE POLICY tenant_isolation ON public.pdpo_processing_activities
  USING (tenant_id = app_tenant_id());

ALTER TABLE public.pdpo_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pdpo_consents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.pdpo_consents;
CREATE POLICY tenant_isolation ON public.pdpo_consents
  USING (tenant_id = app_tenant_id());

ALTER TABLE public.pdpo_subject_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pdpo_subject_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.pdpo_subject_requests;
CREATE POLICY tenant_isolation ON public.pdpo_subject_requests
  USING (tenant_id = app_tenant_id());

ALTER TABLE public.pdpo_breaches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pdpo_breaches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.pdpo_breaches;
CREATE POLICY tenant_isolation ON public.pdpo_breaches
  USING (tenant_id = app_tenant_id());

ALTER TABLE public.pdpo_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pdpo_submissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.pdpo_submissions;
CREATE POLICY tenant_isolation ON public.pdpo_submissions
  USING (tenant_id = app_tenant_id());

-- ---------- 8. Audit ----------
-- The shared audit_row() trigger, exactly as the bank feeds use it. Every
-- change to the register is therefore in audit_logs with its before/after
-- image, which is the only way a compliance register is worth anything: the
-- regulator is entitled to ask not just what it says now but what it said
-- before somebody edited it.
DROP TRIGGER IF EXISTS trg_pdpo_activities_audit ON public.pdpo_processing_activities;
CREATE TRIGGER trg_pdpo_activities_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.pdpo_processing_activities
  FOR EACH ROW EXECUTE FUNCTION audit_row();

DROP TRIGGER IF EXISTS trg_pdpo_consents_audit ON public.pdpo_consents;
CREATE TRIGGER trg_pdpo_consents_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.pdpo_consents
  FOR EACH ROW EXECUTE FUNCTION audit_row();

DROP TRIGGER IF EXISTS trg_pdpo_subject_requests_audit ON public.pdpo_subject_requests;
CREATE TRIGGER trg_pdpo_subject_requests_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.pdpo_subject_requests
  FOR EACH ROW EXECUTE FUNCTION audit_row();

DROP TRIGGER IF EXISTS trg_pdpo_breaches_audit ON public.pdpo_breaches;
CREATE TRIGGER trg_pdpo_breaches_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.pdpo_breaches
  FOR EACH ROW EXECUTE FUNCTION audit_row();

DROP TRIGGER IF EXISTS trg_pdpo_submissions_audit ON public.pdpo_submissions;
CREATE TRIGGER trg_pdpo_submissions_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.pdpo_submissions
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- ---------- 9. Permissions ----------
-- Mirrored in packages/db/src/catalogue.js under the `compliance` module, so
-- the catalogue and the database agree - the rule 0151 states for the Service
-- Desk and 0160 repeats for KCB. The catalogue is the source of truth: because
-- `npm run db:seed` replaces every role's grants from it, a grant made only
-- here would survive until the next seed and then vanish.
INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, 'compliance', v.resource, v.action, v.description
FROM (VALUES
  ('compliance.pdpo.view', 'pdpo', 'view', 'View the PDPO integration: registration posture, appointed officer and filing history'),
  ('compliance.pdpo.manage', 'pdpo', 'manage', 'Configure the PDPO integration: registration number, officer details and statutory windows'),
  ('compliance.pdpo.file', 'pdpo', 'file', 'Record a filing with the Personal Data Protection Office and its acknowledgement'),
  ('compliance.pdpo.export', 'pdpo', 'export', 'Export the compliance register and filing history for a regulator'),

  ('compliance.processing_activities.view', 'processing_activities', 'view', 'View the record of processing activities'),
  ('compliance.processing_activities.create', 'processing_activities', 'create', 'Add an activity that processes personal data to the register'),
  ('compliance.processing_activities.update', 'processing_activities', 'update', 'Amend a registered processing activity'),
  ('compliance.processing_activities.delete', 'processing_activities', 'delete', 'Remove a registered processing activity'),

  ('compliance.consents.view', 'consents', 'view', 'View the consent register'),
  ('compliance.consents.create', 'consents', 'create', 'Record a data subject consent with its evidence'),
  ('compliance.consents.withdraw', 'consents', 'withdraw', 'Record the withdrawal of a consent'),
  ('compliance.consents.delete', 'consents', 'delete', 'Remove a consent record'),

  ('compliance.subject_requests.view', 'subject_requests', 'view', 'View data subject rights requests and their deadlines'),
  ('compliance.subject_requests.create', 'subject_requests', 'create', 'Log a data subject rights request and start its clock'),
  ('compliance.subject_requests.update', 'subject_requests', 'update', 'Progress a data subject rights request'),
  ('compliance.subject_requests.fulfil', 'subject_requests', 'fulfil', 'Complete a data subject rights request and record the outcome'),
  ('compliance.subject_requests.refuse', 'subject_requests', 'refuse', 'Refuse a data subject rights request, with the reason'),

  ('compliance.breaches.view', 'breaches', 'view', 'View the personal data breach register'),
  ('compliance.breaches.create', 'breaches', 'create', 'Record a personal data breach and start its notification clock'),
  ('compliance.breaches.update', 'breaches', 'update', 'Amend a breach record: severity, scope, containment'),
  ('compliance.breaches.report', 'breaches', 'report', 'Record that a breach was notified to the Office and when'),
  ('compliance.breaches.close', 'breaches', 'close', 'Close a breach record')
) AS v(code, resource, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

-- The Data Protection Officer is the role the Act contemplates, and it holds
-- the whole module. Provisioned here for every company that already has roles,
-- exactly as 0151 provisions the Service Desk roles, because `npm run db:seed`
-- stops at reconcileRbac for an already-seeded tenant and that path only
-- updates grants for roles that already exist - it never creates one. A
-- migration-only deployment (SEED_ON_BOOT=false) therefore has to mint the
-- role itself. It is also declared in packages/db/src/catalogue.js ROLES, so a
-- fresh install and this migration converge on the same definition.
INSERT INTO roles (tenant_id, company_id, code, name, description, is_system, is_customizable, permissions)
SELECT t.tenant_id, t.company_id, 'data_protection_officer', 'Data Protection Officer',
       'Statutory data protection officer (Data Protection and Privacy Act, 2019). Owns the PDPO compliance register: processing activities, consents, data subject requests, breach notifications and filings.',
       true, true,
       '["compliance.pdpo.view","compliance.pdpo.manage","compliance.pdpo.file","compliance.pdpo.export","compliance.processing_activities.view","compliance.processing_activities.create","compliance.processing_activities.update","compliance.processing_activities.delete","compliance.consents.view","compliance.consents.create","compliance.consents.withdraw","compliance.consents.delete","compliance.subject_requests.view","compliance.subject_requests.create","compliance.subject_requests.update","compliance.subject_requests.fulfil","compliance.subject_requests.refuse","compliance.breaches.view","compliance.breaches.create","compliance.breaches.update","compliance.breaches.report","compliance.breaches.close"]'::jsonb
FROM (SELECT DISTINCT tenant_id, company_id FROM roles WHERE company_id IS NOT NULL) t
WHERE NOT EXISTS (
  SELECT 1 FROM roles r
   WHERE r.tenant_id = t.tenant_id AND r.company_id = t.company_id
     AND r.code = 'data_protection_officer'
);

-- Reading the register, and exporting it for a regulator, is for the functions
-- whose job is to examine records. The list is explicit rather than anchored to
-- admin.audit.view, because that anchor also reaches stock, asset and QA
-- auditors - and a breach register is not theirs to open.
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT r.id, p.id
FROM roles r
JOIN permissions p
  ON p.module = 'compliance' AND (p.action IN ('view','export'))
WHERE r.code IN ('security_administrator','system_administrator','audit_administrator','internal_auditor')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- The security function owns the breach register: it is the team that contains
-- an incident and the team that has to account for it afterwards.
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'compliance.breaches.create','compliance.breaches.update',
  'compliance.breaches.report','compliance.breaches.close')
WHERE r.code = 'security_administrator'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- HR holds the largest body of personal data in the ERP, so it keeps the parts
-- of the register that are about the data it actually processes: employees,
-- applicants and next of kin. It does not get the breach register, and it does
-- not get delete.
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'compliance.processing_activities.view','compliance.processing_activities.create','compliance.processing_activities.update',
  'compliance.consents.view','compliance.consents.create','compliance.consents.withdraw',
  'compliance.subject_requests.view','compliance.subject_requests.create','compliance.subject_requests.update',
  'compliance.subject_requests.fulfil','compliance.subject_requests.refuse')
WHERE r.code IN ('hr_manager','hr_director','hr_officer')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- The Data Protection Officer holds the whole module. The role is minted just
-- above and mirrored in packages/db/src/catalogue.js ROLES; the grant is
-- repeated here so that the role is usable the moment this migration commits,
-- without waiting for a seed.
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT r.id, p.id
FROM roles r
JOIN permissions p ON p.module = 'compliance'
WHERE r.code = 'data_protection_officer'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- The platform's own administrator role holds every module in full, and this
-- migration has to say so rather than leave it to the seed. super_administrator
-- is declared in packages/db/src/catalogue.js with the single grant "*", which
-- expandGrants() resolves against every permission that exists when the seed
-- runs. A fresh install, or any re-seed, therefore already holds the whole
-- module. The live role confirms that is the intent and not an accident: it
-- holds every catalogue permission except the twenty-two this file adds. A
-- migration-only deployment (SEED_ON_BOOT=false) never runs that expansion, so
-- without the grant below the role reaches the compliance workspace and is then
-- refused by every write route in it - the register would be unconfigurable by
-- the one role whose job is to configure it.
--
-- The read and export block above deliberately names the functions that examine
-- records instead of anchoring to an administrator, because that anchor also
-- reaches stock, asset and QA auditors, and a breach register is not theirs to
-- open. That reasoning is about not widening auditor access. It is not a reason
-- to withhold the module from the owner role, which holds every other module in
-- full and can already read the register through its own grants.
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT r.id, p.id
FROM roles r
JOIN permissions p ON p.module = 'compliance'
WHERE r.code = 'super_administrator'
ON CONFLICT (role_id, permission_id) DO NOTHING;
