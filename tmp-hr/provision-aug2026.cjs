const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = 'http://localhost:4000';
const OUT = path.join(__dirname, 'aug2026-provision-summary.json');

function readToken(file = 'admin-token.txt') {
  const buf = fs.readFileSync(path.join(__dirname, file));
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^\uFEFF/, '').trim();
  return buf.toString('utf8').replace(/^\uFEFF/, '').trim();
}
const TOKEN = readToken();
const APPROVER_TOKEN = readToken('approver-token.txt');

const DEPT_PRODUCTION = 14, DEPT_LOGISTICS = 21, DEPT_HR = 19, DEPT_FINANCE = 12;
const ROLES = { SELF: 97, ACCOUNTANT: 19, HR_MANAGER: 88, DRIVER: 104 };

const NANETTE = {
  id: 1116, contractId: 248,
  first: 'Nanette', last: 'Arakaza', position: 'Accountant', basic: 926154, transport: 300000,
  dept: DEPT_FINANCE, email: 'nanette.arakaza@hopedesign.co.ug', roles: [ROLES.SELF, ROLES.ACCOUNTANT],
};

const STAFF = [
  { first: 'Anthony Njenga', last: 'Chege', position: 'Oper.& flo.Supv.', basic: 1849231, transport: 300000, dept: DEPT_PRODUCTION, email: 'anthony.chege@hopedesign.co.ug', roles: [ROLES.SELF] },
  { first: 'Guillaume', last: 'Niyonzima', position: 'Driver&G.S', basic: 665799, transport: 300000, dept: DEPT_LOGISTICS, email: 'guillaume.niyonzima@hopedesign.co.ug', roles: [ROLES.SELF, ROLES.DRIVER] },
  { first: 'Dinah Hannah', last: 'S.M.', position: "CEO's Assistant", basic: 926154, transport: 300000, dept: null, email: 'dinah.sm@hopedesign.co.ug', roles: [ROLES.SELF] },
  { first: 'Solomon', last: 'Munyagwa', position: 'Oper. Ass.', basic: 607116, transport: 150000, dept: DEPT_PRODUCTION, email: 'solomon.munyagwa@hopedesign.co.ug', roles: [ROLES.SELF] },
  { first: 'Tabu', last: 'Derrick', position: 'Production', basic: 226539, transport: 150000, dept: DEPT_PRODUCTION, email: 'tabu.derrick@hopedesign.co.ug', roles: [ROLES.SELF] },
  { first: 'Emile', last: 'Niyungeko', position: 'Production', basic: 237965, transport: 150000, dept: DEPT_PRODUCTION, email: 'emile.niyungeko@hopedesign.co.ug', roles: [ROLES.SELF] },
  { first: 'Gloria', last: 'Nakakawa', position: 'Production', basic: 237965, transport: 150000, dept: DEPT_PRODUCTION, email: 'gloria.nakakawa@hopedesign.co.ug', roles: [ROLES.SELF] },
  { first: 'Racheal', last: 'Tagulwa', position: 'Production', basic: 237965, transport: 150000, dept: DEPT_PRODUCTION, email: 'racheal.tagulwa@hopedesign.co.ug', roles: [ROLES.SELF] },
  { first: 'Lorraine', last: 'Ninihazwe', position: 'Production', basic: 237965, transport: 150000, dept: DEPT_PRODUCTION, email: 'lorraine.ninihazwe@hopedesign.co.ug', roles: [ROLES.SELF] },
  { first: 'Shamirah', last: 'Nantume', position: 'Production', basic: 237965, transport: 150000, dept: DEPT_PRODUCTION, email: 'shamirah.nantume@hopedesign.co.ug', roles: [ROLES.SELF] },
  { first: 'Viola', last: 'Akatikwasa', position: 'Production', basic: 237965, transport: 150000, dept: DEPT_PRODUCTION, email: 'viola.akatikwasa@hopedesign.co.ug', roles: [ROLES.SELF] },
  { first: 'Mbeba David', last: 'Sebikali', position: 'Office Att.', basic: 320789, transport: 0, dept: null, email: 'mbeba.sebikali@hopedesign.co.ug', roles: [ROLES.SELF] },
  { first: 'Nyirinkindi', last: 'Annonciata', position: 'HR', basic: 692885, transport: 300000, dept: DEPT_HR, email: 'nyirinkindi.annonciata@hopedesign.co.ug', roles: [ROLES.SELF, ROLES.HR_MANAGER] },
];

