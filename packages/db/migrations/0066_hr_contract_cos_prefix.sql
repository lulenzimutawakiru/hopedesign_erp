-- ============================================================
-- 0066 HR Contract Builder: certificate of service numbering
-- ============================================================
-- Certificates of service are statutory documents (Employment Act,
-- 2006 s.66) distinct from employment contracts. Extend the shared
-- prefix mapper so certificate numbers use the COS prefix and the
-- slash-dated format (COS/2026/000001) produced by next_contract_no.

CREATE OR REPLACE FUNCTION contract_prefix_for_type(p_type text) RETURNS text AS $$
BEGIN
  RETURN CASE upper(p_type)
    WHEN 'PERMANENT' THEN 'EMP'
    WHEN 'FIXED_TERM' THEN 'FT'
    WHEN 'PROBATIONARY' THEN 'PROB'
    WHEN 'PART_TIME' THEN 'PT'
    WHEN 'TEMPORARY' THEN 'TEMP'
    WHEN 'APPRENTICESHIP' THEN 'APP'
    WHEN 'CASUAL' THEN 'CAS'
    WHEN 'INTERNSHIP' THEN 'INT'
    WHEN 'CONSULTANCY' THEN 'CONS'
    WHEN 'SECONDMENT' THEN 'SEC'
    WHEN 'RENEWAL' THEN 'RNW'
    WHEN 'VARIATION' THEN 'VAR'
    WHEN 'PROMOTION' THEN 'PROM'
    WHEN 'TRANSFER' THEN 'TRF'
    WHEN 'SALARY_ADJUSTMENT' THEN 'SAL'
    WHEN 'CERTIFICATE' THEN 'COS'
    ELSE 'CTR'
  END;
END;
$$ LANGUAGE plpgsql STABLE;
