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
4. **Application shell** — sidebar/header polish against new tokens (nav, breadcrumbs, theme).
5. **Authentication chrome** — finalise sign-in copy/visuals to the new identity.
6. **Dashboards** — KPI/chart consistency (no fabricated data; ERP-calculated only).
7. **Module-by-module** — sweep for hardcoded legacy colours/strings.
8. **PWA/manifest/OG** — manifest icons, meta, social previews.
9. **Accessibility + responsive** — WCAG 2.2 AA contrast on the new palette.
10. **Regression + security** — full typecheck/build/test; no destructive changes.

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
