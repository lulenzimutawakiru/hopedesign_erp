import pg from 'pg';
import {
  Ctx,
  s,
  n,
  nn,
  truthy,
  oneOf,
  strList,
  uniq,
  hasPerm,
  paged,
  requireRow,
  resolveScope,
  logAudit,
  forbidden,
  badRequest,
  conflict,
  notFound,
  parsePagination,
} from './serviceDeskCommon.js';

/**
 * HOPE DESIGN Service Desk - configuration surface (spec 7, 10, 17).
 *
 * SLA policies, business calendars and holidays, teams, skills and the
 * skill routing tables. These are the knobs an administrator turns to make the
 * rest of the Service Desk behave; every write is audited and every write
 * requires an explicit permission, because a mis-set SLA silently changes the
 * contractual promise made to the rest of the business.
 */

export const SLA_TIME_BASES = ['CALENDAR', 'BUSINESS'] as const;
export const SLA_PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export const SKILL_PROFICIENCY_MIN = 1;
export const SKILL_PROFICIENCY_MAX = 5;
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

const isAdminScope = (scope: { permissions: string[]; isAdmin: boolean }): boolean =>
  scope.isAdmin || hasPerm(scope.permissions, 'service_desk.admin');

// ---------------------------------------------------------------- SLA policies

export interface ListSlaPoliciesQuery extends Record<string, unknown> {
  search?: string;
}

function slaMinutes(v: unknown, label: string): number {
  const x = n(v);
  if (x === undefined || !Number.isFinite(x) || x <= 0) throw badRequest(`${label} must be a positive number of minutes`);
  return Math.round(x);
}

/** Every SLA policy that can match this company, widest scope last. */
export async function listSlaPolicies(client: pg.PoolClient, ctx: Ctx, q: ListSlaPoliciesQuery = {}) {
  const scope = await resolveScope(client, ctx);
  if (!hasPerm(scope.permissions, 'service_desk.sla.view') && !isAdminScope(scope)) {
    throw forbidden('You cannot view SLA policies');
  }
  const where: string[] = ['p.tenant_id = $1', 'p.company_id = $2'];
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const term = s(q.search);
  if (term) {
    params.push('%' + term + '%');
    where.push('(p.code ILIKE $' + String(params.length) + ' OR p.name ILIKE $' + String(params.length) + ')');
  }
  if (q.priority !== undefined && String(q.priority) !== '') {
    const p = oneOf(q.priority, SLA_PRIORITIES);
    if (!p) throw badRequest('priority must be one of P1, P2, P3, P4');
    params.push(p);
    where.push('p.priority = $' + String(params.length));
  }
  if (!truthy(q.includeInactive)) where.push('p.is_active');
  const res = await client.query(
    'SELECT p.*, cal.code AS calendar_code, cal.name AS calendar_name, cal.timezone AS calendar_timezone, ' +
      'c.name AS category_name, d.name AS department_name ' +
      'FROM sla_policies p ' +
      'LEFT JOIN service_business_calendars cal ON cal.id = p.calendar_id ' +
      'LEFT JOIN service_categories c ON c.id = p.category_id ' +
      'LEFT JOIN departments d ON d.id = p.department_id ' +
      'WHERE ' + where.join(' AND ') + ' ORDER BY p.priority, p.response_minutes, p.id',
    params
  );
  return { rows: res.rows, count: res.rows.length };
}