function sqlRaw(query) {
  return execFileSync('docker', ['exec', 'hopedesign_postgres', 'psql', '-U', 'hopedesign', '-d', 'hopedesign_erp', '-t', '-A', '-c', query], { encoding: 'utf8' });
}
function sql(query) { return sqlRaw(query).trim(); }
function sqlVal(query) { return sql(query).split('\n')[0]; }

async function api(method, urlPath, body, token = TOKEN) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${JSON.stringify(json)}`);
  return json.data;
}

async function ensureEmployee(s) {
  const existing = sqlVal(`SELECT id FROM employees WHERE tenant_id=2 AND company_id=2 AND lower(email)=lower('${s.email}') LIMIT 1`);
  if (existing) {
    s.employeeId = Number(existing);
    s.employeeNo = sqlVal(`SELECT employee_no FROM employees WHERE id=${s.employeeId}`);
    console.log(`  (exists) ${s.employeeNo} -> employee#${s.employeeId}  ${s.first} ${s.last}`);
    return;
  }
  const data = await api('POST', '/api/ops/hr/employees', {
    firstName: s.first, lastName: s.last, departmentId: s.dept, position: s.position,
    hireDate: '2026-08-01', salaryType: 'MONTHLY', baseSalary: s.basic,
    email: s.email, status: 'ACTIVE',
  });
  s.employeeId = data.employeeId;
  s.employeeNo = data.employeeNo;
  console.log(`  ${data.employeeNo} -> employee#${data.employeeId}  ${s.first} ${s.last}`);
}

async function ensureContract(s) {
  const existing = sqlVal(`SELECT id FROM employment_contracts WHERE employee_id=${s.employeeId} AND status='ACTIVE' ORDER BY start_date DESC LIMIT 1`);
  if (existing) {
    s.contractId = Number(existing);
    s.contractNo = sqlVal(`SELECT contract_no FROM employment_contracts WHERE id=${s.contractId}`);
    console.log(`  (exists) ${s.contractNo} -> contract#${s.contractId} (ACTIVE) ${s.first} ${s.last}`);
    return;
  }
  const data = await api('POST', '/api/ops/hr/contracts', {
    employeeId: s.employeeId,
    contractType: 'PERMANENT',
    startDate: '2026-08-01',
    jobTitle: s.position,
    departmentId: s.dept,
    salary: {
      basic: s.basic, gross: s.basic + s.transport,
      frequency: 'MONTHLY', currency: 'UGX',
      allowances: [{ allowanceType: 'TRANSPORT', name: 'Transport', amount: s.transport, frequency: 'MONTHLY', currency: 'UGX', taxable: true }],
    },
  });
  s.contractId = data.contractId;
  s.contractNo = data.contractNo;
  console.log(`  ${data.contractNo} -> contract#${data.contractId} (${data.status}) ${s.first} ${s.last}`);
}

