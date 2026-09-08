-- Hope Design mill payroll register for July 2026 (UGX).
-- Idempotent. Settles June balances; OT is not used this month.
-- Final payout = net + previous_balance + reimbursement - cash_advance - other_deductions.

BEGIN;
SELECT set_app_context(
  2, 2, 2,
  (SELECT id FROM users WHERE tenant_id = 2 AND username = 'admin' LIMIT 1)
);

CREATE TEMP TABLE mill_july (
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
  prev_balance numeric(18,2) NOT NULL,
  reimbursement numeric(18,2) NOT NULL,
  cash_advance numeric(18,2) NOT NULL,
  other_deductions numeric(18,2) NOT NULL,
  final_payout numeric(18,2) NOT NULL
) ON COMMIT DROP;

INSERT INTO mill_july VALUES
  (1,  'Anthony',  'Njenga Chege',   'Operations & Floor Supervisor', 'PROD', 1678271, 300000, 130000, 2108271, 105414, 2002857, 502857, 1500000, 69230,     0,      0,     0, 1569230),
  (2,  'Guillaume','Niyonzima',      'Driver & General Services',     'LOG',   926391, 300000, 130000, 1356391,  67820, 1288571, 288571, 1000000,     0,    96, 400000, 50000,  550096),
  (3,  'Dinah',    'Hannah S.M',     'CEO''s Assistant',              'HR',    776015, 300000, 130000, 1206015,  60301, 1145714, 245714,  900000,     0,     0,      0,     0,  900000),
  (4,  'Solomon',  'Munyagwa',       'Operations Assistant',          'PROD',  474887, 150000, 130000,  754887,  37744,  717143, 117143,  600000, 24339,     0,      0,     0,  624339),
  (5,  'Tabu',     'Derrick',        'Production',                    'PROD',       0,      0,      0,       0,      0,       0,      0,       0, 11538,     0,      0,     0,   11538),
  (6,  'Emile',    'Niyungeko',      'Production',                    'PROD',       0,      0,      0,       0,      0,       0,      0,       0, 10818,     0,      0,     0,   10818),
  (7,  'Gloria',   'Nakakawa',       'Production',                    'PROD',       0,      0,      0,       0,      0,       0,      0,       0, 10096,     0,      0,     0,   10096),
  (8,  'Racheal',  'Tagulwa',        'Production',                    'PROD',       0,      0,      0,       0,      0,       0,      0,       0, 10096,     0,      0,     0,   10096),
  (9,  'Lorraine', 'Ninihazwe',      'Production',                    'PROD',       0,      0,      0,       0,      0,       0,      0,       0, 10096,     0,      0,     0,   10096),
  (10, 'Shamirah', 'Nantume',        'Production',                    'PROD',       0,      0,      0,       0,      0,       0,      0,       0, 10096,     0,      0,     0,   10096),
  (11, 'Viola',    'Akatikwasa',     'Production',                    'PROD',       0,      0,      0,       0,      0,       0,      0,       0,     0,     0,      0,     0,       0),
  (12, 'David',    'Mbeba Sebikali', 'Office Attendant',              'HR',    323392,      0,      0,  323392,  16170,  307222,   7222,  300000,     0,     0, 150000,     0,  150000),
  (13, 'Nanette',  'Arakaza',        'Accountant',                    'FIN',   776015, 300000, 130000, 1206015,  60301, 1145714, 245714,  900000,     0,     0, 100000,     0,  800000);

INSERT INTO employees (
  company_id, tenant_id, branch_id, department_id,
  employee_no, first_name, last_name, position, hire_date,
  salary_type, base_salary, status, attributes
)
SELECT
  2, 2, 2, d.id,
  'HDG-' || lpad(m.mill_no::text, 4, '0'),
  m.first_name, m.last_name, m.position, DATE '2025-01-01',
  'MONTHLY',
  COALESCE(NULLIF(m.basic, 0), e.base_salary, 0),
  'ACTIVE',
  jsonb_build_object(
    'millEmployeeNo', m.mill_no,
    'source', 'july-2026-payroll',
    'transport', m.transport,
    'lunch', m.lunch
  )
