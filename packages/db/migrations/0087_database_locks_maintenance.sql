-- ============================================================
-- 0087: Database locks / blocking monitor + maintenance runner
-- Adds database.locks.view and database.maintenance.run
-- Seeds a demo verified backup + approved restore drill.
-- ============================================================

-- ---------- 1. Seed new permissions ----------
INSERT INTO permissions (code, module, resource, action, description)
SELECT v.code, 'database', v.resource, v.action, v.description
FROM (VALUES
  ('database.locks.view','locks','view','View database locks, blocking sessions and long transactions'),
  ('database.maintenance.run','maintenance','run','Run database maintenance (analyze, vacuum, reindex)')
) AS v(code, resource, action, description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);

-- ---------- 2. Grant to administration roles ----------
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code IN ('database.locks.view','database.maintenance.run')
WHERE r.code IN ('super_administrator','system_administrator','it_support_administrator','security_administrator')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ---------- 3. Executive read-only visibility of lock monitor ----------
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code = 'database.locks.view'
WHERE r.code IN ('ceo','executive_director','general_manager','managing_director')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ---------- 4. Demo backup + approved restore drill (dev/demo data) ----------
INSERT INTO backup_records (tenant_id, backup_id, backup_type, scope, started_at, completed_at, status, size_bytes, retention_days, encrypted)
SELECT 2, 'BK-20260824-0001', 'FULL', 'FULL_DATABASE', now() - interval '26 minutes', now() - interval '24 minutes', 'VERIFIED', 110230551, 30, true
WHERE NOT EXISTS (SELECT 1 FROM backup_records WHERE backup_id = 'BK-20260824-0001');

INSERT INTO restore_requests (tenant_id, requested_by, backup_id, reason, risk_confirmed_at, mfa_verified_at, approved_by, approved_at, recovery_point, status, completed_at)
SELECT 2,
       (SELECT id FROM users WHERE email = 'admin@hopedesign.co.ug' AND tenant_id = 2 LIMIT 1),
       bk.id,
       'Demo restore drill — verify point-in-time recovery for the finance ledger',
       now() - interval '20 minutes',
       now() - interval '19 minutes',
       (SELECT id FROM users WHERE email = 'admin@hopedesign.co.ug' AND tenant_id = 2 LIMIT 1),
       now() - interval '18 minutes',
       now() - interval '26 minutes',
       'APPROVED',
       now() - interval '16 minutes'
FROM backup_records bk
WHERE bk.backup_id = 'BK-20260824-0001'
  AND NOT EXISTS (SELECT 1 FROM restore_requests rr WHERE rr.backup_id = bk.id)
  AND EXISTS (SELECT 1 FROM users u WHERE u.email = 'admin@hopedesign.co.ug' AND u.tenant_id = 2);
