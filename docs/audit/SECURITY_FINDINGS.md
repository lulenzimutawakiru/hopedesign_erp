# Security Findings — HOPE DESIGN Enterprise ERP

Date: 2026-10-18 · Branch `main` (`5639810`)

Each finding records: severity, affected file(s) with line evidence, business
impact, reproduction, recommended fix, regression test, and verification
status. **Confirmed** = verified by code inspection (and, where the environment
allows, by a passing/failing test). **Potential** = plausible defect that needs
further runtime or schema confirmation before it is treated as fixed.

Phase 2–5 (finance/EFRIS/QR/procurement/inventory/RLS) findings are tracked in
[`PHASE2_5_FINDINGS.md`](PHASE2_5_FINDINGS.md).

---

## SEC-001 — MFA "verified" state derived from `mfa_enabled`, not session state

**Severity:** Critical · **Priority:** 0 (auth/session) · **Status:** Confirmed

**Evidence**
- `apps/api/src/middleware/authorize.ts:89`
  `environmentSource.mfa_verified = !!user.mfa_enabled` — the ABAC policy
  attribute "MFA verified" is set to whether the *account* has MFA enabled.
- `apps/api/src/middleware/auth.ts:157-163` — session validation checks only
  `revoked_at IS NULL AND expires_at > now()`; it never reads `mfa_verified_at`.
- `apps/api/src/routes/auth.ts:288` — the non-MFA login branch calls
  `createSession(..., true)`, so **every** session row gets
  `mfa_verified_at = now()`, even when no second factor was performed.
- `sessions.mfa_verified_at` (migration `0001_core_identity.sql:283`) is only
  read for admin display (`routes/admin.ts:354,1420`) and the DB-restore flow
  (`services/database-admin.ts:650`) — never for authorization.

**Impact**
- An ABAC policy that gates a sensitive action on
  `environment.mfa_verified == true` can never distinguish "account has MFA
  enabled" from "this session actually passed a second-factor challenge". The
  enforcement layer therefore cannot implement the required distinction between
  *MFA enabled*, *enrolled*, *verified*, and *verified-for-this-session*.
- `sessions.mfa_verified_at` is meaningless as an audit signal (always set), so
  the audit trail cannot prove a session was MFA-verified.

**Reproduction**
1. Create a user with `mfa_enabled = false` and no privileged permissions.
2. Log in with username/password only (no MFA challenge is issued).
3. Observe the session row has `mfa_verified_at` set to `now()`.
4. Add an ABAC policy requiring `environment.mfa_verified == true`; note the
   attribute is computed from `user.mfa_enabled`, not from the session row.

**Recommended fix**
- Store the real MFA state: set `sessions.mfa_verified_at` only when a second
  factor was actually verified (challenge passed or a fresh, verified
  enrollment); leave it `NULL` otherwise.
- Load `sessions.mfa_verified_at` in `authenticate()` and expose it on
  `req.auth` / `req.ctx`; derive `environmentSource.mfa_verified` from that
  value, never from `user.mfa_enabled`.
- Keep a separate `mfa_enabled` (account-level) vs `mfa_verified` (session-level)
  vs a future `step_up` (recent re-verification for a sensitive action).

**Regression test**
- Unit: ABAC environment source reports `mfa_verified:false` when the session has
  no `mfa_verified_at`, even when `user.mfa_enabled` is true.
- Integration: non-MFA login produces a session with `mfa_verified_at IS NULL`;
  MFA login produces a session with `mfa_verified_at` set; a policy keyed on
  `mfa_verified` denies the former and allows the latter.

**Fix applied**
- `middleware/auth.ts` now reads `mfa_verified_at` from the live session row and
  sets `user.mfa_verified_at`; `authorize.ts` derives `environment.mfa_verified`
  from `!!user.mfa_verified_at` (no longer `mfa_enabled`).
- `routes/auth.ts` passes `mfaVerified=false` on the password-only login,
  accept-invite and password-reset paths; MFA-verified paths still pass `true`.
- Regression tests added in `tests/auth.test.ts` (DB-backed) and covered by the
  pure `authorize.test.ts` suite.

**Verification status:** fix implemented; typecheck passes. DB-backed integration
tests added but not yet executed (environment has no PostgreSQL).

