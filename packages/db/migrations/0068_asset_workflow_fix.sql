-- ============================================================
-- 0068 Asset workflow fixes (HOPE DESIGN GROUP LTD)
-- 1. Registration workflow: allow DRAFT -> PENDING_APPROVAL (submit)
--    and PENDING_APPROVAL -> DRAFT (rejection returns to draft).
-- 2. Normalise seeded asset workflow configs: amount_max of 0 means
--    "uncapped"; write an explicit large cap so the workflow engine
--    always finds a covering approval step for any asset value.
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
  IF p_from IN ('MISSING','LOST','STOLEN') AND p_to IN ('AVAILABLE','ASSIGNED','IN_USE','IN_STORE','DAMAGED','DISPOSED','RETIRED','ARCHIVED','QUARANTINED') THEN RETURN true; END IF;
  IF p_from IN ('DAMAGED','QUARANTINED') AND p_to IN ('UNDER_MAINTENANCE','UNDER_INSPECTION','AVAILABLE','ASSIGNED','IN_USE','DISPOSED','RETIRED','ARCHIVED','MISSING') THEN RETURN true; END IF;
  IF p_from = 'RESERVED' AND p_to IN ('ASSIGNED','IN_USE','AVAILABLE','IN_STORE','UNDER_MAINTENANCE','MISSING','DAMAGED','DISPOSED','RETIRED','ARCHIVED') THEN RETURN true; END IF;
  -- Terminal states via controlled workflows
  IF p_to IN ('DISPOSED','RETIRED','ARCHIVED') THEN RETURN true; END IF;
  RETURN false;
END;
$$ LANGUAGE plpgsql STABLE;

-- Normalise seeded asset workflow configs. A step amount_max of 0 is
-- treated as "uncapped" by the workflow service; make that explicit so
-- any asset value is covered by an approval step.
UPDATE workflows
SET config = (
  SELECT jsonb_agg(
    CASE WHEN (step->>'amount_max')::numeric = 0
         THEN step || jsonb_build_object('amount_max', 1000000000)
         ELSE step END
    ORDER BY (step->>'seq')::int
  )
  FROM jsonb_array_elements(config) AS step
)
WHERE code IN ('WF-ASSET-TRANSFER','WF-ASSET-DISPOSAL')
  AND entity_type IN ('assets.transfers','assets.disposals')
  AND jsonb_typeof(config) = 'array';
