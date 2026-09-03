INSERT INTO permissions (code, module, resource, action, description, is_system)
VALUES ('sales.quotations.send', 'sales', 'quotations', 'send', 'Send quotation to the customer by email or SMS', false)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE p.code = 'sales.quotations.send'
   AND (
     r.code IN ('super_administrator', 'system_administrator', 'sales_manager', 'sales_director', 'sales_executive')
     OR EXISTS (
       SELECT 1
         FROM role_permissions rp
         JOIN permissions px ON px.id = rp.permission_id
        WHERE rp.role_id = r.id
          AND px.code IN ('sales.quotations.submit', 'sales.quotations.create')
     )
   )
ON CONFLICT DO NOTHING;
