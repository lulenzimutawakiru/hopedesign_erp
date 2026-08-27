-- ============================================================
-- 0016 Ream & carton authenticity (anti-counterfeit reams)
-- Every ream carries a unique QR. Five scanned reams produce one
-- carton QR. Reams/cartons are publicly verifiable via the portal.
-- ============================================================

-- Allow REAM entity type on qr_codes.
ALTER TABLE qr_codes DROP CONSTRAINT qr_codes_entity_type_check;
ALTER TABLE qr_codes ADD CONSTRAINT qr_codes_entity_type_check CHECK (entity_type IN (
  'PRODUCT','BATCH','LOT','SERIAL','WORK_ORDER','SECURITY_JOB','REAM',
  'CARTON','PALLET','ASSET','MACHINE','BIN','DELIVERY','CUSTOMER','RAW_MATERIAL'));

-- Allow PACK / SEAL scan actions (packing reams into cartons).
ALTER TABLE qr_scans DROP CONSTRAINT qr_scans_action_check;
ALTER TABLE qr_scans ADD CONSTRAINT qr_scans_action_check CHECK (action IN (
  'VERIFY','RECEIVE','PUT_AWAY','MOVE','TRANSFER','PICK','ISSUE',
  'COUNT','ADJUST','INSPECT','DISPATCH','DELIVER','TRACK','PACK','SEAL'));

CREATE TABLE cartons (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  carton_no TEXT NOT NULL,
  qr_id BIGINT UNIQUE REFERENCES qr_codes(id),
  ream_count INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','SEALED','DISPATCHED','VOID','LOST')),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, carton_no)
);
CREATE INDEX idx_cartons_tenant ON cartons(tenant_id, created_at DESC);
CREATE INDEX idx_cartons_status ON cartons(status);

CREATE TABLE reams (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  batch_id BIGINT REFERENCES product_batches(id),
  ream_no TEXT NOT NULL,
  qr_id BIGINT UNIQUE REFERENCES qr_codes(id),
  carton_id BIGINT REFERENCES cartons(id),
  sheets INTEGER NOT NULL DEFAULT 500,
  gsm NUMERIC(10,2),
  size TEXT,
  status TEXT NOT NULL DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE','PACKED','ISSUED','DISPATCHED','VOID','LOST')),
  packed_at TIMESTAMPTZ,
  packed_by BIGINT REFERENCES users(id),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, ream_no)
);
CREATE INDEX idx_reams_tenant ON reams(tenant_id, created_at DESC);
CREATE INDEX idx_reams_status ON reams(status);
CREATE INDEX idx_reams_carton ON reams(carton_id);

CREATE TABLE carton_reams (
  id BIGSERIAL PRIMARY KEY,
  carton_id BIGINT NOT NULL REFERENCES cartons(id) ON DELETE CASCADE,
  ream_id BIGINT NOT NULL REFERENCES reams(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 100),
  UNIQUE (carton_id, ream_id),
  UNIQUE (carton_id, seq)
);
CREATE INDEX idx_carton_reams_ream ON carton_reams(ream_id);

-- Labels can point at a rendered label image (Niimbot PNG spool).
ALTER TABLE qr_labels ADD COLUMN label_image_path TEXT;

-- RLS
ALTER TABLE reams ENABLE ROW LEVEL SECURITY;
ALTER TABLE cartons ENABLE ROW LEVEL SECURITY;
ALTER TABLE carton_reams ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reams USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON cartons USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON carton_reams USING (
  carton_id IN (SELECT id FROM cartons) AND ream_id IN (SELECT id FROM reams));

CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON reams FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON cartons FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Authenticity views (internal use; public portal reads through verify_qr_public).
CREATE OR REPLACE VIEW v_ream_authenticity AS
SELECT r.id, r.company_id, r.tenant_id, r.product_id, p.code AS product_code, p.name AS product_name,
       p.gsm AS product_gsm, p.sheets_per_ream, r.batch_id, pb.batch_no,
       r.ream_no, r.sheets, r.gsm, r.size, r.status, r.packed_at, r.created_at,
       qr.code AS qr_code, qr.status AS qr_status, qr.scan_count, qr.first_scan_at, qr.last_scan_at,
       c.carton_no
FROM reams r
JOIN products p ON p.id = r.product_id
LEFT JOIN product_batches pb ON pb.id = r.batch_id
LEFT JOIN qr_codes qr ON qr.id = r.qr_id
LEFT JOIN cartons c ON c.id = r.carton_id;

CREATE OR REPLACE VIEW v_carton_authenticity AS
SELECT c.id, c.company_id, c.tenant_id, c.product_id, p.code AS product_code, p.name AS product_name,
       c.batch_id, pb.batch_no, c.carton_no, c.ream_count, c.status, c.created_at,
       qr.code AS qr_code, qr.status AS qr_status, qr.scan_count, qr.first_scan_at, qr.last_scan_at,
       (SELECT count(*) FROM carton_reams cr JOIN reams r ON r.id = cr.ream_id
         WHERE cr.carton_id = c.id) AS reams_linked
