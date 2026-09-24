-- 0185_statutory_filings.sql
-- Statutory return lifecycle: a filing is prepared, submitted, accepted and
-- settled against the liabilities a payroll run calculated.
--
-- statutory_submissions was declared against statutory_rules /
-- statutory_rule_versions, a rule-versioning model the payroll engine never
-- adopted. PAYE, NSSF and LST are versioned in statutory_configs instead,
-- so statutory_rule_id was NOT NULL against an empty table and no code path
-- could ever insert a filing: the compliance centre read a table that was
-- permanently empty. This migration points the table at the model the engine
-- actually uses and adds the columns the centre needs to take a return from
-- prepared through submitted and paid to reconciled.
--
-- Additive and idempotent. No existing column is dropped and no existing row
-- changes meaning: PENDING/SUBMITTED/PAID/LATE all remain valid statuses.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The rule reference becomes optional and gains what the engine resolved
-- ---------------------------------------------------------------------------
ALTER TABLE statutory_submissions ALTER COLUMN statutory_rule_id DROP NOT NULL;
ALTER TABLE statutory_submissions ADD COLUMN IF NOT EXISTS statutory_config_id bigint REFERENCES statutory_configs(id);
ALTER TABLE statutory_submissions ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE statutory_submissions ADD COLUMN IF NOT EXISTS payroll_id bigint REFERENCES payrolls(id);
ALTER TABLE statutory_submissions ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'UGX';
ALTER TABLE statutory_submissions ADD COLUMN IF NOT EXISTS tax_period text;
ALTER TABLE statutory_submissions ADD COLUMN IF NOT EXISTS prepared_at timestamptz;
ALTER TABLE statutory_submissions ADD COLUMN IF NOT EXISTS prepared_by bigint REFERENCES users(id);
ALTER TABLE statutory_submissions ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
ALTER TABLE statutory_submissions ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE statutory_submissions ADD COLUMN IF NOT EXISTS payment_date date;
ALTER TABLE statutory_submissions ADD COLUMN IF NOT EXISTS payment_reference text;
ALTER TABLE statutory_submissions ADD COLUMN IF NOT EXISTS reconciled_amount numeric(18,2);
ALTER TABLE statutory_submissions ADD COLUMN IF NOT EXISTS variance_amount numeric(18,2);
ALTER TABLE statutory_submissions ADD COLUMN IF NOT EXISTS evidence_document_id bigint;
ALTER TABLE statutory_submissions ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE statutory_submissions ADD COLUMN IF NOT EXISTS approved_by bigint REFERENCES users(id);
ALTER TABLE statutory_submissions ADD COLUMN IF NOT EXISTS approved_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Filing lifecycle
-- ---------------------------------------------------------------------------
ALTER TABLE statutory_submissions DROP CONSTRAINT IF EXISTS statutory_submissions_status_check;
ALTER TABLE statutory_submissions ADD CONSTRAINT statutory_submissions_status_check CHECK (status = ANY (ARRAY[
  'PENDING'::text,
  'PREPARED'::text,
  'SUBMITTED'::text,
  'ACCEPTED'::text,
  'PAID'::text,
  'LATE'::text,
  'CANCELLED'::text
]));

-- A category, when set, must be one the statutory engine understands.
ALTER TABLE statutory_submissions DROP CONSTRAINT IF EXISTS statutory_submissions_category_check;
ALTER TABLE statutory_submissions ADD CONSTRAINT statutory_submissions_category_check
  CHECK (category IS NULL OR category = ANY (ARRAY[
    'PAYE'::text, 'NSSF'::text, 'LST'::text, 'SDI'::text, 'WHT'::text,
    'SEVERANCE'::text, 'MINIMUM_WAGE'::text, 'OTHER'::text
  ]));

ALTER TABLE statutory_submissions DROP CONSTRAINT IF EXISTS statutory_submissions_amounts_check;
ALTER TABLE statutory_submissions ADD CONSTRAINT statutory_submissions_amounts_check
  CHECK (gross_amount >= 0 AND employee_contribution >= 0 AND employer_contribution >= 0);

-- ---------------------------------------------------------------------------
-- 3. Indexes: one filing per company, category and period window
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_statutory_submissions_period
  ON statutory_submissions (company_id, category, period_start, period_end)
  WHERE category IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_statutory_submissions_status
  ON statutory_submissions (tenant_id, company_id, status, due_date);

COMMIT;
