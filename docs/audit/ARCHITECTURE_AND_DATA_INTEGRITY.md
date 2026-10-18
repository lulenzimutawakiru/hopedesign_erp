# Architecture & Data Integrity — HOPE DESIGN Enterprise ERP

Date: 2026-10-18 · Branch `main` (`5639810`)

This document records what has been verified about the database layer,
transaction boundaries, tenant scoping and key business workflows, and — just as
importantly — what has **not yet been verified** and must be traced end-to-end
before a production-readiness claim is made.

## 1. Database access model (verified)

- `apps/api/src/db.ts` wraps every query in a transaction and calls
  `set_app_context(tenant, company, branch, user)` before the query. RLS relies
  on this context (`set_config` + `set_app_context`).
- Runtime pool connects as `config.postgres.appUser` (least-privilege
  `hopedesign_app` role) with the migration owner role separate
  (`config.ts:80-89`). Production fails fast if the app role is an owner role.
- `tx()` and `detach()` provide multi-statement transaction boundaries.

**Open concern (see SEC-007):** `rejectUnauthorized: false` on the DB TLS
connection weakens transport security for remote managed Postgres.

## 2. Tenant / company / branch scoping (verified, with findings)

- Tenant is carried in the JWT (`tid`) and re-checked in `loadAuthUser`
  (`middleware/auth.ts:34`).
- `user_roles` carries `company_id`/`branch_id`; `scopeFilter` restricts list
  queries to the user's `company_id`/`branch_id`.
- RLS migrations (0126/0127/0130) are present, but the actual runtime behaviour
  (whether every table has a policy and the app role is `BYPASSRLS`-free) has
  not been exercised here because no database is reachable.
- Findings SEC-003 and SEC-005 concern the correctness of the company-scope and
  scope-filter logic respectively.

## 3. What has NOT been verified yet (must be traced before production)

The following were observed to exist (files present) but have **not** been
traced end-to-end from UI → API → service → SQL → integration, and no claim of
correctness is made:

1. **Double-entry accounting / journal balance** — `services/finance.ts`,
   `finance-advanced.ts`, migrations 0083/0093. Not yet verified that every
   posted journal balances or that posted transactions are immutable.
2. **EFRIS idempotency / outbox / retry** — `services/efris/*` and migrations
   0142/0143/0193. Idempotency keys, duplicate-submission protection, timeout
   handling and dead-letter/manual reconciliation have not been audited.
3. **Inventory concurrency** — reservation/movement under concurrent issue,
   receipt, count and adjustment; prevention of negative/double-consumed stock.
4. **QR / ream / carton traceability** — `services/qr.ts`, `services/reams.ts`,
   `services/securityPrinting.ts`, `services/niimbot.ts`. Uniqueness, sealing
   idempotency, reprint/void/recall and print acknowledgement have not been
   traced.
5. **Payroll/statutory correctness** — `services/payrollEngine.ts`,
   `statutory.ts`, `statutoryFilings.ts`. The versioned rules exist and are
   dated; numerical correctness against current URA/NSSF requirements has not
   been independently validated.
6. **Hikvision/KCB/Equity/PDPO ingress** — source-evidence handling,
   duplicate/missing event handling, and signature verification have not been
   traced.
7. **Blue/green migration compatibility** — the deploy scripts (`deploy/*.sh`)
   and migration ordering assume both API colours share a schema during a
   rollout; this has not been validated against a representative DB.

## 4. Data-integrity observations (schema level)

- Migrations are additive and sequenced (0001…0193); there is a
  `packages/db/src/migrate.js` runner and `reset.js`.
- Seed is a single idempotent pass (`seed-data.js`) with `ON CONFLICT` guards and
  sequence reconciliation for fixtures.
- Statutory/legal rules are versioned DB rows with effective dates (a good
  pattern), but see §3.5 on numerical validation.
- The `users`/`sessions` schema supports the fields needed for correct MFA
  state; the application currently does not use them correctly (SEC-001).

## 5. Next-step tracing plan

See `docs/audit/IMPLEMENTATION_ROADMAP.md` for the sequenced order. The next
tracing pass should prioritise the auth/authorization fixes (SEC-001…005) first,
then finance/EFRIS, then inventory/QR concurrency, each with a regression test.
