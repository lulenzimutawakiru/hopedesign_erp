# Approval Workflow Audit — Hope Design ERP

**Date:** 2026-10-20
**Branch:** `fix/audit-remediation-2026` (audit only — no changes implemented)
**Status:** Findings + proposed changes presented for authorization. **Nothing implemented.**

Scope: the existing approval/authorization system, per the implementation prompt (id 4857).
Every finding below is marked **CONFIRMED** (verified in source/SQL) or **SUSPECTED**
(plausible from code, not yet reproduced). Nothing is invented.

---

## 1. Architecture summary (what actually exists)

The approval system is a **generic workflow engine**, not a per-module set of if-statements:

- **`workflows`** → **`workflow_instances`** → **`approval_tasks`** (three tables, tenant/company scoped, RLS `tenant_isolation`).
- `apps/api/src/services/workflow.ts` is the engine: `startWorkflow`, `decideTask`, `completeWorkflow`, `rejectWorkflow`, `getApprovalsQueue`.
- `apps/api/src/services/entities.ts` is the entity registry: maps `entity_type` → `{ table, statusColumn, approvedStatus, rejectedStatus, onApprove, ownerColumn }`.
  - `onApprove` is the execution coupling: `'post'` = post GL/inventory side effect on approval, `'release'` = release a payment, `'authorize'` = status only (declared but **unused**), `'none'` = status only.
- `apps/api/src/routes/approvals.ts` exposes the queue (`GET /`, `GET /pending-count`, `POST /:taskId/decide`).
- `apps/api/src/middleware/authorize.ts` enforces RBAC (`can`) + SoD (`sod_rules`, hard conflicts) + ABAC (`policies`) + company scope.
- Supporting services: `financeApprovals.ts` (finance inbox), `payrollLifecycle.ts` (payroll decision evidence), `governance.ts` (delegations + signature profiles).
- Declarative-only tables (admin screens, **not consulted by the engine**): `approval_workflows`, `approval_levels`, `approval_limits`, `approval_fallback_rules`.

### Seeded approval chains (from `0167` + `seed-data.js`)

Every operational document is stamped with a **3–5 step sequential chain**. Representative shapes:

| Chain | Steps |
|---|---|
| PO / PR / SO / transfer / adjustment / BOM | Operations Manager → Managing Director → Accountant ("Released to Accounting") |
| Expense / claim / supplier invoice / payment / disposal / impairment / credit note | CFO → Operations Manager → Managing Director → Accountant |
| HR requisition / workforce plan / contracts / final settlement | HR Manager → Operations Manager → Managing Director → (Accountant) |

Steps are all unconditional (`amount_min 0`, `amount_max 0`) — i.e. **no threshold gating in practice**. The "Managing Director" step was re-keyed (migration `0195`) to `approver_roles: ["managing_director","operations_manager"]`, with the MD and Operations Manager both holding `operations_manager` (0167 §3).

---

## 2. Existing working functionality (CONFIRMED)

1. **Generic workflow engine** with per-entity status transition and post-approval side effects.
2. **RBAC + ABAC + SoD + scope** in `authorize.ts` — deny-by-default, wildcard RBAC, `sod_rules` hard conflicts, `policies` (priority-ordered, first-match), company-scope guard.
3. **Self-approval prevention** via `ownerColumn`, enforced in `decideTask` (workflow.ts:341–353), for 15 entity types: `procurement.orders`, `po_amendments`, `procurement.requisitions`, `hr.payrolls`, `hr.final_settlements`, `hr.requisitions`, `hr.workforce_plans`, `hr.contracts`, `assets.*`, `ops.requisitions`, `ops.expenses`, `ops.claims`, `ops.replenishments`, `ops.daily_closings`.
4. **Chain integrity** in `decideTask`: (a) later stage blocked while an earlier stage is PENDING ("out of order"), (b) one user cannot decide two stages of one chain. Both are covered by `workflowSegregationOfDuties.test.ts` (276 lines).
5. **Delegation subsystem** (`governance.ts`) with full lifecycle DRAFT→PENDING_APPROVAL→ACTIVE→SUSPENDED→EXPIRED→REVOKED, `delegation_authorities` (can_approve/can_create/max_amount), and status history.
6. **Payroll lifecycle** with append-only evidence (status history, decision, lock, audit) — payroll decisions route through it rather than the bare status update.
7. **Finance approval inbox** (`financeApprovals.ts`) enriching the queue with amount, currency, budget position, GL state.
8. **Existing tests**: `workflow.test.ts` (70), `workflowSegregationOfDuties.test.ts` (276), `sod.test.ts` (30).

---

## 3. Findings

### 3.1 Security vulnerabilities / authorization bypasses

