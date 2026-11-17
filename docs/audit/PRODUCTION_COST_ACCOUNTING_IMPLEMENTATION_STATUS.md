# Production Cost Accounting Modernization — Implementation Status

**Date:** 2026-11-17
**Branch:** `main` (local, **not yet pushed**)
**Companion:** [`PRODUCTION_COST_ACCOUNTING_GAP_ANALYSIS.md`](./PRODUCTION_COST_ACCOUNTING_GAP_ANALYSIS.md)

## What is done (committed)

| Phase | Commit | Content |
|---|---|---|
| 1 — Audit & gap analysis | `f95aa94` | Six-domain repository audit; gap matrix, ranked defects, plan, open decisions. |
| 2 — Costing engine consolidation | `f95aa94` | `completeWorkOrder` totals material/labour/machine/overhead/waste/rework in a single SQL NUMERIC CTE; variance = **standard − actual** (positive = favourable). |
| 3a — BOM line CRUD | `fd3880a` | `createBom`/`updateBom` persist `bom_items`. |
| 3b — Labour / machine / overhead | `da0ef4d` | Migration `0248`; `recordLabour` links employees + SQL-computed cost; electricity + rule-based overhead absorption. |
| 6 — Reports | `0b27069` | Migration `0249`: 14 production-cost views + registry. |
| 4 — WIP GL postings | `c3e63c6` | Migration `0250`: distinct WIP asset `10111410` + abnormal-loss `10251820`. `COA.WIP` repointed → `Dr WIP/Cr Raw`, `Dr FG/Cr WIP`, and `Dr Abnormal loss/Cr WIP` are live. |
| 5 — Filter set | `9845c39` | Server-side filters for `/plant/costing` + `/finance/costing`: date range, MO, product, department (facility), status, costing status. |
| 6 — Posting gate | `9845c39` | `postProductionCost` refuses to post finished-goods value for an in-progress work order. |
| 7 — Lifecycle test | `9845c39` | Full lifecycle regression test (issue → labour → output → complete → GL). |

## Verification status

- **Typecheck:** `npx tsc --noEmit -p tsconfig.json` — clean.
- **Migrations:** `0248`, `0249`, `0250` apply cleanly against local Postgres (Docker, now running).
- **New regression suite:** `apps/api/tests/productionCosting.test.ts` — **8/8 pass**:
  - machine + electricity, rule-based overhead, variance, yield (SQL NUMERIC);
  - employee-rate labour (SQL-computed cost);
  - `Dr FG / Cr WIP` production move (WIP distinct from inventory);
  - `Dr Abnormal loss / Cr WIP`;
  - costing-desk + finance costing filter sets;
  - posting gate (in-progress WO → refuse);
  - full lifecycle with GL assertions.
- **Existing suites:** fail only on the long-standing unseeded-dev-DB fixtures (no `FINISHED_GOODS` warehouse; missing users `qiana.qc`/`sarah.sales`; missing WO `1180`), not on this work.

## Remaining (not implemented)

- **Phase 4 (labour/overhead absorption into FG at *actual* cost):** the GL holds FG at **standard** cost (existing `recordOutput` GOOD posting) while the engine computes actual cost for variance reporting — a coherent *standard-costing* model. Absorbing actual conversion cost into the ledger (a *normal-costing* switch) and posting the period variance to P&L remain a finance-policy decision (which variance account, favourable/unfavourable treatment).
- **Phase 5 (frontend filter UI):** the API now exposes the full filter set; the web costing-desk/finance views still filter client-side and have not been wired to the new query params.
- **Phase 6 (full approval workflow on production cost sheets):** `production_costs` is not a workflow entity; approval gating today is the completion gate above. A full maker–checker workflow (submit/approve on the cost sheet, re-approval invalidation via the existing material-hash machinery) would require registering `production_costs` in `ENTITIES` with its own status semantics.
- **Phase 7 (end-to-end HTTP lifecycle test):** blocked by unseeded dev fixtures (FINISHED_GOODS warehouse); covered at the service layer instead.

## Deploy / rollback notes

**Deploy** (production is a single node with `deploy/auto-deploy.sh` watching the repo; pushing `main` triggers a ~20 min rollout):
1. Migrations run automatically on boot (`packages/db/src/migrate.js`, advisory lock 88100). `0250` is idempotent (`ON CONFLICT (company_id, code) DO NOTHING`) and adds accounts for **every** company.
2. No data migration: new columns have defaults; existing journals are untouched.

**Behaviour change to review:** once `0250` is applied, material issues and good-output postings **start posting to the GL** (`Dr WIP/Cr Raw`, `Dr FG/Cr WIP`) where they previously no-oped. For a company that already runs production without WIP on the chart, this will begin moving balances through `10111410`. Confirm finance has signed off on the account codes before relying on the trial balance.

**Rollback:**
- Revert `COA.WIP` to `10111400` in `finance.ts` (single line) to restore the old no-op behaviour without touching the migration.
- The `10111410`/`10251820` accounts can be left in the chart (they are harmless and zero-balance) or deactivated via `is_active = false`.
