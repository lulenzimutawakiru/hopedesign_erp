# Natex Cloud Accounting Modernisation — File-by-File Implementation Backlog

**Repository:** `lulenzimutawakiru/hopedesign_erp`  
**Planning branch:** `planning/accounting-modernisation-backlog`  
**Base branch:** `main`  
**Status:** Planning baseline only — no production code, schema, data, or deployment changed.  
**Product identity:** Natex Cloud by HOPE DESIGN.

## 1. Objective and delivery rules

Modernise the existing accounting capability into a reliable, auditable, manufacturing-aware accounting system for a Uganda-based business. Preserve existing business behaviour unless a defect is demonstrated, preserve API compatibility, and do not rewrite the finance module.

### Non-negotiable safeguards

1. All implementation work remains on a feature branch created from `main`; do not commit directly to `main`.
2. Do not connect feature work to the production database or production secrets. Use disposable local/CI databases and a sanitised staging copy where available.
3. Do not run migrations against production. Every migration must be additive, reversible where practical, and tested both up and down against a disposable database.
4. Never delete, rewrite, or silently re-post historical journals, invoices, receipts, payments, tax records, or audit events.
5. Posted journals are immutable. Corrections use linked reversals and replacement entries.
6. Preserve existing API contracts. Add fields/endpoints compatibly; version only where a breaking change is unavoidable.
7. Every financial write must enforce tenant, company, branch, currency, period, permission, idempotency, and audit controls.
8. No feature is complete without database tests, service tests, API tests, UI tests, and documented operational behaviour.
9. Do not merge or deploy without an approved pull request, passing CI, migration review, accounting sign-off, and a tested rollback/recovery plan.
10. Never treat an ERP invoice as URA-fiscalised merely because its internal GL posting succeeded.

## 2. Existing files to treat as the baseline

These are the known finance files from the review. Re-read them on the feature branch before changing anything and compare them with `main`.

| Area | Existing file | Review focus |
|---|---|---|
| Finance API | `apps/api/src/routes/ops/finance.ts` | Routes, validation, permissions, response contracts |
| Core finance service | `apps/api/src/services/finance.ts` | Invoice posting, expenses, journals, reports, bank reconciliation |
| Advanced finance service | `apps/api/src/services/finance-advanced.ts` | Draft journals, cost/profit centres, advanced workflows |
| Chart of accounts | `packages/db/migrations/0226_hope_design_chart.sql` | Existing chart and account mappings |
| Tax compliance | `packages/db/migrations/0223_tax_compliance.sql` | Tax codes, VAT/compliance structures |
| Frontend | Existing finance/accounting SPA modules | Locate actual route, page, component, API client and type files before editing; do not invent parallel screens |

The review identified specific items to validate with regression tests before fixing: trial-balance opening balances for date-filtered reports; common GL mapping for raw inventory, WIP and finished goods; fallback behaviour when configured posting rules are invalid; bank expense posting that may select a default bank account based on payment method; account ownership/uniqueness validation; editable opening balances after account activity; and multi-currency journal draft defaults.

## 3. Proposed delivery sequence

Migration numbers below are **provisional**. The implementation owner must inspect the highest migration on the feature branch and allocate the next unused sequential numbers. Never overwrite or renumber an existing migration.

| Phase | Scope | Priority | Exit condition |
|---|---|---:|---|
| 0 | Baseline, accounting invariants, regression suite | P0 | Current behaviour and data assumptions documented |
| 1 | GL integrity, chart governance, journal controls, financial reports | P0 | Balanced immutable ledger and correct TB/P&L/BS |
| 2 | AR/AP subledgers and bank reconciliation | P1 | Control accounts reconcile to source subledgers |
| 3 | Manufacturing inventory accounting and costing | P1 | Raw materials, WIP, FG and COGS reconcile |
| 4 | Uganda tax controls and EFRIS reconciliation | P1 | Tax ledgers and fiscalisation states reconcile |
| 5 | FX, fixed assets, accruals and cash flow | P2 | Period-end accounting schedules reconcile |
| 6 | Dashboards, forecasting and management reporting | P2 | Drillable, permission-aware management reports |

---

## 4. Detailed backlog

