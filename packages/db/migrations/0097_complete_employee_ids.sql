-- ============================================================
-- 0097 Complete employee IDs
-- Employees created after 0088 (e.g. test/batch rows) still lack
-- official + short employee numbers. Backfill them the same way
-- 0088 did, advancing the per-year sequences, and keep the SHORT
-- sequence row aligned with the generator (4-digit badge).
-- ============================================================

-- Align the SHORT sequence row with the generator's intent.
UPDATE employee_id_sequences
   SET prefix = 'HDG',
       pad = 4,
       format = 'HDG{YY}{SEQUENCE}',
       updated_at = now()
 WHERE seq_type = 'SHORT'
   AND prefix <> 'HDG';

DO $$
DECLARE
  v_rec record;
  v_seq bigint;
  v_short bigint;
  v_official text;
  v_badge text;
BEGIN
  FOR v_rec IN
    SELECT e.id, e.company_id, e.tenant_id,
           EXTRACT(YEAR FROM COALESCE(e.created_at, now()))::int AS yr
    FROM employees e
    WHERE e.employee_number IS NULL
    ORDER BY e.tenant_id, e.company_id, e.id
  LOOP
    INSERT INTO employee_id_sequences (tenant_id, company_id, seq_type, doc_year, current_sequence)
    VALUES (v_rec.tenant_id, v_rec.company_id, 'OFFICIAL', v_rec.yr, 1)
    ON CONFLICT (tenant_id, company_id, seq_type, doc_year)
    DO UPDATE SET current_sequence = employee_id_sequences.current_sequence + 1
    RETURNING current_sequence INTO v_seq;

    INSERT INTO employee_id_sequences (tenant_id, company_id, seq_type, doc_year, current_sequence)
    VALUES (v_rec.tenant_id, v_rec.company_id, 'SHORT', v_rec.yr, 1)
    ON CONFLICT (tenant_id, company_id, seq_type, doc_year)
    DO UPDATE SET current_sequence = employee_id_sequences.current_sequence + 1
    RETURNING current_sequence INTO v_short;

    v_official := 'HDG-EMP-' || v_rec.yr || '-' || lpad(v_seq::text, 6, '0');
    v_badge := 'HDG' || right(v_rec.yr::text, 2) || lpad(v_short::text, 4, '0');

    UPDATE employees
    SET employee_number = v_official, short_employee_number = v_badge
    WHERE id = v_rec.id;

    INSERT INTO employee_identities (tenant_id, company_id, employee_id, identity_type, identity_number, status, issued_by, metadata)
    VALUES (v_rec.tenant_id, v_rec.company_id, v_rec.id, 'OFFICIAL_EMPLOYEE_ID', v_official, 'ACTIVE', NULL, '{"source":"backfill"}'::jsonb);

    INSERT INTO employee_identities (tenant_id, company_id, employee_id, identity_type, identity_number, status, issued_by, metadata)
    VALUES (v_rec.tenant_id, v_rec.company_id, v_rec.id, 'SHORT_BADGE_ID', v_badge, 'ACTIVE', NULL, '{"source":"backfill"}'::jsonb);
  END LOOP;
END $$;
