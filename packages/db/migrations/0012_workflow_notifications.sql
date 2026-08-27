-- ============================================================
-- 0012 Workflow engine, notifications, tasks, maintenance
-- ============================================================

CREATE TABLE workflows (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  description TEXT,
  -- steps: [{seq, name, approver_role, approver_user, amount_min, amount_max, sla_hours, branch_id, department_id, condition}]
  config JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workflow_instances (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  workflow_id BIGINT NOT NULL REFERENCES workflows(id),
  entity_type TEXT NOT NULL,
  entity_id BIGINT NOT NULL,
  entity_code TEXT,
  status TEXT NOT NULL DEFAULT 'RUNNING'
    CHECK (status IN ('RUNNING','APPROVED','REJECTED','CANCELLED','ESCALATED')),
  current_step INTEGER NOT NULL DEFAULT 1,
  created_by BIGINT REFERENCES users(id),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wf_entity ON workflow_instances(entity_type, entity_id);
CREATE INDEX idx_wf_status ON workflow_instances(status);

CREATE TABLE approval_tasks (
  id BIGSERIAL PRIMARY KEY,
  instance_id BIGINT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  step_seq INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  approver_role_id BIGINT REFERENCES roles(id),
  approver_user_id BIGINT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','REJECTED','RETURNED','DELEGATED','ESCALATED')),
  comment TEXT,
  decided_by BIGINT REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  delegated_from BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_approval_pending ON approval_tasks(status) WHERE status = 'PENDING';

-- Generic approvals queue (lightweight view of workflow tasks)
CREATE VIEW v_approvals_pending AS
SELECT t.id AS task_id, i.id AS instance_id, i.entity_type, i.entity_id, i.entity_code,
       i.workflow_id, w.name AS workflow_name, t.step_seq, t.step_name,
       t.status, t.due_at, i.company_id, i.tenant_id, i.created_by, i.submitted_at
FROM approval_tasks t
JOIN workflow_instances i ON i.id = t.instance_id
JOIN workflows w ON w.id = i.workflow_id
WHERE t.status = 'PENDING';

CREATE TABLE notifications (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  entity_type TEXT,
  entity_id BIGINT,
  severity TEXT NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO','SUCCESS','WARN','ERROR')),
  action_required BOOLEAN NOT NULL DEFAULT false,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at);

CREATE TABLE user_tasks (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  entity_type TEXT,
  entity_id BIGINT,
  priority TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  due_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO','IN_PROGRESS','DONE','CANCELLED')),
  created_by BIGINT REFERENCES users(id),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_usertasks_user ON user_tasks(user_id, status);

-- ---------- Maintenance ----------
CREATE TABLE maintenance_requests (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  request_no TEXT NOT NULL,
  machine_id BIGINT REFERENCES machines(id),
  asset_id BIGINT REFERENCES assets(id),
  maintenance_type TEXT NOT NULL DEFAULT 'CORRECTIVE'
    CHECK (maintenance_type IN ('PREVENTIVE','CORRECTIVE','BREAKDOWN','INSPECTION')),
  priority TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','ASSIGNED','IN_PROGRESS','COMPLETED','CANCELLED')),
  requested_by BIGINT REFERENCES users(id),
  assigned_to BIGINT REFERENCES users(id),
  completed_at TIMESTAMPTZ,
  UNIQUE (company_id, request_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE maintenance_schedules (
  id BIGSERIAL PRIMARY KEY,
  machine_id BIGINT NOT NULL REFERENCES machines(id),
  name TEXT NOT NULL,
  frequency_days INTEGER NOT NULL DEFAULT 30,
  last_run_at DATE,
  next_run_at DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE maintenance_work_orders (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  mwo_no TEXT NOT NULL,
  request_id BIGINT REFERENCES maintenance_requests(id),
  machine_id BIGINT REFERENCES machines(id),
  asset_id BIGINT REFERENCES assets(id),
  technician_id BIGINT REFERENCES users(id),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  parts JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','IN_PROGRESS','COMPLETED','CANCELLED')),
  UNIQUE (company_id, mwo_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_work_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON workflows USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON workflow_instances USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON approval_tasks USING (instance_id IN (SELECT id FROM workflow_instances));
CREATE POLICY tenant_isolation ON notifications USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON user_tasks USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON maintenance_requests USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON maintenance_schedules USING (machine_id IN (SELECT id FROM machines));
CREATE POLICY tenant_isolation ON maintenance_work_orders USING (tenant_id = app_tenant_id());