export async function createSlaPolicy(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown> = {}) {
  const scope = await resolveScope(client, ctx);
  if (!hasPerm(scope.permissions, 'service_desk.sla.manage') && !isAdminScope(scope)) {
    throw forbidden('You cannot manage SLA policies');
  }
  const code = s(b.code);
  const name = s(b.name);
  if (!code) throw badRequest('SLA policy code is required');
  if (!name) throw badRequest('SLA policy name is required');
  const priority = b.priority === undefined || b.priority === null || b.priority === '' ? null : oneOf(b.priority, SLA_PRIORITIES);
  if (b.priority !== undefined && b.priority !== null && b.priority !== '' && !priority) {
    throw badRequest('priority must be one of P1, P2, P3, P4');
  }
  const timeBasis = b.timeBasis === undefined ? 'CALENDAR' : oneOf(b.timeBasis, SLA_TIME_BASES);
  if (!timeBasis) throw badRequest('timeBasis must be CALENDAR or BUSINESS');

  const dup = await client.query('SELECT 1 FROM sla_policies WHERE company_id = $1 AND code = $2', [ctx.companyId, code]);
  if (dup.rows.length > 0) throw conflict('An SLA policy with that code already exists');

  const categoryId = nn(b.categoryId);
  if (categoryId) {
    const cat = await client.query('SELECT 1 FROM service_categories WHERE id = $1 AND tenant_id = $2 AND company_id = $3', [
      categoryId,
      ctx.tenantId,
      ctx.companyId,
    ]);
    if (cat.rows.length === 0) throw badRequest('Category not found');
  }

  const res = await client.query(
    'INSERT INTO sla_policies ' +
      '(tenant_id, company_id, branch_id, code, name, description, category_id, priority, department_id, ticket_type, ' +
      'calendar_id, response_minutes, resolution_minutes, pause_on_pending, warning_minutes, escalation_enabled, ' +
      'time_basis, is_active, created_by, updated_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19) RETURNING *',
    [
      ctx.tenantId, ctx.companyId, nn(b.branchId), code, name, s(b.description) ?? null, categoryId, priority,
      nn(b.departmentId), s(b.ticketType) ?? null, nn(b.calendarId),
      slaMinutes(b.responseMinutes, 'responseMinutes'), slaMinutes(b.resolutionMinutes, 'resolutionMinutes'),
      b.pauseOnPending === undefined ? true : truthy(b.pauseOnPending),
      n(b.warningMinutes) === undefined ? 30 : Math.max(0, Math.round(Number(n(b.warningMinutes)))),
      b.escalationEnabled === undefined ? true : truthy(b.escalationEnabled),
      timeBasis, b.isActive === undefined ? true : truthy(b.isActive), ctx.userId ?? null,
    ]
  );
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'service_desk.sla',
    recordId: Number(res.rows[0].id),
    recordCode: code,
    newValues: { code, name, priority, responseMinutes: n(b.responseMinutes), resolutionMinutes: n(b.resolutionMinutes), timeBasis },
  });
  return res.rows[0];
}

export async function updateSlaPolicy(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown> = {}) {
  const scope = await resolveScope(client, ctx);
  if (!hasPerm(scope.permissions, 'service_desk.sla.manage') && !isAdminScope(scope)) {
    throw forbidden('You cannot manage SLA policies');
  }
  const before = requireRow(
    (await client.query('SELECT * FROM sla_policies WHERE id = $1 AND tenant_id = $2 AND company_id = $3', [id, ctx.tenantId, ctx.companyId])).rows[0],
    'SLA policy not found'
  );
  const sets: string[] = [];
  const params: unknown[] = [id, ctx.tenantId, ctx.companyId];
  const set = (col: string, value: unknown) => {
    params.push(value);
    sets.push(col + ' = $' + String(params.length));
  };
  if (b.name !== undefined) set('name', s(b.name) ?? before.name);
  if (b.description !== undefined) set('description', s(b.description) ?? null);
  if (b.priority !== undefined) {
    const p = b.priority === null || b.priority === '' ? null : oneOf(b.priority, SLA_PRIORITIES);
    if (b.priority !== null && b.priority !== '' && !p) throw badRequest('priority must be one of P1, P2, P3, P4');
    set('priority', p);
  }
  if (b.categoryId !== undefined) set('category_id', nn(b.categoryId));
  if (b.departmentId !== undefined) set('department_id', nn(b.departmentId));
  if (b.branchId !== undefined) set('branch_id', nn(b.branchId));
  if (b.calendarId !== undefined) set('calendar_id', nn(b.calendarId));
  if (b.ticketType !== undefined) set('ticket_type', s(b.ticketType) ?? null);
  if (b.responseMinutes !== undefined) set('response_minutes', slaMinutes(b.responseMinutes, 'responseMinutes'));
  if (b.resolutionMinutes !== undefined) set('resolution_minutes', slaMinutes(b.resolutionMinutes, 'resolutionMinutes'));
  if (b.pauseOnPending !== undefined) set('pause_on_pending', truthy(b.pauseOnPending));
  if (b.escalationEnabled !== undefined) set('escalation_enabled', truthy(b.escalationEnabled));
  if (b.warningMinutes !== undefined) {
    const w = n(b.warningMinutes);
    set('warning_minutes', w === undefined ? 30 : Math.max(0, Math.round(w)));
  }
  if (b.timeBasis !== undefined) {
    const tb = oneOf(b.timeBasis, SLA_TIME_BASES);
    if (!tb) throw badRequest('timeBasis must be CALENDAR or BUSINESS');
    set('time_basis', tb);
  }
  if (b.isActive !== undefined) set('is_active', truthy(b.isActive));
  if (sets.length === 0) throw badRequest('No supported fields were supplied');
  params.push(ctx.userId ?? null);
  sets.push('updated_by = $' + String(params.length));
  sets.push('updated_at = now()');
  const res = await client.query(
    'UPDATE sla_policies SET ' + sets.join(', ') + ' WHERE id = $1 AND tenant_id = $2 AND company_id = $3 RETURNING *',
    params
  );
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'service_desk.sla',
    recordId: id,
    recordCode: before.code,
    oldValues: before,
    newValues: res.rows[0],
  });
  return res.rows[0];
}

