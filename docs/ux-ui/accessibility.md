# Accessibility

Target: **WCAG 2.2 AA**. This document records what is genuinely implemented,
what is missing, and the verification protocol that has and has not been run.

Companion documents: `design-system.md` (§18/§72 status language),
`component-library.md` (component contracts), `responsive.md` (touch targets),
`testing.md` (how to verify).

---

## 1. Honest status statement (§11.13)

> **No automated or manual accessibility audit has ever been run against this
> application.** There is no `axe`, no Lighthouse CI, no `eslint-plugin-jsx-a11y`,
> no screen-reader pass, and no keyboard-only pass recorded in the repository.
> **There is also no lint gate at all** (`apps/web/package.json` has no `lint`
> script), so a11y lint rules could not fire even if configured.

Every claim in §2 below is a **source-level inspection result**, not a test
result. Section §4 lists what that means for the §143 report: the accessibility
acceptance criterion is **partially met and unverified**, and must not be
reported as passing.

---

## 2. What is genuinely implemented (source-verified)

Counts are occurrences across `apps/web/src/**/*.{ts,tsx}`.

| Signal | Count | Assessment |
| --- | --- | --- |
| `aria-label` | **232** | Good baseline coverage on icon-only controls |
| `aria-hidden` | **292** | Decorative glyphs correctly hidden |
| `aria-sort` | **113** | See §2.1 — real and correct |
| `aria-live` | **28** | See §2.2 |
| `aria-expanded` | **27** | Disclosure controls announce state |
| `scope="col"` | **25** | Partial — see §2.3 |
| `<th` | **1,427** | Native table semantics retained |
| `onKeyDown` | **40** | Keyboard handling exists but is localised |
| `aria-current` | **13** | Active nav/step marking |
| `tabIndex` | **10** | Low; see §3.4 |
| `role="dialog"` | **7** | Incl. `Drawer` |
| `role="alert"` | **7** | Incl. `ErrorBanner`, `ErrorState` |
| `role="alertdialog"` | **1** | `ConfirmDialog` |
| `aria-valuenow` | **3** | `Meter` |
| `aria-labelledby` | **2** | Low |
| `alt=` | **18** | Images are largely icon-font/SVG; see §3.5 |
| `<caption` | **2** | Low — see §2.3 |
| **`aria-describedby`** | **0** | ⚠️ **Errors are never programmatically associated with fields** — see §3.1 |
| **`focus()`** | **0** | ⚠️ **No focus management anywhere** — see §3.2 |
| **`prefers-reduced-motion`** | **0 in TSX** | Handled in CSS only — see §2.4 |

### 2.1 `aria-sort` (113) — real and correct

Distribution: `FinanceFlow.tsx` 107, `AssetsFlow.tsx` 5, `DataTable.tsx` 1.

The `DataTable` implementation is the canonical form
(`apps/web/src/components/DataTable.tsx` L293):

```tsx
<th
  key={c}
  style={widths[c] ? { width: widths[c], minWidth: widths[c] } : { minWidth: 96 }}
  aria-sort={sortCol === c ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
>
```

`undefined` (rather than `"none"`) is the correct choice for a non-sorted
column, and the value is only emitted for the active column. **§70's
`aria-sort` requirement is met on the surfaces that were rebuilt.**

### 2.2 `aria-live` (28) — present, unevenly

`FinanceFlow.tsx` carries 21 of the 28. `toast.tsx` carries 1, which is the
important one: the toast region is a live region, so success/failure
announcements reach assistive technology without a focus move.

Because toasts are the primary completion feedback for most actions
(§118), this single live region does a lot of work. Any new surface that
reports completion **outside** a toast must supply its own live region.

### 2.3 Table semantics (§70)

Native `<table>` is retained throughout — **473 `<table>` occurrences**,
against only 8 `<DataTable>` occurrences. This is the correct default: §69
requires that ordinary tabular data use native table semantics, and that grid
semantics be reserved for cases where cell-level keyboard interaction is
genuinely required. **The codebase does not use `role="grid"` as a substitute
for `<table>`.**

