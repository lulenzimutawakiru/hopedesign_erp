# PDF Export — Modernization Assessment & Plan

**Branch:** `feature/pdf-export-modernization`
**Scope:** visual formatting / typography / brand consistency of every exported PDF.
**Invariants preserved:** business logic, financial calculations, EFRIS output, API contracts,
DB records, auth/authz, and the dependency-free PDF writer's glyph-metric system.

---

## 1. Assessment (2026-11-05)

Every exported PDF already flows through one of **two** shared renderers — there is no ad-hoc
or unbranded PDF path:

| Path | Renderer | Document types |
|---|---|---|
| Business documents | `services/documents.ts` → `renderDocument('pdf', …)` | sales invoice / quotation, purchase order, receipt, credit note, delivery note, expense, budget, payslip, employment contract, certificate of service, ID card, asset labels |
| Table exports / reports | `services/brandedExport.ts` → `renderTablePdf(…)` | customer/stock/finance exports, management reports, requisitions, scheduled report emails |

Both paths draw the **same** branded chrome from `services/brandedExport.ts`:
`drawTopBar` (navy + teal rule), `drawLetterhead` (mark + identity + tagline + doc identity +
status pill + double rule), `drawRunningHeader` (continuation pages), `drawFacts`
(2–4 column metadata grid), `drawParties`, `PdfDoc.table()`, `drawTotals`, section bands
(`drawContractBand`), notices, signatures, `drawAuthenticityBlock` (QR + fingerprint), the
`PdfDoc.footer()` (logo + double rule + page counter) and `PdfDoc.watermark()`.

The palette, letterhead, footer and watermark were already recoloured to the Natex Cloud brand
(navy `#101D35` / teal `#13C8E8`) during the rebrand (phases 3 of `NATEX_CLOUD_REBRAND_PLAN.md`),
so the colour identity is in place.

### Findings

1. **The data table was the one unbranded surface.** Every sibling box — facts, parties,
   totals, payslip breakdown, authenticity panel, notices — carries a 2.6 pt teal left-accent
   bar and/or a teal rule. `PdfDoc.table()` (the line-items table on invoices/POs/receipts,
   the report table, the PAYE-bracket table, the contract schedule) had a plain navy header
   with **no** accent, so the largest branded surface on a document read as a slightly
   different system. *(Fixed in Phase 1.)*
2. **Typography is the remaining legacy element.** The writer renders standard-14
   **Helvetica** (WinAnsiEncoding, hard-coded Adobe core advance widths — see
   `services/pdf.ts` `ASCII_*`/`LATIN1_*` tables). Helvetica is functional but is the clearest
   remaining "1980s standard" signal. A modern embedded face (Inter or a humanist sans) is the
   single highest-impact further modernisation, but it requires a binary font asset + a rebuilt
   advance-width table and carries real layout risk (see Phase 2).

---

## 2. Phases

### Phase 1 — bring the data table into the brand accent system ✅ done

- Added `accent?: Rgb` to `PdfTableOptions`; when set, `PdfDoc.table()` paints a 2.6 pt
  left-accent bar and a 0.7 pt underline on the header — identical to the motif already used
  by `drawFacts` / `drawParties` / `drawTotals` / the authenticity panel.
- Threaded `accent: brand.teal` through all four `PdfDoc.table()` call sites:
  - `documents.ts` — generic document line-items table
  - `documents.ts` — payslip PAYE-bracket table
  - `documents.ts` — contract "Schedule A" table
  - `brandedExport.ts` — `renderTablePdf` table
- Additive and text-preserving: no text, column widths, wrapping or page-break geometry
  changes. Verified by `tsc --noEmit` (clean) and by rendering sample invoice/report PDFs and
  confirming the new `0.07 0.78 0.91 rg … 2.6 … re f` / `0.7 w … RG … l S` ops land at the
  table header baseline.

### Phase 2 — font upgrade (deferred, recommended follow-up)

Replace Helvetica with an embedded modern sans. **Not done in this pass** because it is
large and high-risk rather than incremental:

1. Source a TTF (Inter, matching the web app's UI face) and embed it as a `/TrueType` font
   with `/FontDescriptor`, a `/ToUnicode` CMap and a `/Widths` array.
2. Rebuild `textWidth()` / `byteWidth()` from the new font's `hmtx`+`cmap` tables. These
   metrics drive wrapping, shrink-to-fit, pill centring and table column sizing across every
   document, so an error here breaks layouts subtly — this is the part that must be done with
   care and covered by the existing `documents.test.ts` / `exports.test.ts` assertions.

**Decision needed:** whether to take on the font asset + metric rebuild now, and whether the
brand accepts Inter (the UI face) or a print-oriented humanist sans. This is a product/brand
call, not a code-level default.

---

## 3. Files changed (Phase 1)

- `apps/api/src/services/pdf.ts` — `PdfTableOptions.accent` + header accent painting in `table()`.
- `apps/api/src/services/brandedExport.ts` — pass `accent: brand.teal` in `renderTablePdf`.
- `apps/api/src/services/documents.ts` — pass `accent: brand.teal` in the three `PdfDoc.table()` sites.

## 4. Standing rules (unchanged)

- No destructive migrations; additive, reviewable files only.
- Preserve DB/history, auth/authz, API contracts, business logic, EFRIS, payroll, permissions.
- Do not introduce dependencies without a documented assessment (Phase 2's font embedding is
  deliberately deferred on this basis).
- Do not merge to `main` without explicit review/approval.
