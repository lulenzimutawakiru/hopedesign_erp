-- Harden SECURITY DEFINER functions against search_path hijacking (DB-003).
-- Each function now resolves unqualified relations/types through pg_catalog
-- first, so a caller-controlled schema cannot inject replacement objects.
ALTER FUNCTION public.verify_qr_public(text,text,text,text) SET search_path = pg_catalog, public;
ALTER FUNCTION public.verify_contract_document(text,text,text,text,text,bigint,text) SET search_path = pg_catalog, public;
ALTER FUNCTION public.get_due_report_schedules() SET search_path = pg_catalog, public;
ALTER FUNCTION public.verify_employee_public(text,text,text,text) SET search_path = pg_catalog, public;
ALTER FUNCTION public.get_due_cron_jobs() SET search_path = pg_catalog, public;