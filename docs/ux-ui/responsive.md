# Responsive Design

How the HOPE DESIGN ERP adapts across desktop, laptop, tablet, phablet and
mobile, and specifically how the factory and warehouse modes differ from
ordinary responsive shrinkage.

Companion documents: `design-system.md` (spacing/radius gaps),
`accessibility.md` §3.6 (touch targets), `testing.md` §5 (the five widths to
test).

---

## 1. The two breakpoint systems

The application has **two independent breakpoint definitions** which happen to
agree at the important boundary but are maintained separately. Any change must
respect both.

### 1.1 The JS contract

`apps/web/src/nav.ts` L1057–1064 — the authoritative six-point scale:

```ts
export type Breakpoint = 'mobile' | 'phablet' | 'tablet' | 'laptop' | 'desktop' | 'wide';

export function breakpointOf(width: number): Breakpoint {
  if (width < 640)  return 'mobile';
  if (width < 768)  return 'phablet';
  if (width < 1024) return 'tablet';
  if (width < 1280) return 'laptop';
  if (width < 1536) return 'desktop';
  return 'wide';
}
```

| Range | `bp` |
| --- | --- |
| < 640 | `mobile` |
| 640–767 | `phablet` |
| 768–1023 | `tablet` |
| 1024–1279 | `laptop` |
| 1280–1535 | `desktop` |
| ≥ 1536 | `wide` |

Consumed by `useBreakpoint()` (`components/nav.tsx`).

### 1.2 The CSS reality

`styles.css` contains **59 `@media` blocks**. Of those, **53 are width-based**
and 6 are capability-based: **3 × `prefers-reduced-motion`** (L1077, L4613,
L6458), **1 × `(pointer: coarse)`** (L441), **1 × `(hover: none)`** (L4594)
and **1 × `(orientation: landscape) and (max-height: 520px)`** (L1422).

Across all of `apps/web/src` the totals are **68 blocks — 58 width, 10
non-width**. The four extra non-width blocks are three `print` queries
(`print.css`, `views/hikvision/shared.tsx`, `views/WorkforcePlanning.tsx`) and
one `prefers-reduced-motion` in `styles/auth.css`.

**16 distinct `max-width` values appear inside media queries:**

```
560  639  640  720  760  767  860  900  960  980  1023  1080  1100  1200  1279  1535
```

The most frequent widths are `640` (10 blocks) and `900` (10 blocks), then
`720` (6), `960` (6), `767` (4), `860` (3), `560`/`760`/`1023` (2 each) and
seven values used once each (`639`, `980`, `1080`, `1100`, `1200`, `1279`,
`1535`). That accounts for 52 of the 53 width blocks; the fifty-third is the
only **`min-width`** query in the file, `@media (min-width: 1080px)`.

> ⚠️ **Correction to an earlier count.** A prior summary recorded "32 distinct
> `max-width` values". The measured figure is **31 distinct `max-width`
> values in the whole file**, of which only **16 occur in media queries**. The
> other 15 are component-level `max-width` *properties* (e.g. `.page { max-width:
> 1280px }`), not breakpoints. Full property list: `26, 110, 120, 130, 160, 200,
> 240, 280, 320, 360, 420, 480, 520, 560, 639, 640, 720, 760, 767, 860, 900, 960,
> 980, 1023, 1080, 1100, 1180, 1200, 1279, 1280, 1535`.

> ⚠️ **A second correction.** The same earlier count also claimed
> `styles.css` has `1 × print`. It has none: `styles.css` contains **no
> `print` media query at all**. Printing is handled by `print.css` and by two
> component-level `print` blocks (`views/hikvision/shared.tsx`,
> `views/WorkforcePlanning.tsx`).

### 1.3 Where they agree, and where they do not

**They agree at the mobile boundary**, which is the one that matters most:

| Boundary | JS | CSS |
| --- | --- | --- |
| Sidebar becomes an overlay drawer | `compact` = `mobile` || `phablet` ⇒ `width < 768` | `@media (max-width: 767px)` ⇒ `width ≤ 767` |
| Mobile dock appears | same `compact` | `@media (max-width: 767px) { .mobile-dock { display: grid } }` |

Both resolve to "below 768". ✅

**They diverge elsewhere.** The CSS uses `900`, `960`, `980`, `1023`, `1080`,
`1100`, `1200`, `1279`, `1535` — values that exist in the JS scale only for
`1024`, `1280` and `1536`. So a layout can change at 900 px while the JS
`bp` value is still `tablet` (768–1023). This is tolerable because the JS
breakpoint drives *shell chrome* (rail collapse, dock, focus mode) while the CSS
breakpoints drive *content density* — but it means "which breakpoint are we in?"
has two answers, and the responsive contract in §4 must be read as
chrome-vs-content.

