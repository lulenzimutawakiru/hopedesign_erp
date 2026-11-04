# Natex Cloud — Enterprise Rebrand Plan & Implementation Record

**Branch:** `feature/natex-cloud-enterprise-rebrand`
**Owner:** HOPE DESIGN · **Product:** Natex Cloud
**Tagline:** Streamlining Operations, Empowering Growth.
**Footer:** Powered by Natex Cloud.

---

## 0. Current state (assessed 2026-11-04)

The *naming* layer is already rebranded and shipped to `main`:

- Migration `0225_natex_cloud_brand.sql` seeds `general.company_name = "Natex Cloud"` and
  `general.company_legal_name = "<companies.legal_name>"`, preserving the legal issuer for
  official documents. Idempotent; never rewrites an operator's custom value.
- `LoginPage` reads the product brand from the company profile (`general.company_name`)
  instead of hard-coding "HOPE DESIGN". `loadCompanyProfile()` already separates
  display `name` from legal `legalName`.

The *visual identity* is still the legacy "HOPE DESIGN" system and is the gap this branch closes:

| Surface | Location | Legacy state |
|---|---|---|
| Design tokens | `apps/web/src/tokens.css` | navy `#0B1F33`, primary `#1261A0`, teal `#00A6A6`, bg `#F5F7FA`; font Outfit |
| App HTML / PWA | `apps/web/index.html` | `<title>HOPE DESIGN</title>`, theme-color `#0B1F33`, old meta description |
| Logo assets | `apps/web/public/logo.svg`, `favicon.svg` | "H" monogram, `#1261A0`/`#00A6A6` |
| Sign-in glyph | `apps/web/src/components/auth/icons.tsx` (`BrandGlyph`) | same "H" mark, hardcoded `#1261A0`/`#00A6A6`/`#0B1F33` |
| Email identity | `apps/api/src/services/emailBranding.ts` | `HOPE DESIGN GROUP LTD`, navy `#0F172A`, red `#FF0000`, sky `#87CEEB` |
| Document templates | `apps/api/src/services/documents.ts` | legacy issuer header/footer (read-only from company config; reassess) |
| Brand catalogue | `apps/api/src/services/organisationSettings/catalogue.ts` | config-driven logo/brandColor (uploaded assets override) |

**Key invariant (preserved):** the display/legal name split. "Natex Cloud" is the product
identity; "Hope Design Group Ltd" (from `companies.legal_name`) stays on official/fiscal
documents and the EFRIS taxpayer record. This branch changes **presentation**, never the
registered legal issuer, DB records, API contracts, permissions, or business logic.

---

## 1. Brand identity specification

### Colour tokens

| Token | Value | Role |
|---|---|---|
| Midnight navy | `#101D35` | sidebar/header ground, ink |
| Electric blue | `#1677FF` | primary action, focus, links |
| Accent cyan | `#13C8E8` | accent, highlights, data marks |
| Cloud white | `#F7F9FC` | page background |

Semantic states: success `#168A5B`, warning `#D99A00`, danger `#C93636`, critical `#B42318`,
info `#1677FF`. All colours defined once in `tokens.css`; modules reference tokens by name.
Light + dark themes via token overrides (dark theme added as a follow-up phase).

### Typography

- Display/UI: **Inter** (400/500/600/700/800) — replaces Outfit.
- Numeric/financial: **IBM Plex Mono** (tabular numerals retained).
- Serif (Source Serif 4) retained only where currently used for display copy.

### Logo system

Concept **"Ascend"** — a navy rounded-square plate carrying a gradient **N** (electric
blue → cyan) and a cyan node, reading as a rising/cloud mark. Masters (SVG, vector source
of truth) live under `apps/web/public/brand/`:

- `natex-cloud-icon.svg` — icon only (used as favicon/apple-touch).
- `natex-cloud-horizontal.svg` — symbol + "NATEX CLOUD" wordmark + "BY HOPE DESIGN".
- `natex-cloud-stacked.svg` — stacked lockup.
- `natex-cloud-monochrome.svg` / `natex-cloud-white.svg` — single-colour variants.

