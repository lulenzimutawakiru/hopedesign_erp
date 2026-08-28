const pg = require('pg');
(async () => {
  const c = new pg.Client({host:'localhost',port:5432,user:'hopedesign',password:'hopedesign_dev',database:'hopedesign_erp'});
  await c.connect();
  const h0 = await c.query('SELECT id, tenant_id, company_id, payroll_no, period_start, period_end, payment_date, status, currency, run_type, off_cycle_type, reason, validation_score, gl_posted, gross_total, deduction_total, net_total FROM payrolls WHERE id = 632');
  if (!h0.rows.length) { console.log('NO PAYROLL 632'); process.exit(1); }
  const h = h0.rows[0];
  console.log('HEAD:', JSON.stringify(h));
  const head = await c.query(`SELECT p.payroll_no, p.period_start, p.period_end, p.payment_date, p.status, p.currency, p.run_type, p.off_cycle_type, p.reason, p.validation_score, p.gl_posted, p.gross_total, p.deduction_total, p.net_total, c.name AS company_name, c.legal_name AS company_legal_name, c.address AS company_address, c.phone AS company_phone, c.email AS company_email, c.tin AS company_tin FROM payrolls p JOIN companies c ON c.id = p.company_id WHERE p.id = $1 AND p.tenant_id = $2 AND p.company_id = $3`, [632, h.tenant_id, h.company_id]);
  console.log('HEAD ROWS:', head.rows.length, head.rows[0] && head.rows[0].payroll_no, '|', head.rows[0] && head.rows[0].company_legal_name);
  const items = await c.query(`SELECT i.*, e.employee_no, e.first_name, e.last_name, e.position, e.status AS employee_status, e.nssf_no, e.tin AS employee_tin, e.bank_name, e.bank_account_no, d.name AS department_name, br.name AS branch_name FROM payroll_items i JOIN payrolls p ON p.id = i.payroll_id JOIN employees e ON e.id = i.employee_id LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN branches br ON br.id = e.branch_id WHERE i.payroll_id = $1 AND p.tenant_id = $2 AND p.company_id = $3 ORDER BY e.first_name, e.last_name`, [632, h.tenant_id, h.company_id]);
  console.log('ITEMS:', items.rows.length, '| first:', items.rows[0] && (items.rows[0].first_name + ' ' + items.rows[0].last_name), '| net:', items.rows[0] && items.rows[0].net_pay);
  const sums = await c.query(`SELECT count(i.employee_id)::int AS employee_count, COALESCE(sum(i.basic_pay),0) AS basic_total, COALESCE(sum(i.allowances),0) AS allowances_total, COALESCE(sum(i.gross_pay),0) AS gross_total, COALESCE(sum(i.taxable_income),0) AS taxable_total, COALESCE(sum(i.paye),0) AS paye_total, COALESCE(sum(i.nssf),0) AS nssf_total, COALESCE(sum(i.lst),0) AS lst_total, COALESCE(sum(i.employer_nssf),0) AS employer_nssf_total, COALESCE(sum(i.loans),0) AS loans_total, COALESCE(sum(i.advances),0) AS advances_total, COALESCE(sum(i.other_deductions),0) AS other_deductions_total, COALESCE(sum(i.total_deductions),0) AS deduction_total, COALESCE(sum(i.net_pay),0) AS net_total FROM payroll_items i JOIN payrolls p ON p.id = i.payroll_id WHERE i.payroll_id = $1 AND p.tenant_id = $2 AND p.company_id = $3`, [632, h.tenant_id, h.company_id]);
  console.log('SUMS:', JSON.stringify(sums.rows[0]));
  await c.end();
  console.log('SMOKE OK');
})().catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1); });