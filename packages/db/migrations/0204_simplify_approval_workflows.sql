-- ===========================================================================
-- 0204 - Simplify the approval model: single default level + deprecate the
--        dormant declarative tables
--
-- APR-12: the 3-5 step enterprise chains (CFO -> Operations Manager -> MD ->
-- Accountant) are collapsed to ONE default approval step per workflow. The
-- primary approver is preserved (the first step of the existing chain); the
-- redundant "Managing Director Final Approval" and "Released to Accounting"
-- steps are removed because:
--
--   * the MD step collapsed onto the shared operations_manager code in 0167, so
--     it duplicated the Operations Manager step rather than adding a second,
--     independent sign-off;
--   * "Released to Accounting" was the approval-vs-disbursement coupling that
--     0203 already split out into the permissioned execute step
--     (EXECUTION_PENDING -> EXECUTED, workflows.instances.execute).
--
-- A configurable second level remains available to administrators through the
-- live workflows.config bands (amount_min/amount_max) - the engine already
-- honours them. security_printing.jobs is deliberately untouched: its two-step
-- shape is a hard requirement of handleSecureJobTaskApproved.
--
-- APR-13: the declarative tables (approval_workflows / approval_levels /
-- approval_limits / approval_rules / approval_fallback_rules) are marked
-- DEPRECATED. They were written "so the admin screens show the real mandate,
-- not because the engine consults them" (0167 §32-36). The live engine reads
-- workflows -> workflow_instances -> approval_tasks only. Rows are retained for
-- audit history; no data is destroyed.
--
-- Idempotent: the collapse UPDATE is value-guarded, and COMMENT ON replaces.
-- No BEGIN/COMMIT and no schema_migrations row - migrate.js owns both.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Collapse every Hope Design workflow to its single primary approver.
-- ---------------------------------------------------------------------------
UPDATE workflows w
SET config     = jsonb_build_array(w.config -> 0),
    version    = w.version + 1,
    updated_at = now()
FROM companies c
WHERE c.id = w.company_id
  AND c.code = 'HDG'
  AND c.status = 'ACTIVE'
  AND w.config IS NOT NULL
  AND jsonb_typeof(w.config) = 'array'
  AND jsonb_array_length(w.config) > 1
  AND w.entity_type <> 'security_printing.jobs'
  AND w.config IS DISTINCT FROM jsonb_build_array(w.config -> 0);

-- ---------------------------------------------------------------------------
-- 2. Deprecate the dormant declarative approval model.
--
--    COMMENT ON is non-destructive and self-documenting: it survives in the
--    catalogue for anyone who later wonders whether these tables still matter.
-- ---------------------------------------------------------------------------
COMMENT ON TABLE approval_workflows IS
  'DEPRECATED (0204): declarative approval model superseded by the live workflows/workflow_instances/approval_tasks engine. Retained for audit history. Admin screens should read and edit the live workflows table.';
COMMENT ON TABLE approval_levels IS
  'DEPRECATED (0204): declarative approval level records. Superseded by the steps in workflows.config (JSONB). Retained for audit history.';
COMMENT ON TABLE approval_limits IS
  'DEPRECATED (0204): declarative per-role approval ceilings. Delegation ceilings now live in delegations.approval_limit / delegation_authorities.max_amount. Retained for audit history.';
COMMENT ON TABLE approval_rules IS
  'DEPRECATED (0204): unused declarative approval rules. No runtime path has ever consulted this table. Retained for audit history.';
COMMENT ON TABLE approval_fallback_rules IS
  'DEPRECATED (0204): declarative fallback approvers. Timeboxed absence coverage now lives in delegations (governance.ts). Retained for audit history.';
