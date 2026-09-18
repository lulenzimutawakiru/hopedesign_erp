# Testing, Verification & Quality Gates — HOPE DESIGN ERP

> Companion to `docs/ux-ui/architecture.md`, `design-system.md`, `navigation.md`,
> `component-library.md`, `workflow-ux.md`, `accessibility.md`, `responsive.md`.
> This is the **honest** record of what is actually verified, what is only
> inspected, and what has no gate at all. Read §2 before trusting any other
> document's claims.

**Repository:** `lulenzimutawakiru/hopedesign_erp`
**Document status:** verification of record for the UX/UI modernization effort
**Measured:** 2026-09-18 (Africa/Kampala)
**Scope:** root workspace + `apps/api` + `apps/web` + `packages/db`

---

## 1. Purpose

The modernization brief (§121–§127, §143) asks for a testing story covering:

| Brief | Requirement | Where addressed |
| --- | --- | --- |
| §121 | `npm test`, `npm run test:web`, `npm run build` must pass | §3 (measured), §9 (gap) |
| §122 | Frontend tests for nav, permissions, forms, tables, workflow, QR, responsive, states | §5 (target state) |
| §123 | Visual checks at five viewports | §6 (target state) |
| §124 | Keyboard protocol | §7 |
| §125 | Accessibility verification | §8 |
| §126 | Responsive table presentation | §6, §7 |
| §127 | Performance acceptance | §4.4, §10 |

This document separates three tiers of evidence, because conflating them is how
"it works" becomes untrue:

1. **EXECUTED** — a command was run and its output captured (§3).
2. **INSPECTED** — source was read and counted statically (§4).
3. **TARGET** — a checklist that describes the intended state and has **not**
   been executed against a running UI (§5–§8).

---

## 2. The one-paragraph honesty statement

> The **API test suite is real, extensive and green** (42 files / 380 tests, §3.1).
> The **production build is real and green** (§3.2). The **frontend has no test
> infrastructure whatsoever** — no test runner, no test script, no test files —
> so every UI-level claim in this documentation set (accessibility, responsive
> behaviour, keyboard support, visual consistency) rests on **static source
> inspection**, not on executed verification. No screenshot, no screen-reader
> pass, no keyboard pass and no viewport check has ever been performed against a
> running instance of this application. CI exists and is currently **red**
> because it runs a web test script that does not exist (§9).

Nothing in this document should be read as claiming observed runtime behaviour
that was not observed.

---

## 3. EXECUTED — commands run and captured

### 3.1 API test suite — **PASS (42 files / 380 tests)**

```
Command : npm.cmd test        (root -> npm run test -w apps/api -> vitest run)
Captured: cmd /c "npm.cmd test > C:\tmp\api-test.log 2>&1"
Runner  : apps/api/vitest.config.ts
          environment: node
          include: tests/**/*.test.ts
          testTimeout: 20000   hookTimeout: 30000
          fileParallelism: false        <-- strictly sequential
```

Final tally, verbatim from the captured log:

```
 Test Files  42 passed (42)
      Tests  380 passed (380)
   Start at  10:45:56
   Duration  884.02s (transform 10.70s, setup 0ms, collect 189.15s, tests 657.00s, environment 24ms, prepare 12.40s)
```

**Exit code:** `0`. **Zero failures, zero skipped files.**

The suite targets a **remote Supabase Postgres** instance resolved from the root
`.env` (`DATABASE_URL`). It is **not** a localhost database. This means:

* the suite is an **integration** suite, not a unit suite;
* a full run costs ~15 minutes wall clock (884 s measured);
* it cannot be run without network access to that database;
* `fileParallelism: false` is therefore load-bearing — it prevents cross-file
  fixture collisions on shared tables.

Baseline comparison: commit `01137b6` previously recorded **42 files / 380
tests passed**. The 2026-09-18 run reproduces that figure **exactly** — no
regression, no test removed, no test silently skipped during the modernization.

Representative green files (all captured in the log):

