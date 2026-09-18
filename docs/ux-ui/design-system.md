# Design System

**Status:** tokens are **centralised and verified**; a small number of gaps are
recorded below as deviations. Nothing in this document is aspirational.

---

## 1. Where the tokens live

All design tokens are declared once, in the `:root` block of
`apps/web/src/styles.css` (L6–L79, **67 declarations**). Views and components
reference `var(--token)`; they do not inline hex values for brand or state colour.

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
`--st-draft | pending | progress | ok | reject | hold`.

### 1.5 Elevation, geometry, type

`--shadow`, `--shadow-lg`, `--radius: 10px` ·
`--font 'Outfit'` (UI) · `--serif 'Source Serif 4'` (documents) ·
`--mono 'IBM Plex Mono'` (identifiers, money, codes).

Legacy aliases (`--bg`, `--panel`, `--text`, `--border`, `--primary`,
`--primary-dark`, `--sidebar-*`) are retained so that older views keep working.

---

## 2. Recorded gaps (§8 deviation)

The brief asks for a full token surface. Three items are **deliberately not added
yet**, because renaming or extending the scale touches 7,070 lines of CSS and
would be a visual-regression risk bundled with behaviour work:

1. **No `--space-N` scale.** Measured: **0** spacing tokens. Spacing is literal
   (`gap: 12px`, `padding: 14px 16px`). Recommendation: introduce
   `--space-1..8` and migrate **incrementally, per component**, never globally.
2. **No radius scale.** `--radius: 10px` is a single value; there is no
   `--radius-sm/md/lg`. Adding one without migrating call sites creates a
   token that nothing reads.
3. **No breakpoint tokens in CSS.** Measured: **32 distinct `max-width` values**
   across 60 `@media` blocks (`26, 110, 120, 130, 160, 200, 240, 280, 320, 360,
   420, 480, 520, 560, 639, 640, 720, 760, 767, 860, 900, 960, 980, 1023, 1080,
   1100, 1180, 1200, 1279, 1280, 1535`). The JS breakpoint scale in
   `nav.ts` `breakpointOf()` is the intended 6-point contract; CSS predates it.
   See `responsive.md`.

> Do **not** rename existing tokens. Downstream code, including print layouts,
> depends on them.

---

## 3. CSS architecture (§9 deviation)

The brief proposes splitting `styles.css` into ten files. **This was not done,
and should not be done in one step.** Measured reality: a single 7,070-line
stylesheet with a token block at the top and sections appended chronologically.

Reasons not to split now:

- the stylesheet has **order-dependent cascade** — later sections override earlier
  ones for the same class (for example `.timeline` is defined twice, see §6);
  naive file splitting changes load order and therefore rendering;
- a split with no visual regression suite cannot be verified (§11.13 — no visual
  testing tooling ran in this effort);
- the build already emits **one 268.93 kB CSS chunk (45.44 kB gzip)**; splitting
  the source does not reduce that.

**Approved incremental path** (when a visual test harness exists):

1. Extract `tokens.css` (L6–L79) and load it first — a pure move, zero cascade risk.
2. Extract `print.css` from the single `@media print` block (L6159+).
3. Split by *feature*, not by *element type*: pull a feature's rules out only when
   that feature's view is being refactored anyway, and load the pulled file at the
   same cascade position.

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
- `.visually-hidden` exists (L2560) for screen-reader-only text.

What remains to do, in priority order:

1. replace header emoji with inline SVG;
2. keep the badge glyph but mark it `aria-hidden`, since the text label already
   carries the state;
3. introduce one icon component with a single `currentColor` contract.

---

## 6. Known defects to fix before extending the system

| Defect | Location | Impact |
| --- | --- | --- |
| `.timeline` defined **twice** | L897–901 (working) and L1549–1557 (unused) | The second definition is dead but wins by cascade for any future user |
| `.section-title` defined twice | L930 and L4323 | Same class, two rule sets |
| `.pipeline` / `.pipeline-step` / `.pipeline-dot` | L871–881 | **0 TSX users** — dead CSS |
| `.pipeline-step.done` | L879 | Uses a light-only literal `#E3F3EB` instead of a token |
| `.timeline-body` | referenced by 5 views | **No CSS rule exists** |
| `.kv` | used as a wrapper in markup | **No CSS rule exists** (the children `.kv-k`/`.kv-v` are styled) |

Fix these **in place, one at a time**, when the owning view is next touched.

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
