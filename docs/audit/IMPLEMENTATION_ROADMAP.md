# Implementation Roadmap — HOPE DESIGN Enterprise ERP

Date: 2026-10-18 · Branch `main` (`5639810`)

Sequenced plan. Each item is a small, reviewable change with a regression test,
except where a change is explicitly a larger refactor. Priority ordering follows
the audit's Priority 0 → 5 emphasis: auth/session → RBAC/ABAC/scope → DB/transaction
integrity → finance/EFRIS → manufacturing/inventory/QR → operational.

## Phase 0 — Authorization correctness (in progress)

| ID | Change | Test | Status |
|---|---|---|---|
| SEC-001 | Plumb session `mfa_verified_at` into the request context; derive ABAC `mfa_verified` from it; set the session flag only when a factor was actually verified | unit + integration | done (integration tests added, awaiting DB) |
| SEC-002 | Fix `condMatch` to AND all operators in a condition object; extract to a pure module for direct testing | unit | done (11/11) |
| SEC-003 | Make company-scope evaluation per-effective-grant, not "any other company grant" | integration | model confirmed; fix deferred (needs DB-backed rbac/sod tests) |
| SEC-005 | Parameterise `scopeFilter`; make scope-less list access fail closed (deny-by-default) | unit | done (7/7) |
| SEC-004 | Replace shared default seed password with per-run CSPRNG bootstrap; keep first-login change + MFA enrolment enforced | seed + unit | done (5/5; production refuses default) |
| SEC-007 | Default `rejectUnauthorized:true` for non-loopback DB hosts | unit (config) | done (1/1) |

## Phase 1 — CI / test harness

- SEC-006: add PostgreSQL + Redis services to `.github/workflows/test.yml`,
  run migrations before the API test step, verify the API suite goes green.
  **Status: fix applied (services + migrate/seed added); awaiting CI run.**

## Phase 2 — DB & transaction integrity

- Trace double-entry posting, journal balance, posted-transaction immutability.
- Verify inventory concurrency (reservation/issue/receipt/count) and add row-lock
  / optimistic-locking where missing.
- Verify RLS coverage for every tenant-scoped table under the app role.

**Status: traced.** Negative-stock, reservation and RLS controls are already
enforced at the DB layer (positive). Remaining items are Medium/Low concurrency
gaps (reservation consume/release idempotency, FIFO layer lock, over-receive,
stale count snapshot, MES over-issue) — documented in `PHASE2_5_FINDINGS.md`
(INV-003/INV-004, RLS-002) and deferred to DB-backed verification.

## Phase 3 — Finance & EFRIS

- Verify EFRIS idempotency keys, duplicate-submission protection, timeout/
  unknown-outcome handling, bounded retries, dead-letter and manual
  reconciliation. Confirm request/response fields against the official URA
  documentation already in the repo — no invented fields/rates.

**Status: fixes applied.** Three-way match now enforced at posting (FIN-001);
CLOSED periods are terminal (FIN-002); EFRIS reconciliation query fixed
(EFRIS-001). Idempotency chain confirmed present (EFRIS-002); journal
immutability trigger documented and deferred (FIN-003).

## Phase 4 — Manufacturing / inventory / QR traceability

- Verify BOM/routing, planned-vs-actual consumption, yields/scrap/rework,
  lot/batch traceability, quality hold/release, stock counts with approvals,
  negative/double-consumption prevention.
- Verify QR identifier entropy, uniqueness constraints, packing/sealing
  idempotency, reprint/void/recall, print acknowledgement, and public-verify
  rate limiting / minimal disclosure.

**Status: fixes applied.** QR secret no longer persisted in the scan log
(QR-001, migration 0194 + scrub); QR-level recall wired (QR-002).

## Phase 5 — Procurement / HR / payroll / attendance

- Procurement SoD (request/approve/receive/pay) and three-way match.
- Payroll maker-checker, salary/PII access controls, versioned statutory rules
  validated against current Ugandan requirements.
- Hikvision event source-evidence handling (duplicates/missing/out-of-order).

**Status: fixes applied.** PO approval SoD enforced (PROC-001); FY2026/27 PAYE
bands confirmed reproducible (PAY-001).

## Definition of done for each item

- Root cause confirmed in code with `file:line` evidence.
- Fix implemented as a small, reviewable change that preserves existing behaviour
  and data.
- Regression test added and (where a DB is available) executed to green.
- Finding status updated in `docs/audit/SECURITY_FINDINGS.md`.

## Environment note

This workstation has no running PostgreSQL/Redis (Docker Desktop daemon off), so
DB-backed API tests cannot be executed here. Fixes that are pure functions
(condMatch, scopeFilter, config TLS) can be fully verified by unit tests; the
session/MFA and scope integration changes additionally need a database, and will
be flagged for CI verification once Phase 1 lands.
