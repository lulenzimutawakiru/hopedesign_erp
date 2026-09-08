-- Hope Design mill payroll register for June 2026 (UGX).
-- Idempotent. Preserves the mill's actuals (OT is paid after statutory net).
-- Run inside a transaction with set_app_context(2,2,2,admin).

BEGIN;
SELECT set_app_context(
  2, 2, 2,
  (SELECT id FROM users WHERE tenant_id = 2 AND username = 'admin' LIMIT 1)
);

INSERT INTO departments (company_id, tenant_id, branch_id, code, name, status)
VALUES
  (2, 2, 2, 'PROD', 'Production', 'ACTIVE'),
  (2, 2, 2, 'LOG', 'Logistics', 'ACTIVE'),
  (2, 2, 2, 'HR', 'Human Resources', 'ACTIVE'),
  (2, 2, 2, 'FIN', 'Finance', 'ACTIVE')
ON CONFLICT (company_id, code) DO NOTHING;

CREATE TEMP TABLE mill_june (
  mill_no int PRIMARY KEY,
  first_name text NOT NULL,
  last_name text NOT NULL,
  position text NOT NULL,
  dept_code text NOT NULL,
  basic numeric(18,2) NOT NULL,
  transport numeric(18,2) NOT NULL,
  lunch numeric(18,2) NOT NULL,
  gross numeric(18,2) NOT NULL,
  nssf numeric(18,2) NOT NULL,
  taxable numeric(18,2) NOT NULL,
  paye numeric(18,2) NOT NULL,
  net numeric(18,2) NOT NULL,
  overtime numeric(18,2) NOT NULL,
  cash_advance numeric(18,2) NOT NULL,
  amount_paid numeric(18,2) NOT NULL,
  balance numeric(18,2) NOT NULL
) ON COMMIT DROP;

INSERT INTO mill_june VALUES
  (1,  'Anthony',  'Njenga Chege',   'Operations & Floor Supervisor', 'PROD', 1678271, 300000, 130000, 2108271, 105414, 2002857, 502857, 1500000, 161538, 150000, 1442308, 69230),
  (2,  'Guillaume','Niyonzima',      'Driver & General Services',     'LOG',   926391, 300000, 130000, 1356391,  67820, 1288571, 288571, 1000000,      0, 500000,  500000,     0),
  (3,  'Dinah',    'Hannah S.M',     'CEO''s Assistant',              'HR',    776015, 300000, 130000, 1206015,  60301, 1145714, 245714,  900000,      0, 500000,  400000,     0),
  (4,  'Solomon',  'Munyagwa',       'Operations Assistant',          'PROD',  474887, 150000, 130000,  754887,  37744,  717143, 117143,  600000,  55709, 100000,  531370, 24339),
  (5,  'Tabu',     'Derrick',        'Production',                    'PROD',  249323, 150000, 130000,  529323,  26466,  502857,  52857,  450000,  24519,  44000,  418981, 11538),
  (6,  'Emile',    'Niyungeko',      'Production',                    'PROD',  249323, 150000, 130000,  529323,  26466,  502857,  52857,  450000,  22356,      0,  461538, 10818),
  (7,  'Gloria',   'Nakakawa',       'Production',                    'PROD',  249323, 150000, 130000,  529323,  26466,  502857,  52857,  450000,  20192,      0,  460096, 10096),
  (8,  'Racheal',  'Tagulwa',        'Production',                    'PROD',  249323, 150000, 130000,  529323,  26466,  502857,  52857,  450000,  20192,      0,  460096, 10096),
  (9,  'Lorraine', 'Ninihazwe',      'Production',                    'PROD',  249323, 150000, 130000,  529323,  26466,  502857,  52857,  450000,  20192,      0,  460096, 10096),
  (10, 'Shamirah', 'Nantume',        'Production',                    'PROD',  249323, 150000, 130000,  529323,  26466,  502857,  52857,  450000,  20192,      0,  460096, 10096),
  (11, 'Viola',    'Akatikwasa',     'Production',                    'PROD',  249323, 150000, 130000,  529323,  26466,  502857,  52857,  450000,      0,  50000,  400000,     0),
  (12, 'David',    'Mbeba Sebikali', 'Office Attendant',              'HR',    323392,      0,      0,  323392,  16170,  307222,   7222,  300000,      0,  50000,  250000,     0),
  (13, 'Nanette',  'Arakaza',        'Accountant',                    'FIN',   776015, 300000, 130000, 1206015,  60301, 1145714, 245714,  900000,      0, 600000,  300000,     0);