// ------------------------------------------------------------ business hours

const normaliseWorkingDays = (v: unknown): number[] | undefined => {
  if (v === undefined) return undefined;
  const raw = Array.isArray(v) ? v : strList(v);
  if (!raw) return [];
  const days = uniq(
    (raw as unknown[])
      .map((x) => Number(x))
      .filter((x) => Number.isInteger(x) && WEEKDAYS.includes(x))
  );
  return days.sort((a, b) => a - b);
};

const timeOf = (v: unknown, label: string): string => {
  const t = s(v);
  if (!t) throw badRequest(label + ' is required (HH:MM)');
  if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) throw badRequest(label + ' must be a time such as 08:00');
  const parts = t.split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!(h >= 0 && h <= 23) || !(m >= 0 && m <= 59)) throw badRequest(label + ' is not a valid time');
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00';
};

export async function listBusinessCalendars(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const scope = await resolveScope(client, ctx);
  if (!hasPerm(scope.permissions, 'service_desk.sla.view') && !isAdminScope(scope)) {
    throw forbidden('You cannot view business calendars');
  }
  const where: string[] = ['cal.tenant_id = $1', 'cal.company_id = $2'];
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  if (!truthy(q.includeInactive)) where.push('cal.is_active');
  const res = await client.query(
    'SELECT cal.*, ' +
      '(SELECT count(*) FROM service_holidays h WHERE h.calendar_id = cal.id AND h.is_active) AS holiday_count, ' +
      '(SELECT count(*) FROM sla_policies p WHERE p.calendar_id = cal.id AND p.is_active) AS policy_count ' +
      'FROM service_business_calendars cal WHERE ' + where.join(' AND ') + ' ORDER BY cal.is_default DESC, cal.name',
    params
  );
  return { rows: res.rows, count: res.rows.length };
}

