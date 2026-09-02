-- RLS FORCE + coverage-gap closure (DB-002, Phase 2A).
--
-- Three steps:
--   1) FORCE row-level security on every table that already has RLS enabled and
--      at least one policy, so the row policy binds even when the object owner
--      is the querying role.
--   2) Enable RLS + FORCE + a tenant policy on previously unprotected tables
--      that carry tenant_id (or a tenant-resolvable parent/join), closing the
--      audit_logs / identity / company / PO-amendment / session / role gaps.
--   3) Keep a small documented RLS-off set (global/system catalogs that must be
--      readable across tenants: tenants, currencies, exchange_rates,
--      permissions, login_attempts, schema_migrations) with PUBLIC privileges
--      removed so only the owner and the least-privilege app role can access.
--
-- Runtime note: the current application connection is the superuser
-- `hopedesign`, which PostgreSQL always exempts from row security, so this
-- migration is behavior-neutral for the running stack. It prepares the schema
-- so a non-owner, non-BYPASSRLS connection (hopedesign_app, migration 0126) is
-- fully tenant-isolated, and it binds the table owner as well once the owner is
-- not a superuser.

-- 1) FORCE RLS on all RLS-enabled, policy-backed tables.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relrowsecurity AND NOT c.relforcerowsecurity
      AND EXISTS (SELECT 1 FROM pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = c.relname)
  LOOP
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',
                   r.schema_name, r.relname);
  END LOOP;
END $$;

-- 2a) Tenant-scoped tables that were missed by the policy sweep: enable RLS +
-- FORCE + the standard tenant_isolation policy (tenant_id = app_tenant_id()).
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
      AND EXISTS (SELECT 1 FROM information_schema.columns col
                  WHERE col.table_schema = 'public'
                    AND col.table_name = c.relname
                    AND col.column_name = 'tenant_id')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I '
                   'USING (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

-- 2b) Tables without tenant_id whose tenant resolves through a parent/join.
-- po_amendment_items: child of po_amendments (tenant_id present on parent).
ALTER TABLE public.po_amendment_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.po_amendment_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.po_amendment_items;
CREATE POLICY tenant_isolation ON public.po_amendment_items
  USING (EXISTS (SELECT 1 FROM public.po_amendments pa
                 WHERE pa.id = po_amendment_items.amendment_id
                   AND pa.tenant_id = app_tenant_id()));

-- user_roles: tenant resolves through users.
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.user_roles;
CREATE POLICY tenant_isolation ON public.user_roles
  USING (EXISTS (SELECT 1 FROM public.users u
                 WHERE u.id = user_roles.user_id
                   AND u.tenant_id = app_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users u
                      WHERE u.id = user_roles.user_id
                        AND u.tenant_id = app_tenant_id()));

-- sessions: tenant resolves through users (session rows stay usable for the
-- owning user and for tenant-scoped admin views).
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.sessions;
CREATE POLICY tenant_isolation ON public.sessions
  USING (EXISTS (SELECT 1 FROM public.users u
                 WHERE u.id = sessions.user_id
                   AND u.tenant_id = app_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users u
                      WHERE u.id = sessions.user_id
                        AND u.tenant_id = app_tenant_id()));

-- role_permissions: tenant resolves through roles.
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.role_permissions;
CREATE POLICY tenant_isolation ON public.role_permissions
  USING (EXISTS (SELECT 1 FROM public.roles r
                 WHERE r.id = role_permissions.role_id
                   AND r.tenant_id = app_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.roles r
                      WHERE r.id = role_permissions.role_id
                        AND r.tenant_id = app_tenant_id()));

-- 3) RLS-off exceptions: global/system catalogs that must stay readable across
-- tenants for auth/bootstrap/currency/reference lookups. PUBLIC privileges are
-- stripped so only the object owner and the granted application role can read
-- them; tenant isolation for these is enforced in the application layer.
REVOKE ALL ON public.tenants,
            public.currencies,
            public.exchange_rates,
            public.permissions,
            public.login_attempts,
            public.schema_migrations FROM PUBLIC;

COMMENT ON TABLE public.tenants IS 'RLS-off global catalog (DB-002 exception): auth/bootstrap tenant lookups; app-layer protected.';
COMMENT ON TABLE public.currencies IS 'RLS-off global reference (DB-002 exception).';
COMMENT ON TABLE public.exchange_rates IS 'RLS-off global reference (DB-002 exception).';
COMMENT ON TABLE public.permissions IS 'RLS-off global catalog (DB-002 exception).';
COMMENT ON TABLE public.login_attempts IS 'RLS-off pre-auth log (DB-002 exception): no user/tenant at write time; grants restricted.';
COMMENT ON TABLE public.schema_migrations IS 'RLS-off migration bookkeeping (DB-002 exception).';
