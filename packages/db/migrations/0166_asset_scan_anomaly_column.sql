-- detect_asset_scan_anomalies selected asset_id from asset_register, which has
-- id. Two field verifications in a row (or any rapid scan) therefore 500'd
-- with "column asset_id does not exist".

CREATE OR REPLACE FUNCTION detect_asset_scan_anomalies(
  p_asset_id bigint, p_scan_id bigint, p_location_id bigint
) RETURNS void AS $$
DECLARE
  v_rec record;
  v_prev record;
  v_high boolean;
BEGIN
  SELECT is_high_value INTO v_high FROM asset_register WHERE id = p_asset_id;

  SELECT a.id, a.scanned_by, a.scanned_at, a.location_id INTO v_prev
  FROM asset_scans a
  WHERE a.asset_id = p_asset_id AND a.id <> p_scan_id
  ORDER BY a.scanned_at DESC LIMIT 1;

  IF v_prev.id IS NOT NULL AND v_prev.scanned_by IS NOT DISTINCT FROM
     (SELECT scanned_by FROM asset_scans WHERE id = p_scan_id)
     AND v_prev.scanned_at > now() - interval '5 seconds' THEN
    INSERT INTO asset_scan_anomalies (company_id, tenant_id, asset_id, scan_id, anomaly_type, severity, description)
    SELECT company_id, tenant_id, id, p_scan_id, 'RAPID_REPEATED_SCANS', 'MEDIUM',
           'Asset scanned repeatedly within 5 seconds'
    FROM asset_register WHERE id = p_asset_id;
  END IF;

  IF p_location_id IS NOT NULL AND v_prev.location_id IS NOT NULL
     AND p_location_id <> v_prev.location_id
     AND v_prev.scanned_at > now() - interval '15 minutes' THEN
    INSERT INTO asset_scan_anomalies (company_id, tenant_id, asset_id, scan_id, anomaly_type, severity, description)
    SELECT company_id, tenant_id, id, p_scan_id,
           CASE WHEN v_high THEN 'HIGH_VALUE_MOVED_UNUSUALLY' ELSE 'INCOMPATIBLE_LOCATION_SCANS' END,
           CASE WHEN v_high THEN 'HIGH' ELSE 'MEDIUM' END,
           'Asset scanned at incompatible locations within 15 minutes'
    FROM asset_register WHERE id = p_asset_id;
  END IF;

  FOR v_rec IN
    SELECT t.id AS tag_id, t.status FROM asset_tags t WHERE t.asset_id = p_asset_id AND t.status IN ('VOID','REPLACED')
  LOOP
    INSERT INTO asset_scan_anomalies (company_id, tenant_id, asset_id, scan_id, anomaly_type, severity, description, details)
    SELECT company_id, tenant_id, id, p_scan_id, 'VOIDED_TAG_SCANNED', 'HIGH',
           'A voided or replaced asset tag was scanned', jsonb_build_object('tag_id', v_rec.tag_id, 'tag_status', v_rec.status)
    FROM asset_register WHERE id = p_asset_id;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