```
tests/pdpo.test.ts                        (44 tests)   35107ms
tests/serviceDesk.test.ts                 (26 tests)   54903ms
tests/finance.test.ts                     (15 tests)   41392ms
tests/equity.test.ts                      (25 tests)   13651ms
tests/kcb.test.ts                         (25 tests)   15772ms
tests/sales.test.ts                       (10 tests)   35448ms
tests/hr.test.ts                          (11 tests)   53014ms
tests/contracts.test.ts                    (6 tests)   28139ms
tests/documents.test.ts                    (7 tests)   20766ms
tests/auth.test.ts                        (22 tests)   42756ms
tests/organisationSettingsAcceptance.ts   (23 tests)    9637ms
tests/hcm.test.ts                          (1 test)    31094ms
tests/mes.test.ts                         (13 tests)   17232ms
```

**Control-integrity coverage (directly relevant to §131 / §133 / §134).** Three
files exist specifically to prove the security invariants the UX work was
forbidden to weaken, and all three passed:

| File | Tests | What it proves |
| --- | --- | --- |
| `tests/rbac.test.ts` | 5 | Deny-by-default: low-privilege user blocked from QR generation and CRM; admin allowed; unknown routes 404 |
| `tests/sod.test.ts` | 1 | Segregation of duties: a user cannot approve **their own** purchase order |
| `tests/security.test.ts` | 1 | Security-printing dual-control approval chain runs end to end |
| `tests/auth.test.ts` | 22 | Authentication/session behaviour |

This is the strongest available evidence that the frontend modernization did
**not** touch backend authorization.

### 3.2 Production build — **PASS (exit 0)**

```
Command : npm.cmd run build
Chain   : npm run build -w packages/db   (no-op / tsc)
          npm run build -w apps/api      (tsc)
          npm run build -w apps/web      (tsc --noEmit -p tsconfig.json && vite build)
Result  : ✓ built in 28.80s
          148 modules transformed
Exit    : 0
```

Because `apps/web`'s build script **first** runs `tsc --noEmit` under a
`strict` tsconfig with `noUnusedLocals` and `noUnusedParameters` (see §4.5),
a green build is a meaningful correctness signal: unused imports, unused
parameters, unsafe null handling and type mismatches all fail it. It is **not**
a substitute for behavioural tests.

Notable emitted chunks (post-modernization):

```
index-5kEHoauT.css            268.93 kB │ gzip  45.44 kB
HrFlow-DaY3HM8m.js            468.03 kB │ gzip  96.80 kB
FinanceFlow-WIqDPLDk.js       390.81 kB │ gzip  83.94 kB
Shell-6FjJRKMf.js             376.66 kB │ gzip 109.79 kB
ServiceDeskFlow-CoO6OwqM.js   336.85 kB │ gzip  82.41 kB
AssetsFlow-SG9jsGl8.js        272.29 kB │ gzip  54.34 kB
index-BTHkDY_L.js             177.47 kB │ gzip  57.70 kB
EntityList-1skMD1Wf.js          4.43 kB │ gzip   2.05 kB
```

`Shell-6FjJRKMf.js` is the largest **gzip** payload (109.79 kB) and sits on the
hot path — every authenticated route loads it. `HrFlow` is the largest raw
chunk (468.03 kB). Both are recorded as open performance items (§10).

### 3.3 Frontend test command — **FAIL (exit 1)**

```
Command : npm.cmd run test:web
Root    : "test:web": "npm run test -w apps/web"
```

Verbatim failure:

```
> hopedesign-erp@1.0.0 test:web
> npm run test -w apps/web

npm error workspace @hopedesign/web@1.0.0
npm error location C:\Users\user\Projects\HOPEDESIGN_ERP\apps\web
npm error Missing script: "test"

EXITCODE=1
```

**Root cause.** `apps/web/package.json` declares exactly four scripts:

```json
{ "dev": "vite", "build": "tsc --noEmit -p tsconfig.json && vite build",
  "preview": "vite preview", "typecheck": "tsc --noEmit -p tsconfig.json" }
```

There is no `test` script, and `apps/web` has **no test runner in any
dependency block** (`dependencies`: `jsqr`, `niimbot-web-bluetooth`, `react`,
`react-dom`; `devDependencies`: `@types/react`, `@types/react-dom`,
`@vitejs/plugin-react`, `typescript`, `vite`). No `vitest`, no `jest`, no
`@testing-library/*`, no `jsdom`.

This is **not** a regression introduced by the modernization. The script never
existed; the root-level `test:web` entry and the CI step that calls it are both
dead wiring. See §9.

### 3.4 Test-runner topology

The workspace deliberately scopes testing to the API:

```ts
// vitest.workspace.ts (root) — full file
export default ['apps/api/vitest.config.ts'];
```

Therefore a bare `npx vitest` from the root would run **API tests only**. This
is consistent, but it means there is no path by which web code is exercised.

### 3.5 Test-file census

```
apps/api/tests/**/*.test.ts         42 files   (matches "42 passed" exactly)
outside apps/api/tests               1 file    .codex-patches/index.test.ts
                                                 -> gitignored scratch, not part of the suite
apps/web                            0 files
```

---

## 4. INSPECTED — static evidence (not executed)

Everything below was produced by reading and counting source. It is reliable for
*"does this pattern appear in the code"* and unreliable for *"does this behave
correctly at runtime"*.

### 4.1 Verification method used during this effort

The working loop was deliberately cheap and reproducible:

1. `npm.cmd run typecheck` (~45–55 s) after each extraction.
2. `npm.cmd run build` after each meaningful batch (28.80 s end to end).
3. Compare `dist/assets/` chunk sizes before/after to detect accidental
   import creep (e.g. a lazy view pulled back into the shell graph).
4. Static censuses via PowerShell `Select-String` / scripted `node` walks for
   pattern counts (tables, ARIA attributes, `disabled=`, `prompt()`, etc.).

**What this loop cannot catch:** broken layouts, contrast failures, focus traps,
runtime null paths, wrong amounts, dead buttons that still typecheck, incorrect
workflow gating that is syntactically valid. Those require a browser.

### 4.2 Accessibility signal census

Counts across `apps/web/src/**/*.{ts,tsx}`:

| Signal | Count | Signal | Count |
| --- | --- | --- | --- |
| `aria-label` | 232 | `role="dialog"` | 7 |
| `aria-hidden` | 292 | `role="alert"` | 7 |
| `aria-sort` | 113 (FinanceFlow 107, AssetsFlow 5, DataTable 1) | `role="alertdialog"` | 1 |
| `aria-live` | 28 | `aria-valuenow` | 3 |
| `aria-expanded` | 27 | `aria-labelledby` | 2 |
| `scope="col"` | 25 | `<caption` | 2 |
| `aria-current` | 13 | **`aria-describedby`** | **0** |
| `tabIndex` | 10 | **`focus()`** | **0** |
| `autoFocus` | 15 | `prefers-reduced-motion` in TSX | **0** |
| `<th` | 1,427 | `alt=` | 18 |
| `<table` | 470 | `onKeyDown` | 40 |
| `svg` | 10 | `Escape` | 10 |

Two zeroes are load-bearing and are carried into §8 as blockers:

* **`aria-describedby` = 0** — no validation message in the application is
  programmatically associated with the field it describes. A screen-reader user
  is told *"invalid entry"* with no indication of why.
* **`focus()` = 0** — no dialog, drawer or route change programmatically moves
  or restores focus. Opening a modal leaves the caret behind it.

### 4.3 CSS / responsive landmarks

```
@media blocks          60   (width-based 54, capability 6)
capability queries          3 x prefers-reduced-motion, 1 x print, 1 x hover:none, 1 x pointer:coarse
media-query max-widths 16   (560, 639, 640, 720, 760, 767, 860, 900, 960, 980, 1023, 1080, 1100, 1200, 1279, 1535)
```

Breakpoint sets are inconsistent: 16 widths appear inside media queries while a
further 15 distinct `max-width` values exist as ordinary component properties.
There is no single source of truth for breakpoints. See `responsive.md`.

### 4.4 Code-size census (performance signal)

Largest view files by bytes:

```
FinanceFlow.tsx          452,199 B     <- largest single file in the repo
OrganisationSettings.tsx ~220.9 kB
ContractFlow.tsx         ~206.1 kB
ProcurementFlow.tsx      ~190.8 kB
CompliancePdpo.tsx       ~172.9 kB
HrFlow.tsx               ~158.3 kB
SpendFlow.tsx            ~123.5 kB
CommunicationFlow.tsx    ~116.7 kB
AssetDesk.tsx            ~116.0 kB
AdminFlow.tsx            ~113.9 kB
AssetLifecycle.tsx       ~109.3 kB
MmsViews.tsx             ~102.4 kB
```

Other structural facts:

