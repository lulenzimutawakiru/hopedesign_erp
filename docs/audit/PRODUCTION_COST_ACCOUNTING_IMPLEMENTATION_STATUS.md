# Production Cost Accounting Modernization — Implementation Status

**Date:** 2026-11-17
**Branch:** `main` (local, **not yet pushed**)
**Companion:** [`PRODUCTION_COST_ACCOUNTING_GAP_ANALYSIS.md`](./PRODUCTION_COST_ACCOUNTING_GAP_ANALYSIS.md)

## What is done (committed)

| Phase | Commit | Content |
|---|---|---|
| 1 — Audit & gap analysis | `f95aa94` | Six-domain repository audit; gap matrix, ranked defects, plan, open decisions. |
| 2 — Costing engine consolidation | `f95aa94` | `completeWorkOrder` now totals material/labour/machine/overhead/waste/rework in a single SQL NUMERIC CTE (no JS-float accumulation); rework rolls into `actual_other_cost`; variance standardised to **standard − actual** (positive = favourable) across `completeWorkOrder`, `workOrderCosting`, `captureProductionCost`. |
| 3a — BOM line CRUD | `fd3880a` | `createBom`/`updateBom` now persist `bom_items` (validate + replace semantics + audit). |
| 3b — Labour / machine / overhead | `da0ef4d` | Migration `0248`: `machines.power_kw`/`utility_rate_per_kwh`, `work_order_operations.kwh_consumed`, `employees.hourly_rate`, `work_order_labour.employee_id`, `wip_balances.value`. `recordLabour` links to employees, defaults rate from `employees.hourly_rate`, computes cost in SQL NUMERIC. `completeWorkOrder` adds electricity (kWh × tariff) to machine cost and absorbs overhead from active `allocation_rules` (rate × driver) with a legacy work-centre fallback. |
| 6 — Reports | `0b27069` | Migration `0249`: 14 production-cost views + registry entries (`reports.production.view`). |

## Verification status

- **Typecheck:** `npx tsc --noEmit -p tsconfig.json` — clean.
- **Migrations:** `0248` and `0249` apply cleanly against the local Postgres (Docker `hopedesign_postgres`, now running).
- **New regression test:** `apps/api/tests/productionCosting.test.ts` — **2/2 pass** (pins machine+electricity, rule-based overhead, variance, yield; and employee-rate labour with SQL-computed cost).
- **Existing suites:** run but fail on **missing seed fixtures**, not on this work:
  - `production.test.ts` — `output` step 400s because the dev DB has no `FINISHED_GOODS` warehouse (only `PACK-WH`).
  - `mes.test.ts` / `reports.analytics.test.ts` — login 401s for unseeded users (`qiana.qc`, `sarah.sales`, …) and a missing seeded work order `1180`.
  - These are the long-standing "dev DB unseeded" issue from project memory; not regressions.

## Blocked — needs a decision before Phase 4 (GL postings)

The WIP→FG general-ledger chain is a **no-op today** because the Hope Design chart maps
`RAW_INV`, `FG_INV` and `WIP` to the same account `10111400` (`finance.ts:23-25`), and
`postInventoryValueChange` returns `null` when the stock and contra accounts collide
(`finance.ts:1043-1044`). Real double-entry WIP accounting requires a chart change:

- **(A) Separate accounts** — add a distinct `WIP` account (and optionally a distinct FG account), point `COA.WIP`/`COA.FG_INV` at them, then implement idempotent journals: `Dr WIP / Cr Raw` (material issue), `Dr FG / Cr WIP` (completion), `Dr Expense / Cr WIP` (abnormal loss).
- **(B) Auxiliary-only** — keep the single inventory account and track WIP/FG *value* only in `wip_balances.value` + `wip_ledger` (no GL reclassification).
- **(C) Defer** — ship Phases 2/3/6 now; revisit GL before Phase 4.

This is a **finance sign-off** (account codes + reclassification policy), so it has not been implemented unilaterally.

## Remaining (not yet done)

- **Phase 4** — WIP value engine (maintain `wip_balances.value` on material issue/output; the MES table is currently read-only/dormant) and the GL postings above (blocked on the chart decision).
- **Phase 5** — `/plant/costing` + `/finance/costing` filter set (date range, MO, product, department, status, costing status) and indicator additions.
- **Phase 6 (remainder)** — approval gating + re-approval invalidation on cost adjustment / overhead allocation / completion.
- **Phase 7** — full-lifecycle test (order → issue → labour/machine/overhead → WIP → FG → GL) + deployment/rollback notes.

## Deploy note

Nothing here is pushed. All four commits are additive (new columns with defaults, new views, new report registrations) and the core costing is covered by a passing regression test, but the broader API suite cannot be run green locally until the dev DB is seeded. Recommend seeding fixtures (or a dedicated test DB) before relying on the full CI gate, then push to trigger auto-deploy.
