-- ============================================================
-- 0089 Employee QR scan constraint alignment
-- verify_employee_public previously wrote detailed results
-- (VERIFIED/INACTIVE/EXPIRED/SUSPENDED) into qr_scans.result,
-- which violates the shared CHECK constraint. Map to the
-- allowed result vocabulary (AUTHENTIC/SUSPICIOUS/UNKNOWN) and
-- keep the detailed employee result in metadata.employee_result.
-- ============================================================

CREATE OR REPLACE FUNCTION verify_employee_public(
  p_token text, p_ip text DEFAULT NULL, p_user_agent text DEFAULT NULL, p_device text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_ident record;
  v_emp record;
  v_result text;
  v_qr_id bigint;
  v_token text;
BEGIN
  v_token := left(trim(COALESCE(p_token, '')), 128);

  SELECT i.* INTO v_ident
  FROM employee_identities i
  WHERE i.identity_type = 'QR_IDENTITY' AND i.identity_number = v_token;

  IF v_ident.id IS NULL THEN
    INSERT INTO qr_scans (payload, scan_type, action, result, verified, ip, user_agent, device)
    VALUES (left(COALESCE(p_token, ''), 255), 'PUBLIC', 'VERIFY', 'UNKNOWN', false, p_ip, p_user_agent, p_device);
    RETURN jsonb_build_object('result', 'UNKNOWN', 'verified', false, 'message', 'Employee identity not recognized');
  END IF;

  SELECT e.id, e.first_name, e.last_name, e.status, e.position, e.department_id,
         d.name AS department_name
    INTO v_emp
    FROM employees e
    LEFT JOIN departments d ON d.id = e.department_id
   WHERE e.id = v_ident.employee_id;

  IF v_emp.id IS NULL THEN
    RETURN jsonb_build_object('result', 'UNKNOWN', 'verified', false, 'message', 'Employee record not found');
  END IF;

  IF v_ident.status <> 'ACTIVE' THEN
    v_result := 'INACTIVE';
  ELSIF v_ident.expires_at IS NOT NULL AND v_ident.expires_at < now() THEN
    v_result := 'EXPIRED';
  ELSIF v_emp.status = 'TERMINATED' THEN
    v_result := 'INACTIVE';
  ELSIF v_emp.status = 'SUSPENDED' THEN
    v_result := 'SUSPENDED';
  ELSE
    v_result := 'VERIFIED';
  END IF;

  v_qr_id := COALESCE((v_ident.metadata->>'qr_id')::bigint, (v_ident.metadata->>'qrId')::bigint);

  INSERT INTO qr_scans (company_id, tenant_id, qr_id, payload, scan_type, action, result, verified, ip, user_agent, device, metadata)
  VALUES (v_ident.company_id, v_ident.tenant_id, v_qr_id,
          left(COALESCE(p_token, ''), 255), 'PUBLIC', 'VERIFY',
          CASE WHEN v_result = 'VERIFIED' THEN 'AUTHENTIC' ELSE 'SUSPICIOUS' END,
          v_result = 'VERIFIED', p_ip, p_user_agent, p_device,
          jsonb_build_object('identity_type', 'EMPLOYEE', 'employee_result', v_result));

  RETURN jsonb_build_object(
    'result', v_result,
    'verified', v_result = 'VERIFIED',
    'employeeId', v_emp.id,
    'name', NULLIF(trim(concat(v_emp.first_name, ' ', v_emp.last_name)), ''),
    'department', COALESCE(v_emp.department_name, ''),
    'position', COALESCE(v_emp.position, ''),
    'status', v_emp.status,
    'verifiedAt', now()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
