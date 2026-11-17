# Production Cost Accounting Modernization — Repository Audit & Gap Analysis

**Date:** 2026-11-17
**Repository:** `lulenzimutawakiru/hopedesign_erp` (branch `main`)
**Scope:** Manufacturing → Production Cost Accounting (per MASTER IMPLEMENTATION PROMPT)
**Method:** Six read-only domain audits across backend, DB, frontend, tests. All findings cite `file:line`.

---

## 1. Executive summary

The ERP already has a **mature manufacturing execution layer** and a **mature accounting layer**, plus **two costing UIs** that already render a cost-sheet and WIP screen. This is a *modernization / integration* exercise, **not** a greenfield build — exactly as the prompt directs.

However, production costing is currently fragmented across **two disconnected engines** with opposite conventions, and the **WIP→Finished-Goods general-ledger chain is a structural no-op** because the Hope Design chart of accounts collapses Raw / Finished-Goods / WIP into a single account (`10111400`). In consequence: physical stock and per-order cost *columns* are captured correctly, but the financial statements never see a WIP or FG reclassification.

The gap analysis below ranks what exists, what is partial, what is missing, and what is defective. Section 6 proposes an incremental plan. Section 7 lists the decisions that block specific phases.

---

## 2. Architecture recap (what already exists)

| Layer | Assets | Where |
|---|---|---|
| Manufacturing exec | Work orders, versioned BOM, material reservation/issue (FIFO+batch), output (good/scrap/waste/rework), QC inspection + hold/disposition, machine OEE/telemetry, downtime, shift handover, NCR | `apps/api/src/services/manufacturing.ts`, `production.ts`; routes `/api/ops/manufacturing`, `/api/ops/production` |
| Costing UI | `/plant/costing` → `MmsCosting` (dashboard + per-order cost + unit economics); `/finance/costing` → `Costing` (cost sheet + WIP ledger + capture/post) | `MmsViews.tsx:2833`, `FinanceFlow.tsx:8187` |
| Cost fields | `work_orders.{standard_cost, actual_material/labour/machine/overhead/waste/other_cost, actual_cost, cost_variance, yield_percent, efficiency_percent}` | migration `0006_production_quality.sql:69-80` |
| Cost-sheet tables | `production_costs`, `production_cost_components`, `cost_variances`, `wip_ledger`, `allocation_rules` | migration `0083_finance_advanced.sql:337-414` |
| GL engine | `postJournalLines` → SQL `post_journal()`; balance assert; idempotent `gl_posted` guards; `reverse_journal`; `voidJournal` | `finance.ts:254`, `0010_finance.sql:206`, `0083_finance_advanced.sql:53-121` |
| Payroll | Posts wages to GL split by `employees.cost_centre_id` (already the correct wages channel) | `finance.ts:805-959`, `hr.ts:1614` |
| Expenses | `FACTORY` category group, cost-centre/department/budget tagging, approval workflow, GL posting | `expenses.ts` |
| Approvals | Generic 2-step workflow engine, SoD (no self-approval), append-only audit (`audit_row()` + RLS) | `workflow.ts`, `audit.ts`, `0013_views_triggers.sql` |
| Period control | `financial_periods` + `assertPeriodOpen`; terminal `CLOSED` | `finance.ts:239-251`, `0010_finance.sql:41-55` |
| Tests | 64 API test files + 20 web test files (incl. `production.test.ts`, `mes.test.ts`, `stockEntries.test.ts`, `finance.test.ts`, `payrollEngine*.test.ts`, `workflow*.test.ts`, `sod.test.ts`) | `apps/api/tests/`, `apps/web/src/**` |

---

## 3. Domain-by-domain gap matrix

Legend: ✅ implemented · ⚠️ partial · ❌ missing/defective

