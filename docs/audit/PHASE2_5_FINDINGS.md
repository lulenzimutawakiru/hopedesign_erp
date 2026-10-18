# Phase 2–5 Findings — HOPE DESIGN Enterprise ERP

Date: 2026-10-18 · Branch `main` (`5639810`)

Deep-dive results from the five read-only audit agents (accounting, EFRIS,
manufacturing/QR, procurement/payroll/Hikvision, inventory/RLS) plus fixes
applied in this pass. Findings are **Confirmed** (verified in code with
`file:line` evidence), **Potential** (plausible but needs runtime/DB
confirmation), or **Handled** (already enforced by an existing control).

---

## Phase 2 — DB & transaction integrity

### INV-001 — Negative stock is prevented at the database layer (positive)
**Status:** Handled — no change needed.
- `packages/db/migrations/0005_inventory.sql:250-256` weighted-average issue
  `UPDATE inventory SET quantity = quantity - p_quantity ... WHERE quantity - p_quantity >= 0`
  with `IF NOT FOUND RAISE`; FIFO guard at `:290-296`; batch guard at `:229-233`.
  Concurrent issues serialize on the row lock and the loser raises, so
  over-issue is impossible regardless of app code.

### INV-002 — Reservations are guarded (positive)
**Status:** Handled — no change needed.
- `reserve_stock` takes `SELECT ... FOR UPDATE` before incrementing
  `reserved_qty` (`0005_inventory.sql:321-325`). Header `FOR UPDATE` locks protect
  adjustments, transfers, stock counts, WO material lines, sales dispatch, and
  landed costs.

### INV-003 — Reservation consume/release is not idempotent (Potential, Medium)
**Status:** Documented; fix deferred pending DB-backed verification.
- `consume()` (`apps/api/src/services/inventory.ts:100-110`) and
  `release_reservation` (`0005_inventory.sql:339-348`) decrement `reserved_qty`
  with no `FOR UPDATE` and no guard that the reservation is still ACTIVE in the
  same statement. A double-consume decrements `reserved_qty` twice. Currently
  only safe because callers hold the SO/WO header lock.
- Recommended: make `consume`/`release_reservation` conditional on the
  reservation still being ACTIVE (single guarded UPDATE), or add `FOR UPDATE`.

### INV-004 — Low-severity concurrency gaps (Potential, Low)
**Status:** Documented.
- FIFO layer loop reads `inventory_layers.remaining_qty` without `FOR UPDATE`
  (`0005_inventory.sql:272-286`); two concurrent FIFO issues can push one layer
  negative while the aggregate `inventory` guard keeps total on-hand correct.
- `createGoodsReceipt` reads the PO header without `FOR UPDATE`
  (`procurement.ts:1011-1014`) and has no `received_qty + x <= quantity` guard
  — over-receipt past ordered qty is possible.
- `createAdjustment` captures `expected_qty` via unlocked SELECT
  (`inventory.ts:151-160`).
- `issueMaterialMes` increments `work_order_materials.issued_qty` with no
  `required_qty` upper bound (`manufacturing.ts:768-771`), unlike
  `production.ts:463-465`.

### RLS-001 — Comprehensive tenant isolation (positive)
**Status:** Handled — no change needed.
- `0127_rls_force_close_gaps.sql:42-61` dynamically enables RLS + FORCE +
  `tenant_id = app_tenant_id()` on every public table with a `tenant_id` column,
  retroactively closing 0088/0030/0058/0060/0107-0109. Post-0127 migrations list
  RLS coverage explicitly. App role `hopedesign_app` is non-superuser,
  non-BYPASSRLS, with per-transaction `set_app_context`.
- Documented RLS-off global catalogs: `tenants, currencies, exchange_rates,
  permissions, login_attempts, schema_migrations` with PUBLIC privileges revoked.

### RLS-002 — RLS binds only for the app role (Potential, Low)
**Status:** Documented.
- `0127:15-20` notes the migration superuser `hopedesign` is always RLS-exempt;
  a deployment running the API as owner/superuser bypasses RLS (config
  validation mitigates). Missing evidence: no live DB to confirm zero tables
  have RLS enabled without a policy.

---

## Phase 3 — Finance & EFRIS

### FIN-001 — Three-way match is advisory, not enforced (High)
**Status:** Fixed.
- Evidence: `createSupplierInvoice` computed `allMatch` into
  `supplier_invoices.three_way_matched` (`procurement.ts:1301-1346`) but
  `finance.postSupplierInvoice` never checked it, so an unmatched invoice still
  posted to the GL.
- Fix: `postSupplierInvoice` now blocks posting when
  `si.three_way_matched !== true` **unless** the company disabled the control in
  Procurement Settings (`organisation.procurement.three_way_match_required`,
  default `true`). This is deny-by-default with a sanctioned, audited off-switch.
- Regression test: `procurement.test.ts` "blocks posting a supplier invoice that
  fails three-way match".

