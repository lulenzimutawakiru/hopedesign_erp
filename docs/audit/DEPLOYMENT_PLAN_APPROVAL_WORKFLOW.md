# Deployment & Rollback Plan — Simplified Approval Workflow

**Date:** 2026-10-20
**Branch:** `feat/approval-workflow-simplification`
**Migrations:** `0203_approval_workflow_hardening.sql`, `0204_simplify_approval_workflows.sql`, `0205_approval_exception_workflow.sql`

This is the production rollout plan for the approval-workflow hardening and
simplification. It is a **plan only** — no production change has been made and
none will be made without separate, explicit authorization.

---

## 1. What ships

| Area | Change | Migration |
|---|---|---|
| Fail-closed | Missing workflow is a config error, not an auto-approval | — (code) |
| Self-approval | `ownerColumn` + `created_by` on supplier payments / credit / debit notes / supplier invoices | 0203 |
| Approval vs execution | `EXECUTION_PENDING → EXECUTED` + `workflows.instances.execute` | 0203 |
| Stale invalidation | `workflow_instances.material_hash` + `amount` | 0203 |
| Delegation at decision | `approval_tasks.delegation_id` + limit enforcement | 0203 |
| Exceptions | `approval_exceptions` ledger + API + fields + RBAC | 0203, 0205 |
| Simplify | every Hope Design workflow collapsed to one primary approver; dormant declarative tables `COMMENT`-deprecated | 0204 |

## 2. Migration order and safety

All three migrations are **additive and forward-only** (run via `npm run db:migrate`
→ `node src/migrate.js`, which takes an advisory lock and records each file in
`schema_migrations`). Order matters and is guaranteed by filename:

1. `0203` — adds columns/constraint/table/permission. Drops and re-adds the
   `workflow_instances_status_check` constraint to admit `EXECUTION_PENDING` /
   `EXECUTED` (a constraint swap, not a data change).
2. `0204` — collapses `workflows.config` to a single step for Hope Design,
   **value-guarded** (only where `jsonb_array_length(config) > 1` and the
   entity is not `security_printing.jobs`). `COMMENT ON` deprecations are
   non-destructive.
3. `0205` — adds three nullable columns to `approval_exceptions`, inserts six
   `workflows.exceptions.*` permissions, and derives role grants from
   permissions roles already hold (the `0184` pattern). `ON CONFLICT DO NOTHING`
   throughout.

**No row of production data is modified, deleted, or backfilled** by any of the
three. No `DROP`, no `TRUNCATE`, no destructive schema change.

## 3. Backward compatibility

- Existing in-flight `workflow_instances` keep their current tasks, roles and
  status; the new `EXECUTION_PENDING`/`EXECUTED` states are additive to the
  status `CHECK`.
- Entities that were already `APPROVED` before this release are **not** retro-
  moved to `EXECUTION_PENDING`; their side effect was already run. Only newly
  completed approvals take the deferred-execution path.
- The declarative `approval_*` tables are retained (rows intact) — only
  `COMMENT ON` was added.
- `sales.quotations` remains approval-free by explicit policy.

## 4. Rollback plan

Because the migrations are forward-only, rollback is **code-level**, not
reverse-migration:

- **Rolling back the release** (revert to the previous deploy) restores the
  previous engine behaviour. The new columns/table/permissions are inert when
  the old code runs — the old `startWorkflow` does not read `material_hash`,
  `amount`, `execution_*`, or `approval_exceptions`, and `0204`'s collapse is
  configuration that the old engine still honours (it already read
  `workflows.config`).
- **Recovering a bad `0204` collapse**: the pre-collapse `workflows.config` is
  not automatically preserved in the DB. If the single-level simplification must
  be undone for a specific workflow, an administrator re-edits that workflow's
  `config` to restore the prior steps. A backup of `workflows` (or the whole DB)
  taken before `db:migrate` is the reliable recovery point.

**Pre-deploy checklist (mandatory):** take a full DB backup (`pg_dump`) before
running `db:migrate` in production.

## 5. Rollout steps

1. Back up the production database (`pg_dump -Fc`).
2. Build and tag the API image with the new code.
3. Run `npm run db:migrate` against production **once**, from one host (the
   advisory lock makes concurrent runs safe).
4. Restart the API and worker containers (blue/green) — new code requires the
   0203/0204/0205 columns to be present, so migrate **before** switching traffic.
5. Smoke-test (below).

## 6. Post-deploy verification (smoke)

1. `GET /api/approvals` returns the single-step queue; approve a sales order —
   the order reaches `APPROVED` and its `workflow_instance` reaches
   `EXECUTION_PENDING`, **not** `EXECUTED`.
2. `POST /api/approvals/:instanceId/execute` by an executor who did not approve
   it posts the side effect and returns `EXECUTED`; an approver re-attempting to
   execute their own approval is refused (SoD).
3. Submit an approval-required entity with no configured workflow → the API
   returns a configuration error and nothing is posted/released (fail-closed).
4. Reject an approval with an empty reason → `400` (reason required).
5. `POST /api/approval-exceptions` with a full control package, then
   authorise it as an independent user, then record the reviewer outcome.

## 7. Known risks

- **Behaviour change (intended):** entities with `onApprove: 'post'/'release'`
  no longer auto-post/release at approval — a separate execute step is now
  required. Operators must be told that "Approved" now means "approved for
  execution".
- **Execution permission:** finance executors already hold
  `workflows.instances.*`, so `execute` is available to them; the real
  separation is enforced at decision/execute time (an approver may not execute
  their own approval). Verify role-to-user assignments on a seeded DB before
  go-live.
- **Tests:** the automated suite has not been run against a fully seeded DB in
  this environment (see `docs/audit/AUDIT_2026-10-20.md`); integration tests are
  a pre-requisite before production rollout.
