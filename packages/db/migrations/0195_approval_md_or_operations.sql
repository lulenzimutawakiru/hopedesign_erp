-- ============================================================
-- 0195 Approval: Managing Director step also accepts Operations Manager
-- ============================================================
-- The "Managing Director Approval" stage must be approvable by whoever holds
-- the managing_director OR operations_manager role. This adds a nullable
-- alternative approver role to approval_tasks, re-keys the five seeded
-- "Managing Director Approval" workflow steps from a single approver_role to
-- an approver_roles array, and backfills in-flight PENDING tasks so an
-- operations manager can decide them too.

ALTER TABLE approval_tasks
  ADD COLUMN IF NOT EXISTS alternative_role_id BIGINT REFERENCES roles(id);

-- Re-key seeded workflow steps. A step whose approver_role is managing_director
-- and whose name is "Managing Director*" becomes
-- approver_roles: ["managing_director", "operations_manager"]. Idempotent: a
-- step that already carries approver_roles no longer matches
-- approver_role = 'managing_director', so it is left untouched.
UPDATE workflows w
   SET config = (
     SELECT jsonb_agg(
       CASE
         WHEN e.elem->>'approver_role' = 'managing_director'
          AND e.elem->>'name' LIKE 'Managing Director%'
         THEN (e.elem - 'approver_role')
              || '{"approver_roles":["managing_director","operations_manager"]}'::jsonb
         ELSE e.elem
       END
       ORDER BY e.ord
     )
     FROM jsonb_array_elements(w.config) WITH ORDINALITY AS e(elem, ord)
   )
 WHERE jsonb_typeof(w.config) = 'array'
   AND w.config::text LIKE '%managing_director%';

-- Backfill in-flight PENDING "Managing Director*" tasks so an operations
-- manager can decide tasks that were seeded before this migration.
UPDATE approval_tasks t
   SET alternative_role_id = om.id
  FROM workflow_instances i,
       roles md,
       roles om
 WHERE t.instance_id = i.id
   AND t.approver_role_id = md.id
   AND md.code = 'managing_director'
   AND md.company_id = i.company_id
   AND om.code = 'operations_manager'
   AND om.company_id = i.company_id
   AND t.step_name LIKE 'Managing Director%'
   AND t.status = 'PENDING'
   AND t.alternative_role_id IS NULL;
