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

## 3. Remaining work (roadmap)

These are ordered by impact ÷ risk. The first three are the "safe" tail of the audit; the last is a deliberate redesign that needs a product decision before code.

### A. Navigation — 6-workspace redesign (Phase 3) — **needs IA decision**
`src/nav.ts` (1,125 lines) declares **13 top-level groups** with very deep nesting — Manufacturing has ~30 children, Finance ~40, People ~42. The master prompt asks for a 6-workspace consolidation. **Before writing code I need the target workspace list** (the six workspace names/groupings from your prompt are not recoverable from my notes). A sensible default consolidation of the existing 13 groups:

1. **Home** (home) — Dashboard, My Work, Approvals, Inbox.
2. **Commerce** (business + supply) — CRM, Sales, Procurement, Inventory, Warehouses, Logistics.
3. **Operations** (operations + security) — Manufacturing, QC, Security printing, Operator floor.
4. **Finance** (finance + spend) — GL, Payables/Receivables, Spend, Budgets.
5. **People** (people) — HR, Payroll, Time/Attendance.
6. **Governance** (service + analytics + communication + admin + compliance) — Service Desk, Reports/Exports, Mail, Admin, Compliance/PDPO.

Routing itself does **not** change — only the grouping/labels in `nav.ts` — so all deep links keep working. This is safe to do incrementally.

### B. Design system — enforce tokens (Phase 5)
`tokens.css` is a clean, well-scoped set (colour, spacing, radius, shadow, module accents, status tones) and is loaded first. The gap is **adherence**: `styles.css` is 7,222 lines and the TSX uses pervasive inline `style={{…}}`, so the token layer is bypassed in many places. Recommended increments:
1. Sweep for hard-coded hex values in `styles.css` and inline styles; migrate the common ones (navy/hope/line/muted/danger) to `var(--…)`.
2. Replace the repeated inline layout styles (the `display:flex; gap:8; marginTop:16` footer in `JsonForm`, the tab rows in `Approvals`, etc.) with named utility/component classes.
3. Add a lint guard (a tiny script or `stylelint` rule) so new hex values outside `tokens.css` fail CI.

### C. Responsive (Phase 4)
Breakpoints exist (`useBreakpoint`: mobile/phablet/tablet/laptop/desktop) and the shell has a focus/mobile-dock path. Remaining gap: many view-level cards/tables assume desktop width. Increment: audit the busiest views (`EntityList` table, finance grids, dashboards) at ≤768px and add the missing horizontal-scroll/wrap rules.

### D. Accessibility & performance (Phase 8)
- Focus management is now consistent across modals, drawers and popovers (done above). Remaining: full ARIA **menu** keyboard navigation (Arrow/Home/End) for `UserMenu`/`CreateMenu`, and a contrast pass on the `--muted`/`--rail-dim` pairs.
- Performance: route views are already `lazy()`-loaded. Next: confirm `leaflet`/`jsqr` are only pulled into the routes that use them (dynamic import), and add an explicit `prefetch` strategy for the top 3 landing views.

### E. Tables / forms / record details (Phase 7)
- `JsonForm` validation is fixed. Remaining: a shared table primitive (sticky header, empty-state, `role="table"` semantics) to replace the ad-hoc `<div className="queue">` grids, and consistent record-detail layout.

### F. Business workflow improvements (Phase 6)
Depends on product decisions (e.g. bulk approve, delegations surfaced in the queue, SLA escalation UX). The live `workflows` engine already exposes the data; this is UI polish on top of it.

### G. Testing (Phase 9)
Now **88 tests across 14 files** (was 84/12 before this audit). Expand toward: the route registry (a table-driven test asserting every `nav.ts` href resolves to a non-`AccessDenied` route), `statusMeta` coverage, and the `usePopover`/`useDialogFocus` keyboard contract.

---

## 4. Verification status

- `npm run typecheck` — green.
- `npm test` — **88 passed / 14 files**.
- Nothing here requires a DB migration; the changes are frontend-only and non-destructive.
- Nothing is deployed. Merge/push/deploy are intentionally left to a separate, explicit step after the safe tail (B–E) is in and reviewed.
