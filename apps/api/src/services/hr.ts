import pg from 'pg';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Ctx } from '../db.js';
import { config } from '../config.js';
import { badRequest, notFound, toCamelRow, toCamelRows, toISODate } from '../utils.js';
import { startWorkflow } from './workflow.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';
import * as finance from './finance.js';
import * as statutory from './statutory.js';
import * as payrollValidation from './payrollValidation.js';
import * as identityLink from './identityLink.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

async function nextDoc(client: pg.PoolClient, ctx: Ctx, prefix: string): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, prefix]);
  return String(res.rows[0].code);
}

function inclusiveDays(start: string, end: string): number {
  const s = Date.parse(`${start.slice(0, 10)}T00:00:00Z`);
  const e = Date.parse(`${end.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) throw badRequest('Leave dates are invalid');
  return Math.floor((e - s) / 86400000) + 1;
}

/** Uganda monthly PAYE (threshold 235,000; bands 10 / 20 / 30 / 40). */
export function ugandaPayeMonthly(taxable: number): number {
  const t = Number(taxable) || 0;
  if (t <= 235000) return 0;
  if (t <= 335000) return round2(0.10 * (t - 235000));
  if (t <= 410000) return round2(10000 + 0.20 * (t - 335000));
  if (t <= 10000000) return round2(25000 + 0.30 * (t - 410000));
  return round2(2902000 + 0.40 * (t - 10000000));
}

export function employeeNssf(gross: number): number {
  return round2(Math.max(0, Number(gross) || 0) * 0.05);
}

function sumAllowances(raw: unknown): number {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0;
  return Object.values(raw as Record<string, unknown>).reduce((s: number, v: unknown) => s + (Number(v) || 0), 0);
}

export async function listDepartments(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT id, code, name FROM departments WHERE tenant_id = $1 AND company_id = $2 ORDER BY name`,
    [ctx.tenantId, ctx.companyId]
  );
  return toCamelRows(res.rows);
}