**APR-1 (CRITICAL — CONFIRMED) — missing workflow auto-approves.**
`startWorkflow` (workflow.ts:84–101): when no active workflow exists for an entity type, it sets the entity to `approvedStatus` **and runs the post-approval side effect** (`runApprovalSideEffect`), then emits `auto_approved`. For `onApprove: 'post'`/`'release'` entities this **posts the GL entry / releases the payment / completes the stock movement** on a missing-configuration condition.
- This is currently asserted as *desired* behaviour in `workflow.test.ts:19` ("auto-approves quotations when no workflow is configured").
- The engine already fails **closed** for the narrower case "workflow exists but no step covers the amount" (workflow.ts:110–117) — but fails **open** for "no workflow at all".

**APR-2 (HIGH — CONFIRMED) — dangling approver role silently fails open.**
`startWorkflow` resolves a step's `approver_role` to a role id via `roleIds.get(...)`; an unknown code yields `approverRoleId = null` (workflow.ts:138–145). In `decideTask` (workflow.ts:324–336) the role check is:
- `if ((approver_role_id || alternative_role_id) && roleCodes.length === 0) throw forbidden(...)` — skipped when both ids are NULL;
- `if (roleCodes.length) { ...role membership check... }` — skipped when empty.

So a task whose approver role does not resolve is decidable by **any** holder of the generic `workflows.instances.approve` permission (checked in the route), subject only to the `ownerColumn` SoD check. A deleted/renamed role, or a step referencing a role the company never seeded, silently widens who can approve.

**APR-3 (HIGH — CONFIRMED) — self-approval gap on financial & inventory entities.**
The `ownerColumn` SoD check is the only self-approval guard, and the following sensitive entity types have **no `ownerColumn`** (entities.ts): `sales.invoices`, `sales.credit_notes`, `sales.debit_notes`, `procurement.suppliers`, `procurement.supplier_invoices`, `procurement.payments` (supplier payments), `inventory.adjustments` (stock adjustments), `inventory.transfers` (stock transfers), `production.plans/work_orders/boms`, `security_printing.jobs`.
→ A preparer who also holds the approver role can approve their **own supplier payment, stock adjustment, or invoice**.

**APR-4 (MEDIUM — CONFIRMED) — workflow lifecycle flags ignored.**
`WORKFLOW_SQL` (workflow.ts:20–23) filters only `is_active = true`. It ignores `status` (a `DRAFT`/`ARCHIVED` workflow with `is_active=true` is live) and `effective_from`.

**APR-5 (MEDIUM — CONFIRMED) — delegation limits not enforced at decision time.**
Active delegations are merged into the live session (0167 §9 note), granting the temporary role. `decideTask` then checks **only** role membership + `ownerColumn`. It does **not** enforce `delegation_authorities.can_approve`, `max_amount`, the delegation's `scope`/`approval_limit`, or `expires_at` at the moment of decision (expiry is only checked when the delegate *signs a document* via `applyDocumentSignature`, and in `listActingRoles`). A delegate can therefore act on any amount/type their merged role allows.

**APR-6 (LOW — CONFIRMED) — rejection reason is optional.**
`decideTask`/`rejectWorkflow` accept `comment` as optional; a rejection or return can carry no reason (the prompt requires meaningful reasons).

### 3.2 Missing / incomplete functionality

**APR-7 (HIGH — CONFIRMED) — approval is coupled to execution.**
`completeWorkflow` runs the `onApprove` side effect in the same call that marks the instance APPROVED (workflow.ts:188–207). There is no `EXECUTION_PENDING → EXECUTED` stage. `onApprove: 'authorize'` (approval-only, execution later) is declared but used by **no** entity.

**APR-8 (HIGH — CONFIRMED) — no stale-approval invalidation.**
`workflow_instances` stores no material-field snapshot/hash. Editing amount, supplier, currency, quantities, or line items after submission does not invalidate the standing approval; the approved side effect can execute against edited values.

**APR-9 (MEDIUM — CONFIRMED) — no workflow-level exception mechanism.**
`sod_exceptions` exists for SoD, but there is no "controlled exception" (deviation + compensating control + subsequent reviewer + review deadline) for the approval flow itself.

**APR-10 (MEDIUM — CONFIRMED) — "return for correction" is a status, not a state.**
`RETURNED` is handled identically to `REJECTED` in `decideTask` (both call `rejectWorkflow`, which sets the entity to `rejectedStatus`); payroll maps both to `DRAFT`. There is no distinct `RETURNED` instance/task state with resubmission semantics beyond re-submitting.

