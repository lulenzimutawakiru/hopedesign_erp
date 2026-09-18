-- ===========================================================================
-- 0168 - Hope Design: approval workflows for the seven entity types that had none
--
-- The application can start a workflow for 32 entity types, but only 25 had a
-- row in workflows. startWorkflow treats a missing workflow as "auto-approve":
-- it writes the entity straight to its approved status, runs the configured
-- post-approval side effect and emits a <entity>.auto_approved event. For the
-- seven types below that meant real business documents skipping every sign-off
-- the structure prescribes - most seriously supplier invoices, whose approval
-- side effect posts the accounts-payable journal, so an invoice reached the
-- ledger and became payable with no CFO, Operations Manager or MD sign-off.
--
-- Each chain follows the company's standing route: the document is prepared,
-- verified and authorised by the Operations Manager, given final approval by
-- the Managing Director, and released to Accounting where money moves. Where
-- the structure puts a domain owner or the CFO ahead of that route, they are
-- prepended (HR Manager for people documents, CFO for payables).
--
-- Two engine properties shape the encoding, as in 0167:
--   * startWorkflow takes the SLA for every task from the first applicable
--     step, so all steps are unconditional (amount_min 0 / amount_max 0 means
--     "no floor, no ceiling") and the first step carries the shortest SLA.
--   * decideTask completes an instance only when no PENDING task remains, so
--     every step is a real, unskippable sign-off.
--
-- The "Managing Director Final Approval" step is keyed to operations_manager
-- rather than managing_director on purpose: the structure delegates the MD's
-- signature to the Operations Manager in the MD's absence, and both hold that
-- code, so the step stays decidable either way.
--
-- decideTask refuses to let the creator of a record decide its own task
-- (segregation of duties), which is why no step is keyed to a role that
-- prepares the document: employment contracts are raised by the System
-- Administrator and the MD, and final settlements by HR/Finance, so the HR
-- Manager step above them cannot deadlock.
--
-- Idempotent: the insert is guarded on entity_type (the key startWorkflow
-- matches on) and the update only fires when a stored config has drifted.
-- No BEGIN/COMMIT and no schema_migrations row - migrate.js owns both.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Create the workflows that do not exist yet.
-- ---------------------------------------------------------------------------

INSERT INTO workflows (company_id, tenant_id, code, name, entity_type, description, config, is_active, version, status)
SELECT c.id, c.tenant_id, v.code, v.name, v.entity_type, v.description, v.config, true, 1, 'PUBLISHED'
FROM companies c
CROSS JOIN (VALUES
  ('WF-SINV', 'Supplier Invoice Approval', 'procurement.supplier_invoices',
   'CFO review, Operations Manager verification, Managing Director final approval, then release to Accounting. Blocks the accounts-payable posting until every step signs.',
   '[{"seq":1,"name":"CFO Approval","approver_role":"cfo","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":4,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-FSET', 'Final Settlement Approval', 'hr.final_settlements',
   'HR Manager certification, CFO review, Operations Manager verification, Managing Director final approval, then release to Accounting for disbursement.',
   '[{"seq":1,"name":"HR Manager Approval","approver_role":"hr_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"CFO Approval","approver_role":"cfo","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":4,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":5,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-EMP', 'Employment Contract Approval', 'hr.contracts',
   'HR Manager approval, Operations Manager verification, Managing Director final approval. A signed commitment, not a disbursement, so no Accounting release step.',
   '[{"seq":1,"name":"HR Manager Approval","approver_role":"hr_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-PPLAN', 'Production Plan Approval', 'production.plans',
   'Operations Manager verification then Managing Director final approval before the plan is committed to the shop floor.',
   '[{"seq":1,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-WO', 'Work Order Approval', 'production.work_orders',
   'Operations Manager verification then Managing Director final approval before a work order may be released to production.',
   '[{"seq":1,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-BOM', 'Bill of Materials Approval', 'production.boms',
   'Operations Manager verification then Managing Director final approval. Also governs routings, which share the production.boms entity type.',
   '[{"seq":1,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-QT', 'Quotation Approval', 'sales.quotations',
   'Operations Manager verification then Managing Director final approval before a quotation is issued to a customer.',
   '[{"seq":1,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb)
) AS v(code, name, entity_type, description, config)
WHERE c.code = 'HDG'
  AND c.status = 'ACTIVE'
  AND c.id = (SELECT c2.id FROM companies c2 WHERE c2.code = 'HDG' AND c2.status = 'ACTIVE' ORDER BY c2.id LIMIT 1)
  AND NOT EXISTS (
    SELECT 1 FROM workflows w WHERE w.company_id = c.id AND w.entity_type = v.entity_type
  );

-- ---------------------------------------------------------------------------
-- 2. Realign any of the seven whose stored config has drifted, so the routes
--    above stay authoritative on re-run.
-- ---------------------------------------------------------------------------

UPDATE workflows w
SET config     = v.config,
    version    = w.version + 1,
    status     = 'PUBLISHED',
    is_active  = true,
    updated_at = now()
FROM (VALUES
  ('WF-SINV', 'Supplier Invoice Approval', 'procurement.supplier_invoices',
   'CFO review, Operations Manager verification, Managing Director final approval, then release to Accounting. Blocks the accounts-payable posting until every step signs.',
   '[{"seq":1,"name":"CFO Approval","approver_role":"cfo","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":4,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-FSET', 'Final Settlement Approval', 'hr.final_settlements',
   'HR Manager certification, CFO review, Operations Manager verification, Managing Director final approval, then release to Accounting for disbursement.',
   '[{"seq":1,"name":"HR Manager Approval","approver_role":"hr_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"CFO Approval","approver_role":"cfo","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":4,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":5,"name":"Released to Accounting","approver_role":"accountant","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-EMP', 'Employment Contract Approval', 'hr.contracts',
   'HR Manager approval, Operations Manager verification, Managing Director final approval. A signed commitment, not a disbursement, so no Accounting release step.',
   '[{"seq":1,"name":"HR Manager Approval","approver_role":"hr_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48},{"seq":3,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-PPLAN', 'Production Plan Approval', 'production.plans',
   'Operations Manager verification then Managing Director final approval before the plan is committed to the shop floor.',
   '[{"seq":1,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-WO', 'Work Order Approval', 'production.work_orders',
   'Operations Manager verification then Managing Director final approval before a work order may be released to production.',
   '[{"seq":1,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-BOM', 'Bill of Materials Approval', 'production.boms',
   'Operations Manager verification then Managing Director final approval. Also governs routings, which share the production.boms entity type.',
   '[{"seq":1,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb),
  ('WF-QT', 'Quotation Approval', 'sales.quotations',
   'Operations Manager verification then Managing Director final approval before a quotation is issued to a customer.',
   '[{"seq":1,"name":"Operations Manager Verification","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":24},{"seq":2,"name":"Managing Director Final Approval","approver_role":"operations_manager","amount_min":0,"amount_max":0,"sla_hours":48}]'::jsonb)
) AS v(code, name, entity_type, description, config)
WHERE w.company_id = (SELECT c.id FROM companies c WHERE c.code = 'HDG' AND c.status = 'ACTIVE' ORDER BY c.id LIMIT 1)
  AND w.code = v.code
  AND w.config IS DISTINCT FROM v.config;
