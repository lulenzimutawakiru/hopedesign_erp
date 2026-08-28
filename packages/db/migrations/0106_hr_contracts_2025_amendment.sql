-- ============================================================
-- 0106 HR Contract Builder: Employment (Amendment) Act, 2025
-- Refreshes the statutory legal baseline to the consolidated
-- Employment Act (Cap. 226, Laws of Uganda), as amended by the
-- Employment (Amendment) Act, 2025 (ULII consolidation, current
-- version 5 June 2026).
-- ============================================================

-- ---------- legal rules: refresh statutory metadata ----------
UPDATE legal_rules
SET law = 'Employment Act (Cap. 226, Laws of Uganda), as amended',
    law_chapter = 'Cap. 226',
    source = 'ULII consolidation of the Employment Act (current version 5 June 2026, including the Employment (Amendment) Act, 2025)'
WHERE law = 'Employment Act, 2006'
   OR law_chapter = 'Chapter 226'
   OR source LIKE 'ULII consolidation of Chapter 226%';

-- ---------- new legal rules introduced by the 2025 amendment ----------
INSERT INTO legal_rules (tenant_id, code, name, law, law_chapter, section, description, rules, version, status, enforcement, effective_from, source)
SELECT t.id, v.code, v.name,
       'Employment Act (Cap. 226, Laws of Uganda), as amended',
       'Cap. 226',
       v.section,
       v.description,
       v.rules,
       1, 'ACTIVE', 'HARD', '2026-06-05',
       'ULII consolidation of the Employment Act (current version 5 June 2026, including the Employment (Amendment) Act, 2025)'
FROM tenants t
CROSS JOIN (VALUES
  ('INTIMIDATION_HARASSMENT', 'Prohibition of Intimidation and Harassment', 's.6A',
   'An employer must not intimidate, harass or victimise an employee, and a copy of the employer''s policy prohibiting such conduct must be displayed at the workplace (Employment (Amendment) Act, 2025, inserting s.6A).',
   '{"prohibited": true, "policy_displayed_at_workplace": true}'::jsonb),
  ('PROBATION_TERMINATION_NOTICE', 'Notice During Probation', 's.58(3)',
   'Termination of a probationary contract requires not less than one month''s notice, unless summary dismissal applies (Employment (Amendment) Act, 2025).',
   '{"notice_days": 30}'::jsonb),
  ('SEVERANCE_ALLOWANCE', 'Severance Allowance on Redundancy', NULL,
   'An employee declared redundant is entitled to severance pay of not less than one month''s salary for each completed year of continuous service (Employment (Amendment) Act, 2025).',
   '{"months_per_completed_year": 1}'::jsonb),
  ('OHS_COMMITTEES', 'Safety and Health Committees', NULL,
   'Every workplace must establish a safety and health committee, and mental health support is a mandatory part of the employer''s occupational safety and health obligations (Employment (Amendment) Act, 2025).',
   '{"required_for_all_workplaces": true, "mental_health_support_required": true}'::jsonb),
  ('MIGRANT_WORKERS', 'Protection of Migrant Workers', NULL,
   'Migrant workers enjoy the same statutory protections as other employees, including written particulars, fair termination and freedom from intimidation and harassment (Employment Act (Cap. 226), Part IXA, as amended).',
   '{"equal_statutory_protection": true}'::jsonb)
) AS v(code, name, section, description, rules)
WHERE NOT EXISTS (
  SELECT 1 FROM legal_rules lr
  WHERE lr.tenant_id = t.id AND lr.code = v.code AND lr.version = 1
);

-- ---------- version 3 snapshots for the 2025 amendment ----------
INSERT INTO legal_rules (tenant_id, code, name, law, law_chapter, section, description, rules, version, status, enforcement, effective_from, source)
SELECT t.id, v.code, base.name,
       'Employment Act (Cap. 226, Laws of Uganda), as amended',
       'Cap. 226',
       base.section,
       v.description,
       v.rules,
       3, 'ACTIVE', base.enforcement, '2026-06-05',
       'ULII consolidation of the Employment Act (current version 5 June 2026, including the Employment (Amendment) Act, 2025)'
