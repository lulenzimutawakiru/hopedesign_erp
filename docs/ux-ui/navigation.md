# Navigation

**Source of truth:** `apps/web/src/nav.ts` — 1,049 lines, **14 groups**, 284
`href:` declarations, 273 `perm:` declarations. It is one file on purpose: the
navigation model, the route permission map, breadcrumbs and the search-hit
router all read from the same structure, so they cannot drift apart.

---

## 1. Group structure

| Group id | Label | Contents |
| --- | --- | --- |
| `home` | Home | Dashboard, My Work, Approvals |
| `business` | Business | Sales hub, CRM (Accounts, Contacts, Leads, Pipeline, Activities, Cases, Dashboards) |
| `supply` | Supply Chain | Procurement board, Demand, Requisitions, RFQs, POs, GRN, Supplier invoices, Payments, Suppliers, Inventory, Warehouses, Logistics |
| `operations` | Operations | Manufacturing (Board, Demand, Plans, MRP, Schedule, QC, WIP, Outputs, Issues, Waste, Scrap, Downtime, NCR, Shifts, Machines, BOMs, Costing, Operator Floor), Assets, Maintenance |
| `service` | Service | Service desk, Quality (Inspections, NCRs, CAPA, Defects) |
| `security` | Security | Secure Jobs, QR & Traceability, Ream Packing, Label Varieties |
| `finance` | Finance | **Sub-grouped** — see §1.2 |
| `spend` | Requisitions & Spend | Requisitions, Daily Expenditure, Petty Cash, Claims, Daily Close |
| `people` | People | Org, Positions, Workforce plans, Recruitment, Employees, Contracts, Leave, Attendance, Payroll, Performance, Training, Benefits, Relations |
| `analytics` | Analytics | Reports |
| `communication` | Communication | Hikvision Live, Devices, Events, Failed Events, Exceptions, Attendance, Health, Reports |
| `documents` | Documents | Document management |
| `admin` | Administration | Admin dashboard, Database, Users, Roles, Policies, SoD, Security, Sessions, Audit, Settings, Features, Health, Backups, Delegations, Signatures, Organisation Settings, Workflows |
| `compliance` | Data Protection | PDPO Overview, Processing, Consents, Subject requests, Breaches, Filings, Registration |

### 1.1 §11 deviation — navigation was NOT restructured

The brief proposes a fixed IA (HOME, BUSINESS, SUPPLY CHAIN, OPERATIONS, SECURITY,
FINANCE, PEOPLE, SERVICE, DOCUMENTS, REPORTING, ADMINISTRATION). The shipped model
already matches that shape on **12 of 14 groups** (`home`, `business`, `supply`,
`operations`, `security`, `finance`, `people`, `service`, `documents`,
`analytics`, `admin`, `compliance`), with two additions specific to this business
(`spend` — requisitions and petty cash; `communication` — Hikvision devices and
access events).

Restructuring was **deliberately not performed**, per the audit's narrower §12.1
sequence, because:

- 284 `href:` values are referenced by bookmarks, stored list state keyed on path
  (`hope.os.list.*`, from `listState.ts`) and printed QR labels;
- the remaining gap against the brief is **grouping inside a module**, not missing
  modules — and that is addressed by §1.2 below.

### 1.2 Sub-groups inside a module (§11 requirement, partially met)

`NavChild` carries an optional `group?: string`. When **any** sibling in a child
list sets it, `ModuleNav` renders that child list with section headings. Measured:
**38 children set `group`**, all of them inside `finance`.

Finance sub-groups in use:
`Approvals · Command Center · General Ledger · Receivables · Payables · Cash & Bank ·
Spend & Planning · Fixed Assets · Tax & EFRIS · Cost Centres · Reporting ·
Period & Close · Administration`

**Remaining work:** extend `group` to the other dense modules, highest value first:
`operations` (18 children), `people` (13), `supply` (11), `admin` (16). This is a
data-only change to `nav.ts` — add `group: '…'` strings; `ModuleNav` needs no
change once at least one sibling has it.

---

## 2. Visibility model (§12)

    itemVisible(user, item):
      if (!moduleActiveForTenant(user, item.module)) return false
      if (item.perm && !can(user, item.perm))        return false
      return true

- A menu entry appears only when **the module is enabled for the tenant** *and*
  **the user holds the permission**.
- `CORE_MODULES = { admin, database, settings, workflows, reports }` are always
  considered active.
- `can(user, perm)` (`auth.tsx` L369–379) returns `false` for a null user, honours
  a `system.admin.all` / `*` wildcard, then matches exact, `module.resource.*`,
  or `module.*` forms.

### 2.1 Route gating

`requiredPermForPath(path)` maps a path to the permission it needs;
`Shell.tsx` L184–188 renders `AccessDenied` when the user fails it:

    const perm = requiredPermForPath(path)
    if (!perm) return false
    return !itemVisible(user, { perm, module: perm.split('.')[0] })

Notable mappings:

| Path | Required permission |
| --- | --- |
| `/exports` | `admin.exports.run` |
| `/settings` | `admin.settings.view` |
| `/records/:mod/:res/:id` | `:mod.:res.view` (derived) |
| `/finance` | `finance.journals.view` |
| `/spend` | `expenditure.dashboards.view` |
| `/packing` | `qr.packing.scan` |
| `/labels` | `qr.templates.view` |
| `/plant/command` | `production.kpis.view` |
| `/plant/mrp` | `production.plans.view` |
| `/plant/*` (other) | `production.work_orders.view` |
| `/inventory-intel/*` | `inventory.stock.view` |
| `/sales/customers` | `sales.quotations.view` |
| `/sales/:x` | `sales.:x.view` |

**Two paths intentionally have no route gate:** `/security-jobs` and `/qr/:code`.
The API enforces `security_printing.jobs.view` and `qr.traceability.view`
respectively.

> **A hidden menu item and a route guard are usability affordances, not security
> controls.** Every one of these checks is duplicated server-side. Never treat a
> hidden control as a defence, and never "fix" a 403 by loosening the guard.

---

## 3. Dispatch order (why it matters)

`Shell.tsx` L190–229 is one ordered switch. Prefix matches are evaluated
top-to-bottom, so a **specific** route must be tested before a **broad** prefix that
would swallow it:

    /security-jobs  →  /qr/scan  →  /qr/:code  →  /packing  →  /labels
       … all matched BEFORE …
    /sales/*  and  /inventory/*

`/qr/:code` explicitly excludes the literal segment `scan` (L214) so that the
scanner and the trace view do not collide. When adding a route, **insert it before
any prefix that could shadow it**, and add a matching `requiredPermForPath` branch.

Terminal fallbacks: `detailMatch` → `EntityDetail`, `listMatch` → `EntityList`,
otherwise `AccessDenied`.

---

## 4. Active state, breadcrumbs, module context

- `moduleActive()` and `activeItem()` drive the rail highlight; `childActive()`
  drives the sub-item highlight. The active module is always visible in the rail
  and the active page in the breadcrumb, satisfying "where am I / what is this".
- `crumbsFor(path)` produces a **business** hierarchy, never a routing dump:
  `Finance / Receivables / Invoices / INV-2026-00421`, not
  `records / finance / table / 421`.
- `moduleChildrenFor()` returns a module's children for the contextual nav.

---

## 5. Badges

`BadgeKind = 'approvals' | 'exceptions' | 'inventory' | 'quality' | 'security'`.

Counts come from the single dashboard work endpoint, `/api/dashboard/work`, which
returns exception rows `{ code, label, hint, count, href, severity, persona }`
**filtered to `count > 0`**, with codes:
`approvals, followups, complaints, low_stock, orders, quotes, plant, ncr, secure, qr, ar`.

`Shell.tsx` reuses the **existing 45 s poll** to fetch this and maps rows to badges
via `countsByCode()`. Badge visibility is permission-gated, so a user never sees a
count for a queue they cannot open:

- `inventory` badge requires `inventory.stock.view`
- `quality` badge requires `quality.inspections.view`
- `security` badge requires `security_printing.jobs.view`

### 5.1 Known limitation (P2, unresolved)

`approvals` badge counts every row the endpoint returns, including rows that are
**decidable by a different approver** under segregation of duties. The badge can
therefore be non-zero for a user who can open none of those items. The correct fix
is a backend "decidable by me" filter; it has **not** been faked in the UI.

---

## 6. Focus mode

    focus = prefs.focusMode
         || isFocusPath(path)
         || (compact && (path === '/warehouse' || path.startsWith('/operator')))

Focus mode collapses sidebar, topbar chrome and secondary panels to give floor
operators a full-width, large-target surface. It is triggered by a **saved
preference**, an **explicit path list**, or the **compact breakpoint** — never by
role. That keeps factory/warehouse ergonomics available to any user who opts in,
and keeps role-keying out of the layout.

---

## 7. Keyboard (§124)

Implemented in `Shell.tsx` L110–146:

| Key | Action |
| --- | --- |
| `Ctrl/Cmd + K` | Open command palette |
| `/` | Open command palette (suppressed while typing in a field) |
| `Escape` | Close any open overlay (palette, drawer, help, notifications) |
| `S` | QR scanner |
| `A` | Approvals |
| `N` | Command palette |
| `?` | Keyboard help |
| `g` then `d` | Dashboard |
| `g` then `i` | Inventory |
| `g` then `p` | Plant / production |
| `g` then `w` | Warehouse |
| `g` then `f` | Finance |
| `g` then `b` | Buy / procurement |
| `g` then `c` | CRM |
| `g` then `e` | People / HR |

Letter shortcuts are guarded by `if (e.ctrlKey || e.metaKey || e.altKey) return` so
they never fire while the user is reaching for a chord, and bare letters are
suppressed while the caret is in an input. The in-app help panel advertises exactly
this list, including the `g`-sequence — advertising an unbound shortcut is a bug.

---

## 8. Rules for changing navigation

1. Add the route to the Shell dispatcher **before** any prefix that could shadow it.
2. Add a `requiredPermForPath` branch for the route, or document why the API is the
   only gate.
3. Add the entry to the correct `NAV_GROUPS` item with a real `perm` and useful
   `keywords` (the palette searches `label + keywords + href`).
4. Set `group` on the children when a module exceeds ~8 destinations.
5. Never add a destination without a permission — an unpinned item is visible to
   every authenticated user.
