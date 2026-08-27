-- ============================================================
-- 0069 Asset missing escalation (HOPE DESIGN GROUP LTD)
-- A MISSING asset may be escalated to LOST or STOLEN ONLY via a
-- controlled investigation workflow. Direct arbitrary status edits
-- remain blocked by asset_status_transition_ok; this migration
-- adds the single legal MISSING -> LOST/STOLEN transition.
-- ============================================================

CREATE OR REPLACE FUNCTION asset_status_transition_ok(p_from text, p_to text) RETURNS boolean AS $$
BEGIN
  IF p_from = p_to THEN RETURN true; END IF;
  -- Registration / approval path
  IF p_from = 'DRAFT' AND p_to = 'PENDING_APPROVAL' THEN RETURN true; END IF;
  IF p_from = 'PENDING_APPROVAL' AND p_to IN ('DRAFT','REGISTERED','IN_STORE','AVAILABLE','DISPOSED','RETIRED','ARCHIVED') THEN RETURN true; END IF;
  IF p_from = 'DRAFT' AND p_to IN ('REGISTERED','IN_STORE','AVAILABLE','DISPOSED','RETIRED','ARCHIVED') THEN RETURN true; END IF;
  -- Operational transitions
  IF p_from IN ('REGISTERED','IN_STORE','AVAILABLE') AND p_to IN ('ASSIGNED','IN_USE','UNDER_MAINTENANCE','UNDER_INSPECTION','RESERVED','QUARANTINED','TRANSFERRED','MISSING','DAMAGED','DISPOSED','RETIRED','ARCHIVED') THEN RETURN true; END IF;
  IF p_from IN ('ASSIGNED','IN_USE') AND p_to IN ('AVAILABLE','IN_STORE','UNDER_MAINTENANCE','UNDER_INSPECTION','TRANSFERRED','MISSING','DAMAGED','QUARANTINED','DISPOSED','RETIRED','ARCHIVED') THEN RETURN true; END IF;
  IF p_from IN ('UNDER_MAINTENANCE','UNDER_INSPECTION') AND p_to IN ('AVAILABLE','ASSIGNED','IN_USE','IN_STORE','DAMAGED','DISPOSED','RETIRED','ARCHIVED') THEN RETURN true; END IF;
  IF p_from = 'TRANSFERRED' AND p_to IN ('ASSIGNED','IN_USE','AVAILABLE','IN_STORE','UNDER_MAINTENANCE','MISSING','DAMAGED','DISPOSED','RETIRED','ARCHIVED') THEN RETURN true; END IF;
  -- Missing escalation: an asset may only be declared LOST or STOLEN
  -- while it is MISSING (0069). Everything else stays blocked.
  IF p_from = 'MISSING' AND p_to IN ('LOST','STOLEN') THEN RETURN true; END IF;
  IF p_from IN ('MISSING','LOST','STOLEN') AND p_to IN ('AVAILABLE','ASSIGNED','IN_USE','IN_STORE','DAMAGED','DISPOSED','RETIRED','ARCHIVED','QUARANTINED') THEN RETURN true; END IF;
  IF p_from IN ('DAMAGED','QUARANTINED') AND p_to IN ('UNDER_MAINTENANCE','UNDER_INSPECTION','AVAILABLE','ASSIGNED','IN_USE','DISPOSED','RETIRED','ARCHIVED','MISSING') THEN RETURN true; END IF;
  IF p_from = 'RESERVED' AND p_to IN ('ASSIGNED','IN_USE','AVAILABLE','IN_STORE','UNDER_MAINTENANCE','MISSING','DAMAGED','DISPOSED','RETIRED','ARCHIVED') THEN RETURN true; END IF;
  -- Terminal states via controlled workflows
  IF p_to IN ('DISPOSED','RETIRED','ARCHIVED') THEN RETURN true; END IF;
  RETURN false;
END;
$$ LANGUAGE plpgsql STABLE;