import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, toCamelRows } from '../utils.js';

function scoped(ctx: Ctx) {
  if (!ctx.companyId) throw badRequest('Company context required');
  return { tenantId: ctx.tenantId, companyId: ctx.companyId };
}

async function rows(client: pg.PoolClient, sql: string, params: unknown[]) {
  const res = await client.query(sql, params);
  return toCamelRows(res.rows);
}

export async function listPerformanceGoals(client: pg.PoolClient, ctx: Ctx, status?: string | null) {
  const { tenantId, companyId } = scoped(ctx);
  return rows(
    client,
    `SELECT g.id, g.title, g.category, g.start_date, g.due_date, g.weight, g.progress, g.status,
            e.id AS employee_id, e.employee_no, e.first_name, e.last_name
     FROM performance_goals g JOIN employees e ON e.id = g.employee_id
     WHERE g.tenant_id = $1 AND g.company_id = $2 AND ($3::text IS NULL OR g.status = $3)
     ORDER BY g.id DESC LIMIT 200`,
    [tenantId, companyId, status || null]
  );
}

export async function listPerformanceReviews(client: pg.PoolClient, ctx: Ctx, status?: string | null) {
  const { tenantId, companyId } = scoped(ctx);
  return rows(
    client,
    `SELECT r.id, r.review_type, r.period_start, r.period_end, r.status, r.overall_rating, r.due_date, r.summary,
            e.id AS employee_id, e.employee_no, e.first_name, e.last_name
     FROM performance_reviews r JOIN employees e ON e.id = r.employee_id
     WHERE r.tenant_id = $1 AND r.company_id = $2 AND ($3::text IS NULL OR r.status = $3)
     ORDER BY r.id DESC LIMIT 200`,
    [tenantId, companyId, status || null]
  );
}

export async function listPips(client: pg.PoolClient, ctx: Ctx, status?: string | null) {
  const { tenantId, companyId } = scoped(ctx);
  return rows(
    client,
    `SELECT p.id, p.reason, p.start_date, p.end_date, p.status, p.progress,
            e.id AS employee_id, e.employee_no, e.first_name, e.last_name
     FROM performance_improvement_plans p JOIN employees e ON e.id = p.employee_id
     WHERE p.tenant_id = $1 AND p.company_id = $2 AND ($3::text IS NULL OR p.status = $3)
     ORDER BY p.id DESC LIMIT 200`,
    [tenantId, companyId, status || null]
  );
}

export async function listTrainingCatalog(client: pg.PoolClient, ctx: Ctx) {
  const { tenantId, companyId } = scoped(ctx);
  return rows(
    client,
    `SELECT id, code, title, category, duration_hours, provider, cost, status
     FROM training_catalog WHERE tenant_id = $1 AND company_id = $2 ORDER BY code LIMIT 200`,
    [tenantId, companyId]
  );
}

export async function listTrainingSessions(client: pg.PoolClient, ctx: Ctx) {
  const { tenantId, companyId } = scoped(ctx);
  return rows(
    client,
    `SELECT s.id, s.code, s.trainer, s.start_date, s.end_date, s.location, s.capacity, s.status, s.training_id,
            c.code AS training_code, c.title AS training_title
     FROM training_sessions s JOIN training_catalog c ON c.id = s.training_id
     WHERE s.tenant_id = $1 AND s.company_id = $2 ORDER BY s.start_date DESC LIMIT 200`,
    [tenantId, companyId]
  );
}

export async function listTrainingRequests(client: pg.PoolClient, ctx: Ctx, status?: string | null) {
  const { tenantId, companyId } = scoped(ctx);
  return rows(
    client,
    `SELECT r.id, r.reason, r.status, r.approved_at, r.training_id,
            c.code AS training_code, c.title AS training_title,
            e.id AS employee_id, e.employee_no, e.first_name, e.last_name
     FROM training_requests r
     JOIN employees e ON e.id = r.employee_id
     LEFT JOIN training_catalog c ON c.id = r.training_id
     WHERE r.tenant_id = $1 AND r.company_id = $2 AND ($3::text IS NULL OR r.status = $3)
     ORDER BY r.id DESC LIMIT 200`,
    [tenantId, companyId, status || null]
  );
}