---

## 2. The shell's responsive behaviour

`apps/web/src/views/Shell.tsx` — verbatim:

```ts
const compact = bp === 'mobile' || bp === 'phablet';           // width < 768
const tablet  = bp === 'tablet'  || bp === 'laptop';           // width < 1280
const collapsed = prefs.sidebarCollapsed || tablet;
const focus = prefs.focusMode || isFocusPath(path)
              || (compact && (path === '/warehouse' || path.startsWith('/operator')));
```

| Behaviour | Trigger | Mechanism |
| --- | --- | --- |
| Sidebar collapses to a **72 px rail** | `tablet || prefs.sidebarCollapsed` i.e. width < 1280 unless the user expanded it | `.rail-collapsed` class (Shell L251) → CSS L1373 (base rail width L975) |
| Sidebar becomes an **overlay drawer** | `compact` + CSS `max-width: 767px` | `.sidebar.sidebar-open`, `margin-left: -252px` → `0` (CSS L1397–1398) |
| Drawer scrim | `sideOpen` state | `.sidebar-scrim` L1399 + Shell L273 |
| Hamburger | `compact` | `.menu-btn` L1400 (button Shell L278), `aria-label="Open navigation"` |
| **Mobile dock** (5 items) | CSS `max-width: 767px` | `MobileDock` (`components/nav.tsx` L498) |
| Focus mode auto-on | `compact` **and** path is `/warehouse` or `/operator*` | §49/§50 — the operator surfaces shed the shell entirely |
| Focus mode hides the dock | — | CSS L1270 `.app-shell.is-focus .mobile-dock { display: none }` |

### 2.1 Breakpoint class hook

The shell emits a class per breakpoint (Shell L251):

```tsx
<div className={`app-shell ${collapsed ? 'rail-collapsed' : ''} ${focus ? 'is-focus' : ''} bp-${bp}`}>
```

⚠️ **There is no CSS rule for `.bp-*`** anywhere in `styles.css`. The class is
emitted but unhooked. Treat it as a **test/debugging hook** (it lets a test
assert the resolved breakpoint from the DOM) rather than as a styling contract.
Do not add feature styles against it without intending to create a third
breakpoint system.

### 2.2 Mobile dock contents

`MobileDock` (`components/nav.tsx` L498–529) is a fixed five-slot bottom bar:

```
Home  ·  Work  ·  [Scan]  ·  Tasks  ·  More
```

- Buttons are **`min-height: 52px`** (CSS L1331–1335) — meets the 44 px target.
- `Tasks` carries a `count-badge` when `taskCount > 0`.
- `Scan` is the centre emphasis control (teal, `aria-label="Scan QR"`).
- Rendered glyphs (`⌂ ▣ ◉ ☑ ☰`) are `aria-hidden`; the labels are text. ✅ §120.
- `env(safe-area-inset-bottom)` padding is applied (CSS L1329) — correct for
  notched devices.
- The content region reserves space via
  `.app-shell:not(.is-focus) .content { padding-bottom: 108px; }` (CSS L1394).

**This matches §68's mobile priority list** (My Work, Approvals, QR Scan, Tasks,
Notifications, Quick Actions) with the exception that *Notifications* is reached
via the topbar bell rather than a dock slot.

---

## 3. Responsive table strategy (§126)

The mechanism is **progressive column disclosure**, not card conversion.

```css
/* styles.css L1344–1345 */
@media (max-width: 1023px) { .col-hide-md { display: none !important; } }
@media (max-width: 767px)  { .col-hide-sm { display: none !important; } }
```

Applied per `<th>`/`<td>` on wide registers (the comment names the asset
register as the motivating case).

**Assessment against §126:** on mobile the required survivors are *primary
identifier*, *status*, *important amount* and *primary action*. The mechanism
can express that, but **it is applied by hand on a per-table basis and there is
no enforcement** — a table that omits `col-hide-*` markers will simply
overflow or squash. §123 lists "broken tables" and horizontal overflow as
things to check; with **509 `<table>` occurrences** and only 4 `<DataTable>`
usages (across 3 files), that check is broad.

### 3.1 Horizontal overflow containment

Tables are wrapped in a **`.table-wrap` container**, defined once in
`styles.css` L642:

```css
.table-wrap { overflow-x: auto; }
```