export async function createBusinessCalendar(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown> = {}) {
  const scope = await resolveScope(client, ctx);
  if (!hasPerm(scope.permissions, 'service_desk.sla.manage') && !isAdminScope(scope)) {
    throw forbidden('You cannot manage business calendars');
  }
  const code = s(b.code);
  const name = s(b.name);
  if (!code) throw badRequest('Calendar code is required');
  if (!name) throw badRequest('Calendar name is required');
  const dup = await client.query('SELECT 1 FROM service_business_calendars WHERE company_id = $1 AND code = $2', [ctx.companyId, code]);
  if (dup.rows.length > 0) throw conflict('A business calendar with that code already exists');
  const is24x7 = truthy(b.is24x7 ?? b.is24x7);
  const days = normaliseWorkingDays(b.workingDays ?? b.working_days);
  const workingDays = days !== undefined && days.length > 0 ? days : is24x7 ? WEEKDAYS : [1, 2, 3, 4, 5];
  if (!is24x7 && workingDays.length === 0) throw badRequest('At least one working day is required');
  const start = timeOf(b.workStart ?? b.work_start ?? (is24x7 ? '00:00' : '08:00'), 'workStart');
  const end = timeOf(b.workEnd ?? b.work_end ?? (is24x7 ? '23:59' : '17:00'), 'workEnd');
  if (!is24x7 && end <= start) throw badRequest('workEnd must be after workStart');

  const makeDefault = truthy(b.isDefault);
  if (makeDefault) {
    await client.query('UPDATE service_business_calendars SET is_default = false, updated_at = now() WHERE company_id = $1 AND is_default', [
      ctx.companyId,
    ]);
  }
  const res = await client.query(
    'INSERT INTO service_business_calendars ' +
      '(tenant_id, company_id, branch_id, code, name, timezone, working_days, work_start, work_end, is_24x7, is_default, ' +
      'is_active, created_by, updated_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *',
    [
      ctx.tenantId, ctx.companyId, nn(b.branchId), code, name, s(b.timezone) ?? 'Africa/Kampala',
      workingDays, start, end, is24x7, makeDefault,
      b.isActive === undefined ? true : truthy(b.isActive), ctx.userId ?? null,
    ]
  );
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'service_desk.sla',
    recordId: Number(res.rows[0].id),
    recordCode: code,
    newValues: { code, name, workingDays, workStart: start, workEnd: end, is24x7 },
  });
  return res.rows[0];
}

export async function updateBusinessCalendar(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown> = {}) {
  const scope = await resolveScope(client, ctx);
  if (!hasPerm(scope.permissions, 'service_desk.sla.manage') && !isAdminScope(scope)) {
    throw forbidden('You cannot manage business calendars');
  }
  const before = requireRow(
    (
      await client.query('SELECT * FROM service_business_calendars WHERE id = $1 AND tenant_id = $2 AND company_id = $3', [
        id,
        ctx.tenantId,
        ctx.companyId,
      ])
    ).rows[0],
    'Business calendar not found'
  );
  const sets: string[] = [];
  const params: unknown[] = [id, ctx.tenantId, ctx.companyId];
  const set = (col: string, value: unknown) => {
    params.push(value);
    sets.push(col + ' = $' + String(params.length));
  };
  if (b.name !== undefined) set('name', s(b.name) ?? before.name);
  if (b.timezone !== undefined) set('timezone', s(b.timezone) ?? before.timezone);
  if (b.branchId !== undefined) set('branch_id', nn(b.branchId));
  if (b.workingDays !== undefined || b.working_days !== undefined) {
    const days = normaliseWorkingDays(b.workingDays ?? b.working_days) ?? [];
    set('working_days', days);
  }
  if (b.workStart !== undefined || b.work_start !== undefined) set('work_start', timeOf(b.workStart ?? b.work_start, 'workStart'));
  if (b.workEnd !== undefined || b.work_end !== undefined) set('work_end', timeOf(b.workEnd ?? b.work_end, 'workEnd'));
  if (b.is24x7 !== undefined) set('is_24x7', truthy(b.is24x7));
  if (b.isActive !== undefined) set('is_active', truthy(b.isActive));
  if (truthy(b.isDefault)) {
    await client.query(
      'UPDATE service_business_calendars SET is_default = false, updated_at = now() WHERE company_id = $1 AND is_default AND id <> $2',
      [ctx.companyId, id]
    );
    set('is_default', true);
  } else if (b.isDefault !== undefined) {
    set('is_default', false);
  }
  if (sets.length === 0) throw badRequest('No supported fields were supplied');
  params.push(ctx.userId ?? null);
  sets.push('updated_by = $' + String(params.length));
  sets.push('updated_at = now()');
  const res = await client.query(
    'UPDATE service_business_calendars SET ' + sets.join(', ') + ' WHERE id = $1 AND tenant_id = $2 AND company_id = $3 RETURNING *',
    params
  );
  await logAudit(client, ctx, {
    action: 'update',
    resource: 'service_desk.sla',
    recordId: id,
    recordCode: before.code,
    oldValues: before,
    newValues: res.rows[0],
  });
  return res.rows[0];
}

// ----------------------------------------------------------------- holidays

