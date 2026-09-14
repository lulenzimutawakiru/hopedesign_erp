-- ============================================================
-- 0155 Service Desk document numbering (problems, changes,
-- knowledge articles, access requests).
--
-- Spec 4 requires database-controlled, transaction-safe,
-- concurrency-safe, never-reused numbers. 0150 established that
-- pattern for tickets (HDG-SD-YYYY-NNNNNN) by seeding
-- document_numbers with an explicit last_seq = 1, because the
-- shared next_doc_no() helper inserts the row without a value and
-- therefore returns ...-000000 on the very first call for a new
-- (tenant, prefix, year).
--
-- This migration generalises the same guarded pattern to the other
-- Service Desk document families so that no ITSM record is ever
-- numbered 000000 and no number is ever reused:
--
--   ticket   HDG-SD-YYYY-NNNNNN    (0150)
--   problem  HDG-PRB-YYYY-NNNNNN
--   change   HDG-CHG-YYYY-NNNNNN
--   article  HDG-KB-YYYY-NNNNNN
--   request  HDG-AR-YYYY-NNNNNN    (access requests)
--
-- The prefix embeds the company code, so each legal entity keeps its
-- own independent sequence and numbers are unique per organization.
-- Uniqueness is enforced by document_numbers_tenant_id_prefix_doc_year_key
-- plus the UNIQUE constraint on each document's number column.
-- ============================================================

CREATE OR REPLACE FUNCTION next_service_doc_no(p_tenant bigint, p_company bigint, p_kind text)
RETURNS text AS $$
DECLARE
  v_code   text;
  v_prefix text;
  v_year   integer := EXTRACT(YEAR FROM now())::int;
  v_seq    bigint;
BEGIN
  SELECT code INTO v_code FROM companies WHERE id = p_company;
  v_prefix := COALESCE(v_code, 'HDG') || '-' || upper(coalesce(p_kind, 'DOC'));

  -- Seed explicitly at 1 so the first document of the year is ...-000001.
  -- ON CONFLICT DO UPDATE takes a row lock: concurrent callers serialise and
  -- each receives a distinct, monotonically increasing sequence value.
  INSERT INTO document_numbers (tenant_id, prefix, doc_year, last_seq)
  VALUES (p_tenant, v_prefix, v_year, 1)
  ON CONFLICT (tenant_id, prefix, doc_year)
    DO UPDATE SET last_seq = document_numbers.last_seq + 1
  RETURNING last_seq INTO v_seq;

  IF v_seq IS NULL THEN
    SELECT last_seq INTO v_seq FROM document_numbers
    WHERE tenant_id = p_tenant AND prefix = v_prefix AND doc_year = v_year;
  END IF;

  RETURN v_prefix || '-' || v_year || '-' || lpad(v_seq::text, 6, '0');
END;
$$ LANGUAGE plpgsql;

-- Convenience wrappers so callers cannot pass an arbitrary prefix and so the
-- SQL reads like the domain concept it numbers.
CREATE OR REPLACE FUNCTION next_problem_no(p_tenant bigint, p_company bigint)
RETURNS text AS $$ SELECT next_service_doc_no(p_tenant, p_company, 'PRB'); $$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION next_change_no(p_tenant bigint, p_company bigint)
RETURNS text AS $$ SELECT next_service_doc_no(p_tenant, p_company, 'CHG'); $$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION next_kb_article_no(p_tenant bigint, p_company bigint)
RETURNS text AS $$ SELECT next_service_doc_no(p_tenant, p_company, 'KB'); $$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION next_access_request_no(p_tenant bigint, p_company bigint)
RETURNS text AS $$ SELECT next_service_doc_no(p_tenant, p_company, 'AR'); $$ LANGUAGE sql;
