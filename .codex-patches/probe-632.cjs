const pg = require('pg');
(async () => {
  const c = new pg.Client({host:'localhost',port:5432,user:'hopedesign',password:'hopedesign_dev',database:'hopedesign_erp'});
  await c.connect();
  const r = await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='payroll_items' ORDER BY ordinal_position");
  console.log('COLS:', r.rows.map(x=>x.column_name).join(', '));
  const i = await c.query('SELECT employee_id, taxable_income, employer_nssf, lst, total_deductions, currency FROM payroll_items WHERE payroll_id = 632 ORDER BY employee_id');
  for (const row of i.rows) console.log(JSON.stringify(row));
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
