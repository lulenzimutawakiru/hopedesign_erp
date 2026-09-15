-- ============================================================================
-- 0164 - Organisation Settings (the control plane)
--
-- Organisation Settings is where the organisation is described once and every
-- other module reads that description back. The design rule this file follows
-- is that a setting earns a table of its own only when it must be *versioned*,
-- *allocated* or *lifecycle-managed*. Everything else is a key in
-- `app_settings`, which already carries the whole control plane's machinery:
-- per-tenant/per-company override, `is_secret`, `configuration_history` and an
-- audit entry on every write (see apps/api/src/services/companyConfig.ts).
--
-- So this migration deliberately does NOT recreate the twenty-six suggested
-- tables. Most of them exist and are in use:
--
--   organisations         -> tenants
--   companies/branches/   -> companies, branches, departments, divisions,
--   departments/...          locations, warehouses (+ bins), cost_centres
--   organisation_branding -> company_branding
--   organisation_addresses-> companies + company_profiles
--   fiscal_years / accounting_periods -> fiscal_years, financial_periods
--   tax_rules / tax_categories -> tax_jurisdictions, taxes, tax_rules
--   document_templates/settings -> company_document_templates, app_settings
--   signature_profiles    -> signature_profiles (+ document_signature_records)
--   number_sequences      -> document_numbering_rules, number_sequences
--   delegations / acting / fallback rules -> delegations, delegation_authorities
--   security_policies     -> policies (ABAC), sod_rules, ip_rules, role_templates
--   notification_*        -> notification_templates, notification_preferences
--   integration_*         -> company_integrations, integration_credentials/logs
--   qr_settings           -> qr_settings
--   manufacturing / inventory / hr / attendance / service_desk settings
--                         -> app_settings categories (config, not records)
--   audit_logs            -> audit_logs
--
-- What is genuinely missing, and what this file therefore adds:
--
--   1. tax_rates        - effective-dated tax revisions that freeze on close.
--                         `taxes.rate` is a single mutable number: changing it
--                         silently rewrites history, which AC-ORG-005 forbids.
--   2. tax_categories / tax_exemptions / tax_thresholds
--                       - the rest of the versioned tax vocabulary, so Uganda
--                         rates change by INSERT rather than by code change.
--   3. approval_workflows / approval_levels / approval_rules /
--      approval_fallback_rules
--                       - the approval *definition*. The existing
--                         approval_limits only carries a role's money range;
--                         there is no multi-level workflow, no escalation and
--                         no explicitly configured fallback.
--   4. acting_assignments
--                       - the recorded "who is currently acting as whom", which
--                         delegations (a grant) does not itself model.
--   5. qr_sequences     - concurrency-safe QR allocation. qr_settings is the
--                         format config; nothing yet allocates a number.
--   6. backup_policies  - backup_records is history ("a backup ran"); there is
--                         no policy row saying what *should* run and how long it
--                         is kept.
--   7. security_policies- the enforceable security posture as data, so it can
--                         be changed without a deployment.
--   8. employees.payroll_enabled
--                       - AC-ORG-008. Payroll enrolment is a separate fact from
--                         employee status and from holding a system account, so
--                         the Managing Director can have both a login and
--                         organisational authority without appearing in payroll.
--   9. financial_periods lifecycle columns
--                       - the status vocabulary (OPEN/SOFT_CLOSE/LOCKED/CLOSED)
--                         already exists; the reopen/lock *evidence* does not.
--  10. db_retention_policies.company_id + archive/purge columns
--                       - extended rather than duplicated. A second retention
--                         table beside the existing one would guarantee that
--                         "how long do we keep this?" has two answers.
--
-- Permission model. The `organisation` module is added to
-- packages/db/src/catalogue.js in the same commit. Administrative access is
-- granted to administration roles; *business* authority is granted to the
-- functions that own the subject matter. Configuration authority and approval
-- authority are structurally different things here: `organisation.*` lets a
-- role describe the organisation, and no `organisation.*` grant lets anybody
-- approve a document. Approval is decided by approval_levels, delegations and
-- sod_rules, so a Super Administrator can configure a purchase-approval
-- workflow without thereby being able to approve a purchase order.
-- ============================================================================


