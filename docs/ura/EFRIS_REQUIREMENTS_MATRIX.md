# EFRIS Requirements Traceability Matrix

**Branch:** `feature/ura-efris-compliance-hardening`

Status legend:
- ✅ **Implemented** — present in code with automated test coverage.
- 🟡 **Partial** — present but narrower than the mandate, or unverified against the official spec.
- ❌ **Missing** — not present.
- 🔒 **Blocked on URA confirmation** — cannot be completed correctly without the official specification.

> This matrix maps the **mandate's** requirements to the implementation. It is not a claim of URA acceptance. Official URA specification versions must be attached by HOPE DESIGN and referenced in the "Evidence" column before any 🔒/🟡 row can move to ✅.

| ID | Requirement (mandate) | Status | Implementation / Evidence | Notes |
|---|---|---|---|---|
| REQ-1 | Taxpayer registration & TIN | ✅ | `efris_taxpayers` + `directory.ts` CRUD | Secrets stored as env refs, never in DB |
| REQ-2 | EFRIS device registration & thumbprint | 🟡 | `resolveDeviceNo` + T101 probe | No automated registration-validity check (GAP-6) |
| REQ-3 | Digital certificates / key signing | ✅ | RSA-SHA1 sign + T104 AES key decrypt (`protocol.ts`) | Round-trip covered by `efris.protocol.test.ts` |
| REQ-4 | Sandbox & production environments | ✅ | `assertUrlMatchesMode`; TEST/ACTIVE host isolation | Cross-mode submission refused |
| REQ-5 | Goods & services registration | ✅ | `goods.ts` catalogue + product mapping lifecycle | REGISTERED is operator-confirmed |
| REQ-6 | Stock management & reconciliation | 🟡 | T131 stock-in + reconciliation; report | See GAP-5 for report breadth |
| REQ-7 | Fiscal invoices & receipts | ✅ | T109 (invoice) + B2C e-receipt via `receipts` | FDN+VRC required before FISCALIZED |
| REQ-8 | B2B / B2C / B2G transactions | 🟡 | B2B (`buyerType 0`) / B2C (`buyerType 1`) | B2G not modelled (GAP-3) |
| REQ-9 | Credit notes & approval | ✅ | T110 → T111 → T108 two-step; `pollCreditNoteApplications` | Debit notes stay positive T109 |
| REQ-10 | Cancellation / reversal / correction | 🟡 | ERP cancel (`cancelEfrisTransaction`); URA credit-note reversal path | URA-side cancellation interface not implemented (🔒) |
| REQ-11 | Tax reporting & reconciliation | 🟡 | Reconciliation endpoint + VAT filing (0223) | Report breadth per section 14 incomplete (GAP-5) |
| REQ-12 | Tax calculation (VAT/zero/exempt/excise/mixed) | 🟡 | Standard + zero rated in `taxCategory` | Exempt + excise + mixed-category unmodelled (GAP-2) 🔒 |
| REQ-13 | Effective-dated tax config, no hardcoded rate | 🟡 | `statutory_configs` effective-dated for payroll; VAT rate derives from `invoice_items.tax_percent` | EFRIS tax-category *code* mapping is a hard-coded band (GAP-2) |
| REQ-14 | Line- & document-level accuracy + rounding | ✅ | `prepareLines`/`money`/`qty`; totals reconciled in builder | Unit-tested |
| REQ-15 | Duplicate-submission prevention / idempotency | 🟡 | Stable `sellersReferenceNo`; migration `0211` guard; `singleFlight`; claim-batch | `dataExchangeId` regenerated per attempt (GAP-4) |
| REQ-16 | Timeout / unknown-outcome reconciliation | ❌ | Retry-with-backoff only | Must query URA status before re-submit (GAP-4) 🔒 |
| REQ-17 | Error centre + manual retry with permissions | ✅ | `efris_integration_errors` + retry/archive endpoints (granular perms) | |
| REQ-18 | Dead-letter processing | ✅ | `FAILED` terminal state + notifications | |
| REQ-19 | Secrets management & least privilege | ✅ | Env-only secrets; `efris.configuration.manage` guarded | |
| REQ-20 | Audit trail without secret exposure | ✅ | `logAudit` on lookup/submit/fail/fiscalize; metadata only | |
| REQ-21 | Frontend EFRIS workspace | 🟡 | Embedded in `FinanceFlow.tsx` + `OrganisationSettings.tsx` | No standalone dashboard; see GAP-8 |
| REQ-22 | Reports (section 14 list) | 🟡 | Reconciliation + stock movement + VAT filing | Several reports missing (GAP-5) |
| REQ-23 | Automated test suite | ✅ | 4 suites, ~40 cases (mock/deterministic) | Sandbox harness separate (GAP-7) |
| REQ-24 | UAT matrix | ❌ | — | To be produced (GAP-7) |
| REQ-25 | Database migration discipline | ✅ | Backward-compatible migrations; no drop/rename; 0211/0220/0222/0223 | |
| REQ-26 | Documentation deliverables (section 18) | 🟡 | `EFRIS_GAP_ANALYSIS.md`, `EFRIS_REQUIREMENTS_MATRIX.md` (this branch) | Architecture / config guide / UAT plan / production readiness pending |

---

## Blocked-items register (require official URA confirmation)

| Item | Blocking question | Owning gap |
|---|---|---|
| Exempt / zero-rated distinction | Official `taxCategoryCode` for exempt supplies | GAP-2 |
| Excise duty fields | Official excise field semantics for this taxpayer's goods | GAP-2 |
| B2G buyer classification | Official buyerType / buyer classification for government buyers | GAP-3 |
| Uncertain-submission reconciliation | Official status/query interface code + request/response shape | GAP-4 |
| URA-side cancellation/correction | Official cancellation interface and its distinction from credit-note reversal | REQ-10 |
