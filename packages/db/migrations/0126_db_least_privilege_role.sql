-- Least-privilege application database role (DB-001, Phase 2A).
--
-- Creates a dedicated non-superuser login role for the application connection so
-- the API no longer needs to run as the superuser/table owner `hopedesign`.
-- Phase 2A provisions the role and object grants and hardens PUBLIC defaults.
-- The application connection string is switched to this role in Phase 2B after
-- the pre-auth/bootstrap flows are validated against row-level security.
--
-- The dev password default mirrors the compose dev-credential pattern
-- (docker-compose.yml). Production operators MUST set a strong, unique password
-- before switching the connection, e.g.:
--   psql -c "ALTER ROLE hopedesign_app WITH LOGIN PASSWORD '<strong>'"
-- The application config fail-fast gate refuses to boot in production while the
-- connection still uses the superuser role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hopedesign_app') THEN
    CREATE ROLE hopedesign_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- Idempotent password: allow an operator/runner to pass
--   -c app.app_role_password=...  (GUC override), else dev default.
DO $$
DECLARE v_pw text := NULLIF(current_setting('app.app_role_password', true), '');
BEGIN
  IF v_pw IS NULL THEN v_pw := 'hopedesign_app_dev'; END IF;
  EXECUTE format('ALTER ROLE hopedesign_app WITH LOGIN PASSWORD %L', v_pw);
END $$;

-- Hardening: strip default PUBLIC object privileges. PostgreSQL 15+ already
-- revokes CREATE on the public schema; we also clear table/sequence/function
-- EXECUTE/SELECT defaults so only explicitly granted roles can touch objects.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

-- Application role grants (tables including views, sequences, functions).
GRANT USAGE ON SCHEMA public TO hopedesign_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hopedesign_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hopedesign_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO hopedesign_app;

-- Future objects created by the owner during later migrations automatically
-- inherit the same grants, so maintenance does not silently lock out the app.
ALTER DEFAULT PRIVILEGES FOR ROLE hopedesign IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hopedesign_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hopedesign IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO hopedesign_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hopedesign IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO hopedesign_app;

-- audit_logs stays append-only for the application role too (see 0125).
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM hopedesign_app;
