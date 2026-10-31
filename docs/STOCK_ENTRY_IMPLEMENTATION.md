# Quick Stock Entry — Implementation Report

**Date:** 2026-10-31
**Scope:** "Easy Stock Recording & Inventory Operations" — make stock recording simple and fast for warehouse / production / stores staff while keeping controls and auditability.

## Bottom line

The inventory module was already ~90% built (command center, cycle counts, transfers, adjustments, scan-to-move, reservations, inbound/outbound/production desks). The one genuine gap — a unified **Quick Stock Entry** form that posts receive/issue/transfer in a few steps — is now implemented end-to-end: migration, service, API routes, frontend view, quick-action cards, and tests.

| Deliverable | Status |
|---|---|
| Migration (`0209_quick_stock_entry.sql`) | ✅ done |
| Service + routes (`stockEntries.ts`, `inventory.ts`) | ✅ done |
| Frontend (`QuickEntry.tsx` + routing + quick-action cards) | ✅ done |
| Automated tests (`stockEntries.test.ts`) | ✅ done (not run — DB down, see below) |
| Implementation report | ✅ this file |

## What is new

### Backend
- **`packages/db/migrations/0209_quick_stock_entry.sql`** — `stock_entries` + `stock_entry_lines` with RLS tenant isolation, `set_updated_at` + `audit_row` triggers, and a `UNIQUE(tenant_id, client_token)` idempotency guard.
- **`apps/api/src/services/stockEntries.ts`** — `saveEntry`, `submitEntry`, `postEntry`, `cancelEntry`, `getEntry`, `listEntries`. Posting routes each line through the existing `post_inventory_move()` engine, so balances, batches, FIFO/weighted-average cost and the stock ledger stay identical to every other movement. A receipt also writes `product_batches.expiry_date`.
- **`apps/api/src/routes/ops/inventory.ts`** — five endpoints (`POST/GET /entries`, `GET /entries/:id`, `POST /entries/:id/submit`, `POST /entries/:id/cancel`) reusing the existing `inventory.movements.create` / `.view` permissions — **no new permissions needed**.
- **Optimistic concurrency** — `expectedUpdatedAt` on a draft update; a save that carries a stale view of the draft returns `409 CONFLICT` rather than silently clobbering a newer copy.
- **Restricted-material gate** — posting refuses any line whose product is `type = 'SECURITY_ITEM'` or `security_classification IN ('RESTRICTED','CONFIDENTIAL','SECRET')`, directing it to the existing dual-control secure-materials workflow instead of Quick Entry.

### Frontend
- **`apps/web/src/views/QuickEntry.tsx`** — Receive / Issue / Transfer in one form: warehouse(s), reference, notes, multi-line item search (via the existing `EntityPicker`), quantity, batch/lot + bin per line, and — for receipts — unit cost + expiry. **Save draft** / **Post now**. Duplicate-submission guard: a stable `clientToken` UUID plus a disabled submit button while in flight.
- **`apps/web/src/offlineDrafts.ts`** — a localStorage queue for entries made while offline; each draft keeps its exact POST body (including the idempotent `clientToken`), so a replay after the network returns can never double-post.
- **Offline-aware submit** — a network failure on Post/Save stores the entry locally, shows a pending-drafts banner, and replays on the next `online` event; `expectedUpdatedAt` feeds the 409 conflict detection.
- **`apps/web/src/views/InventoryFlow.tsx`** — `/inventory/quick-entry[/receive|issue|transfer]` route + a "Quick Entry" tab.
- **`apps/web/src/views/InventoryIntel.tsx`** — four quick-action cards on the command center (Receive / Issue / Transfer / Stock count), permission-gated.

### Tests
- **`apps/api/tests/stockEntries.test.ts`** — receipt posts + on-hand increases + ledger movement recorded; idempotent re-submit; draft → cancel → cannot-post; warehouse/line validation; RBAC denial; stale-draft conflict (`409`); restricted-material rejection (`400`).

## What already existed (no new work needed)

- **Stock dashboard / command center** — KPIs, health, today's activity, alerts (`inventoryIntel.ts`).
- **Cycle counts / stock take** — schedule → blind entry → review → approve → post (`inventoryIntel.ts`).
- **Transfers & adjustments** — draft → submit → workflow approval → post/complete (`inventory.ts`).
- **Scan item** — `/qr/scan` (QR/barcode).
- **Stock movement history** — movements ledger, product trace, FIFO/FEFO, valuation, ageing, ABC/XYZ, risk, map, handling units.

## Acceptance criteria — status

| Requirement | Status |
|---|---|
| Unified receive/issue/transfer in a few steps | ✅ Quick Entry |
| Save draft, submit later | ✅ `POST /entries` (draft) + `/entries/:id/submit` |
| Idempotent duplicate submission | ✅ `client_token` unique per tenant |
| Posts through the standard inventory engine | ✅ `post_inventory_move()` |
| Item search / scan | ✅ search via `EntityPicker`; scan via existing `/qr/scan` |
| Permissions + audit trail | ✅ `inventory.movements.create`; `audit_row` + `logAudit` |
| Dashboard with quick actions | ✅ command center + 4 cards |
| Stock count | ✅ existing cycle-count workflow |
| Stock movement history | ✅ existing ledger |
| Manufacturing / security-printing integration | ⚠️ partial — existing raw-material & security-item catalogues; issue-to-work-order posts as `PRODUCTION_ISSUE` when a work order is attached |
| Restricted / security material blocked from Quick Entry | ✅ `type='SECURITY_ITEM'` / `security_classification` gate routes to the secure workflow |
| Mobile / offline experience | ✅ offline draft queue + auto-sync on reconnect + 409 conflict detection |
| Batch/lot/bin selection in the entry | ✅ batch/lot `EntityPicker` + bin dropdown per line (serial tracking stays in the existing trace module) |
| Configurable approval for high-value / restricted / transfer moves | ⚠️ transfers already approval-gated via `inventory_transfers`; Quick Entry posts immediately, consistent with scan-driven `/moves` |

## Deferred — needs a product decision

1. **Serial-number capture in Quick Entry.** Batch/lot and bin are selectable per line, but serialized items still move through the existing scan/trace module; adding per-serial line entry to Quick Entry is a scope question.
2. **Unit-of-measure.** Quantities are entered in base units; UOM conversion is not implemented.

## How to deploy

1. Apply the migration first: run the migrator so `0209_quick_stock_entry.sql` reaches production before the API restarts.
2. Deploy the API + web build via the usual manual `plink` / `zero-downtime-deploy.sh` path (GitHub Actions is billing-locked).

## Test status

`npm run typecheck` is green for **both** `apps/api` and `apps/web`. The new test file collects and runs, but the integration suite could not execute at write time: **Postgres was down** (`ECONNREFUSED 127.0.0.1:5432`). Once the DB is up and seeded, run:

```
cd apps/api && npx vitest run tests/stockEntries.test.ts
```

(Note: `db:seed` is still failing on `financial_periods_company_id_code_key` — see `docs/audit/AUDIT_2026-10-20.md`.)