Two gaps:

- `scope="col"` appears only **25 times against 1,427 `<th>`**. Header
  association therefore relies on the implicit-<th>-in-<thead> heuristic, which
  works in practice for simple tables but is fragile once a table has a
  two-row header, a row-header column, or a `colspan`.
- `<caption>` appears **only twice**, so most tables have no programmatic
  accessible name. Where a table is the sole content of a region, the
  surrounding heading is the practical substitute; where it is not, the table
  is effectively unnamed.

**Requirement:** every sortable column must expose sort state (met via
`aria-sort`), and every `<th>` in a rebuilt surface should carry
`scope="col"` (or `scope="row"` for row headers).

### 2.4 Reduced motion (§119)

`styles.css` contains **3** `@media (prefers-reduced-motion: reduce)` blocks,
at L1142, L4675 and L6523. The L1142 block is the blunt global:

```css
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
```

The `!important` global is a defensible choice for an operations application:
it guarantees the preference is honoured regardless of which feature
stylesheet wins a specificity fight. **§119 is met.**

No TSX reads the media query, so no JS-driven motion (e.g. a timeline that
animates progress) currently bypasses the CSS rule — there is none to bypass.

### 2.5 Focus visibility (§124)

Global rule at `styles.css` L1207–1209:

```css
:focus-visible { outline: 2px solid var(--hope); outline-offset: 2px; }
```

Plus targeted `:focus-visible` rules for the controls that would otherwise
lose the ring to a background change, including L2723
(`.btn, .tab, .chip, .cstep, .kpi-tile, .link-btn`), L665 (`.type-card`),
L798 (`.picker-clear`), L1312/L1321 (module-nav), L1583/L1595 (finance match
cards), L2064 (`button.step`), L3049, L3106, L3120.

**A visible focus indicator exists.** What has not been verified is *focus
order* and *focus visibility on every interactive element in every view* — there
are 88 views and no automated check.

---

## 3. What is missing (source-verified)

### 3.1 `aria-describedby` = 0 ⇒ validation errors are not associated

This is the **single most impactful a11y defect in the codebase.**

Inline errors are rendered as sibling elements. A screen-reader user who tabs
into an invalid field hears the label and the value but **not the error**, and
nothing announces that the field is invalid.

Current pattern (representative):

```tsx
<input value={x} onChange={...} />
{x === '' && <div className="inline-error">Required</div>}
```

Required pattern:

```tsx
const errId = 'err-' + fieldId;
<input
  id={fieldId}
  value={x}
  onChange={...}
  aria-invalid={!!error}
  aria-describedby={error ? errId : undefined}
/>
{error && <div className="inline-error" id={errId} role="alert">{error}</div>}
```

§28 requires inline validation, field-level errors, a summary for long forms,
required indicators, business-rule messages and accessible errors. Of those,
**only the visual half is implemented.**

### 3.2 Focus management = 0

`focus()` appears **zero** times. Consequently:

- **No focus trap** in `Modal` or `Drawer`. Tab from the last control in a dialog
  escapes to the page behind it.
- **No focus restoration.** Closing a dialog (or `ConfirmDialog`) does not
  return focus to the control that opened it; focus falls to `<body>`.
- **No initial focus.** Opening a dialog does not move focus into it, so the
  first Tab may land behind an open overlay.

`autoFocus` appears **15** times, which moves focus into *some* dialogs — but
`autoFocus` on an arbitrary child is not a substitute for a trap and provides
no restoration.

§69 explicitly requires modal focus trapping and focus restoration.
**Both are unmet.**

### 3.3 `Modal` is not an accessible dialog

`components/ui.tsx` L133–158 — verified verbatim:

```tsx
<div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
  <div className="modal" style={wide ? { maxWidth: 960 } : undefined}>
    <div className="modal-head">
      <h3>{title}</h3>
      <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
    </div>
    <div className="modal-body">{children}</div>
    {footer && <div className="modal-foot">{footer}</div>}
  </div>
</div>
```

Missing: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at
the `<h3>`, an ESC handler, a focus trap, and focus restoration.