-- ---------- 1. Security posture as data ----------
-- Deny-by-default is the posture; this row is where the specifics live. It is
-- one row per company rather than a key/value spread so that "what is our
-- current password policy?" is a SELECT and not a reconstruction.
CREATE TABLE IF NOT EXISTS public.security_policies (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES public.tenants(id),
  company_id BIGINT REFERENCES public.companies(id) ON DELETE CASCADE,

  code TEXT NOT NULL DEFAULT 'DEFAULT',
  name TEXT NOT NULL DEFAULT 'Default security policy',

  mfa_required BOOLEAN NOT NULL DEFAULT false,
  mfa_required_for_admins BOOLEAN NOT NULL DEFAULT true,
  password_min_length INTEGER NOT NULL DEFAULT 12 CHECK (password_min_length BETWEEN 8 AND 128),
  password_require_upper BOOLEAN NOT NULL DEFAULT true,
  password_require_lower BOOLEAN NOT NULL DEFAULT true,
  password_require_digit BOOLEAN NOT NULL DEFAULT true,
  password_require_symbol BOOLEAN NOT NULL DEFAULT true,
  password_expiry_days INTEGER CHECK (password_expiry_days IS NULL OR password_expiry_days BETWEEN 0 AND 3650),
  password_history_count INTEGER NOT NULL DEFAULT 5 CHECK (password_history_count BETWEEN 0 AND 50),

  max_failed_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_failed_attempts BETWEEN 1 AND 100),
  lockout_minutes INTEGER NOT NULL DEFAULT 30 CHECK (lockout_minutes BETWEEN 1 AND 10080),
  session_timeout_minutes INTEGER NOT NULL DEFAULT 30 CHECK (session_timeout_minutes BETWEEN 1 AND 10080),
  idle_timeout_minutes INTEGER CHECK (idle_timeout_minutes IS NULL OR idle_timeout_minutes BETWEEN 1 AND 10080),
  max_concurrent_sessions INTEGER NOT NULL DEFAULT 5 CHECK (max_concurrent_sessions BETWEEN 1 AND 100),

  -- Network and device posture. Stored as arrays/JSONB because "which networks
  -- may reach the ERP?" is a list question, and a comma-joined string cannot be
  -- indexed or validated.
  ip_allowlist TEXT[] NOT NULL DEFAULT '{}',
  ip_denylist TEXT[] NOT NULL DEFAULT '{}',
  device_restrictions JSONB NOT NULL DEFAULT '{}'::jsonb,

  api_require_https BOOLEAN NOT NULL DEFAULT true,
  api_rate_limit_per_minute INTEGER NOT NULL DEFAULT 600 CHECK (api_rate_limit_per_minute BETWEEN 1 AND 100000),
  api_token_ttl_minutes INTEGER NOT NULL DEFAULT 60,

  audit_level TEXT NOT NULL DEFAULT 'STANDARD'
    CHECK (audit_level IN ('MINIMAL','STANDARD','VERBOSE')),
  privileged_access_requires_approval BOOLEAN NOT NULL DEFAULT true,
  privileged_session_recording BOOLEAN NOT NULL DEFAULT false,
  sod_enforced BOOLEAN NOT NULL DEFAULT true,

  is_active BOOLEAN NOT NULL DEFAULT true,
  updated_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT security_policies_scope_unique UNIQUE (tenant_id, company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_security_policies_tenant
  ON public.security_policies(tenant_id, is_active);

-- ---------- 2. Tax vocabulary: categories, versioned rates, exemptions, thresholds ----------

CREATE TABLE IF NOT EXISTS public.tax_categories (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES public.tenants(id),
  company_id BIGINT NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  -- Grouping and precedence: an item may match several categories, and the one
  -- with the highest priority wins. Explicit rather than "the first row the
  -- planner happened to return".
  priority INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tax_categories_code_unique UNIQUE (company_id, code)
);

-- The versioned rate. One row per revision of a tax's rate for a period of
-- time. Append a row to change a rate; never edit a rate that has been used.
-- The freeze triggers below are what make AC-ORG-005 ("historical tax
-- configurations remain immutable") a property of the database rather than a
-- convention the application is asked to respect.
CREATE TABLE IF NOT EXISTS public.tax_rates (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES public.tenants(id),
  company_id BIGINT NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  tax_code TEXT NOT NULL,
  tax_name TEXT NOT NULL,
  tax_type TEXT NOT NULL DEFAULT 'VAT'
    CHECK (tax_type IN ('VAT','PAYE','NSSF','WHT','CORPORATE','EXCISE','STAMP_DUTY','LOCAL_SERVICE','OTHER')),
  category_id BIGINT REFERENCES public.tax_categories(id) ON DELETE SET NULL,
  -- Nullable on purpose: a rule may delegate to the bracket table in
  -- tax_thresholds (PAYE) instead of carrying one flat percentage (VAT).
  rate NUMERIC(9,6) CHECK (rate IS NULL OR (rate >= 0 AND rate <= 100)),
  is_inclusive BOOLEAN NOT NULL DEFAULT false,
  is_compound BOOLEAN NOT NULL DEFAULT false,
  applies_to TEXT NOT NULL DEFAULT 'ALL',
  account_id BIGINT,

  effective_from DATE NOT NULL,
  effective_to DATE,

  -- A revision is a legal instrument. It records where it came from and who
  -- put it here, because tax rates are the one setting a revenue authority may
  -- later ask you to justify.
  source_reference TEXT,
  notes TEXT,

  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('DRAFT','ACTIVE','SUPERSEDED','REVOKED')),
  approved_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,

  created_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT tax_rates_period_valid
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- At most one open (currently in force) revision per tax code per company.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_rates_open_revision
  ON public.tax_rates(tenant_id, company_id, tax_code)
  WHERE effective_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_tax_rates_lookup
  ON public.tax_rates(tenant_id, company_id, tax_code, effective_from DESC);

-- "What was the VAT rate on 2026-03-01?" has to be answerable for any past
-- date, which is the whole point of versioning.
CREATE INDEX IF NOT EXISTS idx_tax_rates_effective
  ON public.tax_rates(company_id, effective_from, effective_to);

-- Overlapping revisions would make that question ambiguous, so they are
-- refused rather than resolved by ordering.
CREATE OR REPLACE FUNCTION public.tax_rates_no_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $func$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.tax_rates t
     WHERE t.tenant_id = NEW.tenant_id
       AND t.company_id = NEW.company_id
       AND t.tax_code = NEW.tax_code
       AND t.id IS DISTINCT FROM NEW.id
       AND daterange(t.effective_from, COALESCE(t.effective_to, 'infinity'::date), '[)')
        && daterange(NEW.effective_from, COALESCE(NEW.effective_to, 'infinity'::date), '[)')
  ) THEN
    RAISE EXCEPTION
      'tax_rates: revision for % effective %..% overlaps an existing revision',
      NEW.tax_code, NEW.effective_from, COALESCE(NEW.effective_to::text, 'open')
      USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END $func$;

DROP TRIGGER IF EXISTS trg_tax_rates_no_overlap ON public.tax_rates;
CREATE TRIGGER trg_tax_rates_no_overlap
  BEFORE INSERT OR UPDATE ON public.tax_rates
  FOR EACH ROW EXECUTE FUNCTION public.tax_rates_no_overlap();

-- Freeze on close. Once a revision carries an effective_to it has been used by
-- at least one calculation, so its substance may not move. The open revision
-- stays editable, which is how a mistake is corrected before it matters.
CREATE OR REPLACE FUNCTION public.tax_rates_freeze_closed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $func$
BEGIN
  IF OLD.effective_to IS NOT NULL THEN
    IF NEW.tax_code IS DISTINCT FROM OLD.tax_code
       OR NEW.tax_type IS DISTINCT FROM OLD.tax_type
       OR NEW.rate IS DISTINCT FROM OLD.rate
       OR NEW.is_inclusive IS DISTINCT FROM OLD.is_inclusive
       OR NEW.is_compound IS DISTINCT FROM OLD.is_compound
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
      RAISE EXCEPTION
        'tax_rates: revision % for % closed on % is immutable; add a new revision instead',
        OLD.id, OLD.tax_code, OLD.effective_to
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END $func$;

DROP TRIGGER IF EXISTS trg_tax_rates_freeze_closed ON public.tax_rates;
CREATE TRIGGER trg_tax_rates_freeze_closed
  BEFORE UPDATE ON public.tax_rates
  FOR EACH ROW EXECUTE FUNCTION public.tax_rates_freeze_closed();

CREATE OR REPLACE FUNCTION public.tax_rates_no_delete_closed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $func$
BEGIN
  IF OLD.effective_to IS NOT NULL THEN
    RAISE EXCEPTION
      'tax_rates: closed revision % for % cannot be deleted', OLD.id, OLD.tax_code
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $func$;

DROP TRIGGER IF EXISTS trg_tax_rates_no_delete_closed ON public.tax_rates;
CREATE TRIGGER trg_tax_rates_no_delete_closed
  BEFORE DELETE ON public.tax_rates
  FOR EACH ROW EXECUTE FUNCTION public.tax_rates_no_delete_closed();

CREATE TABLE IF NOT EXISTS public.tax_exemptions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES public.tenants(id),
  company_id BIGINT NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  tax_code TEXT NOT NULL,
  -- Exemptions attach to a class of thing, not to "everything".
  entity_type TEXT NOT NULL DEFAULT 'CUSTOMER'
    CHECK (entity_type IN ('CUSTOMER','SUPPLIER','PRODUCT','SERVICE','TRANSACTION','ORGANISATION')),
  entity_id BIGINT,
  entity_reference TEXT,
  reason TEXT NOT NULL,
  certificate_reference TEXT,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('DRAFT','ACTIVE','EXPIRED','REVOKED')),
  approved_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tax_exemptions_period_valid
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS idx_tax_exemptions_entity
  ON public.tax_exemptions(tenant_id, company_id, tax_code, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS public.tax_thresholds (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES public.tenants(id),
  company_id BIGINT NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  tax_code TEXT NOT NULL,
  seq INTEGER NOT NULL,
  lower_limit NUMERIC(18,2) NOT NULL DEFAULT 0,
  upper_limit NUMERIC(18,2),
  rate NUMERIC(9,6) NOT NULL CHECK (rate >= 0 AND rate <= 100),
  -- PAYE reliefs are a fixed amount subtracted from the computed tax, not a
  -- reduction in the rate, so they need their own column.
  relief_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  basis TEXT NOT NULL DEFAULT 'MONTHLY'
    CHECK (basis IN ('MONTHLY','ANNUAL','DAILY')),
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tax_thresholds_band_valid
    CHECK (upper_limit IS NULL OR upper_limit > lower_limit),
  CONSTRAINT tax_thresholds_period_valid
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT tax_thresholds_seq_unique UNIQUE (company_id, tax_code, basis, effective_from, seq)
);

CREATE INDEX IF NOT EXISTS idx_tax_thresholds_lookup
  ON public.tax_thresholds(tenant_id, company_id, tax_code, basis, effective_from DESC, seq);




-- ---------- 3. Approval definition: workflows, levels, rules, fallbacks ----------
-- approval_limits already answers 'how much may this role approve?'. It cannot
-- answer 'in what order, over how many levels, and who approves when the named
-- approver is unavailable'. Those are definitions rather than limits, so they
-- get their own tables.
--
-- The load-bearing constraint in this section is that a fallback approver must
-- be named explicitly. Nothing here, and nothing in the service layer, ever
-- promotes a missing approver into an administrator. An approval whose named
-- approver is unreachable and has no configured fallback fails closed.

CREATE TABLE IF NOT EXISTS public.approval_workflows (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES public.tenants(id),
  company_id BIGINT NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  document_type TEXT NOT NULL,
  description TEXT,
  -- Lower sorts first. Two workflows may target the same document_type when
  -- their amount bands differ, so this is deliberately not part of a unique key
  -- together with document_type.
  priority INTEGER NOT NULL DEFAULT 100,
  min_amount NUMERIC(18,2),
  max_amount NUMERIC(18,2),
  scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  created_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT approval_workflows_code_unique UNIQUE (company_id, code),
  CONSTRAINT approval_workflows_band_valid
    CHECK (max_amount IS NULL OR min_amount IS NULL OR max_amount >= min_amount),
  CONSTRAINT approval_workflows_period_valid
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS idx_approval_workflows_lookup
  ON public.approval_workflows(tenant_id, company_id, document_type, priority)
  WHERE is_active;

CREATE TABLE IF NOT EXISTS public.approval_levels (
  id BIGSERIAL PRIMARY KEY,
  workflow_id BIGINT NOT NULL REFERENCES public.approval_workflows(id) ON DELETE CASCADE,
  tenant_id BIGINT NOT NULL REFERENCES public.tenants(id),
  company_id BIGINT NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  level_no INTEGER NOT NULL CHECK (level_no > 0),
  name TEXT NOT NULL,
  -- A level names a role, a person, or both. Naming both is the common case:
  -- the role is the pool that may approve, the user is the default holder.
  approver_role_id BIGINT REFERENCES public.roles(id) ON DELETE SET NULL,
  approver_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  required_approvals INTEGER NOT NULL DEFAULT 1 CHECK (required_approvals > 0),
  is_optional BOOLEAN NOT NULL DEFAULT false,
  allow_delegation BOOLEAN NOT NULL DEFAULT true,
  sla_hours INTEGER CHECK (sla_hours IS NULL OR sla_hours > 0),
  escalate_to_level_no INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT approval_levels_seq_unique UNIQUE (workflow_id, level_no),
  -- A level that names nobody can never be satisfied, so it would silently
  -- block every document of that type. Reject it at definition time.
  CONSTRAINT approval_levels_has_approver
    CHECK (approver_role_id IS NOT NULL OR approver_user_id IS NOT NULL),
  CONSTRAINT approval_levels_escalation_not_self
    CHECK (escalate_to_level_no IS NULL OR escalate_to_level_no <> level_no)
);

CREATE INDEX IF NOT EXISTS idx_approval_levels_workflow
  ON public.approval_levels(workflow_id, level_no);

CREATE INDEX IF NOT EXISTS idx_approval_levels_role
  ON public.approval_levels(tenant_id, company_id, approver_role_id)
  WHERE approver_role_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.approval_rules (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES public.tenants(id),
  company_id BIGINT NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  workflow_id BIGINT NOT NULL REFERENCES public.approval_workflows(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  condition JSONB NOT NULL DEFAULT '{}'::jsonb,
  priority INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT approval_rules_code_unique UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_approval_rules_lookup
  ON public.approval_rules(tenant_id, company_id, subject_type, priority)
  WHERE is_active;

CREATE TABLE IF NOT EXISTS public.approval_fallback_rules (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES public.tenants(id),
  company_id BIGINT NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  workflow_id BIGINT REFERENCES public.approval_workflows(id) ON DELETE CASCADE,
  level_id BIGINT REFERENCES public.approval_levels(id) ON DELETE CASCADE,
  -- The authority being stood in for...
  primary_role_id BIGINT REFERENCES public.roles(id) ON DELETE SET NULL,
  primary_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  -- ...and the explicitly named stand-in.
  fallback_role_id BIGINT REFERENCES public.roles(id) ON DELETE SET NULL,
  fallback_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  -- A fallback is always time-boxed. Without an end date it stops being a
  -- fallback and becomes a silent permanent promotion, which is the thing this
  -- table exists to prevent.
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to TIMESTAMPTZ NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  approved_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT approval_fallback_primary_named
    CHECK (primary_role_id IS NOT NULL OR primary_user_id IS NOT NULL),
  CONSTRAINT approval_fallback_fallback_named
    CHECK (fallback_role_id IS NOT NULL OR fallback_user_id IS NOT NULL),
  CONSTRAINT approval_fallback_timeboxed CHECK (effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS idx_approval_fallback_rules_active
  ON public.approval_fallback_rules(tenant_id, company_id, effective_to)
  WHERE is_active;


-- ---------- 4. Acting assignments ----------
-- delegations records a *grant* ('X may act for Y'). This records the
-- assignment as it is actually in force, with an end date a scheduled sweep
-- enforces, and it is what the audit trail cites when it writes
-- 'Acting on behalf of <principal>'.

CREATE TABLE IF NOT EXISTS public.acting_assignments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES public.tenants(id),
  company_id BIGINT NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  delegation_id BIGINT REFERENCES public.delegations(id) ON DELETE SET NULL,
  acting_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  principal_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  acting_role_id BIGINT REFERENCES public.roles(id) ON DELETE SET NULL,
  principal_role_id BIGINT REFERENCES public.roles(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  authority_scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  restrictions JSONB NOT NULL DEFAULT '{}'::jsonb,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','ACTIVE','EXPIRED','REVOKED')),
  reason TEXT,
  approved_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  revoked_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acting_assignments_window_valid CHECK (ends_at > starts_at),
  CONSTRAINT acting_assignments_principal_named
    CHECK (principal_user_id IS NOT NULL OR principal_role_id IS NOT NULL),
  -- Acting for yourself is a configuration mistake, never an assignment.
  CONSTRAINT acting_assignments_not_self
    CHECK (principal_user_id IS NULL OR principal_user_id <> acting_user_id)
);

CREATE INDEX IF NOT EXISTS idx_acting_assignments_actor
  ON public.acting_assignments(tenant_id, acting_user_id, status, ends_at DESC);

CREATE INDEX IF NOT EXISTS idx_acting_assignments_active
  ON public.acting_assignments(tenant_id, company_id, ends_at)
  WHERE status = 'ACTIVE';

-- AC-ORG-007: delegated authority expires on its own. This sweep mirrors
-- governance_expire_delegations() so an operator reads one pattern for both.
CREATE OR REPLACE FUNCTION public.organisation_expire_acting_assignments()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.acting_assignments
     SET status = 'EXPIRED',
         updated_by = NULL,
         updated_at = now()
   WHERE status = 'ACTIVE'
     AND ends_at <= now()
   RETURNING 1 INTO v_count;
  RETURN COALESCE(v_count, 0);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.organisation_expire_acting_assignments() TO hopedesign_app;


-- ---------- 5. QR and traceability allocation ----------
-- qr_settings (already present) holds the *format*. Nothing yet hands out the
-- next number, so two operators scanning stock in at the same moment could mint
-- the same label. allocate_qr_number() below is the only supported way to get
-- one, and it is deliberately modelled on the document-number allocator rather
-- than on SELECT-then-UPDATE.

CREATE TABLE IF NOT EXISTS public.qr_sequences (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES public.tenants(id),
  company_id BIGINT NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  include_year BOOLEAN NOT NULL DEFAULT true,
  pad_length INTEGER NOT NULL DEFAULT 6 CHECK (pad_length BETWEEN 1 AND 12),
  start_seq BIGINT NOT NULL DEFAULT 1 CHECK (start_seq > 0),
  -- Reset vocabulary mirrors document_numbering_rules so an operator reads one
  -- set of words across documents and labels.
  reset_frequency TEXT NOT NULL DEFAULT 'YEARLY'
    CHECK (reset_frequency IN ('NEVER','YEARLY','MONTHLY','DAILY')),
  last_seq BIGINT NOT NULL DEFAULT 0,
  -- Period key in the same shape the reset_frequency produces ('2026', '2026-09'
  -- or '2026-09-15'). One column rather than separate year/month/day columns so
  -- that a frequency change cannot leave stale half-populated state behind.
  last_period TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT qr_sequences_code_unique UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_qr_sequences_tenant
  ON public.qr_sequences(tenant_id, company_id, code);

-- Concurrency safety comes from doing the decision and the increment in one
-- statement. The UPDATE takes a row lock; a second caller blocks on it and then
-- re-evaluates its own CASE against the committed value (EvalPlanQual under
-- READ COMMITTED), so no two callers can observe the same last_seq. This is the
-- same argument that makes the document-number allocator safe.
CREATE OR REPLACE FUNCTION public.allocate_qr_number(
  p_tenant_id BIGINT,
  p_company_id BIGINT,
  p_code TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_rec public.qr_sequences%ROWTYPE;
BEGIN
  UPDATE public.qr_sequences
     SET last_seq = CASE
                      WHEN last_seq = 0 THEN start_seq
                      WHEN reset_frequency = 'NEVER' THEN last_seq + 1
                      WHEN reset_frequency = 'DAILY'
                           AND last_period IS DISTINCT FROM to_char(now(), 'YYYY-MM-DD') THEN start_seq
                      WHEN reset_frequency = 'MONTHLY'
                           AND last_period IS DISTINCT FROM to_char(now(), 'YYYY-MM') THEN start_seq
                      WHEN reset_frequency = 'YEARLY'
                           AND last_period IS DISTINCT FROM to_char(now(), 'YYYY') THEN start_seq
                      ELSE last_seq + 1
                    END,
         last_period = CASE reset_frequency
                         WHEN 'NEVER' THEN COALESCE(last_period, to_char(now(), 'YYYY'))
                         WHEN 'DAILY' THEN to_char(now(), 'YYYY-MM-DD')
                         WHEN 'MONTHLY' THEN to_char(now(), 'YYYY-MM')
                         ELSE to_char(now(), 'YYYY')
                       END,
         updated_at = now()
   WHERE tenant_id = p_tenant_id
     AND company_id = p_company_id
     AND code = p_code
     AND is_active
  RETURNING last_seq, prefix, pad_length, include_year, last_period
       INTO v_rec.last_seq, v_rec.prefix, v_rec.pad_length, v_rec.include_year, v_rec.last_period;

  -- Fail closed: an unconfigured or disabled sequence must never silently mint
  -- a label that nothing can resolve later.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'QR sequence % is not configured or is inactive for company %', p_code, p_company_id
      USING ERRCODE = 'no_data_found';
  END IF;

  RETURN v_rec.prefix
       || CASE WHEN v_rec.include_year THEN '-' || left(COALESCE(v_rec.last_period, to_char(now(), 'YYYY')), 4) ELSE '' END
       || '-' || lpad(v_rec.last_seq::text, v_rec.pad_length, '0');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.allocate_qr_number(BIGINT, BIGINT, TEXT) TO hopedesign_app;


-- ---------- 6. Backup policy ----------
-- backup_records is history ('a backup ran, here is the outcome'). This is the
-- policy: what should run, how often, and how long it is kept. Without it,
-- 'are we compliant on backups?' has no answer that is not a guess.

CREATE TABLE IF NOT EXISTS public.backup_policies (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES public.tenants(id),
  company_id BIGINT NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'DATABASE'
    CHECK (scope IN ('DATABASE','DOCUMENTS','FILES','CONFIGURATION','FULL')),
  frequency TEXT NOT NULL DEFAULT 'DAILY'
    CHECK (frequency IN ('HOURLY','DAILY','WEEKLY','MONTHLY')),
  run_at TIME NOT NULL DEFAULT '02:00',
  retention_count INTEGER CHECK (retention_count IS NULL OR retention_count > 0),
  retention_days INTEGER CHECK (retention_days IS NULL OR retention_days > 0),
  encryption_required BOOLEAN NOT NULL DEFAULT true,
  offsite_required BOOLEAN NOT NULL DEFAULT true,
  verify_restore BOOLEAN NOT NULL DEFAULT true,
  -- Recovery objectives, so a restore drill has something to be measured
  -- against rather than an opinion.
  rpo_minutes INTEGER CHECK (rpo_minutes IS NULL OR rpo_minutes > 0),
  rto_minutes INTEGER CHECK (rto_minutes IS NULL OR rto_minutes > 0),
  destination TEXT,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT backup_policies_code_unique UNIQUE (company_id, code),
  -- A retention policy that states no retention is not a policy.
  CONSTRAINT backup_policies_retention_present
    CHECK (retention_count IS NOT NULL OR retention_days IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_backup_policies_active
  ON public.backup_policies(tenant_id, company_id, scope)
  WHERE is_active;


-- ---------- 7. Extending the tables that were already almost right ----------
-- These three are extended rather than duplicated. A second retention table, a
-- second period table or a second payroll-enrolment flag beside the existing
-- ones would guarantee that 'how long do we keep this?', 'is this period
-- closed?' and 'is this person on payroll?' each have two answers.

-- 7a. Retention policies gain the columns the spec needs. purge_action is the
-- important one: it makes 'what happens when the clock runs out' explicit, so
-- nothing has to infer 'delete' as a default.
ALTER TABLE public.db_retention_policies
  ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES public.companies(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS code TEXT,
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS archive_after_days INTEGER,
  ADD COLUMN IF NOT EXISTS purge_action TEXT NOT NULL DEFAULT 'RETAIN',
  ADD COLUMN IF NOT EXISTS legal_basis TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL;

DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'db_retention_policies_purge_action_check'
       AND conrelid = 'public.db_retention_policies'::regclass
  ) THEN
    ALTER TABLE public.db_retention_policies
      ADD CONSTRAINT db_retention_policies_purge_action_check
      CHECK (purge_action IN ('RETAIN','ARCHIVE','ANONYMISE','DELETE'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'db_retention_policies_archive_after_check'
       AND conrelid = 'public.db_retention_policies'::regclass
  ) THEN
    ALTER TABLE public.db_retention_policies
      ADD CONSTRAINT db_retention_policies_archive_after_check
      CHECK (archive_after_days IS NULL OR archive_after_days >= 0);
  END IF;
END;
$mig$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_db_retention_policies_code
  ON public.db_retention_policies(tenant_id, company_id, code)
  WHERE code IS NOT NULL;

-- 7b. Period lifecycle evidence. The status vocabulary (OPEN / SOFT_CLOSE /
-- LOCKED / CLOSED) already exists in financial_periods_status_check; what was
-- missing is who locked it, when, and whether it has ever been reopened, which
-- is the question an auditor actually asks about a closed period.
ALTER TABLE public.financial_periods
  ADD COLUMN IF NOT EXISTS locked_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reopened_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reopened_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_reopened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_reason TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- 7c. AC-ORG-008. Payroll enrolment is a separate fact from employee status and
-- from holding a system account. A Managing Director can therefore have a login
-- and organisational authority without appearing in a payroll run. Explicit
-- false default: nobody joins payroll by omission.
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS payroll_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payroll_group TEXT,
  ADD COLUMN IF NOT EXISTS payment_method TEXT,
  ADD COLUMN IF NOT EXISTS payroll_currency TEXT;

DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'employees_payment_method_check'
       AND conrelid = 'public.employees'::regclass
  ) THEN
    ALTER TABLE public.employees
      ADD CONSTRAINT employees_payment_method_check
      CHECK (payment_method IS NULL
             OR payment_method IN ('BANK','MOBILE_MONEY','CASH','CHEQUE'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'employees_payroll_currency_check'
       AND conrelid = 'public.employees'::regclass
  ) THEN
    ALTER TABLE public.employees
      ADD CONSTRAINT employees_payroll_currency_check
      CHECK (payroll_currency IS NULL OR char_length(payroll_currency) = 3);
  END IF;
END;
$mig$;

CREATE INDEX IF NOT EXISTS idx_employees_payroll_enabled
  ON public.employees(tenant_id, company_id)
  WHERE payroll_enabled;


-- ---------- 8. Triggers and row-level isolation ----------
-- Every table added above is a configuration table, which means two things
-- uniformly: it must carry an updated_at that is actually maintained, and every
-- write to it must land in audit_logs. Doing this in a loop keeps the three
-- properties (timestamp, audit, tenant isolation) impossible to forget on one
-- table while remembering them on the others.

-- financial_periods gained an updated_at in section 7b; nothing was maintaining
-- it before, so give it the same trigger every other mutable table has.
DROP TRIGGER IF EXISTS trg_set_updated_at ON public.financial_periods;
CREATE TRIGGER trg_set_updated_at
  BEFORE UPDATE ON public.financial_periods
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DO $mig$
DECLARE
  t TEXT;
  v_tables TEXT[] := ARRAY[
    'security_policies',
    'tax_categories',
    'tax_rates',
    'tax_exemptions',
    'tax_thresholds',
    'approval_workflows',
    'approval_levels',
    'approval_rules',
    'approval_fallback_rules',
    'acting_assignments',
    'qr_sequences',
    'backup_policies'
  ];
BEGIN
  FOREACH t IN ARRAY v_tables LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_set_updated_at ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);

    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%s_audit ON public.%I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.audit_row()', t, t);

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'USING (tenant_id = public.app_tenant_id())', t);
  END LOOP;
END;
$mig$;


-- ---------- 9. The organisation permission module ----------
-- Administrative access and business authority are deliberately different
-- things. These codes let a role describe the organisation. None of them
-- permits approving a document, and none of them is a substitute for the
-- approval, delegation and SoD machinery: a Super Administrator can configure
-- the purchase-approval workflow without thereby being able to approve a
-- purchase order.

INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, 'organisation', v.resource, v.action, v.description
FROM (VALUES
  ('organisation.settings.view','settings','view','View organisation settings'),
  ('organisation.settings.create','settings','create','Create organisation settings'),
  ('organisation.settings.update','settings','update','Update organisation settings'),
  ('organisation.settings.delete','settings','delete','Delete organisation settings'),
  ('organisation.structure.manage','structure','manage','Manage companies, branches, departments, divisions, locations, warehouses and cost centres'),
  ('organisation.tax.manage','tax','manage','Manage tax rules, rates, categories, exemptions and thresholds'),
  ('organisation.finance.manage','finance','manage','Manage fiscal years, accounting periods and period locking'),
  ('organisation.payroll.manage','payroll','manage','Manage payroll settings, PAYE and NSSF rules and payroll enrolment'),
  ('organisation.documents.manage','documents','manage','Manage document settings, templates, numbering and signature profiles'),
  ('organisation.security.manage','security','manage','Manage security policies, password and session rules and privileged access'),
  ('organisation.integrations.manage','integrations','manage','Manage integration registry, credentials and health'),
  ('organisation.qr.manage','qr','manage','Manage QR formats, sequences, statuses and traceability rules'),
  ('organisation.manufacturing.manage','manufacturing','manage','Manage production plants, machines, work centres, shifts and BOM rules'),
  ('organisation.inventory.manage','inventory','manage','Manage warehouses, units, valuation, tracking and reorder rules'),
  ('organisation.hr.manage','hr','manage','Manage HR structures, leave, positions and employment configuration'),
  ('organisation.attendance.manage','attendance','manage','Manage attendance devices, shifts, policies and corrections'),
  ('organisation.audit.view','audit','view','View configuration audit history and change records')
) AS v(code, resource, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

-- Grants are explicit code lists, never wildcards: reading a role's grants
-- should tell you exactly what it may do.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'organisation.settings.view', 'organisation.settings.create', 'organisation.settings.update',
  'organisation.settings.delete', 'organisation.structure.manage', 'organisation.tax.manage',
  'organisation.finance.manage', 'organisation.payroll.manage', 'organisation.documents.manage',
  'organisation.security.manage', 'organisation.integrations.manage', 'organisation.qr.manage',
  'organisation.manufacturing.manage', 'organisation.inventory.manage', 'organisation.hr.manage',
  'organisation.attendance.manage', 'organisation.audit.view'
])
WHERE r.code IN ('super_administrator')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'organisation.settings.view', 'organisation.settings.update',
  'organisation.structure.manage', 'organisation.documents.manage',
  'organisation.security.manage', 'organisation.integrations.manage',
  'organisation.audit.view'
])
WHERE r.code IN ('system_administrator')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'organisation.settings.view', 'organisation.security.manage',
  'organisation.audit.view'
])
WHERE r.code IN ('security_administrator')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'organisation.settings.view', 'organisation.integrations.manage'
])
WHERE r.code IN ('integration_administrator')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'organisation.settings.view', 'organisation.audit.view'
])
WHERE r.code IN ('audit_administrator', 'data_protection_officer', 'backup_administrator')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'organisation.settings.view', 'organisation.finance.manage',
  'organisation.tax.manage', 'organisation.audit.view'
])
WHERE r.code IN ('cfo', 'finance_manager', 'chief_accountant', 'financial_controller')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'organisation.settings.view', 'organisation.tax.manage'
])
WHERE r.code IN ('tax_officer')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'organisation.settings.view', 'organisation.payroll.manage'
])
WHERE r.code IN ('payroll_manager', 'payroll_accountant')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'organisation.settings.view', 'organisation.hr.manage', 'organisation.attendance.manage'
])
WHERE r.code IN ('hr_director', 'hr_manager')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'organisation.settings.view', 'organisation.manufacturing.manage', 'organisation.inventory.manage'
])
WHERE r.code IN ('production_director', 'production_manager', 'quality_manager', 'security_printing_director')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'organisation.settings.view', 'organisation.inventory.manage'
])
WHERE r.code IN ('warehouse_manager', 'inventory_controller', 'supply_chain_manager')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'organisation.settings.view', 'organisation.qr.manage'
])
WHERE r.code IN ('security_printing_manager', 'secure_stock_controller')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY(ARRAY[
  'organisation.settings.view', 'organisation.documents.manage'
])
WHERE r.code IN ('service_desk_manager')
ON CONFLICT (role_id, permission_id) DO NOTHING;


