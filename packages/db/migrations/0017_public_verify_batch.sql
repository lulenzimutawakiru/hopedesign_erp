-- 0017: public QR verification also returns the product code and the production
-- batch number printed on the ream/carton label.

CREATE OR REPLACE FUNCTION verify_qr_public(
  p_payload text, p_ip text DEFAULT NULL, p_user_agent text DEFAULT NULL, p_device text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_code text; v_secret text; v_hash text; v_qr record;
  v_result text; v_product text; v_product_code text; v_batch_no text;
  v_is_first boolean := false;
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
  SELECT code INTO v_product_code FROM products WHERE id = v_qr.product_id;
  SELECT batch_no INTO v_batch_no FROM product_batches WHERE id = v_qr.batch_id;
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
    'product_code', v_product_code,
    'batch_no', v_batch_no,
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