The inner `<div className="modal">` is a **plain div** — it has no role, so an
assistive-technology user receives no indication that a modal is open unless
they happen to notice the `aria-label="Close"` button.

**Contrast:** `Drawer` (`components/os.tsx` L56–74) does this correctly — it
has `role="dialog"`, `aria-label={title}`, and an ESC handler. `Modal` predates
it and was never updated. This is a **known asymmetry**, documented in
`component-library.md` §4, and the highest-value single fix available in the
component layer.

### 3.4 `tabIndex` = 10 — no roving-focus implementation

With 470 tables and 88 views, 10 `tabIndex` occurrences means there is no
roving-tabindex pattern. This is **acceptable** given §69's guidance: ordinary
tabular data uses native tables, and tab reaches each interactive cell child in
document order. Interactive grid behaviour (arrow-key cell navigation) is
reserved for cases that genuinely need it, and currently none is implemented —
which is a *consistent* position, not a defect, provided no surface claims grid
semantics it does not deliver.

### 3.5 Icons (§71)

- **No icon component exists.** There are 10 `svg` occurrences across the whole
  of `apps/web/src`, against 232 `aria-label`s — meaning most icon-bearing
  controls rely on a text glyph or emoji rather than an SVG system.
- **Emoji remain the primary production icon language** in the views
  (`design-system.md` records this as an open §71 gap).
- Where `Badge` renders a glyph it does so as **decorative reinforcement of a
  text label** — `ui.tsx` L63/L68 mark the glyph `aria-hidden` and the label is
  always present. **§120 is therefore met**: status is never communicated by
  colour or glyph alone.
- `alt=` appears only 18 times because the UI is largely glyph/SVG-based rather
  than image-based; the 18 that exist are on `StaffPhoto`/avatar surfaces.

### 3.6 Touch targets (§69)

One relevant rule exists — `styles.css` L515, inside
`@media (pointer: coarse)`:

```css
.link-btn { min-height: 44px; }
```

This covers `.link-btn` only. The 44 px minimum is **not** applied to `.btn`,
`.chip`, `.tab`, table row actions, or the icon-only `.modal-close` (which is
also the only focusable affordance in an unfocused `Modal`). See
`responsive.md` for the factory/warehouse large-target requirement (§49, §50),
which is the context where this matters most.

---

## 4. Keyboard contract (§124)

The navigation keyboard table is maintained in `navigation.md` §7. Summary of
what the shell supports today:

| Key | Behaviour |
| --- | --- |
| `Tab` / `Shift+Tab` | Native order; no trap inside `Modal` |
| `Enter` | Activates the focused control (native) |
| `Space` | Activates buttons (native) |
| `Escape` | Closes `Drawer`; closes `ConfirmDialog`-adjacent overlays by design **not**; closes `Modal` **not** |
| `Arrow keys` | Module-nav and picker menus; not implemented as grid navigation |
| **`Ctrl/Cmd+K`** | Command palette |
| `/` | Search focus |
| `g` sequences | Go-to shortcuts (9 letters, 5 chords) — advertised in the shell keyboard help panel |

Verified: `Escape` appears **10** times, `onKeyDown` **40** times.

**Gap:** `Modal` not responding to `Escape` is inconsistent with `Drawer`. A
user who learns that ESC closes overlays will be surprised by `Modal`. Either
add the handler or document the exception in the UI.

---

## 5. Semantic structure

- `ErrorState` (`components/states.tsx` L23–54) uses `role="alert"` with an
  `aria-hidden` mark, an `<h3>` title and a `<p className="muted">` message —
  **correct**: the alert is announced, the glyph is not read aloud, and the
  heading gives the region a name.
- `ErrorBanner` (`components/ui.tsx` L120) uses `role="alert"` and
  `aria-hidden` on its mark — **correct**.
- `ConfirmDialog` uses `role="alertdialog"` — **correct** for a blocking
  decision, though it lacks `aria-modal` and `aria-labelledby` (its title has a
  hardcoded `id="confirm-title"` that is never referenced).
