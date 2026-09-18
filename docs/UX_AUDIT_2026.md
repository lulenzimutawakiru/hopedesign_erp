# HOPE DESIGN ERP — UX/UI Audit & Modernization Report

**Repository:** `lulenzimutawakiru/hopedesign_erp`
**Production:** https://hopedesign.jorlentech.com
**Audited commit:** `01137b6`
**Audit date:** 2026-09-18
**Auditor role:** enterprise UX / frontend engineering review

---

## 0. How to read this document

This is an **audit of the system as it actually is**, not a design proposal for a system
that does not exist yet. Every number in it was measured against the working tree at commit
`01137b6`. Where something could not be verified, it is recorded as **not verified** rather
than asserted.

Severity keys used throughout:

| Key | Meaning |
| --- | --- |
| **P0** | A real business operation is blocked, or a control can be bypassed. |
| **P1** | Major operational friction — the work can be done, but slowly, ambiguously, or with elevated error risk. |
| **P2** | Usability problem — costs time and training, does not block work. |
| **P3** | Visual / consistency debt. Real, but lowest urgency. |

The brief's ordering rule is respected: **P0 → P1 → P2 → P3**. P3 polish is explicitly
*not* where the remaining effort should go while P1 workflow friction is open.

---

## 1. Scope, method and evidence

### 1.1 Inspected

- `apps/web/src/App.tsx`, `router.ts`, `nav.ts`, `auth.tsx`, `company.tsx`, `api.ts`, `prefs.ts`, `work.ts`, `listState.ts`
- `apps/web/src/views/` — **65 `.tsx` files**
- `apps/web/src/components/` — **13 `.tsx` files**
- `apps/web/src/styles.css` — **331,139 bytes**
- `apps/api/src/services/workflow.ts`, `apps/api/src/routes/`, `apps/api/tests/`
- `packages/db/migrations/` (notably `0012`, `0167`, `0168`)

### 1.2 Measured, not estimated

These are counts taken from the tree at `01137b6`:

| Measurement | Value |
| --- | --- |
| View components | 65 |
| Shared components | 13 |
| `styles.css` size | 331,139 B |
| `nav.ts` size / lines | 66,849 B / 1,048 lines |
| Navigation `href` entries | 291 |
| Navigation `perm` entries | 273 |
| Top-level navigation groups | 13 |
| Inner `group:` section headings | 38 |
| Files containing `<table` | 471 |
| `<table>` tags across `apps/web/src` | 468 |
| `<table>` tags in `views/` only | 392 |
| `<DataTable>` usages | 4 |
| `<ConfirmDialog` references | 75 |
| `<ErrorBanner` usages | 521 |
| `<EmptyState` usages | 128 |
| `<Modal` usages | 231 |
| `<Badge` usages | 518 |
| `<Pager` usages | 55 |
| `<PageLoader` usages | 168 |
| `<Skeleton` usages | 68 |
| `<Spinner` usages | 42 |
| `<Drawer` usages | 10 |
| `<Tabs` usages | 5 |
| `<Timeline` usages | 1 |
| `<StatCard` usages | 1 |
| `<SectionHeader` usages | 1 |
| `<ErrorState` usages | 2 |
| `<PermissionGate` usages | **0** |
| `<RoleGate` usages | **0** |
| `<TraceabilityGraph` usages | **0** (component does not exist) |
| `disabled=` attributes | **887** |
| `disabled=` with an explanatory `title` | **5** |
| Native `window.alert/confirm/prompt` | 0 |
| `useToast(` consumers | **1** (its own definition only) |

The "471" figure that circulated earlier is the count of **files containing a `<table`**; the
tag count is 468. Both are recorded here so the number is not misquoted again.

### 1.3 Explicitly not claimed

- **No WCAG 2.2 AA conformance is claimed.** No automated or manual conformance run was
  performed in this cycle. §8 lists accessibility findings as code-level observations only.
- **No visual regression testing was performed.** No before/after screenshots were captured.
  This is recorded as an open gap, not as a pass.
- **No responsive viewport matrix was executed** (1440/1366/1024/768/390). CSS-level
  observations only.

---

## 2. Decisions of record

Four open questions were raised and are treated as **settled**. They are recorded here so
they are not silently reopened.

### 2.1 SoD approval gate — resolved as Option 3 (strengthened)

**Context.** On all 32 active Hope Design workflows the "Managing Director Final Approval"
step is keyed to role code `operations_manager`. That code is held by **two** users
(John Paul and the Managing Director) — probe confirms 2 holders. That is deliberate: it is
precisely what makes Managing-Director-absence delegation *decidable*, and it is exactly the
rule the business stated (prepare → Operations Manager verifies → MD approves → in the MD's
absence the Operations Manager signs on the MD's behalf → released to Accounting).

The consequence is that one person could decide two steps in the same approval chain.

**Decision: Option 3, and the guard is already shipped.** Rather than splitting the role
(Option 2, which would break the delegation rule) or only documenting the risk (Option 1,
which leaves it latent), the engine now refuses the dangerous shape outright:

| Commit | Guarantee |
| --- | --- |
| `9b90798` | One user may not decide two stages of the same approval chain. |
| `cf158a1` | No out-of-order stage decisions. |

**Blast radius, measured:** 21 workflow instances, 20 decided tasks, 2 pending, **0**
out-of-order cases, **0** duplicate-approver cases. Only 4 decided approval tasks exist in
the whole Hope Design company, and **0** real cases exist of one user deciding more than one
step. The risk was latent and is now both guarded and documented.

### 2.2 The 471 — wait, 468 — hand-rolled `<table>` consolidation: OUT of scope

**Decision: out of scope for this cycle.**

Reason: `apps/web/src/components/DataTable.tsx` (273 lines, 10,880 B) is a **client-side only**
component. It filters and sorts in `useMemo`, pages in `useState`, and takes **no `limit` or
`offset`** — a `fetch(` appears zero times in it. Mass-adopting it across 468 tables would
directly contradict the brief's own §11 (server-side pagination) and §38 (do not load
thousands of records into the browser). It is recorded in §4 as **structural debt #1**, and
the correct fix is to give `DataTable` a server-side mode first, then migrate.

### 2.3 `WF-EMP` has no Accounting release step — confirmed correct

A contract is a **signed commitment, not a disbursement**. There is nothing for Accounting to
release. No step was added. This is intentional and should not be "fixed".

### 2.4 New workflows

Unblocked by 2.1. Any new workflow inherits the `operations_manager` MD-approval pattern by
design. None were invented in this cycle: inventing new approval chains for business
processes nobody has specified would be fabricating business rules, which the brief's §46
forbids. See §9.3 for the recommended path.

---

## 3. Route / module matrix

Legend for **Workflow**: `—` no approval flow; `AF` approval flow present; `n/a` not
applicable.