export async function listHolidays(client: pg.PoolClient, ctx: Ctx, calendarRef: number | string, q: Record<string, unknown> = {}) {
  const scope = await resolveScope(client, ctx);
  if (!hasPerm(scope.permissions, 'service_desk.sla.view') && !isAdminScope(scope)) {
    throw forbidden('You cannot view holidays');
  }
  const cal = await resolveCalendar(client, ctx, calendarRef);
  const params: unknown[] = [cal.id];
  let sql =
    'SELECT h.* FROM service_holidays h WHERE h.calendar_id = $1 AND h.tenant_id = ' + String(ctx.tenantId) +
    ' AND h.company_id = ' + String(ctx.companyId);
  if (!truthy(q.includeInactive)) sql += ' AND h.is_active';
  if (s(q.from)) {
    params.push(s(q.from));
    sql += ' AND h.holiday_date >= $' + String(params.length);
  }
  if (s(q.to)) {
    params.push(s(q.to));
    sql += ' AND h.holiday_date <= $' + String(params.length);
  }
  sql += ' ORDER BY h.holiday_date';
  const res = await client.query(sql, params);
  return { calendar: cal, rows: res.rows, count: res.rows.length };
}

export async function createHoliday(client: pg.PoolClient, ctx: Ctx, calendarRef: number | string, b: Record<string, unknown> = {}) {
  const scope = await resolveScope(client, ctx);
  if (!hasPerm(scope.permissions, 'service_desk.sla.manage') && !isAdminScope(scope)) {
    throw forbidden('You cannot manage holidays');
  }
  const cal = await resolveCalendar(client, ctx, calendarRef);
  const date = s(b.holidayDate ?? b.holiday_date ?? b.date);
  if (!date) throw badRequest('holidayDate is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('holidayDate must be YYYY-MM-DD');
  const name = s(b.name);
  if (!name) throw badRequest('Holiday name is required');
  const res = await client.query(
    'INSERT INTO service_holidays (tenant_id, company_id, calendar_id, holiday_date, name, is_active, created_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [ctx.tenantId, ctx.companyId, cal.id, date, name, b.isActive === undefined ? true : truthy(b.isActive), ctx.userId ?? null]
  );
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'service_desk.sla',
    recordId: Number(res.rows[0].id),
    recordCode: cal.code,
    newValues: { calendarId: cal.id, holidayDate: date, name },
  });
  return res.rows[0];
}

export async function deleteHoliday(client: pg.PoolClient, ctx: Ctx, calendarRef: number | string, holidayId: number) {
  const scope = await resolveScope(client, ctx);
  if (!hasPerm(scope.permissions, 'service_desk.sla.manage') && !isAdminScope(scope)) {
    throw forbidden('You cannot manage holidays');
  }
  const cal = await resolveCalendar(client, ctx, calendarRef);
  const res = await client.query(
    'DELETE FROM service_holidays WHERE id = $1 AND calendar_id = $2 AND tenant_id = $3 AND company_id = $4 RETURNING *',
    [holidayId, cal.id, ctx.tenantId, ctx.companyId]
  );
  const removed = requireRow(res.rows[0], 'Holiday not found');
  await logAudit(client, ctx, {
    action: 'delete',
    resource: 'service_desk.sla',
    recordId: holidayId,
    recordCode: cal.code,
    oldValues: removed,
  });
  return { deleted: true, id: holidayId };
}

/** Resolve a calendar by surrogate id or by its code. */
async function resolveCalendar(client: pg.PoolClient, ctx: Ctx, refv: number | string) {
  const asNumber = typeof refv === 'number' ? refv : /^\d+$/.test(String(refv)) ? Number(refv) : null;
  const res = await client.query(
    'SELECT * FROM service_business_calendars WHERE tenant_id = $1 AND company_id = $2 AND (id = $3 OR code = $4) LIMIT 1',
    [ctx.tenantId, ctx.companyId, asNumber, String(refv)]
  );
  return requireRow(res.rows[0], 'Business calendar not found');
}

/** Resolve a service team by surrogate id or by its code. */
async function resolveTeam(client: pg.PoolClient, ctx: Ctx, refv: number | string) {
  const asNumber = typeof refv === "number" ? refv : /^\d+$/.test(String(refv)) ? Number(refv) : null;
  const res = await client.query(
    "SELECT * FROM service_teams WHERE tenant_id = $1 AND company_id = $2 AND (id = $3 OR code = $4) LIMIT 1",
    [ctx.tenantId, ctx.companyId, asNumber, String(refv)]
  );
  return requireRow(res.rows[0], "Service team not found");
}

