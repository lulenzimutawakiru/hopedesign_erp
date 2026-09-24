-- 0183_payroll_lifecycle.sql
-- Enterprise payroll lifecycle: release, lock, close, reopen, period linkage,
-- approval evidence, audit trail, exception workflow, GL role mapping.
--
-- Additive and idempotent. No existing live column, constraint or index is
-- dropped except the two status CHECKs that must accept the new states.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. payrolls - extended lifecycle states and review/close/reopen bookkeeping
-- ---------------------------------------------------------------------------
ALTER TABLE payrolls DROP CONSTRAINT IF EXISTS payrolls_status_check;
ALTER TABLE payrolls ADD CONSTRAINT payrolls_status_check CHECK (status = ANY (ARRAY[
  'DRAFT'::text,
  'VALIDATING'::text,
  'REVIEW'::text,
  'PENDING_APPROVAL'::text,
  'SUBMITTED'::text,
  'APPROVED'::text,
  'RELEASED'::text,
  'PAID'::text,
  'POSTED'::text,
  'CLOSED'::text,
  'LOCKED'::text,
  'REOPENED'::text,
  'CANCELLED'::text,
  'VOID'::text
]));

ALTER TABLE payrolls ADD COLUMN IF NOT EXISTS payroll_period_id bigint;
ALTER TABLE payrolls ADD COLUMN IF NOT EXISTS reviewed_by bigint;
ALTER TABLE payrolls ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE payrolls ADD COLUMN IF NOT EXISTS closed_by bigint;
ALTER TABLE payrolls ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE payrolls ADD COLUMN IF NOT EXISTS reopened_by bigint;
ALTER TABLE payrolls ADD COLUMN IF NOT EXISTS reopened_at timestamptz;
ALTER TABLE payrolls ADD COLUMN IF NOT EXISTS reopen_count integer NOT NULL DEFAULT 0;
ALTER TABLE payrolls ADD COLUMN IF NOT EXISTS locked_at timestamptz;
ALTER TABLE payrolls ADD COLUMN IF NOT EXISTS variance_explanation text;