**APR-11 (LOW — CONFIRMED) — concurrency race on completion.**
`decideTask` locks the task row (`FOR UPDATE OF t`) but not the instance. The "remaining PENDING = 0 → completeWorkflow" check (workflow.ts:453–458) can race when two tasks are decided concurrently: each can read the other as still PENDING and neither completes, leaving the instance RUNNING with all tasks APPROVED. (Duplicate side-effect posting is otherwise guarded by the "already APPROVED" refusal.)

### 3.3 Redundancy / over-complexity (for a ~5-person company)

**APR-12 (HIGH — CONFIRMED) — enterprise-bureaucracy chains.**
The seeded chains impose 3–5 sequential sign-offs on every operational document (CFO → Ops Manager → MD → Accountant). For a five-person company this is exactly the hierarchy the prompt asks to remove. The mandatory "Released to Accounting" final step is what turns approval into disbursement (coupling, APR-7).

**APR-13 (MEDIUM — CONFIRMED) — two parallel approval models.**
A live `workflows` engine and a dormant declarative model (`approval_workflows`/`approval_levels`/`approval_limits`/`approval_fallback_rules`) coexist. The declarative tables are written "so the admin screens show the real mandate, not because the engine consults them" (0167 §32–36). This is duplicated structure and a source of "the screen says X but the engine does Y" confusion.

---

## 4. Gap analysis vs. the requested simplified model

| Requested | Today | Gap |
|---|---|---|
| One approval level by default | 3–5 unconditional levels | Re-seed to 1 (configurable 2nd on threshold) |
| Configurable thresholds / currency / approvers / effective dates | `amount_min`/`max` fields exist but all 0; `effective_from` ignored; currency not modelled | Wire thresholds + effective dates into engine; add currency |
| Self-approval prevented (expense, supplier payment, payroll, stock adjustment, reversal) | payroll/expense/claim have `ownerColumn`; **supplier payment & stock adjustment do not** | Add owner columns / preparer linkage (APR-3) |
| Missing policy fails closed | fails **open** (auto-approve) | APR-1 |
| Approval separated from execution | coupled (`onApprove: post/release`) | APR-7 |
| Stale approvals invalidated | none | APR-8 |
| Delegation respects limits/scope/expiry | not at decision time | APR-5 |
| Exceptions controlled & auditable | none (workflow-level) | APR-9 |
| Concurrent/duplicate posting safe | mostly (task lock + "already approved"), completion race | APR-11 |

---

## 5. Proposed changes (minimal, backward-compatible — **for authorization, not yet implemented**)

Target: a **small-company approval system with enterprise financial integrity**, not enterprise bureaucracy. Keep the engine; change configuration and tighten the four security gaps.

### Phase 1 — Fail-closed & self-approval (correctness + security)

1. **APR-1** — Replace auto-approve-on-missing-workflow with **fail-closed**. Add an explicit approval-mode marker so "approval-free" is a deliberate policy, not an accident:
   - Add `workflows.approval_mode TEXT NOT NULL DEFAULT 'REQUIRED' CHECK IN ('REQUIRED','NONE','THRESHOLD')`, or an entity-level flag on `ENTITIES`.
   - `startWorkflow` auto-approves **only** when `approval_mode = 'NONE'` (or the entity is marked approval-free). Otherwise it throws a configuration error and records an audit event (no post, no release, no inventory write).
   - Mark genuinely approval-free entities (e.g. `sales.quotations`) explicitly, and update `workflow.test.ts:19` accordingly.
2. **APR-2** — Fail closed on dangling role: if a step's `approver_role`/`approver_roles` does not resolve to a role id at `startWorkflow`, **throw** (configuration error) instead of creating an unassigned task; and in `decideTask`, if a task has neither a resolvable approver role nor an `approver_user_id`, refuse rather than skip the role check.
3. **APR-3** — Add a preparer/owner linkage (`ownerColumn` equivalent) for `procurement.payments`, `inventory.adjustments`, `inventory.transfers`, `sales.invoices`, `sales.credit_notes`, `sales.debit_notes`, `procurement.supplier_invoices` so the existing `decideTask` SoD check covers them (reuse the existing `created_by`/`requested_by`/`prepared_by` columns; no schema change where one already exists).

### Phase 2 — Separate approval from execution + stale invalidation

4. **APR-7** — Introduce `EXECUTION_PENDING → EXECUTED` for `onApprove: 'post'/'release'` entities: approval records the decision and marks the document `APPROVED`/`EXECUTION_PENDING`; a separate, permissioned execute step runs the side effect. Add a per-workflow flag (`execute_on_approve boolean`) so small workflows can opt back into combined approval+execution where policy allows.
5. **APR-8** — Add `workflow_instances.material_hash` (or a `material_snapshot jsonb`) computed at submission; on material-field edit, invalidate the open instance (set `status='CANCELLED'` + audit `approval.invalidated`) and require resubmission.