---

## SEC-002 — ABAC `condMatch` short-circuits multi-operator conditions

**Severity:** High · **Priority:** 0 (RBAC/ABAC) · **Status:** Confirmed (latent)

**Evidence**
- `apps/api/src/middleware/authorize.ts:107-147` — for an object condition
  (`cond` is a non-array object), the loop `for (const [op, operand] of
  Object.entries(ops))` executes a `switch` where **every** case `return`s
  immediately. A condition object carrying more than one operator (e.g.
  `{ "$gte": 100, "$lte": 500 }`) is evaluated only on the first operator and
  returns, ignoring the rest.

**Impact**
- Range/compound constraints in ABAC policy attributes are silently ignored. A
  policy meant to require `100 <= value <= 500` would only check `value >= 100`.
- No currently-seeded policy uses a multi-operator object (verified in
  `seed-data.js:3418-3450` and the service-desk ABAC migrations), so this is
  latent today — but it is a correctness defect in the authorization engine and
  a named requirement of this audit ("must not return success after checking
  only one of several operators").

**Recommended fix**
- Treat all operators in one object as a conjunction: evaluate each; return
  `false` on the first unmet operator; return `true` only when all are met (and
  keep the existing "empty object = no constraint" behaviour).

**Regression test**
- Unit: `condMatch({ "$gte": 100, "$lte": 500 }, 50)` → false;
  `(…, 300)` → true; `(…, 600)` → false. Export the evaluator (or extract it into
  a pure module) to make it directly testable.

**Fix applied**
- Extracted a pure `condMatch`/`attrMatches` into `apps/api/src/abac.ts`; object
  conditions are now evaluated as a conjunction over all operators.
- `tests/abac.test.ts` covers the SEC-002 case and passes (11/11).

**Verification status:** fixed; unit tests passing (11/11).

---

## SEC-003 — Company-scope check denies multi-company role holders

**Severity:** High · **Priority:** 0 (RBAC scope) · **Status:** Confirmed (data
model traced; fix deferred pending DB-backed verification)

**Evidence**
- `apps/api/src/middleware/authorize.ts` (scope check)
  ```sql
  SELECT 1 FROM user_roles ur
   WHERE ur.user_id = $1 AND ur.company_id IS NOT NULL AND ur.company_id <> $2
   LIMIT 1
  ```
  followed by `forbidden('Role scope does not cover this company')` if any row
  matches. This denies whenever the user holds **any** company-scoped role grant
  in a company other than the current context — even when the grant authorising
  the current action is valid for the current company.
- `apps/api/src/middleware/auth.ts` `PERMS_SQL` loads the permission **union**
  across all of the user's roles with no company predicate:
  ```sql
  SELECT DISTINCT p.code
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
    JOIN user_roles ur ON ur.role_id = rp.role_id
   WHERE ur.user_id = $1
  ```
  so `user.permissions` cannot distinguish "permitted in company A" from
  "permitted in company B". The separate scope check is a broken attempt to
  recover that distinction.

**Data model (confirmed)**
- `users.company_id` / `users.branch_id` are single nullable columns
  (`0001_core_identity.sql:247-248`) — the user's *active* company/branch.
  `users.default_company_id` (`0042_user_default_company.sql`) is only the UI
  pre-selection; there is no per-request company-switch endpoint in the API
  (verified by grep for switch/active-company routes).
- `user_roles` (`0001_core_identity.sql:332-338`) has `company_id`/`branch_id`
  nullable (NULL = tenant-wide) and `PRIMARY KEY (user_id, role_id)` — one grant
  per role, so a multi-company user holds *different* roles per company.

**Impact**
- A user legitimately assigned roles in two companies is denied in *both*
  companies, because the other company's grant always satisfies the `<>` test.
  This matches the audit requirement "multiple legitimate company assignments
  must not cause unrelated access to be denied."
- Conversely, the current scope check cannot actually stop a company-B-only
  permission from being exercised in company A: it only denies when a *foreign*
  grant exists, not when the *current* grant is absent.

**Recommended fix (precise)**
- Resolve permissions against the *effective* grant for the active company.
  Change `PERMS_SQL` to:
  ```sql
  WHERE ur.user_id = $1 AND (ur.company_id IS NULL OR ur.company_id = $2)
  ```
  with `$2 = user.company_id` (the active company), and apply the same predicate
  to the delegation-permission query. Then the standalone "any other company"
  scope check is redundant and should be removed, because `can()` already fails
  for permissions not granted in the active company.
- Consider the same `(branch_id IS NULL OR branch_id = $activeBranch)` predicate
  for branch-scoped grants once branch-switch semantics are defined.

**Regression test**
- Integration: a user with a company-scoped role in both company A and company B
  can perform an allowed action in company A and in company B; is still denied
  an action in company A that only their company-B grant would authorise.

**Verification status:** model confirmed; fix is a broad authorization-model
change with no pure unit surface (it lives in `loadAuthUser`'s SQL), so it is
**deferred** until DB-backed `rbac`/`sod` integration tests can be executed
(blocked locally — no PostgreSQL; see SEC-006 for the CI harness).

---

## SEC-004 — Publicly documented default credentials

**Severity:** High · **Priority:** 0 (admin provisioning) · **Status:** Confirmed

**Evidence**
- `packages/db/src/seed-data.js:3316` — `bcrypt.hashSync("ChangeMe!2026", 10)`
  is used for **all 21 seeded accounts**, including `super_administrator`.
- `README.md:21` and `README.md:33` publicly document `admin / ChangeMe!2026`.
- `README.md:94` and `apps/api/scripts/niimbot-bridge.ts` use
  `PRINTER_PASSWORD='ChangeMe!2026'` as the documented Niimbot bridge default.
- `must_change_password: true` is set (`seed-data.js:3335`), and the login flow
  enforces a change server-side — this mitigates but does not remove the
  dependence on a publicly documented, shared, known password.

**Impact**
- If `SEED_ON_BOOT` is left enabled in production, a reseed restores known
  passwords for privileged accounts. The documented default is a shared secret
  across the internet-facing deployment instructions.

**Recommended fix**
- Generate a unique, CSPRNG bootstrap password per privileged account (or per
  bootstrap run), never hardcode it, never print it to logs/CI, and require an
  explicit production bootstrap confirmation. Enforce first-login change
  server-side (already present) and require MFA enrollment for privileged roles
  (partially present). Document secure admin recovery.
- Treat the Niimbot bridge password as a deployment secret, not a documented
  literal.

**Fix applied**
- New `packages/db/src/seed-password.js` with `resolveSeedPassword()`:
  `SEED_ADMIN_PASSWORD` (when set) is used verbatim; **production refuses the
  dev default** (throws) so `SEED_ON_BOOT` cannot restore `ChangeMe!2026`;
  dev/test keep the documented default so the DB-backed test suite and local
  setup log in unchanged. `randomSeedPassword()` provides a CSPRNG generator for
  deploy tooling; the seed never prints the secret.
- `packages/db/src/seed-data.js` now hashes `resolveSeedPassword()` instead of
  the hardcoded literal.
- `deploy/generate-env.mjs` generates a strong `SEED_ADMIN_PASSWORD` into the
  0600 `.env.production`; `deploy/README.md` + `README.md` no longer tell
  operators to use the documented default in production; the Niimbot example
  credential is de-literalised.
- `tests/seed-password.test.ts` pins the policy (5/5 passing).

**Verification status:** fixed; unit tests passing (5/5). The remaining
per-account-uniqueness refinement (distinct hash per privileged account) is
tracked as a hardening follow-up rather than a blocker, since every seeded
account still enforces a first-login change and production now uses a unique
per-bootstrap secret.

---

## SEC-005 — `scopeFilter` `1=1` fallback and string interpolation

**Severity:** Medium · **Priority:** 0 (authorization) · **Status:** Confirmed

**Evidence**
- `apps/api/src/middleware/authorize.ts:194-203`
  ```ts
  if (!user) return '1=0';
  if (user.company_id) conds.push(`${tableAlias}.company_id = ${user.company_id}`);
  if (user.branch_id) conds.push(`${tableAlias}.branch_id = ${user.branch_id}`);
  return conds.length ? conds.join(' AND ') : '1=1';
  ```
  - For a user with no `company_id` and no `branch_id`, the filter returns
    `1=1` (no restriction). Whether that grants tenant-wide visibility depends
    on the caller, but the named requirement "`1=1` must not become the implicit
    authorization fallback" applies.
  - `company_id`/`branch_id` are interpolated as raw strings. They originate
    from `loadAuthUser` (DB values, not request input), so injection risk is low
    today, but the pattern is fragile and should be parameterised.

**Recommended fix**
- Parameterise the scope predicate and make the no-scope case explicitly
  deny-by-default (return `1=0`) unless the caller is an authorised
  tenant-wide role; otherwise require a scope and fail closed.

**Regression test**
- Unit: `scopeFilter` returns a parameterised predicate for a scoped user, and a
  fail-closed predicate for a scope-less user (not `1=1`).

**Fix applied**
- `scopeFilter` now returns `{ clause, params }` with bound `$1`/`$2` parameters
  (no interpolation) and fails closed (`1=0`) for ordinary scope-less users;
  only `system.admin.all` / `*` get a tenant-wide `TRUE` clause.
- The single caller (`routes/ops/security.ts`) passes the bound params through.
- `tests/authorize.test.ts` covers the fail-closed and parameterisation cases.

**Verification status:** fixed; unit tests passing (7/7).

---

## SEC-006 — CI runs DB-backed API tests with no PostgreSQL service

**Severity:** Medium · **Priority:** 5 (tests) · **Status:** Confirmed (CI config)

**Evidence**
- `.github/workflows/test.yml` runs `npm run test -w apps/api` with no
  `services:` PostgreSQL and no Redis. `apps/api/tests/helpers.ts` opens a real
  `pg.Pool` to `localhost:5432`, and `apps/api/src/db.ts` connects a real pool
  for every query. The suite therefore cannot pass in CI as configured.

**Impact**
- The DB-backed API test suite does not actually gate merges; regressions in
  auth/RBAC/SoD/inventory/finance can land unnoticed.

**Recommended fix**
- Add a PostgreSQL (and Redis, for queue tests) service to `test.yml`, run
  migrations before the API test step, and make the suite idempotent against a
  shared database (the helpers already clear shared tables).

**Fix applied**
- `.github/workflows/test.yml` now provisions `postgres:16-alpine` and
  `redis:7-alpine` services, sets `DATABASE_URL`, and runs `db:migrate` +
  `db:seed` before the API test step.
- Note: `tests/queue.test.ts` never opens a Redis connection (pure unit tests),
  so Redis is provisioned for future queue/worker tests rather than as a current
  hard dependency.

**Verification status:** fix applied; awaiting CI run (not verifiable locally — no Docker/Postgres on this workstation).

---

## SEC-007 — Relaxed TLS for database connections

**Severity:** Medium · **Priority:** 4 (transport) · **Status:** Confirmed

**Evidence**
- `apps/api/src/db.ts:16` — `ssl: config.postgres.ssl ? { rejectUnauthorized: false } : undefined`.

**Impact**
- When connecting to a managed Postgres over the internet, certificate
  verification is disabled, permitting MITM of the DB connection (including RLS
  context, queries, and results). The inline comment acknowledges this and asks
  to "tighten to true" later.

**Recommended fix**
- Default `rejectUnauthorized` to `true` for non-loopback hosts; allow an
  explicit, documented opt-out only for verified internal CA chains.

**Fix applied**
- `config.postgres.rejectUnauthorized` now defaults to `true` (opt-out via
  `POSTGRES_SSL_REJECT_UNAUTHORIZED=false`); `db.ts` uses it instead of a
  hard-coded `false`.
- `tests/config.test.ts` pins the secure default.

**Verification status:** fixed; unit test passing.

---

## Positive controls already present (do not regress)

- Production boot gate for weak secrets / owner DB role (`config.ts:140-185`).
- Refresh tokens stored as SHA-256 hashes; sessions revocable/expiring.
- Login lockout, hashed failure logs, SECURITY DEFINER identifier resolution.
- Email-OTP MFA: CSPRNG, hashed + domain-separated, TTL + attempt limits.
- RBAC deny-by-default (`can()`); seeded SoD rules.
- RLS + least-privilege `hopedesign_app` DB role (migrations 0126/0127/0130).
- `.gitignore` excludes live secrets, logs, and diagnostic JSON.
