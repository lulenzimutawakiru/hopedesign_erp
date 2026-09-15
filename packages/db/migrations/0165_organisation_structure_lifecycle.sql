-- ============================================================================
-- 0165 - Organisation structure lifecycle (archive / restore)
--
-- 0164 gave every structural entity the same lifecycle vocabulary that the
-- Organisation Settings screen exposes: Create, Edit, View, Activate,
-- Deactivate, Archive, Restore. Six of the seven tables accept any status
-- text, but `divisions` and `locations` were created with a two-value CHECK
-- (ACTIVE|INACTIVE), so "archive" had nowhere to go on those two. This file
-- widens those two CHECKs and gives every structural table the same two
-- bookkeeping columns, so one code path can serve all seven.
--
-- Why a column and not just a status value: "deactivated" and "archived" are
-- deliberately different outcomes. A deactivated branch is temporarily out of
-- use and expected back; an archived one is retired and should stay out of
-- pickers. Recording who archived it and when is what lets the audit screen
-- answer "who retired the Namanve branch?" without reading the audit log.
--
-- Forward-only: 0164 is already in the schema_migrations ledger, so this is a
-- new file rather than an edit of an applied one.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Widen the two constrained status columns to match the other five.
-- ---------------------------------------------------------------------------
ALTER TABLE divisions DROP CONSTRAINT IF EXISTS divisions_status_check;
ALTER TABLE divisions ADD CONSTRAINT divisions_status_check
  CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED'));

ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_status_check;
ALTER TABLE locations ADD CONSTRAINT locations_status_check
  CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED'));

-- ---------------------------------------------------------------------------
-- 2. Archive bookkeeping on every structural entity.
--
-- archived_by is a plain BIGINT on purpose. The structure tables already carry
-- unenforced user references (branches.manager_user_id, departments.head_user_id,
-- divisions.head_user_id), so a hard FK here would be the odd one out - and it
-- would block deleting a departed administrator whose archive actions are long
-- since recorded in audit_logs.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'companies', 'branches', 'departments', 'divisions',
    'locations', 'warehouses', 'cost_centres'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS archived_by BIGINT', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Retired entities stay out of list queries, so index the questions the
--    settings screen actually asks: "what is live for this company?" and
--    "what has been archived?"
--
-- companies is the tenant root and has no company_id, so it gets its own
-- index shape; the other six share one.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'branches', 'departments', 'divisions',
    'locations', 'warehouses', 'cost_centres'
  ]
  LOOP
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id, company_id, status)',
      t || '_tenant_company_status_idx', t
    );
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS companies_tenant_status_idx ON companies (tenant_id, status);
