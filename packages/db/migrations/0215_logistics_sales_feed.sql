-- ============================================================================
-- 0215 - Logistics fed from sales, plus starter fleet/route master data
--
-- Dispatching in the sales module already produces a delivery note carrying the
-- vehicle and driver. This file turns that into a real Trip the logistics module
-- can work with directly, instead of a bare row the dispatcher would have to
-- re-key by hand. It does two things:
--
--   1. Adds `customer_id` and `destination` to `trips` so a trip is
--      self-describing (who the goods are going to, and where), rather than a
--      collection of foreign keys you have to chase through three tables.
--   2. Seeds a minimal fleet (two trucks, two drivers, two routes) so the
--      vehicles/drivers/routes screens and the dispatch pickers aren't empty on
--      a fresh tenant.
--
-- The trip rows themselves are created by the application on dispatch
-- (services/logistics.ts), not here — this file only prepares the schema and
-- the master data. Idempotent: every insert is guarded; re-running is a no-op.
-- ============================================================================

-- 1. Trips carry the sales context they are derived from.
ALTER TABLE trips ADD COLUMN customer_id BIGINT REFERENCES customers(id);
ALTER TABLE trips ADD COLUMN destination TEXT;

-- 2. Starter fleet / drivers / routes for the Hope Design company.
DO $$
DECLARE
  v_tenant  BIGINT;
  v_company BIGINT;
BEGIN
  SELECT c.tenant_id, c.id INTO v_tenant, v_company
  FROM companies c
  WHERE c.code = 'HDG'
  ORDER BY c.id
  LIMIT 1;

  IF v_company IS NULL THEN
    RAISE NOTICE '0215: Hope Design company not found; seed skipped.';
    RETURN;
  END IF;

  INSERT INTO vehicles (company_id, tenant_id, code, plate_no, make, model, vehicle_type, capacity_kg, fuel_type, status)
  SELECT v_company, v_tenant, v.code, v.plate_no, v.make, v.model, 'TRUCK', v.capacity_kg, 'DIESEL', 'OPERATIONAL'
  FROM (VALUES
    ('TRK-001', 'UBA 123K', 'Isuzu',       'NPR 75',       4000),
    ('TRK-002', 'UBL 456L', 'Mitsubishi',  'Fuso Canter',  3500)
  ) AS v(code, plate_no, make, model, capacity_kg)
  WHERE NOT EXISTS (SELECT 1 FROM vehicles WHERE company_id = v_company AND code = v.code);

  INSERT INTO drivers (company_id, tenant_id, name, licence_no, phone, status)
  SELECT v_company, v_tenant, d.name, d.licence_no, d.phone, 'ACTIVE'
  FROM (VALUES
    ('Mukasa Robert', 'DL-001234', '+256 700 000 001'),
    ('Nakato Sarah',  'DL-005678', '+256 700 000 002')
  ) AS d(name, licence_no, phone)
  WHERE NOT EXISTS (SELECT 1 FROM drivers WHERE company_id = v_company AND name = d.name);

  INSERT INTO routes (company_id, tenant_id, code, name, origin, destination, distance_km, estimated_hours)
  SELECT v_company, v_tenant, r.code, r.name, 'Plot 59 Kyambogo Drive, Kyambogo', r.destination, r.distance_km, r.estimated_hours
  FROM (VALUES
    ('RT-KLA-CBD',   'Kyambogo → Kampala CBD', 'Kampala CBD', 12.5, 1.0),
    ('RT-KLA-JINJA', 'Kyambogo → Jinja',       'Jinja',       80.0, 2.5)
  ) AS r(code, name, destination, distance_km, estimated_hours)
  WHERE NOT EXISTS (SELECT 1 FROM routes WHERE company_id = v_company AND code = r.code);
END;
$$;
