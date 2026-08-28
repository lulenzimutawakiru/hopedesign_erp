const { execFileSync } = require('child_process');
const q = (sql) => {
  try { return execFileSync('docker', ['exec','hopedesign_postgres','psql','-U','hopedesign','-d','hopedesign_erp','-t','-A','-F','|','-c', sql], { encoding: 'utf8' }); }
  catch (e) { return 'ERR: ' + e.stderr; }
};
console.log(q("select id, category, code, name, effective_from, effective_to, rates, thresholds, limits from statutory_configs where status='ACTIVE' order by id"));
