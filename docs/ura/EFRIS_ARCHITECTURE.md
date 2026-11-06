# EFRIS Integration Architecture — Natex Cloud

**Branch:** `feature/ura-efris-compliance-hardening`

## 1. Layering

The integration keeps a strict boundary between ERP business operations and URA communication. Every URA call passes through a controlled backend service; the browser never sees credentials, private keys or unrestricted API access.

```
ERP business ops (sales / finance / inventory)
        │  register efris_transaction (DRAFT/PENDING)
        ▼
Fiscalisation queue ── efris_claim_fiscal_batch() [SECURITY DEFINER]
        │  CLAIMED
        ▼
processor.ts  (build payload → submit → persist outcome)
        │
        ├─ builders.ts      : ERP transaction → T109/T110/T131 content
        ├─ protocol.ts      : AES-ECB + RSA-SHA1 envelope, TEST/ACTIVE isolation
        ├─ client.ts        : transport (S2S / OAuth / offline-enabler)
        └─ config.ts        : env-backed credential resolution
        ▼
URA gateway (sandbox / live) — or offline enabler (Aisino TCS)
```

## 2. Transport isolation

- **Native S2S** (`protocol === ura_s2s`, no token URL): T104 key exchange, AES-encrypted T109/T110/T131 content, RSA-SHA1 signature. TEST → `https://efristest.ura.go.ug`, ACTIVE → `https://efrisws.ura.go.ug`.
- **Offline enabler** (`protocol === offline_enabler`): plaintext content + empty signature to the local TCS; the TCS holds the AES key + private key and overrides `appId`/`deviceNo`.
- **OAuth** (`token_url` set): client-credentials token + canonical JSON body.

`assertUrlMatchesMode` refuses any cross-mode host, including loopback for ACTIVE unless explicitly allow-listed.

## 3. Outcome discipline

| Transaction kind | Success condition | Persisted state |
|---|---|---|
| T109 invoice / debit note / receipt | FDN + verification code | `FISCALIZED` + `efris_documents` row |
| T110 credit note | `referenceNo` returned | `TRANSMITTED` (awaits URA approval) |
| T110 approval poll | `approveStatus=101` → fetch T108 red invoice | `FISCALIZED` / `REJECTED` |
| T131 stock movement | `returnCode 00` acknowledgement | `ACCEPTED` (no FDN) |

Anything short of the success condition is recorded in `efris_integration_errors` and retried with backoff (or `FAILED` at the attempt budget).

## 4. Data flow (single fiscalisation)

1. `registerEfrisDocument` / auto-queue inserts `efris_transactions` (status `PENDING`), `request_ref` set.
2. Scheduler ticks `drainEfrisQueue` → `efris_claim_fiscal_batch` claims up to N due rows (single-flight guarded).
3. `processFiscalRow`:
   - **Read phase** (short transaction): load config, taxpayer, source document → build payload → `COMMIT`.
   - **Network phase** (no open transaction): `submitFiscalDocument`.
   - **Write phase** (short transaction): persist FDN/VRC or failure; audit; notify.
4. `recordFailure` runs outside the rolled-back processing transaction so a failure is never lost.

## 5. Secrets

- `efris_configurations` / `efris_taxpayers` store only `client_id_ref` / `credentials_ref`.
- Values resolve from `process.env` at submit time (worker), never from the DB.
- `assertCredentialsResolvable` returns a 400 naming the missing env key before TEST/ACTIVE is allowed.
- The audit trail and error/sync logs never receive a credential, private key or token.

## 6. Permissions

Granular `efris.*` codes (`configuration.view`, `configuration.manage`, `transactions.view`, `transactions.submit`, `transactions.retry`, `errors.view`, `errors.retry`, `errors.archive`, `reconciliation.view`) are honoured alongside the legacy `finance.efris.*` codes. The customer TIN lookup is rate-limited and scoped to CRM create/update permissions.
