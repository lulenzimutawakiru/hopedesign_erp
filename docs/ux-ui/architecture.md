# Frontend Architecture

**Scope:** `apps/web` — React + Vite + TypeScript (`strict`, `noUnusedLocals`).
This document describes the **measured** state. Every claim is checkable in the
repository; nothing here is aspirational.

---

## 1. Authority model

The backend is authoritative for **authorization, workflow transitions, SoD, QR
verdicts, custody, posting rules and fiscal state.** The frontend renders decisions;
it does not make them.

> A route guard or a hidden button is a **usability** affordance, not a security
> control. Every permission check below is duplicated and enforced server-side.
> Never treat a hidden control as a defence.

---

## 2. Layout

| Path | Role |
| --- | --- |
| `apps/web/src/views/` | 88 route-level screens and feature flows |
| `apps/web/src/components/` | 14 shared components (design system + data layer) |
| `apps/web/src/nav.ts` | Navigation model, permission map, breadcrumbs, route gating |
| `apps/web/src/router.ts` | Hash router primitives |
| `apps/web/src/api.ts` | Single HTTP client, `ApiError`, formatters |
| `apps/web/src/auth.tsx` | `useAuth()`, `can(user, perm)` |
| `apps/web/src/company.tsx` | Company / branch / fiscal-year context |
| `apps/web/src/listState.ts` | Per-list query + scroll state |
| `apps/web/src/styles.css` | 7,070 lines — token layer + all component CSS |

---

## 3. App shell and dispatch

`views/Shell.tsx` is the shell **and** the single dispatcher — one ordered switch,
`Shell.tsx` L190–229:

1. `denied` → `AccessDenied` (L184–188)
2. exact / prefix matches for feature flows
3. `detailMatch` → `EntityDetail`
4. `listMatch` → `EntityList`
5. fallback → `AccessDenied`

Dispatch **order matters**: `/security-jobs`, `/qr/scan`, `/qr/:code`,
`/packing` and `/labels` are matched *before* the `salesPath` /
`inventoryPath` prefixes, so the security-printing and QR domains cannot be
shadowed by a broader prefix. `/qr/:code` explicitly excludes the literal
segment `scan` (L214).

### Shell regions

Sidebar · Topbar · breadcrumbs · page header · global search / command palette ·
notifications · company context · user menu · main content · optional context panel
(drawer) · toast host.

### Focus mode

`Shell.tsx` L108:

    const focus = prefs.focusMode || isFocusPath(path)
      || (compact && (path === '/warehouse' || path.startsWith('/operator')));

Focus mode collapses chrome for floor operators. It is driven by a saved preference,
an explicit path list, or the `compact` breakpoint — never by role alone.

---

## 4. Routing (§97 deviation, deliberate)

Routing is **hash-based** (`#/path?query`) and was **not rewritten.** A hash→history
migration must not be bundled with a large visual change: a failed migration breaks
every bookmark, deep link and printed QR label URL at once.

Primitives (`router.ts`): `currentPath()`, `currentQuery()`,
`useHashRoute()`, `useHashQuery()`, `matchRoute(path, pattern)`,
`navigate(path, { replace?, query? })`.

`navigate` serialises `?k=v` pairs, skipping `undefined` and `''`.
With `replace: true` it calls `history.replaceState` and then dispatches a
synthetic `HashChangeEvent` so `useHashQuery()` observes the change — this is
why it is safe to call from inside an effect.

**Migration plan (separate, not started):** ship with a redirect table for old hashes
plus a QR re-encode plan.

---

## 5. Permission model (UI side)

- `useAuth()` → `user`; `can(user, permission)` (`auth.tsx` L369–379).
  Returns `false` for a null user and short-circuits on `system.admin.all` or
  `*`. Otherwise accepts an exact match, `module.resource.*`, or `module.*`.
- `itemVisible(user, { perm, module })` (`nav.ts`) — the single predicate
  deciding whether a nav destination is offered. It also consults tenant module
  activation.
- `requiredPermForPath(path)` (`nav.ts` L687+) — maps a path to the one
  permission that governs it; used by the shell's `denied` gate.
- `requiredPermForPath` returns `undefined` for `/security-jobs` and
  `/qr/:code`, so those routes render and the **API** issues the authoritative 403.

Shell gate (`Shell.tsx` L184–188):

    const denied = useMemo(() => {
      const perm = requiredPermForPath(path);
      if (!perm) return false;
      return !itemVisible(user, { perm, module: perm.split('.')[0] });
    }, [path, user]);

`<PermissionGate>` and `<RoleGate>` exist in `components/states.tsx` but
have **zero call sites**; gating happens through `can` / `itemVisible` and
per-view checks. That is consistent, if less declarative than §98's sketch.

---

## 6. Data flow

There is **no global state framework.** State is layered:

| Layer | Mechanism |
| --- | --- |
| Server state | per-view `useEffect` fetch + local state, or feature hooks |
| URL state | `router.ts` query helpers; `listState.ts` for list query + scroll |
| Global | `auth.tsx` (identity), `company.tsx` (tenant/branch/FY), prefs, nav |
| Feature | local to the view unless two views genuinely share it |

`api.ts` is the only HTTP entry point:

- `ApiError { status, code }` is **exported**, so views can branch on
  `e instanceof ApiError`.
