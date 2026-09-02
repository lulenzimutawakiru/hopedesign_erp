-- Audit trail tamper-proofing (DB-001 / DB-002 compensating control).
-- The audit log is append-only: any UPDATE or DELETE is rejected, even from
-- the application connection. This preserves audit integrity while the
-- architectural least-privilege role work (DB-001) is completed.
CREATE OR REPLACE FUNCTION public.prevent_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs are append-only: UPDATE/DELETE is not permitted';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_no_update_delete ON audit_logs;
CREATE TRIGGER audit_logs_no_update_delete
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_mutation();

-- Defense-in-depth: deny mutation at the privilege layer for the application
-- role and any future non-superuser role.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM hopedesign;