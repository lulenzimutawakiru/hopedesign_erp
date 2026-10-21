# Frontend UX/UI audit — HOPEDESIGN ERP (`apps/web`)

**Date:** 2026-10-21 · **Branch:** `ux/frontend-audit-stage1` · **Method:** direct source inspection (the parallel audit fan-out was unavailable — subagents failed on an API quota error — so every finding below was read against the code and, where a fix was made, verified by typecheck + a regression test).

This document is the Phase 1 (audit) and Phase 10 (roadmap) deliverable. It is a living record: each finding carries file/severity/impact and a status of **FIXED** or **TODO**.

---

## 1. Architecture snapshot

- **React 18.3 + TypeScript** (strict, `tsc --noEmit` as the build gate), **no router library** — a hand-rolled hash router (`src/router.ts`) dispatches through `src/views/Shell.tsx`.
- **No CSS framework, no state library.** Styling is `tokens.css` (97 lines) + `styles.css` (7,222 lines) + `print.css` + `styles/auth.css`, plus a large amount of **inline `style={{…}}`** in the TSX.
- **Dependencies:** `jsqr`, `leaflet`, `niimbot-web-bluetooth`. **Dev:** `vitest`, `@testing-library/*`, `vite`, `jsdom`.
- **No router means route permissions are resolved by convention:** `normalizePath` + `requiredPermForPath` + the route registry in `Shell.tsx` all have to stay in lock-step.

---

## 2. Confirmed findings (prioritised)

### Critical

| # | Finding | Evidence | Status |
|---|---|---|---|
| 1 | **Enter in the approval note field was a one-keystroke sign-off.** The note `<input>` is `autoFocus`ed, and its `onKeyDown` called `decide(row, 'APPROVED')` on Enter. | `views/ApprovalQueue.tsx` | **FIXED** `0f75cf5` — Enter now only dismisses the note editor; the decision stays gated behind the explicit Approve/Return/Reject buttons. Regression test: `ApprovalQueue.test.tsx`. |

### High

| # | Finding | Evidence | Status |
|---|---|---|---|
| 2 | **Malformed `jsonb`/`json` form values were silently posted as plain strings.** The `JSON.parse` catch fell back to `payload[field] = String(raw)`. | `components/JsonForm.tsx` | **FIXED** `0f75cf5` — structured fields are validated up front; submit is blocked with a field-level error. Regression test: `JsonForm.test.tsx`. |
| 3 | **Bare-letter keyboard shortcuts fired underneath open overlays.** `a`→Approvals, `s`→scan, etc. answered even while a modal/drawer/palette had focus. | `views/Shell.tsx` keydown handler | **FIXED** `0f75cf5` + `54b42f7` — suppressed while any blocking overlay (`[aria-modal]`, `.modal-backdrop`, `.drawer-scrim`, `.topbar-dropdown`, …) is open. `Ctrl/Cmd+K` stays available. |

### Medium

| # | Finding | Evidence | Status |
|---|---|---|---|
| 4 | **`MoreDrawer` and the keyboard-help modal bypassed the shared focus trap** (no Tab-trap, no focus restore). | `components/nav.tsx`, `views/Shell.tsx` | **FIXED** `0f75cf5` — `MoreDrawer` now traps focus via a body that mounts only while open; the help modal reuses `Modal` (`useDialogFocus`). |
| 5 | **Route dispatch was an untyped ~40-branch `if/else`.** No compiler check that every path maps to a view. | `views/Shell.tsx:187-228` | **FIXED** `17ce3a3` — replaced with a typed `{match, render}` registry, same ordering, same behaviour. |
| 6 | **Non-modal popovers lost focus on Escape.** `ScopeChip`, `UserMenu`, `CreateMenu` closed on Escape but dumped focus onto `<body>`. | `components/nav.tsx`, `components/os.tsx` | **FIXED** `54b42f7` — shared `usePopover` hook closes on outside-click/Escape and returns focus to the trigger. Test: `popoverFocus.test.tsx`. |
| 7 | **Approval lifecycle states were not distinguishable.** History showed only the task decision (Approved/Rejected/Returned/Delegated); the workflow *instance* state (Submitted / Running / Execution-pending / Approved / Executed / Rejected) was returned by the API but never surfaced. | `views/ApprovalHistory.tsx`, `components/ui.tsx` | **FIXED** `17ce3a3` — `statusMeta` now tones `RUNNING`/`EXECUTION_PENDING`/`ESCALATED`; `ApprovalHistory` renders the `instance_status` badge alongside the decision. Test: `ApprovalHistory.test.tsx`. |

---

## 3. Roadmap — phase status (updated 2026-10-21)

| Phase | Status | Evidence |
|---|---|---|
| 1 · Audit | ✅ Done | Sections 1–2 of this document. |
| 2 · UX/safety fixes | ✅ Done | Findings 1–7 fixed (`0f75cf5`, `54b42f7`, `17ce3a3`). |
| 3 · 6-workspace nav | ✅ Done | `nav.ts` regrouped 13 → 6 groups; routing/hrefs/perms unchanged. PR #9. |
| 4 · Responsive | ✅ Assessed | Already covered: `DataTable` flips to **cards** `<768px`; `.table-wrap { overflow-x:auto }`; ~60 media queries collapse grids at 640/767/900/960/1023px. No further change required for the busiest views. |
| 5 · Design tokens | ✅ Done | `scripts/check-tokens.mjs` guard (`--fix`) migrated 192 hard-coded core colours across 22 files to `var(--token)`; wired into `build`/`typecheck`. PR #10. |
| 6 · Business workflows | ⏸ Product decision | Bulk approve, delegation surfacing, SLA-escalation UX. Live `workflows` engine already exposes the data; needs a choice before UI polish. |
| 7 · Tables/forms | ✅ Assessed | `DataTable` is the shared primitive: sticky `thead`, `EmptyState` (empty + no-results + in-table), native `<table>/<th>/<tr>` semantics; column show/hide + resize. `JsonForm` validation fixed in Phase 2. |
| 8 · A11y & performance | ✅ Done (a11y) | ARIA menu arrow-key nav (`4c8a9ab`); focus traps consistent. Contrast pass: `--muted-2` `#8995A1`→`#6A7683` (3.05→4.63:1); `--muted`/`--rail-text`/`--rail-dim` audited clear. PR #12. |
| 9 · Testing | ✅ Done | 96 tests / 16 files. New `routeRegistry.ts` + table-driven guard asserting **every** `nav.ts` item+child href resolves to a non-`AccessDenied` route. PR #11. |
| 10 · Roadmap | ✅ Done | This document. |

**Outstanding (needs a human decision):** Phase 6. The three workflow enhancements — bulk approve in the queue, surfacing delegations/acting roles, and an SLA-escalation indicator — each have a live-engine data dependency and a UX shape that a product owner should choose. Flagged here for the next planning session rather than guessed.

**Deferred (non-blocking):** a follow-on performance sweep (confirm `leaflet`/`jsqr` load only in their routes; add a `prefetch` strategy for the top 3 landing views), and a token sweep for the remaining *non-core* inline hexes (module accents / status tones that `check-tokens.mjs` intentionally does not flag).

---

## 4. Verification status

- `npm run typecheck` — green (token guard + `tsc --noEmit`).
- `npx vitest run` — **96 passed / 16 files**.
- No DB migration required; all changes are frontend-only and non-destructive.
- Deployed to production via manual plink roll-out (see the deploy step in the runbook).