### NC-ACC-000 — Baseline and regression protection

**Priority:** P0  
**Dependencies:** None

**Files**
- Inspect `apps/api/src/routes/ops/finance.ts`
- Inspect `apps/api/src/services/finance.ts`
- Inspect `apps/api/src/services/finance-advanced.ts`
- Inspect `packages/db/migrations/` and identify the actual latest migration.
- Locate existing API tests, database tests, frontend finance pages, API clients, shared types, permissions and CI workflows.

**Tasks**
- Record the current route list, request/response shapes, permission checks and service call graph.
- Map every source transaction to its current journal posting path.
- Record the current chart of accounts and all inventory, tax, bank, receivable and payable control-account mappings.
- Create a baseline test fixture for one company with UGX accounts, customers, suppliers, stock, invoices, expenses, payments and journals.
- Capture baseline report outputs for a known dataset.

**Acceptance tests**
- Existing finance API contract tests pass unchanged.
- A seeded dataset produces deterministic journal, trial balance, P&L and balance-sheet outputs.
- CI uses a disposable database and cannot access production credentials.
- A migration inventory report identifies the latest migration and confirms no migration file will be overwritten.

### NC-ACC-010 — Ledger integrity and chart-of-accounts governance

**Priority:** P0  
**Dependencies:** NC-ACC-000

**Proposed migration:** `packages/db/migrations/0227_accounting_ledger_integrity.sql` (allocate next unused number)

**Database tasks**
- Add or enforce tenant/company-scoped unique account-code constraints after checking and resolving existing duplicates through a reviewed data-cleanup script.
- Add indexes for journal lookup by tenant, company, status, posting date, source type and source ID.
- Add explicit journal-line currency, functional-currency amount, exchange-rate snapshot and source-reference fields only where equivalent fields do not already exist.
- Add a posting-rule version/reference snapshot to journal headers or lines where the existing schema supports it.
- Add constraints preventing a journal from being posted unless total debits equal total credits in functional currency, using the existing transaction/posting architecture.
- Enforce valid account parent relationships within the same tenant and company.
- Prevent posting directly to parent/header accounts.
- Add account status/deactivation controls without deleting historical references.

**API/service files**
- `apps/api/src/services/finance.ts`: harden account create/update and journal validation.
- `apps/api/src/routes/ops/finance.ts`: validate tenant/company context and reject invalid account operations.
- Add or update shared accounting schemas/types in the existing validation/type locations.

**Frontend tasks**
- Chart-of-accounts page: show account code, name, type, parent, posting eligibility, status and control-account designation.
- Warn and block attempts to deactivate accounts with active balances or dependencies.
- Prevent editing opening balances after posted activity; provide a controlled opening-balance adjustment journal workflow.
- Show why an account cannot be changed, deactivated or used for posting.

**Acceptance tests**
- Duplicate account codes are rejected within the same tenant/company but do not collide across legitimately separate tenants/companies.
- A parent account cannot receive journal lines.
- A child account cannot be assigned a parent belonging to another tenant/company.
- Account type, code and opening balance cannot be silently changed after posted activity.
- Deactivated accounts remain visible in historical reports but cannot receive new postings.
- Cross-tenant and cross-company requests return an authorization error and create no records.

### NC-ACC-020 — Journal lifecycle, posting engine and posting rules

**Priority:** P0  
**Dependencies:** NC-ACC-010

**Proposed migration:** `packages/db/migrations/0228_accounting_posting_controls.sql`

**Database tasks**
- Add journal lifecycle metadata if missing: draft, pending approval, approved, posted, rejected, reversed.
- Add immutable posted-state enforcement through service-level guards and database safeguards appropriate to the current schema.
- Add idempotency keys for source-driven postings, scoped to tenant/company/source.
- Add reversal linkage: original journal ID, reversal journal ID, reversal reason, actor and timestamp.
- Persist posting-rule ID and version used for each generated journal.
- Add approval records with approver, decision, reason, timestamp and the version/hash of the transaction approved.

