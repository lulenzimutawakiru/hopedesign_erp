import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { logAudit } from './audit.js';

/**
 * Odoo "Time Off" parity — the configuration screens that already exist in the
 * schema (migration 0023) but are only reachable through the generic record
 * registry (or not at all):
 *
 *  - Time Off Types   (leave_types)            — the leave categories HR configures
 *  - Accrual Plans    (leave_policies + rules) — entitlement accrual configuration
 *  - Allocations      (leave_balances.adjusted)— manual grants / revocations
 *  - Public Holidays  (holidays)               — the holiday calendar
 *
 * Leave requests / balances / the calendar were already first-class screens;
 * these four were the gaps.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const text = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
};
const isDate = (v: unknown): boolean => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));

const LEAVE_CATEGORIES = ['ANNUAL', 'SICK', 'MATERNITY', 'PATERNITY', 'UNPAID', 'STUDY', 'COMPASSIONATE', 'BEREAVEMENT', 'PUBLIC', 'OTHER'];
const ACCRUAL_METHODS = ['MONTHLY_PROPORTION', 'YEARLY_LUMP', 'PER_DAY_WORKED', 'NONE'];
const APPLIES_TO = ['ALL', 'FULL_TIME', 'PART_TIME', 'PROBATION', 'CONTRACT'];
const RULE_TYPES = ['MONTHLY_PROPORTION', 'YEARLY_LUMP', 'PER_DAY_WORKED'];

// ---------------------------------------------------------------------------
// Time Off Types (leave_types)
// ---------------------------------------------------------------------------

export async function listLeaveTypes(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; status?: string } = {}
) {
  const where = ['tenant_id = $1', 'company_id = $2'];
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  if (filters.status) { params.push(filters.status); where.push(`status = $${params.length}`); }
  if (filters.q?.trim()) { params.push('%' + filters.q.trim() + '%'); where.push(`(code ILIKE $${params.length} OR name ILIKE $${params.length})`); }
  const res = await client.query(
    `SELECT * FROM leave_types WHERE ${where.join(' AND ')} ORDER BY code`,
    params
  );
  return toCamelRows(res.rows);
}

export async function createLeaveType(client: pg.PoolClient, ctx: Ctx, input: Record<string, unknown>) {
  const code = text(input.code);
  const name = text(input.name);
  const category = (text(input.category) ?? 'OTHER').toUpperCase();
  if (!code) throw badRequest('code is required');
  if (!name) throw badRequest('name is required');
  if (!LEAVE_CATEGORIES.includes(category)) throw badRequest(`category must be one of ${LEAVE_CATEGORIES.join(', ')}`);
  const status = text(input.status) ?? 'ACTIVE';
  if (!['ACTIVE', 'INACTIVE'].includes(status)) throw badRequest('status must be ACTIVE or INACTIVE');

  let res: pg.QueryResult;
  try {
    res = await client.query(
      `INSERT INTO leave_types
         (company_id, tenant_id, code, name, category, days_per_year, max_consecutive_days, carryover_limit, is_paid, requires_approval, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        ctx.companyId, ctx.tenantId, code, name, category,
        input.daysPerYear == null ? null : num(input.daysPerYear),
        input.maxConsecutiveDays == null ? null : num(input.maxConsecutiveDays),
        input.carryoverLimit == null ? 0 : num(input.carryoverLimit),
        input.isPaid !== false,
        input.requiresApproval !== false,
        status,
      ]
    );
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === '23505') throw badRequest('A leave type with this code already exists');
    throw e;
  }
  const row = res.rows[0];
  await logAudit(client, ctx, { action: 'create', resource: 'leave_types', recordId: Number(row.id), recordCode: String(row.code), newValues: { code, name, category } });
  return toCamelRow(row);
}

export async function updateLeaveType(client: pg.PoolClient, ctx: Ctx, id: number, input: Record<string, unknown>) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const add = (col: string, v: unknown) => { sets.push(`${col} = $${vals.length + 1}`); vals.push(v); };

  if ('name' in input) add('name', text(input.name));
  if ('category' in input) {
    const c = (text(input.category) ?? '').toUpperCase();
    if (!LEAVE_CATEGORIES.includes(c)) throw badRequest(`category must be one of ${LEAVE_CATEGORIES.join(', ')}`);
    add('category', c);
  }
  if ('daysPerYear' in input) add('days_per_year', input.daysPerYear == null ? null : num(input.daysPerYear));
  if ('maxConsecutiveDays' in input) add('max_consecutive_days', input.maxConsecutiveDays == null ? null : num(input.maxConsecutiveDays));
  if ('carryoverLimit' in input) add('carryover_limit', input.carryoverLimit == null ? 0 : num(input.carryoverLimit));
  if ('isPaid' in input) add('is_paid', !!input.isPaid);
  if ('requiresApproval' in input) add('requires_approval', !!input.requiresApproval);
  if ('status' in input) {
    const s = text(input.status);
    if (!s || !['ACTIVE', 'INACTIVE'].includes(s)) throw badRequest('status must be ACTIVE or INACTIVE');
    add('status', s);
  }

  if (!sets.length) throw badRequest('No fields to update');
  let res: pg.QueryResult;
  try {
    res = await client.query(
      `UPDATE leave_types SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $${vals.length + 1} AND tenant_id = $${vals.length + 2} AND company_id = $${vals.length + 3} RETURNING *`,
      [...vals, id, ctx.tenantId, ctx.companyId]
    );
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === '23505') throw badRequest('A leave type with this code already exists');
    throw e;
  }
  if (res.rowCount === 0) throw notFound('Leave type not found');
  await logAudit(client, ctx, { action: 'update', resource: 'leave_types', recordId: id, newValues: input });
  return toCamelRow(res.rows[0]);
}

// ---------------------------------------------------------------------------
// Accrual Plans (leave_policies + leave_accrual_rules)
// ---------------------------------------------------------------------------

export async function listLeavePolicies(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { q?: string; status?: string } = {}
) {
  const where = ['lp.tenant_id = $1', 'lp.company_id = $2'];
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  if (filters.status) { params.push(filters.status); where.push(`lp.status = $${params.length}`); }
  if (filters.q?.trim()) { params.push('%' + filters.q.trim() + '%'); where.push(`(lp.code ILIKE $${params.length} OR lp.name ILIKE $${params.length} OR lt.name ILIKE $${params.length})`); }
  const res = await client.query(
    `SELECT lp.*, lt.code AS leave_type_code, lt.name AS leave_type_name,
            lr.id AS rule_id, lr.rule_type, lr.accrual_rate, lr.cap, lr.minimum_service_days
       FROM leave_policies lp
       LEFT JOIN leave_types lt ON lt.id = lp.leave_type_id
       LEFT JOIN leave_accrual_rules lr ON lr.policy_id = lp.id
      WHERE ${where.join(' AND ')} ORDER BY lp.code`,
    params
  );
  return toCamelRows(res.rows);
}

export async function createLeavePolicy(client: pg.PoolClient, ctx: Ctx, input: Record<string, unknown>) {
  const code = text(input.code);
  const name = text(input.name);
  if (!code) throw badRequest('code is required');
  if (!name) throw badRequest('name is required');
  const leaveTypeId = input.leaveTypeId == null ? null : num(input.leaveTypeId);
  const appliesTo = (text(input.appliesTo) ?? 'ALL').toUpperCase();
  if (!APPLIES_TO.includes(appliesTo)) throw badRequest(`appliesTo must be one of ${APPLIES_TO.join(', ')}`);
  const accrualMethod = (text(input.accrualMethod) ?? 'MONTHLY_PROPORTION').toUpperCase();
  if (!ACCRUAL_METHODS.includes(accrualMethod)) throw badRequest(`accrualMethod must be one of ${ACCRUAL_METHODS.join(', ')}`);
  const effectiveFrom = text(input.effectiveFrom);
  if (!effectiveFrom || !isDate(effectiveFrom)) throw badRequest('effectiveFrom is required and must be a YYYY-MM-DD date');
  const effectiveTo = text(input.effectiveTo);
  if (effectiveTo && !isDate(effectiveTo)) throw badRequest('effectiveTo must be a YYYY-MM-DD date');
  const status = text(input.status) ?? 'ACTIVE';
  if (!['ACTIVE', 'INACTIVE'].includes(status)) throw badRequest('status must be ACTIVE or INACTIVE');

  let res: pg.QueryResult;
  try {
    res = await client.query(
      `INSERT INTO leave_policies
         (company_id, tenant_id, code, name, leave_type_id, applies_to, accrual_method, effective_from, effective_to, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10) RETURNING *`,
      [ctx.companyId, ctx.tenantId, code, name, leaveTypeId, appliesTo, accrualMethod, effectiveFrom, effectiveTo ?? null, status]
    );
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === '23505') throw badRequest('A policy with this code already exists');
    throw e;
  }
  const policyId = Number(res.rows[0].id);

  // One accrual rule per policy (matches how the engine resolves rules).
  if (input.accrualRate != null || input.ruleType != null) {
    const ruleType = (text(input.ruleType) ?? accrualMethod).toUpperCase();
    if (!RULE_TYPES.includes(ruleType)) throw badRequest(`ruleType must be one of ${RULE_TYPES.join(', ')}`);
    await client.query(
      `INSERT INTO leave_accrual_rules (company_id, tenant_id, policy_id, rule_type, accrual_rate, cap, minimum_service_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        ctx.companyId, ctx.tenantId, policyId, ruleType,
        input.accrualRate == null ? 0 : num(input.accrualRate),
        input.cap == null ? null : num(input.cap),
        input.minimumServiceDays == null ? 0 : num(input.minimumServiceDays),
      ]
    );
  }

  await logAudit(client, ctx, { action: 'create', resource: 'leave_policies', recordId: policyId, recordCode: String(res.rows[0].code), newValues: { code, name, accrualMethod } });
  return toCamelRow(res.rows[0]);
}

export async function updateLeavePolicy(client: pg.PoolClient, ctx: Ctx, id: number, input: Record<string, unknown>) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const add = (col: string, v: unknown) => { sets.push(`${col} = $${vals.length + 1}`); vals.push(v); };

  if ('name' in input) add('name', text(input.name));
  if ('leaveTypeId' in input) add('leave_type_id', input.leaveTypeId == null ? null : num(input.leaveTypeId));
  if ('appliesTo' in input) {
    const a = (text(input.appliesTo) ?? '').toUpperCase();
    if (!APPLIES_TO.includes(a)) throw badRequest(`appliesTo must be one of ${APPLIES_TO.join(', ')}`);
    add('applies_to', a);
  }
  if ('accrualMethod' in input) {
    const m = (text(input.accrualMethod) ?? '').toUpperCase();
    if (!ACCRUAL_METHODS.includes(m)) throw badRequest(`accrualMethod must be one of ${ACCRUAL_METHODS.join(', ')}`);
    add('accrual_method', m);
  }
  if ('effectiveFrom' in input) {
    const d = text(input.effectiveFrom);
    if (d && !isDate(d)) throw badRequest('effectiveFrom must be a YYYY-MM-DD date');
    add('effective_from', d ?? null);
  }
  if ('effectiveTo' in input) {
    const d = text(input.effectiveTo);
    if (d && !isDate(d)) throw badRequest('effectiveTo must be a YYYY-MM-DD date');
    add('effective_to', d ?? null);
  }
  if ('status' in input) {
    const s = text(input.status);
    if (!s || !['ACTIVE', 'INACTIVE'].includes(s)) throw badRequest('status must be ACTIVE or INACTIVE');
    add('status', s);
  }

  if (!sets.length) throw badRequest('No fields to update');
  let res: pg.QueryResult;
  try {
    res = await client.query(
      `UPDATE leave_policies SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $${vals.length + 1} AND tenant_id = $${vals.length + 2} AND company_id = $${vals.length + 3} RETURNING *`,
      [...vals, id, ctx.tenantId, ctx.companyId]
    );
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === '23505') throw badRequest('A policy with this code already exists');
    throw e;
  }
  if (res.rowCount === 0) throw notFound('Policy not found');

  // Upsert the single accrual rule.
  if (input.accrualRate != null || input.ruleType != null || input.cap != null || input.minimumServiceDays != null) {
    const existing = await client.query(
      `SELECT id FROM leave_accrual_rules WHERE policy_id = $1 AND tenant_id = $2 AND company_id = $3`,
      [id, ctx.tenantId, ctx.companyId]
    );
    const ruleType = (text(input.ruleType) ?? 'MONTHLY_PROPORTION').toUpperCase();
    if (!RULE_TYPES.includes(ruleType)) throw badRequest(`ruleType must be one of ${RULE_TYPES.join(', ')}`);
    if (existing.rows.length) {
      await client.query(
        `UPDATE leave_accrual_rules SET rule_type=$2, accrual_rate=$3, cap=$4, minimum_service_days=$5, updated_at=now()
         WHERE id = $1`,
        [
          Number(existing.rows[0].id), ruleType,
          input.accrualRate == null ? 0 : num(input.accrualRate),
          input.cap == null ? null : num(input.cap),
          input.minimumServiceDays == null ? 0 : num(input.minimumServiceDays),
        ]
      );
    } else {
      await client.query(
        `INSERT INTO leave_accrual_rules (company_id, tenant_id, policy_id, rule_type, accrual_rate, cap, minimum_service_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          ctx.companyId, ctx.tenantId, id, ruleType,
          input.accrualRate == null ? 0 : num(input.accrualRate),
          input.cap == null ? null : num(input.cap),
          input.minimumServiceDays == null ? 0 : num(input.minimumServiceDays),
        ]
      );
    }
  }

  await logAudit(client, ctx, { action: 'update', resource: 'leave_policies', recordId: id, newValues: input });
  return toCamelRow(res.rows[0]);
}

// ---------------------------------------------------------------------------
// Allocations (manual grant / revoke on leave_balances.adjusted)
// ---------------------------------------------------------------------------

export async function allocateLeave(client: pg.PoolClient, ctx: Ctx, input: Record<string, unknown>) {
  const employeeId = num(input.employeeId);
  const leaveTypeId = num(input.leaveTypeId);
  const year = num(input.year) || new Date().getUTCFullYear();
  const days = Number(input.days);
  if (!employeeId) throw badRequest('employeeId is required');
  if (!leaveTypeId) throw badRequest('leaveTypeId is required');
  if (!Number.isFinite(days) || days === 0) throw badRequest('days is required and cannot be zero');
  const note = text(input.note);

  const existing = await client.query(
    `SELECT * FROM leave_balances
     WHERE tenant_id = $1 AND company_id = $2 AND employee_id = $3 AND leave_type_id = $4 AND year = $5`,
    [ctx.tenantId, ctx.companyId, employeeId, leaveTypeId, year]
  );

  let row: Record<string, unknown>;
  if (existing.rows.length) {
    const cur = existing.rows[0];
    const adjusted = round2(Number(cur.adjusted ?? 0) + days);
    const available = round2(Number(cur.opening_balance ?? 0) + Number(cur.accrued ?? 0) - Number(cur.used ?? 0) + adjusted);
    const res = await client.query(
      `UPDATE leave_balances SET adjusted = $2, available = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [Number(cur.id), adjusted, available]
    );
    row = res.rows[0];
  } else {
    const adjusted = round2(days);
    const available = adjusted;
    const res = await client.query(
      `INSERT INTO leave_balances
         (company_id, tenant_id, employee_id, leave_type_id, year, opening_balance, accrued, used, adjusted, available)
       VALUES ($1,$2,$3,$4,$5,0,0,0,$6,$7) RETURNING *`,
      [ctx.companyId, ctx.tenantId, employeeId, leaveTypeId, year, adjusted, available]
    );
    row = res.rows[0];
  }

  await logAudit(client, ctx, { action: 'allocate', resource: 'leave_balances', recordId: Number(row.id), newValues: { employeeId, leaveTypeId, year, days, note } });
  return { ...toCamelRow(row), note };
}

// ---------------------------------------------------------------------------
// Public Holidays (holidays)
// ---------------------------------------------------------------------------

export async function listHolidays(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { year?: number; q?: string } = {}
) {
  const where = ['tenant_id = $1', 'company_id = $2'];
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  if (filters.year) {
    params.push(filters.year);
    where.push(`(EXTRACT(YEAR FROM holiday_date) = $${params.length} OR is_recurring)`);
  }
  if (filters.q?.trim()) { params.push('%' + filters.q.trim() + '%'); where.push(`name ILIKE $${params.length}`); }
  const res = await client.query(
    `SELECT * FROM holidays WHERE ${where.join(' AND ')} ORDER BY is_recurring DESC, holiday_date`,
    params
  );
  return toCamelRows(res.rows);
}

export async function createHoliday(client: pg.PoolClient, ctx: Ctx, input: Record<string, unknown>) {
  const name = text(input.name);
  const holidayDate = text(input.holidayDate);
  if (!name) throw badRequest('name is required');
  if (!holidayDate || !isDate(holidayDate)) throw badRequest('holidayDate is required and must be a YYYY-MM-DD date');
  const isRecurring = !!input.isRecurring;
  const country = text(input.country) ?? 'UG';

  const res = await client.query(
    `INSERT INTO holidays (company_id, tenant_id, name, holiday_date, is_recurring, country)
     VALUES ($1,$2,$3,$4::date,$5,$6) RETURNING *`,
    [ctx.companyId, ctx.tenantId, name, holidayDate, isRecurring, country]
  );
  const row = res.rows[0];
  await logAudit(client, ctx, { action: 'create', resource: 'holidays', recordId: Number(row.id), recordCode: String(row.name), newValues: { name, holidayDate, isRecurring, country } });
  return toCamelRow(row);
}

export async function updateHoliday(client: pg.PoolClient, ctx: Ctx, id: number, input: Record<string, unknown>) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const add = (col: string, v: unknown) => { sets.push(`${col} = $${vals.length + 1}`); vals.push(v); };

  if ('name' in input) add('name', text(input.name));
  if ('holidayDate' in input) {
    const d = text(input.holidayDate);
    if (d && !isDate(d)) throw badRequest('holidayDate must be a YYYY-MM-DD date');
    add('holiday_date', d ?? null);
  }
  if ('isRecurring' in input) add('is_recurring', !!input.isRecurring);
  if ('country' in input) add('country', text(input.country) ?? 'UG');

  if (!sets.length) throw badRequest('No fields to update');
  const res = await client.query(
    `UPDATE holidays SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${vals.length + 1} AND tenant_id = $${vals.length + 2} AND company_id = $${vals.length + 3} RETURNING *`,
    [...vals, id, ctx.tenantId, ctx.companyId]
  );
  if (res.rowCount === 0) throw notFound('Holiday not found');
  await logAudit(client, ctx, { action: 'update', resource: 'holidays', recordId: id, newValues: input });
  return toCamelRow(res.rows[0]);
}

export async function deleteHoliday(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `DELETE FROM holidays WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [id, ctx.tenantId, ctx.companyId]
  );
  if (res.rowCount === 0) throw notFound('Holiday not found');
  await logAudit(client, ctx, { action: 'delete', resource: 'holidays', recordId: id });
  return { id };
}
