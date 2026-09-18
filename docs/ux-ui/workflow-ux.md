# Workflow UX

How the HOPE DESIGN ERP frontend presents workflow, approval and state-machine
behaviour. Companion documents: `design-system.md` (§18/§72 status language),
`component-library.md` (§8 "not in the library"), `navigation.md` (§12 visibility).

---

## 1. The governing rule (§133)

**The workflow engine is authoritative. The frontend does not implement workflow.**

The backend owns:

- which transition is legal from the current state;
- who may perform it (RBAC + ABAC + SoD);
- SLA clock and escalation;
- delegation;
- the transition's side effects (posting, numbering, custody, audit).

The frontend may only **display** and **request**:

| Frontend does | Frontend must never |
| --- | --- |
| Render the current state | Compute the next state |
| Render the available actions the backend returns | Invent an action the backend did not offer |
| Render approval history / SLA / delegation | Derive SLA deadlines from client time |
| Send a transition request | Assume success before the response |
| Show the authoritative result after re-fetch | Optimistically commit a business state locally |

### 1.1 Action responses are receipts, not state

This is the single most important implementation rule in this document, and it
is the rule that the `SecurityJobs.tsx` rewrite (pass 46–47) applies
consistently:

> A successful action response means *"the backend accepted the request"*.
> It does **not** mean *"the record now has the state you assumed"*.

Therefore every action handler **re-fetches the detail record** after the
response and renders what the backend returns. No handler does:

```ts
await api(...);
setJob({ ...job, status: 'QC_PENDING' });   // ✗ forbidden: client-invented state
```

The correct shape is:

```ts
await api(...);
toast.success('Submitted');
await refresh();                            // ✓ backend is the source of truth
```

---

## 2. State-aware actions (§76)

A control exists only when **all four** conditions hold:

```
permission
AND workflow state allows the transition
AND business rules allow it (prerequisites met)
AND required data is present
```

If the control would be meaningful but is currently blocked, the rule is
**disable with a reason**, not silently hide (§109). Hiding a control teaches
the user nothing; a disabled control with a reason teaches them the workflow.

### 2.1 The `blockedBy([...])` pattern

The canonical implementation lives in `apps/web/src/views/SecurityJobs.tsx`.
Each action computes a list of blocking reasons; an empty list means the action
is available:

```tsx
const blocked = blockedBy([
  !can(user, 'security_printing.jobs.approve') && 'Your role cannot approve secure jobs.',
  job.status !== 'PENDING_APPROVAL'            && 'Job is not awaiting approval.',
  job.createdBy === user?.id                   && 'Segregation of duties: you created this job.',
]);
```

The same list drives both rendering and explanation:

```tsx
<button onClick={openApprove} disabled={blocked.length > 0}
        title={blocked[0] ?? undefined}>Approve</button>
{blocked.length > 0 && <p className="muted small">{blocked[0]}</p>}
```

### 2.2 Blocking copy (§109)

Blocked actions should state **what is required**, not merely that the button
is off:

```
Cannot dispatch

Reason:
  QC inspection has not passed.

Required:
  QC result = PASSED
```

### 2.3 Coverage in the current codebase

Measured across `apps/web/src`:

| Metric | Count |
| --- | --- |
| `disabled=` occurrences | **897** |
| `disabled=` with an explanatory `title=` | **13** |
| `<PermissionGate>` call sites | **0** |
| `<RoleGate>` call sites | **0** |

⇒ **The disable-with-reason rule is the norm only inside the rebuilt surfaces
(`SecurityJobs.tsx`, `QrTrace.tsx`, `EntityList.tsx`).** Across the remaining
views, 884 disabled controls give the user no explanation. This is the largest
outstanding §76/§109 gap and it is intentionally not mass-edited in this
effort — a blanket edit would touch ~60 files with no per-control reasoning.

`PermissionGate` and `RoleGate` exist in `components/states.tsx` and have zero
call sites. They are **not deprecated and not broken**; they are simply
unused. The project preference is state-aware disabling over hiding, so
prefer `blockedBy` for action controls. `PermissionGate` remains appropriate
for gating an entire region (e.g. a financial-summary panel) where a disabled
control would be meaningless.

---

## 3. Business status model (§18)

**Do not represent every state with one generic `Status`.** A single
transaction legitimately carries several independent status axes at once:

