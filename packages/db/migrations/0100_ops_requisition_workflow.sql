-- ============================================================
-- 0100 Ops Requisition workflow fix (WF-REQOPS)
-- ============================================================
-- 0099 attempted to seed 'WF-REQ' for ops.requisitions, but that
-- code already existed for hr.requisitions (job requisitions), so
-- the WHERE NOT EXISTS guard skipped the insert. startWorkflow()
-- looks up workflows by entity_type = 'ops.requisitions' -> no row
-- -> every requisition silently auto-approved.
--
-- This migration seeds a dedicated workflow with a unique code and
-- guards on entity_type (idempotent even if re-run).

INSERT INTO workflows (company_id, tenant_id, code, name, entity_type, description, config, is_active)
SELECT c.id, c.tenant_id, 'WF-REQOPS', 'Requisition Approval', 'ops.requisitions',
  'Tiered requisition approval by value (configurable in this workflow).',
  '[{"seq":1,"name":"Department Manager Approval","approver_role":"finance_manager","amount_min":0,"amount_max":500000,"sla_hours":24},
    {"seq":1,"name":"Department Head Approval","approver_role":"operations_director","amount_min":500000,"amount_max":5000000,"sla_hours":24},
    {"seq":2,"name":"Finance Approval","approver_role":"finance_manager","amount_min":500000,"amount_max":5000000,"sla_hours":24},
    {"seq":1,"name":"Finance Manager Approval","approver_role":"finance_manager","amount_min":5000000,"amount_max":20000000,"sla_hours":24},
    {"seq":2,"name":"Managing Director Approval","approver_role":"managing_director","amount_min":5000000,"amount_max":20000000,"sla_hours":48},
    {"seq":1,"name":"CFO Approval","approver_role":"cfo","amount_min":20000000,"amount_max":1000000000,"sla_hours":24},
    {"seq":2,"name":"Executive Approval","approver_role":"executive_director","amount_min":20000000,"amount_max":1000000000,"sla_hours":48}]'::jsonb,
  true
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM workflows w WHERE w.company_id = c.id AND w.entity_type = 'ops.requisitions');