That is the primary horizontal-overflow defence; `col-hide-*` above is the
secondary one. The wrapper is applied at ~500 call sites in `apps/web/src`,
and `DataTable` wraps its own table internally (`components/DataTable.tsx`
L288), so `<DataTable>` consumers get containment for free. `styles.css`
L1363 also gives `.table-wrap` a `transition: opacity 120ms ease` for the
refresh state (L1359 `.is-refreshing .table-wrap`).

Nine `<table>` sites remain deliberately unwrapped, all verified safe:

- `components/hrUi.tsx` L47 — a JSDoc comment, not markup.
- `views/CompliancePdpo.tsx` L1041, L1465, L2075, L2789, L3378 — `const table`
  React nodes rendered at L513 inside `<div className="table-wrap desktop-only">`.
- `views/hikvision/shared.tsx` L377, L397 — export HTML strings, not DOM.
- `views/LeaveFlow.tsx` L394 — `.cal-grid`, `width: 100%`, `table-layout: fixed`.
- `views/QrTrace.tsx` L341 — `.mini-table`, `width: 100%`.

### 3.2 Server-side table, client-side presentation

`DataTable`'s server mode changes *query* semantics (§20) but not *layout*; the
column-visibility and `col-hide-*` presentation rules remain the responsive
mechanism. `Pager` renders a rows-per-page `<select>` with
`aria-label="Rows per page"` (ui.tsx L195) at all widths.

---

## 4. The responsive contract (§67)

The brief requires **intentional layouts, not shrunken desktop pages**. The
current state per tier:

| Tier | Width | Shell | Content |
| --- | --- | --- | --- |
| **Desktop** | ≥ 1280 | Full sidebar, no dock | Dense information; `.page` capped at 1280 px |
| **Laptop** | 1024–1279 | **Rail collapsed** (72 px) | Full density, wider content region |
| **Tablet** | 768–1023 | Rail collapsed | Content rules at 900/960/980/1023 apply; `col-hide-md` active below 1024 |
| **Phablet** | 640–767 | **Overlay drawer + dock** | `col-hide-sm` active; single-column KPI grid |
| **Mobile** | < 640 | Overlay drawer + dock; 639 block applies | `page-head h1` 22 px; single-column grids |

**Deviation from §67:** the brief asks for *"Tablet → simplified navigation"*.
Today, tablet keeps the same collapsed rail as laptop — navigation is
*compressed*, not *simplified*. Simplifying it (e.g. module-switcher instead of
rail) is a design change that has not been made.

---

## 5. Orientation, pointer and capability queries

Beyond width, the stylesheet reacts to four non-width conditions — six blocks
in total, since `prefers-reduced-motion` appears three times (§1.2). These are
the rules that actually tailor the operational modes:

| Query | Line | Effect |
| --- | --- | --- |
| `@media (pointer: coarse)` | **L441** | `.link-btn { min-height: 44px }` — a full-size hit target on touch devices without inflating desktop rows |
| `@media (hover: none)` | **L4594** | Suppresses hover-only affordances |
| `@media (orientation: landscape) and (max-height: 520px)` | **L1422** | Short-landscape handling (phone held sideways) |
| `@media (max-width: 960px) and (max-height: 540px)` | **L965–L970** | Short-viewport handling |

Plus, inside the mobile block:

```css
/* L1315–L1319 */
.sheet-backdrop { align-items: flex-end; padding: 0; }
.sheet-modal {
  max-width: none; width: 100%; border-radius: 16px 16px 0 0;
  max-height: 92vh;
}
/* L1320 */
.scan-actions .btn { min-height: 44px; }
```

Note that these rules are **free-standing**, not inside
`@media (max-width: 767px)` — they carry no width condition at all, so the
sheet layout applies at every viewport. The `.sheet-modal` rule is the
**bottom-sheet pattern** on small screens —
correct for §32's "very short forms" and for one-handed use.

### 5.1 Touch targets — honest status

The main interactive families are covered by the `@media (max-width: 1023px)`
block that opens at `styles.css` L1376:

- `.btn`, `.icon-btn`, `.nav-item`, `.tab` — `min-height: 44px` (L1383)
- `.chip`, `.modal-close` — `min-height: 44px` (L1384)
- `.modal-close` — `min-width: 44px` plus flex centring (L1385)

and by three **unconditional** rules that apply at every width:

- `.scan-actions .btn` — `min-height: 44px` (L1320)
- `.handheld-act` — `min-height: 52px` (L1313)
- `.mobile-dock button` — `min-height: 52px` (L1331–1335)

plus `.link-btn` under `(pointer: coarse)` — `min-height: 44px` (L441).

The width-gated rules are the caveat: they bite only **below 1024 px**, so a
coarse-pointer tablet wider than 1023 px falls back to the unconditional rules
only. Table row actions are the surface where that matters most for §49
(factory) and §50 (warehouse) — those are used with gloves, at arm's length,
on handheld devices.