-- ---------- 10. Seeds ----------
-- Every seed is written so it can be re-run: each is guarded by a NOT EXISTS
-- against the natural key, so applying this migration to an environment that
-- already has the rows leaves them untouched. Nothing here overwrites an
-- operator's edit.

-- 10a. Security posture. One row per company, carrying the deny-by-default
-- posture described above.
INSERT INTO public.security_policies (tenant_id, company_id, code, name)
SELECT c.tenant_id, c.id, 'DEFAULT', 'Default security policy'
FROM public.companies c
WHERE NOT EXISTS (
  SELECT 1 FROM public.security_policies sp
   WHERE sp.tenant_id = c.tenant_id AND sp.company_id = c.id AND sp.code = 'DEFAULT'
);

-- 10b. Tax categories.
INSERT INTO public.tax_categories (tenant_id, company_id, code, name, description, priority)
SELECT c.tenant_id, c.id, v.code, v.name, v.description, v.priority
FROM public.companies c
CROSS JOIN (VALUES
  ('STANDARD',     'Standard rate', 'Taxable supplies at the standard rate', 10),
  ('EXEMPT',       'Exempt',        'Supplies exempt from VAT', 20),
  ('ZERO',         'Zero rated',    'Zero-rated supplies', 30),
  ('OUT_OF_SCOPE', 'Out of scope',  'Not a taxable supply', 40)
) AS v(code, name, description, priority)
WHERE NOT EXISTS (
  SELECT 1 FROM public.tax_categories tc
   WHERE tc.tenant_id = c.tenant_id AND tc.company_id = c.id AND tc.code = v.code
);

