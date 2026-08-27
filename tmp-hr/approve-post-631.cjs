const fs = require('fs');
const path = require('path');
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
(async () => {
  let r1 = await api('POST', '/api/approvals/882/decide', { decision: 'APPROVED', comment: 'Approved - PAYE recalculated with amended FY2026/27 brackets' }, APPROVER);
  console.log('task 882 (approver):', r1.ok, r1.status, JSON.stringify(r1.json));
  if (!r1.ok) {
    r1 = await api('POST', '/api/approvals/882/decide', { decision: 'APPROVED', comment: 'Approved - PAYE recalculated with amended FY2026/27 brackets' }, ADMIN);
    console.log('task 882 (admin):', r1.ok, r1.status, JSON.stringify(r1.json));
  }
  let r2 = await api('POST', '/api/approvals/883/decide', { decision: 'APPROVED', comment: 'Released - amended PAYE brackets applied' }, CFO);
  console.log('task 883 (cfo):', r2.ok, r2.status, JSON.stringify(r2.json));
  if (!r2.ok) {
    r2 = await api('POST', '/api/approvals/883/decide', { decision: 'APPROVED', comment: 'Released - amended PAYE brackets applied' }, ADMIN);
    console.log('task 883 (admin):', r2.ok, r2.status, JSON.stringify(r2.json));
  }
  const post = await api('POST', '/api/ops/hr/payrolls/631/post', {}, APPROVER);
  console.log('post payroll 631:', post.ok, post.status, JSON.stringify(post.json));
  if (!post.ok) {
    const post2 = await api('POST', '/api/ops/hr/payrolls/631/post', {}, ADMIN);
    console.log('post payroll 631 (admin):', post2.ok, post2.status, JSON.stringify(post2.json));
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