**API/service files**
- `apps/api/src/services/finance.ts`: centralise debit/credit validation, idempotency, posting and reversal.
- `apps/api/src/services/finance-advanced.ts`: route draft and advanced journal workflows through the same posting engine.
- `apps/api/src/routes/ops/finance.ts`: expose draft, submit, approve, reject, post and reverse operations with explicit permissions.
- Separate “no posting rule configured” from “configured rule invalid/disabled”. A configured but invalid rule must fail closed; fallback is allowed only for explicitly approved legacy cases and must be logged.
- Add a posting preview that returns proposed lines without committing them.

**Frontend tasks**
- Journal workbench with draft, submit, approve, post and reverse states.
- Show debit/credit totals, difference, source transaction, posting-rule trace and validation errors.
- Require a reason for rejection, reversal and approved override.
- Prevent self-approval for controlled transactions.
- Show a before-posting preview and a read-only posted journal detail.

**Acceptance tests**
- A journal with unequal debits and credits cannot be posted.
- Repeating the same source posting request with the same idempotency key creates exactly one journal.
- Reusing a key with a different payload is rejected.
- Posted journal lines cannot be edited or deleted through API or UI.
- Reversal creates an equal and opposite journal linked to the original; original remains unchanged.
- Invalid configured posting rule fails closed and produces a visible actionable error.
- A user cannot approve their own controlled transaction.
- Approval is invalidated if material transaction fields change after approval.

### NC-ACC-030 — Trial balance, P&L and balance sheet correctness

**Priority:** P0  
**Dependencies:** NC-ACC-010, NC-ACC-020

**Proposed migration:** None expected unless report snapshots or close metadata are absent; prefer query/service corrections first.

**Service files**
- `apps/api/src/services/finance.ts`: correct `trialBalance()`, `profitAndLoss()` and `balanceSheet()`.
- Add a shared reporting-period/date-boundary helper rather than duplicating date logic.
- Add a retained-earnings/year-end close workflow only after current accounting policy and existing close functionality are confirmed.

**Required calculation rules**
- Trial-balance opening balance = account opening balance plus all posted movements before the report start date.
- Period debit/credit = posted movements inside the selected inclusive/exclusive date boundary, consistently defined.
- Closing balance = opening balance plus period movement, respecting account normal balance and contra-account presentation.
- P&L includes only selected-period revenue and expense activity.
- Balance sheet is an as-of-date report and includes cumulative balances through that date, with current-period earnings treated consistently with year-end close policy.
- Exclude drafts, rejected journals and unposted source transactions.
- Support company, branch, currency, account range and dimension filters only where permissions and existing data support them.

**Frontend tasks**
- Report filters for date range/as-of date, company, branch, account range and currency where supported.
- Drill-down from account balance to journal lines and source transactions.
- Display report basis, generated timestamp, filters and whether the period is closed.
- Export CSV/XLSX/PDF using the existing export infrastructure.

**Acceptance tests**
- A transaction posted before the report start date affects opening balance but not period debit/credit.
- A transaction on the start and end dates is included according to the documented boundary convention.
- Trial-balance debits equal credits for every valid posted ledger dataset.
- P&L for a month excludes prior-period revenue and expenses.
- Balance sheet as at a date includes all eligible prior postings and balances.
- Reversed journals net to zero without deleting original history.
- Reports do not leak other tenants, companies or unauthorised branches.

### NC-ACC-040 — Manufacturing chart of accounts and inventory accounting

**Priority:** P1  
**Dependencies:** NC-ACC-010, NC-ACC-020

**Proposed migration:** `packages/db/migrations/0229_manufacturing_inventory_accounts.sql`

**Database tasks**
- Introduce distinct control accounts for raw materials, packaging materials, work in progress, finished goods, consumables and inventory adjustments/provisions, subject to review of the existing chart.
- Separate inventory valuation accounts from expense/COGS accounts.
- Add explicit inventory-to-GL mapping by item category, stock location and transaction type, with effective dates and approval controls.
- Preserve historical mappings and journal lines; do not mass-reclassify historical entries without a signed reconciliation and approved adjustment plan.
- Add production cost components: material, direct labour and allocated overhead.
- Support cost method configuration per company/item class: weighted average initially; standard costing only after variance treatment is designed and tested.