-- 10c. Initial tax rate revisions, effective 2026-07-01 and left open
-- (effective_to IS NULL) so a later change appends a closing revision rather
-- than editing this one.
INSERT INTO public.tax_rates (
  tenant_id, company_id, tax_code, tax_name, tax_type, category_id, rate,
  applies_to, effective_from, source_reference, notes)
SELECT c.tenant_id, c.id, v.tax_code, v.tax_name, v.tax_type, tc.id, v.rate,
       v.applies_to, DATE '2026-07-01', v.source_reference, v.notes
FROM public.companies c
CROSS JOIN (VALUES
  ('VAT_STANDARD', 'VAT (standard rate)',      'VAT', 18, 'ALL',      'STANDARD', 'Uganda VAT Act - standard rate', 'Domestic taxable supplies of goods and services.'),
  ('VAT_ZERO',     'VAT (zero rated)',         'VAT',  0, 'ALL',      'ZERO',     'Uganda VAT Act - zero rated',    'Zero-rated supplies, including qualifying exports.'),
  ('WHT_SERVICES', 'Withholding tax (services)','WHT', 6, 'SERVICES', 'STANDARD', 'Uganda Income Tax Act - WHT',    'Withheld on payment for services to a non-exempt supplier.'),
  ('WHT_RENT',     'Withholding tax (rent)',   'WHT', 10, 'RENT',     'STANDARD', 'Uganda Income Tax Act - WHT',    'Withheld on rental payments.')
) AS v(tax_code, tax_name, tax_type, rate, applies_to, category_code, source_reference, notes)
LEFT JOIN public.tax_categories tc
  ON tc.company_id = c.id AND tc.code = v.category_code