INSERT INTO employees (
  company_id, tenant_id, branch_id, department_id,
  employee_no, first_name, last_name, position, hire_date,
  salary_type, base_salary, status, attributes
)
SELECT
  2, 2, 2, d.id,
  'HDG-' || lpad(m.mill_no::text, 4, '0'),
  m.first_name, m.last_name, m.position, DATE '2025-01-01',
  'MONTHLY', m.basic, 'ACTIVE',
  jsonb_build_object(
    'millEmployeeNo', m.mill_no,
    'source', 'june-2026-payroll',
    'transport', m.transport,
    'lunch', m.lunch
  )
FROM mill_june m
JOIN departments d ON d.company_id = 2 AND d.code = m.dept_code
ON CONFLICT (company_id, employee_no) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  last_name = EXCLUDED.last_name,
  position = EXCLUDED.position,
  department_id = EXCLUDED.department_id,
  base_salary = EXCLUDED.base_salary,
  status = 'ACTIVE',
  attributes = employees.attributes || EXCLUDED.attributes,
  updated_at = now();

INSERT INTO payroll_component_definitions (company_id, tenant_id, code, name, type, category, is_taxable, calculation_type, value, status)
VALUES
  (2, 2, 'TRANSPORT', 'Transport allowance', 'EARNING', 'ALLOWANCE', true, 'FIXED', 0, 'ACTIVE'),
  (2, 2, 'LUNCH', 'Lunch allowance', 'EARNING', 'ALLOWANCE', true, 'FIXED', 0, 'ACTIVE')
ON CONFLICT (company_id, code) DO UPDATE SET
  name = EXCLUDED.name,
  type = EXCLUDED.type,
  category = EXCLUDED.category,
  is_taxable = EXCLUDED.is_taxable,
  status = 'ACTIVE',
  updated_at = now();

INSERT INTO employee_payroll_components (
  company_id, tenant_id, employee_id, component_id, value, effective_from, status
)
SELECT 2, 2, e.id, c.id, m.transport, DATE '2025-01-01', 'ACTIVE'
FROM mill_june m
JOIN employees e ON e.company_id = 2 AND e.employee_no = 'HDG-' || lpad(m.mill_no::text, 4, '0')
JOIN payroll_component_definitions c ON c.company_id = 2 AND c.code = 'TRANSPORT'
WHERE m.transport > 0
  AND NOT EXISTS (
    SELECT 1 FROM employee_payroll_components x
    WHERE x.employee_id = e.id AND x.component_id = c.id AND x.status = 'ACTIVE'
  );

INSERT INTO employee_payroll_components (
  company_id, tenant_id, employee_id, component_id, value, effective_from, status
)
SELECT 2, 2, e.id, c.id, m.lunch, DATE '2025-01-01', 'ACTIVE'
FROM mill_june m
JOIN employees e ON e.company_id = 2 AND e.employee_no = 'HDG-' || lpad(m.mill_no::text, 4, '0')
JOIN payroll_component_definitions c ON c.company_id = 2 AND c.code = 'LUNCH'
WHERE m.lunch > 0
  AND NOT EXISTS (
    SELECT 1 FROM employee_payroll_components x
    WHERE x.employee_id = e.id AND x.component_id = c.id AND x.status = 'ACTIVE'
  );

