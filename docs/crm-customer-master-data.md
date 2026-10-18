# CRM Customer Master Data — Edit, Duplicate Prevention & EFRIS Verification

This change completes the customer master-data workflow in the CRM: a full
**Edit Account** form (replacing a misleading no-op Save button), duplicate
prevention that includes the TIN, and persistence of the URA EFRIS lookup
outcome on the customer record.

## Audit findings addressed

| # | Finding | Resolution |
| --- | --- | --- |
| 1 | The account desk showed a **Save** button that reported "No pending edits" without saving anything. | Replaced with an **Edit account** action that opens a real edit form (Save/Cancel, validation, loading state, error + success feedback). |
| 2 | No way to update customer master data after creation. | Added `updateCustomer` (whitelisted fields) and `POST /api/ops/crm/customers/:id`. |
| 3 | Duplicate detection ignored the TIN. | `findDuplicates` now matches on the normalised TIN in addition to name, email and phone. |
| 4 | EFRIS lookup outcome existed only in the UI and was lost on reload. | Lookup outcome is now persisted (`efris_verification`, `efris_verified_at`, `efris_ref`) at save time via the review-then-save flow. |
| 5 | Create did not accept several master-data fields (website, addresses, currency, identifiers). | `createCustomer` extended; the edit form exposes TIN, NIN, VRN, phone, email, website, billing/shipping address, currency, credit limit and payment terms. |

## Feature inventory

- **Create** (`POST /api/ops/crm/customers`) — name, customer type, TIN, NIN,
  VRN, phone, email, website, address, billing/shipping address, currency,
  credit limit, payment terms, and the EFRIS `verification` outcome.
- **Read** (`GET /api/ops/crm/customers/:id`) — full 360° view including
  contacts, opportunities, quotations, orders, invoices, plant work, credit,
  aging, health and timeline.
- **Update** (`POST /api/ops/crm/customers/:id`) — the whitelisted master-data
  fields above. Status and ownership are deliberately excluded (use the
  dedicated status/assign endpoints so privileged transitions stay separately
  permissioned and audited).
- **Search / filter / pagination** (`GET /api/ops/crm/customers`) — `q`,
  `status`, `page`, `pageSize`.
- **Status / archive** (`POST /api/ops/crm/customers/:id/status`) — `ACTIVE`,
  `INACTIVE` (soft archive), `BLOCKED`, `PROSPECT`. Block/unblock requires
  `crm.customers.block`.
- **Duplicate prevention** (`GET /api/ops/crm/duplicates`) — normalised TIN,
  email, phone and name, returned for review; nothing is auto-merged.
- **EFRIS TIN lookup** (`POST /api/ops/finance/efris/customer-lookup`) —
  URA interface `T119`, review-then-save, no auto-create.

## Files modified

- `apps/api/src/services/crm.ts` — `normalizeTin`, `coerceVerification`,
  `createCustomer` extension, new `updateCustomer`, TIN-aware `findDuplicates`.
- `apps/api/src/routes/ops/crm.ts` — `POST /customers/:id` and TIN on the
  `/duplicates` route.
- `apps/web/src/views/CrmFlow.tsx` — EFRIS `verification` pass-through on the
  create form, a real **Edit account** form with TIN + Search EFRIS, and
  TIN/EFRIS highlights on the account desk.
- `packages/db/migrations/0196_crm_customer_verification.sql` — EFRIS
  verification columns and a non-unique TIN index.

## Migration

`packages/db/migrations/0196_crm_customer_verification.sql`

```sql
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS efris_verification TEXT
    CHECK (efris_verification IS NULL OR efris_verification IN ('VERIFIED','NOT_VERIFIED','LOOKUP_FAILED')),
  ADD COLUMN IF NOT EXISTS efris_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS efris_ref TEXT;

CREATE INDEX IF NOT EXISTS idx_customers_tin
  ON customers (company_id, tin)
  WHERE tin IS NOT NULL AND tin <> '';
```

The index is deliberately non-unique: legacy data may already contain duplicate
TINs, and the duplicate-prevention workflow resolves them through review rather
than a destructive constraint.

## API endpoints

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/ops/crm/customers` | `crm.customers.view` |
| GET | `/api/ops/crm/customers/:id` | `crm.customers.view` |
| POST | `/api/ops/crm/customers` | `crm.customers.create` |
| POST | `/api/ops/crm/customers/:id` | `crm.customers.update` |
| POST | `/api/ops/crm/customers/:id/status` | `crm.customers.update` or `crm.customers.block` |
| POST | `/api/ops/crm/customers/:id/assign` | `crm.customers.update` |
| GET | `/api/ops/crm/duplicates` | `crm.customers.view` |
| POST | `/api/ops/finance/efris/customer-lookup` | `crm.customers.create` or `crm.customers.update` |

## Verification status persistence

The lookup outcome is stored at save time (review-then-save), driven by an
actual gateway response:

- `VERIFIED` — the gateway returned a taxpayer for the TIN.
- `NOT_VERIFIED` — the gateway returned no taxpayer for the TIN.
- `LOOKUP_FAILED` — the lookup request failed.

A failed or not-run lookup is stored as `LOOKUP_FAILED` only when a lookup was
attempted and errored; otherwise the verification stays null. `efris_verified_at`
is set to `now()` on a persisted verification, and `efris_ref` records the
normalised TIN. See `docs/efris-customer-tin-lookup.md` for the interface detail
and the live-gateway validation caveat.

## Security

- All endpoints are behind `requirePermission` (RBAC deny-by-default).
- `updateCustomer` only writes whitelisted columns, so request-body fields that
  name other columns are ignored; status/ownership are gated behind their own
  endpoints.
- `coerceVerification` fails closed on an unknown status value.
- EFRIS secrets are never stored in the database and never sent to the frontend
  (resolved from `process.env` via `resolveCredentialValue`).
- The TIN lookup audit line records only the TIN and `found` flag, never the
  returned taxpayer data.

## Test results

Executed in this session:

| Suite | Result |
| --- | --- |
| `apps/api/tests/efris.customer-lookup.test.ts` | 11/11 passed |
| `apps/api/tests/efris.protocol.test.ts` | 4/4 passed |
| `apps/api` typecheck (`tsc --noEmit`) | passed |
| `apps/web` typecheck (`tsc --noEmit`) | passed |

Not run locally (require a live PostgreSQL instance): `apps/api/tests/crm.test.ts`
and `apps/api/tests/efris.test.ts` are database-backed integration tests. They
must be run in an environment with the test database seeded.

## Known limitations

- The TIN duplicate index is non-unique by design (legacy data may already
  contain duplicates); enforcement is via review, not a database constraint.
- EFRIS lookup is against the URA S2S gateway; the response-field mapping is
  sourced from the community `efriser` SDK and must be validated against the
  operator's live gateway before the lookup is treated as authoritative in
  production (see `docs/efris-customer-tin-lookup.md`).
- "Archive" is implemented as the `INACTIVE` status; there is no separate
  `ARCHIVED` status.

## Deployment checklist

1. Merge the migration file `0196_crm_customer_verification.sql` and run
   `npm run db:migrate` (do **not** run destructive migrations without approval).
2. Confirm the company has an active EFRIS configuration before relying on the
   TIN lookup.
3. Validate the live URA `T119` response mapping against the gateway before
   treating lookups as authoritative.
4. Run the database-backed test suites (`crm.test.ts`, `efris.test.ts`) in an
   environment with the seeded test database.
5. No production deploy is performed as part of this change.
