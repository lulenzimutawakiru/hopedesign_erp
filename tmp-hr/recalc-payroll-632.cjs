const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const BASE = 'http://localhost:4000';
function readToken(file) {
  const buf = fs.readFileSync(path.join(__dirname, file));
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^\uFEFF/, '').trim();
  return buf.toString('utf8').replace(/^\uFEFF/, '').trim();
}
async function api(method, urlPath, body, token) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}
function sqlRaw(q) {
  return execFileSync('docker', ['exec', 'hopedesign_postgres', 'psql', '-U', 'hopedesign', '-d', 'hopedesign_erp', '-t', '-A', '-c', q], { encoding: 'utf8' });
}
(async () => {
  const login = await api('POST', '/api/auth/login', { identifier: 'admin', password: 'ChangeMe!2026' });
  console.log('login:', login.status);
  if (!login.ok) { console.log(JSON.stringify(login.json)); process.exit(1); }
  const token = login.json.accessToken;
  const before = sqlRaw("SELECT id, status, gl_posted FROM payrolls WHERE id=632").trim();
  console.log('before:', before);
  const calc = await api('POST', '/api/ops/hr/payrolls/632/calculate', {}, token);
  console.log('calculate:', calc.ok, calc.status);
  console.log(JSON.stringify(calc.json).slice(0, 2500));
  const items = sqlRaw("SELECT count(*) FROM payroll_items WHERE payroll_id=632").trim();
  const totals = sqlRaw("SELECT COALESCE(SUM(gross_pay),0), COALESCE(SUM(total_deductions),0), COALESCE(SUM(net_pay),0), COALESCE(SUM(paye),0), COALESCE(SUM(nssf),0), COALESCE(SUM(lst),0), COALESCE(SUM(employer_nssf),0) FROM payroll_items WHERE payroll_id=632").trim();
  console.log('items:', items);
  console.log('totals(gross,ded,net,paye,nssf,lst,empNssf):', totals);
  const ex = sqlRaw("SELECT count(*) FROM payroll_exceptions WHERE payroll_id=632").trim();
  console.log('exceptions:', ex);
  fs.writeFileSync(path.join(__dirname, 'admin-token.txt'), token);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
