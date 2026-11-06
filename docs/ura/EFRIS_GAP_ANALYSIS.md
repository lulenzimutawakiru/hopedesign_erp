# EFRIS Gap Analysis — Natex Cloud by HOPE DESIGN

**Branch:** `feature/ura-efris-compliance-hardening`
**Scope:** URA Electronic Fiscal Receipting and Invoicing Solution (EFRIS) compliance
**Status:** Audit complete. This document records what exists, what is missing, and what requires official URA confirmation before it can be changed.

> **Honesty rule.** Nothing in this document invents a URA requirement, API field, response code, tax rate or transaction code. Where the official specification is not in hand, the item is marked **REQUIRES URA CONFIRMATION** rather than guessed. Internal tests — including a successful sandbox round-trip — are recorded as *engineering* evidence, never as URA acceptance.

---

## 1. Existing implementation (what is already built)

The EFRIS integration is substantial, layered and tested. It is **not** a "test invoice only" stub.

| Layer | File | What it does |
|---|---|---|
| Transport | `services/efris/client.ts` | Three transports — native URA system-to-system (S2S), OAuth client-credentials, and the offline enabler (Aisino TCS). TEST/ACTIVE mode isolation, timeouts, retryable classification, fiscal-identifier extraction (FDN + verification code required). |
| Protocol | `services/efris/protocol.ts` | AES-ECB (PKCS7) encryption, RSA-SHA1 signing, T104 symmetric-key exchange, T109/T110/T131 payload builders, TEST/ACTIVE host isolation, credit-note reason codes, stock-adjustment codes. |
| Config | `services/efris/config.ts` | Secrets resolved from `process.env` only (never the database). DISABLED/TEST/ACTIVE modes. Credential resolvability pre-flight. |
| Taxpayer | `services/efris/taxpayer.ts` | T119 customer TIN lookup. TIN normalisation, audit log that copies no returned taxpayer data. |
| Goods | `services/efris/goods.ts` | URA goods catalogue copy + bulk import; product → goods mapping; registration lifecycle (UNMAPPED/MAPPED/SUBMITTED/REGISTERED/EXCLUDED); REGISTERED is operator-confirmed. |
| Stock | `services/efris/stock.ts` | T131 stock-movement report (goods receipts + reconciliation adjustments). |
| Processor | `services/efris/processor.ts` | Background fiscalisation worker. Claims due rows, builds payloads, submits, persists outcomes. FISCALIZED **only** on a confirmed FDN + verification code. Credit notes two-step (T110 application → T111/T108 poll). T131 → ACCEPTED (acknowledgement, no FDN). Retry/backoff/dead-letter, audit, notifications. |
| Directory | `services/efris/directory.ts` | Taxpayer/configuration CRUD, integration status, error centre, reconciliation. |
| Routes | `routes/ops/finance.ts` | Full REST surface with granular `efris.*` permissions (+ legacy `finance.efris.*`), and rate-limiting on the customer lookup. |
| Tests | `tests/efris*.test.ts` | Four suites (~40 cases): protocol round-trips, builders, TEST/ACTIVE isolation, offline enabler, T119 lookup, fiscalisation lifecycle, config secrets. |
| Migrations | `packages/db/migrations/0142, 0193, 0198–0200, 0211, 0220, 0222, 0223` | Fiscal schema, goods mapping, credit-note application, stock movement, duplicate-submission guard, goods catalogue, tax compliance. |

### Document states implemented

`PENDING` / `CLAIMED` / `RETRYING` / `FAILED` / `TRANSMITTED` (credit-note application) / `ACCEPTED` (T131) / `FISCALIZED` (FDN+VRC present) / `CANCELLED` / `REJECTED`.

### What the code does **not** do

- It never fabricates an FDN or verification code.
- It never marks a document FISCALIZED without a confirmed FDN + verification code.
- It never sends a TEST document to the live gateway or an ACTIVE document to the sandbox (`assertUrlMatchesMode`).
- It never exposes credentials: secrets live in env vars; the DB and audit trail store only `*_ref` pointers.