WHERE NOT EXISTS (
  SELECT 1 FROM public.tax_rates tr
   WHERE tr.tenant_id = c.tenant_id AND tr.company_id = c.id
     AND tr.tax_code = v.tax_code AND tr.effective_from = DATE '2026-07-01'
);

-- 10d. PAYE bands. Uganda applies the monthly bands progressively, which is why
-- this lives in tax_thresholds rather than as a single percentage on tax_rates.
INSERT INTO public.tax_thresholds (
  tenant_id, company_id, tax_code, seq, lower_limit, upper_limit, rate,
  relief_amount, basis, effective_from)
SELECT c.tenant_id, c.id, 'PAYE_MONTHLY', v.seq, v.lower_limit, v.upper_limit,
       v.rate, 0, 'MONTHLY', DATE '2026-07-01'
FROM public.companies c
CROSS JOIN (VALUES
  (1, 0::numeric,       235000::numeric,  0::numeric),
  (2, 235000::numeric,  335000::numeric, 10::numeric),
  (3, 335000::numeric,  410000::numeric, 20::numeric),
  (4, 410000::numeric,  NULL::numeric,   30::numeric)
) AS v(seq, lower_limit, upper_limit, rate)
WHERE NOT EXISTS (
  SELECT 1 FROM public.tax_thresholds tt
   WHERE tt.tenant_id = c.tenant_id AND tt.company_id = c.id
     AND tt.tax_code = 'PAYE_MONTHLY' AND tt.effective_from = DATE '2026-07-01'
);