// ------------------------------------------------------------------- teams

export async function listTeams(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const scope = await resolveScope(client, ctx);
  if (!hasPerm(scope.permissions, 'service_desk.teams.view') && !isAdminScope(scope)) {
    throw forbidden('You cannot view service teams');
  }
  const { page, pageSize: limit, offset } = parsePagination(q);
  const where: string[] = ['t.tenant_id = $1', 't.company_id = $2'];
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  if (!truthy(q.includeInactive)) where.push('t.is_active');
  const term = s(q.search);
  if (term) {
    params.push('%' + term + '%');
    where.push('(t.code ILIKE $' + String(params.length) + ' OR t.name ILIKE $' + String(params.length) + ')');
  }
  const totalRes = await client.query('SELECT count(*)::int AS total FROM service_teams t WHERE ' + where.join(' AND '), params);
  const total = Number(totalRes.rows[0]?.total ?? 0);
  const res = await client.query(
    'SELECT t.*, ' +
      "COALESCE(lu.first_name || ' ' || lu.last_name, lu.email) AS lead_name, " +
      '(SELECT count(*) FROM service_team_members m WHERE m.team_id = t.id AND m.is_active) AS member_count, ' +
      '(SELECT count(*) FROM service_queues q2 WHERE q2.team_id = t.id AND q2.is_active) AS queue_count, ' +
      '(SELECT count(*) FROM service_tickets tk WHERE tk.assigned_team_id = t.id AND tk.status <> ALL($3::text[])) AS open_tickets ' +
      'FROM service_teams t LEFT JOIN users lu ON lu.id = t.lead_user_id ' +
      'WHERE ' + where.join(' AND ') + ' ORDER BY t.name LIMIT $4 OFFSET $5',
    [...params, ACTIVE_FOR_TEAM_COUNTS, limit, offset]
  );
  return paged(res.rows, total, page, limit, offset);
}

const ACTIVE_FOR_TEAM_COUNTS = ['CLOSED', 'CANCELLED'];

export async function createTeam(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown> = {}) {
  const scope = await resolveScope(client, ctx);
  if (!hasPerm(scope.permissions, 'service_desk.teams.create') && !isAdminScope(scope)) {
    throw forbidden('You cannot create service teams');
  }
  const code = s(b.code);
  const name = s(b.name);
  if (!code) throw badRequest('Team code is required');
  if (!name) throw badRequest('Team name is required');
  const dup = await client.query('SELECT 1 FROM service_teams WHERE company_id = $1 AND code = $2', [ctx.companyId, code]);
  if (dup.rows.length > 0) throw conflict('A team with that code already exists');
  const res = await client.query(
    'INSERT INTO service_teams (tenant_id, company_id, branch_id, code, name, description, lead_user_id, email, is_active, created_by, updated_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *',
    [
      ctx.tenantId, ctx.companyId, nn(b.branchId), code, name, s(b.description) ?? null, nn(b.leadUserId), s(b.email) ?? null,
      b.isActive === undefined ? true : truthy(b.isActive), ctx.userId ?? null,
    ]
  );
  await logAudit(client, ctx, {
    action: 'create',
    resource: 'service_desk.teams',
    recordId: Number(res.rows[0].id),
    recordCode: code,
    newValues: { code, name },
  });
  return res.rows[0];
}