export async function createEmployee(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    firstName: string;
    lastName: string;
    departmentId?: number | null;
    position?: string | null;
    hireDate?: string | null;
    salaryType?: string;
    baseSalary?: number;
    phone?: string | null;
    email?: string | null;
    tin?: string | null;
    nssfNo?: string | null;
    bankName?: string | null;
    bankAccountNo?: string | null;
    status?: string;
    userId?: number | null;
  }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  if (!input.firstName?.trim() || !input.lastName?.trim()) throw badRequest('First and last name are required');
  const no = await nextDoc(client, ctx, 'EMP');
  const status = input.status && ['ACTIVE', 'PROBATION'].includes(input.status) ? input.status : 'ACTIVE';
  const ins = await client.query(
    `INSERT INTO employees
       (company_id, tenant_id, branch_id, department_id, employee_no, first_name, last_name,
        phone, email, tin, nssf_no, position, hire_date, salary_type, base_salary,
        bank_name, bank_account_no, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, ctx.branchId ?? null, input.departmentId ?? null, no,
      input.firstName.trim(), input.lastName.trim(), input.phone ?? null, input.email ?? null,
      input.tin ?? null, input.nssfNo ?? null, input.position ?? null,
      input.hireDate ?? new Date().toISOString().slice(0, 10),
      input.salaryType ?? 'MONTHLY', Number(input.baseSalary ?? 0),
      input.bankName ?? null, input.bankAccountNo ?? null, status,
    ]
  );
  const employeeId = Number(ins.rows[0].id);
  const requestedUserId = input.userId != null ? Number(input.userId) : 0;
  const matchedUserId = requestedUserId || (await identityLink.findUnlinkedUserByEmail(client, ctx, input.email));
  if (matchedUserId) {
    await identityLink.linkUserEmployee(client, ctx, { userId: Number(matchedUserId), employeeId });
  }
  await emitEvent(client, ctx, { eventType: 'hr.employee_created', entityType: 'employees', entityId: employeeId, entityCode: no });
  await logAudit(client, ctx, { action: 'create', resource: 'employees', recordId: employeeId, recordCode: no });
  return { employeeId, employeeNo: no, userId: matchedUserId || null };
}

export async function terminateEmployee(client: pg.PoolClient, ctx: Ctx, employeeId: number, terminationDate?: string | null) {
  const res = await client.query(
    `UPDATE employees SET status = 'TERMINATED', termination_date = $3
     WHERE id = $1 AND tenant_id = $2 AND status <> 'TERMINATED'
     RETURNING employee_no`,
    [employeeId, ctx.tenantId, terminationDate ?? new Date().toISOString().slice(0, 10)]
  );
  if (res.rows.length === 0) throw badRequest('Employee not found or already terminated');
  await client.query(
    `UPDATE employment_contracts SET status = 'TERMINATED' WHERE employee_id = $1 AND status = 'ACTIVE'`,
    [employeeId]
  );
  return { employeeId, employeeNo: res.rows[0].employee_no, status: 'TERMINATED' };
}

export async function listEmployees(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; status?: string; page?: number; pageSize?: number }
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 40));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['e.tenant_id = $1', 'e.company_id = $2'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(e.employee_no ILIKE $${params.length} OR e.first_name ILIKE $${params.length} OR e.last_name ILIKE $${params.length} OR e.email ILIKE $${params.length})`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`e.status = $${params.length}`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `SELECT e.id, e.employee_no, e.first_name, e.last_name, e.position, e.status, e.base_salary, e.salary_type,
            e.hire_date, e.phone, e.email, e.photo_path, e.user_id,
            d.code AS department_code, d.name AS department_name,
            u.username AS user_username, u.email AS user_email, u.status AS user_status,
            (e.photo_path IS NOT NULL) AS has_photo
     FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN users u ON u.id = e.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY e.last_name, e.first_name
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: toCamelRows(res.rows), page, pageSize };
}

export async function getEmployee(client: pg.PoolClient, ctx: Ctx, employeeId: number) {
  const res = await client.query(
    `SELECT e.*, d.code AS department_code, d.name AS department_name
     FROM employees e LEFT JOIN departments d ON d.id = e.department_id
     WHERE e.id = $1 AND e.tenant_id = $2`,
    [employeeId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Employee not found');
  const [contracts, leave, loans, slips] = await Promise.all([
    client.query(`SELECT * FROM employment_contracts WHERE employee_id = $1 ORDER BY start_date DESC`, [employeeId]),
    client.query(`SELECT * FROM leave_requests WHERE employee_id = $1 ORDER BY start_date DESC LIMIT 20`, [employeeId]),
    client.query(`SELECT * FROM employee_loans WHERE employee_id = $1 ORDER BY id DESC`, [employeeId]),
    client.query(
      `SELECT i.id, i.payslip_no, i.gross_pay, i.net_pay, i.paye, i.nssf, p.payroll_no, p.period_start, p.period_end, p.status
       FROM payroll_items i JOIN payrolls p ON p.id = i.payroll_id
       WHERE i.employee_id = $1 ORDER BY p.period_end DESC LIMIT 12`,
      [employeeId]
    ),
  ]);
  const account = await identityLink.getLinkedUser(client, ctx, employeeId);
  const accountMatches = account ? [] : await identityLink.suggestUsersForEmployee(client, ctx, employeeId);
  return {
    employee: toCamelRow(res.rows[0]),
    account,
    accountMatches,
    contracts: toCamelRows(contracts.rows),
    leave: toCamelRows(leave.rows),
    loans: toCamelRows(loans.rows),
    payslips: toCamelRows(slips.rows),
    hasPhoto: Boolean((res.rows[0] as { photo_path?: string | null }).photo_path),
  };
}

const PHOTO_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
};

export interface EmployeePhotoFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export function readEmployeePhotoFile(photoPath: unknown, photoMime?: unknown): { bytes: Buffer; mime: string } | null {
  const rel = String(photoPath ?? '').trim();
  if (!rel || rel.includes('..')) return null;
  const abs = path.join(config.storageRoot, rel);
  try {
    if (!existsSync(abs)) return null;
    const bytes = readFileSync(abs);
    if (!bytes.length) return null;
    return { bytes, mime: String(photoMime ?? '') || (rel.endsWith('.png') ? 'image/png' : 'image/jpeg') };
  } catch {
    return null;
  }
}

export async function uploadEmployeePhoto(
  client: pg.PoolClient,
  ctx: Ctx,
  employeeId: number,
  file: EmployeePhotoFile,
  kind?: string
) {
  const ext = PHOTO_MIME[String(file.mimetype || '').toLowerCase()];
  if (!ext) throw badRequest('Use a JPEG or PNG passport photograph.');
  if (!file.buffer?.length) throw badRequest('A photograph file is required');
  if (file.size > 5 * 1024 * 1024) throw badRequest('Photograph exceeds the 5 MB limit');
  const emp = await client.query(
    `SELECT id, employee_no, photo_path FROM employees WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [employeeId, ctx.tenantId, ctx.companyId]
  );
  if (emp.rows.length === 0) throw notFound('Employee not found');
  const employeeNo = String(emp.rows[0].employee_no);
  const prev = emp.rows[0].photo_path ? String(emp.rows[0].photo_path) : '';
  const relDir = `hr/${ctx.tenantId}/${ctx.companyId}/employees/${employeeId}`;
  const storageKey = `${relDir}/photo.${ext}`;
  mkdirSync(path.join(config.storageRoot, relDir), { recursive: true });
  if (prev && prev !== storageKey) {
    try { unlinkSync(path.join(config.storageRoot, prev)); } catch { /* ignore */ }
  }
  writeFileSync(path.join(config.storageRoot, storageKey), file.buffer);
  const photoKind = kind === 'PHOTO' ? 'PHOTO' : 'PASSPORT';
  await client.query(
    `UPDATE employees SET photo_path = $1, photo_mime = $2, photo_kind = $3, updated_at = now()
     WHERE id = $4 AND tenant_id = $5`,
    [storageKey, file.mimetype, photoKind, employeeId, ctx.tenantId]
  );
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'employees',
    recordId: employeeId,
    recordCode: employeeNo,
    metadata: { photo: true, kind: photoKind, mimeType: file.mimetype, sizeBytes: file.size },
  });
  return { employeeId, employeeNo, hasPhoto: true, photoKind, mimeType: file.mimetype };
}