**Service/API files**
- Inspect the inventory, manufacturing and finance posting services before adding new modules.
- Add a dedicated inventory accounting mapper/service in the existing service architecture.
- Expose mapping configuration and valuation reconciliation endpoints through the existing API routing conventions.
- Ensure goods receipt, issue to production, WIP transfer, production completion, wastage/scrap, stock adjustment and sale each create the correct accounting event exactly once.

**Frontend tasks**
- Inventory accounting mapping setup with validation and effective dates.
- Production cost sheet showing material, labour, overhead, wastage and variance.
- Stock valuation report by item, category, location and valuation date.
- Inventory-to-GL reconciliation page with drill-down to stock movements and journals.

**Acceptance tests**
- Raw material receipt debits raw-material inventory and credits the configured GRNI/AP clearing or payable account according to the existing procurement flow.
- Issue to production transfers value from raw materials to WIP.
- Production completion transfers WIP to finished goods.
- Sale recognises COGS and relieves finished-goods inventory using the approved valuation method.
- Scrap, wastage and stock adjustments post to distinct approved accounts with reasons and approvals.
- Inventory valuation total reconciles to the relevant GL control accounts.
- Replaying an inventory event does not duplicate journal postings.
- Existing stock quantities and historic valuation records remain unchanged by the migration.

### NC-ACC-050 — Accounts receivable and customer collections

**Priority:** P1  
**Dependencies:** NC-ACC-020, NC-ACC-030

**Proposed migration:** `packages/db/migrations/0230_accounts_receivable_controls.sql`

**Database tasks**
- Verify customer invoice, receipt, allocation, credit-note and deposit tables before adding structures.
- Add allocation records supporting partial payments, multiple invoices per receipt and unapplied customer credits.
- Add invoice due date, payment terms, credit limit and collection status where absent.
- Add customer statement and ageing query indexes.
- Add duplicate source-document/reference controls scoped to tenant/company/customer.

**API/service files**
- `apps/api/src/services/finance.ts`: make invoice posting and receipt allocation atomic and idempotent.
- Add AR ageing, customer statement, credit-limit validation and receipt-allocation endpoints.
- Ensure credit notes and write-offs use approval and reversal-safe journal flows.

**Frontend tasks**
- Customer account page with invoices, receipts, allocations, credits, outstanding balance and statement.
- AR ageing buckets (current, 1–30, 31–60, 61–90, over 90 days; configurable).
- Receipt allocation screen with unapplied amount clearly shown.
- Credit-limit warning and collection follow-up queue.

**Acceptance tests**
- Partial receipt reduces the correct invoice balance without closing unrelated invoices.
- Over-allocation is rejected.
- Unapplied receipt remains visible as customer credit.
- Credit note reduces receivable and tax/revenue accounts correctly.
- Customer statement agrees with AR subledger and GL control account.
- Duplicate customer invoice source reference is rejected or explicitly handled by approved policy.

### NC-ACC-060 — Accounts payable and supplier controls

**Priority:** P1  
**Dependencies:** NC-ACC-020, NC-ACC-030

**Proposed migration:** `packages/db/migrations/0231_accounts_payable_controls.sql`

**Database tasks**
- Verify existing purchase order, goods received note, supplier invoice and supplier payment structures.
- Add three-way-match status and exception reason where missing.
- Add supplier invoice duplicate detection using supplier, invoice number, date, currency and amount, with override audit.
- Support partial supplier payments and allocation across invoices.
- Add withholding-tax metadata and tax-period references where appropriate to Uganda rules and approved policy.

**API/service files**
- Add AP ageing, supplier statements, invoice matching, payment proposal and payment allocation services.
- Prevent supplier payment posting without required approval and bank/cash account selection.
- Preserve payment method and selected bank account as separate data; never infer the bank GL account solely from a generic “BANK” method if a specific bank account was selected.

**Frontend tasks**
- Supplier ledger and statement.
- PO–GRN–supplier invoice match view with quantity/price variance.
- Payment batch preparation and approval workflow.
- Duplicate invoice warnings and documented override reasons.
- AP ageing and due-payment dashboard.

