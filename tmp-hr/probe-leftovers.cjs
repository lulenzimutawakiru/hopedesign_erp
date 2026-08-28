const { execFileSync } = require('child_process');
const q = (sql) => {
  try { return execFileSync('docker', ['exec','hopedesign_postgres','psql','-U','hopedesign','-d','hopedesign_erp','-t','-A','-F','|','-c', sql], { encoding: 'utf8' }); }
  catch (e) { return 'ERR: ' + e.stderr; }
};
console.log(q("select id, payroll_no, period_start, period_end, status, run_type from payrolls order by id desc limit 25"));
console.log('employee count:', q("select count(*) from employees where status='ACTIVE'"));
