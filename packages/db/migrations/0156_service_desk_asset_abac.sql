-- ============================================================================
-- 0156_service_desk_asset_abac.sql
--
-- HOPE DESIGN Service Desk & ITSM - ABAC gate for secure assets (spec 13, 23).
--
-- WHY
-- ---
-- 0152/0154 gate Service Desk records on data classification, and the asset
-- scan service (apps/api/src/services/serviceDeskAssets.ts) publishes
-- `secure_asset_denied` whenever the scanned asset is flagged `is_secure` and
-- the caller holds no `security_clearance`. Until now no policy consumed that
-- fact, so a scan of a security-printing machine was authorized on RBAC alone.
--
-- This migration closes that gap with a deny that fires before every
-- Service Desk allow policy.
--
-- PRIORITY LAYOUT (first-match-wins, ascending)
--   130  ABAC-SD-CLASSIFIED        deny
--   140  ABAC-SD-INTERNAL-NOTES    deny
--   150  ABAC-NO-SELF-APPROVE      deny
--   155  ABAC-SD-ASSET-SECURE      deny   <- new
--   160  ABAC-SD-READONLY          deny
--   165  ABAC-SD-OUT-OF-SCOPE      deny
--   200  ABAC-SEC-CLEARANCE        deny
--   995  ABAC-SD-EMPLOYEE-OWN      allow
--   996  ABAC-SD-AGENT-SCOPE       allow
--   999  ABAC-DEFAULT-ALLOW        allow
--
-- SCOPE OF THE CONTROL
-- --------------------
-- The resource condition is keyed on `secure_asset_denied`, an attribute that
-- only the QR scan routes publish (via assetResourceAttributes). Ordinary
-- ticket endpoints never set it, so this policy cannot leak into, or interfere
-- with, the rest of the Service Desk. The subject condition is deliberately
-- applied as well: a cleared user is never blocked even if the API were to
-- mislabel the attribute, so the control is fail-closed on the subject side and
-- cannot be defeated by a caller-controlled resource fact.
--
-- NOTE ON MAINTENANCE WORK ORDERS
-- -------------------------------
-- `service_desk_technician` and `service_desk_manager` intentionally do NOT
-- hold `assets.maintenance.create`. A technician scanning a machine raises the
-- service ticket and the maintenance REQUEST; the Asset Management roles
-- (asset_manager, asset_officer) own the work order. requestAssetMaintenance()
-- therefore audits the deferral and notifies those holders instead of
-- self-granting Asset Register authority. That is segregation of duties, not a
-- missing grant - do not "fix" it here.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ABAC-SD-ASSET-SECURE - scanning a secure asset without clearance.
-- ---------------------------------------------------------------------------
INSERT INTO policies (tenant_id, code, name, description, effect, priority,
                      subject_attributes, resource_attributes, environment_attributes, is_active)
SELECT t.id,
       'ABAC-SD-ASSET-SECURE',
       'Service Desk secure asset scanning requires clearance',
       'A subject without a security_clearance attribute may not scan, read or raise tickets against an asset flagged is_secure.',
       'deny',
       155,
       '{"security_clearance":{"$missing":true}}'::jsonb,
       '{"module":"service_desk","secure_asset_denied":true}'::jsonb,
       '{}'::jsonb,
       true
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM policies p WHERE p.tenant_id = t.id AND p.code = 'ABAC-SD-ASSET-SECURE'
);

-- ---------------------------------------------------------------------------
-- 2. Idempotent repair of the priority on re-run.
-- ---------------------------------------------------------------------------
UPDATE policies
   SET priority = 155,
       is_active = true,
       updated_at = now()
 WHERE code = 'ABAC-SD-ASSET-SECURE'
   AND (priority <> 155 OR is_active IS DISTINCT FROM true);

-- ---------------------------------------------------------------------------
-- 3. Guard: an unconditional deny is skipped by the authorizer, which would
--    silently disable the control. Fail the migration loudly instead.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_effect text;
  v_priority integer;
  v_resource jsonb;
  v_subject jsonb;
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM policies WHERE code = 'ABAC-SD-ASSET-SECURE';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'ABAC-SD-ASSET-SECURE was not created';
  END IF;

  SELECT effect, priority, resource_attributes, subject_attributes
    INTO v_effect, v_priority, v_resource, v_subject
    FROM policies WHERE code = 'ABAC-SD-ASSET-SECURE' LIMIT 1;

  IF v_effect <> 'deny' THEN
    RAISE EXCEPTION 'ABAC-SD-ASSET-SECURE must deny (found %)', v_effect;
  END IF;
  IF v_priority >= 995 THEN
    RAISE EXCEPTION 'ABAC-SD-ASSET-SECURE priority % is not ahead of the allow policies', v_priority;
  END IF;
  IF v_resource IS NULL OR v_resource = '{}'::jsonb THEN
    RAISE EXCEPTION 'ABAC-SD-ASSET-SECURE has no resource condition and would be ignored';
  END IF;
  IF v_resource->>'secure_asset_denied' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'ABAC-SD-ASSET-SECURE lost its secure_asset_denied condition: %', v_resource;
  END IF;
  IF v_resource->>'module' IS DISTINCT FROM 'service_desk' THEN
    RAISE EXCEPTION 'ABAC-SD-ASSET-SECURE must stay scoped to the service_desk module: %', v_resource;
  END IF;
  IF v_subject IS NULL OR v_subject = '{}'::jsonb THEN
    RAISE EXCEPTION 'ABAC-SD-ASSET-SECURE has no subject condition';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Verification helper: the effective Service Desk policy ladder, in the
--    order the authorization engine evaluates it. Useful for operators and for
--    the integration tests.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_service_desk_abac_ladder AS
SELECT p.tenant_id,
       p.priority,
       p.code,
       p.effect,
       p.is_active,
       p.subject_attributes,
       p.resource_attributes,
       p.environment_attributes
  FROM policies p
 WHERE p.code LIKE 'ABAC-SD-%'
    OR p.code IN ('ABAC-NO-SELF-APPROVE', 'ABAC-DEFAULT-ALLOW', 'ABAC-FIN-HOURS', 'ABAC-SEC-CLEARANCE')
 ORDER BY p.tenant_id, p.priority, p.id;

COMMENT ON VIEW v_service_desk_abac_ladder IS
  'Service Desk ABAC ladder in evaluation order (priority ascending, first match wins).';