- The token lives in `sessionStorage` under `hdg_token`.
- A **401 on any non-`/api/auth/` path clears the token and redirects to
  `#/login`**, then throws `ApiError('Session expired', 401)` — views never
  handle expiry themselves.
- Non-OK responses become `ApiError(body.error.message, res.status, body.error.code)`.

### List contract

    { "data": [], "pagination": { "page": 1, "pageSize": 50, "total": 8421 } }

`components/DataTable` consumes this via `ListResult<T>` (`api.ts`). The
API's `parsePagination` clamps `page >= 1` and `pageSize` to 1–500.

### API service layer

§79 asked for per-domain API modules; that was **not** done as a blanket refactor.
Feature views call `api()` directly against existing endpoints, keeping endpoint
usage auditable per feature. New work should prefer a `features/<domain>/api/`
module when one view makes many calls to a single domain.

---

## 7. Code splitting

Every flow is a route-level dynamic import, so the shell stays small and a finance user
never downloads payroll. Measured production output (latest build):

    index                   177.47 kB │ gzip  57.70 kB
    Shell                   376.54 kB │ gzip 109.75 kB
    HrFlow                  468.03 kB │ gzip  96.80 kB
    FinanceFlow             390.81 kB │ gzip  83.94 kB
    ServiceDeskFlow         336.85 kB │ gzip  82.40 kB
    AssetsFlow              272.29 kB │ gzip  54.34 kB
    AdminFlow               163.19 kB │ gzip  37.03 kB
    ManufacturingFlow       160.48 kB │ gzip  34.05 kB
    HikvisionFlow           152.94 kB │ gzip  32.64 kB
    ProcurementFlow         151.80 kB │ gzip  29.28 kB
    OrganisationSettings    118.17 kB │ gzip  28.87 kB
    CompliancePdpo          103.28 kB │ gzip  25.22 kB
    SpendFlow                91.46 kB │ gzip  18.71 kB
    CommunicationFlow        79.79 kB │ gzip  19.35 kB
    InventoryIntel           74.68 kB │ gzip  14.42 kB
    InventoryFlow            72.54 kB │ gzip  14.68 kB
    CrmFlow                  60.31 kB │ gzip  10.84 kB
    SalesFlow                59.05 kB │ gzip  12.87 kB
    DocumentsFlow            42.29 kB │ gzip   9.31 kB
    ReamPacking              38.87 kB │ gzip  10.32 kB
    index.css               268.93 kB │ gzip  45.44 kB

The four largest flows are already isolated chunks — which is why they are candidates
for *internal* decomposition rather than urgency-driven splitting.

---

## 8. Error and loading model

- `describeError(err, fallback)` (`components/errorText.ts`) is the **only**
  sanctioned way to turn a thrown value into user-facing text. Canonical statuses
  (401/404/405/408/413/429/500–504) win over server text; a human-readable server
  message wins otherwise.
- `safeMessage(err)` returns `undefined` rather than a lie when nothing useful
  is known.
- `<ErrorState>` (`role="alert"`, optional retry + reference id) for a failed region.
- `<ErrorBanner error=…>` for inline / stale conditions.
- `<PageLoader>`, `<Spinner>`, skeletons for loading; `<Meter>` for
  determinate progress.
- Errors are **never** swallowed: a `catch` that hides a material failure is not
  permitted. A background refresh that keeps the previous, still-truthful data on screen
  is the only accepted quiet path.

---

## 9. Real-time / polling

One interval per concern, owned by the shell where possible:

| Data | Interval | Owner |
| --- | --- | --- |
| Notifications + module badge counts | 45 s | `Shell.tsx` |
| Factory live boards | per-view | `FactoryOs` / `OperatorFloor` |
| Reference data (warehouses, machines, tax codes) | not polled | request-time |

`Shell.tsx` fetches `/api/dashboard/work` inside the same 45 s tick and reuses
the `counts` map for badges — one interval for "what needs attention" rather than
one per module.

---

## 10. Deviations and open gaps

See `../UX_AUDIT_2026.md` for the full baseline.

1. **§97 — routing.** Hash router preserved; no migration. Deliberate.
2. **§11 — information architecture.** Navigation was **subgrouped and pruned of dead
   entries**, not restructured into the brief's literal tree. A wholesale regroup
   invalidates stored list state and bookmarks for no functional gain.
3. **§8 — design tokens.** Tokens were already centralized in `:root` under an
   established convention (`--hope`, `--navy`, `--line`, `--mod-*`,
   `--st-*`) referenced by 470 tables and 88 views. They were **documented and
   extended, not renamed** — a rename is a mass mechanical edit with regression risk and
   no user-visible benefit. Mapping in `design-system.md`. Spacing is **not**
   tokenised as `--space-N` — recorded as a gap.
4. **§99 — `features/*` folders.** Not created; 88 files remain under `views/`.
   Decomposition is byte-budget-first in §145 priority order, because moving files without
   shrinking them is pure churn.
5. **No `apps/web` test runner.** `vitest` is not configured for the web app and
   there is no `test:web` script, so root `npm run test:web` fails. Type checking
   and the production build are the available gates — see `testing.md`.
6. **No lint gate** in `apps/web`.
7. **Visual / a11y verification** was code-audit based only; no automated browser matrix
   ran in this effort. Treat the `responsive.md` matrix as a **required manual
   checklist**, not as evidence it passed.