export async function listTrainingEnrollments(client: pg.PoolClient, ctx: Ctx, status?: string | null) {
  const { tenantId, companyId } = scoped(ctx);
  return rows(
    client,
    `SELECT n.id, n.status, n.score, n.completed_at, n.session_id,
            s.code AS session_code, c.title AS training_title,
            e.id AS employee_id, e.employee_no, e.first_name, e.last_name
     FROM training_enrollments n
     JOIN employees e ON e.id = n.employee_id
     JOIN training_sessions s ON s.id = n.session_id
     LEFT JOIN training_catalog c ON c.id = s.training_id
     WHERE n.tenant_id = $1 AND n.company_id = $2 AND ($3::text IS NULL OR n.status = $3)
     ORDER BY n.id DESC LIMIT 200`,
    [tenantId, companyId, status || null]
  );
}

export async function listGrievances(client: pg.PoolClient, ctx: Ctx, status?: string | null) {
  const { tenantId, companyId } = scoped(ctx);
  return rows(
    client,
    `SELECT g.id, g.category, g.subject, g.priority, g.status, g.created_at, g.resolution,
            e.id AS employee_id, e.employee_no, e.first_name, e.last_name
     FROM grievances g JOIN employees e ON e.id = g.employee_id
     WHERE g.tenant_id = $1 AND g.company_id = $2 AND ($3::text IS NULL OR g.status = $3)
     ORDER BY g.id DESC LIMIT 200`,
    [tenantId, companyId, status || null]
  );
}

export async function listDisciplinaryCases(client: pg.PoolClient, ctx: Ctx, status?: string | null) {
  const { tenantId, companyId } = scoped(ctx);
  return rows(
    client,
    `SELECT d.id, d.case_no, d.incident_date, d.category, d.description, d.status,
            e.id AS employee_id, e.employee_no, e.first_name, e.last_name
     FROM disciplinary_cases d JOIN employees e ON e.id = d.employee_id
     WHERE d.tenant_id = $1 AND d.company_id = $2 AND ($3::text IS NULL OR d.status = $3)
     ORDER BY d.id DESC LIMIT 200`,
    [tenantId, companyId, status || null]
  );
}

export async function listWarnings(client: pg.PoolClient, ctx: Ctx, status?: string | null) {
  const { tenantId, companyId } = scoped(ctx);
  return rows(
    client,
    `SELECT w.id, w.warning_type, w.reason, w.issued_at, w.expires_at, w.status,
            e.id AS employee_id, e.employee_no, e.first_name, e.last_name
     FROM warnings w JOIN employees e ON e.id = w.employee_id
     WHERE w.tenant_id = $1 AND w.company_id = $2 AND ($3::text IS NULL OR w.status = $3)
     ORDER BY w.id DESC LIMIT 200`,
    [tenantId, companyId, status || null]
  );
}

export async function listBenefitPlans(client: pg.PoolClient, ctx: Ctx) {
  const { tenantId, companyId } = scoped(ctx);
  return rows(
    client,
    `SELECT id, code, name, category, provider, cost, employee_contribution, employer_contribution, status
     FROM benefit_plans WHERE tenant_id = $1 AND company_id = $2 ORDER BY code LIMIT 200`,
    [tenantId, companyId]
  );
}

export async function listBenefitEnrollments(client: pg.PoolClient, ctx: Ctx, status?: string | null) {
  const { tenantId, companyId } = scoped(ctx);
  return rows(
    client,
    `SELECT n.id, n.effective_from, n.effective_to, n.monthly_cost, n.status, n.plan_id,
            p.code AS plan_code, p.name AS plan_name, p.category,
            e.id AS employee_id, e.employee_no, e.first_name, e.last_name
     FROM benefit_enrollments n
     JOIN employees e ON e.id = n.employee_id
     JOIN benefit_plans p ON p.id = n.plan_id
     WHERE n.tenant_id = $1 AND n.company_id = $2 AND ($3::text IS NULL OR n.status = $3)
     ORDER BY n.id DESC LIMIT 200`,
    [tenantId, companyId, status || null]
  );
}

export async function listShifts(client: pg.PoolClient, ctx: Ctx) {
  const { tenantId, companyId } = scoped(ctx);
  return rows(
    client,
    `SELECT id, code, name, start_time, end_time, grace_minutes, break_minutes, work_hours, status
     FROM shifts WHERE tenant_id = $1 AND company_id = $2 ORDER BY code LIMIT 200`,
    [tenantId, companyId]
  );
}

