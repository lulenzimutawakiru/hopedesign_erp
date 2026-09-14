-- ============================================================
-- 0150 Service Desk & ITSM (HOPE DESIGN GROUP LTD)
-- Central service management platform: categories, tickets,
-- lifecycle, assignment, queues, SLA, escalation, incidents,
-- service/access/change requests, problems, known errors, root
-- cause analysis, knowledge base, asset/QR integration.
--
-- Conventions: BIGSERIAL surrogate keys, tenant_id/company_id/
-- branch_id/created_by/created_at/updated_at on every business
-- table, append-only audit via audit_row(), tenant RLS.
-- ============================================================

-- ---------- 1. Ticket numbering ----------
-- HOPE DESIGN Service Desk ticket numbers are HDG-SD-YYYY-XXXXXX.
-- The prefix follows the company code so every legal entity gets its
-- own never-reused, database-controlled sequence.
CREATE OR REPLACE FUNCTION service_ticket_prefix(p_company bigint) RETURNS text AS $$
DECLARE v_code text;
BEGIN
  SELECT code INTO v_code FROM companies WHERE id = p_company;
  RETURN COALESCE(v_code, 'HDG') || '-SD';
END;
$$ LANGUAGE plpgsql STABLE;

-- Ticket numbers are allocated from document_numbers, the same
-- database-controlled sequence table the rest of the ERP uses. Unlike the
-- shared next_doc_no() helper -- which returns 0 on the very first call for a
-- new (tenant, prefix, year) because the INSERT relies on the column default --
-- the seed row here is explicitly created with last_seq = 1 so the first
-- ticket of the year is ...-000001 and no work item is ever numbered 000000.
--
-- Safety properties required by spec 4:
--   * transaction-safe   - the INSERT/UPDATE and the caller's ticket INSERT
--                          commit or roll back together;
--   * concurrency-safe   - ON CONFLICT DO UPDATE takes a row lock, so
--                          simultaneous calls serialise and each receives a
--                          distinct value;
--   * never reused       - last_seq only ever increases;
--   * unique per company - the prefix embeds the company code (HDG-SD), and
--                          service_tickets has UNIQUE (tenant_id, ticket_number).
CREATE OR REPLACE FUNCTION next_service_ticket_no(p_tenant bigint, p_company bigint)
RETURNS text AS $$
DECLARE
  v_prefix text    := service_ticket_prefix(p_company);
  v_year   integer := EXTRACT(YEAR FROM now())::int;
  v_seq    bigint;
BEGIN
  INSERT INTO document_numbers (tenant_id, prefix, doc_year, last_seq)
  VALUES (p_tenant, v_prefix, v_year, 1)
  ON CONFLICT (tenant_id, prefix, doc_year)
    DO UPDATE SET last_seq = document_numbers.last_seq + 1
  RETURNING last_seq INTO v_seq;

  IF v_seq IS NULL THEN
    SELECT last_seq INTO v_seq FROM document_numbers
    WHERE tenant_id = p_tenant AND prefix = v_prefix AND doc_year = v_year;
  END IF;

  RETURN v_prefix || '-' || v_year || '-' || lpad(v_seq::text, 6, '0');
END;
$$ LANGUAGE plpgsql;

-- ---------- 2. Priority matrix (IMPACT + URGENCY = PRIORITY) ----------
-- Impacts: ENTERPRISE, DEPARTMENT, INDIVIDUAL, MINOR
-- Urgencies: CRITICAL, HIGH, MEDIUM, LOW
-- IMPACT x URGENCY = PRIORITY (spec 6). Deliberately a pure, side-effect-free
-- function so it can be used in generated columns, views and API validation.
--
--   impact \ urgency | CRITICAL |  HIGH  | MEDIUM |  LOW
--   -----------------+----------+--------+--------+-------
--   ENTERPRISE       |   P1     |   P1   |   P2   |  P2     ERP down, site outage,
--   DEPARTMENT       |   P1     |   P2   |   P3   |  P3     security incident
--   INDIVIDUAL       |   P2     |   P3   |   P3   |  P4     one employee blocked
--   MINOR            |   P3     |   P4   |   P4   |  P4     routine / cosmetic
--
-- Unrecognised impact or urgency falls back to P3 (the catalogue default)
-- rather than silently downgrading real work to the lowest priority.
CREATE OR REPLACE FUNCTION service_priority_for(p_impact text, p_urgency text)
RETURNS text AS $$
DECLARE
  v_impact  text := upper(coalesce(p_impact,  ''));
  v_urgency text := upper(coalesce(p_urgency, ''));
BEGIN
  IF v_impact = 'ENTERPRISE' THEN
    RETURN CASE WHEN v_urgency IN ('CRITICAL','HIGH') THEN 'P1' ELSE 'P2' END;
  END IF;
  IF v_impact = 'DEPARTMENT' THEN
    RETURN CASE v_urgency
             WHEN 'CRITICAL' THEN 'P1'
             WHEN 'HIGH'     THEN 'P2'
             ELSE                 'P3'
           END;
  END IF;
  IF v_impact = 'INDIVIDUAL' THEN
    RETURN CASE v_urgency
             WHEN 'CRITICAL' THEN 'P2'
             WHEN 'HIGH'     THEN 'P3'
             WHEN 'MEDIUM'   THEN 'P3'
             ELSE                 'P4'
           END;
  END IF;
  IF v_impact = 'MINOR' THEN
    RETURN CASE WHEN v_urgency = 'CRITICAL' THEN 'P3' ELSE 'P4' END;
  END IF;
  RETURN 'P3';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------- 3. Ticket lifecycle guard ----------
-- No arbitrary status changes: only the transitions below are legal.
CREATE OR REPLACE FUNCTION service_ticket_status_transition_ok(p_from text, p_to text)
RETURNS boolean AS $$
BEGIN
  IF p_from = p_to THEN RETURN true; END IF;
  IF p_from = 'NEW' THEN RETURN p_to IN ('OPEN','ASSIGNED','CANCELLED','ESCALATED'); END IF;
  IF p_from = 'OPEN' THEN RETURN p_to IN ('ASSIGNED','IN_PROGRESS','PENDING_REQUESTER','PENDING_VENDOR','RESOLVED','CANCELLED','ESCALATED'); END IF;
  IF p_from = 'REOPENED' THEN RETURN p_to IN ('OPEN','ASSIGNED','IN_PROGRESS','CANCELLED'); END IF;
  IF p_from = 'ASSIGNED' THEN RETURN p_to IN ('OPEN','IN_PROGRESS','PENDING_REQUESTER','PENDING_VENDOR','RESOLVED','CANCELLED','ESCALATED'); END IF;
  IF p_from = 'IN_PROGRESS' THEN RETURN p_to IN ('ASSIGNED','OPEN','PENDING_REQUESTER','PENDING_VENDOR','RESOLVED','CANCELLED','ESCALATED'); END IF;
  IF p_from = 'ESCALATED' THEN RETURN p_to IN ('OPEN','ASSIGNED','IN_PROGRESS','PENDING_REQUESTER','PENDING_VENDOR','RESOLVED','CANCELLED'); END IF;
  IF p_from = 'PENDING_REQUESTER' THEN RETURN p_to IN ('OPEN','IN_PROGRESS','RESOLVED','CLOSED','CANCELLED','ESCALATED'); END IF;
  IF p_from = 'PENDING_VENDOR' THEN RETURN p_to IN ('OPEN','IN_PROGRESS','RESOLVED','CANCELLED','ESCALATED'); END IF;
  IF p_from = 'RESOLVED' THEN RETURN p_to IN ('CLOSED','REOPENED','IN_PROGRESS'); END IF;
  IF p_from = 'CLOSED' THEN RETURN p_to IN ('REOPENED'); END IF;
  IF p_from = 'CANCELLED' THEN RETURN p_to IN ('REOPENED'); END IF;
  RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------- 4. Service catalogue ----------
