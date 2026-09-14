-- ============================================================================
-- 0158_hr_statutory_clause_validation.sql
--
-- HOPE DESIGN ERP - HR Contract Builder: restore the statutory clause
-- governance invariant, and make it structural.
--
-- DEFECT
-- ------
-- 0091_hr_clause_governance.sql established the rule that a clause carrying a
-- linked legal_rules row is centrally controlled library content whose legal
-- basis is already registered, and therefore carries
-- validation_status = 'VALIDATED' (0091, final backfill step).
--
-- 0145_employment_clause_library.sql rewrote the bundled clause library. Its
-- seed table hardcodes the validation status per row, and the statutory
-- WORKING_HOURS row (legal_reference "Employment Act (Cap. 226), s.52") was
-- seeded as 'PENDING_REVIEW'. Step 2 of that migration copies
-- s.validation_status onto any row whose wording changed, so it overwrote the
-- previously correct 'VALIDATED' value, bumped the clause to version 2 and
-- re-dated effective_from. Result: exactly one of the 30 rule-linked clauses
-- reported as unvalidated, breaking the governance contract asserted by
-- tests/contracts.test.ts ("statutory clauses carry legal metadata and are
-- frozen") and, more importantly, mislabelling a statutory clause as an
-- unreviewed draft in the clause library HR builds contracts from.
--
-- Drafted commercial wording that has no legal rule attached is INTENTIONALLY
-- left PENDING_REVIEW - that is the 0145 legal-review gate and is not touched
-- here. Only rule-linked rows are corrected.
--
-- FIX
-- ---
--   1. Restore validation_status = 'VALIDATED' for centrally controlled rows
--      that carry a legal rule, and backfill any missing legal metadata from
--      the linked rule (same single-source-of-truth backfill as 0091).
--   2. Add a CHECK constraint so the invariant can never regress again: a
--      clause may only be unvalidated while it has no legal rule attached.
--      Tenant-authored clauses are always created with legal_rule_id NULL and
--      validation_status 'PENDING_REVIEW'
--      (apps/api/src/services/contracts.ts createClause()), and centrally
--      controlled clauses are frozen against tenant edits
--      (createClauseVersion() rejects them), so no application write path can
--      violate the constraint.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Restore the statutory rows.
-- ---------------------------------------------------------------------------
UPDATE contract_clauses cc
SET validation_status = 'VALIDATED',
    law = COALESCE(cc.law, lr.law),
    law_chapter = COALESCE(cc.law_chapter, lr.law_chapter),
    section = COALESCE(cc.section, lr.section),
    law_source = COALESCE(cc.law_source, lr.source),
    updated_at = now()
FROM legal_rules lr
WHERE lr.id = cc.legal_rule_id
  AND cc.deleted_at IS NULL
  AND cc.validation_status <> 'VALIDATED';

-- ---------------------------------------------------------------------------
-- 2. Enforce the invariant for good.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'contract_clauses'::regclass
       AND conname = 'contract_clauses_statutory_validated_chk'
  ) THEN
    ALTER TABLE contract_clauses
      ADD CONSTRAINT contract_clauses_statutory_validated_chk
      CHECK (legal_rule_id IS NULL OR validation_status = 'VALIDATED');
  END IF;
END $$;