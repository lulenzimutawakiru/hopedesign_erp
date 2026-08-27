-- ============================================================
-- 0091 — HR Contract Builder: clause governance metadata
-- Every statutory clause in the version-controlled library
-- carries its legal source, section/reference, effective window,
-- amendment/version and validation status. Legal rules remain the
-- single source of truth; clause rows mirror the linked rule.
-- ============================================================

ALTER TABLE contract_clauses
  ADD COLUMN IF NOT EXISTS law TEXT,
  ADD COLUMN IF NOT EXISTS law_chapter TEXT,
  ADD COLUMN IF NOT EXISTS section TEXT,
  ADD COLUMN IF NOT EXISTS law_source TEXT,
  ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (validation_status IN ('VALIDATED','PENDING_REVIEW','REJECTED','DRAFT'));

ALTER TABLE contract_clause_versions
  ADD COLUMN IF NOT EXISTS law TEXT,
  ADD COLUMN IF NOT EXISTS law_chapter TEXT,
  ADD COLUMN IF NOT EXISTS section TEXT,
  ADD COLUMN IF NOT EXISTS law_source TEXT,
  ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (validation_status IN ('VALIDATED','PENDING_REVIEW','REJECTED','DRAFT'));

-- Backfill statutory clauses from their linked legal rule (single source of truth).
UPDATE contract_clauses cc
SET law = COALESCE(cc.law, lr.law),
    law_chapter = COALESCE(cc.law_chapter, lr.law_chapter),
    section = COALESCE(cc.section, lr.section),
    law_source = COALESCE(cc.law_source, lr.source),
    validation_status = 'VALIDATED'
FROM legal_rules lr
WHERE lr.id = cc.legal_rule_id;

-- Centrally seeded clauses without a linked rule (e.g. compassionate leave)
-- are controlled library content and are marked validated for use.
UPDATE contract_clauses cc
SET law = COALESCE(cc.law, 'Employment Act, 2006'),
    law_chapter = COALESCE(cc.law_chapter, 'Chapter 226'),
    law_source = COALESCE(cc.law_source, 'ULII consolidation of Chapter 226 (current version 5 June 2026, incl. Employment (Amendment) Act, 2026)'),
    validation_status = 'VALIDATED'
WHERE cc.legal_rule_id IS NULL AND cc.created_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_contract_clauses_code ON contract_clauses (tenant_id, clause_code);
CREATE INDEX IF NOT EXISTS idx_contract_clauses_validation ON contract_clauses (tenant_id, validation_status);
