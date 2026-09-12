-- ============================================================
-- 0149 Professionalise employee IDs across the ERP
--
-- An employee carries two identifier families:
--   * employee_number / short_employee_number - the permanent IDs minted by
--     the identity engine (migration 0088).
--   * employee_no - the operational number that payroll, payslips, the
--     payroll register, payment batches and every HR screen read.
--
-- 0088 filled employee_number but left employee_no holding the legacy bare
-- integers (and, on the recruitment->hire path, the nextDoc() artefact
-- 'EMP-2026-00000000'), so the professional ID never reached finance.
--
-- This migration makes employee_no *be* the permanent ID, issues IDs to the
-- employees that never received one, closes the gap in the identity register
-- and installs triggers so a new employee can never again be created without
-- a professional ID and a matching identity record.
-- ============================================================

-- ---------- 1. Render an ID from the sequence's stored format ----------
-- The employee_id_sequences row stays the single source of truth for prefix,
-- pad and format, so a company can be re-branded (e.g. prefix 'HOPE-EMP')
-- without touching application code.
CREATE OR REPLACE FUNCTION employee_render_id(
  p_format text, p_prefix text, p_year integer, p_sequence bigint, p_pad integer
) RETURNS text AS $$
  SELECT replace(
           replace(
             replace(
               replace(
                 COALESCE(NULLIF(btrim(p_format), ''), '{PREFIX}-{YEAR}-{SEQUENCE}'),
                 '{PREFIX}', COALESCE(NULLIF(btrim(p_prefix), ''), 'HDG-EMP')),
               '{YEAR}', lpad(p_year::text, 4, '0')),
             '{YY}', right(p_year::text, 2)),
           '{SEQUENCE}', lpad(p_sequence::text, GREATEST(COALESCE(p_pad, 6), 1), '0'));
$$ LANGUAGE sql IMMUTABLE;

-- ---------- 2. Mint the next official + short ID (collision safe) ----------
-- Advances the per-year sequence until it lands on a number that no employee
-- and no issued identity currently holds, so historic manual numbering (for
-- example the 000015/16/17 IDs issued outside the sequence) can never cause a
-- unique-index violation or a duplicate identity.
CREATE OR REPLACE FUNCTION employee_next_identity(
  p_tenant_id bigint, p_company_id bigint, OUT official text, OUT short text
) AS $$
DECLARE
  v_year integer := EXTRACT(YEAR FROM now())::integer;
  v_attempt integer := 0;
  v_seq bigint;
  v_prefix text;
  v_pad integer;
  v_format text;
BEGIN
  IF p_tenant_id IS NULL OR p_company_id IS NULL THEN
    RAISE EXCEPTION 'employee_next_identity requires a tenant and a company';
  END IF;

  -- The table defaults describe the OFFICIAL shape (prefix 'HDG-EMP', pad 6),
  -- so each type must state its own shape here: an auto-created SHORT row that
  -- inherited those defaults would render short badges in the official format.
  INSERT INTO employee_id_sequences (tenant_id, company_id, seq_type, doc_year, prefix, pad, format)
  VALUES (p_tenant_id, p_company_id, 'OFFICIAL', v_year, 'HDG-EMP', 6, '{PREFIX}-{YEAR}-{SEQUENCE}')
  ON CONFLICT (tenant_id, company_id, seq_type, doc_year) DO NOTHING;
  INSERT INTO employee_id_sequences (tenant_id, company_id, seq_type, doc_year, prefix, pad, format)
  VALUES (p_tenant_id, p_company_id, 'SHORT', v_year, 'HDG', 4, 'HDG{YY}{SEQUENCE}')
  ON CONFLICT (tenant_id, company_id, seq_type, doc_year) DO NOTHING;

  -- Official ID (unique per company).
  LOOP
    v_attempt := v_attempt + 1;
    IF v_attempt > 100000 THEN
      RAISE EXCEPTION 'no free employee id for company % in %', p_company_id, v_year;
    END IF;
    UPDATE employee_id_sequences s
       SET current_sequence = s.current_sequence + 1, updated_at = now()
     WHERE s.tenant_id = p_tenant_id AND s.company_id = p_company_id
       AND s.seq_type = 'OFFICIAL' AND s.doc_year = v_year
    RETURNING s.current_sequence, s.prefix, s.pad, s.format
      INTO v_seq, v_prefix, v_pad, v_format;
    official := employee_render_id(v_format, v_prefix, v_year, v_seq, v_pad);
    EXIT WHEN NOT EXISTS (
             SELECT 1 FROM employees e
              WHERE e.company_id = p_company_id AND e.employee_number = official)
          AND NOT EXISTS (
             SELECT 1 FROM employee_identities i
              WHERE i.company_id = p_company_id
                AND i.identity_type = 'OFFICIAL_EMPLOYEE_ID'
                AND i.identity_number = official);
  END LOOP;

  -- Short badge (unique per tenant).
  v_attempt := 0;
  LOOP
    v_attempt := v_attempt + 1;
    IF v_attempt > 100000 THEN
      RAISE EXCEPTION 'no free short employee id for company % in %', p_company_id, v_year;
    END IF;
    UPDATE employee_id_sequences s
       SET current_sequence = s.current_sequence + 1, updated_at = now()
     WHERE s.tenant_id = p_tenant_id AND s.company_id = p_company_id
       AND s.seq_type = 'SHORT' AND s.doc_year = v_year
    RETURNING s.current_sequence, s.prefix, s.pad, s.format
      INTO v_seq, v_prefix, v_pad, v_format;
    short := employee_render_id(v_format, v_prefix, v_year, v_seq, v_pad);
    EXIT WHEN NOT EXISTS (
             SELECT 1 FROM employees e
              WHERE e.tenant_id = p_tenant_id AND e.short_employee_number = short)
          AND NOT EXISTS (
             SELECT 1 FROM employee_identities i
              WHERE i.tenant_id = p_tenant_id
                AND i.identity_type = 'SHORT_BADGE_ID'
                AND i.identity_number = short);
  END LOOP;
