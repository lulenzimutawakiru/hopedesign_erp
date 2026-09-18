# Component Library

**Scope:** `apps/web/src/components/` — **14 `.tsx` files**. The library is
deliberately small. Everything here is exported, used, and verified against the
current source; nothing is described from memory.

> **Confirmation this is the real inventory:** the build produces exactly one
> shared UI chunk pair from this folder — `EntityList-tgly2Iab.js` (4.43 kB) — plus
> the CSS. There is no hidden second design system.

---

## 1. Primitives — `components/ui.tsx` (255 lines)

| Export | Line | Contract |
| --- | --- | --- |
| `statusMeta(status)` | 18–55 | Maps an enum string to `{ kind, tone, icon, label }` |
| `statusTone(status)` | 57 | Tone class only |
| `Badge({ value })` | 61–72 | Renders a status chip from **any** value |
| `Spinner()` | 74 | Inline spinner |
| `PageLoader({ label?, variant? })` | 87 | `'spinner'` or `'page'` |
| `ErrorBanner({ error })` | 117 | Renders `describeError(error)` |
| `Notice` | 129 | Inline informational block |
| `Modal` | 133 | Dialog shell |
| `Pager` | 160–193 | Pagination control |
| `StaffPhoto` | — | Avatar |

### 1.1 `Badge` — the only status renderer

`<Badge value={row.status} />` accepts **any** value, including `null`, `undefined`
and `''` (which render a neutral chip with a `●` glyph and `-` label). It maps
roughly 160 backend enum values to **10 semantic kinds** and **9 tones**:

| Kind | Glyph | Representative values |
| --- | --- | --- |
| `ok` | ✓ | APPROVED, COMPLETED, POSTED, ACTIVE, EXECUTED, SIGNED, DISPATCHED, DELIVERED, DONE, AUTHENTIC, RECEIVED, PASSED, PASS, RELEASED, RESOLVED, VERIFIED, OK, MATCHED, GREEN, REGISTERED, AVAILABLE, IN_STORE, IN_USE, ASSIGNED, PAID, SETTLED, RECONCILED |
| `progress` | ● | IN_PROGRESS, IN_REVIEW, REVIEW, PARTIALLY_DISPATCHED, PARTIAL, PARTIALLY_PAID, UNDER_REVIEW, VALIDATING, SENT_FOR_SIGNATURE, PARTIALLY_SIGNED |
| `pending` | ⚠ | PENDING, SUBMITTED, PENDING_APPROVAL, HR_REVIEW, MANAGER_REVIEW, FINANCE_REVIEW, LEGAL_REVIEW, WAITING, OVERDUE, RETURNED, LOW, NOT_RECEIVED, NOT_INVOICED, AMBER, WARN |
| `reject` | ✕ | REJECTED, TERMINATED, FAILED, FAIL, QUARANTINE, QUARANTINED, COMPROMISED, RECALLED, SPOILED, DAMAGED, LOST, MISSING, STOLEN, DIFFERENCE, RED |
| `critical` | — | CRITICAL, LOCKED |
| `hold` | — | SUSPENDED, ON_HOLD, MAINTENANCE, UNDER_MAINTENANCE, UNDER_INSPECTION, RESERVED, REWORK, SUSPICIOUS |
| `draft` | – | CANCELLED, CANCELED, VOID, VOIDED, DRAFT, CLOSED, ARCHIVED, EXPIRED, IDLE, OFFLINE, UNKNOWN, DISPOSED, RETIRED |
| `info` | — | OPEN, NEW, REQUESTED, SCHEDULED, PLANNED, ALREADY_VERIFIED |
| `secure` | — | SECRET, TOP_SECRET, CLASSIFIED, CONFIDENTIAL, RESTRICTED |
| `neutral` | ● | Fallback for anything unrecognised |

**Rules**

1. Never write a bespoke status span. Use `Badge`.
2. Never invent a status the backend does not return (§77).
3. Values outside the registry degrade to `neutral` — they do **not** throw. This is
   intentional: an unknown backend enum must not break a screen.
4. **Custody events are not statuses.** Use `eventLabel()` from `helpers.ts` inside a
   timeline. Several custody `event_type`s (`MATERIALS_AUTHORIZED`,
   `MATERIALS_ISSUED`, `IN_PRODUCTION`, `QC`, `RECONCILIATION`, `PACKAGING`,
   `IN_SECURE_STORAGE`) have no `statusMeta` entry and would render neutral.

### 1.2 `Pager`

```
Pager({ page, pageSize, total, onPage, onPageSize?, pageSizes = [25, 50, 100, 200] })
```

Named export. Renders "Page X of Y · N records", a rows-per-page select and
Prev/Next. `DataTable` composes it; a view should not re-implement pagination.

---

## 2. Overlays and layout — `components/os.tsx` (119 lines)

