# EFRIS Production Readiness — Natex Cloud

**Branch:** `feature/ura-efris-compliance-hardening`

A single checklist for the moment HOPE DESIGN decides to move from sandbox to
live fiscalisation. Nothing here authorises production; it records the
preconditions that must all be true first. Production (acceptance state C) is
granted by URA, not by this repository.

---

## 1. Blocking preconditions

- [ ] URA device **registered** and the device number confirmed current (the
      2026-10-20 re-provisioning left a device unregistered — see project memory
      `efris-sandbox-device-and-key`).
- [ ] Device private key and number resolvable from the server environment (not
      in the DB, not in logs).
- [ ] A `TEST` configuration has **proven the sandbox** (`sandboxProven = true`).
- [ ] Sandbox round-trips on file: FDN + verification code for a T109 invoice,
      a completed T110→T111→T108 credit note, and a T131 acknowledgement.
- [ ] Health monitor (`GET /efris/health`) reports `ok = true` for the intended
      production configuration (or, for the offline enabler, the TCS has been
      verified locally).
- [ ] The tax-category model covers this taxpayer's supplies. **Blocked items:**
      exempt-supply category code and excise fields require the official URA
      specification (GAP-2); B2G classification requires confirmation (GAP-3).
- [ ] Uncertain-submission reconciliation (GAP-4) decision recorded: the current
      worker replays the same stable payload; the official URA status-query
      interface has **not** been wired. This is a known, documented limitation,
      not a hidden one.

## 2. Non-blocking but required before go-live sign-off

- [ ] Secrets stored only in env; `client_id_ref` / `credentials_ref` verified
      to resolve on the production node.
- [ ] Production firewall allows only the intended egress (URA live hosts, or
      the TCS VPS) — the TCS VPS still needs its firewall review (see project
      memory `efris-offline-enabler-vps-deploy`).
- [ ] Notifications (`notifyOnFailure`, role codes) confirmed to reach the
      finance/tax roles.
- [ ] Reports reviewed: reconciliation endpoint plus the health report surface.

## 3. What must be authorised explicitly

The following are **never** done automatically and are refused here without
explicit authorisation:

- Switching a configuration to `ACTIVE`.
- Altering live URA credentials or pointing a live configuration at a new host.
- Submitting a live fiscal document.
- Changing production settings.

## 4. Known gaps (tracked, not hidden)

| Gap | Status | Required for go-live? |
|---|---|---|
| GAP-2 tax-category / excise | 🔒 official spec needed | Only if exempt/excisable supplies exist |
| GAP-3 B2G classification | 🔒 official spec needed | Only if selling to government |
| GAP-4 uncertain-submission reconciliation | 🔒 official status-query spec needed | Recommended before heavy live volume |
| GAP-5 reports (tax-category splits) | 🟡 blocked on GAP-2 | Partial |
| GAP-6 health monitoring | ✅ implemented this branch | — |

## 5. Go/no-go

Production readiness is **C only when URA authorises live onboarding.** Until
then the honest posture is **A** (engineering complete) or **B** (sandbox
verified), and this document records exactly which preconditions remain.