### 3.1 Costing engine
- ✅ Standard vs actual cost, per-order variance, per-unit cost (on-the-fly), yield/efficiency — `production.ts:766-823`, `manufacturing.ts:1492/1584`.
- ❌ **Two disconnected engines** — `production.ts` (server-computed at completion) vs `finance-advanced.ts` (`captureProductionCost`/`postProductionCost`, manual finance cost sheet). They do not reconcile.
- ❌ **Opposite variance sign conventions** — Engine A `standard − actual`; Engine B `actual − expected` (`finance-advanced.ts:1087/1125`). Same event reports opposite sign.
- ❌ **JS float arithmetic** feeds NUMERIC columns — `round2 = Math.round(n*100)/100` in `finance-advanced.ts:16`, `manufacturing.ts:8`, `production.ts:12`. No SQL-side/DECIMAL production-cost computation (violates prompt §3).
- ⚠️ **Cost per good unit** missing — divides by `produced_qty`, not good units; `production_batches.good_qty/rejected_qty` are dormant (`0101:239-242`).
- ❌ **Rework cost never rolled** into `actual_cost`; scrap cost is overwritten by `completeWorkOrder` (`production.ts:805` discards `recordScrap`'s accumulated `actual_waste_cost`).

### 3.2 BOM & material costing
- ✅ BOM header + versioned MES BOM (`boms`, `bom_items`, `bom_versions`, `bom_version_lines`, `bom_substitutes`, `bom_co_products`); wastage via `bom_items.scrap_percent` / `bom_version_lines.scrap_factor`.
- ❌ **BOM line maintenance missing** — no API/service writes `bom_items`/`bom_version_lines`; `createBom` is header-only, `copyBom` is the only line-writing path (`manufacturing.ts:2939-3193`).
- ❌ **Standard material cost not stored on BOM** — pulled live from `products.standard_cost` at WO creation; no per-BOM-line standard cost.
- ⚠️ **UOM recorded, never converted** on issue/consumption (`manufacturing.ts:686`, `production.ts:465`).
- ✅ Actual consumption originates from authorized inventory moves (`PRODUCTION_ISSUE`, FIFO/batch-first) — `inventory.ts:39`, `manufacturing.ts:676-684`.
- ❌ `production_material_reservations.consumed_qty` and `production_batches.good_qty/rejected_qty` are never written.

### 3.3 Direct labour
- ⚠️ `work_order_labour` exists but references **`users` not `employees`**; no operation/stage column, no team, no overtime flag, no cost-centre link (`0006:125-135`).
- ❌ **No employee hourly rate** (`salary_type='HOURLY'` is inert — `hr.ts` treats everything as monthly).
- ❌ Attendance `worked_minutes`/`overtime_minutes` are available (`attendance_records`) but **unused** for labour costing or payroll overtime (`auto_overtime_from_attendance` is config-only, never wired).
- ✅ Payroll already posts wages to GL split by cost centre → production labour **must not** duplicate a wages journal.

### 3.4 Machine & utility costing
- ✅ Machine master with `hourly_rate`; machine hours from `work_order_operations` actual/planned; OEE/utilisation reporting.
- ❌ **Electricity/utilities missing** — no kWh/power/utility-rate columns anywhere; only a `POWER` component *string* in Engine B's enum (`0083:377`).
- ⚠️ Consumables/packaging/QC: `is_consumable` flag exists but isn't separated in cost; packaging feeds per-unit economics only; no QC cost line.

### 3.5 Overhead allocation
- ⚠️ `allocation_rules` table + list/create CRUD exists (`finance-advanced.ts:1046-1068`) but **no engine applies the rules**; no source cost pools (rent/depreciation/utilities/maintenance/security/cleaning/admin) captured; no traceability transaction; no double-count prevention.
- ❌ `work_centres.overhead_rate` is applied as a **labour-cost multiplier**, not a per-hour absorb rate (`production.ts:802`).
- ✅ `captureProductionCost` tags components with `cost_centre_id` + `period_id`.

### 3.6 WIP & accounting integration
- ⚠️ `wip_ledger` (currency, by txn type) exists but has **no running-balance/valuation**; MES `wip_balances` is **quantity-only** (no value column).
- ❌ **The GL chain is a no-op**: `RAW_INV`, `FG_INV`, `WIP` all map to `10111400` (`finance.ts:23-25`); `postInventoryValueChange` returns null on that collision (`finance.ts:1041-1044`); the `PRODUCTION_COMPLETE`/`FG_WIP` posting rule is **deactivated** (`0226_hope_design_chart.sql:455-457`).
- ❌ No journal for: material→WIP, labour→clearing, overhead→clearing, completion→FG, abnormal loss→expense.

### 3.7 Approvals, audit, controls
- ✅ Generic 2-step workflow (`WF-WO`, `WF-BOM`, `WF-PPLAN`), SoD (owner cannot self-approve, sequential-step segregation, approver-cannot-execute), append-only audit.
- ❌ Material issue / reservation / **cost adjustment** / **overhead allocation** / production completion are **status-gated, not approval-gated**.
- ❌ A material change to an approved WO via the manufacturing services does **not** invalidate approval (only the generic `crudFactory` update path calls `invalidateStaleApproval`).

### 3.8 Frontend, dashboard, reports
- ✅ `/plant/costing` and `/finance/costing` both render; operator-simple floor UI (`OperatorHub`, `WasteRecorder`, `MaterialIssueFlow`) is already touch-optimized.
- ⚠️ Only 2 manufacturing reports (`production-yield`, `work-order-summary`) in the analytics engine; **zero** production-cost/BOM-cost/material-consumption/wastage/labour/machine/overhead/WIP/variance/profitability reports in `reportExport.ts`.

---

## 4. Critical defects & risks (ranked)

1. **WIP/FG GL reclassification is impossible today** (single inventory account + disabled rule). Until the chart of accounts separates WIP/FG (or the policy is deliberately "no GL reclassification"), "reflected accurately in the general ledger" cannot be satisfied. *Decision required (§7.1).*
2. **Two costing engines with opposite variance signs** → the `/plant/costing` and `/finance/costing` screens can disagree with each other about whether a variance is favourable.
3. **JS float arithmetic** for authoritative financial totals → rounding drift; violates prompt §3.
4. **Overhead `overhead_rate` misused** as a labour uplift, not an absorption rate; and `allocation_rules` has no apply-engine.
5. **Scrap/rework cost inconsistency** — scrap cost is overwritten at completion; rework cost never reaches `actual_cost`.
6. **No electricity/utility cost capture** despite the prompt naming it explicitly.
7. **Labour not linked to employees/cost centres** — cannot attribute production labour to a cost centre without the manual `captureProductionCost` path.

## 5. Pre-existing defects discovered (unrelated to this feature, worth a separate ticket)

- `journal_entries.journal_type` CHECK does **not** allow `ASSET_DISPOSAL`/`ASSET_IMPAIRMENT`/`ASSET_MAINTENANCE`, yet `assets.ts` posts those exact types (`assets.ts:1575/1688/2580`) → those postings would fail the DB constraint.
- Journal maker/approver SoD is **dead**: `journalCreator()` queries `financial_audit_logs` for `action='JOURNAL_DRAFT'`, but `createJournalDraft` logs `'JOURNAL_CREATED'` (`finance-advanced.ts:125,139`) → maker can approve own journal.
- `production_variances` table has schema + reads but **no populating code**.
- Two overlapping material-issue implementations (legacy `production.ts:445` vs MES `manufacturing.ts:654`) with different capabilities.
- `SOFT_CLOSE` period is enforced inconsistently across posting paths (`assertPeriodOpen` allows only `OPEN`; draft/intercompany allow `SOFT_CLOSE`).

---

## 6. Proposed implementation plan (incremental)

> Ordering is chosen to de-risk: consolidate the cost model first, wire the ledger second, then surface/automate.

**Phase 0 — Accounting policy (blocking decision, §7.1).** Decide WIP/FG chart-of-accounts treatment. Output: a short decision record.

**Phase 2 — Costing engine consolidation.**
- Single canonical costing routine (server-side, SQL NUMERIC math) used by both `/plant/costing` and `/finance/costing`; remove the manual `captureProductionCost` divergence or make it call the same engine.
- One variance sign convention (favour `actual − standard`, with explicit favourable/adverse flag); persist unit cost, good-unit cost, variance %, yield/efficiency.
- Roll rework + scrap cost into `actual_cost` consistently; add missing components (utilities, QC, packaging, consumables) to the cost model.

**Phase 3 — BOM / labour / machine / overhead integration.**
- BOM line CRUD + per-line standard material cost (reuse `bom_version_lines`).
- Operation/stage-level labour: link `work_order_labour` to `employees` (not `users`), add cost-centre to `work_orders`, optional attendance-derived hours; employee hourly rate.
- Machine costing: add electricity/utility capture (kWh × rate) to machine cost.
- Overhead allocation engine that applies `allocation_rules` drivers to MOs with source-cost pools + traceability + double-count prevention.

**Phase 4 — WIP & accounting.**
- Value-tracked WIP (add value to `wip_balances`/running balance in `wip_ledger`).
- Real journal postings (idempotent, audited, period-gated): material→WIP, labour→clearing, overhead→clearing, completion→FG, abnormal loss→expense — via the existing `post_journal` engine.

**Phase 5 — Frontend & dashboard.** Extend `/plant/costing` filters (date range, MO, product, department, status, costing status) and indicator set.

**Phase 6 — Reports, approvals, audit.** Add the 14 reports to `reportExport.ts`; add approval gating + re-approval invalidation to cost adjustments / overhead allocations / completion; enforce period restrictions.

**Phase 7 — Tests + deployment docs.** Full lifecycle test (order → issue → labour/machine/overhead → WIP → FG → GL) plus the acceptance-criteria unit tests in prompt §16; deployment/rollback notes.

---

## 7. Open decisions required

### 7.1 Chart of accounts for WIP / FG (blocks Phase 4)
- **(A)** Add separate `WIP` and `Finished Goods` GL accounts to the Hope Design chart, and (re-)activate a `PRODUCTION_COMPLETE` posting rule so completion posts `Dr FG / Cr WIP` and consumption posts `Dr WIP / Cr Raw`. → true double-entry WIP accounting.
- **(B)** Keep the single inventory account; track WIP/FG *value* only in the auxiliary `wip_ledger`/`production_costs` (no GL reclassification). → less ledger churn, but "accurate in the GL" is weaker.
- **(C)** Defer; I proceed with Phases 2/3 (cost model) and revisit before Phase 4.

### 7.2 Scope / sequencing
- Full phased build (2→7), or start with Phase 2 only, or fix the ranked critical defects first.

### 7.3 Variance convention
- Standardize on `actual − standard` (favourable = negative) or keep `standard − actual` (favourable = positive). Recommend `actual − standard` to match the finance cost sheet.