CREATE TABLE service_categories (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  -- ACCENT tints the workspace header; never the only signal of severity.
  accent TEXT NOT NULL DEFAULT 'info',
  default_queue_id BIGINT,
  default_priority TEXT NOT NULL DEFAULT 'P3'
    CHECK (default_priority IN ('P1','P2','P3','P4')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE service_subcategories (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  category_id BIGINT NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  default_priority TEXT CHECK (default_priority IN ('P1','P2','P3','P4')),
  default_queue_id BIGINT,
  requires_asset BOOLEAN NOT NULL DEFAULT false,
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (category_id, code)
);

-- ---------- 5. Queues, teams and skills (assignment targets) ----------
CREATE TABLE service_queues (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category_id BIGINT REFERENCES service_categories(id),
  -- MANUAL | ROUND_ROBIN | LOAD_BALANCED | SKILL_BASED | TEAM
  assignment_strategy TEXT NOT NULL DEFAULT 'MANUAL'
    CHECK (assignment_strategy IN ('MANUAL','ROUND_ROBIN','LOAD_BALANCED','SKILL_BASED','TEAM')),
  team_id BIGINT,
  target_response_minutes INTEGER,
  target_resolution_minutes INTEGER,
  max_open_tickets INTEGER,
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE service_teams (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  lead_user_id BIGINT REFERENCES users(id),
  email TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE service_team_members (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  team_id BIGINT NOT NULL REFERENCES service_teams(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id),
  is_lead BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id)
);

CREATE TABLE service_skills (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE service_agent_skills (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  user_id BIGINT NOT NULL REFERENCES users(id),
  skill_id BIGINT NOT NULL REFERENCES service_skills(id) ON DELETE CASCADE,
  proficiency SMALLINT NOT NULL DEFAULT 3 CHECK (proficiency BETWEEN 1 AND 5),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, skill_id)
);

CREATE TABLE service_category_skills (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  category_id BIGINT NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
  subcategory_id BIGINT REFERENCES service_subcategories(id) ON DELETE CASCADE,
  skill_id BIGINT NOT NULL REFERENCES service_skills(id) ON DELETE CASCADE,
  min_proficiency SMALLINT NOT NULL DEFAULT 1 CHECK (min_proficiency BETWEEN 1 AND 5),
  UNIQUE (category_id, subcategory_id, skill_id)
);

-- ---------- 6. Business calendars and holidays ----------
CREATE TABLE service_business_calendars (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Africa/Kampala',
  -- 0=Sunday .. 6=Saturday. working_days lists the staffed days.
  working_days INTEGER[] NOT NULL DEFAULT '{1,2,3,4,5}',
  work_start TIME NOT NULL DEFAULT '08:00',
  work_end TIME NOT NULL DEFAULT '17:00',
  is_24x7 BOOLEAN NOT NULL DEFAULT false,
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE service_holidays (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  calendar_id BIGINT NOT NULL REFERENCES service_business_calendars(id) ON DELETE CASCADE,
  holiday_date DATE NOT NULL,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (calendar_id, holiday_date)
);

-- ---------- 7. Service tickets ----------
-- Core service ticket table (spec 21). Ticket numbers are issued by
-- next_service_ticket_no(); status changes are validated by the trigger
-- installed in section 18.
CREATE TABLE service_tickets (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  ticket_number TEXT NOT NULL,
  -- INCIDENT | SERVICE_REQUEST | ACCESS_REQUEST | CHANGE_REQUEST | MAINTENANCE_REQUEST | SECURITY_INCIDENT
  ticket_type TEXT NOT NULL DEFAULT 'INCIDENT'
    CHECK (ticket_type IN ('INCIDENT','SERVICE_REQUEST','ACCESS_REQUEST','CHANGE_REQUEST','MAINTENANCE_REQUEST','SECURITY_INCIDENT')),
  requester_employee_id BIGINT REFERENCES employees(id),
  requester_user_id BIGINT REFERENCES users(id),
  preferred_contact TEXT,
  category_id BIGINT REFERENCES service_categories(id),
  subcategory_id BIGINT REFERENCES service_subcategories(id),
  subject TEXT NOT NULL,
  description TEXT,
  impact TEXT CHECK (impact IN ('ENTERPRISE','DEPARTMENT','INDIVIDUAL','MINOR')),
  urgency TEXT CHECK (urgency IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  priority TEXT NOT NULL DEFAULT 'P3' CHECK (priority IN ('P1','P2','P3','P4')),
  priority_overridden BOOLEAN NOT NULL DEFAULT false,
  priority_override_reason TEXT,
  status TEXT NOT NULL DEFAULT 'NEW'
    CHECK (status IN ('NEW','OPEN','ASSIGNED','IN_PROGRESS','PENDING_REQUESTER','PENDING_VENDOR','RESOLVED','CLOSED','CANCELLED','REOPENED','ESCALATED')),
  status_reason TEXT,
  data_classification TEXT NOT NULL DEFAULT 'INTERNAL'
    CHECK (data_classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  assigned_queue_id BIGINT REFERENCES service_queues(id),
  assigned_team_id BIGINT REFERENCES service_teams(id),
  assigned_to_user_id BIGINT REFERENCES users(id),
  assignment_strategy TEXT,
  affected_asset_id BIGINT REFERENCES asset_register(id),
  device_info JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'PORTAL' CHECK (source IN ('PORTAL','AGENT','MOBILE','EMAIL','QR_SCAN','PHONE','API','SYSTEM')),
  related_incident_id BIGINT,
  related_problem_id BIGINT,
  related_change_id BIGINT,
  parent_ticket_id BIGINT REFERENCES service_tickets(id),
  reopen_count INTEGER NOT NULL DEFAULT 0,
  resolution_code TEXT,
  resolution_summary TEXT,
  confirmation_required BOOLEAN NOT NULL DEFAULT true,
  confirmed_at TIMESTAMPTZ,
  confirmed_by BIGINT REFERENCES employees(id),
  satisfaction_rating SMALLINT CHECK (satisfaction_rating BETWEEN 1 AND 5),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_response_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  reopened_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  sla_response_due_at TIMESTAMPTZ,
  sla_resolution_due_at TIMESTAMPTZ,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ticket_number)
);

CREATE INDEX idx_service_tickets_company_status ON service_tickets(company_id, status);
CREATE INDEX idx_service_tickets_assignee ON service_tickets(assigned_to_user_id, status);
CREATE INDEX idx_service_tickets_queue ON service_tickets(assigned_queue_id, status);
CREATE INDEX idx_service_tickets_requester ON service_tickets(requester_employee_id, status);
CREATE INDEX idx_service_tickets_requester_user ON service_tickets(requester_user_id, status);
CREATE INDEX idx_service_tickets_category ON service_tickets(category_id, subcategory_id);
CREATE INDEX idx_service_tickets_priority ON service_tickets(company_id, priority, status);
CREATE INDEX idx_service_tickets_asset ON service_tickets(affected_asset_id);
CREATE INDEX idx_service_tickets_opened ON service_tickets(company_id, opened_at DESC);
CREATE INDEX idx_service_tickets_sla_due ON service_tickets(sla_resolution_due_at) WHERE status NOT IN ('RESOLVED','CLOSED','CANCELLED');
CREATE INDEX idx_service_tickets_number_trgm ON service_tickets USING gin (ticket_number gin_trgm_ops);

-- Public reply vs internal note. is_internal=true is never exposed to the
-- requester: the API requires service_desk.internal_notes.view and always
-- filters is_internal=false on employee-facing queries.
CREATE TABLE ticket_comments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  ticket_id BIGINT NOT NULL REFERENCES service_tickets(id) ON DELETE CASCADE,
  comment_type TEXT NOT NULL DEFAULT 'REPLY' CHECK (comment_type IN ('REPLY','NOTE','SYSTEM')),
  is_internal BOOLEAN NOT NULL DEFAULT false,
  body TEXT NOT NULL,
  author_user_id BIGINT REFERENCES users(id),
  author_employee_id BIGINT REFERENCES employees(id),
  author_display TEXT,
  notified_at TIMESTAMPTZ,
  is_edited BOOLEAN NOT NULL DEFAULT false,
  edited_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ticket_comments_ticket ON ticket_comments(ticket_id, created_at);
CREATE INDEX idx_ticket_comments_public ON ticket_comments(ticket_id, is_internal);

CREATE TABLE ticket_attachments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  ticket_id BIGINT NOT NULL REFERENCES service_tickets(id) ON DELETE CASCADE,
  comment_id BIGINT REFERENCES ticket_comments(id) ON DELETE SET NULL,
  document_id BIGINT REFERENCES documents(id),
  file_name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  storage_key TEXT,
  kind TEXT NOT NULL DEFAULT 'ATTACHMENT' CHECK (kind IN ('ATTACHMENT','EVIDENCE','PHOTO','LOG','SCREENSHOT')),
  is_internal BOOLEAN NOT NULL DEFAULT false,
  uploaded_by_user_id BIGINT REFERENCES users(id),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ticket_attachments_ticket ON ticket_attachments(ticket_id);

-- Full assignment + reassignment ledger with reason (spec 10).
CREATE TABLE ticket_assignments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  ticket_id BIGINT NOT NULL REFERENCES service_tickets(id) ON DELETE CASCADE,
  assignment_type TEXT NOT NULL DEFAULT 'MANUAL'
    CHECK (assignment_type IN ('MANUAL','AUTOMATIC','QUEUE','TEAM','SKILL_BASED','ROUND_ROBIN')),
  assigned_to_user_id BIGINT REFERENCES users(id),
  assigned_team_id BIGINT REFERENCES service_teams(id),
  queue_id BIGINT REFERENCES service_queues(id),
  assigned_from_user_id BIGINT REFERENCES users(id),
  previous_assignee_id BIGINT REFERENCES users(id),
  is_reassignment BOOLEAN NOT NULL DEFAULT false,
  reason TEXT,
  strategy_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  assigned_by BIGINT REFERENCES users(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ticket_assignments_ticket ON ticket_assignments(ticket_id, assigned_at DESC);
CREATE INDEX idx_ticket_assignments_user ON ticket_assignments(assigned_to_user_id, assigned_at DESC);

CREATE TABLE ticket_status_history (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  ticket_id BIGINT NOT NULL REFERENCES service_tickets(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  changed_by BIGINT REFERENCES users(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ticket_status_history_ticket ON ticket_status_history(ticket_id, changed_at);

-- Links incidents to problems, tickets to changes, duplicates to originals.
CREATE TABLE ticket_relations (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  ticket_id BIGINT NOT NULL REFERENCES service_tickets(id) ON DELETE CASCADE,
  related_ticket_id BIGINT NOT NULL REFERENCES service_tickets(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL DEFAULT 'RELATED'
    CHECK (relation_type IN ('RELATED','DUPLICATE','BLOCKS','BLOCKED_BY','CAUSED_BY','PARENT','CHILD')),
  note TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, related_ticket_id, relation_type)
);

-- ---------- 8. SLA policies and tracking ----------
-- One policy row per (category | priority | department | branch | service
-- type) combination. Most specific match wins; a NULL dimension is a
-- wildcard. Business-hours policies count only staffed minutes.
CREATE TABLE sla_policies (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category_id BIGINT REFERENCES service_categories(id),
  priority TEXT CHECK (priority IN ('P1','P2','P3','P4')),
  department_id BIGINT REFERENCES departments(id),
  ticket_type TEXT,
  calendar_id BIGINT REFERENCES service_business_calendars(id),
  response_minutes INTEGER NOT NULL CHECK (response_minutes > 0),
  resolution_minutes INTEGER NOT NULL CHECK (resolution_minutes > 0),
  -- Pause the resolution clock while the ticket waits on the requester/vendor.
  pause_on_pending BOOLEAN NOT NULL DEFAULT true,
  -- Warn this many minutes before a target is due.
  warning_minutes INTEGER NOT NULL DEFAULT 30,
  escalation_enabled BOOLEAN NOT NULL DEFAULT true,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE sla_tracking (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  ticket_id BIGINT NOT NULL REFERENCES service_tickets(id) ON DELETE CASCADE,
  policy_id BIGINT NOT NULL REFERENCES sla_policies(id),
  state TEXT NOT NULL DEFAULT 'RUNNING'
    CHECK (state IN ('RUNNING','PAUSED','MET','BREACHED','CANCELLED')),
  response_due_at TIMESTAMPTZ,
  first_response_at TIMESTAMPTZ,
  response_state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (response_state IN ('PENDING','MET','BREACHED','CANCELLED')),
  resolution_due_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolution_state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (resolution_state IN ('PENDING','MET','BREACHED','CANCELLED')),
  -- Business-minute accounting: elapsed minus paused, in the policy calendar.
  consumed_minutes INTEGER NOT NULL DEFAULT 0,
  paused_minutes INTEGER NOT NULL DEFAULT 0,
  paused_at TIMESTAMPTZ,
  response_warning_at TIMESTAMPTZ,
  response_warning_sent_at TIMESTAMPTZ,
  resolution_warning_at TIMESTAMPTZ,
  resolution_warning_sent_at TIMESTAMPTZ,
  breached_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticket_id)
);

CREATE TABLE sla_breaches (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  ticket_id BIGINT NOT NULL REFERENCES service_tickets(id) ON DELETE CASCADE,
  tracking_id BIGINT REFERENCES sla_tracking(id) ON DELETE SET NULL,
  policy_id BIGINT REFERENCES sla_policies(id),
  breach_type TEXT NOT NULL CHECK (breach_type IN ('RESPONSE','RESOLUTION')),
  due_at TIMESTAMPTZ NOT NULL,
  breached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  minutes_over INTEGER NOT NULL DEFAULT 0,
  -- The reason the SLA was missed, captured at closure for reporting.
  reason TEXT,
  acknowledged_by BIGINT REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, breach_type)
);

-- ---------- 9. Escalation ----------
CREATE TABLE escalation_levels (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  role_code TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, level)
);

CREATE TABLE escalation_rules (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category_id BIGINT REFERENCES service_categories(id),
  priority TEXT CHECK (priority IN ('P1','P2','P3','P4')),
  level_id BIGINT NOT NULL REFERENCES escalation_levels(id),
  after_minutes INTEGER NOT NULL CHECK (after_minutes > 0),
  -- Trigger the rule when the first response / resolution is still missing.
  trigger_on TEXT NOT NULL DEFAULT 'NO_RESPONSE'
    CHECK (trigger_on IN ('NO_RESPONSE','NO_RESOLUTION','SLA_WARNING','SLA_BREACH')),
  notify_roles TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE ticket_escalations (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  ticket_id BIGINT NOT NULL REFERENCES service_tickets(id) ON DELETE CASCADE,
  rule_id BIGINT REFERENCES escalation_rules(id) ON DELETE SET NULL,
  level_id BIGINT REFERENCES escalation_levels(id),
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
  reason TEXT NOT NULL,
  -- AUTOMATIC (SLA/rule engine) or MANUAL (agent raised it).
  trigger_type TEXT NOT NULL DEFAULT 'AUTOMATIC'
    CHECK (trigger_type IN ('AUTOMATIC','MANUAL')),
  escalated_from_user_id BIGINT REFERENCES users(id),
  escalated_to_user_id BIGINT REFERENCES users(id),
  escalated_to_role TEXT,
  notified_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by BIGINT REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 10. Service requests and incidents ----------
-- service_tickets carries the shared spine; these two tables carry the
-- type-specific detail (what was asked for / what broke).
CREATE TABLE service_requests (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  ticket_id BIGINT NOT NULL REFERENCES service_tickets(id) ON DELETE CASCADE,
  subcategory_id BIGINT REFERENCES service_subcategories(id),
  catalog_item TEXT,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  required_by DATE,
  delivery_location TEXT,
  preferred_contact_method TEXT
    CHECK (preferred_contact_method IS NULL
           OR preferred_contact_method IN ('EMAIL','PHONE','SMS','IN_PERSON','PORTAL')),
  fulfilment_status TEXT NOT NULL DEFAULT 'REQUESTED'
    CHECK (fulfilment_status IN ('REQUESTED','APPROVED','IN_FULFILMENT','FULFILLED','REJECTED','CANCELLED')),
  approver_employee_id BIGINT REFERENCES employees(id),
  approved_at TIMESTAMPTZ,
  fulfilled_by BIGINT REFERENCES users(id),
  fulfilled_at TIMESTAMPTZ,
  estimated_cost NUMERIC(18,2),
  currency TEXT NOT NULL DEFAULT 'UGX',
  notes TEXT,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticket_id)
);

CREATE TABLE incidents (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  ticket_id BIGINT NOT NULL REFERENCES service_tickets(id) ON DELETE CASCADE,
  incident_no TEXT,
  detection_source TEXT NOT NULL DEFAULT 'USER_REPORT'
    CHECK (detection_source IN ('USER_REPORT','MONITORING','AGENT','QR_SCAN','PHONE','API','SCHEDULED_JOB')),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  affected_service TEXT,
  affected_asset_id BIGINT REFERENCES asset_register(id),
  -- Major and security incidents surface on the executive dashboard and are
  -- never downgraded silently.
  is_major BOOLEAN NOT NULL DEFAULT false,
  is_security_incident BOOLEAN NOT NULL DEFAULT false,
  impact_summary TEXT,
  outage_minutes INTEGER CHECK (outage_minutes IS NULL OR outage_minutes >= 0),
  workaround TEXT,
  workaround_applied_at TIMESTAMPTZ,
  root_cause TEXT,
  resolution_summary TEXT,
  resolved_by BIGINT REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  -- FK to problems(id) is installed with the other deferred constraints at the
  -- end of this migration (problems is created in section 11).
  problem_id BIGINT,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticket_id)
);

CREATE INDEX idx_incidents_major ON incidents(company_id, is_major, detected_at DESC);
CREATE INDEX idx_incidents_security ON incidents(company_id, is_security_incident) WHERE is_security_incident;
CREATE INDEX idx_incidents_problem ON incidents(problem_id) WHERE problem_id IS NOT NULL;
CREATE INDEX idx_incidents_asset ON incidents(affected_asset_id) WHERE affected_asset_id IS NOT NULL;

-- ---------- 11. Problem management ----------
-- Recurring incidents become a problem; a problem becomes a known error once a
-- root cause and a workaround exist, and closes only on a permanent fix.
CREATE TABLE problems (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  problem_number TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  category_id BIGINT REFERENCES service_categories(id),
  subcategory_id BIGINT REFERENCES service_subcategories(id),
  status TEXT NOT NULL DEFAULT 'NEW'
    CHECK (status IN ('NEW','INVESTIGATING','ROOT_CAUSE_IDENTIFIED','KNOWN_ERROR','RESOLVED','CLOSED','CANCELLED')),
  priority TEXT CHECK (priority IN ('P1','P2','P3','P4')),
  impact TEXT CHECK (impact IN ('ENTERPRISE','DEPARTMENT','INDIVIDUAL','MINOR')),
  -- Denormalised counter so the agent queue can rank problems by blast radius
  -- without aggregating the link table on every read.
  incident_count INTEGER NOT NULL DEFAULT 0,
  assigned_to_user_id BIGINT REFERENCES users(id),
  assigned_team_id BIGINT REFERENCES service_teams(id),
  root_cause TEXT,
  workaround TEXT,
  permanent_fix TEXT,
  identified_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  closed_by BIGINT REFERENCES users(id),
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, problem_number)
);

CREATE INDEX idx_problems_company_status ON problems(company_id, status);
CREATE INDEX idx_problems_assignee ON problems(assigned_to_user_id, status);
CREATE INDEX idx_problems_category ON problems(category_id, subcategory_id);

CREATE TABLE problem_incidents (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  problem_id BIGINT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  incident_id BIGINT REFERENCES incidents(id) ON DELETE SET NULL,
  ticket_id BIGINT REFERENCES service_tickets(id) ON DELETE SET NULL,
  -- How this incident relates: it triggered the problem or it was matched to it.
  link_type TEXT NOT NULL DEFAULT 'MATCHED'
    CHECK (link_type IN ('TRIGGERING','MATCHED','MANUAL')),
  linked_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (problem_id, ticket_id)
);

CREATE INDEX idx_problem_incidents_ticket ON problem_incidents(ticket_id);

CREATE TABLE known_errors (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  problem_id BIGINT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  error_code TEXT,
  title TEXT NOT NULL,
  symptoms TEXT,
  workaround TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','FIX_PENDING','RESOLVED','ARCHIVED')),
  -- Surfacing the known error to agents turns a repeat incident into a
  -- first-time fix.
  agent_visible BOOLEAN NOT NULL DEFAULT true,
  resolved_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, error_code)
);

CREATE TABLE root_cause_analyses (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  problem_id BIGINT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  method TEXT NOT NULL DEFAULT 'FIVE_WHYS'
    CHECK (method IN ('FIVE_WHYS','FISHBONE','FAULT_TREE','KEPNER_TREGOE','OTHER')),
  -- What happened, why it was not detected, and what stops it recurring.
  incident_timeline TEXT,
  root_cause TEXT,
  contributing_factors TEXT,
  detection_gap TEXT,
  corrective_actions TEXT,
  preventive_actions TEXT,
  recommendation TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','IN_REVIEW','APPROVED','REJECTED')),
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rca_problem ON root_cause_analyses(problem_id, status);

-- ---------- 12. Change management ----------
-- CHANGE REQUEST -> RISK ASSESSMENT -> IMPACT ANALYSIS -> APPROVAL ->
-- IMPLEMENTATION -> VALIDATION -> CLOSURE.
CREATE TABLE change_requests (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  change_number TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  justification TEXT,
  change_type TEXT NOT NULL DEFAULT 'NORMAL'
    CHECK (change_type IN ('NORMAL','STANDARD','EMERGENCY')),
  category_id BIGINT REFERENCES service_categories(id),
  subcategory_id BIGINT REFERENCES service_subcategories(id),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','RISK_ASSESSMENT','IMPACT_ANALYSIS','PENDING_APPROVAL','APPROVED',
                      'REJECTED','IMPLEMENTATION','VALIDATION','CLOSED','FAILED','ROLLED_BACK','CANCELLED')),
  priority TEXT CHECK (priority IN ('P1','P2','P3','P4')),
  risk_level TEXT CHECK (risk_level IS NULL OR risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  risk_assessment TEXT,
  impact_analysis TEXT,
  affected_systems TEXT[],
  affected_asset_id BIGINT REFERENCES asset_register(id),
  planned_start_at TIMESTAMPTZ,
  planned_end_at TIMESTAMPTZ,
  actual_start_at TIMESTAMPTZ,
  actual_end_at TIMESTAMPTZ,
  downtime_minutes INTEGER CHECK (downtime_minutes IS NULL OR downtime_minutes >= 0),
  implementation_plan TEXT,
  backout_plan TEXT,
  test_plan TEXT,
  validation_notes TEXT,
  document_id BIGINT REFERENCES documents(id),
  requested_by BIGINT REFERENCES users(id),
  requested_by_employee_id BIGINT REFERENCES employees(id),
  assigned_to_user_id BIGINT REFERENCES users(id),
  assigned_team_id BIGINT REFERENCES service_teams(id),
  related_ticket_id BIGINT REFERENCES service_tickets(id),
  related_problem_id BIGINT REFERENCES problems(id),
  -- Emergency changes are approved after the fact. The deviation is recorded
  -- explicitly so the audit trail shows it was authorised retrospectively.
  is_emergency BOOLEAN NOT NULL DEFAULT false,
  retrospective_approval_required BOOLEAN NOT NULL DEFAULT false,
  retrospective_approved_by BIGINT REFERENCES users(id),
  retrospective_approval_at TIMESTAMPTZ,
  retrospective_justification TEXT,
  implemented_by BIGINT REFERENCES users(id),
  implemented_at TIMESTAMPTZ,
  validated_by BIGINT REFERENCES users(id),
  validated_at TIMESTAMPTZ,
  closed_by BIGINT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, change_number)
);

CREATE INDEX idx_change_requests_company_status ON change_requests(company_id, status);
CREATE INDEX idx_change_requests_window ON change_requests(planned_start_at) WHERE status NOT IN ('CLOSED','CANCELLED','REJECTED');
CREATE INDEX idx_change_requests_ticket ON change_requests(related_ticket_id) WHERE related_ticket_id IS NOT NULL;

CREATE TABLE change_approvals (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  change_id BIGINT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 1 CHECK (seq > 0),
  approval_type TEXT NOT NULL DEFAULT 'IMPLEMENTATION'
    CHECK (approval_type IN ('RISK','CAB','IMPLEMENTATION','RETROSPECTIVE','EMERGENCY')),
  approver_role TEXT,
  approver_user_id BIGINT REFERENCES users(id),
  approver_employee_id BIGINT REFERENCES employees(id),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','REJECTED','DELEGATED','SKIPPED')),
  decided_at TIMESTAMPTZ,
  comments TEXT,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (change_id, approval_type, seq)
);

CREATE INDEX idx_change_approvals_pending ON change_approvals(approver_user_id, status) WHERE status = 'PENDING';

-- ---------- 13. Knowledge base ----------
-- DRAFT -> REVIEW -> APPROVED -> PUBLISHED -> ARCHIVED. Only PUBLISHED
-- articles reach ordinary employees; agents may read APPROVED drafts.
CREATE TABLE knowledge_categories (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  parent_id BIGINT REFERENCES knowledge_categories(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  sort_order INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE knowledge_articles (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  article_number TEXT NOT NULL,
  category_id BIGINT REFERENCES knowledge_categories(id),
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT,
  keywords TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','REVIEW','APPROVED','PUBLISHED','ARCHIVED')),
  data_classification TEXT NOT NULL DEFAULT 'INTERNAL'
    CHECK (data_classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  -- Empty array means "everyone who can read the knowledge base".
  audience_roles TEXT[] NOT NULL DEFAULT '{}',
  current_version INTEGER NOT NULL DEFAULT 1,
  author_user_id BIGINT REFERENCES users(id),
  owner_user_id BIGINT REFERENCES users(id),
  reviewed_by BIGINT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  published_by BIGINT REFERENCES users(id),
  published_at TIMESTAMPTZ,
  archived_by BIGINT REFERENCES users(id),
  archived_at TIMESTAMPTZ,
  view_count INTEGER NOT NULL DEFAULT 0,
  helpful_count INTEGER NOT NULL DEFAULT 0,
  not_helpful_count INTEGER NOT NULL DEFAULT 0,
  -- Running totals keep the average rating a single-row read.
  rating_sum INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  ticket_usage_count INTEGER NOT NULL DEFAULT 0,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, article_number)
);

CREATE INDEX idx_knowledge_articles_status ON knowledge_articles(company_id, status);
CREATE INDEX idx_knowledge_articles_category ON knowledge_articles(category_id, status);
CREATE INDEX idx_knowledge_articles_keywords ON knowledge_articles USING gin (keywords);
CREATE INDEX idx_knowledge_articles_title_trgm ON knowledge_articles USING gin (title gin_trgm_ops);

CREATE TABLE knowledge_versions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  article_id BIGINT NOT NULL REFERENCES knowledge_articles(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT,
  change_note TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','REVIEW','APPROVED','PUBLISHED','ARCHIVED')),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (article_id, version)
);

CREATE TABLE knowledge_feedback (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  article_id BIGINT NOT NULL REFERENCES knowledge_articles(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id),
  employee_id BIGINT REFERENCES employees(id),
  is_helpful BOOLEAN,
  rating SMALLINT CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  comment TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One rating per person per article; re-rating updates in place.
  UNIQUE (article_id, user_id)
);

CREATE TABLE ticket_knowledge_links (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  ticket_id BIGINT NOT NULL REFERENCES service_tickets(id) ON DELETE CASCADE,
  article_id BIGINT NOT NULL REFERENCES knowledge_articles(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL DEFAULT 'RECOMMENDED'
    CHECK (link_type IN ('RECOMMENDED','USED','RESOLVED_BY')),
  linked_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, article_id)
);

CREATE INDEX idx_ticket_knowledge_links_article ON ticket_knowledge_links(article_id);

-- ---------- 14. Access requests ----------
-- EMPLOYEE -> REQUEST ERP ACCESS -> MANAGER APPROVAL -> SYSTEM / DATA OWNER
-- APPROVAL -> RBAC ROLE ASSIGNMENT -> ABAC SCOPE CONFIGURATION -> ACCESS
-- GRANTED -> AUDIT.
-- The Service Desk never grants access directly. It records the approvals and
-- hands the grant to the identity layer; a request that has not cleared both
-- approval steps cannot reach GRANTED.
CREATE TABLE access_requests (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  ticket_id BIGINT NOT NULL REFERENCES service_tickets(id) ON DELETE CASCADE,
  request_number TEXT NOT NULL,
  requester_employee_id BIGINT REFERENCES employees(id),
  target_user_id BIGINT REFERENCES users(id),
  system_name TEXT NOT NULL,
  access_type TEXT NOT NULL DEFAULT 'ROLE'
    CHECK (access_type IN ('ROLE','PERMISSION','MODULE','DATA_SCOPE','SHARED_MAILBOX','VPN','FOLDER','DATABASE','OTHER')),
  requested_role_code TEXT,
  requested_permissions TEXT[] NOT NULL DEFAULT '{}',
  -- The ABAC scope the requester is asking for, e.g. {"company_id":3,"branch_id":7}.
  requested_scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  justification TEXT NOT NULL,
  duration TEXT NOT NULL DEFAULT 'PERMANENT'
    CHECK (duration IN ('PERMANENT','TEMPORARY','DATE_BOUNDED')),
  access_starts_at TIMESTAMPTZ,
  access_expires_at TIMESTAMPTZ,
  data_classification TEXT NOT NULL DEFAULT 'INTERNAL'
    CHECK (data_classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  risk_level TEXT CHECK (risk_level IS NULL OR risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status TEXT NOT NULL DEFAULT 'SUBMITTED'
    CHECK (status IN ('DRAFT','SUBMITTED','MANAGER_APPROVED','OWNER_APPROVED','APPROVED','REJECTED',
                      'PROVISIONING','GRANTED','PROVISION_FAILED','EXPIRED','REVOKED','CANCELLED')),
  manager_approval_required BOOLEAN NOT NULL DEFAULT true,
  owner_approval_required BOOLEAN NOT NULL DEFAULT true,
  current_step INTEGER NOT NULL DEFAULT 1 CHECK (current_step > 0),
  granted_role_id BIGINT REFERENCES roles(id),
  granted_by BIGINT REFERENCES users(id),
  granted_at TIMESTAMPTZ,
  revoked_by BIGINT REFERENCES users(id),
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, request_number)
);

CREATE INDEX idx_access_requests_status ON access_requests(company_id, status);
CREATE INDEX idx_access_requests_requester ON access_requests(requester_employee_id, status);
CREATE INDEX idx_access_requests_target ON access_requests(target_user_id) WHERE target_user_id IS NOT NULL;
CREATE INDEX idx_access_requests_expiry ON access_requests(access_expires_at) WHERE access_expires_at IS NOT NULL AND status = 'GRANTED';

CREATE TABLE access_approvals (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  access_request_id BIGINT NOT NULL REFERENCES access_requests(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 1 CHECK (seq > 0),
  step TEXT NOT NULL
    CHECK (step IN ('MANAGER','SYSTEM_OWNER','DATA_OWNER','SECURITY','ADMIN')),
  approver_role TEXT,
  approver_user_id BIGINT REFERENCES users(id),
  approver_employee_id BIGINT REFERENCES employees(id),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','REJECTED','DELEGATED','SKIPPED')),
  decided_at TIMESTAMPTZ,
  comments TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (access_request_id, step, seq)
);

CREATE INDEX idx_access_approvals_pending ON access_approvals(approver_user_id, status) WHERE status = 'PENDING';

-- ---------- 15. QR asset service desk ----------
-- SCAN -> AUTHENTICATE -> RBAC -> ABAC -> ASSET IDENTIFIED -> VIEW AUTHORIZED
-- DETAILS -> CREATE / VIEW SERVICE TICKETS.
-- Every scan is written here whether or not it was allowed: a denied scan is
-- itself a security signal and must be reviewable.
CREATE TABLE asset_service_scans (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  scanned_by BIGINT REFERENCES users(id),
  scanned_by_employee_id BIGINT REFERENCES employees(id),
  qr_code_id BIGINT REFERENCES qr_codes(id),
  qr_value TEXT,
  asset_id BIGINT REFERENCES asset_register(id),
  asset_no TEXT,
  action TEXT NOT NULL DEFAULT 'VIEW'
    CHECK (action IN ('VIEW','REPORT_INCIDENT','CREATE_SERVICE_REQUEST','VIEW_ASSET_HISTORY',
                      'VIEW_MAINTENANCE_HISTORY','UPDATE_TICKET','REQUEST_MAINTENANCE')),
  outcome TEXT NOT NULL DEFAULT 'SUCCESS'
    CHECK (outcome IN ('SUCCESS','DENIED_RBAC','DENIED_ABAC','DENIED_SCOPE','ASSET_NOT_FOUND','ERROR')),
  deny_reason TEXT,
  ticket_id BIGINT REFERENCES service_tickets(id),
  device TEXT,
  ip TEXT,
  gps_lat NUMERIC(10,7),
  gps_lng NUMERIC(10,7),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_asset_service_scans_asset ON asset_service_scans(asset_id, created_at DESC);
CREATE INDEX idx_asset_service_scans_user ON asset_service_scans(scanned_by, created_at DESC);
CREATE INDEX idx_asset_service_scans_outcome ON asset_service_scans(company_id, outcome) WHERE outcome <> 'SUCCESS';
CREATE INDEX idx_asset_service_scans_ticket ON asset_service_scans(ticket_id) WHERE ticket_id IS NOT NULL;

-- ---------- 16. updated_at maintenance ----------
-- Any table carrying updated_at gets the house trigger, created only where it
-- is missing so the migration is safe to replay.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM information_schema.columns col
                  WHERE col.table_schema = 'public' AND col.table_name = c.relname
                    AND col.column_name = 'updated_at')
      AND NOT EXISTS (SELECT 1 FROM pg_trigger tg
                      WHERE tg.tgrelid = c.oid AND tg.tgname = 'trg_set_updated_at'
                        AND NOT tg.tgisinternal)
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;

-- ---------- 17. DB-level audit triggers ----------
-- Every service desk table is append-only audited: WHO / DID WHAT / TO WHICH
-- RECORD / WHEN / FROM WHERE / PREVIOUS VALUE / NEW VALUE.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'service_categories','service_subcategories','service_queues','service_teams',
    'service_team_members','service_skills','service_agent_skills','service_category_skills',
    'service_business_calendars','service_holidays','service_tickets','ticket_comments',
    'ticket_attachments','ticket_assignments','ticket_status_history','ticket_relations',
    'sla_policies','sla_tracking','sla_breaches','escalation_levels','escalation_rules',
    'ticket_escalations','service_requests','incidents','problems','problem_incidents',
    'known_errors','root_cause_analyses','change_requests','change_approvals',
    'knowledge_categories','knowledge_articles','knowledge_versions','knowledge_feedback',
    'ticket_knowledge_links','access_requests','access_approvals','asset_service_scans'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit' AND tgrelid = format('%I', t)::regclass
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
    END IF;
  END LOOP;
END $$;

-- ---------- 18. Lifecycle enforcement ----------
-- A ticket status may only move along a legal edge, and every move lands in
-- ticket_status_history with the actor, the reason and the timestamp.
CREATE OR REPLACE FUNCTION service_ticket_status_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT service_ticket_status_transition_ok(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'Illegal service ticket transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO ticket_status_history
      (tenant_id, company_id, branch_id, ticket_id, from_status, to_status, reason, changed_by)
    VALUES
      (NEW.tenant_id, NEW.company_id, NEW.branch_id, NEW.id, OLD.status, NEW.status,
       COALESCE(NEW.status_reason, 'Status changed'), app_user_id());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_service_ticket_status ON service_tickets;
CREATE TRIGGER trg_service_ticket_status
  BEFORE UPDATE ON service_tickets
  FOR EACH ROW EXECUTE FUNCTION service_ticket_status_guard();

-- ---------- 19. Row-level security: tenant isolation ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'service_categories','service_subcategories','service_queues','service_teams',
    'service_team_members','service_skills','service_agent_skills','service_category_skills',
    'service_business_calendars','service_holidays','service_tickets','ticket_comments',
    'ticket_attachments','ticket_assignments','ticket_status_history','ticket_relations',
    'sla_policies','sla_tracking','sla_breaches','escalation_levels','escalation_rules',
    'ticket_escalations','service_requests','incidents','problems','problem_incidents',
    'known_errors','root_cause_analyses','change_requests','change_approvals',
    'knowledge_categories','knowledge_articles','knowledge_versions','knowledge_feedback',
    'ticket_knowledge_links','access_requests','access_approvals','asset_service_scans'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I '
                   'USING (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

-- ---------- 20. Deferred foreign keys ----------
-- These tables reference each other in a cycle (categories -> queues -> teams,
-- tickets -> incidents/problems/changes), so the constraints are added now that
-- every relation exists.
ALTER TABLE service_categories
  ADD CONSTRAINT fk_service_categories_default_queue
  FOREIGN KEY (default_queue_id) REFERENCES service_queues(id) ON DELETE SET NULL;
ALTER TABLE service_subcategories
  ADD CONSTRAINT fk_service_subcategories_default_queue
  FOREIGN KEY (default_queue_id) REFERENCES service_queues(id) ON DELETE SET NULL;
ALTER TABLE service_queues
  ADD CONSTRAINT fk_service_queues_team
  FOREIGN KEY (team_id) REFERENCES service_teams(id) ON DELETE SET NULL;
ALTER TABLE service_tickets
  ADD CONSTRAINT fk_service_tickets_related_incident
  FOREIGN KEY (related_incident_id) REFERENCES incidents(id) ON DELETE SET NULL;
ALTER TABLE service_tickets
  ADD CONSTRAINT fk_service_tickets_related_problem
  FOREIGN KEY (related_problem_id) REFERENCES problems(id) ON DELETE SET NULL;
ALTER TABLE service_tickets
  ADD CONSTRAINT fk_service_tickets_related_change
  FOREIGN KEY (related_change_id) REFERENCES change_requests(id) ON DELETE SET NULL;
ALTER TABLE incidents
  ADD CONSTRAINT fk_incidents_problem
  FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE SET NULL;

-- ---------- 21. Baseline configuration ----------
-- Seeded per company so a newly provisioned legal entity starts with a usable
-- calendar, SLA ladder, escalation ladder, queue set and knowledge taxonomy.
-- Every insert is guarded, so the migration is replay-safe.

-- 21a. Calendar + Uganda public holidays.
DO $$
DECLARE
  c record;
  v_calendar bigint;
  v_year integer;
BEGIN
  FOR c IN SELECT id, tenant_id FROM companies LOOP
    INSERT INTO service_business_calendars
      (tenant_id, company_id, code, name, timezone, working_days, work_start, work_end, is_24x7, is_default)
    VALUES (c.tenant_id, c.id, 'DEFAULT', 'Default business calendar', 'Africa/Kampala',
            ARRAY[1,2,3,4,5], TIME '08:00', TIME '17:00', false, true)
    ON CONFLICT (company_id, code) DO NOTHING;

    SELECT id INTO v_calendar
    FROM service_business_calendars WHERE company_id = c.id AND code = 'DEFAULT';

    -- Fixed-date national holidays; the lunar (Eid) observances are declared
    -- annually by the administration screens.
    FOR v_year IN 2026..2027 LOOP
      INSERT INTO service_holidays (tenant_id, company_id, calendar_id, holiday_date, name)
      SELECT c.tenant_id, c.id, v_calendar, d, n
      FROM (VALUES
        (make_date(v_year, 1, 1),  'New Year''s Day'),
        (make_date(v_year, 1, 26), 'Liberation Day'),
        (make_date(v_year, 2, 16), 'Archbishop Janani Luwum Day'),
        (make_date(v_year, 3, 8),  'International Women''s Day'),
        (make_date(v_year, 5, 1),  'Labour Day'),
        (make_date(v_year, 6, 3),  'Martyrs'' Day'),
        (make_date(v_year, 6, 9),  'National Heroes'' Day'),
        (make_date(v_year, 10, 9), 'Independence Day'),
        (make_date(v_year, 12, 25),'Christmas Day'),
        (make_date(v_year, 12, 26),'Boxing Day')
      ) AS h(d, n)
      ON CONFLICT (calendar_id, holiday_date) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

-- 21b. Escalation ladder (spec 17).
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT id, tenant_id FROM companies LOOP
    INSERT INTO escalation_levels (tenant_id, company_id, level, code, name, role_code, description)
    SELECT c.tenant_id, c.id, l, cd, nm, rc, ds
    FROM (VALUES
      (1, 'L1_SERVICE_DESK_AGENT',  'Level 1 - Service Desk Agent',   'service_desk_agent',      'First line: triage, known fixes, service requests.'),
      (2, 'L2_SPECIALIST',          'Level 2 - Specialist',           'service_desk_technician', 'Second line: specialist technician / subject matter expert.'),
      (3, 'L3_SERVICE_DESK_MANAGER','Level 3 - Service Desk Manager', 'service_desk_manager',    'Owns SLA performance, workload and major incidents.'),
      (4, 'L4_OPERATIONS_MANAGER',  'Level 4 - Operations Manager',   'operations_director',     'Operations leadership: cross-department impact and outages.'),
      (5, 'L5_MANAGING_DIRECTOR',   'Level 5 - Managing Director',    'managing_director',       'Executive escalation: enterprise and reputational risk.')
    ) AS lv(l, cd, nm, rc, ds)
    ON CONFLICT (company_id, level) DO NOTHING;
  END LOOP;
END $$;

-- 21c. Default queues (spec 5 + 10).
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT id, tenant_id FROM companies LOOP
    INSERT INTO service_queues
      (tenant_id, company_id, code, name, description, assignment_strategy,
       target_response_minutes, target_resolution_minutes, is_default)
    SELECT c.tenant_id, c.id, cd, nm, ds, st, rm, fm, df
    FROM (VALUES
      ('IT_SERVICE_DESK','IT Service Desk','General IT support and service requests.','LOAD_BALANCED',60,480,true),
      ('NETWORK','Network Support','Internet, Wi-Fi, LAN, VPN and network equipment.','ROUND_ROBIN',60,480,false),
      ('ERP_SUPPORT','ERP Support','ERP login, permissions, errors, data and integrations.','SKILL_BASED',60,480,false),
      ('ATTENDANCE','Attendance Devices','Hikvision terminals, face recognition and missing attendance.','ROUND_ROBIN',60,480,false),
      ('PRODUCTION','Production Machines','Production machines and machine connectivity (FSS104, FSS300).','TEAM',30,240,false),
      ('MAINTENANCE','Maintenance','Electrical, mechanical, machine and facility maintenance.','TEAM',120,1440,false),
      ('FACILITIES','Facilities','Office equipment, workspace, furniture and utilities.','MANUAL',240,2880,false),
      ('SECURITY','Security Systems','CCTV, access control and security equipment.','MANUAL',30,240,false)
    ) AS q(cd, nm, ds, st, rm, fm, df)
    ON CONFLICT (company_id, code) DO NOTHING;
  END LOOP;
END $$;

-- 21d. SLA ladder (spec 7): P1 15m/4h, P2 1h/8h, P3 4h/2 business days,
-- P4 1 business day/5 business days.
DO $$
DECLARE
  c record;
  v_calendar bigint;
BEGIN
  FOR c IN SELECT id, tenant_id FROM companies LOOP
    SELECT id INTO v_calendar
    FROM service_business_calendars WHERE company_id = c.id AND code = 'DEFAULT';

    INSERT INTO sla_policies
      (tenant_id, company_id, code, name, description, priority, calendar_id,
       response_minutes, resolution_minutes, pause_on_pending, warning_minutes)
    SELECT c.tenant_id, c.id, cd, nm, ds, pr, v_calendar, rm, fm, true, wn
    FROM (VALUES
      ('SLA-P1','SLA - Critical (P1)','ERP unavailable, major network outage, security incident, production stopped.',  'P1',  15,  240,  5),
      ('SLA-P2','SLA - High (P2)','Major department affected, critical machine unavailable.',                          'P2',  60,  480, 15),
      ('SLA-P3','SLA - Medium (P3)','Individual employee unable to work normally.',                                  'P3', 240, 2880, 60),
      ('SLA-P4','SLA - Low (P4)','Routine request or minor issue.',                                                  'P4', 480, 7200,120)
    ) AS p(cd, nm, ds, pr, rm, fm, wn)
    ON CONFLICT (company_id, code) DO NOTHING;
  END LOOP;
END $$;

-- 21e. Escalation rules (spec 17): a P1 that nobody answers inside 15 minutes
-- goes straight to the Service Desk Manager (level 3), and an unanswered P1
-- resolution escalates to the Operations Manager (level 4). The ladder is
-- configurable per category and priority via escalation_rules.
DO $$
DECLARE
  c record;
  r record;
  v_level bigint;
BEGIN
  FOR c IN SELECT id, tenant_id FROM companies LOOP
    FOR r IN
      SELECT *
      FROM (VALUES
        ('ESC-P1-RESPONSE',   'P1 response overdue',   'P1', 'NO_RESPONSE',    15, 3, ARRAY['service_desk_manager','operations_director']),
        ('ESC-P1-RESOLUTION', 'P1 resolution overdue', 'P1', 'NO_RESOLUTION', 240, 4, ARRAY['operations_director','managing_director']),
        ('ESC-P2-RESPONSE',   'P2 response overdue',   'P2', 'NO_RESPONSE',    60, 2, ARRAY['service_desk_technician','service_desk_manager']),
        ('ESC-P2-RESOLUTION', 'P2 resolution overdue', 'P2', 'NO_RESOLUTION', 480, 3, ARRAY['service_desk_manager']),
        ('ESC-P3-RESPONSE',   'P3 response overdue',   'P3', 'NO_RESPONSE',   240, 2, ARRAY['service_desk_technician']),
        ('ESC-P3-BREACH',     'P3 SLA breached',       'P3', 'SLA_BREACH',      1, 3, ARRAY['service_desk_manager']),
        ('ESC-P4-BREACH',     'P4 SLA breached',       'P4', 'SLA_BREACH',      1, 3, ARRAY['service_desk_manager'])
      ) AS x(code, name, prio, trig, mins, lvl, roles)
    LOOP
      SELECT id INTO v_level
      FROM escalation_levels
      WHERE company_id = c.id AND level = r.lvl;
      CONTINUE WHEN v_level IS NULL;
      INSERT INTO escalation_rules
        (tenant_id, company_id, code, name, priority, level_id, after_minutes, trigger_on, notify_roles)
      VALUES (c.tenant_id, c.id, r.code, r.name, r.prio, v_level, r.mins, r.trig, r.roles)
      ON CONFLICT (company_id, code) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

-- 21f. Knowledge base taxonomy (spec 16).
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT id, tenant_id FROM companies LOOP
    INSERT INTO knowledge_categories (tenant_id, company_id, code, name, description, sort_order)
    SELECT c.tenant_id, c.id, cd, nm, ds, so
    FROM (VALUES
      ('ERP_HELP','ERP Help','Using the HOPE DESIGN ERP.',10),
      ('IT_SUPPORT','IT Support','Computers, laptops, printers, software, email and accounts.',20),
      ('NETWORK','Network','Internet, Wi-Fi, LAN, VPN and network equipment.',30),
      ('HR_SYSTEMS','HR Systems','HR, leave, payroll and self-service systems.',40),
      ('ATTENDANCE','Attendance','Hikvision terminals, face recognition and attendance records.',50),
      ('PRODUCTION','Production','Production machines, systems and connectivity.',60),
      ('SECURITY','Security','CCTV, access control and security equipment.',70),
      ('HOW_TO','How-To Guides','Step-by-step operational guides.',80)
    ) AS k(cd, nm, ds, so)
    ON CONFLICT (company_id, code) DO NOTHING;
  END LOOP;
END $$;

-- 22. Category / subcategory taxonomy (spec 5).
-- Admins can create unlimited categories and subcategories on top of this
-- baseline; every entry is company-scoped and routes to a default queue so a
-- new ticket lands in the right place even when no agent picks it up.
-- `accent` is a presentation hint only (it tints the workspace header) and is
-- never the sole carrier of severity.
DO $$
DECLARE
  c record;
  r record;
  v_cat bigint;
BEGIN
  FOR c IN SELECT id, tenant_id FROM companies LOOP
    FOR r IN
      SELECT *
      FROM (VALUES
        ('IT_SUPPORT','IT Support','Computers, laptops, printers, scanners, software, email and accounts.','it','IT_SERVICE_DESK','P3',10),
        ('NETWORK','Network','Internet, Wi-Fi, LAN, VPN and network equipment.','net','NETWORK','P3',20),
        ('ERP_SUPPORT','ERP Support','ERP login, permissions, system errors, data, reports and integrations.','erp','ERP_SUPPORT','P3',30),
        ('ATTENDANCE','Attendance','Hikvision terminals, face recognition and attendance records.','att','ATTENDANCE','P3',40),
        ('PRODUCTION','Production','Production machines, FSS104 / FSS300, systems and machine connectivity.','mfg','PRODUCTION','P2',50),
        ('MAINTENANCE','Maintenance','Electrical, mechanical, machine and facility maintenance.','mnt','MAINTENANCE','P3',60),
        ('FACILITIES','Facilities','Office equipment, workspace, furniture and utilities.','fac','FACILITIES','P4',70),
        ('SECURITY','Security','CCTV, access control and security equipment.','sec','SECURITY','P2',80)
      ) AS x(cd, nm, ds, ac, qc, pr, so)
    LOOP
      INSERT INTO service_categories
        (tenant_id, company_id, code, name, description, accent, default_queue_id,
         default_priority, sort_order)
      SELECT c.tenant_id, c.id, r.cd, r.nm, r.ds, r.ac,
             (SELECT q.id FROM service_queues q WHERE q.company_id = c.id AND q.code = r.qc),
             r.pr, r.so
      ON CONFLICT (company_id, code) DO NOTHING;
    END LOOP;

    FOR r IN
      SELECT *
      FROM (VALUES
        -- IT SUPPORT
        ('IT_SUPPORT','HARDWARE','Hardware','Physical hardware failures and faults.','P3',true,false,10),
        ('IT_SUPPORT','LAPTOP','Laptop','Laptop faults, setup, upgrades and replacement.','P3',true,false,20),
        ('IT_SUPPORT','DESKTOP','Desktop Computer','Desktop faults, setup, upgrades and replacement.','P3',true,false,30),
        ('IT_SUPPORT','PRINTER','Printer','Printer, toner, paper jam and print queue issues.','P3',true,false,40),
        ('IT_SUPPORT','SCANNER','Scanner','Scanner faults and scan-to-email / scan-to-folder setup.','P3',true,false,50),
        ('IT_SUPPORT','SOFTWARE','Software','Software installation, licensing and faults.','P3',false,false,60),
        ('IT_SUPPORT','EMAIL','Email','Mailbox, distribution list, spam and delivery issues.','P3',false,false,70),
        ('IT_SUPPORT','USER_ACCOUNT','User Account','Account creation, changes, lockouts and disablement.','P3',false,false,80),
        ('IT_SUPPORT','PASSWORD','Password','Password reset and credential problems.','P3',false,false,90),
        ('IT_SUPPORT','ERP_ACCESS','ERP Access','Request ERP access or change an ERP role.','P3',false,true,100),
        -- NETWORK
        ('NETWORK','INTERNET','Internet','Internet connectivity outages and slowness.','P3',false,false,10),
        ('NETWORK','WIFI','Wi-Fi','Wireless coverage, authentication and roaming issues.','P3',false,false,20),
        ('NETWORK','LAN','LAN','Wired LAN, switch port and cabling issues.','P3',false,false,30),
        ('NETWORK','VPN','VPN','Remote access and VPN tunnel issues.','P3',false,false,40),
        ('NETWORK','NETWORK_EQUIPMENT','Network Equipment','Routers, switches, access points and firewalls.','P3',true,false,50),
        -- ERP SUPPORT
        ('ERP_SUPPORT','LOGIN','Login Problem','Cannot sign in to the ERP.','P3',false,false,10),
        ('ERP_SUPPORT','PERMISSION','Permission Problem','Missing or incorrect ERP permissions.','P3',false,true,20),
        ('ERP_SUPPORT','SYSTEM_ERROR','System Error','ERP errors, exceptions and failed operations.','P2',false,false,30),
        ('ERP_SUPPORT','DATA_ISSUE','Data Issue','Incorrect, missing or duplicated ERP data.','P3',false,false,40),
        ('ERP_SUPPORT','REPORT_PROBLEM','Report Problem','Report totals, filters or exports are wrong.','P3',false,false,50),
        ('ERP_SUPPORT','INTEGRATION','Integration Issue','Integration failures between the ERP and other systems.','P2',false,false,60),
        -- ATTENDANCE
        ('ATTENDANCE','HIKVISION_TERMINAL','Hikvision Terminal','Hikvision terminal enrolment, sync and faults.','P3',true,false,10),
        ('ATTENDANCE','FACE_RECOGNITION','Face Recognition','Face template capture and recognition failures.','P3',true,false,20),
        ('ATTENDANCE','EMPLOYEE_IDENTIFICATION','Employee Identification','Employee not recognised or missing from the terminal.','P3',false,false,30),
        ('ATTENDANCE','MISSING_ATTENDANCE','Missing Attendance','Missing or incorrect attendance records.','P3',false,false,40),
        ('ATTENDANCE','DEVICE_FAILURE','Device Failure','Attendance device offline or damaged.','P2',true,false,50),
        -- PRODUCTION
        ('PRODUCTION','PRODUCTION_MACHINE','Production Machine','Production machine faults and stoppages.','P2',true,false,10),
        ('PRODUCTION','FSS104','FSS104','FSS104 machine incidents and stoppages.','P2',true,false,20),
        ('PRODUCTION','FSS300','FSS300','FSS300 machine incidents and stoppages.','P2',true,false,30),
        ('PRODUCTION','PRODUCTION_SYSTEM','Production System','Production software and system faults.','P2',false,false,40),
        ('PRODUCTION','MACHINE_CONNECTIVITY','Machine Connectivity','Machine network and controller connectivity.','P2',true,false,50),
        -- MAINTENANCE
        ('MAINTENANCE','ELECTRICAL','Electrical','Electrical faults, power and wiring.','P3',false,false,10),
        ('MAINTENANCE','MECHANICAL','Mechanical','Mechanical faults and breakdowns.','P3',false,false,20),
        ('MAINTENANCE','MACHINE_MAINTENANCE','Machine Maintenance','Scheduled and corrective machine maintenance.','P3',true,false,30),
        ('MAINTENANCE','FACILITY_MAINTENANCE','Facility Maintenance','Building, plumbing and general facility maintenance.','P4',false,false,40),
        -- FACILITIES
        ('FACILITIES','OFFICE_EQUIPMENT','Office Equipment','Office equipment faults and requests.','P4',true,false,10),
        ('FACILITIES','WORKSPACE','Workspace','Desks, seating and workspace changes.','P4',false,false,20),
        ('FACILITIES','FURNITURE','Furniture','Furniture requests, repairs and moves.','P4',false,false,30),
        ('FACILITIES','UTILITIES','Utilities','Water, power and other utility issues.','P4',false,false,40),
        -- SECURITY
        ('SECURITY','CCTV','CCTV','Camera, recorder and CCTV coverage issues.','P2',true,false,10),
        ('SECURITY','ACCESS_CONTROL','Access Control','Door access, turnstiles and access rights.','P2',true,true,20),
        ('SECURITY','SECURITY_EQUIPMENT','Security Equipment','Security equipment faults and requests.','P2',true,false,30)
      ) AS y(cat, cd, nm, ds, pr, ra, rap, so)
    LOOP
      SELECT id INTO v_cat
      FROM service_categories
      WHERE company_id = c.id AND code = r.cat;
      CONTINUE WHEN v_cat IS NULL;
      INSERT INTO service_subcategories
        (tenant_id, company_id, category_id, code, name, description,
         default_priority, requires_asset, requires_approval, sort_order)
      VALUES (c.tenant_id, c.id, v_cat, r.cd, r.nm, r.ds, r.pr, r.ra, r.rap, r.so)
      ON CONFLICT (category_id, code) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

-- 23. Audit record codes for service-desk documents (spec 29).
-- audit_row() already resolves the human-readable code for most modules, but
-- it has no knowledge of the service-desk document numbers, so tickets would
-- be recorded against their numeric id. Republish the function with the
-- service-desk keys added so every audit entry answers "TO WHICH RECORD" in
-- the same vocabulary the users see (HDG-SD-2026-000145, CHG-..., PRB-...).
-- These column names are unique to the service-desk tables, so other modules
-- keep resolving exactly as before.
CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger AS $$
DECLARE
  v_tenant bigint; v_company bigint; v_branch bigint;
  v_changes jsonb; v_code text;
  v_old jsonb; v_new jsonb; v_row jsonb; k text;
BEGIN
  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);
  -- Never persist secrets in audit payloads
  IF TG_TABLE_NAME IN ('users','sessions') THEN
    FOREACH k IN ARRAY ARRAY['password_hash','mfa_secret','token_hash'] LOOP
      v_old := v_old - k;
      v_new := v_new - k;
    END LOOP;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_tenant := NULLIF(v_old->>'tenant_id','')::bigint;
    v_company := NULLIF(v_old->>'company_id','')::bigint;
    v_branch := NULLIF(v_old->>'branch_id','')::bigint;
    v_changes := v_old;
    v_row := v_old;
  ELSE
    v_tenant := NULLIF(v_new->>'tenant_id','')::bigint;
    v_company := NULLIF(v_new->>'company_id','')::bigint;
    v_branch := NULLIF(v_new->>'branch_id','')::bigint;
    v_row := v_new;
    IF TG_OP = 'INSERT' THEN
      v_changes := v_new;
    ELSE
      v_changes := jsonb_diff(v_old, v_new);
    END IF;
  END IF;

  v_code := COALESCE(
    NULLIF(v_row->>'code',''), NULLIF(v_row->>'document_no',''),
    NULLIF(v_row->>'doc_no',''), NULLIF(v_row->>'entry_no',''),
    NULLIF(v_row->>'wo_no',''), NULLIF(v_row->>'order_no',''),
    NULLIF(v_row->>'po_no',''), NULLIF(v_row->>'job_no',''),
    NULLIF(v_row->>'invoice_no',''), NULLIF(v_row->>'grn_no',''),
    NULLIF(v_row->>'quote_no',''), NULLIF(v_row->>'quotation_no',''),
    NULLIF(v_row->>'transfer_no',''), NULLIF(v_row->>'adjustment_no',''),
    NULLIF(v_row->>'payment_no',''), NULLIF(v_row->>'receipt_no',''),
    NULLIF(v_row->>'ncr_no',''), NULLIF(v_row->>'capa_no',''),
    NULLIF(v_row->>'return_no',''), NULLIF(v_row->>'contract_no',''),
    NULLIF(v_row->>'pr_no',''), NULLIF(v_row->>'rfq_no',''),
    NULLIF(v_row->>'delivery_no',''), NULLIF(v_row->>'credit_no',''),
    NULLIF(v_row->>'complaint_no',''), NULLIF(v_row->>'lead_no',''),
    NULLIF(v_row->>'mwo_no',''), NULLIF(v_row->>'request_no',''),
    NULLIF(v_row->>'trip_no',''), NULLIF(v_row->>'payroll_no',''),
    NULLIF(v_row->>'employee_no',''), NULLIF(v_row->>'label_no',''),
    NULLIF(v_row->>'plan_no',''), NULLIF(v_row->>'inspection_no',''),
    -- Service desk (0150)
    NULLIF(v_row->>'ticket_number',''), NULLIF(v_row->>'incident_no',''),
    NULLIF(v_row->>'problem_number',''), NULLIF(v_row->>'change_number',''),
    NULLIF(v_row->>'article_number',''), NULLIF(v_row->>'request_number',''),
    NULLIF(v_row->>'email',''), NULLIF(v_row->>'username',''),
    (v_row->>'id')::text
  );

  INSERT INTO audit_logs (tenant_id, company_id, branch_id, user_id, correlation_id, action, resource, record_id, record_code, old_values, new_values, changes, ip, user_agent, device, metadata)
  VALUES (
    v_tenant, v_company, v_branch, app_user_id(), current_setting('app.correlation_id', true),
    lower(TG_OP), TG_TABLE_NAME, COALESCE(NEW.id, OLD.id), v_code,
    CASE WHEN TG_OP = 'UPDATE' THEN v_old ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN v_new ELSE NULL END,
    v_changes,
    current_setting('app.ip', true), current_setting('app.user_agent', true), current_setting('app.device', true),
    jsonb_build_object('table', TG_TABLE_NAME)
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