FROM cartons c
JOIN products p ON p.id = c.product_id
LEFT JOIN product_batches pb ON pb.id = c.batch_id
LEFT JOIN qr_codes qr ON qr.id = c.qr_id;

-- Public verification extended with safe ream/carton details.
CREATE OR REPLACE FUNCTION verify_qr_public(
  p_payload text, p_ip text DEFAULT NULL, p_user_agent text DEFAULT NULL, p_device text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_code text; v_secret text; v_hash text; v_qr record;
  v_result text; v_product text; v_is_first boolean := false;
  v_company bigint; v_tenant bigint;
  v_ream jsonb; v_carton jsonb;
BEGIN
  v_code := split_part(p_payload, '|', 1);
  v_secret := split_part(p_payload, '|', 2);
  IF v_code = '' OR v_secret = '' OR length(v_code) > 80 THEN
    INSERT INTO qr_scans (payload, scan_type, action, result, verified, ip, user_agent, device)
    VALUES (left(p_payload, 255), 'PUBLIC', 'VERIFY', 'UNKNOWN', false, p_ip, p_user_agent, p_device);
    RETURN jsonb_build_object('result', 'UNKNOWN', 'verified', false, 'message', 'QR code not recognized');
  END IF;
  v_hash := encode(digest(v_secret, 'sha256'), 'hex');
  SELECT * INTO v_qr FROM qr_codes WHERE code = v_code AND secret_hash = v_hash;
  IF v_qr.id IS NULL THEN
    INSERT INTO qr_scans (payload, scan_type, action, result, verified, ip, user_agent, device)
    VALUES (left(p_payload, 255), 'PUBLIC', 'VERIFY', 'UNKNOWN', false, p_ip, p_user_agent, p_device);
    RETURN jsonb_build_object('result', 'UNKNOWN', 'verified', false, 'message', 'QR code not recognized');
  END IF;

  IF v_qr.status = 'VOID' OR v_qr.status = 'DAMAGED' OR v_qr.status = 'LOST' OR v_qr.status = 'REPLACED' THEN
    v_result := 'VOID';
  ELSIF EXISTS (SELECT 1 FROM recalls WHERE qr_id = v_qr.id AND status = 'ACTIVE') THEN
    v_result := 'RECALLED';
  ELSIF v_qr.first_scan_at IS NOT NULL THEN
    v_result := 'ALREADY_VERIFIED';
  ELSE
    v_result := 'AUTHENTIC';
  END IF;

  IF v_result = 'AUTHENTIC' THEN
    UPDATE qr_codes SET first_scan_at = now(), last_scan_at = now(), scan_count = scan_count + 1 WHERE id = v_qr.id;
    v_is_first := true;
  ELSE
    UPDATE qr_codes SET last_scan_at = now(), scan_count = scan_count + 1 WHERE id = v_qr.id;
  END IF;

  SELECT name INTO v_product FROM products WHERE id = v_qr.product_id;
  v_company := v_qr.company_id; v_tenant := v_qr.tenant_id;
  INSERT INTO qr_scans (company_id, tenant_id, qr_id, payload, scan_type, action, result, verified, ip, user_agent, device, metadata)
  VALUES (v_company, v_tenant, v_qr.id, left(p_payload,255), 'PUBLIC', 'VERIFY', v_result,
          v_result IN ('AUTHENTIC','ALREADY_VERIFIED'), p_ip, p_user_agent, p_device,
          jsonb_build_object('first_verification', v_is_first));

  IF v_qr.entity_type = 'REAM' THEN
    SELECT jsonb_build_object(
      'ream_no', r.ream_no, 'sheets', r.sheets, 'gsm', r.gsm, 'size', r.size,
      'status', r.status, 'packed_at', r.packed_at, 'carton_no', c.carton_no
    ) INTO v_ream
    FROM reams r LEFT JOIN cartons c ON c.id = r.carton_id
    WHERE r.qr_id = v_qr.id;
  ELSIF v_qr.entity_type = 'CARTON' THEN
    SELECT jsonb_build_object(
      'carton_no', c.carton_no, 'ream_count', c.ream_count, 'status', c.status,
      'members', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'ream_no', r.ream_no, 'code', q2.code,
          'verified', q2.first_scan_at IS NOT NULL,
          'status', r.status
        ) ORDER BY cr.seq)
        FROM carton_reams cr
        JOIN reams r ON r.id = cr.ream_id
        JOIN qr_codes q2 ON q2.id = r.qr_id
        WHERE cr.carton_id = c.id
      ), '[]'::jsonb)
    ) INTO v_carton
    FROM cartons c WHERE c.qr_id = v_qr.id;
  END IF;

  RETURN jsonb_build_object(
    'result', v_result,
    'verified', v_result IN ('AUTHENTIC','ALREADY_VERIFIED'),
    'product', COALESCE(v_product, 'Unknown product'),
    'code', v_qr.code,
    'entity_type', v_qr.entity_type,
    'verified_at', now()
  ) || CASE
    WHEN v_ream IS NOT NULL THEN jsonb_build_object('ream', v_ream)
    WHEN v_carton IS NOT NULL THEN jsonb_build_object('carton', v_carton)
    ELSE '{}'::jsonb
  END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