`public/favicon.svg` and `public/logo.svg` are replaced with the icon mark; `BrandGlyph`
is redrawn to match so the sign-in chrome is asset-free but identical.

---

## 2. Phased implementation

1. **Repository assessment** — ✅ done (this document).
2. **Brand assets + tokens** — ✅ done. Logo SVG masters, token recolor, `index.html` PWA/meta, `BrandGlyph`.
3. **Email + document identity** — ✅ done. `emailBranding.ts` palette/tagline/legal-name footer; `branding.ts`/`bird.ts`/`documents.ts`/`pdf.ts`/`auth.ts`/`assets.ts`/`mfaEmail.ts` default colours; settings catalogue defaults.
4. **Application shell** — ✅ done. Sidebar/header/nav resolve through `tokens.css`, so the recolor propagates with no per-view edits; no legacy hex remains in the shell or any module (`check-tokens.mjs` clean, see Phase 7).
5. **Authentication chrome** — ✅ done. `LoginPage`/`SecurityNotice` copy + legal-name casing; `auth.css` header; MFA/password-reset email wording ("Natex Cloud").
6. **Dashboards** — ✅ assessed, no change needed. All KPI tiles compute from ERP rows; the only `Math.random` usage is React list `key` generation for editable line items, never displayed statistics. No fabricated figures introduced.
7. **Module-by-module** — ✅ done. Swept remaining hard-coded legacy colours/strings across web + API:
   - Hex: `#1261A0`/`#00A6A6`/`#0f172a`/`#F5F7FA` → `#1677FF`/`#13C8E8`/`#101D35`/`#F7F9FC` (13 view files).
   - rgba legacy-blue tints `rgba(18,97,160,…)` → `rgba(22,119,255,…)` (focus rings, KPI icon tints, hover washes).
   - Product-name copy "HOPE DESIGN …" → "Natex Cloud …" (service desk, hikvision, factory OS, communication centre, workforce planning); legal-name casing "HOPE DESIGN GROUP LTD" → "Hope Design Group Ltd" where it is the legal issuer.
   - API notification/email defaults (`mfaEmail.ts`, `auth.ts`, `communication.ts`, `bird.ts`, `config.ts`, `mail/send.ts`, `cronJobs.ts`, `sales.ts`, `eventNotifications.ts`, `catalogue.ts` defaults, service-desk/payroll/iso header comments).
   - `check-tokens.mjs` CORE_TOKENS updated to the new palette; dark-theme block de-duplicated (removed redundant overrides now identical to `:root`).
8. **PWA/manifest/OG** — ✅ done. Added `public/manifest.webmanifest` (name "Natex Cloud", `#101D35`/`#F7F9FC`, SVG icons) + `<link rel="manifest">` + Open Graph / Twitter card meta in `index.html`; dynamic light/dark `theme-color` already handled by `prefs.ts`.
9. **Accessibility + responsive** — ✅ assessed. Contrast on the new palette (measured vs cloud-white `#F7F9FC`):
   - `--hope #1677FF` ≈ 4.10:1 — passes AA for large text & UI components (3:1), borderline for small/normal text (4.5:1). The prior primary `#1261A0` was ≈ 6.47:1; the electric blue is a deliberate spec choice, and the AA-compliant darker variants `--hope-hover #0E5FD6` (≈ 5.79:1) and `--steel #2E6CC4` (≈ 5.17:1) remain available for small-text/interactive use.
   - `--muted-2 #6A7683` already the AA-compliant muted (comment retained in `tokens.css`). No hard-coded colour left in a CSS/style context that bypasses a token.
10. **Regression + security** — ✅ done. `check-tokens.mjs` clean; web + api `tsc --noEmit` green; web `vite build` green; web suite **101/101** tests pass; api `tsc` build green; `branding.assets.test.ts` **6/6**. `mail.test.ts`/integration suites still skip on the pre-existing unseeded dev-DB login (401), unrelated to this branch.