---

## 2. Gaps against the mandate

### GAP-1 — No regulatory traceability matrix (documentation gap)
There is no source-level mapping from each URA requirement to its implementation. The code comments cite "the S2S guide" and "the gateway's option list", but there is no `EFRIS_REQUIREMENTS_MATRIX.md` linking behaviour to a dated URA specification.
- **Severity:** High (governance/audit).
- **Remediation:** `docs/ura/EFRIS_REQUIREMENTS_MATRIX.md` (produced in this branch) + attach official spec versions when supplied by HOPE DESIGN.

### GAP-2 — Tax category model is narrower than the mandate (REQUIRES URA CONFIRMATION)
`protocol.ts → taxCategory(rate)` currently maps only two categories:
- `0.17–0.19` → `01` (Standard)
- `0` → `02` (Zero)
- anything else → `01` (Standard)

Consequences:
1. **Exempt supplies are not distinguished from zero-rated.** Both are `rate === 0`, so an exempt line is emitted as `02 Zero`. URA treats zero-rated and exempt as distinct tax categories.
2. **A non-standard rate (e.g. 12% or 5%) is silently labelled Standard.**
3. **Excise duty is not modelled.** Every `excise*` field in `buildT109Content` / `buildT110Content` is emitted empty.

- **Severity:** High for any taxpayer with exempt or excisable supplies; Low for the current single-product (NATEX-A4, standard-rated) scope.
- **Remediation:** Add a config-driven tax-category resolver (effective-dated, per-company) instead of the hard-coded band. **The exact URA `taxCategoryCode` for "exempt" and any excise fields must be confirmed from the official specification before implementation.**

### GAP-3 — B2G is not explicitly modelled
`buyerDetails.buyerType` is derived solely from the presence of a buyer TIN: `'0'` (registered business) when a TIN is present, `'1'` (consumer) otherwise. There is no distinct B2G (business-to-government) classification.
- **Severity:** Medium.
- **Remediation:** Confirm the URA B2G buyer classification and whether the customer master already distinguishes government buyers; then map it.

### GAP-4 — Uncertain-submission (timeout) reconciliation is not automatic (REQUIRES URA CONFIRMATION)
On a network/unknown-outcome failure the worker marks the row `RETRYING` and re-submits the **same** payload on the next attempt. It does **not** first query URA for the original transaction's outcome before re-submitting.

Mitigations already present:
- The submission payload carries a stable `sellersReferenceNo` (`docRefCode`) and `referenceNo`; the same payload is replayed, so a gateway that deduplicates on content will not double-issue.
- Migration `0211_efris_duplicate_fiscalisation_guard.sql` guards against duplicate fiscalisation at the DB layer.
- `dataExchangeId` is regenerated per attempt (`crypto.randomBytes(16)`), which **weakens** URA-level dedupe keyed on the exchange id.

- **Severity:** High for reliability under flaky connectivity (the exact scenario section 11 of the mandate targets).
- **Remediation:** Before re-submitting a network-timeout failure, call the official URA status/query interface for the transaction (reference number) and reconcile first. **The query interface code and request shape must come from the official specification.**

### GAP-5 — Reports are incomplete against section 14
Present: EFRIS reconciliation (`/efris/reconciliation`), stock-movement report (`/efris/stock-movements`), VAT return filing (migration `0223`).
Missing from the mandate's list:
- Daily fiscalised sales; sales by tax category; zero-rated/exempt supply reports.
- EFRIS-vs-ERP sales and tax reconciliation report (a dedicated report, not just the reconciliation endpoint).
- API/integration health and product-registration-status reports.

- **Severity:** Medium.
- **Remediation:** Add the report queries once the tax-category model (GAP-2) is confirmed.