**Acceptance tests**
- Invoice matching identifies missing PO/GRN and quantity/price variances.
- Duplicate supplier invoice is flagged and cannot be posted without authorised override.
- Partial payment allocates correctly.
- Payment uses the selected bank/cash GL account and reconciles to the bank ledger.
- Supplier statement reconciles to AP control account.
- WHT is calculated and posted only according to configured effective tax rules.

### NC-ACC-070 — Bank reconciliation and treasury controls

**Priority:** P1  
**Dependencies:** NC-ACC-020, NC-ACC-050, NC-ACC-060

**Proposed migration:** `packages/db/migrations/0232_bank_reconciliation_controls.sql`

**Database tasks**
- Add statement-import batch and source-file hash to prevent duplicate imports.
- Add normalised statement-line fingerprint and duplicate detection.
- Add match suggestion confidence, match method, reviewer and approval metadata.
- Preserve original statement values and import source.
- Add reconciliation lock/snapshot metadata once a statement is finalised.

**Service/API files**
- `apps/api/src/services/finance.ts`: harden automatic and manual matching.
- Add CSV/XLSX import adapters using the project's existing file-processing conventions.
- Match using reference, amount, date window, counterparty and configurable tolerances.
- Do not auto-confirm ambiguous matches; show suggestions for human approval.
- Add controlled bank charges, interest and correction journals.

**Frontend tasks**
- Statement upload, column mapping and import preview.
- Reconciliation workspace with matched, suggested, unmatched and excluded states.
- Explain match score/reason and allow reviewer approval.
- Finalise/lock reconciliation with variance report and audit evidence.

**Acceptance tests**
- Importing the same statement twice does not duplicate statement lines.
- Ambiguous equal-score matches remain suggestions and are not auto-confirmed.
- Match cannot cross tenant/company/bank account.
- Reconciliation difference is zero before finalisation unless an approved exception exists.
- Finalised reconciliation cannot be silently edited; reopening requires permission and reason.
- Bank statement balance reconciles to bank GL and outstanding reconciling items.

### NC-ACC-080 — Uganda tax engine and EFRIS reconciliation

**Priority:** P1  
**Dependencies:** NC-ACC-020, NC-ACC-030, NC-ACC-050, NC-ACC-060

**Proposed migration:** `packages/db/migrations/0233_uganda_tax_controls.sql`

**Database tasks**
- Review and extend `packages/db/migrations/0223_tax_compliance.sql`; do not duplicate existing tax tables.
- Store tax type, rate, effective-from/to dates, tax-inclusive/exclusive treatment, recoverability, tax account mappings and return-box mapping.
- Support tax transaction snapshots so historical transactions retain the rate/rule used at posting.
- Record tax adjustments, withholding certificates, filing periods, payment references and filing evidence.
- Store EFRIS request/response identifiers, fiscalisation state, device/branch identity, retry state and reconciliation timestamps without storing secrets in plain text.

**Service/API files**
- Keep the tax calculation engine separate from EFRIS transport and retry logic.
- Validate tax calculations at invoice/credit-note posting.
- Add tax summary, VAT return workpaper, WHT report and tax reconciliation endpoints.
- Add EFRIS reconciliation between ERP invoices/credit notes and URA fiscalisation outcomes.
- Distinguish ERP-posted, queued, submitted, accepted/fiscalised, rejected, cancelled and retryable states.
- Never report a transaction as fiscalised without an explicit successful URA response.

**Frontend tasks**
- Tax code configuration with effective dates and account mapping.
- Tax transaction register and return workpaper.
- EFRIS status/reconciliation queue with request reference, URA response, retry history and actionable errors.
- Filing evidence and payment reference capture.

**Acceptance tests**
- Tax rate changes do not alter already-posted historical invoice tax.
- VAT output/input totals reconcile to tax GL accounts and eligible source documents.
- Credit notes and cancellations follow the approved URA workflow and preserve original audit history.
- EFRIS rejection does not mark an invoice fiscalised.
- Retry is idempotent and does not create duplicate fiscal documents.
- Tax reports can be traced to source transactions and GL journals.
- Tax rules are configurable by effective date and must be reviewed against current URA guidance before production use.

### NC-ACC-090 — Foreign currency and exchange differences