| Export | Line | Notes |
| --- | --- | --- |
| `ConfirmDialog` | 8 | `role="alertdialog"` |
| `Drawer` | 56 | `role="dialog"`, has ESC + scrim close |
| `CreateMenu` | 76 | Split create button |
| `Meter` | 98 | `.meter` + `.meter-track`, `role="progressbar"` with `aria-valuenow/min/max` |
| `EmptyState` | 110 | `{ title, body, action?, onAction? }` |

### 2.1 Known behavioural differences (choose deliberately)

**`Drawer` is the more accessible of the two overlays.** It handles `Escape`,
declares `role="dialog"` with `aria-label={title}`, and closes on scrim click.
Prefer it for context, activity, audit and quick details.

**`ConfirmDialog` has three constraints you must design around:**

1. **Hardcoded ids** `#confirm-title` and `#confirm-reason` — so **only one can be
   open at a time**, and a page must not render two.
2. **`body` is a required `string`** — it cannot take JSX. Keep confirmation copy
   plain.
3. **No `Escape` handler.** It is a deliberate two-step confirmation; do not wire
   ESC to it, because a stray keypress must not dismiss a destructive prompt.

`reasonLabel={null}` hides the reason input but still calls `onConfirm('')` — so the
handler must tolerate an empty reason rather than assume one was typed. The cancel
label is hardcoded `"Keep as-is"`.

Use `ConfirmDialog` **before destructive or irreversible actions only**. It is not
a general-purpose modal.

### 2.2 `EmptyState`

The action button renders **only when both** `action` and `onAction` are given —
passing a label alone produces a dead button. Always write a contextual title and
body plus a way out (§35): *"No purchase requisitions — no requisitions match your
current filters. [Clear filters] [Create requisition]"*, never *"No data."*

---

## 3. States and gates — `components/states.tsx` (176 lines)

| Export | Line | Notes |
| --- | --- | --- |
| `ErrorState` | 23–54 | Full-page failure surface |
| `PermissionGate` | 56 | `{ permission?, allOf?, fallback?, children }` |
| `RoleGate` | 75 | Role-based wrapper |
| `SectionHeader` | 92 | Section heading |
| `StatCard` | — | KPI tile |
| `StatusBadge` | 6 | Re-export of `Badge` |
| `safeMessage` | 17 | Re-export |
| skeletons | 8–15 | Table / card / page skeletons |

### 3.1 `ErrorState`

```
ErrorState({ title?, message?, referenceId?, onRetry?, showDashboard = true })
```

Root is `<div className="state-error" role="alert">` with `.state-error-mark`,
`<h3>`, `<p className="muted">` and a `.quick-actions` row containing **"Try again"**
(rendered only when `onRetry` is supplied) and **"Go to dashboard"**. An optional
`.state-ref` prints the reference id in `cell-mono` so a user can quote it to
support.

Defaults: `title='Something went wrong'`,
`message='We could not load this view…'`.

### 3.2 `PermissionGate` / `RoleGate` — zero call sites

Measured: **0** `<PermissionGate>` and **0** `<RoleGate>` usages in the codebase.

These components are **not** deprecated and **not** broken; route-level gating is
handled by `requiredPermForPath` in the shell and by `itemVisible` in navigation.
They exist for the case a **single control inside an authorised page** must be
hidden. When you need that:

- prefer **state-aware disabling with an explanation** (§109) over hiding, when the
  user is authorised for the page but not for this step;
- use `PermissionGate` only when the control is meaningless without the permission.

> Neither gate is a security control. The backend enforces every call.

---

## 4. Error text — `components/errorText.ts`

```
describeError(error, fallback = GENERIC_TEXT): string
safeMessage(error): string | undefined
```

Status codes in `CANONICAL_ONLY = { 401, 404, 405, 408, 413, 429, 500, 501, 502, 503, 504 }`
always use the canonical message, overriding anything the server sent — so an
internal string can never leak to a user. Representative mappings:

| Status | Message |
| --- | --- |
| 401 | Session expired — sign in again |
| 403 | You do not have permission to perform this action |
| 404 | This record could not be found. It may have been removed |
| 409 | This record changed while you were working on it. Reload and try again |
| 429 | Too many requests |

**Always render failures through this helper.** Never print a raw
`err.message` or a bare `403 Forbidden` to an operator (§33) — the canonical text
explains *what happened*, and the view supplies *what to do next*.

---

## 5. Toasts — `components/toast.tsx`

```
toast.success(title, options?)
toast.error(title, options?)     // sticky: duration 0
toast.warning(title, options?)
toast.info(title, options?)
toast.fromError(title, error?)
useToast()
Toaster()
```

