const { execFileSync } = require('child_process');
const q = (sql) => {
  try { return execFileSync('docker', ['exec','hopedesign_postgres','psql','-U','hopedesign','-d','hopedesign_erp','-t','-A','-F','|','-c', sql], { encoding: 'utf8' }); }
  catch (e) { return 'ERR: ' + e.stderr; }
};
console.log(q("select viewname, definition from pg_views where viewname like 'v_payroll%' or viewname like 'v_payslip%' order by viewname"));