```
Invoice:       POSTED              ← business state
Approval:      APPROVED            ← approval state
Payment:       PARTIALLY PAID      ← payment state
eFRIS:         FISCALIZED          ← fiscal state
Collection:    OVERDUE             ← collection state
```

The `Badge` component (`components/ui.tsx`) is a *single-axis* renderer: it
maps one string to one tone. It is correct to render the same record with
several `Badge` instances, one per axis, and the UI must **label the axis**:

```tsx
<dl className="kv">
  <div><dt className="kv-k">Business</dt><dd className="kv-v"><Badge value={inv.status} /></dd></div>
  <div><dt className="kv-k">Approval</dt><dd className="kv-v"><Badge value={inv.approvalStatus} /></dd></div>
  <div><dt className="kv-k">Payment</dt><dd className="kv-v"><Badge value={inv.paymentStatus} /></dd></div>
</dl>
```

Never collapse two axes into one badge by concatenation, and never pick a
"most important" axis and hide the rest.

### 3.1 Badge coverage

The full kind/tone/label table lives in `component-library.md` §3. Two
workflow-relevant facts from that table:

- **Covered tokens** include `PENDING, SUBMITTED, PENDING_APPROVAL, HR_REVIEW,
  MANAGER_REVIEW, FINANCE_REVIEW, LEGAL_REVIEW, WAITING, RETURNED, APPROVED,
  REJECTED, COMPLETED, POSTED, EXECUTED, ON_HOLD, SUSPENDED, DRAFT, CANCELLED,
  VOID`.
- **Not covered → neutral `●`:** `MATERIALS_AUTHORIZED, MATERIALS_ISSUED,
  IN_PRODUCTION, QC, RECONCILIATION, PACKAGING, IN_SECURE_STORAGE`, and most
  custody `event_type` values. **Custody events are not statuses** — render them
  with `eventLabel()` (`helpers.ts` L29–34), not with `Badge`.

---

## 4. Approval Center (§16)

A unified approval surface. Every approval row/panel must expose:

| Field | Source |
| --- | --- |
| Document | linked record (use `hrefForSearchHit`-style resolvers, never a hand-built path) |
| Document number | business identifier, not `id` |
| Owner | creator / requester |
| Department | org unit |
| Amount | `fmtMoney` — backend value, never client-computed (§136) |
| Current status | `Badge` on the *approval* axis |
| Workflow step | step name from the engine |
| Approver role | role required for the current step |
| Due date | engine SLA |
| SLA | remaining/elapsed, derived from the engine's due date |
| Previous decisions | ordered history |
| Comments | per-step |
| Audit history | `AuditTimeline` (pending, see §7) |

Actions: `Approve`, `Reject`, `Return`, `Delegate` (where authorized),
`Open record`, `View supporting documents`.

### 4.1 Sensitive actions require confirmation

Destructive / irreversible approvals route through `ConfirmDialog`
(`components/os.tsx`) with a **required reason**. See §6.

### 4.2 SLA indicators

SLA must be computed from the backend-supplied due timestamp. Two presentation
states are useful and one is not:

| State | Presentation |
| --- | --- |
| On track | remaining duration, muted |
| Due soon | remaining duration, warning tone |
| Overdue | elapsed-since-due, danger tone, and the row sorts first |

Do **not** render a client-computed countdown that keeps ticking after the tab
has been backgrounded; re-derive from the timestamp on each render.

---

## 5. WorkflowTimeline (§17)

> **Status: the component does not exist.** `component-library.md` §8 records
> this explicitly. `WorkflowTimeline`, `TraceabilityChain`,
> `TransactionSummary`, `ActivityTimeline`, `AuditTimeline` and
> `SignatureBlock` are all absent from `components/`.

What exists today is **hand-rolled markup per view** against a shared CSS
primitive.

### 5.1 The working CSS primitive

`styles.css` L897–901 (the live definition):

```css
.timeline       { position: relative; padding-left: 20px; }
.timeline-item  { position: relative; padding: 0 0 14px; }
.timeline-dot   { position: absolute; left: -19px; top: 4px; width: 10px;
                  height: 10px; border-radius: 50%;
                  background: var(--mill); border: 2px solid #fff; }
.timeline-title { font-weight: 700; font-size: 13px;
                  display: flex; align-items: center; gap: 8px; }
.timeline-meta  { font-size: 12px; color: var(--muted); }
```