export async function getEmployeePhoto(
  client: pg.PoolClient,
  ctx: Ctx,
  employeeId: number
): Promise<{ bytes: Buffer; mime: string; employeeNo: string } | null> {
  const emp = await client.query(
    `SELECT employee_no, photo_path, photo_mime FROM employees
     WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [employeeId, ctx.tenantId, ctx.companyId]
  );
  if (emp.rows.length === 0) throw notFound('Employee not found');
  const file = readEmployeePhotoFile(emp.rows[0].photo_path, emp.rows[0].photo_mime);
  if (!file) return null;
  return { ...file, employeeNo: String(emp.rows[0].employee_no) };
}

export async function clockIn(client: pg.PoolClient, ctx: Ctx, employeeId: number) {
  const emp = await client.query(`SELECT id FROM employees WHERE id = $1 AND tenant_id = $2`, [employeeId, ctx.tenantId]);
  if (emp.rows.length === 0) throw notFound('Employee not found');
  const day = new Date().toISOString().slice(0, 10);
  const existing = await client.query(
    `SELECT id, clock_in FROM attendance WHERE employee_id = $1 AND work_date = $2`,
    [employeeId, day]
  );
  if (existing.rows.length && existing.rows[0].clock_in) throw badRequest('Already clocked in today');
  if (existing.rows.length) {
    await client.query(`UPDATE attendance SET clock_in = now(), status = 'PRESENT' WHERE id = $1`, [existing.rows[0].id]);
    return { attendanceId: Number(existing.rows[0].id), workDate: day };
  }
  const ins = await client.query(
    `INSERT INTO attendance (employee_id, work_date, clock_in, status) VALUES ($1,$2,now(),'PRESENT') RETURNING id`,
    [employeeId, day]
  );
  return { attendanceId: Number(ins.rows[0].id), workDate: day };
}

export async function clockOut(client: pg.PoolClient, ctx: Ctx, employeeId: number) {
  const day = new Date().toISOString().slice(0, 10);
  const existing = await client.query(
    `SELECT a.* FROM attendance a JOIN employees e ON e.id = a.employee_id
     WHERE a.employee_id = $1 AND a.work_date = $2 AND e.tenant_id = $3`,
    [employeeId, day, ctx.tenantId]
  );
  if (existing.rows.length === 0 || !existing.rows[0].clock_in) throw badRequest('Clock in first');
  if (existing.rows[0].clock_out) throw badRequest('Already clocked out');
  const hours = (Date.now() - new Date(existing.rows[0].clock_in).getTime()) / 3600000;
  await client.query(
    `UPDATE attendance SET clock_out = now(), hours = $2 WHERE id = $1`,
    [existing.rows[0].id, round2(hours)]
  );
  return { attendanceId: Number(existing.rows[0].id), hours: round2(hours) };
}

export async function listAttendance(client: pg.PoolClient, ctx: Ctx, day?: string) {
  const workDate = day || new Date().toISOString().slice(0, 10);
  const res = await client.query(
    `SELECT a.id, a.work_date, a.clock_in, a.clock_out, a.hours, a.status,
            e.id AS employee_id, e.employee_no, e.first_name, e.last_name
     FROM attendance a
     JOIN employees e ON e.id = a.employee_id
     WHERE e.tenant_id = $1 AND e.company_id = $2 AND a.work_date = $3
     ORDER BY e.last_name`,
    [ctx.tenantId, ctx.companyId, workDate]
  );
  return { workDate, rows: toCamelRows(res.rows) };
}

export async function createLeave(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { employeeId: number; leaveType?: string; startDate: string; endDate: string; reason?: string | null }
) {
  const emp = await client.query(`SELECT id FROM employees WHERE id = $1 AND tenant_id = $2`, [input.employeeId, ctx.tenantId]);
  if (emp.rows.length === 0) throw notFound('Employee not found');
  const days = inclusiveDays(input.startDate, input.endDate);
  const overlap = await client.query(
    `SELECT id FROM leave_requests
     WHERE employee_id = $1 AND status IN ('SUBMITTED','APPROVED')
       AND start_date <= $3 AND end_date >= $2`,
    [input.employeeId, input.startDate, input.endDate]
  );
  if (overlap.rows.length) throw badRequest('Overlaps an existing leave request');
  const leaveType = input.leaveType ?? 'ANNUAL';
  // Link the request to the configured leave type, balance and policy when present.
  const typeRes = await client.query(
    `SELECT id FROM leave_types WHERE tenant_id = $1 AND company_id = $2 AND code = $3 AND status = 'ACTIVE' ORDER BY id LIMIT 1`,
    [ctx.tenantId, ctx.companyId, leaveType]
  );
  const leaveTypeId = typeRes.rows.length ? Number(typeRes.rows[0].id) : null;
  const year = Number(String(input.startDate).slice(0, 4));
  let balanceId: number | null = null;
  let policyId: number | null = null;
  if (leaveTypeId) {
    const balRes = await client.query(
      `SELECT id FROM leave_balances
       WHERE tenant_id = $1 AND company_id = $2 AND employee_id = $3 AND leave_type_id = $4 AND year = $5
       ORDER BY year DESC LIMIT 1`,
      [ctx.tenantId, ctx.companyId, input.employeeId, leaveTypeId, year]
    );
    if (balRes.rows.length) balanceId = Number(balRes.rows[0].id);
    const polRes = await client.query(
      `SELECT id FROM leave_policies
       WHERE tenant_id = $1 AND company_id = $2 AND leave_type_id = $3 AND status = 'ACTIVE'
       ORDER BY effective_from DESC LIMIT 1`,
      [ctx.tenantId, ctx.companyId, leaveTypeId]
    );
    if (polRes.rows.length) policyId = Number(polRes.rows[0].id);
  }
  const ins = await client.query(
    `INSERT INTO leave_requests (employee_id, leave_type, leave_type_id, balance_id, policy_id, start_date, end_date, days, reason, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SUBMITTED') RETURNING id`,
    [input.employeeId, leaveType, leaveTypeId, balanceId, policyId, input.startDate, input.endDate, days, input.reason ?? null]
  );
  return { leaveId: Number(ins.rows[0].id), days, leaveTypeId, balanceId, policyId };
}

export async function decideLeave(client: pg.PoolClient, ctx: Ctx, leaveId: number, decision: 'APPROVED' | 'REJECTED') {
  const res = await client.query(
    `SELECT l.*, e.tenant_id, e.company_id,
            to_char(l.start_date, 'YYYY-MM-DD') AS start_date_iso,
            to_char(l.end_date, 'YYYY-MM-DD') AS end_date_iso
     FROM leave_requests l
     JOIN employees e ON e.id = l.employee_id
     WHERE l.id = $1 AND e.tenant_id = $2 FOR UPDATE OF l`,
    [leaveId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Leave request not found');
  if (String(res.rows[0].status) !== 'SUBMITTED') throw badRequest(`Leave is ${res.rows[0].status}`);
  await client.query(
    `UPDATE leave_requests SET status = $2, approved_by = $3, approved_at = now() WHERE id = $1`,
    [leaveId, decision, ctx.userId ?? null]
  );
  const today = new Date().toISOString().slice(0, 10);
  const startDate = String(res.rows[0].start_date_iso).slice(0, 10);
  const endDate = String(res.rows[0].end_date_iso).slice(0, 10);
  if (decision === 'APPROVED' && startDate <= today && endDate >= today) {
    await client.query(`UPDATE employees SET status = 'ON_LEAVE' WHERE id = $1 AND status = 'ACTIVE'`, [res.rows[0].employee_id]);
  }
  // Consume the leave balance when the request is linked to a leave type and a balance row exists.
  if (decision === 'APPROVED' && res.rows[0].leave_type_id != null) {
    const year = Number(startDate.slice(0, 4));
    const balanceRes = await client.query(
      `SELECT id FROM leave_balances
       WHERE tenant_id = $1 AND company_id = $2 AND employee_id = $3 AND leave_type_id = $4 AND year = $5`,
      [ctx.tenantId, res.rows[0].company_id, res.rows[0].employee_id, Number(res.rows[0].leave_type_id), year]
    );
    if (balanceRes.rows.length) {
      await client.query(
        `UPDATE leave_balances
         SET used = used + $2,
             available = opening_balance + accrued - used - $2 + adjusted
         WHERE id = $1`,
        [Number(balanceRes.rows[0].id), Number(res.rows[0].days ?? 0)]
      );
    }
  }
  return { leaveId, status: decision };
}

export async function listLeave(client: pg.PoolClient, ctx: Ctx, filters: { status?: string } = {}) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['e.tenant_id = $1', 'e.company_id = $2'];
  if (filters.status) {
    params.push(filters.status);
    where.push(`l.status = $${params.length}`);
  }
  const res = await client.query(
    `SELECT l.id, l.leave_type, l.start_date, l.end_date, l.days, l.reason, l.status,
            e.id AS employee_id, e.employee_no, e.first_name, e.last_name
     FROM leave_requests l JOIN employees e ON e.id = l.employee_id
     WHERE ${where.join(' AND ')}
     ORDER BY CASE l.status WHEN 'SUBMITTED' THEN 0 WHEN 'APPROVED' THEN 1 ELSE 2 END, l.start_date DESC
     LIMIT 80`,
    params
  );
  return toCamelRows(res.rows);
}

export async function createPayroll(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    periodStart: string;
    periodEnd: string;
    runType?: string;
    offCycleType?: string;
    reason?: string;
    employeeIds?: number[];
    extraEarnings?: number;
    extraDeductions?: number;
    deductLoans?: boolean;
    deductAdvances?: boolean;
    paymentDate?: string;
    payrollGroupId?: number | null;
  }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  if (!input.periodStart || !input.periodEnd) throw badRequest('Period start and end are required');
  if (input.periodEnd < input.periodStart) throw badRequest('Period end is before start');
  const runType = String(input.runType ?? 'NORMAL').toUpperCase();
  if (!['NORMAL','OFF_CYCLE','FINAL','ADJUSTMENT','REVERSAL','ARREARS'].includes(runType)) {
    throw badRequest('Unsupported payroll run type');
  }
  const isOffCycle = runType === 'OFF_CYCLE';
  const offCycleType = String(input.offCycleType ?? '').toUpperCase();
  const payrollGroupId = isOffCycle
    ? null
    : input.payrollGroupId != null && String(input.payrollGroupId) !== ''
      ? Number(input.payrollGroupId)
      : null;
  if (payrollGroupId !== null && (!Number.isInteger(payrollGroupId) || payrollGroupId <= 0)) {
    throw badRequest('Payroll group must be a valid id');
  }
  const employeeIds = isOffCycle && Array.isArray(input.employeeIds)
    ? [...new Set(input.employeeIds.map(Number))].filter((n) => Number.isFinite(n) && n > 0)
    : [];
  if (isOffCycle) {
    if (!['NEW_HIRE','TERMINATION','FINAL','BONUS','COMMISSION','CORRECTION','ARREARS','EMERGENCY'].includes(offCycleType)) {
      throw badRequest('Unsupported off-cycle type');
    }
    if (!String(input.reason ?? '').trim()) throw badRequest('A reason is required for off-cycle payroll');
    if (employeeIds.length === 0) throw badRequest('Select at least one employee for the off-cycle run');
  }
  if (!isOffCycle) {
    if (payrollGroupId !== null) {
      const grp = await client.query(
        `SELECT id FROM payroll_groups
         WHERE id = $1 AND tenant_id = $2 AND company_id = $3 AND status = 'ACTIVE'`,
        [payrollGroupId, ctx.tenantId, ctx.companyId]
      );
      if (grp.rows.length === 0) throw badRequest('Payroll group not found or inactive for this company');
    }
    const clash = await client.query(
      `SELECT payroll_no FROM payrolls
       WHERE tenant_id = $1 AND company_id = $2 AND status NOT IN ('VOID','PAID')
         AND period_start <= $4 AND period_end >= $3
         AND payroll_group_id IS NOT DISTINCT FROM $5`,
      [ctx.tenantId, ctx.companyId, input.periodStart, input.periodEnd, payrollGroupId]
    );
    if (clash.rows.length) throw badRequest(`Overlaps payroll ${clash.rows[0].payroll_no}`);
  }
  const payrollNo = await nextDoc(client, ctx, 'PAY');
  const ins = await client.query(
    `INSERT INTO payrolls (company_id, tenant_id, payroll_no, period_start, period_end, status, created_by,
        run_type, off_cycle_type, reason, employee_ids, extra_earnings, extra_deductions, deduct_loans, deduct_advances, payment_date, payroll_group_id)
     VALUES ($1,$2,$3,$4,$5,'DRAFT',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, payrollNo, input.periodStart, input.periodEnd, ctx.userId ?? null,
      runType, isOffCycle ? offCycleType : null, isOffCycle ? String(input.reason ?? '').trim() : null,
      employeeIds, isOffCycle ? round2(Math.max(0, Number(input.extraEarnings ?? 0))) : 0,
      isOffCycle ? round2(Math.max(0, Number(input.extraDeductions ?? 0))) : 0,
      isOffCycle ? input.deductLoans !== false : true,
      isOffCycle ? input.deductAdvances !== false : true,
      isOffCycle && input.paymentDate ? String(input.paymentDate) : null,
      payrollGroupId,
    ]
  );
  const payrollId = Number(ins.rows[0].id);
  await calculatePayroll(client, ctx, payrollId);
  return { payrollId, payrollNo };
}

export async function calculatePayroll(client: pg.PoolClient, ctx: Ctx, payrollId: number) {
  const run = await client.query(`SELECT * FROM payrolls WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [payrollId, ctx.tenantId]);
  if (run.rows.length === 0) throw notFound('Payroll not found');
  if (!['DRAFT', 'SUBMITTED'].includes(String(run.rows[0].status))) {
    throw badRequest(`Cannot recalculate a ${run.rows[0].status} payroll`);
  }
  const periodStart = toISODate(run.rows[0].period_start) ?? '';
  const periodEnd = toISODate(run.rows[0].period_end) ?? '';
  const currency = String(run.rows[0].currency ?? 'UGX');
  const runType = String(run.rows[0].run_type ?? 'NORMAL');
  const isOffCycle = runType === 'OFF_CYCLE';
  const employeeIds = isOffCycle && Array.isArray(run.rows[0].employee_ids)
    ? run.rows[0].employee_ids.map(Number).filter((n: number) => Number.isFinite(n) && n > 0)
    : [];
  const extraEarnings = isOffCycle ? round2(Math.max(0, Number(run.rows[0].extra_earnings) || 0)) : 0;
  const extraDeductions = isOffCycle ? round2(Math.max(0, Number(run.rows[0].extra_deductions) || 0)) : 0;
  const deductLoans = isOffCycle ? run.rows[0].deduct_loans !== false : true;
  const deductAdvances = isOffCycle ? run.rows[0].deduct_advances !== false : true;
  const payrollGroupId = run.rows[0].payroll_group_id != null ? Number(run.rows[0].payroll_group_id) : null;
  if (isOffCycle && employeeIds.length === 0) throw badRequest('Off-cycle payroll requires at least one selected employee');
  // ARREARS runs pay each employee their own approved net arrears (linked at
  // run creation) rather than applying one global total to every employee.
  const isArrearsRun = isOffCycle && String(run.rows[0].off_cycle_type ?? '') === 'ARREARS';
  const arrearsByEmployee = new Map<number, number>();
  if (isArrearsRun) {
    const links = await client.query(
      `SELECT employee_id, COALESCE(sum(net_arrears),0)::numeric AS total
       FROM payroll_arrears WHERE payroll_id = $1 AND status = 'APPROVED'
       GROUP BY employee_id`,
      [payrollId]
    );
    for (const r of links.rows) arrearsByEmployee.set(Number(r.employee_id), round2(Number(r.total) || 0));
  }

  // Versioned statutory configuration (Uganda defaults are seeded, never hard-coded).
  const payeCfg = await statutory.requireStatutoryConfig(client, ctx, 'PAYE', { effectiveDate: periodEnd });
  const nssfCfg = await statutory.requireStatutoryConfig(client, ctx, 'NSSF', { effectiveDate: periodEnd });
  const lstCfg = await statutory.getStatutoryConfig(client, ctx, 'LST', { effectiveDate: periodEnd });

  await client.query(`DELETE FROM payroll_items WHERE payroll_id = $1`, [payrollId]);
  const staff = isOffCycle
    ? await client.query(
        `SELECT e.*, (
            SELECT c.allowances FROM employment_contracts c
            WHERE c.employee_id = e.id AND c.status = 'ACTIVE'
            ORDER BY c.start_date DESC LIMIT 1
          ) AS contract_allowances
         FROM employees e
         WHERE e.tenant_id = $1 AND e.company_id = $2 AND e.id = ANY($3::bigint[])`,
        [ctx.tenantId, ctx.companyId, employeeIds]
      )
    : await client.query(
        `SELECT e.*, (
            SELECT c.allowances FROM employment_contracts c
            WHERE c.employee_id = e.id AND c.status = 'ACTIVE'
            ORDER BY c.start_date DESC LIMIT 1
          ) AS contract_allowances
         FROM employees e
         WHERE e.tenant_id = $1 AND e.company_id = $2
           AND e.status IN ('ACTIVE','ON_LEAVE','PROBATION')
           AND (e.termination_date IS NULL OR e.termination_date >= $3)
           ${payrollGroupId !== null ? `AND EXISTS (
             SELECT 1 FROM employee_payroll_profiles p
             WHERE p.employee_id = e.id AND p.payroll_group_id = $4
               AND p.tenant_id = e.tenant_id AND p.company_id = e.company_id
           )` : ''}`,
        payrollGroupId !== null
          ? [ctx.tenantId, ctx.companyId, periodStart, payrollGroupId]
          : [ctx.tenantId, ctx.companyId, periodStart]
      );
  if (staff.rows.length === 0) throw badRequest(isOffCycle ? 'No selected employees to pay' : 'No active employees to pay');
  let grossTotal = 0;
  let deductionTotal = 0;
  let netTotal = 0;
  for (const emp of staff.rows) {
    const allowances = sumAllowances(emp.contract_allowances);
    const unpaid = await client.query(
      `SELECT COALESCE(sum(
         GREATEST(0,
           LEAST(end_date, $3::date) - GREATEST(start_date, $2::date) + 1
         )
       ),0)::numeric AS days
       FROM leave_requests
       WHERE employee_id = $1 AND status = 'APPROVED' AND leave_type = 'UNPAID'
         AND start_date <= $3 AND end_date >= $2`,
      [emp.id, periodStart, periodEnd]
    );
    const unpaidDays = Number(unpaid.rows[0].days) || 0;
    const basic = round2(Math.max(0, Number(emp.base_salary) - (Number(emp.base_salary) / 30) * unpaidDays));
    const extraForEmployee = isArrearsRun && arrearsByEmployee.has(Number(emp.id))
      ? (arrearsByEmployee.get(Number(emp.id)) ?? 0)
      : extraEarnings;
    const gross = round2(basic + allowances + extraForEmployee);
    const nssf = statutory.computeNssf(gross, nssfCfg);
    const paye = statutory.computePaye(gross, payeCfg);
    const lst = statutory.computeLst(gross, lstCfg);
    const loanRows = await client.query(
      `SELECT id, balance, monthly_deduction FROM employee_loans
       WHERE employee_id = $1 AND status = 'ACTIVE' AND balance > 0`,
      [emp.id]
    );
    let loans = 0;
    if (deductLoans) {
      for (const ln of loanRows.rows) {
        const take = Math.min(Number(ln.monthly_deduction), Number(ln.balance), Math.max(0, gross - paye - nssf.employee - lst - loans));
        if (take <= 0) continue;
        loans = round2(loans + take);
      }
    }
    const advanceRows = await client.query(
      `SELECT id, outstanding_balance, monthly_deduction FROM salary_advances
       WHERE employee_id = $1 AND status = 'ACTIVE' AND outstanding_balance > 0`,
      [emp.id]
    );
    let advances = 0;
    if (deductAdvances) {
      for (const av of advanceRows.rows) {
        const take = Math.min(
          Number(av.monthly_deduction),
          Number(av.outstanding_balance),
          Math.max(0, gross - paye - nssf.employee - lst - loans - advances)
        );
        if (take <= 0) continue;
        advances = round2(advances + take);
      }
    }
    const deductions = round2(paye + nssf.employee + lst + loans + advances + extraDeductions);
    const net = round2(gross - deductions);
    const slip = await nextDoc(client, ctx, 'PS');
    const breakdown = {
      paye: { configId: payeCfg.id, code: payeCfg.code, version: payeCfg.version, taxableIncome: gross, tax: paye },
      nssf: { configId: nssfCfg.id, code: nssfCfg.code, version: nssfCfg.version, employee: nssf.employee, employer: nssf.employer, base: nssf.base, ceiling: nssf.ceiling },
      lst: lstCfg ? { configId: lstCfg.id, code: lstCfg.code, version: lstCfg.version, amount: lst } : null,
    };
    await client.query(
      `INSERT INTO payroll_items
         (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, payslip_no,
          taxable_income, employer_nssf, lst, total_deductions, currency, breakdown)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [payrollId, emp.id, basic, allowances, gross, paye, nssf.employee, loans, advances, extraDeductions, net, slip, gross, nssf.employer, lst, deductions, currency, JSON.stringify(breakdown)]
    );
    grossTotal += gross;
    deductionTotal += deductions;
    netTotal += net;
  }
  const statutorySnapshot = {
    paye: statutory.statutorySnapshot(payeCfg),
    nssf: statutory.statutorySnapshot(nssfCfg),
    lst: lstCfg ? statutory.statutorySnapshot(lstCfg) : null,
  };
  await client.query(
    `UPDATE payrolls SET gross_total = $2, deduction_total = $3, net_total = $4, currency = $5,
       statutory_config_id = $6, statutory_snapshot = $7 WHERE id = $1`,
    [payrollId, round2(grossTotal), round2(deductionTotal), round2(netTotal), currency, payeCfg.id, JSON.stringify(statutorySnapshot)]
  );
  const validation = await payrollValidation.validatePayroll(client, ctx, payrollId);
  return { payrollId, employees: staff.rows.length, grossTotal: round2(grossTotal), deductionTotal: round2(deductionTotal), netTotal: round2(netTotal), statutory: { paye: payeCfg.code, nssf: nssfCfg.code }, validation };
}

export async function submitPayroll(client: pg.PoolClient, ctx: Ctx, payrollId: number) {
  const openErrors = await payrollValidation.countOpenErrors(client, payrollId);
  if (openErrors > 0) {
    throw badRequest(`Payroll has ${openErrors} unresolved error${openErrors === 1 ? '' : 's'} (fix the data and recalculate)`);
  }
  const res = await client.query(
    `UPDATE payrolls SET status = 'SUBMITTED' WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT' RETURNING payroll_no, net_total`,
    [payrollId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Payroll not found or not DRAFT');
  await startWorkflow(client, ctx, {
    entityType: 'hr.payrolls',
    entityId: payrollId,
    entityCode: String(res.rows[0].payroll_no),
    amount: Number(res.rows[0].net_total),
  });
  return { payrollId, payrollNo: res.rows[0].payroll_no };
}

export async function postPayrollRun(client: pg.PoolClient, ctx: Ctx, payrollId: number) {
  const run = await client.query(`SELECT * FROM payrolls WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [payrollId, ctx.tenantId]);
  if (run.rows.length === 0) throw notFound('Payroll not found');
  if (run.rows[0].gl_posted) return { payrollId, journalId: Number(run.rows[0].gl_journal_id), alreadyPosted: true };
  const items = await client.query(`SELECT * FROM payroll_items WHERE payroll_id = $1`, [payrollId]);
  const journalId = await finance.postPayroll(client, ctx, payrollId);
  const periodCode = (toISODate(run.rows[0].period_end) ?? '').slice(0, 7) || undefined;
  for (const it of items.rows) {
    if (Number(it.loans) <= 0) continue;
    let remaining = Number(it.loans);
    const loans = await client.query(
      `SELECT id, balance, outstanding_balance FROM employee_loans
       WHERE employee_id = $1 AND status = 'ACTIVE' AND balance > 0 ORDER BY id`,
      [it.employee_id]
    );
    for (const ln of loans.rows) {
      if (remaining <= 0) break;
      const take = Math.min(Number(ln.balance), remaining);
      const next = round2(Number(ln.balance) - take);
      await client.query(
        `UPDATE employee_loans
         SET balance = $2::numeric,
             outstanding_balance = $2::numeric,
             status = CASE WHEN $2::numeric <= 0 THEN 'PAID' ELSE status END,
             period_code = $3
         WHERE id = $1`,
        [ln.id, next, periodCode]
      );
      await client.query(
        `INSERT INTO loan_repayments
           (company_id, tenant_id, loan_id, payroll_run_id, period_code, amount,
            principal_component, interest_component, paid_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$6,0,now(),$7)`,
        [ctx.companyId, ctx.tenantId, ln.id, payrollId, periodCode, take, ctx.userId ?? null]
      );
      remaining = round2(remaining - take);
    }
  }
  for (const it of items.rows) {
    if (Number(it.advances) <= 0) continue;
    let remaining = Number(it.advances);
    const advances = await client.query(
      `SELECT id, outstanding_balance FROM salary_advances
       WHERE employee_id = $1 AND status = 'ACTIVE' AND outstanding_balance > 0 ORDER BY id`,
      [it.employee_id]
    );
    for (const av of advances.rows) {
      if (remaining <= 0) break;
      const take = Math.min(Number(av.outstanding_balance), remaining);
      const next = round2(Number(av.outstanding_balance) - take);
      await client.query(
        `UPDATE salary_advances
         SET outstanding_balance = $2::numeric,
             status = CASE WHEN $2::numeric <= 0 THEN 'PAID' ELSE status END,
             period_code = $3
         WHERE id = $1`,
        [av.id, next, periodCode]
      );
      await client.query(
        `INSERT INTO advance_repayments
           (company_id, tenant_id, advance_id, payroll_run_id, amount, paid_at, created_by)
         VALUES ($1,$2,$3,$4,$5,now(),$6)`,
        [ctx.companyId, ctx.tenantId, av.id, payrollId, take, ctx.userId ?? null]
      );
      remaining = round2(remaining - take);
    }
  }
  // Close any arrears records that were auto-loaded into this run.
  await client.query(
    `UPDATE payroll_arrears SET status = 'CLOSED' WHERE payroll_id = $1 AND status = 'APPROVED'`,
    [payrollId]
  );
  await logAudit(client, ctx, {
    action: 'post',
    resource: 'payrolls',
    recordId: payrollId,
    recordCode: String(run.rows[0].payroll_no),
    newValues: { journalId, status: 'RELEASED' },
  });
  return { payrollId, journalId, netTotal: Number(run.rows[0].net_total) };
}

export async function listPayrolls(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT id, payroll_no, run_type, off_cycle_type, reason, employee_ids, payment_date, period_start, period_end,
            status, gross_total, deduction_total, net_total, gl_posted, validation_score,
            extra_earnings, extra_deductions, deduct_loans, payroll_group_id
     FROM payrolls WHERE tenant_id = $1 AND company_id = $2
     ORDER BY period_end DESC, id DESC LIMIT 40`,
    [ctx.tenantId, ctx.companyId]
  );
  return res.rows.map((r) => {
    const out = toCamelRow(r);
    out.employeeCount = Array.isArray(r.employee_ids) ? r.employee_ids.length : 0;
    return out;
  });
}

export async function getPayroll(client: pg.PoolClient, ctx: Ctx, payrollId: number) {
  const res = await client.query(`SELECT * FROM payrolls WHERE id = $1 AND tenant_id = $2`, [payrollId, ctx.tenantId]);
  if (res.rows.length === 0) throw notFound('Payroll not found');
  const items = await client.query(
    `SELECT i.*, e.employee_no, e.first_name, e.last_name, e.position
     FROM payroll_items i JOIN employees e ON e.id = i.employee_id
     WHERE i.payroll_id = $1 ORDER BY e.last_name, e.first_name`,
    [payrollId]
  );
  const exceptions = await client.query(
    `SELECT x.id, x.employee_id, x.exception_type, x.severity, x.message, x.status, x.created_at,
            e.employee_no, e.first_name, e.last_name
     FROM payroll_exceptions x LEFT JOIN employees e ON e.id = x.employee_id
     WHERE x.payroll_id = $1
     ORDER BY x.severity DESC, x.created_at DESC, x.id DESC`,
    [payrollId]
  );
  return { payroll: toCamelRow(res.rows[0]), items: toCamelRows(items.rows), exceptions: toCamelRows(exceptions.rows) };
}

export async function hrBoard(client: pg.PoolClient, ctx: Ctx) {
  const kpis = await client.query(
    `SELECT
       (SELECT count(*) FROM employees WHERE tenant_id = $1 AND company_id = $2 AND status IN ('ACTIVE','ON_LEAVE','PROBATION'))::int AS headcount,
       (SELECT count(*) FROM employees WHERE tenant_id = $1 AND company_id = $2 AND status = 'ON_LEAVE')::int AS on_leave,
       (SELECT count(*) FROM leave_requests l JOIN employees e ON e.id = l.employee_id
         WHERE e.tenant_id = $1 AND e.company_id = $2 AND l.status = 'SUBMITTED')::int AS pending_leave,
       (SELECT COALESCE(sum(net_total),0) FROM payrolls
         WHERE tenant_id = $1 AND company_id = $2 AND status IN ('APPROVED','RELEASED','PAID')
           AND period_end >= (CURRENT_DATE - interval '45 days'))::numeric AS last_net,
       (SELECT COALESCE(sum(balance),0) FROM employee_loans ln
         JOIN employees e ON e.id = ln.employee_id
         WHERE e.tenant_id = $1 AND e.company_id = $2 AND ln.status = 'ACTIVE')::numeric AS loan_book,
       (SELECT count(*) FROM employment_contracts ec
         JOIN employees e ON e.id = ec.employee_id
         WHERE e.tenant_id = $1 AND e.company_id = $2
           AND ec.status IN ('EXECUTED','ACTIVE','VARIED','RENEWED')
           AND ec.deleted_at IS NULL)::int AS active_contracts,
       (SELECT count(*) FROM employment_contracts ec
         JOIN employees e ON e.id = ec.employee_id
         WHERE e.tenant_id = $1 AND e.company_id = $2
           AND ec.status IN ('SENT_FOR_SIGNATURE','PARTIALLY_SIGNED')
           AND ec.deleted_at IS NULL)::int AS pending_signature,
       (SELECT count(*) FROM employment_contracts ec
         JOIN employees e ON e.id = ec.employee_id
         WHERE e.tenant_id = $1 AND e.company_id = $2
           AND ec.status IN ('EXECUTED','ACTIVE')
           AND ec.deleted_at IS NULL
           AND ec.end_date IS NOT NULL AND ec.end_date <= (CURRENT_DATE + interval '30 days'))::int AS expiring_contracts`,
    [ctx.tenantId, ctx.companyId]
  );
  const leave = await client.query(
    `SELECT l.id, l.leave_type, l.start_date, l.end_date, l.days, l.status, e.employee_no, e.first_name, e.last_name, e.id AS employee_id
     FROM leave_requests l JOIN employees e ON e.id = l.employee_id
     WHERE e.tenant_id = $1 AND e.company_id = $2 AND l.status = 'SUBMITTED'
     ORDER BY l.start_date LIMIT 8`,
    [ctx.tenantId, ctx.companyId]
  );
  const runs = await client.query(
    `SELECT id, payroll_no, period_start, period_end, status, net_total
     FROM payrolls WHERE tenant_id = $1 AND company_id = $2
     ORDER BY id DESC LIMIT 5`,
    [ctx.tenantId, ctx.companyId]
  );
  const contracts = await client.query(
    `SELECT ec.id, ec.contract_no, ec.contract_type, ec.status, ec.start_date, ec.end_date, ec.version,
            e.first_name, e.last_name, e.employee_no, e.id AS employee_id
     FROM employment_contracts ec
     JOIN employees e ON e.id = ec.employee_id
     WHERE e.tenant_id = $1 AND e.company_id = $2 AND ec.deleted_at IS NULL
     ORDER BY ec.id DESC LIMIT 6`,
    [ctx.tenantId, ctx.companyId]
  );
  return {
    kpis: toCamelRow(kpis.rows[0]),
    pendingLeave: toCamelRows(leave.rows),
    payrolls: toCamelRows(runs.rows),
    contracts: toCamelRows(contracts.rows),
  };
}
