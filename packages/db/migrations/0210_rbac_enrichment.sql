-- ============================================================
-- Hope Design ERP — 0210 RBAC enrichment: role-assignment
-- metadata + per-user permission overrides
-- ============================================================
--
-- Two Super Administrators (Managing Director + System Administrator),
-- multi-role authorization and per-user permission overrides need three
-- things the core schema did not yet carry:
--
--   1. Assignment metadata on user_roles — which department a role was
--      granted in, who granted it, when, whether it expires, and whether
--      it is still active. Expiry/status are what let an administrator
--      hand a temporary or scoped role instead of a permanent one.
--   2. A per-user override that can grant a permission the user's roles do
--      not carry, or revoke one they do — without inventing a throwaway
--      role to express it.
--
-- Both are additive: the (user_id, role_id) primary key and every existing
-- INSERT (seed-data, admin.ts) keep working unchanged, because the new
-- columns are nullable or carry a default.

-- ---------- 1. role-assignment metadata ----------
ALTER TABLE user_roles
  ADD COLUMN department_id BIGINT REFERENCES departments(id) ON DELETE SET NULL,
  ADD COLUMN assigned_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN expires_at   TIMESTAMPTZ,
  ADD COLUMN status       TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'INACTIVE', 'EXPIRED', 'REVOKED'));

CREATE INDEX idx_user_roles_expires ON user_roles (expires_at);
CREATE INDEX idx_user_roles_status  ON user_roles (status);

-- ---------- 2. per-user permission overrides ----------
CREATE TABLE user_permission_overrides (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id BIGINT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  -- 'grant' adds a permission the user's roles do not carry; 'revoke'
  -- removes one they do. A user cannot hold both for the same permission:
  -- the two effects are contradictory, so one row per (user, permission).
  effect        TEXT NOT NULL DEFAULT 'grant' CHECK (effect IN ('grant', 'revoke')),
  company_id    BIGINT REFERENCES companies(id),
  branch_id     BIGINT REFERENCES branches(id),
  reason        TEXT,
  assigned_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'INACTIVE', 'EXPIRED', 'REVOKED')),
  UNIQUE (user_id, permission_id)
);
CREATE INDEX idx_user_perm_overrides_user   ON user_permission_overrides (user_id);
CREATE INDEX idx_user_perm_overrides_tenant ON user_permission_overrides (tenant_id);

-- Same tenant-isolation posture as the rest of the RBAC surface (see 0001).
ALTER TABLE user_permission_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_permission_overrides
  USING (tenant_id = app_tenant_id());