**Priority:** P2  
**Dependencies:** NC-ACC-020, NC-ACC-030, NC-ACC-050, NC-ACC-060

**Proposed migration:** `packages/db/migrations/0234_accounting_multi_currency.sql`

**Database tasks**
- Define company functional currency (UGX by default only where confirmed by company configuration).
- Store transaction currency, functional currency, rate, rate source, rate date and original/functional amounts.
- Add exchange-rate history and approval controls.
- Add realised/unrealised FX gain/loss account mapping.

**Service/API files**
- Remove hard-coded assumptions in journal draft flows where the current company or transaction currency should determine the currency/rate.
- Calculate realised FX on settlement and unrealised FX on approved period-end revaluation.
- Preserve the original rate used on posted transactions.

**Frontend tasks**
- Currency and exchange-rate setup.
- Rate selection with source/date and approval.
- Multi-currency supplier/customer balances and FX revaluation preview.

**Acceptance tests**
- A foreign-currency transaction stores both original and functional amounts.
- Revaluation does not overwrite original transaction values.
- Settlement calculates realised FX using the approved rate snapshots.
- Revaluation journal is balanced, repeatable and reversible.
- Reports clearly state presentation currency and conversion basis.

### NC-ACC-100 — Fixed assets, depreciation and period-end schedules

**Priority:** P2  
**Dependencies:** NC-ACC-020, NC-ACC-030

**Proposed migration:** `packages/db/migrations/0235_fixed_assets_and_period_close.sql`

**Database tasks**
- Add fixed asset register, categories, acquisition cost, useful life, residual value, depreciation method, location, custodian and disposal/impairment status if not already available.
- Add depreciation schedule and posted-run references.
- Add period-close checklist and close/reopen audit events.
- Add accrual and prepayment schedules with source, period allocation and reversal rules.

**Service/API files**
- Fixed-asset acquisition, depreciation, impairment and disposal posting services.
- Accrual/prepayment schedule generation with idempotent monthly journals.
- Period-close validation for unposted batches, unreconciled control accounts, incomplete bank reconciliations and outstanding approvals.

**Frontend tasks**
- Asset register, asset card and depreciation schedule.
- Monthly depreciation preview and approval.
- Accrual/prepayment schedules.
- Period-close dashboard with blockers and authorised reopen workflow.

**Acceptance tests**
- Depreciation schedule matches configured method, useful life and residual value.
- Re-running a depreciation period does not duplicate journals.
- Disposal removes cost and accumulated depreciation and recognises gain/loss correctly.
- Closed period rejects backdated posting unless an authorised reopen is recorded.
- Accruals/prepayments reverse or amortise according to approved schedule.

### NC-ACC-110 — Cash flow, management reports and dashboards

**Priority:** P2  
**Dependencies:** NC-ACC-030, NC-ACC-050, NC-ACC-060, NC-ACC-070

**Database/service tasks**
- Add cash-flow statement using documented direct or indirect method.
- Add cost-centre and profit-centre reporting with validated allocation rules.
- Add budget-versus-actual, working-capital, gross-margin and operating-margin reporting.
- Add report export audit metadata where required.

**Frontend tasks**
- Finance dashboard: cash/bank, receivables, payables, overdue balances, revenue, gross profit, operating expenses, net result, tax liabilities, inventory value and budget variance.
- Every KPI drills down to a filtered report and then to source transactions.
- Respect company, branch, role and financial-data permissions.

**Acceptance tests**
- Dashboard totals reconcile to underlying reports and ledgers.
- Filters are consistently applied to all cards and drill-downs.
- A user without access to a branch cannot infer its financial totals through dashboard aggregates.
- Exported report totals match the on-screen report for the same filters.

---

## 5. Cross-cutting API and frontend requirements

### API
- Use existing route conventions and validation library; do not create a second finance API.
- Enforce authentication, permission checks, tenant/company/branch scope and input validation at the route boundary and again where required by service-level trust boundaries.
- Use database transactions for source document + journal + subledger state transitions.
- Use idempotency for all retryable integrations and source-event postings.
- Return stable error codes for validation, approval, closed-period, duplicate and reconciliation failures.
- Add pagination, date filters and bounded exports to prevent unbounded ledger queries.
- Never expose credentials, private keys, EFRIS secrets or bank integration secrets in responses/logs.

