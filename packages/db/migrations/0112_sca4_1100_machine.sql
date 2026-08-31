-- ============================================================================
-- SCA4-1100 A4 Production Line machine registration
-- Adds the SCA4-1100 machine (NATEX A4 primary production line) with its QR
-- identity and today's capacity entry, and wires it into the NATEX A4 routing
-- as the primary slitting / cutting operation. Idempotent.
-- ============================================================================

DO $$
DECLARE
  v_company  BIGINT;
  v_tenant   BIGINT;
  v_admin    BIGINT;
  v_facility BIGINT;
  v_wc_cut   BIGINT;
  v_qr       BIGINT;
  v_machine  BIGINT;
  v_routing  BIGINT;
BEGIN
  -- Resolve the primary HOPE DESIGN company (convention: tenant 2 / company 2).
  SELECT id, tenant_id INTO v_company, v_tenant
  FROM companies WHERE tenant_id = 2 AND id = 2 LIMIT 1;
  IF v_company IS NULL THEN
    SELECT id, tenant_id INTO v_company, v_tenant FROM companies ORDER BY id LIMIT 1;
  END IF;
  IF v_company IS NULL THEN RETURN; END IF;

  SELECT id INTO v_admin FROM users
  WHERE company_id = v_company AND email = 'admin@hopedesign.co.ug'
  ORDER BY id LIMIT 1;

  SELECT id INTO v_facility FROM production_facilities
  WHERE company_id = v_company ORDER BY id LIMIT 1;

  SELECT id INTO v_wc_cut FROM work_centres
  WHERE company_id = v_company AND code = 'MC-CUT' LIMIT 1;

  -- 1) QR identity for the machine (opaque secret; only the hash is stored)
  INSERT INTO qr_codes (company_id, tenant_id, code, secret_hash, entity_type, entity_id, status, generated_by)
  SELECT v_company, v_tenant, 'HDG-MC-SCA4-1100', encode(sha256(gen_random_bytes(24)), 'hex'),
         'MACHINE', NULL, 'ACTIVE', v_admin
  WHERE NOT EXISTS (SELECT 1 FROM qr_codes WHERE code = 'HDG-MC-SCA4-1100')
  RETURNING id INTO v_qr;

  IF v_qr IS NULL THEN
    SELECT id INTO v_qr FROM qr_codes WHERE code = 'HDG-MC-SCA4-1100';
  END IF;

  -- 2) Machine register entry
  INSERT INTO machines (company_id, tenant_id, facility_id, work_centre_id, code, name, make, model,
                        serial_no, type, capacity, capacity_unit, hourly_rate, status, is_secure, qr_id,
                        machine_state, production_hours, downtime_hours, maintenance_status, attributes)
  SELECT v_company, v_tenant, v_facility, v_wc_cut, 'SCA4-1100', 'SCA4-1100 A4 Production Line',
         'SCA4', 'SCA4-1100', 'SCA4-0001', 'SHEET_CUTTER', 1200, 'REAMS/HR', 35000,
         'OPERATIONAL', false, v_qr,
         'RUNNING', 7.474, 0.4, 'NONE',
         '{"line":"SCA4-1100","primary":true,"only_manufactured_fg":"NATEX-A4"}'::jsonb
  WHERE NOT EXISTS (SELECT 1 FROM machines WHERE company_id = v_company AND code = 'SCA4-1100')
  RETURNING id INTO v_machine;

  IF v_machine IS NULL THEN
    SELECT id INTO v_machine FROM machines WHERE company_id = v_company AND code = 'SCA4-1100';
    -- Keep an existing row aligned with the current configuration
    UPDATE machines
    SET work_centre_id = v_wc_cut, machine_state = 'RUNNING', production_hours = 7.474,
        downtime_hours = 0.4, maintenance_status = 'NONE',
        attributes = attributes || '{"line":"SCA4-1100","primary":true,"only_manufactured_fg":"NATEX-A4"}'::jsonb,
        updated_at = now()
    WHERE id = v_machine;
  END IF;

  -- Link the QR to the machine
  UPDATE qr_codes SET entity_id = v_machine, updated_at = now() WHERE id = v_qr;

  -- 3) Today's capacity entry (shift A)
  INSERT INTO machine_capacity (company_id, tenant_id, machine_id, work_centre_id, capacity_date, shift_code,
                                available_hours, scheduled_hours, actual_hours, downtime_hours,
                                maintenance_hours, changeover_hours, break_hours, remaining_hours,
                                utilization_pct, efficiency_pct, oee_pct)
  SELECT v_company, v_tenant, v_machine, v_wc_cut, CURRENT_DATE, 'A',
         8, 8, 7.474, 0.4, 0, 0, 0, 0,
         ROUND((7.474 / 8) * 100, 2), ROUND((7.474 / 8) * 100, 2), NULL
  WHERE NOT EXISTS (
    SELECT 1 FROM machine_capacity
    WHERE company_id = v_company AND machine_id = v_machine
      AND capacity_date = CURRENT_DATE AND COALESCE(shift_code, '') = 'A'
  );

  -- 4) Wire SCA4-1100 into the NATEX A4 routing as the slitting / cutting step
  SELECT id INTO v_routing FROM routings
  WHERE company_id = v_company AND code = 'ROUT-A4-80' LIMIT 1;

  IF v_routing IS NOT NULL THEN
    UPDATE routing_operations
    SET name = 'Slitting / Cutting', machine_id = v_machine
    WHERE routing_id = v_routing AND seq = 10;

    UPDATE work_instructions
    SET title = 'A4 Slitting / Cutting - SCA4-1100', updated_at = now()
    WHERE company_id = v_company AND code = 'WI-A4-CUT-001' AND version = 1;
  END IF;
END $$;