UPDATE employee_payroll_components epc
SET value = m.transport, updated_at = now()
FROM mill_june m
JOIN employees e ON e.company_id = 2 AND e.employee_no = 'HDG-' || lpad(m.mill_no::text, 4, '0')
JOIN payroll_component_definitions c ON c.company_id = 2 AND c.code = 'TRANSPORT'
WHERE epc.employee_id = e.id AND epc.component_id = c.id AND epc.status = 'ACTIVE';

UPDATE employee_payroll_components epc
SET value = m.lunch, updated_at = now()
FROM mill_june m
JOIN employees e ON e.company_id = 2 AND e.employee_no = 'HDG-' || lpad(m.mill_no::text, 4, '0')
JOIN payroll_component_definitions c ON c.company_id = 2 AND c.code = 'LUNCH'
WHERE epc.employee_id = e.id AND epc.component_id = c.id AND epc.status = 'ACTIVE';

DELETE FROM payroll_component_entries
WHERE payroll_id IN (SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-06');
DELETE FROM payroll_items
WHERE payroll_id IN (SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-06');
DELETE FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-06';

INSERT INTO payrolls (
  company_id, tenant_id, payroll_no, period_start, period_end, status,
  gross_total, deduction_total, net_total, currency, created_by, run_type, reason
)
SELECT
  2, 2, 'PAY-2026-06', DATE '2026-06-01', DATE '2026-06-30', 'RELEASED',
  (SELECT sum(gross) FROM mill_june),
  (SELECT sum(nssf + paye) FROM mill_june),
  (SELECT sum(net) FROM mill_june),
  'UGX',
  (SELECT id FROM users WHERE tenant_id = 2 AND username = 'admin' LIMIT 1),
  'NORMAL',
  'Imported mill register EMPLOYEE PAY ROLL/JUNE';

INSERT INTO payroll_items (
  payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf,
  loans, advances, other_deductions, net_pay, payslip_no,
  taxable_income, employer_nssf, lst, total_deductions, currency, breakdown
)
SELECT
  p.id,
  e.id,
  m.basic,
  m.transport + m.lunch,
  m.gross,
  m.paye,
  m.nssf,
  0,
  m.cash_advance,
  0,
  m.net,
  'PS-2026-06-' || lpad(m.mill_no::text, 2, '0'),
  m.taxable,
  round(m.gross * 0.10, 2),
  0,
  m.paye + m.nssf,
  'UGX',
  jsonb_build_object(
    'source', 'june-2026-payroll',
    'transport', m.transport,
    'lunch', m.lunch,
    'overtime', m.overtime,
    'cashAdvance', m.cash_advance,
    'amountPaid', m.amount_paid,
    'balance', m.balance,
    'taxableIncome', m.taxable,
    'earnings', jsonb_build_array(
      jsonb_build_object('code', 'BASIC', 'name', 'Basic salary', 'amount', m.basic, 'taxable', true),
      jsonb_build_object('code', 'TRANSPORT', 'name', 'Transport allowance', 'amount', m.transport, 'taxable', true),
      jsonb_build_object('code', 'LUNCH', 'name', 'Lunch allowance', 'amount', m.lunch, 'taxable', true),
      jsonb_build_object('code', 'OVERTIME', 'name', 'Overtime (paid after net)', 'amount', m.overtime, 'taxable', false)
    )
  )
FROM mill_june m
JOIN employees e ON e.company_id = 2 AND e.employee_no = 'HDG-' || lpad(m.mill_no::text, 4, '0')
JOIN payrolls p ON p.company_id = 2 AND p.payroll_no = 'PAY-2026-06';

COMMIT;

SELECT e.employee_no, e.first_name, e.last_name, e.position, e.base_salary
FROM employees e WHERE e.company_id = 2 AND e.employee_no LIKE 'HDG-%'
ORDER BY e.employee_no;

SELECT payroll_no, period_start, period_end, status, gross_total, deduction_total, net_total
FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-06';

SELECT count(*) AS slips, sum((breakdown->>'balance')::numeric) AS balance_total
FROM payroll_items i
JOIN payrolls p ON p.id = i.payroll_id
WHERE p.payroll_no = 'PAY-2026-06';
