import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, conflict, notFound, parsePagination, toCamelRow, toCamelRows, toISODate } from '../utils.js';
import { logAudit } from './audit.js';

interface RunRow {
  id: number;
  payroll_no: string;
  period_start: string;
  period_end: string;
  run_type: string;
  off_cycle_type: string | null;
  employee_ids: number[] | null;
  payroll_group_id: number | null;
}

interface StaffRow {
  id: number;
  employee_no: string;
  first_name: string;
  last_name: string;
  base_salary: string;
  status: string;
  termination_date: string | null;
  tin: string | null;
  bank_account_no: string | null;
}

interface ValidationCheck {
  employeeId: number | null;
  exceptionType: string;
  severity: 'ERROR' | 'WARNING' | 'HIGH_RISK';
  message: string;
  referenceData?: Record<string, unknown>;
}

/**
 * Loads the same eligible-employee population the calculation engine pays,
 * so validation always judges exactly what a run would pay.
 */
async function loadEligibleStaff(
  client: pg.PoolClient,
  ctx: Ctx,
  run: RunRow
): Promise<StaffRow[]> {
  const periodStart = toISODate(run.period_start) ?? '';
  const isOffCycle = String(run.run_type) === 'OFF_CYCLE';
  const employeeIds = isOffCycle && Array.isArray(run.employee_ids)
    ? run.employee_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const res = isOffCycle
    ? await client.query(
        `SELECT id, employee_no, first_name, last_name, base_salary, status, termination_date, tin, bank_account_no
         FROM employees
         WHERE tenant_id = $1 AND company_id = $2 AND id = ANY($3::bigint[])`,
        [ctx.tenantId, ctx.companyId, employeeIds]
      )
    : await client.query(
        `SELECT e.id, e.employee_no, e.first_name, e.last_name, e.base_salary, e.status, e.termination_date, e.tin, e.bank_account_no
         FROM employees e
         WHERE e.tenant_id = $1 AND e.company_id = $2
           AND e.status IN ('ACTIVE','ON_LEAVE','PROBATION')
           AND (e.termination_date IS NULL OR e.termination_date >= $3)
           ${run.payroll_group_id ? `AND EXISTS (
             SELECT 1 FROM employee_payroll_profiles p
             WHERE p.employee_id = e.id AND p.payroll_group_id = $4
               AND p.tenant_id = e.tenant_id AND p.company_id = e.company_id
           )` : ''}`,
        run.payroll_group_id
          ? [ctx.tenantId, ctx.companyId, periodStart, run.payroll_group_id]
          : [ctx.tenantId, ctx.companyId, periodStart]
      );
  return res.rows as StaffRow[];
}

export interface ValidationResult {
  payrollId: number;
  validationScore: number;
  errors: number;
  warnings: number;
  exceptionCount: number;
  ready: boolean;
}

/**
 * Runs the payroll validation suite for a live run: regenerates the run's
 * exception set from current data, computes the readiness score and persists
 * both. Called automatically at the end of every calculation so a run is
 * never left in a silently inconsistent state.
 */