-- 10e. QR sequences. Prefixes match the stock-code conventions the factory
-- already uses (HDG-RAW / HDG-WIP / HDG-FG / HDG-PAL).
INSERT INTO public.qr_sequences (
  tenant_id, company_id, code, name, prefix, include_year, pad_length, reset_frequency)
SELECT c.tenant_id, c.id, v.code, v.name, v.prefix, true, 6, 'YEARLY'
FROM public.companies c
CROSS JOIN (VALUES
  ('MATERIAL',      'Raw material',   'HDG-RAW'),
  ('WIP',           'Work in progress','HDG-WIP'),
  ('FINISHED_GOOD', 'Finished goods', 'HDG-FG'),
  ('PALLET',        'Pallet / ream',  'HDG-PAL'),
  ('ASSET',         'Fixed asset',    'HDG-AST')
) AS v(code, name, prefix)
WHERE NOT EXISTS (
  SELECT 1 FROM public.qr_sequences q
   WHERE q.tenant_id = c.tenant_id AND q.company_id = c.id AND q.code = v.code
);

-- 10f. Retention. Statutory categories are held under legal hold and are never
-- purged; operational history is archived rather than deleted.
INSERT INTO public.db_retention_policies (
  tenant_id, company_id, category, code, name, retention_days, legal_hold,
  applies_to, purge_action, legal_basis, notes)
