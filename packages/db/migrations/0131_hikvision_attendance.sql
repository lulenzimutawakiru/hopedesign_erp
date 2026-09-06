-- Hikvision biometric attendance integration.  Raw events are immutable: they
-- are accepted first and processed asynchronously by the API worker.
CREATE TABLE hikvision_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  name TEXT NOT NULL,
  model TEXT,
  serial_number TEXT NOT NULL,
  ip_address INET,
  mac_address TEXT,
  physical_location TEXT,
  purpose TEXT NOT NULL DEFAULT 'ATTENDANCE' CHECK (purpose IN ('ENTRY','EXIT','ATTENDANCE','BREAK_ENTRY','BREAK_EXIT','PRODUCTION','WAREHOUSE','SECURE_AREA')),
  timezone TEXT NOT NULL DEFAULT 'UTC', firmware_version TEXT,
  status TEXT NOT NULL DEFAULT 'ONLINE' CHECK (status IN ('ONLINE','OFFLINE','WARNING','MAINTENANCE','DISABLED')),
  webhook_secret_hash TEXT NOT NULL,
  last_heartbeat_at TIMESTAMPTZ, last_event_at TIMESTAMPTZ,
  duplicate_window_seconds INTEGER NOT NULL DEFAULT 60 CHECK (duplicate_window_seconds BETWEEN 1 AND 3600),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, serial_number)
);

CREATE TABLE hikvision_raw_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id), company_id BIGINT NOT NULL REFERENCES companies(id),
  device_id UUID REFERENCES hikvision_devices(id), device_serial_number TEXT NOT NULL,
  payload JSONB NOT NULL, payload_format TEXT NOT NULL CHECK (payload_format IN ('JSON','XML')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(), device_event_time TIMESTAMPTZ, event_type TEXT,
  payload_hash TEXT NOT NULL, processing_status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (processing_status IN ('RECEIVED','QUEUED','PROCESSING','PROCESSED','DUPLICATE','FAILED','REJECTED')),
  retry_count INTEGER NOT NULL DEFAULT 0, error_message TEXT, processed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (device_id, payload_hash)
);
CREATE INDEX idx_hikvision_raw_queue ON hikvision_raw_events (processing_status, received_at);
CREATE INDEX idx_hikvision_raw_tenant ON hikvision_raw_events (tenant_id, received_at DESC);

CREATE TABLE hikvision_normalized_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), raw_event_id UUID NOT NULL UNIQUE REFERENCES hikvision_raw_events(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id), company_id BIGINT NOT NULL REFERENCES companies(id), device_id UUID NOT NULL REFERENCES hikvision_devices(id),
  employee_identifier TEXT, employee_id BIGINT REFERENCES employees(id), event_time TIMESTAMPTZ NOT NULL, received_time TIMESTAMPTZ NOT NULL,
  verification_method TEXT NOT NULL CHECK (verification_method IN ('FACE','CARD','FINGERPRINT','PASSWORD','QR','UNKNOWN')),
  event_type TEXT NOT NULL, location TEXT, classification TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE attendance_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id BIGINT NOT NULL REFERENCES tenants(id), company_id BIGINT NOT NULL REFERENCES companies(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id), normalized_event_id UUID NOT NULL UNIQUE REFERENCES hikvision_normalized_events(id),
  event_time TIMESTAMPTZ NOT NULL, classification TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE attendance_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id BIGINT NOT NULL REFERENCES tenants(id), company_id BIGINT NOT NULL REFERENCES companies(id),
  raw_event_id UUID NOT NULL REFERENCES hikvision_raw_events(id), type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','REJECTED')),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb, resolved_by BIGINT REFERENCES users(id), resolved_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The webhook has no user JWT.  This narrowly scoped, security-definer gate
