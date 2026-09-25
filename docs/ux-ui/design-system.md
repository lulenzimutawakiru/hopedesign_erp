# Design System

**Status:** tokens are **centralised and verified**; a small number of gaps are
recorded below as deviations. Nothing in this document is aspirational.

---

## 1. Where the tokens live

All design tokens are declared once, in `apps/web/src/tokens.css` (**98 lines,
81 declarations**). That file is imported **first** in `main.tsx`, ahead of
`styles.css`, so every `var(--token)` in the stylesheet resolves against it.
Views and components reference `var(--token)`; they do not inline hex values for
brand or state colour.

### 1.1 Brand and structure

| Token | Value | Use |
| --- | --- | --- |
| `--navy` | `#0B1F33` | Structural UI: rail, topbar, deep headings |
| `--hope` | `#1261A0` | Primary brand / default action |
| `--hope-hover` | `#0E4F83` | Primary hover |
| `--steel` | `#2E7DB2` | Secondary accent |
| `--teal` | `#00A6A6` | Tertiary accent, informational emphasis |

### 1.2 Semantic states

| Token | Value | Meaning |
| --- | --- | --- |
| `--success` | `#168A5B` | Completed, approved, posted, passed |
| `--warning` | `#D99A00` | Pending, attention, low |
| `--danger` | `#C93636` | Failed, rejected, damaged |
| `--critical` | `#B42318` | Critical / locked |
| `--info` | `#2878D0` | Neutral informational |
| `--secure` | `#A52A2A` | Security-printing classification |

### 1.3 Surfaces, text, borders

`--paper` `--paper-2` `--sheet` (page / muted / card) · `--ink` `--ink-soft`
`--muted` `--muted-2` (primary / secondary / muted / disabled text) ·
`--line` `--line-strong` (subtle / strong borders) · `--rail` `--rail-text`
`--rail-dim` (navigation rail).

### 1.4 Domain hues

The system carries a **module hue per business domain**, used for the module
kicker and module chrome, so that a user can tell at a glance which part of the
ERP they are in:

`--mod-exec | crm | sales | proc | inv | wh | mfg | qc | sec | mnt | log | fin | hr | ast | rpt | adm`

It also carries a **state ramp** used by status chips:
`--st-draft | pending | progress | ok | reject | hold` — plus, for the tones that
need a tinted surface, the paired background/foreground tokens
**`--st-ok-bg` (`#E3F3EB`) / `--st-ok-fg` (`#0F4A32`)**.

### 1.5 Elevation, geometry, type

`--shadow`, `--shadow-lg` · **radius scale** `--radius-sm: 6px` ·
`--radius-md: 10px` · `--radius-lg: 16px` · `--radius-pill: 999px` ·
legacy `--radius: 10px` (kept, equal to `--radius-md`) ·
**space scale** `--space-1..8` = `4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 px` ·
`--font 'Outfit'` (UI) · `--serif 'Source Serif 4'` (documents) ·
`--mono 'IBM Plex Mono'` (identifiers, money, codes).

Legacy aliases (`--bg`, `--panel`, `--text`, `--border`, `--primary`,
`--primary-dark`, `--sidebar-*`) are retained so that older views keep working.

---

## 2. Recorded gaps

Two of the three gaps originally recorded here have since been **closed** when
tokens were extracted into `tokens.css`. One remains open.

1. ~~No `--space-N` scale~~ — **closed.** `--space-1..8` now exist
   (`4/8/12/16/20/24/32/48px`). Migrating literal spacing to the scale is still
   **incremental, per component**; a literal `gap: 12px` is not a defect by
   itself.
2. ~~No radius scale~~ — **closed.** `--radius-sm/md/lg/pill` now exist, and
   `--radius: 10px` is retained as the legacy alias for `--radius-md`.
3. **No breakpoint tokens in CSS.** Measured: **16 distinct `max-width` values**
   across **59 `@media` blocks** (`560, 639, 640, 720, 760, 767, 860, 900, 960,
   980, 1023, 1080, 1100, 1200, 1279, 1535`) and only **1 distinct `min-width`**
   (`1080`). The JS breakpoint scale in `nav.ts` `breakpointOf()` is the intended
   6-point contract; CSS predates it. See `responsive.md`.
   - An earlier revision of this table reported **32 max-width values across 60
     blocks**. That figure double-counted repeated values and is superseded by
     the measurement above.

> Do **not** rename existing tokens. Downstream code, including print layouts,
> depends on them; `tokens.css` opens with a header comment stating the same rule.

---

## 3. CSS architecture

The brief proposes splitting `styles.css` into ten files. **This was not done
wholesale, and should not be done in one step.** Measured reality: a single
**7,003-line** stylesheet with the token block extracted and sections appended
chronologically.

Reasons not to split it now:

- the stylesheet has **order-dependent cascade**. Measured: **2,569 distinct
  selectors, of which 204 appear in more than one rule** — 204 selectors whose
  winner is decided by source order rather than specificity. Worst offenders
  repeat four times: `.login-page` (L24, L889, L967, L1406), `.work-hero` (L477,
  L944, L1377, L3713), `.kpi-grid` (L457, L1367, L1380, L1407), `.com-msg-layout`
  (L3788, L3888, L3910, L3924), `.cmd-open` (L310, L972, L1400, L1416). Naive file
  splitting changes load order and therefore rendering.
  - Caveat: the census counts duplicates inside `@media` blocks alongside
    top-level ones (the `L1365–1424` cluster is a single media block), so **204 is
    an upper bound** on true cascade collisions — but the order-dependence it
    measures is real and measurable.
