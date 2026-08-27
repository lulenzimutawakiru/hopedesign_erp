-- ============================================================
-- 0088 Employee ID Generator & Identity Management
-- Permanent, unique, QR-enabled employee identity for Hope Design Group.
-- Official ID: HDG-EMP-YYYY-NNNNNN (company-scoped, permanent)
-- Short badge: HDGYYNNNN (tenant-scoped)
-- ============================================================

-- ---------- 1. Extend employees with permanent identity fields ----------
ALTER TABLE employees ADD COLUMN IF NOT EXISTS employee_number TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS short_employee_number TEXT;

-- Official ID is permanent and company-scoped; short badge is tenant-scoped.
-- Postgres allows multiple NULLs in unique indexes, so pre-backfill rows are safe.
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_employee_number ON employees (company_id, employee_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_short_employee_number ON employees (tenant_id, short_employee_number);

-- ---------- 2. Employee ID sequences (locked during generation) ----------
CREATE TABLE IF NOT EXISTS employee_id_sequences (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  seq_type TEXT NOT NULL CHECK (seq_type IN ('OFFICIAL','SHORT')),
  doc_year INTEGER NOT NULL,
  prefix TEXT NOT NULL DEFAULT 'HDG-EMP',
  current_sequence BIGINT NOT NULL DEFAULT 0,
  pad INTEGER NOT NULL DEFAULT 6,
  format TEXT NOT NULL DEFAULT '{PREFIX}-{YEAR}-{SEQUENCE}',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, seq_type, doc_year)
);

-- ---------- 3. Employee identities ----------
CREATE TABLE IF NOT EXISTS employee_identities (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  identity_type TEXT NOT NULL CHECK (identity_type IN (
    'OFFICIAL_EMPLOYEE_ID','SHORT_BADGE_ID','QR_IDENTITY','RFID_IDENTITY','BIOMETRIC_REFERENCE'
  )),
  identity_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED','EXPIRED')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  issued_by BIGINT REFERENCES users(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, identity_type, identity_number)
);
-- One active identity per employee per type (replacement revokes the old one first)
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_identities_active
  ON employee_identities (tenant_id, employee_id, identity_type)
  WHERE status <> 'REVOKED';
CREATE INDEX IF NOT EXISTS idx_employee_identities_emp ON employee_identities (employee_id);