SELECT c.tenant_id, c.id, v.category, v.code, v.name, v.retention_days,
       v.legal_hold, v.applies_to, v.purge_action, v.legal_basis, v.notes
FROM public.companies c
CROSS JOIN (VALUES
  ('AUDIT_TRAIL', 'AUDIT_TRAIL', 'Audit trail',               3650, true,  'audit_logs',   'RETAIN',   'Statutory audit and accountability obligation', 'Never purged while under legal hold.'),
  ('FINANCIAL',   'FINANCIAL',   'Financial records',         3650, true,  'finance',      'RETAIN',   'Companies Act and URA record-keeping',          'Ledgers, statements and tax returns.'),
  ('PAYROLL',     'PAYROLL',     'Payroll records',           3650, true,  'payroll',      'RETAIN',   'Employment, NSSF and URA obligations',          'Payslips and statutory returns.'),
  ('DOCUMENTS',   'DOCUMENTS',   'Documents',                 2555, false, 'documents',    'ARCHIVE',  'Contractual and commercial',                    'Archive to cold storage, do not delete.'),
  ('TICKETS',     'TICKETS',     'Service desk tickets',      1095, false, 'service_desk', 'ARCHIVE',  'Operational',                                   'Closed tickets older than the window are archived.'),
  ('QR_HISTORY',  'QR_HISTORY',  'QR / traceability history', 1095, false, 'qr',           'RETAIN',   'Product traceability',                          'Scan history is evidence; retain, never purge.')
) AS v(category, code, name, retention_days, legal_hold, applies_to, purge_action, legal_basis, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM public.db_retention_policies rp
   WHERE rp.tenant_id = c.tenant_id AND rp.company_id = c.id AND rp.code = v.code
);