### FIN-002 — A CLOSED accounting period could be re-opened (Medium)
**Status:** Fixed.
- Evidence: `finance.setPeriodStatus` allowed any transition, including
  `CLOSED → OPEN`, silently.
- Fix: a `CLOSED` period is now terminal — `setPeriodStatus` rejects re-opening
  it (`badRequest`). `OPEN ↔ LOCKED` stays reversible for legitimate adjustments
  and every transition remains audited.

### FIN-003 — Posted journal immutability is not enforced at the DB layer (Potential, Medium)
**Status:** Documented; fix deferred pending DB-backed verification.
- `journal_lines` and `journal_entries` have no trigger preventing direct
  UPDATE/DELETE of posted entries. Bank reconciliation legitimately updates
  `journal_lines.reconciled`/`bank_transaction_id`
  (`finance.ts:2152,2280`), so any immutability trigger must be scoped to the
  accounting fields (`account_id`, `debit`, `credit`) and to DELETE, leaving the
  reconciliation columns and the controlled `voidJournal` status transition
  intact.
- Recommended: a narrow `BEFORE UPDATE/DELETE` trigger on `journal_lines` (and a
  `BEFORE DELETE` on `journal_entries` for `status='POSTED'`) that raises when
  accounting fields are mutated or a posted entry is deleted.

### EFRIS-001 — Reconciliation query never matched (High)
**Status:** Fixed.
- Evidence: `efris/directory.ts:1309` filtered `doc_ref_type IN
  ('CUSTOMER_INVOICE','SALES_INVOICE')`, but stored values are lowercase plural
  table names (`customer_invoices`/`credit_notes`/`debit_notes`), so the match
  always returned zero.
- Fix: `AND t.doc_ref_type = 'customer_invoices'`.

### EFRIS-002 — Idempotency chain is present (positive)
**Status:** Handled — documented, no code change.
- `registerEfrisDocument` is idempotent on `idempotency_key`
  (`finance-advanced.ts:552-556`); `request_ref` is the stable ERP document code
  (`finance.ts:354`) and is reused on retry (`processor.ts:329`);
  `efris_documents` upserts on `efris_transaction_id` (`processor.ts:372`). The
  ERP→queue boundary cannot double-register a fiscal document.

### EFRIS-003 — Double-fiscalisation on timeout (Potential, Low)
**Status:** Documented (mitigated).
- A URA timeout after a successful fiscalisation is retried with the same
  `request_ref`/payload, relying on URA-side idempotency. The ERP side is
  correct; the residual risk is URA-side and cannot be fixed here without
  inventing URA fields/behaviour (which this audit must not do). A manual
  reconciliation desk reports the unknown-outcome state.

---

## Phase 4 — Manufacturing / inventory / QR traceability

### QR-001 — QR secret persisted in plaintext in the scan log (High)
**Status:** Fixed.
- Evidence: `verify_qr_public` stored `left(p_payload, 255)` (the full
  `code|secret`) into `qr_scans.payload` (`0063_public_verify_company.sql:21,28,54`),
  contradicting the design that only the SHA-256 hash is stored
  (`0008_qr_system.sql:10`).
- Fix: migration `0194_qr_scrub_secret.sql` replaces `verify_qr_public` to
  record only the non-secret `code` (with `SET search_path` preserved) and
  scrubs the secret out of historical public-verify rows
  (`scan_type='PUBLIC' AND action='VERIFY' AND payload LIKE '%|%'`). The secret
  hash in `qr_codes.secret_hash` is untouched.
- Regression test: `qr.test.ts` "does not persist the QR secret in the public
  scan log".

### QR-002 — QR-level recall was dead code (Medium)
**Status:** Fixed.
- Evidence: `recalls.qr_id` exists (`0008_qr_system.sql:42`) and
  `verify_qr_public` checks it for the `RECALLED` result, but `createRecall`
  never wrote `qr_id` and accepted no `qrId` input
  (`inventoryIntel.ts:1348-1353`).
- Fix: `createRecall` now accepts an optional `qrId`, resolves the QR, derives
  `product_id`/`batch_id` from it when not supplied, and writes `recalls.qr_id`.
- Regression test: `qr.test.ts` "links a recall to its QR so public verification
  reports RECALLED".

---

## Phase 5 — Procurement / HR / payroll / attendance

### PROC-001 — Purchaser could approve their own PO (High)
**Status:** Fixed.
- Evidence: `approvePurchaseOrder` had no segregation-of-duties check.
- Fix: if `po.created_by == ctx.userId`, approve now throws
  `forbidden('Segregation of duties: you cannot approve your own purchase order')`
  (`procurement.ts`).

### PAY-001 — FY2026/27 PAYE bands reproducible (positive)
**Status:** Handled — already resolved before this pass.
- Migration `0188_statutory_paye_2026.sql` installs the FY2026/27 bands and the
  Jul-Oct LST window; `seed-data.js` carries the matching bands
  (`UG-PAYE-2026`, lines 337-353). No further change required.
