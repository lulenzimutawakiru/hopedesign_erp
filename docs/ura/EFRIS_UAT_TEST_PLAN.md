# EFRIS UAT Test Plan — Natex Cloud

**Branch:** `feature/ura-efris-compliance-hardening`
**Purpose:** Formal user-acceptance matrix (mandate section 15) for the URA EFRIS
integration, and the sandbox integration harness that proves it.

> **Honesty rule.** A passing UAT row here records an *observed* outcome, not a
> URA acceptance. Sandbox round-trips are engineering evidence. Production
> authorisation (state C) is only ever granted by URA after live onboarding, and
> is never inferred from a passing sandbox test.

---

## 1. Acceptance-state mapping

| State | Evidence required | Tracked where |
|---|---|---|
| A. Engineering complete | `tsc` clean; mock/deterministic suites pass | CI (GitHub Actions) |
| B. URA sandbox verified | Real sandbox round-trips with FDN + VRC on file | Sandbox harness + evidence log |
| C. Production authorised | URA production onboarding approved | URA-side, not this repo |

---

## 2. Sandbox harness (never runs in CI)

A tagged, standalone script (`scripts/efris-sandbox-harness.ts` in this branch)
exercises the real sandbox through the ERP's own service layer. It is **not**
part of the test suite: it needs a live TIN, device number and private key, and
must only be pointed at `TEST` (sandbox) endpoints.

It performs, in order:

1. **T101 server-time probe** — proves the gateway, device number and key.
2. **T119 taxpayer lookup** — proves customer TIN query (no fiscalisation).
3. **T109 fiscal invoice** — a single sale; asserts an FDN + verification code
   are returned before any status is considered success.
4. **T110 → T111 → T108 credit note** — applies, polls, then fetches the
   approved red invoice; asserts the FDN.
5. **T131 stock-in** — asserts an acknowledgement (no FDN).

The harness prints the raw request/response for each step so the evidence can be
attached to the UAT record, but it redacts the private key from any output.

---

## 3. UAT matrix

Run against the **sandbox** only. "Expected" is what the ERP must observe; "Pass"
is recorded only when observed.

| ID | Scenario | Precondition | Steps | Expected | Pass (date/initials) |
|---|---|---|---|---|---|
| UAT-01 | Save TEST configuration | Taxpayer exists | Create config, `mode=TEST`, env creds resolve | 200; `protocol`, `gatewayHost`, `secretsResolvable` correct | |
| UAT-02 | DISABLED guard | Config `DISABLED` | Attempt submission | Refused; nothing sent | |
| UAT-03 | T101 probe | TEST config + key | `POST .../configurations/:id/probe` | `ok:true`, `interfaceCode:T101`; `sandboxProven` set | |
| UAT-04 | Cross-mode isolation | TEST config | Point baseUrl at live host | 400 `EFRIS_MODE_HOST_MISMATCH`; nothing sent | |
| UAT-05 | Fiscalise a sale | Product mapped to URA goods | Post invoice → worker | `FISCALIZED` with FDN + VRC persisted | |
| UAT-06 | Duplicate guard | UAT-05 invoice | Re-submit same document | No second fiscal document issued | |
| UAT-07 | Credit note two-step | FISCALIZED invoice | Apply credit note | `TRANSMITTED` + `referenceNo`; later `FISCALIZED` after URA approval | |
| UAT-08 | Stock movement | Goods receipt | Submit T131 | `ACCEPTED` (acknowledgement, no FDN) | |
| UAT-09 | Failure → error centre | Invalid device | Submit | `FAILED`/`RETRYING`; row in error centre; no FDN | |
| UAT-10 | Manual retry | Open error | `POST .../errors/:id/retry` | Requeued; never double-reports a `FISCALIZED` row | |
| UAT-11 | Secret never exposed | Any write path | Send `privateKey`/`clientSecret` in body | 400; DB/audit hold only `*_ref` keys | |
| UAT-12 | Health monitor | Active TEST config | Wait one tick / read `GET /efris/health` | `ok:true` (or `ok:null` for offline enabler) recorded | |
| UAT-13 | Reconciliation | Fiscalised + unfiscalised invoices | `GET .../efris/reconciliation` | Variances surface; nothing smoothed over | |

---

## 4. Evidence log

Attach, for each fiscalising scenario: the date, the operator, the raw (key
-redacted) request/response, and the FDN + verification code returned by URA.
Store the FDN/VRC with the transaction; do **not** record the private key.