Markup convention — a **plain `<div>` list**, never `<ol>`:

```tsx
<div className="timeline">
  <div className="timeline-item">
    <span className="timeline-dot" />
    <div className="timeline-title">Prepared <Badge value="COMPLETED" /></div>
    <div className="timeline-meta">A. Nakato · 12 Sep 2026 09:14 · Kampala</div>
  </div>
</div>
```

⚠️ **Do not render `.timeline` as `<ol>`** — the CSS positions `.timeline-dot`
absolutely against `.timeline-item`; list-item boxes break the rail.

⚠️ `.timeline` is **defined twice** — L897–901 (live) and L1549–1557 (dead,
used by no view). Do not touch L1549. See `design-system.md` for the full
duplicate-selector list.

⚠️ **`.timeline-body` has no CSS rule**, although 5 views emit it. Either add a
rule or stop emitting the class; do not assume it renders as intended.

### 5.2 Target stage model

```
Prepared                      ✓
Operations Manager Review     ✓
Managing Director Approval    ●  Waiting
Accounting Release            ○  Pending
```

Each stage should carry: role · person · status · timestamp · comment · SLA ·
delegation · rejection reason · return reason.

### 5.3 A known engine behaviour to design around

⚠️ `startWorkflow` **seeds every stage as `PENDING` at submit time.** Two
consequences for the UI:

1. A freshly-submitted document renders all stages at once — that is expected,
   not a rendering bug.
2. "Pending" therefore means *"not yet reached"* as well as *"waiting now"*, so
   the timeline must distinguish the **current** stage (from the engine's
   active-step pointer) rather than inferring it from whichever stage happens to
   be last.

This is recorded as an open item in the §143 report. It is a backend-behaviour
observation, not something the frontend may paper over.

---

## 6. Confirmation UX (§108)

### 6.1 The two-step rule

For `Void`, `Delete`, `Archive`, `Cancel`, `Reject`, `Disable`,
`Unassign`:

```
What will happen
Why
Reason (where required)
Confirmation
```

Never hide irreversible effects. Never rely on a bare `window.confirm`.

### 6.2 ConfirmDialog contract

From `components/os.tsx` L8. Full contract in `component-library.md` §4; the
workflow-relevant constraints:

- `role="alertdialog"` — correct for a blocking decision.
- **`body` must be a `string`** — it cannot hold JSX, so consequence lists must
  be flattened to text.
- **Hardcoded ids `#confirm-title` / `#confirm-reason`** ⇒ **only one
  ConfirmDialog may be open at a time.**
- **No ESC handler — by design** (a blocking decision should require an explicit
  choice, unlike `Drawer` which does handle ESC).
- Cancel label is hardcoded `"Keep as-is"`.
- `reasonLabel={null}` hides the input but still calls `onConfirm('')` — so a
  nullable reason is indistinguishable, at the call site, from the user typing
  nothing.

### 6.3 `Drawer` vs `ConfirmDialog`

| | `Drawer` | `ConfirmDialog` |
| --- | --- | --- |
| ESC closes | **yes** | no (deliberate) |
| `role` | `dialog` + `aria-label={title}` | `alertdialog` |
| Scrim click closes | yes | — |
| Multiple concurrent | no constraint | **one at a time** (hardcoded ids) |
| Body content | any JSX | `string` only |

Because `Drawer` handles ESC and accepts arbitrary JSX, it is the better
container for record context, activity and audit. `ConfirmDialog` is for the
decision itself.

### 6.4 Modal policy (§32)

| Container | Use for |
| --- | --- |
| Modal | confirmation, very short forms, quick actions |
| Drawer | context, activity, audit, quick details |
| Full page | complex transactions, long forms, payroll, production planning, finance posting, complex configuration |

**Do not put an entire business application inside a modal.**

---

## 7. Audit, activity and history (§73, §74)

Three distinct concepts that are frequently conflated:

| Concept | Question it answers | Target component |
| --- | --- | --- |
| Activity | *What happened, narratively?* | `ActivityTimeline` |
| Audit | *Who changed what, before/after, why?* | `AuditTimeline` |
| Workflow | *Where is the approval, and what is next?* | `WorkflowTimeline` |

Audit must present: who · what · when · before · after · reason · IP/device
where appropriate · correlation/event reference where appropriate.

