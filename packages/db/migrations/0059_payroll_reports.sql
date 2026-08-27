-- ============================================================
-- 0059 Payroll reporting views
-- Read-only analytical views over the operational payroll engine
-- (`payrolls` + `payroll_items` + `payslips`). Tenant isolation is
-- inherited from the base tables via RLS; the reports API adds an
-- explicit company_id filter on top.
-- ============================================================

-- ---------- Payroll register (per run, per employee) ----------
CREATE OR REPLACE VIEW v_payroll_register AS
SELECT
  p.id                            AS payroll_id,
  p.payroll_no,
  p.run_type,
  p.off_cycle_type,
  p.period_start,
  p.period_end,
  p.payment_date,
  p.status                        AS payroll_status,
  p.currency,
  p.validation_score,
  p.payroll_group_id,
  pg.name                         AS payroll_group_name,
  p.company_id,
  p.tenant_id,
  e.id                            AS employee_id,
  e.employee_no,
  e.first_name,
  e.last_name,
  (e.first_name || ' ' || e.last_name) AS employee_name,
  e.position,
  e.status                        AS employee_status,
  d.name                          AS department,
  br.name                         AS branch,
  i.basic_pay,
  i.allowances,
  i.gross_pay,
  i.taxable_income,
  i.paye,
  i.nssf,
  i.lst,
  i.employer_nssf,
  i.loans,
  i.advances,
  i.other_deductions,
  i.total_deductions,
  i.net_pay,
  i.payslip_no
FROM payroll_items i
JOIN payrolls p         ON p.id = i.payroll_id
JOIN employees e        ON e.id = i.employee_id
LEFT JOIN departments d ON d.id = e.department_id
LEFT JOIN branches br   ON br.id = e.branch_id
LEFT JOIN payroll_groups pg ON pg.id = p.payroll_group_id;

-- ---------- Payroll summary (per run) ----------
CREATE OR REPLACE VIEW v_payroll_summary AS
SELECT
  p.id                                AS payroll_id,
  p.payroll_no,
  p.run_type,
  p.off_cycle_type,
  p.period_start,
  p.period_end,
  p.payment_date,
  p.status                            AS payroll_status,
  p.currency,
  p.validation_score,
  p.payroll_group_id,
  pg.name                             AS payroll_group_name,
  p.company_id,
  p.tenant_id,
  count(i.employee_id)::int           AS employee_count,
  COALESCE(sum(i.basic_pay), 0)       AS basic_total,
  COALESCE(sum(i.allowances), 0)      AS allowances_total,
  COALESCE(sum(i.gross_pay), 0)       AS gross_total,
  COALESCE(sum(i.taxable_income), 0)  AS taxable_total,
  COALESCE(sum(i.paye), 0)            AS paye_total,
  COALESCE(sum(i.nssf), 0)            AS nssf_total,
  COALESCE(sum(i.lst), 0)             AS lst_total,
  COALESCE(sum(i.employer_nssf), 0)   AS employer_nssf_total,
  COALESCE(sum(i.loans), 0)           AS loans_total,
  COALESCE(sum(i.advances), 0)        AS advances_total,
  COALESCE(sum(i.other_deductions), 0) AS other_deductions_total,
  COALESCE(sum(i.total_deductions), 0) AS deduction_total,
  COALESCE(sum(i.net_pay), 0)         AS net_total
FROM payrolls p
LEFT JOIN payroll_items i ON i.payroll_id = p.id
LEFT JOIN payroll_groups pg ON pg.id = p.payroll_group_id
GROUP BY p.id, pg.name;

-- ---------- Statutory report (per run, per employee, per rule) ----------
CREATE OR REPLACE VIEW v_payroll_statutory AS
SELECT
  p.id            AS payroll_id,
  p.payroll_no,
  p.run_type,
  p.period_start,
  p.period_end,
  p.payment_date,
  p.status        AS payroll_status,
  p.currency,
  p.company_id,
  p.tenant_id,
  e.id            AS employee_id,
  e.employee_no,
  (e.first_name || ' ' || e.last_name) AS employee_name,
  d.name          AS department,
  x.rule_code,
  x.rule_name,
  x.contribution_type,
  x.taxable_base,
  x.amount