```
views/                88 .tsx   (64 at root; subdirs hikvision/, serviceDesk/)
components/           14 .tsx
nav.ts             1,049 lines / 284 hrefs / 273 perm: / 14 groups
styles.css         7,070 lines / 332,206 B
<table>            470        vs   <DataTable>  8
disabled=          897        (of which only 13 carry an explanatory title=)
<PermissionGate>     0        <RoleGate>     0
window.prompt(        0   across apps/web/src
```

`470 : 8` is the single most important ratio in this document. The enterprise
table system described in §19–§22 of the brief exists but has been adopted by
**eight** call sites; the remaining tables are bespoke. `897 disabled=` against
`13` explanatory titles quantifies the §109 gap (buttons that are disabled
without telling the operator why).

### 4.5 Type-system guardrails

`apps/web/tsconfig.json` is genuinely strict:

```
strict: true            noUnusedLocals: true      noUnusedParameters: true
noFallthroughCasesInSwitch: true                  jsx: react-jsx
target: ES2020          moduleResolution: bundler  isolatedModules: true
types: ["vite/client"]  include: ["src"]
```

This is why the build is a useful gate. It is also why no `.tsx` file in the
repo has a silently-unused import.

---

## 5. TARGET STATE — §122 frontend test checklist

**Status: NOT IMPLEMENTED. No frontend test exists.** This is the specification
for what should be built *if and when* web test infrastructure is introduced. It
is reproduced here so the intent is not lost, not to imply coverage.

| # | Area | Required assertions |
| --- | --- | --- |
| 1 | Navigation | Active module/page state correct per route; breadcrumbs match hierarchy; collapsed/rail/drawer modes reachable |
| 2 | Permission visibility | A `can()`-false item is absent from nav; `Shell` route gate renders `AccessDenied`, not the page |
| 3 | Forms | Required indicators render; field-level error appears on submit; error is associated to its input |
| 4 | Validation | Business-rule violations surface as messages, never a browser `alert` |
| 5 | Tables | Header sort toggles `aria-sort`; server query string reflects `page/pageSize/q/sort/order` |
| 6 | Filters | Chips render; "clear all" resets URL state; filter set survives reload |
| 7 | Sorting | Sort is requested from the server, not applied client-side over a partial page |
| 8 | Workflow state | Timeline renders each stage with role/person/status/timestamp |
| 9 | Approval actions | Approve/Reject/Return appear **only** when permission + state + prerequisites hold |
| 10 | QR scanning | Camera, manual entry and handheld paths all route to a real backend verdict |
| 11 | Responsive | Table collapses to card presentation; primary action remains reachable |
| 12 | Loading | Skeleton/spinner appears; `role="status"` announces |
| 13 | Error | `ErrorState` renders with retry; message is human-readable |
| 14 | Empty | Contextual empty state with a working `action` |

Test-infrastructure prerequisite for all of the above: add a runner (vitest), a
DOM environment (jsdom or happy-dom), `@testing-library/react`, and a `test`
script in `apps/web/package.json`. **This was deliberately not done** — the
brief forbids adding tests to a codebase with no test infrastructure without
direction (§122 is a requirement list, and §142 forbids bundling unrelated
changes). See §9 for the recommendation.

---

## 6. TARGET STATE — §123 visual & responsive matrix

**Status: NOT PERFORMED. Zero screenshots exist for this effort.**

Viewports to check:

```
1440 x 900     desktop
1280 x 800     laptop
1024 x 768     tablet landscape
 768 x 1024    tablet portrait
 390 x 844     mobile
```

At each viewport, verify all ten:

1. No horizontal overflow (`document.scrollWidth <= innerWidth`).
2. No clipped dialogs (modal fully inside viewport, scrollable body).
3. No inaccessible buttons (every control reachable and hit-testable).
4. No overlapping headers (topbar does not occlude page header).
5. No broken tables (no column collapse into unreadable widths).
6. No unreadable text (contrast + no truncation mid-word).
7. No broken navigation (sidebar/dock/drawer all functional).
8. Touch targets >= 44x44 CSS px on `pointer: coarse`.
9. Sticky action bars do not cover the last table row.
10. Mobile dock does not overlap content (`padding-bottom` accounts for it).

§126 responsive-table rule — on mobile the following must remain visible, with
everything else moving to a card/detail view:

```
important columns
primary identifier
status
important amount
primary action
```

