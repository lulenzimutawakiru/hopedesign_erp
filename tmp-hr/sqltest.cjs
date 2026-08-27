const { execFileSync } = require('child_process');
const sql = (q) => execFileSync('docker', ['exec', 'hopedesign_postgres', 'psql', '-U', 'hopedesign', '-d', 'hopedesign_erp', '-t', '-A', '-c', q], { encoding: 'utf8' }).trim();
try {
  const out = sql(`INSERT INTO payroll_groups (company_id, tenant_id, branch_id, code, name, frequency, salary_currency, default_payment_method, status)
     VALUES (2,2,2,'TMP-TEST-1','Tmp Test','MONTHLY','UGX','BANK_TRANSFER','ACTIVE')
     RETURNING id`);
  console.log('RAW:', JSON.stringify(out));
  console.log('NUM:', Number(out));
} catch (e) {
  console.log('ERR', e.message);
}