---

## 6. Factory and warehouse modes (§49, §50)

These are **work modes, not breakpoints**. They are first-class and should not
be modelled as "mobile layout".

### 6.1 Auto-entry

Shell L110:

```ts
const focus = prefs.focusMode || isFocusPath(path)
              || (compact && (path === '/warehouse' || path.startsWith('/operator')));
```

So on a phone/phablet, navigating to `/warehouse` or `/operator*`
**automatically enters focus mode** — the shell chrome (sidebar, topbar
decoration, mobile dock) is removed and the operator gets the full viewport.
`isFocusPath` (`nav.ts` L920) is the explicit allow-list.

### 6.2 Requirements (§49, §50)

| Requirement | Status |
| --- | --- |
| Large controls | ⚠️ Guaranteed below 1024 px for `.btn`/`.icon-btn`/`.nav-item`/`.tab`/`.chip`/`.modal-close`; unconditional for `.link-btn` (coarse), `.scan-actions .btn`, `.handheld-act` and dock buttons |
| High readability | ⚠️ Not verified; no typography audit at operator viewing distance |
| Simple actions | ✅ Focus mode removes shell chrome; `OperatorFloor` / `WarehouseRoom` are purpose-built |
| Minimal typing | ✅ Scan-first by design |
| Touch interaction | ⚠️ See touch targets above |
| Handheld scanners | ✅ `QrScanner` supports camera + manual + handheld input |
| Clear state indicators | ✅ `Badge` + tone + text label (§120) |

### 6.3 Scan-first entry

The dock's centre `Scan` control and the topbar scanner button both open
`QrScanner`. §51 requires that operators **not** choose from a long action
dropdown on every scan — instead the mode is inferred from context. The
`QrScanner` routes by entity type; the reusable `entityHref` helper in
`views/QrTrace.tsx` is the intended resolver.

---

## 7. Verification protocol (§123)

Test each of the following viewports and record the result:

```
1440 × 900     desktop
1280 × 800     laptop / desktop boundary
1024 × 768     laptop / tablet boundary
768 × 1024     tablet portrait
390 × 844      mobile (modern phone)
```

At each width, check:

- [ ] no horizontal overflow
- [ ] no clipped dialogs (esp. `.sheet-modal` at < 768)
- [ ] no inaccessible buttons
- [ ] no overlapping headers
- [ ] no broken tables (columns not squashed; `col-hide-*` honoured)
- [ ] no unreadable text
- [ ] no broken navigation (rail / drawer / dock at the right boundary)
- [ ] mobile dock does not cover the last row of content
      (`padding-bottom: 108px` applied)
- [ ] focus mode entered correctly on `/warehouse` and `/operator*` at < 768

**No visual verification has been performed.** No screenshots exist. §11.13 of
the audit records this, and `testing.md` repeats it. Do not report the §123
criterion as met.

---

## 8. Known issues and open items

| # | Issue | Where |
| --- | --- | --- |
| 1 | Two breakpoint systems (JS 6-point vs CSS 16 max-width values) with no shared source | `nav.ts` L1057 vs `styles.css` |
| 2 | `.bp-*` class emitted with no CSS rule | Shell L251 |
| 3 | 44 px touch targets are width-gated (≤ 1023 px), so a wide coarse-pointer device is not covered | CSS L1383–L1385; unconditional: L441, L1313, L1320, L1331–1335 |
| 4 | Tablet gets *compressed* navigation, not *simplified* navigation (§67) | Shell L107–L108 |
| 5 | Column disclosure is opt-in per table; no enforcement across 509 tables | CSS L1344–L1345 |
| 6 | Dead CSS: bare `.approval-head` / `.approval-row` rules have 0 JSX usages | CSS L828, L832–L833, L947–L948 |
| 7 | Spacing tokens exist (`--space-1..8`, `tokens.css` L77–L84) but are consumed 0 times, so responsive spacing cannot be tuned centrally | see `design-system.md` |
| 8 | Radius tokens all exist (`--radius`, `-sm`, `-md`, `-lg`, `-pill` at `tokens.css` L71–L75) and are consumed 21 times; the earlier absent claim was wrong | see `design-system.md` |

Also worth recording: `table.data th` is declared twice — `position: relative`
at L1085 and `position: sticky; top: 0` at L2661. The later rule wins; this
predates the responsive work, but it makes the sticky header fragile to any
rule reordering.

Items 1 and 7 are the ones that most constrain future responsive work: they
mean a density change cannot be made in one place.
