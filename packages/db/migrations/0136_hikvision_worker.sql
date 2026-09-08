-- ============================================================================
-- 0136 - Hikvision background worker helpers
-- Cross-tenant SECURITY DEFINER sweeps for the queue worker. Additive only;
-- 0135 remains authoritative for the schema.
-- ============================================================================

-- Device health sweep: flip ONLINE/WARNING terminals that have stopped sending
-- heartbeats/events to OFFLINE and record the transition (append-only).
CREATE OR REPLACE FUNCTION public.hikvision_device_health_sweep(p_stale_seconds INTEGER DEFAULT NULL)
RETURNS TABLE (device_id BIGINT, previous_status TEXT, new_status TEXT, changed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_dev RECORD;
  v_cfg RECORD;
  v_stale INTEGER;
  v_prev TEXT;
BEGIN
  FOR v_dev IN
    SELECT d.id, d.tenant_id, d.company_id, d.connection_status, d.last_heartbeat_at
      FROM hikvision_devices d
     WHERE d.enabled = true
       AND d.connection_status IN ('ONLINE','WARNING')
       AND d.last_heartbeat_at IS NOT NULL
     ORDER BY d.id
  LOOP
    SELECT * INTO v_cfg FROM hikvision_device_configurations c
      WHERE c.device_id = v_dev.id LIMIT 1;
    v_stale := COALESCE(p_stale_seconds, COALESCE(v_cfg.heartbeat_stale_seconds, 300));
    IF v_dev.last_heartbeat_at < now() - make_interval(secs => v_stale) THEN
      v_prev := v_dev.connection_status;
      UPDATE hikvision_devices
         SET connection_status = 'OFFLINE',
             status_reason = 'No heartbeat or event within configured window',
             updated_at = now()
       WHERE id = v_dev.id;
      INSERT INTO hikvision_device_health_logs
        (tenant_id, company_id, device_id, health_type, previous_status, new_status,
         message, severity, metadata)
      VALUES
        (v_dev.tenant_id, v_dev.company_id, v_dev.id, 'STATUS_CHANGE', v_prev, 'OFFLINE',
         'No heartbeat or event within configured window', 'WARN',
         jsonb_build_object('stale_seconds', v_stale));
      device_id := v_dev.id;
      previous_status := v_prev;
      new_status := 'OFFLINE';
      changed := true;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.hikvision_device_health_sweep(INTEGER) TO hopedesign_app;