The CSS already contains the intended mechanics (`.col-hide-md`, `.col-hide-sm`,
`.mobile-dock`, `.scan-actions .btn { min-height: 44px }`, safe-area insets) but
**none of it has been observed in a browser.** See `responsive.md`.

---

## 7. §124 keyboard protocol — TARGET STATE

**Status: NOT PERFORMED.** No keyboard-only pass has been run.

Keys to verify per screen:

| Key | Expected |
| --- | --- |
| `Tab` | Moves forward through interactive elements in DOM order; never escapes into hidden content |
| `Shift+Tab` | Moves backward |
| `Enter` | Activates focused button/link; submits focused form where intended |
| `Space` | Activates focused button; toggles checkboxes |
| `Escape` | Closes the topmost overlay (dialog, drawer, palette, scanner, help, more-drawer, sidebar) |
| `Arrow keys` | Move within listbox/menu/tablist where a composite widget is declared |
| `Ctrl/Cmd+K` | Opens the unified search / command palette |
| `/` | Focuses search where offered |

Known wiring from inspection (unverified at runtime):

* `Shell.tsx` L116–119 binds `Escape` to close **scanner, command palette,
  help, more-drawer, sidebar and `g`-mode** in one handler.
* `components/os.tsx` `Drawer` binds `Escape`; `ConfirmDialog` **does not** —
  a keyboard user cannot dismiss a confirm dialog with `Esc` (see §8).
* `onKeyDown` appears 40 times across the web source.

Cross-reference: `navigation.md` §7, `accessibility.md` §4.

---

## 8. §125 accessibility verification — TARGET STATE + known blockers

**Status: NOT VERIFIED.** No automated axe/Lighthouse scan, and no
screen-reader session (NVDA / JAWS / VoiceOver), has been run.

Verification list to execute:

```
focus order            focus visibility       dialog focus containment
form labels            error association      table headers + scope
sort state (aria-sort) screen-reader names    keyboard-reachable actions
```

**Static blockers already identified — these will fail a real audit:**

| # | Blocker | Evidence | Owner |
| --- | --- | --- | --- |
| A1 | `Modal` (`components/ui.tsx` L133–158) is not an accessible dialog: no `role="dialog"`, no `aria-modal`, no `aria-labelledby`, no `Escape`, no focus trap, no focus restoration | source read | `components/ui.tsx` |
| A2 | `ConfirmDialog` (`components/os.tsx` L8) has `role="alertdialog"` but **no `aria-modal`, no `aria-labelledby`, no `Escape`**; hardcoded `id="confirm-reason"`/`id="confirm-title"` means only one can exist at a time; cancel label hardcoded to "Keep as-is" | source read | `components/os.tsx` |
| A3 | Validation errors are never associated with inputs — `aria-describedby` count = **0** | census §4.2 | app-wide |
| A4 | No focus management on overlay open/close — `focus()` count = **0** | census §4.2 | app-wide |
| A5 | Sort state not exposed on 470 bespoke tables; `aria-sort` appears 113x and 107 of those are in one file (`FinanceFlow.tsx`) | census §4.2 | app-wide |
| A6 | `scope="col"` on only 25 of 1,427 `<th>` (1.8%) | census §4.2 | app-wide |
| A7 | Two rules explicitly remove focus indication: `styles.css` L2889 `.org-search input:focus { outline: none }` and L2926 `.org-card-head:focus-visible { outline: none }` — these defeat the global `:focus-visible` rule at L1207–1209 | source read | `styles.css` |
| A8 | `prefers-reduced-motion` is honoured in CSS (3 sites) but **never in TSX** — JS-driven animation/auto-advance is unchecked | census §4.2 | app-wide |

Positive signals worth preserving:

* Global focus ring exists: `styles.css` L1207–1209 `:focus-visible { outline: 2px solid var(--hope); outline-offset: 2px }`.
* `PageLoader` (`components/ui.tsx` L87) is the **correct** pattern to copy —
  `role="status"` + `aria-busy="true"` + a `.visually-hidden` label.
* `ErrorState` (`components/states.tsx` L23) uses `role="alert"` with a
  `aria-hidden` mark, and `ErrorBanner` (`ui.tsx` L117) does the same.
* The toast region (`components/toast.tsx`) is an `aria-live` region and is the
  primary completion-announcement path.
* `.visually-hidden` is applied at 5 sites including the loader.

Full detail: `accessibility.md` §3.3, §4, §7.

---

