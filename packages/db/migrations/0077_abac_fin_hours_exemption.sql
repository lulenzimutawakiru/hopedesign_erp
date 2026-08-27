UPDATE policies
SET subject_attributes = '{"policy_exempt_finance_hours": {"missing": true}}'::jsonb
WHERE code = 'ABAC-FIN-HOURS';

UPDATE users
SET attributes = COALESCE(attributes, '{}'::jsonb) || '{"policy_exempt_finance_hours": true}'::jsonb
WHERE email = 'admin@hopedesign.co.ug';