- `PageLoader` (`ui.tsx` L96–98) uses `role="status"` + `aria-busy="true"` and
  a `.visually-hidden` label — **correct**; this is the pattern to copy.
- `Meter` (`os.tsx` L98–108) uses `role="progressbar"` with
  `aria-valuenow/min/max` — **correct**.
- `.visually-hidden` is defined at `styles.css` L2560 and used in
  `ui.tsx:97`, `FinanceFlow.tsx:4769`, `LeaveFlow.tsx:222`,
  `SecurityJobs.tsx:692`, `SecurityJobs.tsx:904`.

### 5.1 Heading order

No heading-order audit has been performed. With 88 views each emitting its own
`.mod-kicker` / `h1` / `h2` structure (141 `mod-kicker` usages across 37
views), heading order is a plausible failure area but is **unmeasured**.

---

## 6. Prioritised remediation plan

Ordered by impact per unit of risk. Items 1–3 are component-layer fixes that
benefit every view at once; they should precede further per-view work.

| # | Fix | Scope | Why first |
| --- | --- | --- | --- |
| 1 | `Modal`: add `role="dialog"` + `aria-modal` + `aria-labelledby` + ESC + focus trap + focus restoration | `components/ui.tsx` L133 | Every dialog in the app; ESC asymmetry with `Drawer` is also a UX inconsistency |
| 2 | `ConfirmDialog`: add `aria-modal` + `aria-labelledby` wiring, and decide ESC deliberately | `components/os.tsx` L8 | Blocking decisions are the highest-consequence dialogs |
| 3 | Field-level error association: `aria-invalid` + `aria-describedby` + `role="alert"` on `.inline-error` | shared form primitives | §28's accessible-errors requirement is entirely unmet today |
| 4 | `scope="col"` on `<th>` in rebuilt surfaces; `<caption>` where the table is standalone | `DataTable.tsx` + top tables | 25/1,427 is a latent failure for any complex header |
| 5 | Extend the `pointer: coarse` 44 px rule from `.link-btn` to all interactive controls | `styles.css` L515 | Factory/warehouse/glove use (§49, §50) |
| 6 | Introduce an SVG icon component and retire emoji as the primary icon language | §71 | Required for §71; also improves consistent `aria-hidden` handling |
| 7 | Add an a11y gate: `eslint-plugin-jsx-a11y` + `axe` in a test runner | tooling | Without a gate, every fix above regresses |

### 6.1 What must **not** be done

- **Do not convert ordinary tables to `role="grid"`** (§69). Native table
  semantics are correct for tabular data; grid semantics are reserved for
  genuine cell-level keyboard interaction, and adding them broadly would remove
  native table affordances that currently work.
- **Do not remove `aria-hidden` from decorative glyphs** to "improve" coverage;
  `Badge` relies on it so that the tone glyph is not read aloud before the
  label.
- **Do not announce state by colour** when adding new statuses (§120). Every
  status needs text and/or an accessible name.

---

## 7. Verification protocol

Because no audit has been run, the acceptance criterion in §143 for
accessibility is **partially met, unverified**. To close it:

1. **Keyboard-only pass** per §124: `Tab`, `Shift+Tab`, `Enter`, `Space`,
   `Escape`, arrow keys, `Ctrl/Cmd+K`, `/` — first on the shell and the five
   Phase-2 core-work surfaces, then on each rebuilt view.
2. **Focus verification**: after opening and closing every dialog type, confirm
   focus returns to the invoking control. Requires fix #1/#2 first.
3. **Screen-reader pass** (NVDA on Windows) over Dashboard, My Work, Approvals,
   a list, a detail, and a form.
4. **Automated scan** (`axe` or Lighthouse) per view at each of the five
   viewport widths in `responsive.md` §7, accepting that automated tooling
   cannot verify focus order or announcement quality.
5. **Contrast check** for every token pair in `design-system.md`, including the
   light-only literals flagged there (e.g. `.pipeline-step.done` `#E3F3EB`).
6. Record results in this document before claiming §69/§143 accessibility
   compliance.

None of the above has been performed. No screenshot, scan or report should be
presented as evidence that it has.
