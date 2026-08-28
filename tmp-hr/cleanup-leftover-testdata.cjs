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
    // Find tables that reference payrolls (FK to payrolls.id) and clear rows for 747
    const fk = await client.query(`
      SELECT tc.table_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'payrolls' AND ccu.column_name = 'id'
    `);
    for (const r of fk.rows) {
      const t = r.table_name;
      try {
        await client.query(`DELETE FROM ${t} WHERE payroll_id = $1`, [747]);
      } catch (e) { console.log('skip', t, e.message); }
    }
    await client.query('DELETE FROM payrolls WHERE id = $1', [747]);
    console.log('payroll 747 deleted');

    const ids = [1324, 1325];
    await client.query('UPDATE users SET employee_id = NULL WHERE employee_id = ANY($1)', [ids]);
    await client.query('DELETE FROM user_employment_links WHERE employee_id = ANY($1)', [ids]);
    for (const table of EMPLOYEE_CHILD_TABLES) {
      try {
        const r = await client.query(`DELETE FROM ${table} WHERE employee_id = ANY($1)`, [ids]);
        if (r.rowCount > 0) console.log('cleared', table, r.rowCount);
      } catch (e) { console.log('skip', table, e.message); }
    }
    const del = await client.query('DELETE FROM employees WHERE id = ANY($1)', [ids]);
    console.log('employees deleted:', del.rowCount);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
