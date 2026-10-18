# EFRIS Customer TIN Lookup (URA interface code T119)

Hope Design CRM can query the Uganda Revenue Authority (URA) EFRIS
system-to-system (S2S) gateway for a taxpayer record by TIN, so a customer
account can be populated from — and cross-checked against — the taxpayer
register. The lookup is **review-then-save**: nothing is created or overwritten
automatically.

## Interface

| Item | Value |
| --- | --- |
| Interface code | `T119` (query taxpayer by TIN) |
| Test endpoint | `https://efristest.ura.go.ug/efrisws/ws/taapp/getInformation` |
| Production endpoint | `https://efrisws.ura.go.ug/ws/taapp/getInformation` |
| Transport | URA system-to-system gateway (signed envelope, no OAuth token) |
| Content encoding | Unencrypted base64 (`codeType: "0"`, `encryptCode: "1"`, `zipCode: "0"`) |
| Signature | RSA-SHA1 over the content, using the company device private key |

The OAuth/gateway transport used by the newer fiscal-document flow is **not**
available for `T119`; the lookup refuses that configuration with
`EFRIS_LOOKUP_TRANSPORT`.

## Request payload

The unencrypted content sent to the gateway is:

```json
{ "tin": "<10-digit TIN>", "ninBrn": "" }
```

The surrounding envelope is the standard EFRIS S2S envelope
(`data` / `globalInfo` / `returnStateInfo`) with `globalInfo.interfaceCode`
set to `T119` and the company's own taxpayer TIN and device number populated.

## Response fields

Only these fields are read and mapped into the lookup result. They are the
fields the EFRIS SDK documents for the taxpayer query:

| Response field | Mapped to |
| --- | --- |
| `tin` | `tin` |
| `governmentTIN` | `governmentTin` |
| `legalName` | `legalName` |
| `businessName` | `businessName` |
| `address` | `address` |
| `contactEmail` | `contactEmail` |
| `contactNumber` | `contactNumber` |
| `taxpayerType` | `taxpayerType` |

Unknown or additional fields returned by the gateway are intentionally dropped
and never copied into a customer record. Snake-case variants of the same names
are accepted for resilience.

## Source and validation caveat

`T119` and the request/response shape above were sourced from the community
`efriser` SDK (interface code, `tin`/`ninBrn` request payload, and the eight
response fields). This is **not** URA's integrator-only specification, and URA
has not published an official public spec for this operation.

**Before treating a lookup as authoritative in production, validate the live
response mapping against the operator's gateway** — confirm the exact envelope
key casing, the success/not-found return codes, and that the eight fields above
are what the gateway actually returns. Do not claim live integration from
mocked tests alone.

## How the lookup is wired

- `apps/api/src/services/efris/protocol.ts` — `digObject` / `digFirst` helpers
  for tolerant key matching.
- `apps/api/src/services/efris/client.ts` — `queryTaxpayerByTin` (builds and
  signs the `T119` envelope) and `extractTaxpayer` (field mapping).
- `apps/api/src/services/efris/taxpayer.ts` — `lookupCustomerTin` service:
  validates the TIN, resolves the company's EFRIS configuration and
  credentials, calls `queryTaxpayerByTin`, finds duplicate customer accounts,
  and writes an audit line (`efris_customer_tin` lookup — TIN and `found` flag
  only, never the returned taxpayer data).
- `apps/api/src/routes/ops/finance.ts` — `POST /api/ops/finance/efris/customer-lookup`
  guarded by `crm.customers.create` **or** `crm.customers.update`, and by the
  `customerLookupLimiter` rate limit.
- `apps/web/src/views/CrmFlow.tsx` — the TIN field with a **Search EFRIS**
  button and a debounced auto-lookup once the TIN reaches 10 digits.

## Required configuration

The lookup reuses the existing EFRIS configuration for the company; no new
secrets are introduced.

- A company must have an active EFRIS configuration (`resolveFiscalTarget`
  returns a target), otherwise the endpoint returns
  "EFRIS integration is not configured for this company".
- The company device private key and client credentials must resolve from the
  existing credential references (server-side environment, never stored in the
  database and never sent to the frontend).
- The lookup is only available on the URA S2S gateway (`mode` `TEST` or
  `ACTIVE`); a `DISABLED` or OAuth configuration is refused.

## Verification status

The CRM now persists the lookup outcome on the customer at save time
(review-then-save) via `efris_verification` (`VERIFIED` / `NOT_VERIFIED` /
`LOOKUP_FAILED`), `efris_verified_at`, and `efris_ref` — see
`docs/crm-customer-master-data.md` and migration
`0196_crm_customer_verification.sql`. The status is driven by an actual gateway
response, never by HTTP success alone.

## Tests

`apps/api/tests/efris.customer-lookup.test.ts` covers TIN normalisation and
validation, field mapping (including unknown-field dropping and snake-case
variants), the signed `T119` envelope, `found: false`, `DISABLED` and OAuth
refusals, business rejection, and missing private key. These are pure unit
tests with a mocked `fetch`; they do **not** exercise the live URA gateway.