export async function validatePayroll(
  client: pg.PoolClient,
  ctx: Ctx,
  payrollId: number
): Promise<ValidationResult> {
  const run = await client.query(
    `SELECT id, payroll_no, period_start, period_end, run_type, off_cycle_type, employee_ids, payroll_group_id
     FROM payrolls WHERE id = $1 AND tenant_id = $2`,
    [payrollId, ctx.tenantId]
  );
  if (run.rows.length === 0) throw notFound('Payroll not found');
  const r = run.rows[0] as RunRow;
  const periodStart = toISODate(r.period_start) ?? '';
  const isOffCycle = String(r.run_type) === 'OFF_CYCLE';
  const staff = await loadEligibleStaff(client, ctx, r);

  const checks: ValidationCheck[] = [];
  for (const emp of staff) {
    const baseSalary = Number(emp.base_salary) || 0;
    if (baseSalary <= 0) {
      checks.push({
        employeeId: Number(emp.id),
        exceptionType: 'NO_SALARY',
        severity: 'ERROR',
        message: 'Employee has no salary configured (base salary is zero)',
        referenceData: { baseSalary },
      });
    }
    const terminationDate = emp.termination_date ? String(emp.termination_date).slice(0, 10) : null;
    if (String(emp.status) === 'TERMINATED' || (terminationDate !== null && terminationDate < periodStart)) {
      checks.push({
        employeeId: Number(emp.id),
        exceptionType: 'TERMINATED_INCLUDED',
        severity: 'ERROR',
        message: 'Terminated employee included in payroll run',
        referenceData: { status: emp.status, terminationDate },
      });
    }
    if (!emp.bank_account_no || !String(emp.bank_account_no).trim()) {
      checks.push({
        employeeId: Number(emp.id),
        exceptionType: 'MISSING_BANK_ACCOUNT',
        severity: 'WARNING',
        message: 'Employee has no bank account for payment',
        referenceData: {},
      });
    }
    if (!emp.tin || !String(emp.tin).trim()) {
      checks.push({
        employeeId: Number(emp.id),
        exceptionType: 'MISSING_TAX_PROFILE',
        severity: 'WARNING',
        message: 'Employee has no tax identification (TIN) on file',
        referenceData: {},
      });
    }
  }

  // Group-scoped runs: flag every eligible employee who is not assigned to the
  // run's payroll group (they would be paid outside the group) plus any
  // configuration problem on the group itself.
  if (!isOffCycle && r.payroll_group_id) {
    const grp = await client.query(
      `SELECT id, status FROM payroll_groups WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
      [r.payroll_group_id, ctx.tenantId, ctx.companyId]
    );
    if (grp.rows.length === 0 || String(grp.rows[0].status) !== 'ACTIVE') {
      checks.push({
        employeeId: null,
        exceptionType: 'PAYROLL_GROUP_INACTIVE',
        severity: 'ERROR',
        message: grp.rows.length === 0
          ? 'Payroll group configured on this run no longer exists'
          : 'Payroll group configured on this run is inactive',
        referenceData: { payrollGroupId: r.payroll_group_id },
      });
    }
    const outside = await client.query(
      `SELECT e.id, e.employee_no, e.first_name, e.last_name, p.payroll_group_id
       FROM employees e
       LEFT JOIN employee_payroll_profiles p
         ON p.employee_id = e.id AND p.tenant_id = e.tenant_id AND p.company_id = e.company_id
       WHERE e.tenant_id = $1 AND e.company_id = $2
         AND e.status IN ('ACTIVE','ON_LEAVE','PROBATION')
         AND (e.termination_date IS NULL OR e.termination_date >= $3)
         AND (p.id IS NULL OR p.payroll_group_id IS DISTINCT FROM $4)`,
      [ctx.tenantId, ctx.companyId, periodStart, r.payroll_group_id]
    );
    for (const row of outside.rows) {
      checks.push({
        employeeId: Number(row.id),
        exceptionType: 'PAID_OUTSIDE_PAYROLL_GROUP',
        severity: 'ERROR',
        message: row.payroll_group_id === null
          ? 'Employee has no payroll group assignment for this run'
          : 'Employee is assigned to a different payroll group',
        referenceData: { payrollGroupId: r.payroll_group_id, profileGroupId: row.payroll_group_id },
      });
    }
  }

  const negative = await client.query(
    `SELECT i.employee_id, i.net_pay FROM payroll_items i WHERE i.payroll_id = $1 AND i.net_pay < 0`,
    [payrollId]
  );
  for (const row of negative.rows) {
    checks.push({
      employeeId: Number(row.employee_id),
      exceptionType: 'NEGATIVE_NET_PAY',
      severity: 'ERROR',
      message: 'Net pay is negative after deductions',
      referenceData: { netPay: Number(row.net_pay) },
    });
  }

  // Exceptions are reconciled against the current checks on every validation:
  // OPEN items whose condition no longer applies are removed, acknowledged
  // items (RESOLVED/IGNORED) are preserved as an audit of the decision, and
  // new conditions surface as fresh OPEN items. Stale issues therefore never
  // linger after the underlying data has been corrected, while a reviewer's
  // resolve/ignore decision is not silently discarded by the next validation.
  const existingRes = await client.query(
    `SELECT id, employee_id, exception_type, status FROM payroll_exceptions WHERE payroll_id = $1`,
    [payrollId]
  );
  const existing = existingRes.rows as { id: number; employee_id: number | null; exception_type: string; status: string }[];
  const keyOf = (employeeId: number | null, exceptionType: string) => `${employeeId ?? 'run'}|${exceptionType}`;
  const checkKeys = new Set(checks.map((c) => keyOf(c.employeeId, c.exceptionType)));
  for (const ex of existing) {
    if (
      String(ex.status) === 'OPEN' &&
      !checkKeys.has(keyOf(ex.employee_id === null ? null : Number(ex.employee_id), String(ex.exception_type)))
    ) {
      await client.query(`DELETE FROM payroll_exceptions WHERE id = $1`, [ex.id]);
    }
  }
  const byKey = new Map<string, { id: number; status: string }>();
  for (const ex of existing) {
    byKey.set(keyOf(ex.employee_id === null ? null : Number(ex.employee_id), String(ex.exception_type)), {
      id: Number(ex.id),
      status: String(ex.status),
    });
  }
  for (const ex of checks) {
    const current = byKey.get(keyOf(ex.employeeId, ex.exceptionType));
    if (!current) {
      await client.query(
        `INSERT INTO payroll_exceptions
           (company_id, tenant_id, payroll_id, employee_id, exception_type, severity, message, reference_data, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OPEN')`,
        [ctx.companyId, ctx.tenantId, payrollId, ex.employeeId, ex.exceptionType, ex.severity, ex.message, JSON.stringify(ex.referenceData ?? {})]
      );
    } else if (current.status === 'OPEN') {
      await client.query(
        `UPDATE payroll_exceptions SET severity = $2, message = $3, reference_data = $4 WHERE id = $1`,
        [current.id, ex.severity, ex.message, JSON.stringify(ex.referenceData ?? {})]
      );
    }
    // RESOLVED / IGNORED items are kept untouched as the record of the decision.
  }

  const errors = checks.filter((c) => c.severity === 'ERROR').length;
  const warnings = checks.filter((c) => c.severity === 'WARNING').length;
  const validationScore = Math.max(0, 100 - errors * 25 - warnings * 5);
  await client.query(`UPDATE payrolls SET validation_score = $2 WHERE id = $1`, [payrollId, validationScore]);
  await logAudit(client, ctx, {
    action: 'validate',
    resource: 'payrolls',
    recordId: payrollId,
    recordCode: String(r.payroll_no),
    newValues: { validationScore, errors, warnings, exceptionCount: checks.length },
  });

  return {
    payrollId,
    validationScore,
    errors,
    warnings,
    exceptionCount: checks.length,
    ready: errors === 0,
  };
}

