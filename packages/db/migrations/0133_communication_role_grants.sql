-- Restore communication.* role grants. Seed reconcile from the RBAC catalogue
-- previously wiped them because the catalogue had no communication module.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE p.code LIKE 'communication.%'
   AND (
     r.code IN (
       'super_administrator', 'system_administrator', 'managing_director', 'executive_director',
       'general_manager', 'ceo', 'commercial_director', 'hr_director', 'hr_manager',
       'sales_manager', 'sales_director', 'cfo', 'finance_manager', 'chief_accountant',
       'operations_director', 'production_director', 'production_manager',
       'procurement_manager', 'warehouse_manager', 'logistics_manager',
       'maintenance_manager', 'quality_manager', 'internal_auditor'
     )
     OR EXISTS (
       SELECT 1
         FROM role_permissions rp
         JOIN permissions px ON px.id = rp.permission_id
        WHERE rp.role_id = r.id
          AND px.code IN ('sales.quotations.send', 'hr.leave.approve', 'sales.quotations.view')
     )
   )
ON CONFLICT DO NOTHING;
