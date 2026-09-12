-- ============================================================
-- 0146_employment_template_modernisation.sql
--
-- Brings the remaining bundled documents in line with the modern
-- clause library seeded by 0145. Promotion letters, salary
-- adjustment letters and contract variations all restate or
-- preserve obligations that the templates previously omitted: a
-- promotion could previously be granted without reaffirming
-- confidentiality, and a variation could alter terms without
-- stating which obligations survive the change.
--
-- Mechanics mirror 0145 and `createClauseVersion` in
-- apps/api/src/services/contracts.ts - the outgoing version is
-- marked SUPERSEDED and a new approved version is published. The
-- prior content is retained in contract_template_versions, so any
-- document already issued stays reproducible.
--
-- Idempotent: the insert is guarded on a marker that only the new
-- content contains (GENERAL_PROVISIONS), so re-running is a no-op.
--
-- Depends on 0145. Four of the clauses referenced below (GENERAL_PROVISIONS,
-- IT_ACCEPTABLE_USE, CYBERSECURITY, DATA_BREACH_REPORTING) are created by
-- 0145, so that migration must be applied first. Migrations run in name
-- order, so 0145 always lands ahead of this file.
--
-- TMPL-COS (Certificate of Service) is deliberately NOT touched.
-- It is a short statutory certificate of fact rather than a
-- contract, and confidentiality or dispute-resolution wording has
-- no place in it.
--
-- Legal review: the clause wording these templates reference is
-- centrally maintained under 0145 and is flagged PENDING_REVIEW.
-- ============================================================

DROP TABLE IF EXISTS _tmpl_modern;
CREATE TEMP TABLE _tmpl_modern ON COMMIT DROP AS
SELECT t.id AS template_id, t.company_id, t.tenant_id, t.code, t.name,
       max(v.version) + 1 AS next_version
FROM contract_templates t
JOIN contract_template_versions v ON v.template_id = t.id
WHERE t.code IN ('TMPL-PROMO', 'TMPL-SAL', 'TMPL-VAR')
  AND NOT EXISTS (
    SELECT 1 FROM contract_template_versions x
    WHERE x.template_id = t.id AND x.sections::text LIKE '%GENERAL_PROVISIONS%'
  )
GROUP BY t.id, t.company_id, t.tenant_id, t.code, t.name;

UPDATE contract_template_versions v
SET status = 'SUPERSEDED', updated_at = now()
FROM _tmpl_modern n
WHERE v.template_id = n.template_id
  AND v.status = 'ACTIVE'
  AND v.version < n.next_version;

INSERT INTO contract_template_versions (
  company_id, tenant_id, template_id, version, name, sections, content, status
)
SELECT n.company_id, n.tenant_id, n.template_id, n.next_version, n.name,
       s.sections, s.sections, 'ACTIVE'
FROM _tmpl_modern n
JOIN (VALUES  ('TMPL-PROMO',
   '[{"section_code":"EMPLOYER","clauses":[]},
     {"section_code":"EMPLOYEE","clauses":[]},
     {"section_code":"EMPLOYMENT","clauses":["PROMOTION"]},
     {"section_code":"COMPENSATION","clauses":["SALARY","ALLOWANCES"]},
     {"section_code":"CONFIDENTIALITY","clauses":["CONFIDENTIALITY","INTELLECTUAL_PROPERTY","CONFLICT_OF_INTEREST"]},
     {"section_code":"GENERAL","clauses":["GENERAL_PROVISIONS","GOVERNING_LAW"]},
     {"section_code":"SIGNATURES","clauses":[]}]'::jsonb),
  ('TMPL-SAL',
   '[{"section_code":"EMPLOYER","clauses":[]},
     {"section_code":"EMPLOYEE","clauses":[]},
     {"section_code":"COMPENSATION","clauses":["SALARY"]},
     {"section_code":"CONFIDENTIALITY","clauses":["CONFIDENTIALITY"]},
     {"section_code":"GENERAL","clauses":["GENERAL_PROVISIONS","GOVERNING_LAW"]},
     {"section_code":"SIGNATURES","clauses":[]}]'::jsonb),
  ('TMPL-VAR',
   '[{"section_code":"EMPLOYER","clauses":[]},
     {"section_code":"EMPLOYEE","clauses":[]},
     {"section_code":"EMPLOYMENT","clauses":["VARIATION"]},
     {"section_code":"COMPENSATION","clauses":["SALARY"]},
     {"section_code":"CONFIDENTIALITY","clauses":["CONFIDENTIALITY","INTELLECTUAL_PROPERTY","COMPANY_PROPERTY","IT_ACCEPTABLE_USE","CYBERSECURITY","DATA_BREACH_REPORTING"]},
     {"section_code":"TERMINATION","clauses":["DISPUTE_RESOLUTION"]},
     {"section_code":"GENERAL","clauses":["GENERAL_PROVISIONS","GOVERNING_LAW"]},
     {"section_code":"SIGNATURES","clauses":[]}]'::jsonb)
) AS s(code, sections) ON s.code = n.code;