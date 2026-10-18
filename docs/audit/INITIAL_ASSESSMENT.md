# Initial Assessment — HOPE DESIGN Enterprise ERP

Date: 2026-10-18
Branch: `main` (HEAD `5639810`)
Repository: `lulenzimutawakiru/hopedesign_erp`

This document records the actual state of the repository as observed during the
mandatory initial audit. It distinguishes **verified facts** (confirmed by
reading the code or by executing a command) from **assumptions** and **gaps**.

## 1. Repository shape

- Monorepo with npm workspaces: `apps/api` (Express + TypeScript), `apps/web`
  (React + Vite), `packages/db` (PostgreSQL migrations + seed).
- 193 SQL migrations (`packages/db/migrations/0001…0193`) and a large, mature
  service layer under `apps/api/src/services/`.
- External integrations present: URA EFRIS (`services/efris`), Hikvision
  attendance (`services/hikvision`), KCB bank (`services/kcb`), Equity Bank
  (`services/equity`), PDPO (`services/pdpo`), Resend email
  (`services/mail`, `services/resend`), Africa's Talking SMS, Niimbot label
  printing, plus a BullMQ/Redis worker queue (`services/queue`).
- CI workflows in `.github/workflows/`: `build.yml`, `production.yml`,
  `security.yml`, `test.yml`.

## 2. Baseline commands executed (this environment)

| Command | Result |
|---|---|
| `npm run typecheck -w apps/api` | **PASS** (tsc --noEmit, no errors) |
| `npm run test -w apps/web` | **PASS** — 10 files, 80 tests |
| `npm run build -w apps/web` | running at time of writing (background) |
| `npm run test -w apps/api` | **NOT RUN** — requires live PostgreSQL |
| `docker ps` | **FAIL** — Docker Desktop daemon not running |

**Environment limitation (verified):** `apps/api/src/db.ts` opens a real
`pg.Pool` connection for every `query()`. `apps/api/tests/helpers.ts` connects
to `localhost:5432`. No PostgreSQL server is reachable in this environment
(port 5432 closed, Docker daemon off). Therefore the API integration suite
could not be executed here; the DB-backed API tests could not be run to green,
and no claim about them passing is made.

## 3. What is already in place (verified positive controls)

- **Production fail-fast gate** — `apps/api/src/config.ts:140-185` refuses to
  boot in production with weak `JWT_SECRET`/`REFRESH_SECRET`/`DOC_SIGNING_SECRET`,
  a loopback DB host, or an owner/superuser DB role. This is a strong control.
- **Secret hygiene in git** — `.gitignore` excludes `.env`, `.env.production`,
  `.env.local`, `.prod-gen.env`, `*.log`, `hv-*.json`, `tmp-*.cjs`,
  `deploy/failover.env`, `deploy/cloudflared.env`, `deploy/tunnel-ingress.env`,
  and `SECURITY_ASSESSMENT_2026.md`. None of those are git-tracked (verified).
- **Session hardening** — `sessions` table stores only `token_hash` (SHA-256 of
  the refresh token), plus `mfa_verified_at`, `revoked_at`, `expires_at`.
  `authenticate()` rejects missing/revoked/expired sessions.
- **Login hardening** — 5-attempt / 15-minute lockout, identifier normalisation,
  hashed failure logging, `auth_resolve_user_by_identifier` SECURITY DEFINER,
  email-OTP MFA with hashed + domain-separated codes, TTL and attempt limits.
- **RBAC deny-by-default** — `can()` in `middleware/authorize.ts` is
  deny-by-default with wildcard support.
- **DB least-privilege + RLS** — migrations 0124–0130 introduce a
  non-superuser `hopedesign_app` role, RLS, audit append-only, and a
  SECURITY DEFINER auth bootstrap.
- **CI secret scanning** — `security.yml` runs `npm audit --omit=dev
  --audit-level=high` (blocking) and `gitleaks`.

## 4. Modules, entities and workflows (inventory, high level)

Core business domains mapped to route files under `apps/api/src/routes/`:
CRM/Sales (`ops/crm`, `ops/sales`), Procurement (`ops/procurement`,
`ops/requisitions`), MRP (`ops/mrp`), Inventory (`ops/inventory`), Manufacturing
(`ops/manufacturing`, `ops/production`), Finance (`ops/finance`, `finance.ts`),
HR/HCM/Payroll (`ops/hr`, `ops/hcm`, `ops/myPayroll`), Security printing & QR
(`ops/security`, `qr.ts`, `publicVerification.ts`), Service Desk (`ops/serviceDesk`),
Governance (`ops/governance`), Compliance (`ops/compliance`), plus integration
routes (Hikvision, KCB, Equity, PDPO, Resend, EFRIS) and admin/platform routes.

Approval and SoD are driven by `services/workflow.ts`, `services/financeApprovals.ts`
and `sod_rules` seeded in `packages/db/src/seed-data.js`.

## 5. First-pass gap list

Confirmed and potential findings are detailed in
`docs/audit/SECURITY_FINDINGS.md`. The highest-priority, verified issues are:

1. **SEC-001** — MFA "verified" state is derived from `users.mfa_enabled`, not
   from session state (`middleware/authorize.ts:89`), and `createSession` is
   called with `mfaVerified=true` even on the non-MFA path
   (`routes/auth.ts:288`).
2. **SEC-002** — ABAC `condMatch` returns after evaluating only the first
   operator of a multi-operator condition object (`middleware/authorize.ts`).
3. **SEC-003** — Company-scope check denies users who hold a role in any other
   company (`middleware/authorize.ts:175-184`).
4. **SEC-004** — Publicly documented default admin password `ChangeMe!2026`
   shared by all 21 seeded accounts (`README.md`, `seed-data.js:3316`).
5. **SEC-005** — `scopeFilter` falls back to `1=1` and interpolates IDs into SQL.
6. **SEC-006** — CI runs DB-backed API tests with no PostgreSQL service
   (`test.yml`), so the API suite cannot pass in CI as configured.

Architecture/data-integrity observations are in
`docs/audit/ARCHITECTURE_AND_DATA_INTEGRITY.md`; the sequenced remediation plan
is in `docs/audit/IMPLEMENTATION_ROADMAP.md`.