### Phase 3 — Delegation enforcement, reasons, concurrency

6. **APR-5** — In `decideTask`, when the deciding user's role comes from an ACTIVE delegation, enforce the delegation's `scope`, `approval_limit`, `delegation_authorities.can_approve`/`max_amount`, and window.
7. **APR-6** — Require a non-empty reason for `REJECTED` and `RETURNED` (and future exception/override decisions).
8. **APR-11** — Lock the instance row (`SELECT ... FOR UPDATE` on `workflow_instances`) before the remaining-PENDING check / completion, eliminating the stuck-instance race.

### Phase 4 — Simplify the model (configuration)

9. **APR-12 / APR-13** — Re-seed workflows to a **single default approval level** (configurable second level gated by amount threshold). Remove or clearly deprecate the dormant `approval_*` declarative tables, or make the admin screens read the live `workflows` config instead. Preserve `security_printing.jobs` two-step as-is (hard requirement of `handleSecureJobTaskApproved`).

### Phase 5 — Inbox & exceptions

10. Inbox (`ApprovalQueue.tsx`) already exists — add Overdue / Returned / Delegated filters and reason display; keep all decision authorization re-checked server-side (already true).
11. **APR-9** — Add a lightweight `approval_exceptions` table (transaction ref, deviation, authorised approver, compensating control, independent reviewer, review deadline, outcome) — no silent override of mandatory rules.

### Phase 6 — Tests

Extend the suite (`workflow.test.ts`, `workflowSegregationOfDuties.test.ts`, `sod.test.ts`, plus a new `approval.workflow.test.ts`) to cover: single/multi-level, threshold boundaries, self-approval on supplier payment + stock adjustment (currently untested), missing-workflow fail-closed, dangling-role fail-closed, material-change invalidation, delegation limit/expiry enforcement, required rejection reason, concurrent completion, and tenant/company isolation. Run `npm run typecheck` and the API test suite; report actual results.

---

## 6. Proposed default approval matrix (single-level, configurable)

Same shape as the prompt's matrix, implemented as **one default approver** per transaction, with an optional second threshold level:

| Transaction | Preparer | Approver (default) | Execution |
|---|---|---|---|
| Purchase requisition | Authorized employee | Manager (`operations_manager`) | Authorized buyer |
| Purchase order | Procurement | Manager | Procurement |
| Supplier invoice | Finance | CFO / independent approver | Finance (post) |
| Supplier payment | Finance | CFO / independent approver | Payment executor (release) |
| Employee expense / claim | Employee / Finance | CFO / independent approver | Finance |
| Stock adjustment | Stores | Independent approver | Inventory (post) |
| Stock transfer | Stores | Manager (as configured) | Stores / receiving |
| Production order / BOM | Production | Manager (where required) | Production |
| Payroll | Finance/Payroll | Independent approver | Payroll executor |
| Financial reversal | Finance | Independent approver | Finance |
| User permission change | Administrator | Authorized approver | Administrator |
| Emergency override | Authorized requester | Designated authority | Executor + subsequent review |

Approver role codes, thresholds, currency, effective dates and required-approval counts become configurable (wired into the engine, not just recorded).

---

## 7. Migration & rollout risk notes

- **Local DB is under-seeded** (1 user, 0 `user_roles`, 4 roles) and is **not** representative. Users/roles/workflows come from `seed-data.js` + migration `0167`. Verify against a fully seeded DB before finalizing behaviour changes.
- **APR-1 change is behaviour-breaking for approval-free entities** — must first enumerate which entity types have no workflow today and mark them `approval_mode='NONE'` (or equivalent) to avoid breaking quotations/orders/etc.
- All changes are additive or config-level; no destructive migration. Backward-compatible: existing instances keep their current tasks/roles (0167 already establishes that pattern).
- No production data changes and no deployment without explicit authorization.

---

## 8. Decisions required from you

1. **Approval level default**: confirm single-level default with optional threshold-gated second level (vs. keep current multi-step for some high-risk types).
2. **Approval vs execution**: confirm introducing `EXECUTION_PENDING` (separate execute step) for post/release entities, or keep combined approval+execution and only fix the fail-closed/self-approval gaps.
3. **Which entities are approval-free**: confirm `sales.quotations` (and any others) should remain auto-approved by policy.
4. **Dormant declarative tables** (`approval_workflows/levels/limits/fallback_rules`): deprecate/remove, or wire them in?
5. Authorization to proceed with implementation on a separate branch (this work is currently uncommitted on `fix/audit-remediation-2026`, alongside unrelated Phase-A remediation edits from the prior audit).
