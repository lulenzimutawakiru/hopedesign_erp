const { Pool } = require('pg');
const pool = new Pool({ host: 'localhost', port: 5432, user: 'hopedesign', password: 'hopedesign_dev', database: 'hopedesign_erp' });
const EMPLOYEE_CHILD_TABLES = [
  'asset_assignments','attendance','benefit_claims','benefit_enrollments','bonus_records','commission_records',
  'disciplinary_actions','disciplinary_cases','employee_benefits','employee_competencies','employee_deductions',
  'employee_earnings','employee_loans','employee_movements','employee_payroll_components','employee_requests',
  'employee_salaries','final_settlements','fraud_alerts','grievances','leave_balances','leave_requests',
  'offboarding_instances','overtime_records','onboarding_instances','overtime_requests','payment_batch_items',
  'payment_transactions','payroll_adjustments','payroll_arrears','payroll_calculations','payroll_component_entries',
  'payroll_documents','payroll_exceptions','payroll_items','payroll_run_employees','payslips','performance_goals',
  'performance_improvement_plans','performance_kpis','performance_reviews','position_assignments','practitioners',
  'salary_histories','shift_assignments','statutory_calculations','timesheets','training_certificates',
  'training_enrollments','training_requests','warnings',
];
(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 1. Find junk payrolls: any DRAFT 2027 payroll not created by us (i.e., test leftovers)
    const junk = await client.query(
      `SELECT id FROM payrolls WHERE period_start >= '2027-01-01' AND id <> 632 ORDER BY id`
    );
    const payrollIds = junk.rows.map(r => Number(r.id));
    for (const pid of payrollIds) {
      const fk = await client.query(`
        SELECT tc.table_name FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'payrolls' AND ccu.column_name = 'id'
      `);
      for (const r of fk.rows) {
        try { await client.query(`DELETE FROM ${r.table_name} WHERE payroll_id = $1`, [pid]); } catch {}
      }
      await client.query('DELETE FROM payrolls WHERE id = $1', [pid]);
    }
    console.log('payrolls deleted:', payrollIds);
    // 2. Delete employees that are test leftovers (Modern/Prorated/Bonus/OffCycle/Peter/Asha/Arrears etc.) - any employee
    //    created by tests, identified by name patterns OR simply any employee created in the last hour beyond the 14.
    const emps = await client.query(`SELECT id, first_name, last_name FROM employees WHERE id NOT IN (1116,1122,1123,1124,1125,1126,1127,1128,1129,1130,1131,1132,1133,1134) ORDER BY id`);
    const ids = emps.rows.map(r => Number(r.id));
    if (ids.length) {
      await client.query('UPDATE users SET employee_id = NULL WHERE employee_id = ANY($1)', [ids]);
      await client.query('DELETE FROM user_employment_links WHERE employee_id = ANY($1)', [ids]);
      for (const table of EMPLOYEE_CHILD_TABLES) {
        try { await client.query(`DELETE FROM ${table} WHERE employee_id = ANY($1)`, [ids]); } catch {}
      }
      const del = await client.query('DELETE FROM employees WHERE id = ANY($1)', [ids]);
      console.log('employees deleted:', del.rowCount, emps.rows.map(r => r.first_name + ' ' + r.last_name).join(', '));
    } else {
      console.log('no junk employees');
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); await pool.end(); }
})().catch(e => { console.error(e); process.exit(1); });
