-- ============================================================
-- 0009 Logistics + fleet
-- ============================================================

CREATE TABLE vehicles (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  plate_no TEXT NOT NULL,
  make TEXT,
  model TEXT,
  vehicle_type TEXT NOT NULL DEFAULT 'TRUCK' CHECK (vehicle_type IN ('TRUCK','VAN','PICKUP','MOTORCYCLE','OTHER')),
  capacity_kg NUMERIC(12,2),
  fuel_type TEXT NOT NULL DEFAULT 'DIESEL',
  status TEXT NOT NULL DEFAULT 'OPERATIONAL'
    CHECK (status IN ('OPERATIONAL','MAINTENANCE','OUT_OF_SERVICE','RETIRED')),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE routes (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  origin TEXT,
  destination TEXT,
  distance_km NUMERIC(10,2),
  estimated_hours NUMERIC(6,2),
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE drivers (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  employee_id BIGINT,
  name TEXT NOT NULL,
  licence_no TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE trips (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  trip_no TEXT NOT NULL,
  vehicle_id BIGINT NOT NULL REFERENCES vehicles(id),
  driver_id BIGINT REFERENCES drivers(id),
  route_id BIGINT REFERENCES routes(id),
  delivery_note_id BIGINT REFERENCES delivery_notes(id),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  start_odometer NUMERIC(12,2),
  end_odometer NUMERIC(12,2),
  status TEXT NOT NULL DEFAULT 'PLANNED'
    CHECK (status IN ('PLANNED','IN_TRANSIT','ARRIVED','COMPLETED','CANCELLED')),
  UNIQUE (company_id, trip_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fuel_logs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  vehicle_id BIGINT NOT NULL REFERENCES vehicles(id),
  fuel_date DATE NOT NULL DEFAULT CURRENT_DATE,
  litres NUMERIC(10,2) NOT NULL,
  cost NUMERIC(18,2) NOT NULL,
  odometer NUMERIC(12,2),
  supplier TEXT,
  notes TEXT,
  recorded_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fleet_maintenance (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  vehicle_id BIGINT NOT NULL REFERENCES vehicles(id),
  maintenance_type TEXT NOT NULL DEFAULT 'SERVICE'
    CHECK (maintenance_type IN ('SERVICE','REPAIR','TYRE','BRAKES','ENGINE','OTHER')),
  maintenance_date DATE NOT NULL DEFAULT CURRENT_DATE,
  cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  description TEXT,
  vendor TEXT,
  odometer NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- QR-based delivery tracking events
CREATE TABLE delivery_events (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  delivery_note_id BIGINT NOT NULL REFERENCES delivery_notes(id),
  status TEXT NOT NULL,
  location TEXT,
  notes TEXT,
  qr_id BIGINT REFERENCES qr_codes(id),
  recorded_by BIGINT REFERENCES users(id),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_delivery_events ON delivery_events(delivery_note_id, occurred_at);

ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE fuel_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet_maintenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON vehicles USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON routes USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON drivers USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON trips USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON fuel_logs USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON fleet_maintenance USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON delivery_events USING (tenant_id = app_tenant_id());