- a split with no visual regression suite cannot be verified (§11.13 — no visual
  testing tooling ran in this effort);
- the build emits a **278,899 B CSS chunk** (`index-*.css`) plus one route-level
  `OrganisationSettings-*.css` at 15,607 B; splitting the source does not reduce
  either figure.

**Approved incremental path** (when a visual test harness exists):

1. ~~Extract `tokens.css` and load it first~~ — **DONE.** 98 lines / 81
   declarations, imported before `styles.css` in `main.tsx`. A pure move, zero
   cascade risk.
2. ~~Extract `print.css` from the `@media print` block~~ — **DONE.**
   `styles.css` now contains **0** `@media print` blocks; `print.css` (9 lines,
   363 B) is imported **last** on purpose, so print overrides win.
3. Split by *feature*, not by *element type*: pull a feature's rules out only when
   that feature's view is being refactored anyway, and load the pulled file at the
   same cascade position. **Not started.**

Splitting by element type (`tables.css`, `forms.css`) is explicitly rejected: it
fragments one component's rules across files and makes specificity debugging worse.

---

## 4. Status language (§18, §72)

Status is **not** one field. Screens separate the independent business axes:

    Business State   POSTED
    Approval State   APPROVED
    Payment State    PARTIALLY PAID
    Fiscal State     FISCALIZED
    Collection       OVERDUE

Rendering rules:

- Use **`<Badge value={...} />`** from `components/ui.tsx` for any enum value.
  It maps 10 semantic kinds to 9 tones via `statusMeta()` and never renders a
  bare colour — every badge carries **an icon glyph and a text label**, satisfying
  §120 (never colour alone).
- Never write a bespoke `<span className="badge ...">` for a status that the
  registry already knows.
- Never invent a status string the backend does not return.

`statusMeta()` covers the vocabulary in use across the ERP. Values it does **not**
recognise degrade to a neutral `●` badge rather than breaking — including
`MATERIALS_AUTHORIZED`, `MATERIALS_ISSUED`, `IN_PRODUCTION`, `QC`,
`RECONCILIATION`, `PACKAGING`, `IN_SECURE_STORAGE`.

> **Custody events are not statuses.** Render them with `eventLabel()` from
> `helpers.ts` inside a timeline, not with `<Badge>`. A custody event is a
> point-in-time fact with an actor and a timestamp, not a state.

---

## 5. Icons (§71)

Current reality, stated plainly: the codebase **still uses emoji glyphs inside
status badges** (`✓ ● ⚠ ✕ –`) and in a number of view headers. Full SVG icon
coverage was **not** implemented.

What is true today:

- the emoji in `statusMeta()` are **decorative reinforcement of a text label**,
  not the sole carrier of meaning — the badge always prints the word too, so the
  interface is not colour- or glyph-dependent;
- `.visually-hidden` exists (`styles.css:2490`) for screen-reader-only text.

What remains to do, in priority order:

1. replace header emoji with inline SVG;
2. keep the badge glyph but mark it `aria-hidden`, since the text label already
   carries the state;
3. introduce one icon component with a single `currentColor` contract.

---

## 6. Known defects to fix before extending the system

| Defect | Location | Status |
| --- | --- | --- |
| `.timeline` defined **twice** | was L897–901 / L1549–1557 | **Fixed** — one rule remains, `styles.css:822` |
| `.section-title` defined twice | was L930 / L4323 | **Fixed** — one rule remains, `styles.css:4254` |
| `.timeline-body` has no CSS rule | referenced by 5 views | **Fixed** — rule exists at `styles.css:825` |
| `.kv` has no CSS rule | used as a wrapper in markup | **Fixed** — rule exists at `styles.css:4250` (`min-width: 0`) |
| `.pipeline-step.done` uses light-only literal `#E3F3EB` | was L879 | **Fixed** — now `background: var(--st-ok-bg); color: var(--st-ok-fg);` (`styles.css:804`), dark override at L1073 |
| `.pipeline` / `.pipeline-step` / `.pipeline-dot` "dead CSS" | L796–806 | **Not a defect — do not delete.** `.pipeline-step` and `.pipeline-dot` each have **5 live consumer files** (`PayrollFlow`, `ProcurementFlow`, `SalesFlow`, `SpendFlow`, `WorkOrderWizard`) |
| Remaining green literals in `styles.css` | `#E3F3EB` ×8, `#E6F4EE` ×8, `#E9F7EF` ×1 | **Open** — tokenise **in place** when the owning view is next touched |

Fix the remaining item **in place, one at a time**, when the owning view is next
touched.

---

## 7. Adding to the system

Before adding a class or a colour:

1. Is there an existing primitive? Check `components/ui.tsx`, `components/os.tsx`,
   `components/states.tsx` first — the component library is small and deliberate.
2. Is the value brand or semantic? If yes, use a `var(--token)`. If a token does
   not exist, **add the token**, do not inline the hex.
3. Is it a status? Use `<Badge>`.
4. Is it a one-off layout tweak? Keep it in the view's existing CSS section rather
   than inventing a global class.