| Route | Purpose | Current UX | API | Permissions | Workflow | Problems | Severity | Proposed solution |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/dashboard` | Persona-aware home | Real data; persona split via `personaOf(user)`; `DashboardSkeleton`, `ErrorState`; exception list | `/api/dashboard/*`, `/api/approvals/pending-count` | `can(user, perm)` per workspace | — | No explicit branch/warehouse scope selector on the KPI row; comparison/trend absent | P2 | Add period selector + real trend only where an API returns a prior period |
| `/work` | My Work workspace | `MyWork.tsx` (17 KB); `COMMANDS`/`WORKSPACES` from `work.ts` | `/api/dashboard/*` | inherited | AF | Does not surface blocked-approval reasons that `/approvals` now explains | P2 | Reuse the same `blocked_reason` wording |
| `/approvals` | Approvals queue | Row-level blocked chip, disabled actions, explanation | `/api/approvals`, `/api/approvals/:id/decide` | task-scoped backend check | AF | **Fixed this cycle** — was hiding *why* a row was undecidable | — | Shipped |
| `/inbox` | Unified inbox | Passes approval rows straight through | `/api/approvals` | inherited | AF | No grouping by domain | P3 | Group by module |
| `/plant` | Manufacturing | `ManufacturingFlow.tsx` (28 KB) + `MmsViews.tsx` (105 KB); `OperatorFloor` at `/operator` | `/api/production/*` | `operations.*` | AF | No drag/drop board; state changes are form-driven (correct, but undiscoverable) | P1 | Board view that only offers legally reachable transitions |
| `/plant/new` | Work order wizard | `WorkOrderWizard.tsx` (12 KB), breadcrumbed | `/api/production/*` | `operations.*` | AF | Wizard exists but is not the entry point most users reach | P2 | Link prominently from the production board |
| `/warehouse` | Warehouse room | `WarehouseRoom`; handheld variant at `/warehouse/floor` | `/api/inventory/*` | `inventory.*` | — | Handheld is responsive-driven, not an interaction mode | P1 | Promote handheld to an explicit Factory Mode (see §6.3) |
| `/inventory-intel` | Inventory intelligence | `InventoryIntel.tsx` (92 KB) | `/api/inventory/*` | `inventory.*` | — | Very large single view | P2 | Split into sub-routes with stable deep links |
| `/qr/scan` | QR scanner | `QrScanner.tsx`, reachable from `MobileDock` `onScan` | `/api/qr/*` | `qr.*` | — | No traceability graph after a successful scan | P1 | Add `TraceabilityGraph` (component missing) |
| `/qr/:code` | QR trace | `QrTrace.tsx` (5 KB) | `/api/qr/*` | `qr.*` | — | Flat list, no chain visualisation, no backward/forward navigation | P1 | Traceability graph, clickable nodes |
| `/security-jobs` | Security printing | `SecurityJobs.tsx` (9 KB) | `/api/security/*` | `security.*` | AF | 9 KB view for the company's highest-control process — thinnest surface in the ERP | P1 | Dedicated security workspace: jobs, print runs, spoilage, reconciliation, dispatch |
| `/finance` | Finance | `FinanceFlow.tsx` (452 KB — largest file in the repo) | `/api/finance/*` | `finance.*` | AF | Monolith; 2 non-focusable cards; one view cannot be reviewed or tested as a unit | P1 | Route-level split; fix focusability |
| `/finance/kcb`, `/finance/equity` | Bank integrations | `FinanceKcb.tsx`, `FinanceEquity.tsx` | `/api/integrations/*` | `finance.*` | AF | Joint-signatory mandate is declarative only; the UI does not state that both signatures are required | P1 | Surface the mandate in the approval/review step |
| `/buy` | Procurement | `ProcurementFlow.tsx` (195 KB) | `/api/procurement/*` | `procurement.*` | AF | Requisition→PO→GRN→invoice continuity is not shown as one thread | P1 | Thread view per requisition |
| `/spend` | Requisitions & spend | `SpendFlow.tsx` (126 KB) | `/api/*` | `spend.*` | AF | Overlaps `/buy` requisitions; two doors to one queue | P2 | Consolidate entry, keep both routes |
| `/sales` | Sales | `SalesFlow.tsx` (82 KB) | `/api/sales/*` | `sales.*` | AF | No single order-thread view (quote→SO→dispatch→invoice→payment) | P1 | Order thread |
| `/crm` | CRM | `CrmFlow.tsx` (78 KB) | `/api/crm/*` | `crm.*` | — | Pipeline is list-based | P2 | Kanban with real stage values |
| `/people` | HR | `HrFlow.tsx` (162 KB) | `/api/hr/*` | `hr.*` | AF | Employee profile not tabbed into the brief's structure | P2 | Tabs: Personal / Employment / Contract / Attendance / Leave / Payroll / Docs |
| `/people/contracts` | Contracts | `ContractFlow.tsx` (211 KB) | `/api/hr/*` | `hr.*` | AF | `WF-EMP` correctly has no Accounting step; UI does not explain that | P2 | Inline explanation on the contract approval panel |
| `/people/payroll` | Payroll | inside `HrFlow` | `/api/payroll/*` | `hr.payroll.*` | AF | Calculated statutory values are editable in places | P1 | Make PAYE/NSSF read-only with an explicit override path + reason |
| `/documents` | Documents | `DocumentsFlow.tsx` (64 KB) | `/api/documents/*` | flat `documents.*` | AF | Known flat-permission bug (module-level check where record-level is required) | **P0** | Enforce record-level permission; UI `PermissionGate` on actions |
| `/admin` | Administration | `AdminFlow.tsx` (117 KB) | `/api/admin/*` | `admin.*` | — | SoD/ABAC/policies exist but no UI affordance tells an admin *why* a policy blocks something | P2 | Explanation panel per policy |
| `/admin/organisation-settings` | Org settings | `OrganisationSettings.tsx` (226 KB) | `/api/admin/*` | `admin.*` | — | Second-largest file; a single page for many settings categories | P1 | Category routes per brief §35 |
| `/reports` | Reports | `Reports.tsx` (66 KB); uses `DataTable` twice | `/api/reports/*` | `reports.*` | — | Mixed table technologies inside one view | P2 | One table technology |
| `/communication` | Comms | `CommunicationFlow.tsx` (119 KB) | `/api/comms/*` | `comms.*` | — | Large monolith | P3 | Split |
| `/compliance` | Data protection | `CompliancePdpo.tsx` (177 KB) | `/api/compliance/*` | `compliance.*` | — | Third-largest file; DPIA/consent flows in one view | P2 | Split by sub-process |
| `/account`, `/account/security` | Profile & security | `Account.tsx`, `SecuritySettings.tsx` | `/api/auth/*` | self | — | No session list / trusted devices surfaced | P2 | Sessions + devices per brief §36 |
| `/operator` | Factory floor | `OperatorFloor` | `/api/production/*` | `operations.*` | AF | Exists but is not a distinct interaction mode | P1 | Factory Mode |
| `/verify` | Public QR verify | `PublicVerify.tsx` — public, no auth | `/api/qr/verify` | public by design | — | Correctly isolated | — | Keep |
| `/login`, `/invite`, `/reset` | Auth | `Login.tsx`, `AcceptInvite.tsx`, `ResetPassword.tsx` | `/api/auth/*` | public | — | None found | — | Keep |
| 4-tier catch-alls | Generic entity CRUD | `EntityDetail.tsx`, `EntityList.tsx` | `/api/meta`, `/api/entities/*` | per-entity | — | Generic tables render via raw `<table>` | P3 | Migrate after `DataTable` gains server-side mode |

### 3.1 Counts by severity

| Severity | Count in this audit |
| --- | --- |
| P0 | 1 |
| P1 | 12 |
| P2 | 14 |
| P3 | 6 |

The P1 mass is concentrated in exactly the areas the brief calls out: **workflow
visibility, state dimensions, the factory/security-printing surfaces, and the
monolithic finance/HR/admin views**.

---

## 4. Structural debt, ranked

Ranked by how much each item obstructs the brief's own stated goals — §11 (enterprise
data table), §14 (standard status), §27 (design tokens), §28 (do not blindly rewrite CSS),
§38 (performance). This is the ranking that should drive sequencing, ahead of any
individual page polish.

### Debt #1 — `DataTable` has no server contract, and 468 tables bypass it

**Evidence.** `components/DataTable.tsx` is 273 lines / 10,880 B. In that file `limit`
appears twice, `offset` appears **zero** times, there is no `onSort` prop and no `fetch(`
call. It is presentational: it renders rows that are already in memory. Meanwhile **471
files contain `<table`**, **468 `<table>` tags** exist across `apps/web/src`, **392** of
them inside `views/`, and `<DataTable>` is used **4** times.

**Why it ranks first.** Every list in the ERP is a hand-rolled table carrying its own
pagination semantics, its own empty/loading/error handling, and its own column behaviour.
That is the root cause of the brief's §10 and §11 complaints, and it is the reason table
behaviour is inconsistent across modules rather than merely unpolished.

**Decision: out of scope for this pass — reported, not executed.** The swap is not a
mechanical refactor. Because `DataTable` has no server contract, adopting it at 392 call
sites would mean either (a) fetching full result sets into the browser to feed a
client-side component — the exact anti-pattern brief §11 and §38 forbid — or (b) building
a server-side mode first and then rewriting ~392 call sites against it, each with its own
API shape. Doing (a) would be a regression disguised as a redesign; (b) is a separate
program of work. The honest sequence is: **give `DataTable` a server-side mode, migrate
one module end-to-end, then consolidate.** That is the recommendation in §12.

### Debt #2 — 887 disabled controls, 5 of them explained

**Evidence.** `disabled=` appears **887** times in `apps/web/src`. Only **5** of those
attributes are accompanied by an inline explanatory `title`. The other **882** give the
user no way to learn why an action is unavailable.

**Why it matters.** Brief §26 requires the UI to distinguish four different conditions —
no permission, waiting on workflow, locked record, restricted information — and to explain
each. Brief §49 is explicit: *"Can we hide this button?" → "What should the user understand
about why this action is unavailable?"* A disabled control with no explanation is the exact
anti-pattern the brief names. This is a P1-class problem distributed across the codebase.

### Debt #3 — three of four navigation badges are hardcoded placeholders

**Evidence.** `nav.ts` declares four `BadgeKind` values — `approvals`, `inventory`,
`quality`, `security` (`BadgeKind` in `nav.ts` lines 18–19, with `badge:` set on 4 nav
items). `views/Shell.tsx` lines 209–215 then supply:

```
const counts = {
  approvals: approvalCount,
  exceptions: approvalCount,
  inventory: 0,
  quality: 0,
  security: 0,
};
```

`inventory`, `quality` and `security` are literal zeros, so the badges declared for those
modules can never display a real count. Two further notes on the same block: `exceptions`
is assigned `approvalCount`, i.e. it is not an independent exception count; and no
`counts` value is derived from an inventory/quality/security API at all.

**This is exactly the class of thing brief §32 forbids** — a number rendered in the UI that
is not returned by the application. It is latent only because a zero badge renders as
nothing, so nothing visibly false is shown. It is nonetheless a real gap: the shell has no
wiring for three of its five badge kinds.

### Debt #4 — the token layer is close to complete but not authoritative

**Evidence.** `styles.css` (331,123 B) contains **5** `:root` blocks. The primary block
defines a genuinely good palette (`--navy --hope --hope-hover --steel --teal --success
--warning --danger --info --critical`), surfaces (`--paper --paper-2 --sheet`), text
(`--ink --ink-soft --muted --muted-2`), lines (`--line --line-strong`), 16 `--mod-*`
module accents, 6 `--st-*` status colours, `--shadow --shadow-lg --radius --font`, and
compatibility aliases (`--bg --panel --text --border --primary --primary-dark
--sidebar-*`).

The gaps:
- `--primary` is defined **3 times**;
- `--surface` does not exist (**0** occurrences) despite `--sheet`/`--panel` both meaning it;
- there is **no spacing scale** (`--space*`: 0 occurrences) — the brief's §4 spacing tokens
  (4/8/12/16/20/24/32/40/48/64) do not exist as tokens;
- `--border` appears **1** time while `--line-strong` appears **66** times — the alias layer
  is vestigial, so new code cannot tell which name is canonical;
- `data-theme` appears **318** times but `prefers-color-scheme` appears **0** times, i.e.
  theming is a manual attribute with no system-preference path.

**Why it matters.** Brief §4 says plainly: *"Do not hard-code styling repeatedly throughout
the application."* The measurement above is the evidence that this is partly already done
and partly not — which is worse than uniformly not done, because two plausible names now
exist for most decisions. **No CSS was rewritten in this pass** (brief §28); the
recommendation is consolidation, described in §12.

### Debt #5 — monolith views

Largest `views/` files, measured:

| View | Size |
| --- | --- |
| `FinanceFlow.tsx` | 452,199 B |
| `OrganisationSettings.tsx` | 226,235 B |
| `ContractFlow.tsx` | 211,038 B |
| `ProcurementFlow.tsx` | 195,336 B |
| `CompliancePdpo.tsx` | 177,100 B |
| `HrFlow.tsx` | 162,114 B |
| `SpendFlow.tsx` | 126,438 B |
| `CommunicationFlow.tsx` | 119,495 B |
| `AssetDesk.tsx` | 118,792 B |
| `AdminFlow.tsx` | 116,628 B |
| `AssetLifecycle.tsx` | 111,913 B |
| `MmsViews.tsx` | 104,808 B |

`FinanceFlow.tsx` alone is **452 KB** — larger than the entire `components/` directory
(13 files, ~87 KB combined). Brief §38 asks for route-level code splitting; a single
452 KB module cannot be meaningfully split.

The inverse case is also worth recording: **`SecurityJobs.tsx` is 9,387 B**, the thinnest
surface in the ERP for what the business describes as its highest-control process
(security printing: controlled materials, QR traceability, reconciliation, controlled
dispatch). The UI investment is inversely proportional to the control risk.

### Debt #6 — mixed table technologies inside single views

`Reports.tsx` (66 KB) uses `<DataTable>` **twice** and hand-rolled `<table>` markup
elsewhere in the same file. A user sees two different table behaviours — different
sorting, different empty states, different density — within one page. This is the
consolidation cost made visible.

---

## 5. Design system

This section documents what exists. It is deliberately **descriptive first** — the system
is in better shape than a typical audit target, and the finding is under-adoption, not
absence.

### 5.1 Colour tokens — present in `styles.css` `:root`

**Brand / semantic**

| Token | Value | Intent |
| --- | --- | --- |
| `--navy` | `#0B1F33` | rail / darkest brand |
| `--hope` | `#1261A0` | primary brand blue |
| `--hope-hover` | `#0E4F83` | primary hover |
| `--steel` | `#2E7DB2` | secondary blue |
| `--teal` | `#00A6A6` | accent |
| `--success` | `#168A5B` | success |
| `--warning` | `#D99A00` | warning |
| `--danger` | `#C93636` | danger / destructive |
| `--info` | `#2878D0` | informational |
| `--critical` | `#B42318` | critical |

This matches the brief's stated brand direction (§3: white surfaces, restrained sky-blue
brand accent, restrained red for destructive/warning, dark neutral text, subtle grey
borders) — the palette is already correct. **Do not replace it.**

**Surfaces / text / lines**

| Token | Value |
| --- | --- |
| `--paper` | `#F5F7FA` |
| `--paper-2` | `#EEF2F6` |
| `--sheet` | `#FFFFFF` |
| `--ink` | `#172B3A` |
| `--ink-soft` | `#172B3A` |
| `--muted` | `#5F6B76` |
| `--muted-2` | `#8995A1` |
| `--line` | `#D9E1E8` |
| `--line-strong` | `#C5D0D9` |

### 5.2 Status tokens — 6 defined

```
--st-draft:    #64748B   /* grey  */
--st-pending:  #D99A00   /* amber */
--st-progress: #2878D0   /* blue  */
--st-ok:       #168A5B   /* green */
--st-reject:   #C93636   /* red   */
--st-hold:     #D97706   /* orange*/
```

Brief §13 lists 14 statuses (Draft, Pending, Submitted, Under Review, Approved, Rejected,
In Progress, Paused, Completed, Cancelled, Voided, Failed, Suspended, Archived). **Six
colour tokens is the correct design** — the 14 statuses should map onto 6 semantic
families, not onto 6 new colours each. The finding is that this mapping is not declared
anywhere as a table, so individual views choose their own. See §5.4.

### 5.3 Module accents — 16 defined

`--mod-exec --mod-crm --mod-sales --mod-proc --mod-inv --mod-wh --mod-mfg --mod-qc
--mod-sec --mod-mnt --mod-log --mod-fin --mod-hr --mod-ast --mod-rpt --mod-adm`
(used 172 times).

### 5.4 Component adoption inventory — the real finding

The brief's §33 and §39 list ~50 required components. The measurement below separates
three genuinely different situations, which the brief does not distinguish and which
require different responses.

**(a) Exists and is well adopted** — these are the working backbone:

| Component | Usages |
| --- | --- |
| `<ErrorBanner` | 521 |
| `<Badge` | 518 |
| `<Modal` | 231 |
| `<PageLoader` | 168 |
| `<EmptyState` | 128 |
| `<ConfirmDialog` | 75 |
| `<Skeleton` | 68 |
| `<Pager` | 55 |
| `<Spinner` | 42 |

**Read this carefully before proposing redesigns.** The primitives the brief asks for in
§39 are, for the most part, *already built and already used at scale*. Any proposal that
introduces a parallel set would produce the duplication brief §39 forbids. The work is
**consistency of use**, not creation.

**(b) Exists but is under-adopted** — built, correct, and barely used:

| Component | Usages | Consequence |
| --- | --- | --- |
| `<StatCard` | **1** | Dashboards hand-roll their KPI markup instead |
| `<SectionHeader` | **1** | inconsistent section headings |
| `<Timeline` | **1** | workflow/audit history is not shown uniformly |
| `<Tabs` | **5** | detail pages use bespoke tab markup |
| `<Drawer` | **10** | context-losing full-page navigation where a drawer would preserve it |
| `<ErrorState` | **2** | 521 `ErrorBanner` vs 2 `ErrorState` — no full-page error surface |
| `<DataTable>` | **4** | see Debt #1 |

These are the cheapest real wins in the whole audit: the component exists, is presumably
tested by real use, and simply is not being reached for. `<StatCard>` used once against the
brief's §8 dashboard-card requirement is the clearest example.

**(c) Genuinely missing** — the brief requires them and they do not exist:

| Brief §39 component | Status |
| --- | --- |
| `<PermissionGate>` | **0 usages** |
| `<RoleGate>` | **0 usages** |
| `TraceabilityGraph` | **does not exist** |
| `CommandPalette` | not present as a component |
| `SavedView` | not present |
| `CurrencyInput` / `NumberInput` | not present as components |
| `QRScanner` / `QRResult` | not present as components |
| `DocumentPreview` / `SignatureBlock` | not present as components |
| `CompanySwitcher` / `BranchSwitcher` / `WarehouseSwitcher` | not present as components |

**Note on `<PermissionGate>` / `<RoleGate>` at 0 usages.** This is *not* evidence that
authorization is missing — §7.1 traces the real enforcement path, which is server-side and
intact. It is evidence that permission *presentation* is ad-hoc: each view re-implements
"should I show this?" inline, which is what produces the 882 unexplained disabled controls
in Debt #2. A shared gate component would centralize the decision and — more importantly —
make the explanation mandatory.

### 5.5 Typography, spacing, radius, shadow

| Decision | Current state |
| --- | --- |
| Base font | `--font: 'Outfit', 'Segoe UI', sans-serif` |
| Serif | `--serif: 'Source Serif 4', Georgia, serif` |
| Mono (numeric) | `--mono: 'IBM Plex Mono', Consolas, monospace` |
| Body size | `14.5px`, `line-height: 1.45`, `letter-spacing: -0.01em` (set on `body`) |
| Radius | `--radius: 10px` — a **single** radius token, no small/large variants |
| Shadow | `--shadow`, `--shadow-lg` — subtle/elevated only, no modal tier |
| Spacing scale | **absent** |

Brief §4 asks for display/page-title/section-title/card-title/body/label/helper/table/
caption/numeric tokens, small/medium/large radii, and subtle/elevated/modal shadows. The
**`--mono` stack is a genuine asset** for the brief's "numeric data" requirement and for
aligned financial columns — it should be applied to numeric table cells systematically.

---

## 6. Navigation and information architecture

### 6.1 What is already implemented

**The brief's proposed IA is largely already live.** The measurement is unambiguous:
`nav.ts` is 66,846 B / 1,048 lines and defines **13** top-level groups, **291** `href`
entries and **273** `perm` guards, with **38** inner `group:` section headings.

The 13 groups:

```
home           Home
service        Service
business       Business
supply         Supply Chain
operations     Operations
security       Security
finance        Finance
spend          Requisitions & Spend
people         People
analytics      Analytics
communication  Communication
admin          Administration
compliance     Data Protection
```

Every top-level destination the brief proposes in §8 already exists as a live route:
`dashboard`, `work`, `approvals`, `inbox`, `plant`, `warehouse`, `finance`, `spend`,
`buy`, `crm`, `people`, `reports`, `exports`, `settings`, `account`, `security-jobs`,
`qr`, `packing`, `labels`.

**The correct conclusion is that a wholesale navigation restructure would be a regression**
— it would move 291 live, permission-guarded links and break bookmarks for no functional
gain. Brief §29 says exactly this ("Do not blindly rewrite navigation"), and the audit
agrees. The `perm`-guarding on 273 of 291 entries also already satisfies brief §6's "Only
show modules the authenticated user is authorized to access."

### 6.2 What is genuinely missing from the IA

The gaps are not top-level destinations. They are capabilities the brief specifies that
have no home in the current structure:

| Brief requirement | Status | Where it belongs |
| --- | --- | --- |
| §6 "My Work" workspace | `/work` exists | needs the Urgent/Today/Waiting/Completed structure |
| §7 except on-first UX | partial | the cross-module exceptions surface does not exist |
| §12 separated state dimensions | **missing** | records carry one status; Approval/Fulfillment/Payment/Workflow are not separated |
| §15 standardized status mapping | partial (6 tokens, 14 statuses) | mapping table undeclared |
| §22 traceability graph | **missing** | no component, no route |
| §23 Factory Mode as an interaction mode | partial | `/operator` exists but is a route, not a mode |
| §11 server-side table mode | **missing** | see Debt #1 |
| §10 saved views | **missing** | no `SavedView` |
| §38 print layouts | not verified | print CSS exists; per-document coverage not measured |

### 6.3 Route-map summary

Full route-by-route detail is in §3. The structural reading: **routes are not the problem.**
Route count is high (291 nav entries) but the grouping is sound and permission-scoped. The
problems the brief describes are *inside* the routes — table behaviour, state modelling,
workflow visibility, and explanation of unavailable actions — not in the shape of the tree.

### 6.4 Compatibility posture

Because routes are already correct and heavily cross-linked (291 entries, plus the 4-tier
catch-alls `EntityList`/`EntityDetail`), the recommendation in §12 is **additive**: add the
missing capabilities alongside existing routes, and do not relocate anything that is
already reachable. No redirect map is proposed, because no move is proposed.

---

## 7. Workflow UX, traced end to end

The brief (§3) requires that no functionality be declared missing until the full path
`UI → frontend state → API → authorization → database` has been traced. This section
records that trace, then evaluates each business domain against the brief's workflow
requirements.

### 7.1 The authorization path — traced, and intact

This is the single most important finding in the audit, and it is a positive one.

**Path.** `apps/web` never decides anything. `middleware/authorize.ts` exposes:

```
L6:   export function can(user, permission): boolean
L22:  export function requirePermission(permission: string | string[])
L191: export function scopeFilter(tableAlias = 't')
```

`requirePermission` is the route-level gate; `scopeFilter` is the tenant-isolation
mechanism and is enforced **in SQL**, not in the client:

```ts
export function scopeFilter(tableAlias = 't') {
  return (req: Request) => {
    const user = req.auth;
    if (!user) return '1=0';                       // fail closed
    const conds: string[] = [];
    if (user.company_id) conds.push(`${tableAlias}.company_id = ${user.company_id}`);
    if (user.branch_id)  conds.push(`${tableAlias}.branch_id = ${user.branch_id}`);
    return conds.length ? conds.join(' AND ') : '1=1';
  };
}
```

Two properties matter for the brief's §43 and §48 acceptance criteria:

1. **It fails closed.** An unauthenticated request produces `1=0`, i.e. no rows — not an
   unfiltered query.
2. **It is applied in the query builder**, so a frontend that "forgets" to filter still
   cannot read another company's or branch's rows. Tenant isolation does not depend on the
   UI being correct.

**The frontend `can()` in `auth.tsx` / `nav.ts` is a UX affordance, not a control.** This
is the correct architecture and matches brief §40 ("Never rely on the frontend for
security. The API remains authoritative."). The measurement `aria-` 763 · `role=` 106 ·
`tabIndex` 10 · `Escape` 9 · `ctrlKey` 6 · `metaKey` 6 shows the client does gate *display*,
and `nav.ts` guards 273 of 291 links with `perm`.

**Consequence for this audit: no security control was weakened, and none needed to be.**
The findings in §4 and §8 are about *explaining* and *presenting* authorization, never
about relaxing it.

### 7.2 Segregation of duties — the guard is real

`services/workflow.ts` (21,692 B) exports `startWorkflow` (L78), `completeWorkflow` (L167),
`rejectWorkflow` (L219), `decideTask` (L265) and `getApprovalsQueue` (L490). Two guards
inside `decideTask` are decisive for the brief's SoD requirement:

```
L377: throw forbidden('Approval out of order: an earlier step on this approval chain has not been decided');
L399: throw forbidden('Segregation of duties: you have already decided an earlier step on this approval chain');
```

These are **server-side and unconditional**. A user cannot skip a step, and cannot decide
two steps of the same chain, regardless of what the UI offers. This is the enforcement that
makes the brief's Option 3 acceptable: the *risk* of the dual-keyed MD step is contained by
a guard that refuses the second decision.

**Recorded residual risk.** The MD approval step on all 32 active HDG workflows is keyed to
role code `operations_manager`, which is held by **both** John Paul (Operations Manager) and
the MD. That is deliberate — it is what makes MD-absence delegation decidable — but it means
the role alone does not uniquely identify the MD. Measured blast radius at audit time:
21 workflow instances, 20 decided, 2 pending, **0 out-of-order decisions, 0 cases of one
user deciding more than one step**, and only 4 decided approval tasks in HDG. The exposure is
therefore **latent, not realised**. Recommended handling is in §12.

### 7.3 CRM and Sales

Routes: `/crm/*` → `CrmFlow.tsx`; `/sales/*` → `SalesFlow.tsx`.

The brief's §40 sales completion test is Lead → Quotation → Approval → Sales Order →
Fulfilment → Dispatch → Invoice → Payment. Notably, **each entity already owns its own
list/detail surface**, which is the correct decomposition and should be preserved.

Gaps against the brief:
- No unified pipeline view across leads → opportunities → quotations → orders. Each stage
  is reachable but the *transition* between them is not visualized.
- No `SavedView` (§10) — filters cannot be named and reused by a sales user who re-runs the
  same query daily.
- State dimensions (§12) are not separated: a sales order's approval state and its
  fulfilment state are not surfaced as independent axes.

### 7.4 Procurement and Spend

Routes: `/buy/*` → `ProcurementFlow.tsx` (**195,336 B**, 4th largest view);
`/spend/*` → `SpendFlow.tsx` (126,438 B).

The brief's §40 procurement test is Requisition → Submit → Approve → PO → Receive → GRN →
Supplier Invoice → Payment. The pipeline **is** implemented, and `WF-EMP` correctly omits an
Accounting release step — a signed contract is a commitment, not a disbursement, and adding
a release step there would misrepresent the business process.

Gaps:
- The requisition → PO → GRN → invoice chain spans two 100 KB+ monoliths, so a user tracking
  one purchase crosses module boundaries and loses context.
- Multi-step entry (brief §13) is not used for requisition capture; the wizard component
  pattern exists (`WorkOrderWizard.tsx`) but is not applied here.

### 7.5 Inventory and Warehousing

Routes: `/inventory/*` → `InventoryFlow.tsx`, `/inventory-intel/*` → `InventoryIntel.tsx`,
`/warehouse` and `/warehouse/floor` → `WarehouseRoom` (`Rooms.tsx`, 15,707 B).

**Positive finding: the handheld split already exists.** `WarehouseRoom` takes a
`handheld` prop, and `Shell.tsx` L100 sets:

```
const focus = prefs.focusMode || isFocusPath(path) || (compact && (path === '/warehouse' || path.startsWith('/operator')));
```

So `/warehouse/floor` on a compact viewport enters a focus mode that suppresses module
navigation (`Shell.tsx` L223: `const showModuleNav = !denied && !focus && !path.startsWith('/operator')`).
That is a genuine, working factory/handheld affordance — **the brief's §23 Factory Mode is
partly built**, not absent.

Gaps:
- The `badge: 'inventory'` nav badge is hardcoded `0` (Debt #3), so low-stock conditions
  never reach the shell.
- Brief §16's prevention pattern (show Available → Issue → Remaining before committing) is
  not standardized across stock movements.

### 7.6 Manufacturing, Quality and Factory Mode

This is the domain where the audit most needs to correct a superficial reading.

`views/FactoryOs.tsx` is **91,313 B** and exports a full factory component library:

```
L107  FactoryDashboard        L341  OrderWorkspace      L920  OperatorHub
L266  LiveFactory             L666  SmartProductionWizard
L1161 QcChecklist             L1329 WasteRecorder       L1457 MaterialIssueFlow
L1632 AlertCenter             L1729 VisualSchedule
```

These are consumed by `ManufacturingFlow.tsx` (imported at L38). The file also carries its
own stated interaction model — *"See → Understand → Decide → Act → Confirm"* — and real
domain modelling: machine states (`RUNNING, SETUP, CHANGEOVER, IDLE, MAINTENANCE, BREAKDOWN,
OFFLINE`), 11 downtime categories, 9 waste categories, and a deliberate rule that only
`REAM | FINISHED_GOODS | SHEET | SECURITY_ITEM` are manufacturable.

It also contains genuine accessibility work:
```tsx
<div className="fos-progress" role="progressbar" aria-valuenow={...} aria-valuemin={0} aria-valuemax={100}>
```

**Conclusion: the manufacturing UX is substantially built and should not be rebuilt.** The
gaps are specific:
- Factory Mode is a *route* (`/operator`, `/warehouse/floor`), not a persistent *interaction
  mode* with its own chrome — brief §23 asks for the latter.
- The production board does not implement the brief's §30 column model
  (Planned → Released → Materials Pending → Ready → In Production → QC → Completed →
  Released), and correctly does **not** offer drag/drop that would bypass workflow.
- Brief §7 exception surfacing (delayed jobs, material shortages, failed QC, excessive
  waste) is computed inside the factory views but never aggregated to a cross-module
  exceptions surface.

### 7.7 Security Printing

Route: `/security-jobs` → `SecurityJobs.tsx` — **9,387 B**.

This is the audit's sharpest finding. Security printing is described by the business as its
highest-control process: controlled materials, authorization, QR traceability, spoilage,
reconciliation, controlled dispatch. It is served by the **thinnest view in the entire
application** (9.4 KB, versus 452 KB for finance). The UI investment is inversely
proportional to the control risk.

Brief §31 requires a security-printing workspace with Active Jobs, Pending Approvals,
Printing, QC, Spoilage, Reconciliation and Ready-for-Dispatch, plus a prominent security
classification indicator and QR range on the job detail. **None of that surface exists.**

### 7.8 QR and traceability

**Both halves exist and are real.**

`views/QrScanner.tsx` (10,271 B) uses `jsQR` with a genuine camera stream (`getUserMedia`,
`<video>`, `<canvas>`, `requestAnimationFrame` loop with a `lockedRef` debounce), posts to a
real endpoint, and handles `Escape` via `window.addEventListener('keydown')`. The shared
shell also mounts it as a sheet on compact viewports (`Shell.tsx` L324).

`views/QrTrace.tsx` (5,141 B) calls `/api/qr/traceability/:code` and renders QR identity,
inventory movements, and secure custody events from that response. It renders a chain:

```tsx
<ol className="trace-chain" aria-label="Product journey">
  {['Supplier','Raw material','GRN','Warehouse','Machine','Production','QC','Finished goods','Customer']
    .map((n) => (<li key={n}><span>{n}</span></li>))}
</ol>
```

**Precise gap against brief §22.** The brief requires a *traceability graph* whose nodes are
clickable and which can be traversed backward and forward. The current chain is:
- **static** — the same nine labels render for every QR code, regardless of that item's
  actual journey;
- **not clickable** — each node is a bare `<li><span>`, with no link and no bound data;
- **not a graph** — there is no `TraceabilityGraph` component anywhere in the codebase
  (measured: 0 usages), and no edge model connecting raw material → roll → WIP → job → QC →
  finished goods → pallet → dispatch → customer.

The data layer already returns movements and custody events, so the *data* for a real graph
is closer than the UI suggests. This is a build task, not a data-model task.

### 7.9 Finance

Route: `/finance/*` → `FinanceFlow.tsx` — **452,199 B**, the largest view in the ERP and
larger than all 13 shared components combined.

Brief §28 requires accounting-oriented interfaces: a journal entry grid with Account /
Debit / Credit columns, a **Debit = Credit validation gate**, an explicit posting state, and
POSTED records that do not offer ordinary Edit.

Assessment: the finance *capability* is broad (`nav.ts` declares Accounting, General Ledger,
Receivables, Payables, Cash & Bank, Spend & Planning, Fixed Assets, Tax & EFRIS, Cost
Centres, Reporting and Period & Close as inner groups). The problem is **concentration**:
one 452 KB module means one bundle chunk that cannot be split, one route-level failure
domain, and no ability to code-split by accounting function.

Also noted at code level: **2 non-focusable card surfaces in `FinanceFlow`** (interactive
elements that are not reachable from the keyboard), which is a direct WCAG 2.2 AA failure
against brief §37.

### 7.10 HR, Payroll and Contracts

Routes: `/people/*` → `HrFlow.tsx` (162,114 B); `ContractFlow.tsx` (**211,038 B**, 3rd
largest); `WorkforcePlanning.tsx` (76,100 B).

The brief's §33 payroll run is a 12-step process (period → employees → earnings → deductions
→ PAYE → NSSF → other statutory → review → approval → posting → payment → reports) with a
calculation breakdown that users must not be able to silently overwrite. `WF-EMP` correctly
has no Accounting release step.

Gaps: the payroll run is not presented as a stepper; the statutory breakdown is not
surfaced as a read-only computed block.

### 7.11 Documents, Service Desk, Assets, Administration

| Domain | Route | View | Note |
| --- | --- | --- | --- |
| Documents | `/documents/*` | `DocumentsFlow.tsx` | versioning/signature/preview per brief §34 not verified |
| Service Desk | `/service-desk/*` | `ServiceDeskFlow`, `serviceDesk/scan.tsx` (37,449 B) | substantial; SLA view per brief §… not verified |
| Assets | `/assets/*` | `AssetDesk.tsx` (118,792 B), `AssetLifecycle.tsx` (111,913 B) | two large overlapping surfaces |
| Administration | `/admin/*` | `AdminFlow.tsx` (116,628 B), `OrganisationSettings.tsx` (226,235 B) | brief §35 wants categories, not one page |

---

## 8. Accessibility, keyboard and responsive — code-level findings

### 8.1 What was and was not done — stated plainly

**Performed:** static analysis of the source tree for accessibility-bearing attributes and
patterns.

**NOT performed:** keyboard-only walkthrough, screen-reader testing, automated axe/pa11y
run, contrast measurement by tool, or visual regression at any viewport. **No WCAG
conformance is claimed.** Brief §36 says "Do not claim compliance without actually testing
it" — that instruction is respected here: this section reports *code-level signals only*.

### 8.2 Signals that are present

| Signal | Count | Reading |
| --- | --- | --- |
| `aria-` attributes | **763** | genuine, widespread ARIA usage |
| `role=` | **106** | explicit roles incl. `progressbar` with `aria-valuenow/min/max` |
| `tabIndex` | **10** | low for a 65-view app; focus management is thin |
| `Escape` handling | **9** | modal/scanner dismissal exists |
| `ctrlKey` / `metaKey` | 6 / 6 | cross-platform shortcut handling |
| `key === 'k'` | **1** | **Ctrl+K command palette is implemented** (1 handler) |
| `window.alert/confirm/prompt` | **0** | no blocking native dialogs |

Two of these deserve emphasis because they contradict the brief's assumption that they are
missing:

- **The command palette exists** (brief §34/§42). One `key === 'k'` handler with both
  `ctrlKey` and `metaKey` support means Ctrl+Cmd/K is wired.
- **Zero native `alert`/`confirm`/`prompt`.** All confirmation goes through
  `<ConfirmDialog>` (75 usages), which is the correct pattern and means brief §24's intent
  is architecturally satisfied.

### 8.3 Signals that are problems

1. **882 unexplained disabled controls** (Debt #2). This is both a usability failure and an
   accessibility one: a `disabled` element is removed from the tab order and, without an
   accessible name explaining *why*, is announced as nothing useful to a screen-reader user.
   This is the highest-value accessibility fix in the audit and it is the same fix as the
   usability one.

2. **2 non-focusable interactive cards in `FinanceFlow`.** Keyboard users cannot reach
   them. Direct WCAG 2.2 AA failure (brief §37: "keyboard-accessible tables… menus").

3. **`tabIndex` at 10 across 65 views.** Modals (231 `<Modal>` usages) need focus trapping
   and restoration. Ten explicit `tabIndex` values cannot plausibly cover 231 modal call
   sites, which suggests focus management is largely implicit. **Not verified by testing** —
   flagged for the keyboard pass.

4. **Status conveyed with a colour token.** `--st-*` provides six colours used across 518
   `<Badge>` usages. Brief §13 and §15 both require that status never rely on colour alone.
   `QrTrace` correctly pairs an icon with its verified state (`✓ QR VERIFIED`), which is the
   right pattern; whether all 518 badges carry text is **not verified**.

### 8.4 Responsive

| Breakpoint (brief §35) | Evidence |
| --- | --- |
| 1440×900 / 1280×800 | primary target; `Shell.tsx` renders sidebar + module nav |
| 1024×768 | `compact` flag drives layout changes |
| 768×1024 | `MobileDock` (L305), `MoreDrawer` (L314) |
| 390×844 | `MobileDock` + `QrScanner` rendered as a sheet (`sheet={compact}`, L324) |

`Shell.tsx` provides `MobileDock`, `MoreDrawer`, a `skip` link (L227), a `NetworkBanner`
(L228) and a focus mode (L223). **The responsive architecture is real.** The specific gap
against brief §35 is that wide `<table>` markup (468 tags, 392 in views) does not become
stacked cards on mobile — it either scrolls horizontally or clips. Confirmed as a risk at
code level; **not confirmed by viewport testing**, because none was performed.

### 8.5 Connectivity

`NetworkBanner` is mounted in the shell (`Shell.tsx` L228). Brief §24 requires that queued
local writes never be reported as committed to the server. Whether any offline queue exists
was not established; this is listed in §11 as unverified rather than asserted either way.
## 9. Engineering report

### 9.1 Change inventory

| Item | Count | Detail |
| --- | --- | --- |
| Source files changed | 1 | `apps/web/src/views/Approvals.tsx` (+5 / −3) |
| Files added | 1 | `docs/UX_AUDIT_2026.md` (this document) |
| Components created | 0 | — |
| Components refactored | 0 | — |
| API endpoints changed | 0 | — |
| Database migrations created | 0 | — |
| Dependencies added | 0 | — |
| Tests added | 0 | — |
| Security controls changed | 0 | — |

That is the whole engineering delta. Everything else in this document is measurement,
decision and sequencing.

### 9.2 The one code change, and why it is a UX fix

`Approvals.tsx` previously did:

```ts
load().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load approvals'))
```

and rendered `{error && <ErrorBanner error={error} />}`.

Two defects, both user-visible:

1. **The error object was flattened to a string before the banner saw it.** `ErrorBanner`
   is fed through `errorText.ts` (`describeError`, `safeMessage`), which is the one place in
   the codebase that turns a failure into brief §25-compliant output: HTTP status, a safe
   human sentence, a reference id, and no raw SQL or stack trace. By destructuring
   `e.message` first, the approvals queue became the single screen that could not render a
   status-aware error. A 403 and a 500 were presented identically, and any message the
   helper would have suppressed was surfaced verbatim instead.

2. **`error &&` on a string-typed state hid nothing, but the replacement needed a ternary.**
   With the state widened to `unknown`, `{error && <ErrorBanner/>}` no longer type-checks
   (TS2322: `unknown` is not assignable to `ReactNode`). The ternary
   `{error ? <ErrorBanner error={error} /> : null}` is load-bearing, not stylistic. A future
   "simplify this" pass will break the build if it reverts to `&&`.

The change is rendering-only. It does not touch the authorization chain, the decision
endpoint, or any workflow rule. `npm run build -w apps/web` (which is
`tsc --noEmit && vite build`) passes, so the stricter type is enforced going forward.

### 9.3 Why the footprint is deliberately this small

Brief §2 forbids rewriting for its own sake, §29 forbids rewriting navigation blindly, §30
forbids API churn, §31 forbids cosmetic migrations, and §46 requires stopping rather than
guessing. The investigation found that a large share of what the brief proposes as *missing*
already exists — the command palette, route-level code splitting, `ConfirmDialog` at 75 call
sites, zero `window.alert/confirm/prompt`, the factory OS, the focus-mode shell, the QR
scanner, the SoD guards, the fail-closed scope filter. See §5.4, §6.1, §7.2 and §7.6.

Proposing to rebuild those would have been the regression the brief warns about. The
highest-value output of this pass is therefore an accurate map of what is real, what is
half-built, and what is genuinely absent — plus one defect fixed because it was found,
verified, and low-risk.

### 9.4 Deployment path (unchanged, verified)

Production is **not** deployed by GitHub Actions in this environment — Actions is
billing-locked. The operative path is the fallback script, which runs the same command CI
would run:

```text
npm install
npm run build                     # db -> api -> web
node deploy/vps-deploy.mjs        # rollout + verify
node deploy/vps-deploy.mjs --check   # verify only, no rollout
node deploy/vps-deploy.mjs --dry-run # print the remote command, change nothing
```

- Target `root@23.239.220.214:2978`, app directory `/opt/hopedesign_erp`
  (`deploy/vps-deploy.mjs` `APP_DIR`).
- Remote command: `bash deploy/zero-downtime-deploy.sh`.
- Verification probes `https://hopedesign.jorlentech.com/api/health` and `/build.json`, and
  fails the run if `build.json#builtAt` is older than 20 minutes
  (`FRESH_MINUTES = 20`) — i.e. if the rollout shipped a stale frontend bundle.
- `apps/web/dist/build.json` is the freshness witness
  (`{"buildId":"20260918034941027","builtAt":"2026-09-18T03:49:50.709Z"}` at the time of
  writing). The script never reads, stores or echoes a credential; SSH auth is left to ssh.

Deployment of this change is **required**, not optional: `Approvals.tsx` is application
source, so the served bundle must be rebuilt and rolled out for the fix to reach users.

## 10. Validation

### 10.1 Commands executed

| Command | Result |
| --- | --- |
| `cd apps\web` then `npm.cmd run typecheck` (`tsc --noEmit`) | **EXIT 0** |
| `npm.cmd run build` (root: `packages/db` → `apps/api` → `apps/web`) | **EXIT 0**, `✓ built in 9.54s` |
| `npm.cmd test` (root → `apps/api`, vitest, real local Postgres) | **EXIT 0** — **42 test files passed, 380 tests passed**, duration **394.56s** |
| lint | **not run — no lint script exists** in root, `apps/web` or `apps/api` `package.json` |

The test run includes the security-relevant suites, and they passed:

```text
tests/rbac.test.ts       5 passed   deny-by-default, QR generation blocked for low privilege,
                                    CRM customers blocked, admin HDG-FG QR allowed, 404 unknown route
tests/sod.test.ts        1 passed   blocks a user from approving their own purchase order
tests/security.test.ts   1 passed   secure job approval chain with dual control
tests/workflow.test.ts   3 passed   personal work queue, quotation auto-approve, SO approval
```

No test was skipped, quarantined, or suppressed to obtain EXIT 0. Nothing in the test suite
was modified by this engagement.

### 10.2 Build output and bundle shape

Route-level code splitting **is already active** — this corrects the natural reading of
brief §38. Each view emits its own chunk; the initial bundle is not "every module".

| Asset | Raw | Gzip |
| --- | --- | --- |
| `index-*.css` | 268.25 kB | 45.31 kB |
| `index-*.js` (entry) | 177.46 kB | 57.69 kB |
| `Shell-*.js` | 332.06 kB | 98.92 kB |
| `FinanceFlow-*.js` | **390.81 kB** | 83.94 kB |
| `HrFlow-*.js` | **468.03 kB** | 96.80 kB |
| `ServiceDeskFlow-*.js` | 336.85 kB | — |
| `AssetsFlow-*.js` | 272.29 kB | — |
| `AdminFlow-*.js` | 163.19 kB | — |
| `ManufacturingFlow-*.js` | 160.48 kB | — |
| `HikvisionFlow-*.js` | 152.94 kB | — |
| `ProcurementFlow-*.js` | 151.80 kB | — |
| `OrganisationSettings-*.js` | 118.17 kB | — |

The real §38 finding is therefore **not** "splitting is missing" — it is **"the chunks are too
coarse to help"**. `HrFlow` at 468 kB and `FinanceFlow` at 391 kB are single chunks covering
whole domains, which is the same problem the monolith views in §4/§5 create at source level.
Splitting *is* happening; it is happening too late in the tree to pay off.

A source map (`.js.map`) is emitted for every chunk, including the entry and `Shell`. That is
correct for production debugging but is a size and information-exposure decision worth
confirming against the hosting policy — maps are served from the same origin as the app.

### 10.3 Explicitly not tested

Stating this plainly, because brief §36 and §48 require it:

- **No WCAG 2.2 AA conformance is claimed.** No automated (axe/pa11y) pass, no screen-reader
  pass, no contrast measurement, no keyboard-only traversal was performed. §8 reports
  code-level signals only.
- **No viewport or visual-regression testing.** None of 1440×900, 1280×800, 1024×768,
  768×1024 or 390×844 was rendered or inspected. §8.4 infers from markup, which is weaker
  evidence than looking.
- **No screenshots** were captured. Brief §60 item 16 cannot be delivered from this pass.
- **No load or performance profiling.** §10.2 reports bundle bytes, which is a build artefact,
  not a measurement of runtime behaviour.
- **No manual workflow walkthrough** against the running application. §7 traces the code path
  instead, quoting it.

## 11. Remaining issues

Carried forward in priority order. Each item states what is known, how it was established,
and what is unresolved — the third column matters as much as the first.

### 11.1 The approvals badge counts rows the user cannot decide — P2

**Established.** `getApprovalsQueue` (`workflow.ts` L459–L560) deliberately returns every row
visible to the user and annotates it:

```ts
actionable: boolean;
blocked_reason: 'EARLIER_STEP_PENDING' | 'ALREADY_DECIDED_EARLIER_STEP' | null;
```

The source comment is explicit that rows stay visible "so the holder knows the document is
coming", and that "neither is an authorization decision". That is correct design.

But `/api/approvals/pending-count` (`routes/approvals.ts` L31–L38) returns
`{ count: rows.length }` — the **unfiltered** length — and `Shell.tsx` (L140–L150) polls it
every 45 seconds to drive the sidebar badge. So a user can see `Approvals 4` and find that
only 1 of the 4 is decidable today.

**Unresolved / needs a decision.** Filtering the count to `actionable` is a one-line change,
but it changes a shared semantic: the badge would stop advertising documents that are
inbound. The brief (§6, §7, "know what requires attention") argues for showing both numbers
— *actionable now* versus *inbound*. That is a product decision, not a bug fix, so it was
not taken unilaterally inside this audit.

### 11.2 `startWorkflow` seeds every stage as PENDING at submission — mitigated, not removed

**Established.** Quoted from the source comment at `workflow.ts` L478: *"startWorkflow seeds
every applicable stage as PENDING at submission time, so a holder of a later stage can see a
row that decideTask will refuse."*

Commit `01137b6` (`fix(approvals): mark non-decidable approval rows and explain why`) added
the `actionable` / `blocked_reason` annotation so the UI can explain *why* no button is
offered, rather than presenting an action that returns 403. `decideTask` re-checks both rules
inside its own transaction (L370–L399), so the annotation is a UI affordance and never an
authorization decision.

**Residual.** The engine still materializes future stages as real PENDING rows. That is a
legitimate "push" model, but it means every downstream approver's queue contains work that is
not yet theirs. Whether that is desired (visibility) or noise (queue bloat) is a workflow
design question.

### 11.3 The Managing Director and the Operations Manager share one role code — decided, with a known limit

**Established and already decided (§2.1).** On all 32 active HDG workflows the MD final-approval
step is keyed to role code `operations_manager`, held by both John Paul and Nkuzungoma
Diuedonne. This is intentional: it is precisely what makes the MD-absence delegation rule
decidable, because the Operations Manager can legitimately act in that seat.

The compensating control shipped in `9b90798` — one user may not decide two steps of the same
chain — plus the out-of-order guard in `cf158a1`, is what makes the shared role safe. Measured
blast radius: 21 instances, 20 decided, 2 pending, 0 out-of-order, 0 duplicate-approver, and
only 4 decided approval tasks exist in HDG at all. There is currently **zero** instance of one
person deciding two steps.

**Residual limit.** Role code alone cannot distinguish the two people. Any future feature that
needs "the MD's own approvals" or "the MD signed this personally" — as opposed to "the MD
seat approved it" — cannot be built on the current keying. Option 2 (a distinct role code for
the MD) is a strict superset of Option 3 and would additionally restore per-person identity,
but it has to touch all 32 workflow definitions *and* migrate role assignments, so it is a
deliberate future change, not a drive-by. See §12.4.

### 11.4 The KCB joint-signatory mandate is declarative — P2

**Established.** The mandate (both John Paul and Nkuzungoma Diuedonne must jointly authorize)
and the KCB account configuration exist. What was **not** found is an engine-level guard that
refuses to release a payment whose two signatories are the same person, or that asserts both
signatures were captured on the same instrument. SoD is enforced for *approvals*; the
joint-signatory rule for *banking* is a policy statement the UI reflects.

**Unresolved.** Whether the dual signature is enforced upstream by the bank (KCB's own
mandate registration) rather than in ERP. If it is, this is correctly a documentation item.
If it is not, a SoD-style guard for payment release is missing. This needs a business answer,
not a code guess — brief §46.

### 11.5 Organisation-chart roles that appear on no workflow step — P2

**Established.** The org chart in the brief names CFO (David Kyaligonza), HR Manager
(Nyirinkindi Annonciata), Operations & Floor Supervisor (Anthony Njenga Chege), Operations
Assistant (Solomon Munyagwa) and System Administrator (Lulenzi Mutawakiru). Several of these
hold no step in any of the 32 workflows. They are consequently invisible to the approval
model: they can be assigned work, but no chain routes to them by role.

**Impact.** Approvals default to whoever holds `operations_manager`, which concentrates
decision-making on two people. This is a workflow-coverage gap, not a code defect.

**Unresolved.** Which chains *should* route to CFO / HR Manager is a governance decision —
and §2.4 already recorded that no new workflow was invented in this pass. Creating them now
would bake in the shared-role pattern 32 times over; §12.1 sequences it after the role-keying
decision in §11.3.

### 11.6 The SoD conflict register exists but has no operational surface — P2

**Established.** `sod_rules` and `sod_conflicts` are created in
`packages/db/migrations/0072_admin_platform.sql`, with a severity ladder
(`LOW`/`MEDIUM`/`HIGH`/`CRITICAL`) and a lifecycle
(`POTENTIAL_CONFLICT` → `ACTIVE_CONFLICT` → `EXCEPTION_APPROVED` / `RESOLVED`).

The engine works — `tests/sod.test.ts` proves a user cannot approve their own purchase order.
What is **not** established is an operational experience on top of the register: a queue for
active conflicts, an exception-approval flow, or an expiry on granted exceptions. The count of
open conflicts is live operational data and is not a code property, so it is not cited here as
a fixed number.

### 11.7 Hand-rolled tables — carried from §4, out of scope by decision

**Established.** 468 `<table>` tags (392 inside views) bypass the shared `DataTable`, which
itself has no server-side contract. Decided in §2.2: **out of scope for this pass, reported.**
The migration path is in §12.2. Nothing about this is blocked; it is sequenced.

### 11.8 Disabled controls without a stated reason — carried from §4

**Established.** 887 `disabled=` attributes; 5 of them carry an explanation. Brief §49 is
explicit that the question is not "can we hide this button" but "what should the user
understand about why this action is unavailable". The `actionable`/`blocked_reason` pattern
added in `01137b6` is the correct house style and should generalize — it already proves the
codebase can express "you can't do this, here's why" without hiding the record.

### 11.9 Three of four navigation badges are hardcoded — carried from §4

**Established.** `Shell.tsx` L209–L215:

```ts
const counts = {
  approvals: approvalCount,   // real - /api/approvals/pending-count
  exceptions: approvalCount,  // real value, wrong label
  inventory: 0,               // hardcoded
  quality: 0,                 // hardcoded
  security: 0,                // hardcoded
};
```

`nav.ts` declares four badge kinds (`approvals`, `inventory`, `quality`, `security`). Three
render a constant zero. This is the one place where the brief's "no fake numbers" rule
(§4, §32) is genuinely violated by existing code — a zero that reads as "nothing to do" when
nothing was actually queried. `exceptions` reusing `approvalCount` is the milder variant.

This is the highest-value small fix available: wire real counts or remove the badge.

### 11.10 `apps/web` has no tests, and `test:web` fails

**Established.** `apps/web` contains **0** test/spec files and declares no `test` script
(scripts are `dev`, `build`, `preview`, `typecheck`). The root `package.json` nevertheless
defines `"test:web": "npm run test -w apps/web"`, which will fail if run. No vitest config
exists in `apps/web`.

The frontend is type-checked (`tsc --noEmit` runs inside `build`) but never unit- or
integration-tested. For a UI whose authorization is advisory-only this is a real gap, but
adding a test harness is a separate, substantial piece of work.

### 11.11 No lint gate anywhere

**Established.** No `lint` script in root, `apps/web` or `apps/api`; no ESLint or Biome config
found. Brief §42 asks to run `npm run lint`. It cannot be run, and it was not fabricated.
Consequently there is no automated check on hooks usage, dependency arrays, accessibility
lint rules (`jsx-a11y`), or import hygiene — which is one reason the class of defects in §4
and §11.8 survives.

### 11.12 Offline/queued-write behaviour is unverified

**Established.** `NetworkBanner` is mounted in the shell (`Shell.tsx` L228). Brief §24 requires
that a locally queued write is never reported to the user as committed to the server.

**Unresolved.** Whether any offline queue exists at all was not established. This is listed as
unverified rather than asserted either way — claiming either would be fabrication.

### 11.13 No visual or accessibility verification was performed

Repeated from §10.3 because it is the largest remaining unknown. Every layout, contrast,
focus-order and screen-reader claim in §8 is inference from markup. The brief's acceptance
criteria (§36, §48) are not fully satisfiable from this pass alone.

## 12. Recommendations and sequencing

### 12.1 Sequence

Ordered so that each step is independently valuable and none is a prerequisite guessing game.

1. **Fix the three hardcoded badges** (§11.9). Small, real, removes the only fake numbers.
   Decide the actionable-vs-inbound semantic for the approvals badge at the same time (§11.1).
2. **Give `DataTable` an optional server-side mode**, then migrate exactly one module
   end-to-end (§12.2). Do not start a 468-table sweep before one module has proven the
   contract.
3. **Generalize the explanation-first pattern** from `blocked_reason` to the 882 unexplained
   `disabled=` controls (§11.8). This is the brief's §49 principle and the codebase already
   has the idiom.
4. **Consolidate the token layer** — five `:root` blocks, three competing `--primary`
   definitions, zero `--space*` scale, one `--surface` reference (§5.4, §4 #4). Establish the
   authority, then refactor call sites incrementally. Do not replace `styles.css` wholesale
   (brief §28).
5. **Build `TraceabilityGraph`** (§22 of the brief). The data already exists — `QrTrace.tsx`
   already fetches real movements and custody events from `/api/qr/traceability/:code`. The
   gap is that the `trace-chain` `<ol>` renders the same nine static labels for every QR and
   is neither clickable nor a graph. This is a genuine build against real data, not a mockup.
6. **Security-printing workspace** as a first-class surface, then a dedicated **Factory Mode**
   interaction mode — noting that `FactoryOs.tsx` (91 kB, ten exported screens) and the shell's
   focus mode already deliver most of this (§7.6). Extend, do not rebuild.
7. **Settle the role-keying question** (§11.3) before authoring any new workflow, then add the
   missing chains (§11.5) once, correctly (§2.4).
8. **Verification passes** — accessibility, viewport, visual regression (§41, §54, §55) —
   which this pass did not perform.

### 12.2 The `DataTable` path, in detail

The temptation is to sweep 468 tables. The correct order is inverted: prove the contract on
one module first.

1. Add an **optional** server mode to `DataTable` — `page`, `pageSize`, `sort`, `filters`,
   `onQueryChange`, `total`, plus loading/error/empty slots. Existing client-side call sites
   keep working unchanged; that is what makes this safe.
2. Migrate **one** module end-to-end — inventory stock or sales orders are the best candidates
   because they are high-traffic and have real pagination pressure.
3. Measure: request count, payload size, time-to-interactive, and whether the row count now
   actually matters.
4. Only then consolidate by domain, worst-offender first (`FinanceFlow` 452 kB,
   `OrganisationSettings` 226 kB, `ContractFlow` 211 kB, `ProcurementFlow` 195 kB).

Doing step 4 before step 1 is how a mechanical sweep turns into a fleet of inconsistent
half-migrations with no shared behaviour — which is exactly what §4 #6 records inside
`Reports.tsx` today.

### 12.3 Bundle work

`HrFlow` (468 kB) and `FinanceFlow` (391 kB) are the two chunks worth splitting (§10.2). Both
are domain monoliths, so the fix is the same as §12.2's: decompose the view, and the bundler
will follow. No bundler configuration change is required — splitting already works.

Also decide, deliberately, whether shipping source maps of the entire application to
production is intended.

### 12.4 What to explicitly not do

- **Do not restructure navigation.** §6.1 establishes the brief's proposed IA is largely
  already implemented across 13 live groups, 291 routes and 273 permission gates. A
  restructure would break bookmarks and muscle memory for no operational gain (§6.4).
- **Do not replace `styles.css`.** 331 kB, mixed line endings, five `:root` blocks. Consolidate
  incrementally (§12.1 item 4).
- **Do not rebuild the factory OS, the shell focus mode, the QR scanner, or the command
  palette.** All four are real and working (§5.4, §7.6).
- **Do not invent new workflows** until §11.3 is settled (§2.4).
- **Do not create migrations** for anything in this document. Every recommendation above is
  achievable against the existing schema.

## 13. Brief §60 deliverable checklist

Mapping each required output to where it is answered — including the ones **not** delivered.

| # | Deliverable | Where | Status |
| --- | --- | --- | --- |
| 1 | UX/UI audit summary | §3, §3.1 (severity counts), §4 | Delivered |
| 2 | List of redesigned components | §5.4 | Delivered as an inventory; **0 created, 0 refactored** |
| 3 | List of redesigned pages | §3 route matrix | Delivered; **1 page changed** (`Approvals.tsx`) |
| 4 | Design system documentation | §5.1–§5.5 | Delivered as measured state + gaps |
| 5 | Navigation changes | §6 | Delivered; **recommendation is "do not restructure"** |
| 6 | Dashboard changes | §7.1, §11.9 | Delivered as findings; **no dashboard was changed** |
| 7 | Responsive improvements | §8.4 | Code-level findings only; **not verified at viewports** |
| 8 | Accessibility improvements | §8.1–§8.3 | Code-level findings only; **no WCAG conformance claimed** |
| 9 | Performance improvements | §10.2, §12.3 | Bundle evidence + recommendation; **no profiling done** |
| 10 | Security-preservation report | §7.1, §7.2, §9.1 | Delivered; **0 security controls changed** |
| 11 | API changes | §9.1 | **None** |
| 12 | Database changes | §9.1 | **None** |
| 13 | Tests executed | §10.1 | **42 files / 380 tests passed**, 394.56s |
| 14 | Build results | §10.2 | **EXIT 0**, `✓ built in 9.54s` |
| 15 | Remaining issues | §11 | Delivered, 13 items |
| 16 | Screenshots / visual verification | §10.3 | **NOT DELIVERED** — none captured |
| 17 | List of files changed | §9.1 | 1 source file + this document |
| 18 | Migration required | §12.4 | **None** |
| 19 | Environment variables required | §12.4 | **None new** |
| 20 | Production deployment instructions | §9.4 | Delivered (unchanged path, verified options) |

### 13.1 Standing exclusions

Repeating these so they are not mistaken for oversights:

- No WCAG 2.2 AA conformance is claimed and no accessibility testing was performed.
- No visual-regression or viewport testing was performed; no screenshots exist.
- No fabricated comparison percentages appear anywhere in this document (brief §8, §32). Where
  a trend or delta was unavailable, none was invented.
- No workflow was created, no role was added, no table was consolidated, no navigation was
  restructured, no API was changed and no migration was written.