### GAP-6 — No automated credential/device lifecycle monitoring
The configuration supports a manual T101 probe (`/efris/configurations/:id/probe`), but there is no automated monitoring for:
- credential/certificate expiry, and
- device-registration validity (the 2026-10-20 re-provisioning left the device unregistered; nothing surfaces this until a submission fails with `400 Device does not exist`).
- **Severity:** Medium.
- **Remediation:** **Implemented (this branch).** `0228_efris_health_monitoring.sql` + `services/efris/health.ts`: a scheduled worker probes every active TEST/ACTIVE configuration (T101/token) every 5 minutes and records the outcome; `/efris/health` surfaces it and `efrisIntegrationStatus` includes `lastHealthCheck`. Offline-enabler configs (TCS-owned key) are recorded `ok=null` (manual), never a false failure.

### GAP-7 — No formal UAT matrix or sandbox integration harness
Tests are mock-based and deterministic, which is correct for CI. But the sandbox round-trip is a manual operation with no formal UAT matrix (section 15) and no separate, clearly-marked sandbox harness.
- **Severity:** Medium (governance).
- **Remediation:** **Produced (this branch).** `docs/ura/EFRIS_UAT_TEST_PLAN.md` (13-scenario matrix) + `scripts/efris-sandbox-harness.ts`, a tagged script that runs the read-only T101/T119 sandbox proofs and never runs in CI. Fiscalising steps stay on the ERP API + worker (built by the real payload builders).

### GAP-8 — Documentation deliverables missing
No `docs/ura/` existed before this branch. Section 18 requires six documents plus updated API documentation.
- **Remediation:** **Complete (this branch).** `EFRIS_GAP_ANALYSIS.md`, `EFRIS_REQUIREMENTS_MATRIX.md`, `EFRIS_ARCHITECTURE.md`, `EFRIS_CONFIGURATION_GUIDE.md` (includes the API surface), `EFRIS_UAT_TEST_PLAN.md`, `EFRIS_PRODUCTION_READINESS.md`.

---

## 3. Non-gaps (already correct)

- **Secrets handling.** Credentials never enter the DB, logs or audit trail. `recordFailure` persists only the fiscal request/response payloads (no client secret, private key or token).
- **TEST/ACTIVE isolation.** `assertUrlMatchesMode` refuses cross-mode hosts at the transport boundary; the probe requires TEST success before ACTIVE.
- **FDN discipline.** `extractFiscalIdentifiers` returns null unless both FDN and verification code are present; the processor then refuses to mark FISCALIZED.
- **T131 semantics.** A stock acknowledgement is recorded as ACCEPTED, not a fiscal document.
- **Credit notes.** Two-step T110 → T111/T108; debit notes remain positive invoices on T109; no conflation of ERP cancellation with URA cancellation.

---

## 4. Remediation order (proposed)

1. **Documentation + traceability** (GAP-1, GAP-7, GAP-8) — no URA dependency. *In progress on this branch.*
2. **Automatic health/device monitoring** (GAP-6) — safe; reuses T101.
3. **Reports** (GAP-5) — safe; blocked on GAP-2 confirmation for tax-category splits.
4. **Uncertain-submission reconciliation** (GAP-4) — **REQUIRES the official status-query interface**.
5. **Tax-category/excise model** (GAP-2) and **B2G** (GAP-3) — **REQUIRE official URA confirmation** of category codes and buyer classification.

---

## 5. Acceptance-state honesty

| State | Meaning | Current |
|---|---|---|
| **A. Engineering complete** | Code + automated tests pass | In progress — typecheck green; CI unverified (GitHub Actions billing lock); mock suite present |
| **B. URA sandbox verified** | Real sandbox round-trips pass with evidence | Partially — historical sandbox fiscalisation succeeded (FDN issued), but the device was re-provisioned 2026-10-20 and is currently unregistered |
| **C. Production authorised** | URA approved production onboarding | **Not claimed.** Requires device registration, credentials, certificates and production config |

This branch will never report **C** merely because **A** or **B** is satisfied.
