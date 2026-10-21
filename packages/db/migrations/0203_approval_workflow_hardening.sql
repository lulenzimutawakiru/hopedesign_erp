-- ===========================================================================
-- 0203 - Approval workflow hardening
--
-- Backward-compatible, additive changes only. No destructive migration, no
-- data mutation. Each change maps to a finding in the approval-workflow audit
-- (docs/audit/AUDIT_APPROVAL_WORKFLOW_2026-10-20.md).
--
--   APR-1/4  fail-closed + lifecycle flags        (workflow.ts, no DDL here)
--   APR-3    self-approval coverage               (created_by columns)
--   APR-5    delegation enforcement at decision   (approval_tasks.delegation_id)
--   APR-7    approval separated from execution    (EXECUTION_PENDING/EXECUTED)
--   APR-8    stale-approval invalidation          (material_hash, amount)
--   APR-9    controlled exceptions                (approval_exceptions)
--
-- No BEGIN/COMMIT and no schema_migrations row - migrate.js owns both.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. workflow_instances: amount + material snapshot + execution state
-- ---------------------------------------------------------------------------
ALTER TABLE workflow_instances
  ADD COLUMN amount numeric(18,2),
  ADD COLUMN material_hash text,
  ADD COLUMN executed_by bigint REFERENCES users(id),
  ADD COLUMN executed_at timestamp with time zone;

-- Approval no longer doubles as execution: a document that needs a post/release
-- side effect is marked EXECUTION_PENDING once every approval step signs, and a
-- separate permissioned execute step moves it to EXECUTED.
ALTER TABLE workflow_instances DROP CONSTRAINT workflow_instances_status_check;
ALTER TABLE workflow_instances ADD CONSTRAINT workflow_instances_status_check
  CHECK (status = ANY (ARRAY['RUNNING','APPROVED','REJECTED','CANCELLED','ESCALATED','EXECUTION_PENDING','EXECUTED']));

-- ---------------------------------------------------------------------------
-- 2. approval_tasks: record the delegation a decision was made under
-- ---------------------------------------------------------------------------
ALTER TABLE approval_tasks
  ADD COLUMN delegation_id bigint REFERENCES delegations(id);

-- ---------------------------------------------------------------------------
-- 3. Self-approval coverage (APR-3): preparer columns on the four financial
--    documents that had none. crudFactory already populates created_by on
--    insert; the four custom creation paths are wired in the service layer.
-- ---------------------------------------------------------------------------
ALTER TABLE supplier_payments ADD COLUMN created_by bigint REFERENCES users(id);
ALTER TABLE credit_notes     ADD COLUMN created_by bigint REFERENCES users(id);
ALTER TABLE debit_notes      ADD COLUMN created_by bigint REFERENCES users(id);
ALTER TABLE supplier_invoices ADD COLUMN created_by bigint REFERENCES users(id);

-- ---------------------------------------------------------------------------
-- 4. Execution permission (APR-7). Finance executors already hold
--    workflows.instances.*; the real separation is enforced at decision time
--    (an approver may not execute what they approved). The row exists so the
--    code is first-class and appears in the RBAC catalogue.
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, module, resource, action, description, is_system)
VALUES ('workflows.instances.execute', 'workflows', 'instances', 'execute',
        'Execute a fully approved workflow (post/release the side effect)', false)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. Controlled exceptions (APR-9). A deviation from a mandatory rule is a
--    recorded, independently reviewed, time-boxed decision - never a silent
--    override. No runtime rule bypasses are wired here; this is the ledger that
--    makes any such deviation auditable.
-- ---------------------------------------------------------------------------
CREATE TABLE approval_exceptions (
  id                   bigserial PRIMARY KEY,
  tenant_id            bigint NOT NULL REFERENCES tenants(id),
  company_id           bigint NOT NULL REFERENCES companies(id),
  entity_type          text NOT NULL,
  entity_id            bigint NOT NULL,
  entity_code          text,
  deviation            text NOT NULL,
  justification        text NOT NULL,
  requested_by         bigint REFERENCES users(id),
  approved_by          bigint REFERENCES users(id),
  approved_at          timestamp with time zone,
  independent_reviewer bigint REFERENCES users(id),
  review_deadline      date,
  review_outcome       text,
  status               text NOT NULL DEFAULT 'REQUESTED'
                       CHECK (status IN ('REQUESTED','APPROVED','REJECTED','REVIEWED','EXPIRED')),
  created_at           timestamp with time zone NOT NULL DEFAULT now(),
  updated_at           timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_approval_exceptions_entity ON approval_exceptions (tenant_id, entity_type, entity_id);
CREATE INDEX idx_approval_exceptions_status ON approval_exceptions (status, review_deadline);

ALTER TABLE approval_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_exceptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approval_exceptions
  USING (tenant_id = public.app_tenant_id());

CREATE TRIGGER trg_set_updated_at
  BEFORE UPDATE ON approval_exceptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_approval_exceptions_audit
  AFTER INSERT OR UPDATE OR DELETE ON approval_exceptions
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();