FROM tenants t
CROSS JOIN (VALUES
  ('SICK_LEAVE',
   'Paid sick leave of 12 working days per year, available after one month of service, with a medical certificate required for an absence of 7 or more consecutive days. An employee absent due to sickness is entitled to retain employment for up to six months of sick absence in any period of twelve months.',
   '{"sick_leave_days": 12, "qualifying_months": 1, "medical_certificate": true, "certificate_required_after_days": 7, "sick_absence_months": 6}'::jsonb),
  ('CASUAL_EMPLOYMENT',
   'An employee engaged on a casual basis may not be employed for a continuous period exceeding six months; the employee must then be engaged under a written contract of employment with the statutory written particulars (Employment Act (Cap. 226), s.34A, as amended).',
   '{"written_contract_after_months": 6, "max_continuous_months": 6}'::jsonb),
  ('SEXUAL_HARASSMENT',
   'Sexual harassment in the workplace is prohibited. The employer must put in place a policy against sexual harassment, display it prominently at the workplace, and take reasonable steps to prevent and address harassment.',
   '{"prohibited": true, "employer_prevention_duty": true, "policy_displayed_at_workplace": true}'::jsonb),
  ('PROBATION_MAX_DURATION',
   'A probationary period may not exceed six months, and termination of a probationary contract requires not less than one month''s notice unless summary dismissal applies.',
   '{"max_duration_days": 180, "max_duration_label": "6 months", "termination_notice_days": 30}'::jsonb)
) AS v(code, description, rules)
JOIN LATERAL (
  SELECT name, section, enforcement
  FROM legal_rules lr
  WHERE lr.tenant_id = t.id AND lr.code = v.code
  ORDER BY lr.version DESC
  LIMIT 1
) base ON true
WHERE NOT EXISTS (
  SELECT 1 FROM legal_rules lr2
  WHERE lr2.tenant_id = t.id AND lr2.code = v.code AND lr2.version = 3
);

-- ---------- v2 SICK_LEAVE: reflect the 2025 amendment ----------
UPDATE legal_rules
SET description = 'Paid sick leave of 12 working days per year, available after one month of service, with a medical certificate required for an absence of 7 or more consecutive days. An employee absent due to sickness is entitled to retain employment for up to six months of sick absence in any period of twelve months (as amended by the Employment (Amendment) Act, 2025; consolidated in the ULII current version 5 June 2026).',
    rules = '{"sick_leave_days": 12, "qualifying_months": 1, "medical_certificate": true, "certificate_required_after_days": 7, "sick_absence_months": 6}'::jsonb
WHERE code = 'SICK_LEAVE' AND version = 2;

-- ---------- contract clauses: refresh statutory metadata ----------
UPDATE contract_clauses cc
SET law = lr.law,
    law_chapter = lr.law_chapter,
    law_source = lr.source,
    validation_status = 'VALIDATED'
FROM legal_rules lr
WHERE lr.id = cc.legal_rule_id
  AND (cc.law = 'Employment Act, 2006' OR cc.law_chapter = 'Chapter 226'
       OR cc.law_source LIKE 'ULII consolidation of Chapter 226%');

UPDATE contract_clauses
SET law = 'Employment Act (Cap. 226, Laws of Uganda), as amended',
    law_chapter = 'Cap. 226',
    law_source = 'ULII consolidation of the Employment Act (current version 5 June 2026, including the Employment (Amendment) Act, 2025)',
    validation_status = 'VALIDATED'
WHERE legal_rule_id IS NULL AND created_by IS NULL
  AND (law = 'Employment Act, 2006' OR law_chapter = 'Chapter 226'
       OR law_source LIKE 'ULII consolidation of Chapter 226%');

UPDATE contract_clause_versions ccv
SET law = cc.law,
    law_chapter = cc.law_chapter,
    law_source = cc.law_source,
    validation_status = 'VALIDATED'
FROM contract_clauses cc
WHERE ccv.clause_id = cc.id
  AND (ccv.law = 'Employment Act, 2006' OR ccv.law_chapter = 'Chapter 226'
       OR ccv.law_source LIKE 'ULII consolidation of Chapter 226%');