## 9. THE CI GAP — concrete, actionable finding

This is the single highest-value, lowest-risk issue surfaced by this audit.

### 9.1 CI is red today

`.github/workflows/test.yml` runs on every PR and every push to `main`:

```yaml
      - name: Build database package
        run: npm run build -w packages/db
      - name: Run API tests
        run: npm run test -w apps/api
      - name: Run Web tests
        run: npm run test -w apps/web      # <-- ALWAYS FAILS: Missing script: "test"
```

The final step cannot succeed because `apps/web/package.json` has no `test`
script (§3.3). The job therefore fails on **every** pull request regardless of
the code under review. A permanently-red required check is worse than no check:
it trains reviewers to ignore CI, and it masks genuine failures in the two steps
that *do* work.

### 9.2 No lint gate anywhere

Searched the whole workspace: **no** `.eslintrc*`, **no** `eslint.config.*`,
**no** `.prettierrc*`, **no** `prettier.config.*`, and **no** `lint`/`format`
script in the root, `apps/api`, `apps/web` or `packages/db` `package.json`.
No workflow runs a linter. Style consistency across 88 view files currently
depends entirely on convention.

### 9.3 Recommendation (do not apply without direction)

Two acceptable resolutions for the web-test step, in preference order:

1. **Make the check real.** Add `vitest` + `jsdom`/`happy-dom` +
   `@testing-library/react` to `apps/web`, add
   `"test": "vitest run"` to `apps/web/package.json`, add a
   `vitest.config.ts` for the web workspace, and write the first tests
   (§5). Then the CI step becomes meaningful.
2. **Make the check honest.** Remove the `Run Web tests` step until (1) is
   done, so CI reflects reality and the API suite's signal is not buried.

Recommended separately: introduce a lint gate (ESLint flat config + a
`lint` script wired into `build.yml`/`test.yml`) — noting that retrofitting
ESLint to 4.6 MB of view code will surface a large first-run error count and
should be staged (start with `no-unused-vars`-class rules that TypeScript
already enforces, then tighten).

**Both are explicitly out of scope for this UX/UI effort** — §142 forbids
bundling unrelated changes, and §122 forbids adding tests to a codebase without
test infrastructure. Flagged for the maintainer.

### 9.4 Other workflows (context)

| Workflow | Purpose | Gate |
| --- | --- | --- |
| `test.yml` | PR + push to main | **RED** (web step, §9.1) |
| `build.yml` | docker build + push `ghcr.io/.../hopedesign-api` and `-web` on main | n/a |
| `security.yml` | `npm audit --omit=dev --audit-level=high` (**blocking**) + advisory full audit (`continue-on-error`) + `gitleaks/gitleaks-action@v2` | passing; one formally risk-accepted advisory: `exceljs@4.4.0 -> uuid@8.3.2` (GHSA-w5hq-g745-h8pq, moderate, unreachable) |
| `production.yml` | `appleboy/ssh-action` deploy to `/opt/hopedesign_erp` port 2978, `command_timeout: 30m`, `deploy/zero-downtime-deploy.sh` (blue/green + Caddy flip) | n/a |

The presence of `gitleaks` in CI is a meaningful secret-hygiene control and is
why §147's secret review is largely satisfied by tooling plus the finding that
`.env` is not tracked (§11).

---

## 10. Performance acceptance (§127) — measured signals

Not a benchmark; a set of measured proxies that identify where to look.

| Signal | Value | Reading |
| --- | --- | --- |
| Largest gzip chunk | `Shell` 109.79 kB | On the hot path for every route. Highest-value split target. |
| Largest raw chunk | `HrFlow` 468.03 kB | Lazy, but heavy; candidate for intra-feature splitting. |
| `FinanceFlow` | 390.81 kB raw / 83.94 kB gzip | Matches the 452,199 B source file. |
| Largest source file | 452,199 B | Decomposition target (§145). |
| Total views | 88 files / 4.63 MB | Structural debt; see `architecture.md`. |
| `index` CSS | 268.93 kB / 45.44 kB gzip | Single stylesheet, 7,070 lines, no critical-CSS split. |
| Client-side table call sites | 3 (`InventoryFlow.tsx:705`, `Reports.tsx:1291`, `Reports.tsx:1818`) | Deliberately **untouched**; these still filter over loaded rows and are the remaining §20 exposure. |
| Polling intervals | 45 s (`Shell` dashboard-work badges), plus per-feature | Not centrally coordinated; §84 wants fewer, longer-lived intervals. |