-- ---------- 4. Employee ID cards ----------
CREATE TABLE IF NOT EXISTS employee_id_cards (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  card_no TEXT NOT NULL,
  qr_id BIGINT REFERENCES qr_codes(id),
  identity_id BIGINT REFERENCES employee_identities(id),
  issue_date DATE,
  expiry_date DATE,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT','ACTIVE','LOST','DAMAGED','REPLACED','SUSPENDED','EXPIRED','VOID'
  )),
  status_reason TEXT,
  printed_at TIMESTAMPTZ,
  printed_by BIGINT REFERENCES users(id),
  issued_at TIMESTAMPTZ,
  issued_by BIGINT REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by BIGINT REFERENCES users(id),
  replaced_by_card_id BIGINT REFERENCES employee_id_cards(id),
  serial_number TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, card_no)
);
CREATE INDEX IF NOT EXISTS idx_employee_id_cards_emp ON employee_id_cards (employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_id_cards_status ON employee_id_cards (status);

-- ---------- 5. Employee assignments (transfer history) ----------
CREATE TABLE IF NOT EXISTS employee_assignments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  company_id BIGINT NOT NULL REFERENCES companies(id),
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  branch_id BIGINT REFERENCES branches(id),
  department_id BIGINT REFERENCES departments(id),
  position_id BIGINT REFERENCES positions(id),
  position TEXT,
  assignment_type TEXT NOT NULL DEFAULT 'TRANSFER' CHECK (assignment_type IN (
    'HIRE','TRANSFER','PROMOTION','DEMOTION','SECONDMENT','REASSIGNMENT'
  )),
  effective_from DATE NOT NULL,
  effective_to DATE,
  reason TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_assignments_emp ON employee_assignments (employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_assignments_eff ON employee_assignments (employee_id, effective_from DESC);

-- ---------- 6. Allow EMPLOYEE entity type on qr_codes ----------
ALTER TABLE qr_codes DROP CONSTRAINT IF EXISTS qr_codes_entity_type_check;
ALTER TABLE qr_codes ADD CONSTRAINT qr_codes_entity_type_check CHECK (entity_type IN (
  'PRODUCT','BATCH','LOT','SERIAL','WORK_ORDER','SECURITY_JOB','REAM',
  'CARTON','PALLET','ASSET','MACHINE','BIN','DELIVERY','CUSTOMER','RAW_MATERIAL','EMPLOYEE'
));

-- ---------- 7. Audit + updated_at triggers for the new tables ----------
CREATE TRIGGER trg_employee_id_sequences_set_updated_at BEFORE UPDATE ON employee_id_sequences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_employee_identities_set_updated_at BEFORE UPDATE ON employee_identities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_employee_id_cards_set_updated_at BEFORE UPDATE ON employee_id_cards
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_employee_identities_audit AFTER INSERT OR UPDATE OR DELETE ON employee_identities
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_employee_id_cards_audit AFTER INSERT OR UPDATE OR DELETE ON employee_id_cards
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_employee_assignments_audit AFTER INSERT OR UPDATE OR DELETE ON employee_assignments
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- ---------- 8. Backfill existing employees with official + short IDs ----------
DO $$
DECLARE
  v_rec record;
  v_seq bigint;
  v_short bigint;
  v_official text;
  v_badge text;
BEGIN
  FOR v_rec IN
    SELECT e.id, e.company_id, e.tenant_id,
           EXTRACT(YEAR FROM COALESCE(e.created_at, now()))::int AS yr
    FROM employees e
    WHERE e.employee_number IS NULL
    ORDER BY e.tenant_id, e.company_id, e.id
  LOOP
    INSERT INTO employee_id_sequences (tenant_id, company_id, seq_type, doc_year, current_sequence)
    VALUES (v_rec.tenant_id, v_rec.company_id, 'OFFICIAL', v_rec.yr, 1)
    ON CONFLICT (tenant_id, company_id, seq_type, doc_year)
    DO UPDATE SET current_sequence = employee_id_sequences.current_sequence + 1
    RETURNING current_sequence INTO v_seq;

    INSERT INTO employee_id_sequences (tenant_id, company_id, seq_type, doc_year, current_sequence)
    VALUES (v_rec.tenant_id, v_rec.company_id, 'SHORT', v_rec.yr, 1)
    ON CONFLICT (tenant_id, company_id, seq_type, doc_year)
    DO UPDATE SET current_sequence = employee_id_sequences.current_sequence + 1
    RETURNING current_sequence INTO v_short;

    v_official := 'HDG-EMP-' || v_rec.yr || '-' || lpad(v_seq::text, 6, '0');
    v_badge := 'HDG' || right(v_rec.yr::text, 2) || lpad(v_short::text, 4, '0');

    UPDATE employees
    SET employee_number = v_official, short_employee_number = v_badge
    WHERE id = v_rec.id;

    INSERT INTO employee_identities (tenant_id, company_id, employee_id, identity_type, identity_number, status, issued_by, metadata)
    VALUES (v_rec.tenant_id, v_rec.company_id, v_rec.id, 'OFFICIAL_EMPLOYEE_ID', v_official, 'ACTIVE', NULL, '{"source":"backfill"}'::jsonb);

    INSERT INTO employee_identities (tenant_id, company_id, employee_id, identity_type, identity_number, status, issued_by, metadata)
    VALUES (v_rec.tenant_id, v_rec.company_id, v_rec.id, 'SHORT_BADGE_ID', v_badge, 'ACTIVE', NULL, '{"source":"backfill"}'::jsonb);
  END LOOP;
END $$;

-- ---------- 9. Permissions ----------
INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, 'hr', v.resource, v.action, v.description
FROM (VALUES
  ('hr.employee_identity.view','employee_identity','view','View the employee identity centre, IDs, QR and card records'),
  ('hr.employee_identity.generate','employee_identity','generate','Generate official and short employee IDs'),
  ('hr.employee_identity.replace','employee_identity','replace','Replace/revoke an employee identity'),
  ('hr.employee_identity.suspend','employee_identity','suspend','Suspend an employee identity'),
  ('hr.employee_card.view','employee_card','view','View employee ID cards'),
  ('hr.employee_card.generate','employee_card','generate','Generate employee ID cards'),
  ('hr.employee_card.print','employee_card','print','Print employee ID cards'),
  ('hr.employee_card.issue','employee_card','issue','Issue employee ID cards to employees'),
  ('hr.employee_card.replace','employee_card','replace','Replace lost or damaged employee ID cards'),
  ('hr.employee_card.suspend','employee_card','suspend','Suspend or void an employee ID card'),
  ('hr.employee_qr.view','employee_qr','view','View employee QR identities'),
  ('hr.employee_qr.generate','employee_qr','generate','Generate employee QR identities'),
  ('hr.employee_qr.scan','employee_qr','scan','Scan employee QR identities internally'),
  ('hr.employee_qr.verify','employee_qr','verify','Verify an employee QR identity'),
  ('hr.employee_assignments.view','employee_assignments','view','View employee transfer/assignment history'),
  ('hr.employee_assignments.create','employee_assignments','create','Record employee transfers and assignments')
) AS v(code, resource, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

-- ---------- 10. Grants ----------
-- HR administrators: full identity management
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code IN (
  'hr.employee_identity.view','hr.employee_identity.generate','hr.employee_identity.replace','hr.employee_identity.suspend',
  'hr.employee_card.view','hr.employee_card.generate','hr.employee_card.print','hr.employee_card.issue','hr.employee_card.replace','hr.employee_card.suspend',
  'hr.employee_qr.view','hr.employee_qr.generate','hr.employee_qr.scan','hr.employee_qr.verify',
  'hr.employee_assignments.view','hr.employee_assignments.create'
)
WHERE r.code IN ('super_administrator','system_administrator','it_support_administrator','hr_director','hr_manager','hr_officer')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- HR assistant: read + generate only
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code IN (
  'hr.employee_identity.view','hr.employee_identity.generate',
  'hr.employee_card.view','hr.employee_card.generate',
  'hr.employee_qr.view','hr.employee_qr.verify',
  'hr.employee_assignments.view'
)
WHERE r.code IN ('hr_assistant')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Executives + finance: read-only visibility
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code IN (
  'hr.employee_identity.view','hr.employee_card.view','hr.employee_qr.view','hr.employee_assignments.view'
)
WHERE r.code IN ('ceo','managing_director','executive_director','general_manager','operations_director','commercial_director','cfo','executive_viewer')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Audit & security: read + verify/scan
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code IN (
  'hr.employee_identity.view','hr.employee_card.view','hr.employee_qr.view','hr.employee_qr.verify','hr.employee_qr.scan',
  'hr.employee_assignments.view'
)
WHERE r.code IN ('audit_administrator','internal_auditor','security_administrator')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Employee self-service: can verify their own QR identity
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code = 'hr.employee_qr.verify'
WHERE r.code IN ('employee_self_service')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ---------- 11. Keep roles.permissions jsonb consistent ----------
UPDATE roles r
SET permissions = s.agg
FROM (
  SELECT rp.role_id,
         COALESCE(jsonb_agg(DISTINCT p.code ORDER BY p.code), '[]'::jsonb) AS agg
  FROM role_permissions rp
  JOIN permissions p ON p.id = rp.permission_id
  GROUP BY rp.role_id
) s
WHERE s.role_id = r.id
  AND r.code IN ('super_administrator','system_administrator','it_support_administrator',
                 'hr_director','hr_manager','hr_officer','hr_assistant',
                 'ceo','managing_director','executive_director','general_manager',
                 'operations_director','commercial_director','cfo','executive_viewer',
                 'audit_administrator','internal_auditor','security_administrator',
                 'employee_self_service');

-- ---------- 12. Public employee QR verification (safe data only) ----------
CREATE OR REPLACE FUNCTION verify_employee_public(
  p_token text, p_ip text DEFAULT NULL, p_user_agent text DEFAULT NULL, p_device text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_ident record;
  v_emp record;
  v_result text;
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

  INSERT INTO qr_scans (company_id, tenant_id, qr_id, payload, scan_type, action, result, verified, ip, user_agent, device, metadata)
  VALUES (v_ident.company_id, v_ident.tenant_id,
          (v_ident.metadata->>'qr_id')::bigint,
          left(COALESCE(p_token, ''), 255), 'PUBLIC', 'VERIFY', v_result,
          v_result = 'VERIFIED', p_ip, p_user_agent, p_device,
          jsonb_build_object('identity_type', 'EMPLOYEE'));

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