FROM payrolls p
JOIN payroll_items i ON i.payroll_id = p.id
JOIN employees e     ON e.id = i.employee_id
LEFT JOIN departments d ON d.id = e.department_id
CROSS JOIN LATERAL (
  VALUES
    ('PAYE', 'Pay As You Earn', 'EMPLOYEE', i.taxable_income, i.paye),
    ('NSSF', 'National Social Security Fund', 'EMPLOYEE', i.gross_pay, i.nssf),
    ('NSSF', 'National Social Security Fund', 'EMPLOYER', i.gross_pay, i.employer_nssf),
    ('LST',  'Local Service Tax', 'EMPLOYEE', i.gross_pay, i.lst)
) AS x(rule_code, rule_name, contribution_type, taxable_base, amount)
WHERE x.amount IS DISTINCT FROM 0;

-- ---------- Earnings report (per run, per employee) ----------
CREATE OR REPLACE VIEW v_payroll_earnings AS
SELECT
  p.id            AS payroll_id,
  p.payroll_no,
  p.run_type,
  p.period_start,
  p.period_end,
  p.payment_date,
  p.status        AS payroll_status,
  p.currency,
  p.company_id,
  p.tenant_id,
  e.id            AS employee_id,
  e.employee_no,
  (e.first_name || ' ' || e.last_name) AS employee_name,
  d.name          AS department,
  i.basic_pay,
  i.allowances,
  i.gross_pay,
  i.taxable_income,
  i.net_pay
FROM payroll_items i
JOIN payrolls p         ON p.id = i.payroll_id
JOIN employees e        ON e.id = i.employee_id
LEFT JOIN departments d ON d.id = e.department_id;

-- ---------- Deductions report (per run, per employee) ----------
CREATE OR REPLACE VIEW v_payroll_deductions AS
SELECT
  p.id            AS payroll_id,
  p.payroll_no,
  p.run_type,
  p.period_start,
  p.period_end,
  p.payment_date,
  p.status        AS payroll_status,
  p.currency,
  p.company_id,
  p.tenant_id,
  e.id            AS employee_id,
  e.employee_no,
  (e.first_name || ' ' || e.last_name) AS employee_name,
  d.name          AS department,
  i.gross_pay,
  i.paye,
  i.nssf,
  i.lst,
  i.loans,
  i.advances,
  i.other_deductions,
  i.total_deductions,
  i.net_pay
FROM payroll_items i
JOIN payrolls p         ON p.id = i.payroll_id
JOIN employees e        ON e.id = i.employee_id
LEFT JOIN departments d ON d.id = e.department_id;

-- ---------- Payslip register (published payslips) ----------
CREATE OR REPLACE VIEW v_payslip_register AS
SELECT
  s.id                    AS payslip_id,
  s.payslip_no,
  s.status                AS payslip_status,
  s.verification_code,
  s.payment_date,
  s.published_at,
  s.viewed_count,
  s.download_count,
  s.currency,
  s.gross_total,
  s.taxable_total,
  s.deduction_total,
  s.net_total,
  s.employer_contributions,
  s.company_id,
  s.tenant_id,
  s.payroll_id,
  p.payroll_no,
  p.period_start,
  p.period_end,
  p.run_type,
  e.id                    AS employee_id,
  e.employee_no,
  (e.first_name || ' ' || e.last_name) AS employee_name,
  d.name                  AS department,
  br.name                 AS branch
FROM payslips s
LEFT JOIN payrolls p      ON p.id = s.payroll_id
JOIN employees e          ON e.id = s.employee_id
LEFT JOIN departments d   ON d.id = e.department_id
LEFT JOIN branches br     ON br.id = e.branch_id;