Not measured (would require a browser/profiler): render counts, commit
durations, memory, INP/LCP/CLS, network waterfall, real query latency.
**No runtime performance measurement has been performed.**

---

## 11. Secret & data hygiene (supports §147)

```
git ls-files --error-unmatch .env
  -> pathspec '.env' did not match any file(s) known to git      [NOT TRACKED]
```

`.gitignore` correctly covers `.env`, `.env.local`, `.env.production`,
`.prod-gen.env`, `env/`, `backups/`, `*.token.txt` plus scratch patterns.

The root `.env` is present on disk and holds real values (database URL, JWT
secret, mail provider key, etc.). It is **read by the API test suite** to resolve
the integration database, so it must not be moved or blanked casually. It is not
in git and not in any diff produced by this effort.

`gitleaks` runs in CI on push/PR (§9.4), which is a standing automated control
against future accidental commits of credentials.

**No secret value appears anywhere in the modernization diff.**

---

## 12. Why §143 acceptance criteria are partially met

The brief's acceptance criteria include three testing-shaped clauses. Their
status, stated plainly:

| §143 clause | Status | Basis |
| --- | --- | --- |
| "Navigation / dashboard / tables / forms / transactions …" behavioural criteria | **Partially met, unverified in UI** | Delivered as code + static inspection; no runtime confirmation possible without a browser or a frontend test suite |
| Accessibility: "keyboard usable; focus visible; semantic structure correct; dialogs usable; tables accessible; errors accessible" | **NOT met** | A1–A8 in §8 are open blockers, and no assistive-technology pass has been run |
| Performance: "large views reduced/refactored; reasonable code splitting; controlled polling; efficient lists" | **Partially met** | Chunk table measured (§3.2); largest files identified and scheduled (§10); no runtime profiling |

The gap is **tooling, not effort**: there is no mechanism in this repository by
which a frontend change can be automatically verified. That is the finding.

---

## 13. Runbook — reproducing every executed result

```powershell
# --- API integration suite (~15 min, needs network + root .env) ---
cmd /c "npm.cmd test > C:\tmp\api-test.log 2>&1"
Get-Content C:\tmp\api-test.log -Tail 8       # expect: 42 passed / 380 passed

# --- Full production build (~29 s) ---
npm.cmd run build                               # expect: exit 0, "built in ~29s"

# --- Web typecheck only (~45-55 s) ---
npm.cmd run typecheck

# --- Frontend tests (CURRENTLY FAILS - see section 9) ---
npm.cmd run test:web                            # expect: exit 1, Missing script: "test"
```

Notes for whoever runs these next:

* Always redirect long runs to a file. A bare `exec_command` session can be
  reaped before its buffered output is read, losing the result entirely.
* Use `npm.cmd`, not `npm` — the PowerShell execution policy blocks the
  `.ps1` shim.
* `Select-String` is case-insensitive by default; pass `-CaseSensitive` for
  exact counts.
* `rg` is not installed in this environment; use `Select-String` piped from
  `Get-ChildItem -Recurse -Include`.
* The API suite runs **sequentially** by design and never in parallel; do not
  override `fileParallelism`.

---

## 14. Summary

| Gate | Command | Result |
| --- | --- | --- |
| API integration tests | `npm test` | **PASS** — 42 files / 380 tests / exit 0 / 884.02 s |
| Production build | `npm run build` | **PASS** — exit 0 / 148 modules / 28.80 s |
| Web typecheck (in build) | `tsc --noEmit` | **PASS** — strict, noUnusedLocals, noUnusedParameters |
| Frontend tests | `npm run test:web` | **FAIL** — exit 1, `Missing script: "test"` (no web test infra exists) |
| Lint | *(none)* | **ABSENT** — no config, no script, no CI step |
| Accessibility scan | *(none)* | **NOT PERFORMED** |
| Visual/responsive check | *(none)* | **NOT PERFORMED** |
| Keyboard pass | *(none)* | **NOT PERFORMED** |
| Screen-reader pass | *(none)* | **NOT PERFORMED** |
| **CI** | `.github/workflows/test.yml` | **RED** — last step targets a script that does not exist |

The backend is genuinely verified. The frontend is genuinely not.
