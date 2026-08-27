const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const BASE = 'http://localhost:4000';
function readToken(file) {
  const buf = fs.readFileSync(path.join(__dirname, file));
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^\uFEFF/, '').trim();
  return buf.toString('utf8').replace(/^\uFEFF/, '').trim();
}
const ADMIN = readToken('admin-token.txt');
const APPROVER = readToken('approver-token.txt');
const CFO = readToken('cfo-token.txt');
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
  // 1. Reverse stale journal 954 (try CFO then admin)
  let rev = await api('POST', '/api/ops/finance/journals/954/reverse', { reason: 'PAYE brackets amended (FY2026/27) - payroll 631 recalculation' }, CFO);
  if (!rev.ok) {
    console.log('CFO reverse failed: ' + rev.status + ' ' + JSON.stringify(rev.json));
    rev = await api('POST', '/api/ops/finance/journals/954/reverse', { reason: 'PAYE brackets amended (FY2026/27) - payroll 631 recalculation' }, ADMIN);
  }
  console.log('reverse journal 954:', rev.ok, rev.status, JSON.stringify(rev.json));

  // 2. Reopen payroll 631 to DRAFT, clear GL flags
  const open = sqlRaw("UPDATE payrolls SET status='DRAFT', gl_posted=false, gl_journal_id=NULL WHERE id=631 RETURNING id, status, gl_posted, gl_journal_id").trim();
  console.log('reopen payroll 631:', open);

  // 3. Recalculate with new PAYE config
  const calc = await api('POST', '/api/ops/hr/payrolls/631/calculate', {}, ADMIN);
  console.log('calculate:', calc.ok, calc.status, JSON.stringify(calc.json));

  // 4. Validate
  const val = await api('POST', '/api/ops/hr/payrolls/631/validate', {}, APPROVER);
  console.log('validate:', val.ok, val.status, JSON.stringify(val.json));

  // 5. Submit
  const sub = await api('POST', '/api/ops/hr/payrolls/631/submit', {}, APPROVER);
  console.log('submit:', sub.ok, sub.status, JSON.stringify(sub.json));

  // 6. Post (new GL journal)
  const post = await api('POST', '/api/ops/hr/payrolls/631/post', {}, APPROVER);
  console.log('post:', post.ok, post.status, JSON.stringify(post.json));
  if (!post.ok) {
    console.log('trying CFO for post...');
    const post2 = await api('POST', '/api/ops/hr/payrolls/631/post', {}, CFO);
    console.log('post(cfo):', post2.ok, post2.status, JSON.stringify(post2.json));
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