Behaviour: **errors are sticky** until dismissed; others auto-dismiss after
4,800 ms; identical `(kind, title, body)` triples are de-duplicated; the stack is
capped at **4** so a burst cannot bury the screen.

Rules:

- A toast **confirms** an action that already succeeded. It is never the only
  result of a button (§77 — no toast-only fake functionality).
- Use `toast.fromError` with the caught error so canonical messages are reused.
- Long operations should report progress in the page, not as toast spam
  (§34, §130).

---

## 6. Entity pickers — `components/EntityPicker.tsx` (8,049 B, new)

```
EntityPicker({
  value, onChange(value, option?),
  options?, endpoint?, query?,
  searchParam = 'q', mapRow = defaultMapRow,
  placeholder = 'Search...', disabled = false,
  ariaLabel?, initialLabel?, emptyHint = 'No matches',
  id?, className?
})
```

Default export; also exports `defaultMapRow` and the `EntityOption` type.

- **Two modes.** Pass `options` for a small static list, or `endpoint` to search the
  server. Server mode issues:
  `${endpoint}?page=1&pageSize=25&<searchParam>=…&<query>`
- **`searchParam` matters.** Every picker uses `q` **except**
  `/api/admin/users`, which expects `search`. Getting this wrong returns an
  unfiltered list that looks like it works.
- Define `mapRow` as a **module-level const**, never an inline arrow — an inline
  function is a new identity on every render and re-fetches the list.
- `initialLabel` lets an edit form show the current selection's name before the
  first keystroke, so an existing record never renders as a bare numeric id (§27).

**Why it exists:** §26 forbids asking a user to type a database id. Use this
component (or a picker built on the same contract) for every
customer / supplier / employee / product / warehouse / machine / account reference.

Verified picker endpoints:

| Entity | Endpoint | Search param | Searchable fields |
| --- | --- | --- | --- |
| Products | `/api/inventory/items` | `q` | `code`, `name` |
| Machines | `/api/production/machines` | `q` | — |
| Customers | `/api/crm/customers` | `q` | — |
| Suppliers | `/api/procurement/suppliers` | `q` | — |
| Users | `/api/admin/users` | **`search`** | — |
| Employees | `/api/hr/employees` | `q` | — |

Current consumer: `views/SecurityJobs.tsx`.

---

## 7. Data display

### 7.1 `DataTable` (`components/DataTable.tsx`)

Two modes, one component.

**Client mode** (`rows` only) — for short, bounded, fully-loaded lists.

**Server mode** (`server` prop) — for anything that represents a register:

```
DataTableServer = {
  query: { page, pageSize, q, sort, order },
  total: number,
  onQuery: (next: Partial<DataTableQuery>) => void,
  hideSearch?: boolean,   // page owns the search box
}
```

Server mode is the §20 fix: filtering, sorting and paging are performed by the
backend against the whole table, not against the loaded page. When `server` is
supplied, **the table stops doing client-side filter/sort** — a distinction the
user can rely on.

Other behaviour:

- `pickColumns(meta, max)` chooses up to `max` business columns and skips
  `HIDDEN` plumbing (`id`, `*_at`, `*_by`, `tenant_id`, `company_id`, `branch_id`,
  `attributes`, `secret_hash`, and their camelCase forms) — this is the §22
  "no database column names" rule, enforced in code.
- Terminal columns to finance/warehouse density, column show/hide, drag-to-resize,
  and a table/cards view switch for narrow screens (§126).
- Renders `EmptyState` for empty results, `ErrorState` for failure, and a
  `TableSkeleton` while loading — so no list can render a blank region.

### 7.2 `EntityList` (`views/EntityList.tsx`, 209 lines)

Generic CRUD list for **master data and simple registers only** (§24): products,
suppliers, warehouses, machines, cost centres, departments. Complex transactions
must not be forced through it.

Recent hardening:

- errors are routed correctly — a page-level `ErrorBanner` shows only when rows
  already exist and a refresh failed, otherwise the list renders `ErrorState`;
- search input is debounced **350 ms** before it hits the API.

---

## 8. Not in the library

Do not assume these exist because the brief names them. Verified absent:

| Named in brief | Reality |
| --- | --- |
| `WorkflowTimeline` | No dedicated component. `.timeline*` CSS exists and is used with hand-written markup. |
| `TraceabilityChain` / `TraceabilityGraph` | **0** usages. `.trace-chain` CSS was deleted; `QrTrace.tsx` renders its own lineage. |
| `TransactionSummary` | No component; the subtotal/tax/total/paid/balance pattern is per-view. |
| `ActivityTimeline` / `AuditTimeline` | No component; timeline markup is repeated per view. |
| `SignaturesBlock` | No component. |
| `Toaster` mount | Mounted once in the shell — do not mount a second host. |

Each is a **candidate for extraction** when the second or third consumer appears.
Extract on the third use, not the first (§100).
