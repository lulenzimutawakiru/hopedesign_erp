# Manufacturing / Inventory / EFRIS Modernisation — Completion Accounting

**Branch:** `feature/manufacturing-inventory-efris-modernisation`
**Date:** 2026-11-04
**Status:** Backend and frontend complete; API + web typecheck green, 101 web tests passing, web production build clean. Shipped to `main` and pushed (production deploys on push via the server-side cron watcher).

This document is a consolidated, honest accounting of what is complete against the two
governing specs (manufacturing/inventory/EFRIS modernisation + URA EFRIS sales reporting,
VAT return filing & tax compliance), what is portal-only-limited, and what remains.

---

## Commits on the branch (ahead of `main`)

| Commit | Scope |
|---|---|
| `c504516` | Multi-UOM model with per-purpose conversion (0221) |
| `a38b147` | EFRIS goods catalogue + product registration lifecycle (0222) |
| `c75b62a` | VAT return filing workflow + tax report history (0223) |
| `20b1493` | Product brand/image + maker-checker approval workflow (0224) |
| `bfec10b` | EFRIS stock-movement report (T131 stock-in / reconciliation) |
| `04a7678` | Natex Cloud product branding + config-driven sign-in (0225) |
| `c589f3f` | VAT return filing + report history UI (tax compliance) |

---

## Complete

### Product / UOM / master data (P2)
- Multi-UOM model with per-purpose conversion factors (migration 0221).
- Product `brand`, `image_url`, and a dedicated `approval_status` column that flows
  through the existing maker-checker workflow (`DRAFT → SUBMITTED → APPROVED/REJECTED`)
  without conflating approval with the lifecycle `status` column that filters pickers and
  catalogues. Wired via `entities.ts` (`inventory.items`), a custom `submitProduct`, and
  guarded in `PROCESS_EXCLUDED`/`MATERIAL_EXCLUDED` so approval is never client-writable.

### EFRIS goods configuration & registration (P6)
- URA goods catalogue copy: searchable list + idempotent bulk import (`/efris/goods`).
- Product → goods registration lifecycle (`UNMAPPED → MAPPED → SUBMITTED → REGISTERED /
  EXCLUDED`), with `mapProductToGoods` and `setRegistrationStatus`. `REGISTERED` is
  operator-confirmed, never synthesised.

### EFRIS stock movement (P7)
- T131 stock-in (goods receipts → operationType 101 / stockInType 102) and T131 stock
  reconciliation (negative inventory-adjustment variance) were already implemented.
- **New:** a dedicated stock-movement report (`/efris/stock-movements`) joining each
  movement to its source document and the acknowledgement-backed fiscal status. A T131
  acknowledgement is **not** an FDN — FDN fields stay null unless the worker populates
  them from a confirmed URA response.

### VAT return filing & tax compliance (P9)
- `tax_filings` table + `report_history` table (migration 0223), permission seeds and
  catalogue grants to `tax_officer` / `accountant` / `internal_auditor`.
- `computeVat` derives output/input VAT from posted `tax_transactions`
  (output = `SALES_INVOICE` + `DEBIT_NOTE` − `CREDIT_NOTE`; input = `PURCHASE_RECEIPT`,
  VAT taxes only). Filing state machine: `OPEN/PREPARED → SUBMITTED → FILED → CLOSED`,
  any non-terminal → `CANCELLED`.
- Frontend: VAT returns table (prepare + submit/file/close/cancel, status- and
  permission-gated) and report-history table (record portal-only URA reports).

### Branding (P10)
- Rebranded the platform display name to **Natex Cloud** while preserving the legal
  issuer **Hope Design Group Ltd** for official documents. The sign-in chrome now reads
  its brand name from the company profile (`app_settings general.company_name`) instead
  of hard-coding "HOPE DESIGN". Migration 0225 seeds `general.company_legal_name` and
  points the legacy display default at "Natex Cloud" — idempotent and scoped so an
  operator's custom value is never rewritten. The EFRIS taxpayer name reads from the
  `taxpayers` table, which is untouched.

---

## ERP-calculated vs official URA (standing rule honoured)

- **ERP-calculated** (never presented as official): `computeVat` output/input/net VAT,
  and the `tax_filings` amounts. These are computed from the ERP's posted transactions.
- **Official URA** (never altered, never force-reconciled): any FDN, verification code,
  or fiscal status written to `efris_transactions`/`efris_documents` comes only from a
  genuine, validated URA response. FISCALIZED is written only by the worker.
- The reconciliation report surfaces variance and never smooths it over.

---

## Portal-only limitations (documented, controlled manual process)

URA exposes no authorised filing API, so these are handled as controlled manual steps —
never browser automation:

- **VAT return filing**: `prepare` is ERP-side only; `submit`/`file`/`close`/`cancel`
  record the operator's confirmation and an optional URA reference. No submission is ever
  claimed without the operator recording it.
- **Stock inquire / stock ledger**: no URA API; the T131 stock acknowledgement is the
  ERP's record of a stock movement, and the stock-movement report presents that record.
- **Z-reports, registers, document requests**: recorded in `report_history`
  (`REQUESTED → RECEIVED/FAILED`) as a manual trail; the ERP never claims to hold an
  official report it does not.

---

## Frontend wiring (now complete)

The backend for every endpoint below was complete and typecheck-green; the frontend
surfaces are now wired too (commit `ae251fd`):

1. **EFRIS goods catalogue UI** — search + idempotent bulk import
   (`/efris/goods`, `/efris/goods/import`) as the `goods` tab in EfrisDesk.
2. **Product registration UI** — map product → goods, set registration status
   (`/efris/registrations*`) as the `registrations` tab.
3. **Stock-movement report UI** — `/efris/stock-movements` as the `stock` tab
   (date/status filter + summary KPI strip).
4. **Product UOM editor** — per-purpose unit + conversion factor
   (PURCHASE/PRODUCTION/SALES/EFRIS) with a pinned BASE row, plus the brand/image fields
   that were already auto-wired through `crudFactory`/`JsonForm` on the 0224 columns.

These follow the established `FinanceFlow` panel patterns (parallel loads with per-panel
failure surfacing, permission-gated actions, no placeholders).

---

## Not done / deliberate

- **No direct production data changes** were applied. All data changes are in reviewable
  migration files (0221–0225) and apply idempotently on deploy.
