# Dual Super Administrator, Multi-Role Authorization & Smart Approvals — Implementation Report

**Date:** 2026-10-31
**Scope:** the "MASTER DEVELOPMENT PROMPT" for two equal Super Administrators, multi-role authorization with assignment metadata, per-user permission overrides, and the smart-approval business-authority rule.

## Bottom line

The existing RBAC / approval engine already implemented most of the spec: multi-role permission union (`PERMS_SQL`), super-admin bypass (`can()`), ABAC (`policies`), segregation of duties (`sod_rules`), amount-banded approval limits, a multi-step workflow engine with escalation/delegation/material-hash invalidation, and final-authority self-authorization. Rebuilding any of that would have duplicated working mechanisms, which the prompt explicitly forbids.

So this change adds only the genuine gaps — **assignment metadata + expiry enforcement**, **per-user permission overrides**, and the **business-authority rule** that stops a System Administrator from self-approving their own major business transaction — and reuses everything else.

| Deliverable | Status |
|---|---|
| Migration `0210_rbac_enrichment.sql` (role metadata + overrides) | ✅ done |
| Expiry/status enforced in permission evaluation | ✅ done (auth, authorize, workflow, dashboard, security-printing, service-desk) |
| `user_permission_overrides` + admin API | ✅ done |
| Business-authority rule (SA no longer self-authorizes) | ✅ done |
| Automated tests | ✅ written (not run — DB down, see below) |
| Managing Director "equal" role + MD user seed | ⏸ product decision — lives in `catalogue.js` / `seed-data.js` (see below) |

## Gap analysis

The prompt's step 1 ("inspect the existing architecture first") surfaced that the following already exist and were **reused, not duplicated**:

- **Roles / role_permissions / user_roles / permissions** — `0001_core_identity.sql`.
- **Multi-role union** — `auth.ts` `PERMS_SQL` (`SELECT DISTINCT … UNION`-style join across all of a user's roles).
- **Super-admin bypass** — `can()` returns true on `system.admin.all` / `*`.
- **ABAC** — `policies` + `attrMatches` in `requirePermission`.
- **SoD** — `sod_rules`, enforced in `requirePermission` and again in `workflow.ts`.
- **Approval limits** — `approval_limits` (role × module × currency, min/max).
- **Smart-approval categories** — the three spec categories map onto existing, config-driven mechanics: **AUTO** = `ENTITIES[…].requiresApproval === false` (no approval chain); **OPERATIONS MANAGER** = a workflow whose step names `operations_manager`; **MAJOR OPERATIONS** = a workflow with an operations step then a `managing_director` step, with `amount_min`/`amount_max` bands. No separate "category" table was added — that would be a duplicate mechanism.
- **Self-authorization / escalation / delegation** — `workflow.ts` `selfAuthorize`, `decideTask`, escalation cron, delegation limits.
- **`operations_manager` role** — already present in the catalogue (`catalogue.js:827`), closing what looked like a potential gap.

The genuine gaps, now closed:

1. `user_roles` carried no `department_id` / `assigned_by` / `assigned_at` / `expires_at` / `status`, and **expiry was not enforced anywhere**.
2. No `user_permission_overrides` table existed.
3. `SELF_AUTHORIZE_ROLES` included `super_administrator`, so a System Administrator self-approved their own major business transactions — contradicting "SA must route major business transactions to MD".

## What changed

### `packages/db/migrations/0210_rbac_enrichment.sql`
- Adds `department_id`, `assigned_by`, `assigned_at`, `expires_at`, `status` to `user_roles` (all nullable or defaulted, so every existing `INSERT (user_id, role_id, company_id, branch_id)` — seed-data and admin — keeps working; the `(user_id, role_id)` PK is unchanged).
- Creates `user_permission_overrides` (tenant, user, permission, `effect` grant/revoke, scope, reason, assigner, expiry, status) with RLS tenant isolation.

### `apps/api/src/middleware/auth.ts`
- `ROLES_SQL` / `PERMS_SQL` now filter `ur.status = 'ACTIVE'` and `(ur.expires_at IS NULL OR ur.expires_at > now())`.
- New `OVERRIDES_SQL`; `loadAuthUser` unions role + delegation permissions then applies overrides last — a `revoke` also beats a delegation that carries the same code, a `grant` adds a code no role has.
- Roles now expose `department_id` and `expires_at`.

### `apps/api/src/middleware/authorize.ts`
- SoD conflict check and the company-scope check both ignore expired / non-active `user_roles`.

### `apps/api/src/services/workflow.ts`
- `SELF_AUTHORIZE_ROLES` drops `super_administrator` (now `managing_director`, `executive_director`, `ceo`). A System Administrator's major business submission now routes through the normal workflow to the Managing Director instead of self-approving.
- `selfAuthorizeRole`, the `decideTask` role check, and the approval-queue direct-role check all ignore expired / non-active `user_roles`.

### Secondary role-membership checks (consistent enforcement)
- `securityPrinting.ts` `assertRole` (dual-control custody), `dashboard.ts` pending-approvals queue, and `serviceDeskAccess.ts` `usersWithRole` now filter active + unexpired roles.

### `apps/api/src/routes/admin.ts`
- `POST /users/:id/roles` accepts `department_id`, `expires_at`, `status` and records `assigned_by`/`assigned_at`; re-assigning upserts so an expiry/status refresh sticks.
- `GET /users/:id` now returns full role metadata (assigner, department, expiry, status).
- New endpoints: `GET/POST /users/:id/permission-overrides`, `DELETE /users/:id/permission-overrides/:overrideId`.

### `apps/api/tests/rbacEnrichment.test.ts`
Six tests: grant override adds a permission, revoke override removes one, expired override grants nothing, expired role assignment grants nothing, active role assignment grants, revoked role assignment grants nothing. `sarah.sales` (sales-only, no inventory) is the target so the grant/revoke boundary is unambiguous.

## Business-authority rule — operational note

Removing `super_administrator` from the self-authorize list is the spec's intent, but it is a behaviour change for the seeded `admin` user, who holds `super_administrator` + `system_administrator`. Previously their submissions self-authorized; now a major business transaction they submit enters the workflow and is routed to the `managing_director` step. Until a user actually holds `managing_director` (see the next section), such a transaction sits PENDING at that step — **fail-closed, exactly as specified**, but worth knowing before it is exercised in production.

## Remaining product decisions (your files)

These live in `packages/db/src/catalogue.js` and `seed-data.js`, which I left untouched. Recommend one of:

**A — keep the roles as-is** (the "equal" is equal *system authority* in the sense of equal standing as super administrators, not identical admin-screen access):
- No change needed; the MD role already exists and is the final business approver.

**B — make `managing_director` a true full-super-admin** (equal *system* authority, MD manages the system too), in `catalogue.js`:
```js
{ code: "managing_director", name: "Managing Director", grants: ["*"] },
```

Either way, **seed a Managing Director user** holding `managing_director` (in `seed-data.js` alongside the `admin`/`opus.ops` definitions), otherwise the business-authority rule has no final approver to route to.

## Test status

`npm run typecheck` is green for **both** `apps/api` and `apps/web`. The new test file collects but the integration suite cannot run at write time — **Postgres is down** (`ECONNREFUSED 127.0.0.1:5432`). Once the DB is up:

```
cd apps/api && npx vitest run tests/rbacEnrichment.test.ts
```

(`db:seed` is still failing on `financial_periods_company_id_code_key` — see `docs/audit/AUDIT_2026-10-20.md`.)

## Deploy

Migration `0210` is applied automatically by `deploy/docker-entrypoint.mjs` on the next container boot, so the normal manual `plink` / `zero-downtime-deploy.sh` path is sufficient — no separate migration step.
