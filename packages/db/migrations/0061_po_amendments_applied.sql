-- PO amendments: widen the status state machine to include APPLIED so an
-- approved amendment is applied exactly once (idempotent, auditable).
ALTER TABLE po_amendments DROP CONSTRAINT po_amendments_status_check;
ALTER TABLE po_amendments ADD CONSTRAINT po_amendments_status_check
  CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','CANCELLED','APPLIED'));