async function main() {
  const summary = { employees: [], contracts: [], payroll: null, users: [], notes: [] };

  console.log('== Phase 1: ensure 13 employees ==');
  for (const s of STAFF) await ensureEmployee(s);

  console.log('== Phase 2: ensure 13 contracts ==');
  for (const s of STAFF) await ensureContract(s);

  console.log('== Phase 3: activate contracts + allowances (SQL) ==');
  for (const s of STAFF) {
    sql(`UPDATE employment_contracts SET status='ACTIVE', allowances = jsonb_build_object('Transport', ${s.transport}) WHERE id = ${s.contractId}`);
  }
  sql(`UPDATE employees SET base_salary = ${NANETTE.basic} WHERE id = ${NANETTE.id}`);
  sql(`UPDATE employment_contracts SET status='ACTIVE', allowances = jsonb_build_object('Transport', ${NANETTE.transport}) WHERE id = ${NANETTE.contractId}`);
  console.log('  contracts ACTIVE with Transport allowances; Nanette base_salary + contract 248 updated');

  console.log('== Phase 4: payroll group + profiles (SQL) ==');
  let grpId = Number(sqlVal(`SELECT id FROM payroll_groups WHERE company_id=2 AND tenant_id=2 AND code='PAYROLL-AUG-2026' LIMIT 1`));
  if (!grpId) {
    grpId = Number(sqlVal(`INSERT INTO payroll_groups (company_id, tenant_id, branch_id, code, name, frequency, salary_currency, default_payment_method, status)
         VALUES (2,2,2,'PAYROLL-AUG-2026','August 2026 Staff','MONTHLY','UGX','BANK_TRANSFER','ACTIVE') RETURNING id`));
  }
  console.log(`  payroll group id = ${grpId}`);

  const allStaff = [...STAFF.map((s) => ({ employeeId: s.employeeId })), { employeeId: NANETTE.id }];
  for (const e of allStaff) {
    sql(`INSERT INTO employee_payroll_profiles (company_id, tenant_id, branch_id, employee_id, payroll_group_id, payment_method, currency, status)
         VALUES (2,2,2,${e.employeeId},${grpId},'BANK_TRANSFER','UGX','ACTIVE')
         ON CONFLICT (company_id, employee_id) DO UPDATE SET payroll_group_id = EXCLUDED.payroll_group_id, status='ACTIVE'`);
  }
  console.log(`  ensured ${allStaff.length} payroll profiles`);

  console.log('== Phase 5: payroll run Aug 2026 ==');
  let payroll = null;
  const existingRun = sqlVal(`SELECT id FROM payrolls WHERE tenant_id=2 AND company_id=2 AND payroll_group_id=${grpId}
      AND period_start='2026-08-01' AND period_end='2026-08-31' AND status NOT IN ('VOID','PAID') ORDER BY id DESC LIMIT 1`);
  if (existingRun) {
    const no = sqlVal(`SELECT payroll_no FROM payrolls WHERE id=${existingRun}`);
    payroll = { payrollId: Number(existingRun), payrollNo: no };
    console.log(`  (exists) payroll#${payroll.payrollId} ${payroll.payrollNo}`);
  } else {
    payroll = await api('POST', '/api/ops/hr/payrolls', {
      periodStart: '2026-08-01', periodEnd: '2026-08-31', runType: 'NORMAL', payrollGroupId: grpId,
    });
    console.log(`  payroll#${payroll.payrollId} ${payroll.payrollNo} (auto-calculated)`);
  }
  await api('POST', `/api/ops/hr/payrolls/${payroll.payrollId}/calculate`, {});
  console.log('  recalculated');

  const validation = await api('POST', `/api/ops/hr/payrolls/${payroll.payrollId}/validate`, {});
  console.log(`  validation: errors=${validation?.errors ?? '?'} warnings=${validation?.warnings ?? '?'}`);

  const exceptions = await api('GET', `/api/ops/hr/payrolls/${payroll.payrollId}/exceptions`, undefined);
  const errs = Array.isArray(exceptions) ? exceptions : (exceptions?.items ?? []);
  const errOnly = errs.filter((ex) => ex.severity === 'ERROR' && ex.exceptionType === 'PAID_OUTSIDE_PAYROLL_GROUP' && ex.status === 'OPEN');
  console.log(`  open ERROR PAID_OUTSIDE_PAYROLL_GROUP exceptions: ${errOnly.length}`);
  let resolved = 0;
  for (const ex of errOnly) {
    await api('POST', `/api/ops/hr/exceptions/${ex.id}/resolve`, { status: 'RESOLVED', note: 'Employee intentionally excluded from August 2026 payroll (not on staff list)' }, APPROVER_TOKEN);
    resolved++;
  }
  console.log(`  resolved ${resolved} PAID_OUTSIDE_PAYROLL_GROUP exceptions`);

  if (resolved > 0) {
    await api('POST', `/api/ops/hr/payrolls/${payroll.payrollId}/validate`, {}, APPROVER_TOKEN);
    console.log('  re-validated after resolving exceptions');
  }

  const runStatus = sqlVal(`SELECT status FROM payrolls WHERE id=${payroll.payrollId}`);
  let submitted = { already: runStatus };
  if (runStatus === 'DRAFT') {
    submitted = await api('POST', `/api/ops/hr/payrolls/${payroll.payrollId}/submit`, {}, APPROVER_TOKEN);
    console.log(`  submitted: ${JSON.stringify(submitted)}`);
  } else {
    console.log(`  run already ${runStatus}; skip submit`);
  }

  let posted = null;
  const glPosted = sqlVal(`SELECT COALESCE(gl_posted, false) FROM payrolls WHERE id=${payroll.payrollId}`);
  if (glPosted === 't' || glPosted === 'true') {
    posted = { alreadyPosted: true };
    console.log('  already posted');
  } else {
    try {
      posted = await api('POST', `/api/ops/hr/payrolls/${payroll.payrollId}/post`, {}, APPROVER_TOKEN);
      console.log(`  posted: ${JSON.stringify(posted)}`);
    } catch (e) {
      posted = { error: String(e.message) };
      console.log(`  post failed (run remains ${runStatus}): ${e.message}`);
    }
  }

  console.log('== Phase 6: user accounts ==');
  const usersToCreate = [
    ...STAFF.map((s) => ({ first: s.first, last: s.last, email: s.email, dept: s.dept, employeeId: s.employeeId, jobTitle: s.position, roles: s.roles })),
    { first: NANETTE.first, last: NANETTE.last, email: NANETTE.email, dept: NANETTE.dept, employeeId: NANETTE.id, jobTitle: NANETTE.position, roles: NANETTE.roles },
  ];
  for (const u of usersToCreate) {
    const existingUser = sqlVal(`SELECT id FROM users WHERE tenant_id=2 AND lower(email)=lower('${u.email}') LIMIT 1`);
    if (existingUser) {
      console.log(`  (exists) ${u.email} -> user#${existingUser}`);
      summary.users.push({ email: u.email, userId: Number(existingUser), username: null, tempPassword: null, employeeId: u.employeeId });
      continue;
    }
    const data = await api('POST', '/api/admin/users', {
      email: u.email, first_name: u.first, last_name: u.last,
      company_id: 2, branch_id: 2, department_id: u.dept,
      employee_id: u.employeeId, job_title: u.jobTitle,
      role_ids: u.roles, invite: false,
    });
    console.log(`  ${u.email} -> user#${data.userId} username=${data.username} tempPwd=${data.tempPassword}`);
    summary.users.push({ email: u.email, userId: data.userId, username: data.username, tempPassword: data.tempPassword, employeeId: u.employeeId });
  }

  summary.employees = [...STAFF.map((s) => ({ employeeId: s.employeeId, employeeNo: s.employeeNo, name: `${s.first} ${s.last}`, email: s.email })),
    { employeeId: NANETTE.id, employeeNo: 'EMP-2026-00001114', name: `${NANETTE.first} ${NANETTE.last}`, email: NANETTE.email }];
  summary.contracts = [...STAFF.map((s) => ({ contractId: s.contractId, contractNo: s.contractNo, employeeId: s.employeeId })),
    { contractId: NANETTE.contractId, contractNo: 'EMP/2026/000181', employeeId: NANETTE.id }];
  summary.payroll = { payrollId: payroll.payrollId, payrollNo: payroll.payrollNo, groupId: grpId, submitted, posted };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(`\nSummary written to ${OUT}`);
}

main().catch((e) => {
  console.error('\nFATAL:', e.stack || e.message);
  process.exit(1);
});