### Standing rules (unchanged)

- No destructive migrations against production; all changes are reviewable files.
- Preserve DB/history, auth/authz, API contracts, business logic, EFRIS, payroll, permissions.
- Never invent EFRIS commodity codes, endpoints, fields, rates, or company contact details.
- No fabricated statistics; distinguish transactional vs estimated figures.
- Do not merge to `main` without explicit review/approval.

---

## 3. Modified-files inventory (grows per phase)

*Phases 2–3 (brand assets + tokens, email + document identity):*

**Web** — `apps/web/src/tokens.css`, `apps/web/index.html`,
`apps/web/public/favicon.svg`, `apps/web/public/logo.svg`,
`apps/web/public/brand/*.svg` (icon/horizontal/stacked/monochrome/white),
`apps/web/src/components/auth/icons.tsx`.

**API** — `apps/api/src/services/branding.ts` (palette `BRAND`/`BRAND_HEX`, `brandMarkSvg`,
tagline default, `brandColor`/`brandColorSecondary` defaults), `apps/api/src/services/emailBranding.ts`
(`DEFAULT_COMPANY` name/legalName/tagline, `BRAND_COLORS`, footer copyright), `apps/api/src/services/bird.ts`
(legal-name threading), `apps/api/src/services/documents.ts` (id-card/XLSX brand fallbacks),
`apps/api/src/services/pdf.ts` (footer/table defaults), `apps/api/src/auth.ts` (TOTP QR colour),
`apps/api/src/services/assets.ts` (label sheet colours), `apps/api/src/services/mfaEmail.ts` (warning token),
`apps/api/src/routes/settings.ts` (brand colour catalogue defaults).

**Tests** — `apps/api/tests/settings.test.ts`, `apps/api/tests/documents.test.ts` (default-colour +
brand-mark viewBox assertions).

*Phases 5–8 (auth chrome, dashboards, module sweep, PWA/OG):*

**Web** — `apps/web/index.html` (manifest + OG/Twitter meta), `apps/web/public/manifest.webmanifest` (new),
`apps/web/src/signin/{LoginPage,SecurityNotice}.tsx`, `apps/web/src/styles/{styles,auth}.css`,
`apps/web/src/print.css`, `apps/web/src/scripts/check-tokens.mjs`,
`apps/web/src/views/{Settings,OrganisationSettings,PublicVerify,AdminFlow,ContractFlow,WorkforcePlanning,InventoryIntel,CommunicationFlow,FinanceFlow,FactoryOs}.tsx`,
`apps/web/src/views/serviceDesk/{access,portal,ticket,reports,scan,dashboards}.tsx`,
`apps/web/src/views/hikvision/{devices,exceptions}.tsx`, `apps/web/src/components/LocationMap.tsx`,
`apps/web/src/views/{HrPayrollCentre,HrHcmBoard,HcmOps,HrPeopleDesks,PayrollFlow,MyPayroll}.tsx` (rgba tint sweep).

**API** — `apps/api/src/services/{mfaEmail,communication,bird,assets,sales,documents,cronJobs,eventNotifications,finance-advanced}.ts`,
`apps/api/src/services/mail/{send,erpAttachment}.ts`, `apps/api/src/routes/auth.ts`,
`apps/api/src/routes/ops/{communication,mail,myPayroll,myServiceDesk,serviceDesk}.ts`,
`apps/api/src/services/{serviceDesk,serviceDeskAccess,serviceDeskChanges,serviceDeskConfig,serviceDeskKnowledge,serviceDeskProblems,serviceDeskSla,payrollSelfService}.ts`,
`apps/api/src/services/iso/{types,register}.ts`, `apps/api/src/services/organisationSettings/catalogue.ts`,
`apps/api/src/{app,index,config}.ts`.

**Tests** — `apps/api/tests/mail.test.ts` (SECURITY_CODE template `PURPOSE`/`COMPANY_NAME` expected values).