**None of these three components exists.** Every current instance is hand-rolled.
Extraction should follow the §100 rule (extract on the third use).

---

## 8. Error and conflict UX (§31, §33)

### 8.1 Canonical error text

`components/errorText.ts` owns the mapping. `describeError(error, fallback)`
L86–96 is the entry point; `CANONICAL_ONLY = {401,404,405,408,413,429,500,501,
502,503,504}` means the canonical message wins over any server-supplied text
for those codes.

Workflow-relevant mappings:

| Status | Message |
| --- | --- |
| 401 | session expired → `api.ts` clears the token and redirects to `#/login` |
| 403 | "You do not have permission to perform this action." |
| 404 | "This record could not be found. It may have been removed." |
| **409** | **"This record changed while you were working on it. Reload and try again."** |

### 8.2 SoD copy (§33)

A raw `403` is not acceptable for a segregation-of-duties block. The user
needs to know that *the rule*, not *their access*, is the obstacle:

```
Approval unavailable

You created this transaction.
Segregation-of-duties rules require another authorized user to approve it.
```

Where practical, offer: **What happened · Why · What you can do.**

### 8.3 Concurrency protection (§31)

For sensitive transactional records, detect stale edits using the record's
`version` and/or `updated_at`:

```
This record changed while you were editing it.

[ Reload latest ]   [ Compare changes ]
```

**Never silently overwrite another user's work.** A `409` must never be
swallowed — see the "no silent failures" rule (§138): a `catch(() => undefined)`
is acceptable only for a genuinely optional background refresh where the
surrounding UI remains truthful.

---

## 9. Unsaved state (§30)

Leaving a dirty form requires an explicit decision:

```
You have unsaved changes.

[ Stay ]   [ Discard changes ]
```

For long forms, support draft saving where it is safe (i.e. where a draft is a
first-class backend state and not a client-side illusion). The
`OrganisationSettings` control plane already tracks dirty state and is the
reference implementation to follow when extracting a shared guard.

---

## 10. Session expiry (§89)

`api.ts` L21–48 already implements the hard behaviour: on `401` for any
non-`/api/auth/` path it calls `clearToken()`, redirects to `#/login` and
throws `ApiError('Session expired', 401, 'UNAUTHORIZED')`.

The *soft* behaviour — warning before expiry and offering **Continue session** —
is not implemented:

```
Your session is about to expire.
[ Continue session ]
```

and after expiry, where a draft was preserved:

```
Your session expired.
Your draft was preserved.
[ Sign in ]
```

Do not claim draft preservation unless the draft actually survives the redirect.

---

## 11. Long-running operations (§34)

Payroll, MRP, posting runs and bulk operations should narrate progress by
**step**, not with a bare spinner:

```
Generating payroll...

✓ Employees loaded
✓ Gross pay calculated
✓ PAYE calculated
● NSSF
○ Validation
○ Posting
```

`Meter` (`components/os.tsx` L98–108) already emits
`role="progressbar"` with `aria-valuenow/min/max`, and `PageLoader` /
the skeleton set in `components/states.tsx` cover the indeterminate cases. A
step-list component does not exist.

---

## 12. Business-event notifications (§90)

Events that warrant an actionable notification, each linking **directly to the
record** (never to a module landing page):

```
Purchase Order approved
Payroll requires approval
Invoice overdue
Stock below reorder point
Production material shortage
QC failed
Security job awaiting approval
Service Desk SLA breached
Integration failed
```

Notification actions are standardised to: **Open · Mark read · Snooze ·
Archive · Mark unread**, with severity drawn from the same tone vocabulary as
`Badge`. See `design-system.md` for the semantic colour table.

---

## 13. Implementation checklist for a new workflow surface

1. Identify the authoritative endpoint and its permission from `routes/`.
2. Render state from the response; never derive it.
3. Build `blockedBy([...])` per action: permission, state, prerequisites, data.
4. Disable-with-reason; do not hide.
5. Route destructive actions through `ConfirmDialog` with a required reason.
6. Re-fetch the detail record after every action response.
7. Render the timeline from engine history, marking the active step explicitly.
8. Separate business / approval / payment / fiscal / quality axes into distinct
   labelled badges.
9. Surface `409` as a reload-and-retry, never as a silent overwrite.
10. Add the audit panel before shipping — a sensitive record without discoverable
    audit does not meet the §73 bar.