export async function updateTeam(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown> = {}) {
  const scope = await resolveScope(client, ctx);
  if (!hasPerm(scope.permissions, 'service_desk.teams.update') && !isAdminScope(scope)) {
    throw forbidden('You cannot update service teams');
  }
  const before = requireRow(
    (await client.query('SELECT * FROM service_teams WHERE id = $1 AND tenant_id = $2 AND company_id = $3', [id, ctx.tenantId, ctx.companyId])).rows[0],
    'Service team not found'
  );
  const sets: string[] = [];
  const params: unknown[] = [id, ctx.tenantId, ctx.companyId];
  const set = (col: string, value: unknown) => {
    params.push(value);
    sets.push(col + ' = $' + String(params.length));
  };
  if (b.name !== undefined) set('name', s(b.name) ?? before.name);
  if (b.description !== undefined) set('description', s(b.description) ?? null);
  if (b.email !== undefined) set('email', s(b.email) ?? null);
  if (b.leadUserId !== undefined) set('lead_user_id', nn(b.leadUserId));
  if (b.branchId !== undefined) set('branch_id', nn(b.branchId));
  if (b.isActive !== undefined) set('is_active', truthy(b.isActive));
  if (sets.length === 0) throw badRequest('No supported fields were supplied');
  params.push(ctx.userId ?? null);
  sets.push('updated_by = $' + String(params.length));
  sets.push('updated_at = now()');
  const res = await client.query(
    'UPDATE service_teams SET ' + sets.join(', ') + ' WHERE id = $1 AND tenant_id = $2 AND company_id = $3 RETURNING *',
    params
  );
  await logAudit(client, ctx, { action: 'update', resource: 'service_desk.teams', recordId: id, recordCode: before.code, oldValues: before, newValues: res.rows[0] });
  return res.rows[0];
}

export async function listTeamMembers(client: pg.PoolClient, ctx: Ctx, teamRef: number | string) {
  const scope = await resolveScope(client, ctx);
  if (!hasPerm(scope.permissions, 'service_desk.teams.view') && !isAdminScope(scope)) {
    throw forbidden('You cannot view service teams');
  }
  const team = await resolveTeam(client, ctx, teamRef);
  const res = await client.query(
    'SELECT m.*, COALESCE(u.first_name || \' \' || u.last_name, u.email) AS name, u.email, u.status AS user_status ' +
      'FROM service_team_members m JOIN users u ON u.id = m.user_id ' +
      'WHERE m.team_id = $1 AND m.tenant_id = $2 AND m.company_id = $3 ORDER BY m.is_lead DESC, name',
    [team.id, ctx.tenantId, ctx.companyId]
  );
  return { team, rows: res.rows, count: res.rows.length };
}

export async function addTeamMember(client: pg.PoolClient, ctx: Ctx, teamRef: number | string, b: Record<string, unknown> = {}) {
  const scope = await resolveScope(client, ctx);
  if (!hasPerm(scope.permissions, 'service_desk.teams.update') && !isAdminScope(scope)) {
    throw forbidden('You cannot manage service team membership');
  }
  const team = await resolveTeam(client, ctx, teamRef);
  const userId = nn(b.userId ?? b.user_id);
  if (!userId) throw badRequest('userId is required');
  const user = await client.query("SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE'", [userId, ctx.tenantId]);
  if (user.rows.length === 0) throw badRequest('User not found or inactive');
  const isLead = truthy(b.isLead);
  const res = await client.query(
    'INSERT INTO service_team_members (tenant_id, company_id, team_id, user_id, is_lead, is_active, created_by) ' +
      'VALUES ($1,$2,$3,$4,$5,true,$6) ' +
      'ON CONFLICT (team_id, user_id) DO UPDATE SET is_active = true, is_lead = EXCLUDED.is_lead, updated_at = now() RETURNING *',
    [ctx.tenantId, ctx.companyId, team.id, userId, isLead, ctx.userId ?? null]
  );
  if (isLead) {
    await client.query('UPDATE service_team_members SET is_lead = false, updated_at = now() WHERE team_id = $1 AND user_id <> $2', [team.id, userId]);
  }
  await logAudit(client, ctx, {
    action: 'assign',
    resource: 'service_desk.teams',
    recordId: Number(team.id),
    recordCode: team.code,
    newValues: { teamMemberUserId: userId, isLead },
  });
  return res.rows[0];
}