-- is the only unauthenticated write path and validates the device secret
-- before discovering tenant scope or preserving the event.
CREATE OR REPLACE FUNCTION hikvision_ingest_event(p_serial TEXT, p_secret TEXT, p_payload JSONB, p_format TEXT, p_event_time TIMESTAMPTZ, p_event_type TEXT, p_hash TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d hikvision_devices%ROWTYPE; event_id UUID;
BEGIN
  SELECT * INTO d FROM hikvision_devices WHERE serial_number = p_serial;
  IF NOT FOUND OR d.status IN ('DISABLED','MAINTENANCE') OR d.webhook_secret_hash <> encode(digest(p_secret, 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'invalid device credentials' USING ERRCODE = '28000';
  END IF;
  INSERT INTO hikvision_raw_events (tenant_id, company_id, device_id, device_serial_number, payload, payload_format, device_event_time, event_type, payload_hash, processing_status)
  VALUES (d.tenant_id, d.company_id, d.id, d.serial_number, p_payload, p_format, p_event_time, p_event_type, p_hash, 'QUEUED')
  ON CONFLICT (device_id, payload_hash) DO UPDATE SET processing_status = 'DUPLICATE'
  RETURNING id INTO event_id;
  UPDATE hikvision_devices SET last_event_at = now(), last_heartbeat_at = now(), status = 'ONLINE', updated_at = now() WHERE id = d.id;
  RETURN event_id;
END $$;
REVOKE ALL ON FUNCTION hikvision_ingest_event(TEXT,TEXT,JSONB,TEXT,TIMESTAMPTZ,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hikvision_ingest_event(TEXT,TEXT,JSONB,TEXT,TIMESTAMPTZ,TEXT,TEXT) TO hopedesign_app;

CREATE OR REPLACE FUNCTION hikvision_process_events(p_limit INTEGER DEFAULT 50)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r hikvision_raw_events%ROWTYPE; d hikvision_devices%ROWTYPE; e employees%ROWTYPE;
  employee_no TEXT; verify_method TEXT; class TEXT; normalized_id UUID; count_processed INTEGER := 0;
BEGIN
  FOR r IN SELECT * FROM hikvision_raw_events WHERE processing_status = 'QUEUED' ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT LEAST(GREATEST(p_limit,1),200) LOOP
    UPDATE hikvision_raw_events SET processing_status='PROCESSING' WHERE id=r.id;
    BEGIN
      SELECT * INTO d FROM hikvision_devices WHERE id=r.device_id;
      employee_no := COALESCE(r.payload->>'employeeNoString', r.payload->>'employeeNo');
      SELECT * INTO e FROM employees WHERE tenant_id=r.tenant_id AND company_id=r.company_id AND employee_no=employee_no AND status IN ('ACTIVE','ON_LEAVE') LIMIT 1;
      IF NOT FOUND THEN
        INSERT INTO attendance_exceptions (tenant_id,company_id,raw_event_id,type,detail) VALUES (r.tenant_id,r.company_id,r.id,'UNKNOWN_EMPLOYEE_EVENT',jsonb_build_object('employeeIdentifier',employee_no));
        UPDATE hikvision_raw_events SET processing_status='PROCESSED',processed_at=now() WHERE id=r.id; count_processed := count_processed+1; CONTINUE;
      END IF;
      verify_method := CASE COALESCE(r.payload->>'verifyNo','') WHEN '1' THEN 'FACE' WHEN '2' THEN 'FINGERPRINT' WHEN '3' THEN 'CARD' WHEN '4' THEN 'PASSWORD' WHEN '5' THEN 'QR' ELSE 'UNKNOWN' END;
      class := CASE d.purpose WHEN 'ENTRY' THEN 'CHECK_IN' WHEN 'EXIT' THEN 'CHECK_OUT' WHEN 'BREAK_ENTRY' THEN 'BREAK_END' WHEN 'BREAK_EXIT' THEN 'BREAK_START' ELSE 'UNKNOWN' END;
      IF EXISTS (SELECT 1 FROM hikvision_normalized_events n WHERE n.employee_id=e.id AND n.device_id=d.id AND n.classification=class AND abs(extract(epoch FROM (n.event_time-r.device_event_time))) <= d.duplicate_window_seconds) THEN
        UPDATE hikvision_raw_events SET processing_status='DUPLICATE',processed_at=now() WHERE id=r.id;
        INSERT INTO attendance_exceptions (tenant_id,company_id,raw_event_id,type,detail) VALUES (r.tenant_id,r.company_id,r.id,'DUPLICATE_PUNCH','{}'); count_processed := count_processed+1; CONTINUE;
      END IF;
      INSERT INTO hikvision_normalized_events (raw_event_id,tenant_id,company_id,device_id,employee_identifier,employee_id,event_time,received_time,verification_method,event_type,location,classification)
      VALUES (r.id,r.tenant_id,r.company_id,d.id,employee_no,e.id,r.device_event_time,r.received_at,verify_method,r.event_type,d.physical_location,class) RETURNING id INTO normalized_id;
      INSERT INTO attendance_events (tenant_id,company_id,employee_id,normalized_event_id,event_time,classification) VALUES (r.tenant_id,r.company_id,e.id,normalized_id,r.device_event_time,class);
      IF class IN ('CHECK_IN','CHECK_OUT') THEN
        INSERT INTO attendance (employee_id,work_date,clock_in,clock_out,status) VALUES (e.id,(r.device_event_time AT TIME ZONE d.timezone)::date,CASE WHEN class='CHECK_IN' THEN r.device_event_time END,CASE WHEN class='CHECK_OUT' THEN r.device_event_time END,'PRESENT')
        ON CONFLICT (employee_id,work_date) DO UPDATE SET clock_in=CASE WHEN EXCLUDED.clock_in IS NOT NULL THEN LEAST(attendance.clock_in,EXCLUDED.clock_in) ELSE attendance.clock_in END, clock_out=CASE WHEN EXCLUDED.clock_out IS NOT NULL THEN GREATEST(attendance.clock_out,EXCLUDED.clock_out) ELSE attendance.clock_out END;
      END IF;
      UPDATE hikvision_raw_events SET processing_status='PROCESSED',processed_at=now() WHERE id=r.id; count_processed := count_processed+1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE hikvision_raw_events SET processing_status='FAILED',retry_count=retry_count+1,error_message=left(SQLERRM,500) WHERE id=r.id;
    END;
  END LOOP;
  RETURN count_processed;
END $$;
REVOKE ALL ON FUNCTION hikvision_process_events(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hikvision_process_events(INTEGER) TO hopedesign_app;

ALTER TABLE hikvision_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE hikvision_raw_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hikvision_normalized_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_exceptions ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['hikvision_devices','hikvision_raw_events','hikvision_normalized_events','attendance_events','attendance_exceptions'] LOOP
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

INSERT INTO permissions (code, resource, action, description) VALUES
 ('hikvision.devices.view','hikvision.devices','view','View Hikvision devices'), ('hikvision.devices.create','hikvision.devices','create','Register Hikvision devices'),
 ('hikvision.devices.update','hikvision.devices','update','Update Hikvision devices'), ('hikvision.devices.delete','hikvision.devices','delete','Disable Hikvision devices'),
 ('hikvision.events.view','hikvision.events','view','View Hikvision events'), ('hikvision.events.retry','hikvision.events','retry','Retry Hikvision events'),
 ('hikvision.events.reject','hikvision.events','reject','Reject Hikvision events') ON CONFLICT (code) DO NOTHING;