export async function listShiftAssignments(client: pg.PoolClient, ctx: Ctx) {
  const { tenantId, companyId } = scoped(ctx);
  return rows(
    client,
    `SELECT a.id, a.effective_from, a.effective_to, a.status, a.shift_id,
            s.code AS shift_code, s.name AS shift_name,
            e.id AS employee_id, e.employee_no, e.first_name, e.last_name
     FROM shift_assignments a
     JOIN employees e ON e.id = a.employee_id
     JOIN shifts s ON s.id = a.shift_id
     WHERE a.tenant_id = $1 AND a.company_id = $2
     ORDER BY a.id DESC LIMIT 200`,
    [tenantId, companyId]
  );
}

export async function listTimesheets(client: pg.PoolClient, ctx: Ctx, status?: string | null) {
  const { tenantId, companyId } = scoped(ctx);
  return rows(
    client,
    `SELECT t.id, t.period_start, t.period_end, t.total_hours, t.status, t.approved_at, t.notes,
            e.id AS employee_id, e.employee_no, e.first_name, e.last_name
     FROM timesheets t JOIN employees e ON e.id = t.employee_id
     WHERE t.tenant_id = $1 AND t.company_id = $2 AND ($3::text IS NULL OR t.status = $3)
     ORDER BY t.period_start DESC, t.id DESC LIMIT 200`,
    [tenantId, companyId, status || null]
  );
}

export async function createTimesheet(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { employeeId: number; periodStart: string; periodEnd: string; totalHours?: number; notes?: string | null }
) {
  const { tenantId, companyId } = scoped(ctx);
  if (!input.employeeId || !input.periodStart || !input.periodEnd) throw badRequest('Employee and period are required');
  const ins = await client.query(
    `INSERT INTO timesheets (company_id, tenant_id, employee_id, period_start, period_end, total_hours, notes, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'DRAFT') RETURNING id`,
    [companyId, tenantId, Number(input.employeeId), input.periodStart, input.periodEnd, Number(input.totalHours ?? 0), input.notes ?? null]
  );
  return { timesheetId: Number(ins.rows[0].id), status: 'DRAFT' };
}

export async function createTrainingCourse(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { code?: string; title: string; category?: string | null; durationHours?: number | null; provider?: string | null; cost?: number }
) {
  const { tenantId, companyId } = scoped(ctx);
  if (!input.title?.trim()) throw badRequest('Course title is required');
  const code = (input.code?.trim() || `TRN-${Date.now().toString().slice(-6)}`).toUpperCase();
  const ins = await client.query(
    `INSERT INTO training_catalog (company_id, tenant_id, code, title, category, duration_hours, provider, cost, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE') RETURNING id, code`,
    [companyId, tenantId, code, input.title.trim(), input.category ?? null, input.durationHours ?? null, input.provider ?? null, Number(input.cost ?? 0)]
  );
  return { trainingId: Number(ins.rows[0].id), code: String(ins.rows[0].code) };
}

export async function createTrainingSession(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { trainingId: number; startDate: string; endDate?: string | null; location?: string | null; trainer?: string | null; capacity?: number | null }
) {
  const { tenantId, companyId } = scoped(ctx);
  if (!input.trainingId || !input.startDate) throw badRequest('Course and start date are required');
  const code = `SES-${Date.now().toString().slice(-6)}`;
  const ins = await client.query(
    `INSERT INTO training_sessions (company_id, tenant_id, training_id, code, trainer, start_date, end_date, location, capacity, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SCHEDULED') RETURNING id, code`,
    [companyId, tenantId, Number(input.trainingId), code, input.trainer ?? null, input.startDate, input.endDate ?? null, input.location ?? null, input.capacity ?? null]
  );
  return { sessionId: Number(ins.rows[0].id), code: String(ins.rows[0].code) };
}

export async function createBenefitPlan(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { code?: string; name: string; category?: string; provider?: string | null; cost?: number; employeeContribution?: number; employerContribution?: number }
) {
  const { tenantId, companyId } = scoped(ctx);
  if (!input.name?.trim()) throw badRequest('Plan name is required');
  const code = (input.code?.trim() || `BEN-${Date.now().toString().slice(-6)}`).toUpperCase();
  const category = String(input.category ?? 'OTHER').toUpperCase();
  const ins = await client.query(
    `INSERT INTO benefit_plans
       (company_id, tenant_id, code, name, category, provider, cost, employee_contribution, employer_contribution, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE') RETURNING id, code`,
    [
      companyId, tenantId, code, input.name.trim(), category, input.provider ?? null,
      Number(input.cost ?? 0), Number(input.employeeContribution ?? 0), Number(input.employerContribution ?? 0),
    ]
  );
  return { planId: Number(ins.rows[0].id), code: String(ins.rows[0].code) };
}