CREATE INDEX IF NOT EXISTS idx_payrolls_company_period
  ON payrolls (company_id, period_start DESC, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_payrolls_company_status
  ON payrolls (company_id, status);
CREATE INDEX IF NOT EXISTS idx_payrolls_period_id
  ON payrolls (payroll_period_id);

-- One active regular run per company / period window / payroll group.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payrolls_active_normal_period
  ON payrolls (company_id, period_start, period_end, COALESCE(payroll_group_id, 0))
  WHERE run_type = 'NORMAL' AND status <> ALL (ARRAY['VOID'::text, 'CANCELLED'::text]);

-- ---------------------------------------------------------------------------
-- 2. payroll_items - one line per employee per run (spec 46)
-- ---------------------------------------------------------------------------
DELETE FROM payroll_items a
 USING payroll_items b
 WHERE a.payroll_id = b.payroll_id
   AND a.employee_id = b.employee_id
   AND a.id < b.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_items_run_employee
  ON payroll_items (payroll_id, employee_id);

CREATE INDEX IF NOT EXISTS idx_payroll_items_employee
  ON payroll_items (employee_id, payroll_id);

-- ---------------------------------------------------------------------------
-- 3. payroll_periods - fiscal calendar context and lifecycle bookkeeping
-- ---------------------------------------------------------------------------
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS fiscal_year integer;
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS month integer;
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS statutory_rule_version text;
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS created_by bigint;
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS reviewed_by bigint;
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS approved_by bigint;
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS released_by bigint;
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS released_at timestamptz;
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS closed_by bigint;
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS closed_at timestamptz;

ALTER TABLE payroll_periods DROP CONSTRAINT IF EXISTS payroll_periods_status_check;
ALTER TABLE payroll_periods ADD CONSTRAINT payroll_periods_status_check CHECK (status = ANY (ARRAY[
  'OPEN'::text, 'LOCKED'::text, 'CLOSED'::text, 'CANCELLED'::text
]));

ALTER TABLE payroll_periods DROP CONSTRAINT IF EXISTS payroll_periods_month_check;
ALTER TABLE payroll_periods ADD CONSTRAINT payroll_periods_month_check
  CHECK (month IS NULL OR (month >= 1 AND month <= 12));

CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_periods_company_group_window
  ON payroll_periods (company_id, payroll_group_id, period_start, period_end);

CREATE INDEX IF NOT EXISTS idx_payroll_periods_company_start
  ON payroll_periods (company_id, period_start DESC);

-- ---------------------------------------------------------------------------
-- 4. payroll_approvals - full approval evidence against a live payroll
-- ---------------------------------------------------------------------------
ALTER TABLE payroll_approvals ALTER COLUMN payroll_run_id DROP NOT NULL;
ALTER TABLE payroll_approvals ADD COLUMN IF NOT EXISTS payroll_id bigint;
ALTER TABLE payroll_approvals ADD COLUMN IF NOT EXISTS approval_stage text;
ALTER TABLE payroll_approvals ADD COLUMN IF NOT EXISTS delegated_from_user_id bigint;
ALTER TABLE payroll_approvals ADD COLUMN IF NOT EXISTS previous_status text;
ALTER TABLE payroll_approvals ADD COLUMN IF NOT EXISTS new_status text;
ALTER TABLE payroll_approvals ADD COLUMN IF NOT EXISTS device text;

ALTER TABLE payroll_approvals DROP CONSTRAINT IF EXISTS payroll_approvals_action_check;
ALTER TABLE payroll_approvals ADD CONSTRAINT payroll_approvals_action_check CHECK (action = ANY (ARRAY[
  'SUBMIT'::text, 'REVIEW'::text, 'APPROVE'::text, 'REJECT'::text, 'RETURN'::text,
  'LOCK'::text, 'UNLOCK'::text, 'POST'::text, 'RELEASE'::text, 'PAY'::text,
  'CLOSE'::text, 'REOPEN'::text, 'REVERSE'::text, 'CANCEL'::text
]));

CREATE INDEX IF NOT EXISTS idx_payroll_approvals_payroll
  ON payroll_approvals (payroll_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- 5. payroll_locks - one open lock per payroll
-- ---------------------------------------------------------------------------
ALTER TABLE payroll_locks ALTER COLUMN payroll_run_id DROP NOT NULL;
ALTER TABLE payroll_locks ADD COLUMN IF NOT EXISTS payroll_id bigint;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_locks_open
  ON payroll_locks (payroll_id) WHERE status = 'LOCKED';

-- ---------------------------------------------------------------------------
-- 6. payroll_status_history - workflow timeline against a live payroll
-- ---------------------------------------------------------------------------
ALTER TABLE payroll_status_history ALTER COLUMN payroll_run_id DROP NOT NULL;
ALTER TABLE payroll_status_history ADD COLUMN IF NOT EXISTS payroll_id bigint;
ALTER TABLE payroll_status_history ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE payroll_status_history ADD COLUMN IF NOT EXISTS ip text;

CREATE INDEX IF NOT EXISTS idx_payroll_status_history_payroll
  ON payroll_status_history (payroll_id, changed_at DESC);

-- ---------------------------------------------------------------------------
-- 7. payroll_audit_logs - correlation id and live payroll linkage
-- ---------------------------------------------------------------------------
ALTER TABLE payroll_audit_logs ADD COLUMN IF NOT EXISTS payroll_id bigint;
ALTER TABLE payroll_audit_logs ADD COLUMN IF NOT EXISTS correlation_id text;

CREATE INDEX IF NOT EXISTS idx_payroll_audit_logs_payroll
  ON payroll_audit_logs (payroll_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 8. payroll_exceptions - assignment and resolution evidence (spec 19)
-- ---------------------------------------------------------------------------
ALTER TABLE payroll_exceptions ADD COLUMN IF NOT EXISTS assigned_to bigint;
ALTER TABLE payroll_exceptions ADD COLUMN IF NOT EXISTS assigned_at timestamptz;
ALTER TABLE payroll_exceptions ADD COLUMN IF NOT EXISTS resolution_evidence text;
ALTER TABLE payroll_exceptions ADD COLUMN IF NOT EXISTS reopen_count integer NOT NULL DEFAULT 0;

ALTER TABLE payroll_exceptions DROP CONSTRAINT IF EXISTS payroll_exceptions_status_check;
ALTER TABLE payroll_exceptions ADD CONSTRAINT payroll_exceptions_status_check CHECK (status = ANY (ARRAY[
  'OPEN'::text, 'ASSIGNED'::text, 'UNDER_REVIEW'::text,
  'RESOLVED'::text, 'IGNORED'::text, 'REOPENED'::text
]));

CREATE INDEX IF NOT EXISTS idx_payroll_exceptions_queue
  ON payroll_exceptions (company_id, status, severity);

-- ---------------------------------------------------------------------------
-- 9. payroll_gl_mappings - resolve accounts by accounting role, not just
--    by earnings component (spec 31). Existing component mappings kept.
-- ---------------------------------------------------------------------------
ALTER TABLE payroll_gl_mappings ADD COLUMN IF NOT EXISTS mapping_role text;
ALTER TABLE payroll_gl_mappings ADD COLUMN IF NOT EXISTS branch_id bigint;

ALTER TABLE payroll_gl_mappings DROP CONSTRAINT IF EXISTS payroll_gl_mappings_role_check;
ALTER TABLE payroll_gl_mappings ADD CONSTRAINT payroll_gl_mappings_role_check
  CHECK (mapping_role IS NULL OR mapping_role = ANY (ARRAY[
    'EARNING_EXPENSE'::text,
    'EMPLOYER_NSSF_EXPENSE'::text,
    'EMPLOYER_PENSION_EXPENSE'::text,
    'PAYE_PAYABLE'::text,
    'NSSF_PAYABLE'::text,
    'LST_PAYABLE'::text,
    'STAFF_RECOVERIES'::text,
    'NET_PAY'::text
  ]));

ALTER TABLE payroll_gl_mappings DROP CONSTRAINT IF EXISTS payroll_gl_mappings_target_check;
ALTER TABLE payroll_gl_mappings ADD CONSTRAINT payroll_gl_mappings_target_check
  CHECK (component_id IS NOT NULL OR mapping_role IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_gl_mappings_role
  ON payroll_gl_mappings (company_id, COALESCE(payroll_group_id, 0), mapping_role)
  WHERE mapping_role IS NOT NULL;

COMMIT;