export async function removeTeamMember(client: pg.PoolClient, ctx: Ctx, teamRef: number | string, userId: number) {
  const scope = await resolveScope(client, ctx);
  if (!hasPerm(scope.permissions, 'service_desk.teams.update') && !isAdminScope(scope)) {
    throw forbidden('You cannot manage service team membership');
  }
  const team = await resolveTeam(client, ctx, teamRef);
  const res = await client.query(
    'UPDATE service_team_members SET is_active = false, is_lead = false, updated_at = now() ' +
      'WHERE team_id = $1 AND user_id = $2 AND tenant_id = $3 AND company_id = $4 RETURNING *',
    [team.id, userId, ctx.tenantId, ctx.companyId]
  );
  requireRow(res.rows[0], 'Team member not found');
  await logAudit(client, ctx, {
    action: 'remove',
    resource: 'service_desk.teams',
    recordId: Number(team.id),
    recordCode: team.code,
    oldValues: { teamMemberUserId: userId },
  });
  return { removed: true, teamId: Number(team.id), userId };
}

// ------------------------------------------------------------------ skills

export async function listSkills(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown> = {}) {
  const scope = await resolveScope(client, ctx);
  if (!hasPerm(scope.permissions, 'service_desk.skills.view') && !isAdminScope(scope)) {
    throw forbidden('You cannot view service skills');
  }
  const where: string[] = ['s.tenant_id = $1', 's.company_id = $2'];
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  if (!truthy(q.includeInactive)) where.push('s.is_active');
  const res = await client.query(
    'SELECT s.*, ' +
      '(SELECT count(*) FROM service_agent_skills a WHERE a.skill_id = s.id) AS agent_count, ' +
      '(SELECT count(*) FROM service_category_skills c WHERE c.skill_id = s.id) AS category_count ' +
      'FROM service_skills s WHERE ' + where.join(' AND ') + ' ORDER BY s.name',
    params
  );
  return { rows: res.rows, count: res.rows.length };
}

export async function createSkill(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown> = {}) {
  const scope = await resolveScope(client, ctx);
  if (!hasPerm(scope.permissions, 'service_desk.skills.create') && !isAdminScope(scope)) {
    throw forbidden('You cannot create service skills');
  }
  const code = s(b.code);
  const name = s(b.name);
  if (!code) throw badRequest('Skill code is required');
  if (!name) throw badRequest('Skill name is required');
  const dup = await client.query('SELECT 1 FROM service_skills WHERE company_id = $1 AND code = $2', [ctx.companyId, code]);
  if (dup.rows.length > 0) throw conflict('A skill with that code already exists');
  const res = await client.query(
    'INSERT INTO service_skills (tenant_id, company_id, code, name, description, is_active, created_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [ctx.tenantId, ctx.companyId, code, name, s(b.description) ?? null, b.isActive === undefined ? true : truthy(b.isActive), ctx.userId ?? null]
  );
  await logAudit(client, ctx, { action: 'create', resource: 'service_desk.skills', recordId: Number(res.rows[0].id), recordCode: code, newValues: { code, name } });
  return res.rows[0];
}

export async function updateSkill(client: pg.PoolClient, ctx: Ctx, id: number, b: Record<string, unknown> = {}) {
  const scope = await resolveScope(client, ctx);
  if (!hasPerm(scope.permissions, 'service_desk.skills.update') && !isAdminScope(scope)) {
    throw forbidden('You cannot update service skills');
  }
  const before = requireRow(
    (await client.query('SELECT * FROM service_skills WHERE id = $1 AND tenant_id = $2 AND company_id = $3', [id, ctx.tenantId, ctx.companyId])).rows[0],
    'Skill not found'
  );
  const sets: string[] = [];
  const params: unknown[] = [id, ctx.tenantId, ctx.companyId];
  const set = (col: string, value: unknown) => {
    params.push(value);
    sets.push(col + ' = $' + String(params.length));
  };
  if (b.name !== undefined) set('name', s(b.name) ?? before.name);
  if (b.description !== undefined) set('description', s(b.description) ?? null);
  if (b.isActive !== undefined) set('is_active', truthy(b.isActive));
  if (sets.length === 0) throw badRequest('No supported fields were supplied');
  sets.push('updated_at = now()');
  const res = await client.query(
    'UPDATE service_skills SET ' + sets.join(', ') + ' WHERE id = $1 AND tenant_id = $2 AND company_id = $3 RETURNING *',
    params
  );
  await logAudit(client, ctx, { action: 'update', resource: 'service_desk.skills', recordId: id, recordCode: before.code, oldValues: before, newValues: res.rows[0] });
  return res.rows[0];
}