### Frontend
- Reuse the existing SPA router, navigation, design system and API client.
- Add permission-aware navigation and action controls, but enforce security on the server too.
- Use explicit loading, empty, error, pending approval, rejected and posted states.
- Show audit history and source-document links on financial records.
- Avoid optimistic UI for irreversible posting actions; confirm only after server success.
- Keep all existing finance routes and workflows operational during rollout.

## 6. Required test matrix

| Layer | Required coverage |
|---|---|
| Migration | Fresh install, upgrade from current schema, rollback on disposable DB, existing-data preservation |
| Database | Constraints, indexes, tenant/company isolation, FK integrity, uniqueness |
| Unit | Calculations, rounding, tax rules, FX, posting-rule resolution, ageing |
| Service integration | Atomic posting, idempotency, reversal, period lock, reconciliation |
| API | Authentication, permissions, validation, compatibility, pagination, error contracts |
| Frontend | Forms, workflow states, permission gating, drill-down, failed requests |
| Accounting | Balanced journals, TB equality, subledger-to-GL reconciliation, inventory-to-GL reconciliation |
| Security | Cross-tenant access, privilege escalation, audit integrity, secret redaction |
| Regression | Existing invoices, expenses, payments, journals, bank reconciliation, EFRIS and reports |
| Operations | Backup/restore rehearsal, migration timing, monitoring, rollback and release notes |

## 7. Definition of done for every backlog item

- [ ] Existing implementation and callers inspected before modification.
- [ ] Data model and migration reviewed; migration number verified against current branch head.
- [ ] Migration tested on fresh and upgraded disposable databases.
- [ ] Backfill/cleanup scripts are dry-run capable, logged and reviewed.
- [ ] API validation, permissions and compatibility tests pass.
- [ ] Service tests prove accounting entries and idempotency.
- [ ] Frontend tests prove permissions and workflow states.
- [ ] Audit events are present for approvals, postings, reversals and overrides.
- [ ] Financial reports and subledger reconciliations pass.
- [ ] CI passes; no production secrets or production DB connections used.
- [ ] Reviewer approves code, schema and accounting treatment.
- [ ] Release notes and rollback/recovery steps are documented.

## 8. Branch and release workflow

1. Keep `planning/accounting-modernisation-backlog` as the planning record.
2. Create implementation branches from the current approved `main` (or a dedicated integration branch only after agreement), for example:
   - `feature/accounting-gl-integrity`
   - `feature/accounting-reporting-corrections`
   - `feature/accounting-ar-ap`
   - `feature/accounting-manufacturing-costing`
   - `feature/accounting-uganda-tax-efris`
3. Deliver one coherent vertical slice per PR: migration + service + API + UI + tests + docs.
4. Keep each PR small enough for review. Avoid combining ledger integrity, tax and manufacturing costing in one large merge.
5. Use feature flags/configuration for new workflows where existing production users need a gradual transition.
6. Deploy first to isolated staging with a sanitised database and production-like configuration.
7. Reconcile opening balances, AR/AP, inventory valuation, bank accounts and tax balances before enabling new posting paths.
8. Require explicit business/accounting approval before enabling a new posting rule in production.
9. Merge only after the PR is approved and all checks pass. Production deployment is a separate, explicitly authorised activity.

## 9. First implementation sprint

Start with **NC-ACC-000, NC-ACC-010, NC-ACC-020 and NC-ACC-030**. Do not begin manufacturing costing or tax-engine expansion until the general ledger, journal lifecycle and financial statements are proven correct.

**Sprint deliverables**
- Baseline architecture and route inventory.
- Regression fixtures for invoices, expenses, receipts, payments and journals.
- Chart-of-accounts integrity migration (after migration-head verification).
- Central posting validation/idempotency/reversal design.
- Correct trial-balance opening/period/closing calculation.
- P&L and balance-sheet test suite.
- Draft PR with no production deployment.

**Release gate:** no phase is enabled in production until trial balance balances, P&L and balance sheet reconcile to the ledger, and AR/AP/inventory/bank control accounts reconcile to their respective subledgers.