export async function listExceptions(client: pg.PoolClient, ctx: Ctx, payrollId: number) {
  const run = await client.query(`SELECT id FROM payrolls WHERE id = $1 AND tenant_id = $2`, [payrollId, ctx.tenantId]);
  if (run.rows.length === 0) throw notFound('Payroll not found');
  const res = await client.query(
    `SELECT x.id, x.employee_id, x.exception_type, x.severity, x.message, x.reference_data, x.status,
            x.resolved_by, x.resolved_at, x.resolution_note, x.created_at,
            e.employee_no, e.first_name, e.last_name, e.position
     FROM payroll_exceptions x
     LEFT JOIN employees e ON e.id = x.employee_id
     WHERE x.payroll_id = $1
     ORDER BY CASE x.severity WHEN 'ERROR' THEN 0 WHEN 'HIGH_RISK' THEN 1 ELSE 2 END, x.created_at DESC, x.id DESC`,
    [payrollId]
  );
  return toCamelRows(res.rows);
}

export interface ExceptionCentreQuery {
  status?: string;
  severity?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Cross-run exception centre: tenant/company-scoped view of every payroll
 * exception regardless of which run it belongs to, with summary counts, a
 * paginated filterable row set, and the most common exception types.
 */
export async function exceptionCentre(client: pg.PoolClient, ctx: Ctx, query: ExceptionCentreQuery) {
  const { page, pageSize, offset } = parsePagination({ page: query.page, pageSize: query.pageSize });
  const status = query.status && String(query.status).trim() ? String(query.status).trim().toUpperCase() : null;
  const severity = query.severity && String(query.severity).trim() ? String(query.severity).trim().toUpperCase() : null;
  const q = query.q && String(query.q).trim() ? `%${String(query.q).trim()}%` : null;
  if (status && !['OPEN', 'RESOLVED', 'IGNORED'].includes(status)) {
    throw badRequest('status must be OPEN, RESOLVED or IGNORED');
  }
  if (severity && !['WARNING', 'ERROR', 'HIGH_RISK'].includes(severity)) {
    throw badRequest('severity must be WARNING, ERROR or HIGH_RISK');
  }

  const summary = await client.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'OPEN')::int AS open,
            count(*) FILTER (WHERE status = 'RESOLVED')::int AS resolved,
            count(*) FILTER (WHERE status = 'IGNORED')::int AS ignored,
            count(*) FILTER (WHERE status = 'OPEN' AND severity = 'ERROR')::int AS open_errors,
            count(*) FILTER (WHERE status = 'OPEN' AND severity = 'WARNING')::int AS open_warnings
     FROM payroll_exceptions
     WHERE tenant_id = $1 AND company_id = $2`,
    [ctx.tenantId, ctx.companyId]
  );

  const rows = await client.query(
    `SELECT x.id, x.payroll_id, x.employee_id, x.exception_type, x.severity, x.message,
            x.status, x.resolved_by, x.resolved_at, x.resolution_note, x.created_at,
            p.payroll_no, p.period_start, p.period_end, p.status AS payroll_status,
            e.employee_no, e.first_name, e.last_name, e.position
     FROM payroll_exceptions x
     JOIN payrolls p ON p.id = x.payroll_id AND p.tenant_id = x.tenant_id AND p.company_id = x.company_id
     LEFT JOIN employees e ON e.id = x.employee_id AND e.tenant_id = x.tenant_id AND e.company_id = x.company_id
     WHERE x.tenant_id = $1 AND x.company_id = $2
       AND ($3::text IS NULL OR x.status = $3)
       AND ($4::text IS NULL OR x.severity = $4)
       AND ($5::text IS NULL OR x.message ILIKE $5 OR p.payroll_no ILIKE $5
            OR e.first_name ILIKE $5 OR e.last_name ILIKE $5 OR e.employee_no ILIKE $5)
     ORDER BY CASE x.severity WHEN 'ERROR' THEN 0 WHEN 'HIGH_RISK' THEN 1 ELSE 2 END, x.created_at DESC, x.id DESC
     LIMIT $6 OFFSET $7`,
    [ctx.tenantId, ctx.companyId, status, severity, q, pageSize, offset]
  );

  const topTypes = await client.query(
    `SELECT exception_type, count(*)::int AS count,
            count(*) FILTER (WHERE status = 'OPEN')::int AS open,
            count(*) FILTER (WHERE status = 'OPEN' AND severity = 'ERROR')::int AS open_errors
     FROM payroll_exceptions
     WHERE tenant_id = $1 AND company_id = $2
     GROUP BY exception_type
     ORDER BY open_errors DESC, count DESC, exception_type ASC
     LIMIT 8`,
    [ctx.tenantId, ctx.companyId]
  );

  return {
    summary: toCamelRow(summary.rows[0] ?? {}),
    rows: toCamelRows(rows.rows),
    topTypes: toCamelRows(topTypes.rows),
    page,
    pageSize,
    totalCount: Number(summary.rows[0]?.total) || 0,
  };
}

export interface ResolveExceptionResult {
  exceptionId: number;
  status: string;
  resolvedBy: number;
  resolvedAt: string;
  resolutionNote: string | null;
  validation: ValidationResult;
}

/**
 * Marks an open exception RESOLVED or IGNORED with a note, guards against
 * tampering with runs that are no longer in progress, writes an immutable
 * audit record, and refreshes the owning run's validation score.
 */
export async function resolveException(
  client: pg.PoolClient,
  ctx: Ctx,
  exceptionId: number,
  status: string,
  note?: string
): Promise<ResolveExceptionResult> {
  const target = String(status).toUpperCase();
  if (!['RESOLVED', 'IGNORED'].includes(target)) throw badRequest('Resolution status must be RESOLVED or IGNORED');

  const res = await client.query(
    `SELECT x.id, x.payroll_id, x.employee_id, x.exception_type, x.severity, x.status,
            p.payroll_no, p.status AS payroll_status
     FROM payroll_exceptions x
     JOIN payrolls p ON p.id = x.payroll_id AND p.tenant_id = x.tenant_id AND p.company_id = x.company_id
     WHERE x.id = $1 AND x.tenant_id = $2 AND x.company_id = $3`,
    [exceptionId, ctx.tenantId, ctx.companyId]
  );
  if (res.rows.length === 0) throw notFound('Exception not found');
  const row = res.rows[0] as {
    payroll_id: string;
    employee_id: string | null;
    exception_type: string;
    severity: string;
    status: string;
    payroll_no: string;
    payroll_status: string;
  };
  if (String(row.status) !== 'OPEN') throw badRequest('This exception is already resolved or ignored');
  if (!['DRAFT', 'SUBMITTED'].includes(String(row.payroll_status))) {
    throw badRequest('Cannot resolve exceptions on a payroll run that is no longer in progress');
  }

  const updated = await client.query(
    `UPDATE payroll_exceptions
     SET status = $1, resolved_by = $2, resolved_at = now(), resolution_note = $3
     WHERE id = $4 AND tenant_id = $5 AND company_id = $6 AND status = 'OPEN'
     RETURNING id, status, resolved_by, resolved_at, resolution_note`,
    [target, ctx.userId, note ?? null, exceptionId, ctx.tenantId, ctx.companyId]
  );
  if (updated.rows.length === 0) throw conflict('Exception was concurrently resolved');

  await logAudit(client, ctx, {
    action: 'resolve-exception',
    resource: 'payroll_exceptions',
    recordId: exceptionId,
    recordCode: String(row.payroll_no),
    oldValues: { status: 'OPEN' },
    newValues: { status: target, note: note ?? null },
    metadata: {
      payrollId: Number(row.payroll_id),
      employeeId: row.employee_id !== null ? Number(row.employee_id) : null,
      exceptionType: String(row.exception_type),
      severity: String(row.severity),
    },
  });

  // Refresh the run's readiness score now the reviewer has acted.
  const validation = await validatePayroll(client, ctx, Number(row.payroll_id));

  return {
    exceptionId,
    status: target,
    resolvedBy: Number(updated.rows[0].resolved_by),
    resolvedAt: String(updated.rows[0].resolved_at),
    resolutionNote: note ?? null,
    validation,
  };
}

export async function countOpenErrors(client: pg.PoolClient, payrollId: number): Promise<number> {
  const res = await client.query(
    `SELECT count(*)::int AS n FROM payroll_exceptions
     WHERE payroll_id = $1 AND severity = 'ERROR' AND status = 'OPEN'`,
    [payrollId]
  );
  return Number(res.rows[0].n) || 0;
}
