-- ============================================================================
-- 0154_service_desk_abac_refine.sql
--
-- Refine the Service Desk classification gate (ABAC-SD-CLASSIFIED).
--
-- 0152 keyed the deny directly on resource.data_classification, which is
-- fail-closed for every reader of a CONFIDENTIAL/RESTRICTED ticket - including
-- the very employee who raised it. That directly contradicts the Service Desk
-- directive: an employee must always be able to track their own request
-- (spec section 23, "Can view: OWN TICKETS").
--
-- The gate now keys on a fact the API publishes after it has resolved the
-- ticket: `classified_denied`. The API sets it to true only when
--     data_classification IN ('CONFIDENTIAL','RESTRICTED')
--     AND the caller is NOT the requester
--     AND the caller holds no security clearance.
-- The requester therefore keeps their own ticket, while everyone else still
-- needs clearance - i.e. the control is unchanged for non-requesters.
--
-- The subject-side condition (no security_clearance attribute) is preserved, so
-- a cleared user is never blocked by this policy.
-- ============================================================================

UPDATE policies
   SET resource_attributes = jsonb_build_object(
         'module', 'service_desk',
         'classified_denied', true,
         'action', jsonb_build_object('$in', jsonb_build_array(
           'view', 'view_own', 'update', 'reply', 'resolve', 'close', 'close_own',
           'reopen', 'escalate', 'assign', 'export', 'print', 'investigate',
           'approve', 'reject', 'grant', 'revoke', 'download'))
       ),
       updated_at = now()
 WHERE code = 'ABAC-SD-CLASSIFIED';

-- Guard: the refinement must not leave the gate without a resource condition
-- (an unconditional deny would be skipped by the engine, silently disabling the
-- control). Fail the migration loudly instead.
DO $$
DECLARE v_attrs jsonb;
BEGIN
  SELECT resource_attributes INTO v_attrs FROM policies WHERE code = 'ABAC-SD-CLASSIFIED';
  IF v_attrs IS NULL THEN
    RAISE EXCEPTION 'ABAC-SD-CLASSIFIED is missing';
  END IF;
  IF v_attrs->>'classified_denied' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'ABAC-SD-CLASSIFIED lost its classified_denied condition: %', v_attrs;
  END IF;
  IF v_attrs->'action' IS NULL THEN
    RAISE EXCEPTION 'ABAC-SD-CLASSIFIED lost its action condition: %', v_attrs;
  END IF;
END $$;