-- 10g. A purchase-order approval workflow, so the module ships with a real
-- two-level definition rather than an empty screen. Level 2 names the CFO role;
-- an operator replaces that with their actual signatory. No fallback is seeded:
-- a fallback is a time-boxed operational decision, not a default.
INSERT INTO public.approval_workflows (
  tenant_id, company_id, code, name, document_type, description, priority)
SELECT c.tenant_id, c.id, 'PO_STANDARD', 'Purchase order approval',
       'PURCHASE_ORDER',
       'Procurement management approval, then finance or executive approval.',
       100
FROM public.companies c
WHERE NOT EXISTS (
  SELECT 1 FROM public.approval_workflows w
   WHERE w.tenant_id = c.tenant_id AND w.company_id = c.id AND w.code = 'PO_STANDARD'
);

INSERT INTO public.approval_levels (
  workflow_id, tenant_id, company_id, level_no, name, approver_role_id,
  required_approvals, sla_hours)
SELECT w.id, w.tenant_id, w.company_id, v.level_no, v.name, r.id, 1, v.sla_hours
FROM public.approval_workflows w
CROSS JOIN (VALUES
  (1, 'Procurement management', 'procurement_manager', 24),
  (2, 'Finance / executive',    'cfo',                  48)
) AS v(level_no, name, role_code, sla_hours)
JOIN public.roles r
  ON r.code = v.role_code
 AND r.tenant_id = w.tenant_id
 AND r.company_id = w.company_id
WHERE w.code = 'PO_STANDARD'
  AND NOT EXISTS (
    SELECT 1 FROM public.approval_levels al
     WHERE al.workflow_id = w.id AND al.level_no = v.level_no
  );

-- 10h. Backup policy. Conservative defaults: daily, encrypted, offsite, and
-- restore-verified. An operator adjusts the destination and cadence; what they
-- should not have to invent is whether backups are encrypted.
INSERT INTO public.backup_policies (
  tenant_id, company_id, code, name, scope, frequency, run_at,
  retention_count, retention_days, encryption_required, offsite_required,
  verify_restore, rpo_minutes, rto_minutes, destination, notes)
SELECT c.tenant_id, c.id, v.code, v.name, v.scope, v.frequency, v.run_at::time,
       v.retention_count, v.retention_days, true, true, true,
       v.rpo_minutes, v.rto_minutes, NULL, v.notes
FROM public.companies c
CROSS JOIN (VALUES
  ('DB_DAILY', 'Database (daily)', 'DATABASE', 'DAILY', '02:00', 35, 90, 60, 240,
   'Full logical backup of the application database.'),
  ('DOCS_DAILY', 'Documents and files (daily)', 'DOCUMENTS', 'DAILY', '02:30', 35, 90, 120, 480,
   'Generated documents, uploads and signed PDFs.')
) AS v(code, name, scope, frequency, run_at, retention_count, retention_days, rpo_minutes, rto_minutes, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM public.backup_policies bp
   WHERE bp.tenant_id = c.tenant_id AND bp.company_id = c.id AND bp.code = v.code
);
