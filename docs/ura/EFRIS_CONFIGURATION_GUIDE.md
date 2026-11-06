# EFRIS Configuration Guide — Natex Cloud

**Branch:** `feature/ura-efris-compliance-hardening`
**Audience:** HOPE DESIGN administrators onboarding the URA EFRIS integration.

This guide documents how the integration is actually wired in this repository. It
describes configuration fields, secret handling and the mode/acceptance model. It
does **not** invent URA requirements: every field below maps to the schema in
`packages/db/migrations/0142_efris_production.sql` and the service in
`apps/api/src/services/efris/`.

---

## 1. Two objects: taxpayer and configuration

| Object | Table | Purpose |
|---|---|---|
| Taxpayer (place of business) | `efris_taxpayers` | The registered TIN, legal name, VAT status, environment and effective dates. |
| Integration configuration | `efris_configurations` | How the ERP talks to URA: mode, endpoints, transport protocol, credentials pointers, retry/notification policy. |

A configuration links to a taxpayer via `taxpayer_id`. Secrets are **never**
stored on either row — only `client_id_ref` / `credentials_ref` pointer keys.

---

## 2. Modes and the acceptance model

| Mode | Meaning | Gateway |
|---|---|---|
| `DISABLED` | Nothing is sent to URA. The queue is inert. | — |
| `TEST` | Sandbox. `assertUrlMatchesMode` enforces `efristest.ura.go.ug` (S2S). | Sandbox |
| `ACTIVE` | Production. Enforced `efrisws.ura.go.ug` (S2S). Requires a proven sandbox + resolvable credentials. | Live |

`ACTIVE` cannot be saved until a `TEST` configuration for the same company has
proven the sandbox connection (`security_flags.sandboxProven = true`) and the
credentials pointer actually resolves on the server. Cross-mode hosts are refused
at the transport boundary — a TEST document can never reach the live gateway and
an ACTIVE document can never reach the sandbox.

The three acceptance states are tracked honestly and separately:

- **A. Engineering complete** — code + automated tests pass.
- **B. URA sandbox verified** — real sandbox round-trips with evidence (FDN/VRC).
- **C. Production authorised** — URA-approved production onboarding.

This branch never reports C merely because A or B is complete.

---

## 3. Configuration fields

REST surface: `GET/POST /api/ops/finance/efris/configurations`,
`PATCH /api/ops/finance/efris/configurations/:id` (permission
`efris.configuration.view` / `efris.configuration.manage`).

| Field | Type | Notes |
|---|---|---|
| `code` | string | Unique code (uppercased). |
| `name` | string | Display name. |
| `taxpayerId` | number | Links to `efris_taxpayers.id`. |
| `mode` | `DISABLED`/`TEST`/`ACTIVE` | See section 2. |
| `baseUrl` | url | S2S gateway endpoint. TEST/ACTIVE host is validated against mode. |
| `tokenUrl` | url | OAuth token endpoint (only for the OAuth transport). |
| `authGrantType` | string | Default `client_credentials`. |
| `clientIdRef` | string | Env var name holding the client id / device number. |
| `credentialsRef` | string | Env var name holding the client secret / device private key. |
| `timeoutSeconds` | number | Default 20. |
| `maxAttempts` | number | Retry budget before `FAILED`. |
| `retryBackoffSeconds` | number | Base backoff (capped, exponential). |
| `pollIntervalSeconds` | number | Credit-note approval poll cadence reference. |
| `fiscalizeSalesOnPost` | bool | Auto-queue an invoice for fiscalisation on posting. |
| `autoSubmit` | bool | Whether the background worker submits queued rows. |
| `notifyOnFailure` | bool | Notify roles on terminal failure. |
| `notifyRoleCodes` | string[] | Role codes to notify (default finance roles). |
| `duplicateWindowSeconds` | number | Duplicate-submission guard window. |
| `payloadMapping` | object | Optional ERP→URA field overrides. |
| `securityFlags` | object | Protocol flag, `deviceNo`, and server-written proof flags. |
| `isActive` | bool | Pause/resume the configuration. |

### Transport selection

`security_flags.protocol` selects the transport:

- `ura_s2s` (default) — native URA system-to-system: T104 key exchange, AES-ECB,
  RSA-SHA1 signing.
- `oauth` — client-credentials token + canonical JSON body.
- `offline_enabler` — the Aisino Tax Control Service (TCS): the ERP posts a
  plaintext envelope to the local TCS, which owns the AES key and private key.

The offline enabler is the configuration HOPE DESIGN currently uses
(see `[[efris-offline-enabler-vps-deploy]]` in the project memory).

---

## 4. Secrets (never in the database)

Values resolve from `process.env` at submit time only:

- `client_id_ref` → env key whose value is the **client id** (OAuth) or the
  **device number** (S2S when not carried in `security_flags.deviceNo`).
- `credentials_ref` → env key whose value is the **client secret** (OAuth) or the
  **device private key** (S2S, PEM).

`assertCredentialsResolvable` returns a `400` naming the missing env key before
`TEST`/`ACTIVE` is accepted. The API rejects any payload field that looks like a
secret (`clientSecret`, `privateKey`, `password`, …) and any embedded PEM. The
audit trail and sync logs never receive a credential, key or token.

---

## 5. Permissions

Granular codes from migration `0142` (honoured alongside legacy
`finance.efris.*` codes):

- `efris.configuration.view` / `efris.configuration.manage`
- `efris.transactions.view` / `efris.transactions.submit` / `efris.transactions.retry`
- `efris.errors.view` / `efris.errors.retry` / `efris.errors.archive`
- `efris.reconciliation.view`

Customer TIN lookup is rate-limited and scoped to `crm.customers.*`.

---

## 6. Health monitoring (GAP-6)

A background worker probes every active `TEST`/`ACTIVE` configuration every 5
minutes with a read-only call (T101 server time, or an OAuth token request) and
records the outcome in `efris_health_checks`. No fiscal document is submitted.

- `GET /api/ops/finance/efris/health` — recent health history (filter `configId`,
  `limit`).
- `GET /api/ops/finance/efris/status` — integration status banner now includes
  `lastHealthCheck`.

Offline-enabler configurations hold their device key on the TCS, so they cannot
run T101; they are recorded `ok = null` ("manual verification required"), never
a false failure.

---

## 7. Verification path (no live submissions)

1. Seed a taxpayer and a `TEST` configuration with env-backed credentials.
2. `POST /api/ops/finance/efris/configurations/:id/probe` — T101/token proof.
   A successful TEST probe writes `sandboxProven`.
3. Confirm the scheduled health check records `ok = true` for the configuration.
4. Only then switch a configuration to `ACTIVE` — and only with explicit
   authorisation to issue live fiscal documents.
