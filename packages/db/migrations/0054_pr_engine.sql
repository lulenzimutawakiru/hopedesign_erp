-- ============================================================
-- 0054 Purchase Requisition engine
-- Full lifecycle status machine, collaboration timeline,
-- document register, officer assignments and an immutable
-- status-history trail.  Backward compatible with the existing
-- DRAFT / SUBMITTED / APPROVED / REJECTED / CONVERTED flow.

-- 1) Status machine: widen the CHECK to the full PR lifecycle.
--    CONVERTED is kept as an alias of FULLY_CONVERTED so existing
--    rows and integrations keep working.
ALTER TABLE purchase_requisitions DROP CONSTRAINT purchase_requisitions_status_check;
ALTER TABLE purchase_requisitions ADD CONSTRAINT purchase_requisitions_status_check
  CHECK (status = ANY (ARRAY[
    'DRAFT','SUBMITTED','PENDING_APPROVAL','PENDING_BUDGET','PENDING_PROCUREMENT','PENDING_FINANCE',
    'APPROVED','REJECTED','RETURNED','ON_HOLD','RFQ_CREATED',
    'PARTIALLY_ORDERED','PARTIALLY_CONVERTED','FULLY_CONVERTED','CONVERTED',
    'PARTIALLY_FULFILLED','FULFILLED','CANCELLED','CLOSED'
  ]));

-- 2) Procurement officer on the header (display) + hold metadata.
--    The full assignment history lives in pr_assignments.
ALTER TABLE purchase_requisitions
  ADD COLUMN procurement_officer_id bigint REFERENCES users(id),
  ADD COLUMN held_reason text,
  ADD COLUMN hold_until timestamptz;

CREATE INDEX idx_pr_procurement_officer ON purchase_requisitions (procurement_officer_id);

-- 3) Status history: immutable state-machine trail.
CREATE TABLE pr_status_history (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requisition_id  bigint NOT NULL REFERENCES purchase_requisitions(id) ON DELETE CASCADE,
  from_status     text,
  to_status       text NOT NULL,
  changed_by      bigint REFERENCES users(id),
  comment         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pr_status_history_requisition ON pr_status_history (requisition_id, id);

-- 4) Collaboration timeline (comments / internal notes / @mentions).
CREATE TABLE pr_comments (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requisition_id  bigint NOT NULL REFERENCES purchase_requisitions(id) ON DELETE CASCADE,
  user_id         bigint NOT NULL REFERENCES users(id),
  body            text NOT NULL,
  is_internal     boolean NOT NULL DEFAULT false,
  mentions        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pr_comments_requisition ON pr_comments (requisition_id, id);

-- 5) Document register (metadata; bytes live in object storage).
CREATE TABLE pr_attachments (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requisition_id  bigint NOT NULL REFERENCES purchase_requisitions(id) ON DELETE CASCADE,
  file_name       text NOT NULL,
  file_path       text,
  mime_type       text,
  size_bytes      bigint NOT NULL DEFAULT 0,
  classification  text NOT NULL DEFAULT 'INTERNAL',
  uploaded_by     bigint REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pr_attachments_requisition ON pr_attachments (requisition_id, id);

-- 6) Procurement officer assignment trail.
CREATE TABLE pr_assignments (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requisition_id  bigint NOT NULL REFERENCES purchase_requisitions(id) ON DELETE CASCADE,
  officer_user_id bigint NOT NULL REFERENCES users(id),
  assigned_by     bigint REFERENCES users(id),
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  notes           text
);
CREATE INDEX idx_pr_assignments_requisition ON pr_assignments (requisition_id, id);

-- 7) Row-level security: tenant isolation through the parent requisition
--    (same subquery pattern already used by purchase_requisition_items).
ALTER TABLE pr_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON pr_status_history
  USING (requisition_id IN (SELECT id FROM purchase_requisitions));
CREATE POLICY tenant_isolation ON pr_comments
  USING (requisition_id IN (SELECT id FROM purchase_requisitions));
CREATE POLICY tenant_isolation ON pr_attachments
  USING (requisition_id IN (SELECT id FROM purchase_requisitions));
CREATE POLICY tenant_isolation ON pr_assignments
  USING (requisition_id IN (SELECT id FROM purchase_requisitions));

-- 8) Backfill one history row per existing requisition reflecting its
--    current state so the audit trail starts populated.
INSERT INTO pr_status_history (requisition_id, from_status, to_status, changed_by, comment, created_at)
SELECT id, NULL, status, COALESCE(converted_by, approved_by, requested_by),
       'Snapshot of existing requisition on PR engine rollout',
       COALESCE(converted_at, approved_at, updated_at, created_at)
FROM purchase_requisitions;
