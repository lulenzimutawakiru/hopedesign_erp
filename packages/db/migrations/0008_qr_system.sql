-- ============================================================
-- 0008 QR traceability + anti-counterfeit system
-- ============================================================

CREATE TABLE qr_codes (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT UNIQUE NOT NULL,                 -- display/print code e.g. HDG-FG-2026-00000001
  secret_hash TEXT NOT NULL,                 -- sha256 of opaque secret encoded in QR payload
  entity_type TEXT NOT NULL
    CHECK (entity_type IN (
      'PRODUCT','BATCH','LOT','SERIAL','WORK_ORDER','SECURITY_JOB',
      'CARTON','PALLET','ASSET','MACHINE','BIN','DELIVERY','CUSTOMER','RAW_MATERIAL')),
  entity_id BIGINT,
  product_id BIGINT REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','SUSPENDED','DAMAGED','REPLACED','VOID','LOST','ARCHIVED')),
  status_reason TEXT,
  parent_qr_id BIGINT REFERENCES qr_codes(id),
  replaced_by_qr_id BIGINT REFERENCES qr_codes(id),
  first_scan_at TIMESTAMPTZ,
  last_scan_at TIMESTAMPTZ,
  scan_count INTEGER NOT NULL DEFAULT 0,
  generated_by BIGINT REFERENCES users(id),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_qr_entity ON qr_codes(entity_type, entity_id);
CREATE INDEX idx_qr_status ON qr_codes(status);
CREATE INDEX idx_qr_product ON qr_codes(product_id);

CREATE TABLE recalls (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  recall_no TEXT NOT NULL,
  product_id BIGINT REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  qr_id BIGINT REFERENCES qr_codes(id),
  reason TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'STANDARD' CHECK (severity IN ('STANDARD','MAJOR','CRITICAL')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CLOSED')),
  issued_by BIGINT REFERENCES users(id),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, recall_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE label_templates (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'PRODUCT'
    CHECK (kind IN ('PRODUCT','BATCH','CARTON','PALLET','ASSET','MACHINE','BIN','DELIVERY','WORK_ORDER')),
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (company_id, code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE qr_labels (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  qr_id BIGINT NOT NULL REFERENCES qr_codes(id),
  template_id BIGINT REFERENCES label_templates(id),
  label_no TEXT NOT NULL,
  copies INTEGER NOT NULL DEFAULT 1,
  printed_at TIMESTAMPTZ,
  printed_by BIGINT REFERENCES users(id),
  print_job_id BIGINT,
  status TEXT NOT NULL DEFAULT 'GENERATED'
    CHECK (status IN ('GENERATED','PRINTED','REPRINTED','DAMAGED','VOID')),
  UNIQUE (company_id, label_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE label_print_jobs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  job_no TEXT NOT NULL,
  template_id BIGINT REFERENCES label_templates(id),
  entity_type TEXT,
  entity_id BIGINT,
  count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','PRINTING','PRINTED','FAILED','CANCELLED')),
  requested_by BIGINT REFERENCES users(id),
  completed_at TIMESTAMPTZ,
  UNIQUE (company_id, job_no),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE qr_scans (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT,
  tenant_id BIGINT,
  qr_id BIGINT REFERENCES qr_codes(id),
  payload TEXT NOT NULL,
  scan_type TEXT NOT NULL DEFAULT 'INTERNAL' CHECK (scan_type IN ('INTERNAL','PUBLIC')),
  action TEXT NOT NULL DEFAULT 'VERIFY'
    CHECK (action IN (
      'VERIFY','RECEIVE','PUT_AWAY','MOVE','TRANSFER','PICK','ISSUE',
      'COUNT','ADJUST','INSPECT','DISPATCH','DELIVER','TRACK')),
  result TEXT NOT NULL
    CHECK (result IN ('AUTHENTIC','ALREADY_VERIFIED','SUSPICIOUS','VOID','RECALLED','UNKNOWN')),
  verified BOOLEAN NOT NULL DEFAULT false,
  ip TEXT,
  user_agent TEXT,
  device TEXT,
  location TEXT,
  scanned_by BIGINT REFERENCES users(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_qrscans_qr ON qr_scans(qr_id, created_at DESC);
CREATE INDEX idx_qrscans_created ON qr_scans(created_at DESC);

CREATE TABLE qr_events (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT,
  tenant_id BIGINT,
  qr_id BIGINT REFERENCES qr_codes(id),
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id BIGINT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  user_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_qrevents_qr ON qr_events(qr_id, created_at DESC);

CREATE TABLE qr_anomalies (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT,
  tenant_id BIGINT,
  qr_id BIGINT REFERENCES qr_codes(id),
  anomaly_type TEXT NOT NULL
    CHECK (anomaly_type IN (
      'SAME_QR_MULTIPLE_LOCATIONS','IMPOSSIBLE_MOVEMENT','EXCESSIVE_SCANS',
      'UNAUTHORIZED_SCAN','VOIDED_QR_SCAN','DUPLICATE_QR','SUSPICIOUS_PATTERN')),
  severity TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  description TEXT NOT NULL,
  detected_from_scan_id BIGINT REFERENCES qr_scans(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','INVESTIGATING','RESOLVED','FALSE_POSITIVE')),
  resolved_by BIGINT,
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_qranomalies_status ON qr_anomalies(status);

-- RLS
ALTER TABLE qr_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE recalls ENABLE ROW LEVEL SECURITY;
ALTER TABLE label_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE qr_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE label_print_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE qr_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE qr_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE qr_anomalies ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON qr_codes USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON recalls USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON label_templates USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON qr_labels USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON label_print_jobs USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON qr_scans USING (COALESCE(tenant_id, 0) = COALESCE(app_tenant_id(), 0));
CREATE POLICY tenant_isolation ON qr_events USING (COALESCE(tenant_id, 0) = COALESCE(app_tenant_id(), 0));
CREATE POLICY tenant_isolation ON qr_anomalies USING (COALESCE(tenant_id, 0) = COALESCE(app_tenant_id(), 0));

-- Public scans: qr_scans rows created by anonymous users get no tenant;
-- internal API reads tenant-scoped rows only (RLS above). Public endpoint
-- reads only through a dedicated server-side function that never returns
-- confidential data.