FROM mill_july m
JOIN departments d ON d.company_id = 2 AND d.code = m.dept_code
LEFT JOIN employees e ON e.company_id = 2 AND e.employee_no = 'HDG-' || lpad(m.mill_no::text, 4, '0')
ON CONFLICT (company_id, employee_no) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  last_name = EXCLUDED.last_name,
  position = EXCLUDED.position,
  department_id = EXCLUDED.department_id,
  base_salary = CASE WHEN EXCLUDED.base_salary > 0 THEN EXCLUDED.base_salary ELSE employees.base_salary END,
  attributes = employees.attributes || EXCLUDED.attributes,
  updated_at = now();

DELETE FROM payroll_component_entries
WHERE payroll_id IN (SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-07');
DELETE FROM payroll_items
WHERE payroll_id IN (SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-07');
DELETE FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-07';

INSERT INTO payrolls (
  company_id, tenant_id, payroll_no, period_start, period_end, status,
  gross_total, deduction_total, net_total, currency, created_by, run_type, reason
)
SELECT
  2, 2, 'PAY-2026-07', DATE '2026-07-01', DATE '2026-07-31', 'RELEASED',
  (SELECT sum(gross) FROM mill_july),
  (SELECT sum(nssf + paye) FROM mill_july),
  (SELECT sum(net) FROM mill_july),
  'UGX',
  (SELECT id FROM users WHERE tenant_id = 2 AND username = 'admin' LIMIT 1),
  'NORMAL',
  'Imported mill register EMPLOYEE PAY ROLL/JULY';

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
  m.other_deductions,
  m.net,
  'PS-2026-07-' || lpad(m.mill_no::text, 2, '0'),
  m.taxable,
  round(m.gross * 0.10, 2),
  0,
  m.paye + m.nssf + m.other_deductions,
  'UGX',
  jsonb_build_object(
    'source', 'july-2026-payroll',
    'transport', m.transport,
    'lunch', m.lunch,
    'overtime', 0,
    'previousBalance', m.prev_balance,
    'reimbursement', m.reimbursement,
    'cashAdvance', m.cash_advance,
    'otherDeductions', m.other_deductions,
    'amountPaid', m.final_payout,
    'finalPayout', m.final_payout,
    'balance', 0,
    'taxableIncome', m.taxable,
    'earnings', jsonb_build_array(
      jsonb_build_object('code', 'BASIC', 'name', 'Basic salary', 'amount', m.basic, 'taxable', true),
      jsonb_build_object('code', 'TRANSPORT', 'name', 'Transport allowance', 'amount', m.transport, 'taxable', true),
      jsonb_build_object('code', 'LUNCH', 'name', 'Lunch allowance', 'amount', m.lunch, 'taxable', true),
      jsonb_build_object('code', 'PREV_BALANCE', 'name', 'Previous month balance', 'amount', m.prev_balance, 'taxable', false),
      jsonb_build_object('code', 'REIMBURSEMENT', 'name', 'Reimbursement', 'amount', m.reimbursement, 'taxable', false)
    )
  )
FROM mill_july m
JOIN employees e ON e.company_id = 2 AND e.employee_no = 'HDG-' || lpad(m.mill_no::text, 4, '0')
JOIN payrolls p ON p.company_id = 2 AND p.payroll_no = 'PAY-2026-07';

COMMIT;

SELECT payroll_no, period_start, period_end, status, gross_total, deduction_total, net_total
FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-07';

SELECT count(*) AS slips,
       sum((breakdown->>'previousBalance')::numeric) AS prev_total,
       sum((breakdown->>'finalPayout')::numeric) AS payout_total
FROM payroll_items i
JOIN payrolls p ON p.id = i.payroll_id
WHERE p.payroll_no = 'PAY-2026-07';