END $$ LANGUAGE plpgsql;

-- ---------- 3. Issue permanent IDs to employees that never got one ----------
DO $$
DECLARE
  v_rec record;
  v_id record;
BEGIN
  FOR v_rec IN
    SELECT e.id, e.tenant_id, e.company_id
      FROM employees e
     WHERE e.employee_number IS NULL OR e.short_employee_number IS NULL
     ORDER BY e.created_at NULLS FIRST, e.id
  LOOP
    SELECT * INTO v_id FROM employee_next_identity(v_rec.tenant_id, v_rec.company_id);
    UPDATE employees e
       SET employee_number = COALESCE(e.employee_number, v_id.official),
           short_employee_number = COALESCE(e.short_employee_number, v_id.short)
     WHERE e.id = v_rec.id;
  END LOOP;
END $$;

-- ---------- 4. Close gaps in the identity register ----------
-- Every employee holding a permanent number must have the matching issued
-- identity, otherwise they are invisible in the identity centre.
INSERT INTO employee_identities
  (tenant_id, company_id, employee_id, identity_type, identity_number, status, issued_by, metadata)
SELECT e.tenant_id, e.company_id, e.id, 'OFFICIAL_EMPLOYEE_ID', e.employee_number,
       'ACTIVE', NULL, '{"source":"backfill_0149"}'::jsonb
  FROM employees e
 WHERE e.employee_number IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM employee_identities i
      WHERE i.tenant_id = e.tenant_id AND i.employee_id = e.id
        AND i.identity_type = 'OFFICIAL_EMPLOYEE_ID')
ON CONFLICT DO NOTHING;

INSERT INTO employee_identities
  (tenant_id, company_id, employee_id, identity_type, identity_number, status, issued_by, metadata)
SELECT e.tenant_id, e.company_id, e.id, 'SHORT_BADGE_ID', e.short_employee_number,
       'ACTIVE', NULL, '{"source":"backfill_0149"}'::jsonb
  FROM employees e
 WHERE e.short_employee_number IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM employee_identities i
      WHERE i.tenant_id = e.tenant_id AND i.employee_id = e.id
        AND i.identity_type = 'SHORT_BADGE_ID')
ON CONFLICT DO NOTHING;

-- ---------- 5. employee_no adopts the permanent ID ----------
-- Payroll, payslips, the payroll register, payment batches and every HR screen
-- read employee_no, so adopting the permanent ID here is what actually makes
-- the professional identifier flow through to finance. Only legacy shapes are
-- rewritten: bare integers from bulk imports and the 'EMP-...' nextDoc()
-- artefact. Anything already carrying a real number is left untouched.
UPDATE employees e
   SET employee_no = e.employee_number
 WHERE e.employee_number IS NOT NULL
   AND e.employee_no IS DISTINCT FROM e.employee_number
   AND (e.employee_no IS NULL
        OR e.employee_no ~ '^[0-9]+$'
        OR e.employee_no LIKE 'EMP-%');

-- ---------- 6. Stop the regression ----------
-- BEFORE INSERT: an employee created without a number is issued a permanent
-- one instead of failing the NOT NULL constraint or inventing a bare integer.
CREATE OR REPLACE FUNCTION employees_assign_employee_identity() RETURNS trigger AS $$
DECLARE
  v_id record;
BEGIN
  IF NEW.employee_number IS NULL AND NEW.short_employee_number IS NULL
     AND NEW.employee_no IS NULL THEN
    SELECT * INTO v_id FROM employee_next_identity(NEW.tenant_id, NEW.company_id);
    NEW.employee_number := v_id.official;
    NEW.short_employee_number := v_id.short;
    NEW.employee_no := v_id.official;
  END IF;

  -- employee_no is NOT NULL without a default: never let a caller leak a NULL.
  IF NEW.employee_no IS NULL THEN
    NEW.employee_no := COALESCE(NEW.employee_number, NEW.short_employee_number);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_employees_assign_employee_identity ON employees;
CREATE TRIGGER trg_employees_assign_employee_identity
  BEFORE INSERT ON employees
  FOR EACH ROW EXECUTE FUNCTION employees_assign_employee_identity();

-- AFTER INSERT: the identity register follows the employee row, so a holder of
-- a permanent number is always visible in the identity centre. This runs after
-- the row exists, which is what makes the employee_identities foreign key
-- satisfiable.
CREATE OR REPLACE FUNCTION employees_sync_employee_identities() RETURNS trigger AS $$
BEGIN
  IF NEW.employee_number IS NOT NULL THEN
    INSERT INTO employee_identities
      (tenant_id, company_id, employee_id, identity_type, identity_number, status, metadata)
    VALUES (NEW.tenant_id, NEW.company_id, NEW.id, 'OFFICIAL_EMPLOYEE_ID',
            NEW.employee_number, 'ACTIVE', '{"source":"auto"}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;
  IF NEW.short_employee_number IS NOT NULL THEN
    INSERT INTO employee_identities
      (tenant_id, company_id, employee_id, identity_type, identity_number, status, metadata)
    VALUES (NEW.tenant_id, NEW.company_id, NEW.id, 'SHORT_BADGE_ID',
            NEW.short_employee_number, 'ACTIVE', '{"source":"auto"}'::jsonb)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_employees_sync_employee_identities ON employees;
CREATE TRIGGER trg_employees_sync_employee_identities
  AFTER INSERT ON employees
  FOR EACH ROW EXECUTE FUNCTION employees_sync_employee_identities();
