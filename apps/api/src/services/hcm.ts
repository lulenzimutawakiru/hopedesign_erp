import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { startWorkflow } from './workflow.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';
import * as statutory from './statutory.js';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { parsePdf } from './pdf.js';

const round2 = (n: number) => Math.round(n * 100) / 100;
const ACTIVE_EMPLOYEE_STATUS = "('ACTIVE','PROBATION','ON_LEAVE')";

async function nextDoc(client: pg.PoolClient, ctx: Ctx, prefix: string): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, prefix]);
  return String(res.rows[0].code);
}

function num(v: unknown, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function str(v: unknown): string | null {
  return v == null || String(v).trim() === '' ? null : String(v).trim();
}

function fmtDate(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dt = new Date(s);
  if (isNaN(dt.getTime())) return s;
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function bool(v: unknown, d = false): boolean {
  if (v === undefined || v === null) return d;
  return v === true || v === 'true' || v === 1 || v === '1';
}

function contractType(v: unknown): string {
  const s = String(v ?? 'PERMANENT').toUpperCase();
  if (s === 'FULL_TIME') return 'PERMANENT';
  if (s === 'CONTRACT' || s === 'FIXED_TERM') return 'FIXED_TERM';
  if (s === 'PROBATION' || s === 'PROBATIONARY') return 'PROBATIONARY';
  return ['PERMANENT', 'PART_TIME', 'TEMPORARY', 'APPRENTICESHIP', 'CASUAL', 'INTERNSHIP', 'CONSULTANCY', 'SECONDMENT'].includes(s) ? s : 'FIXED_TERM';
}

function requisitionEmploymentType(v: unknown): string {
  const s = String(v ?? 'PERMANENT').toUpperCase();
  if (s === 'FULL_TIME' || s === 'PROBATION') return 'PERMANENT';
  if (s === 'INTERNSHIP') return 'INTERNSHIP';
  return ['PERMANENT', 'CONTRACT', 'PART_TIME', 'CASUAL'].includes(s) ? s : 'PERMANENT';
}

async function companyRow(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT * FROM companies WHERE id = $1 AND tenant_id = $2`,
    [ctx.companyId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Company context required');
  return res.rows[0];
}

// ============================================================
// ORGANIZATION MANAGEMENT
// ============================================================

/** Full org tree: company -> divisions -> departments -> org units -> teams -> positions -> employees. */
export async function orgChart(client: pg.PoolClient, ctx: Ctx) {
  const company = await companyRow(client, ctx);
  const branches = await client.query(
    `SELECT * FROM branches WHERE company_id = $1 AND tenant_id = $2 ORDER BY name`,
    [ctx.companyId, ctx.tenantId]
  );
  const divisions = await client.query(
    `SELECT * FROM divisions WHERE company_id = $1 AND tenant_id = $2 ORDER BY name`,
    [ctx.companyId, ctx.tenantId]
  );
  const departments = await client.query(
    `SELECT * FROM departments WHERE company_id = $1 AND tenant_id = $2 ORDER BY name`,
    [ctx.companyId, ctx.tenantId]
  );
  const orgUnits = await client.query(
    `SELECT * FROM org_units WHERE company_id = $1 AND tenant_id = $2 ORDER BY name`,
    [ctx.companyId, ctx.tenantId]
  );
  const teams = await client.query(
    `SELECT * FROM teams WHERE company_id = $1 AND tenant_id = $2 ORDER BY name`,
    [ctx.companyId, ctx.tenantId]
  );
  const positions = await client.query(
    `SELECT p.*, (
        SELECT count(*)::int FROM employees e
        WHERE e.position_id = p.id AND e.status IN ${ACTIVE_EMPLOYEE_STATUS}
      ) AS occupied
     FROM positions p
     WHERE p.company_id = $1 AND p.tenant_id = $2 ORDER BY p.code`,
    [ctx.companyId, ctx.tenantId]
  );
  const employees = await client.query(
    `SELECT e.id, e.employee_no, e.employee_number, e.short_employee_number,
            e.first_name, e.last_name, e.position, e.position_id,
            e.department_id, e.team_id, e.org_unit_id, e.job_grade_id, e.status, e.hire_date
     FROM employees e
     WHERE e.company_id = $1 AND e.tenant_id = $2 AND e.status IN ${ACTIVE_EMPLOYEE_STATUS}
     ORDER BY e.last_name, e.first_name`,
    [ctx.companyId, ctx.tenantId]
  );

  const deptRows: any[] = departments.rows.map((d) => ({
    ...toCamelRow(d),
    orgUnits: [] as Record<string, unknown>[],
    teams: [] as Record<string, unknown>[],
    positions: [] as Record<string, unknown>[],
    employees: [] as Record<string, unknown>[],
  }));
  const deptById = new Map<number, any>();
  for (const d of deptRows) deptById.set(Number(d.id), d);

  const ouRows: any[] = orgUnits.rows.map((u) => ({ ...toCamelRow(u), teams: [] as Record<string, unknown>[], employees: [] as Record<string, unknown>[] }));
  const ouById = new Map<number, any>();
  for (const u of ouRows) ouById.set(Number(u.id), u);

  const teamRows: any[] = teams.rows.map((t) => ({ ...toCamelRow(t), employees: [] as Record<string, unknown>[] }));

  const posRows: any[] = positions.rows.map((p) => ({
    ...toCamelRow(p),
    occupied: Number(p.occupied),
    vacancy: Math.max(0, Number(p.approved_headcount ?? 0) - Number(p.occupied)),
    employees: [] as Record<string, unknown>[],
  }));
  const posById = new Map<number, any>();
  for (const p of posRows) posById.set(Number(p.id), p);

  for (const r of employees.rows) {
    const emp = toCamelRow(r);
    const pos = posById.get(Number(r.position_id));
    if (pos) pos.employees.push(emp);
    const team = teamRows.find((t) => Number(t.id) === Number(r.team_id));
    if (team) team.employees.push(emp);
    const ou = ouById.get(Number(r.org_unit_id));
    if (ou) ou.employees.push(emp);
    const dept = deptById.get(Number(r.department_id));
    if (dept) dept.employees.push(emp);
  }

  for (const t of teamRows) {
    const ou = ouById.get(Number(t.org_unit_id));
    if (ou) ou.teams.push(t);
  }
  for (const u of ouRows) {
    const dept = deptById.get(Number(u.department_id));
    if (dept) dept.orgUnits.push(u);
  }
  for (const p of posRows) {
    const dept = deptById.get(Number(p.department_id));
    if (dept) dept.positions.push(p);
  }

  const divisionRows: any[] = divisions.rows.map((d) => ({ ...toCamelRow(d), departments: [] as Record<string, unknown>[], employees: [] as Record<string, unknown>[] }));
  const divisionById = new Map<number, any>();
  for (const d of divisionRows) divisionById.set(Number(d.id), d);
  const withoutDivision: any[] = [];
  for (const d of deptRows) {
    const div = divisionById.get(Number(d.divisionId));
    if (div) div.departments.push(d);
    else withoutDivision.push(d);
  }

  const headcount = employees.rows.length;
  const vacant = posRows.reduce((s, p) => s + p.vacancy, 0);
  return {
    company: toCamelRow(company),
    branches: toCamelRows(branches.rows),
    divisions: divisionRows,
    departmentsWithoutDivision: withoutDivision,
    summary: {
      headcount,
      activePositions: posRows.length,
      vacantPositions: vacant,
      departments: deptRows.length,
      teams: teamRows.length,
      orgUnits: ouRows.length,
    },
  };
}

/** Approved vs occupied headcount per position; optionally filtered to one position. */
export async function positionOccupancy(client: pg.PoolClient, ctx: Ctx, positionId?: number | null) {
  const res = await client.query(
    `SELECT p.id, p.code, p.title, p.department_id, d.name AS department, p.branch_id, b.name AS branch,
            p.job_family_id, p.job_grade_id, p.approved_headcount, p.status, p.currency,
            p.salary_min, p.salary_max,
            (SELECT count(*)::int FROM employees e
              WHERE e.position_id = p.id AND e.status IN ${ACTIVE_EMPLOYEE_STATUS}) AS occupied,
            (SELECT count(*)::int FROM position_assignments pa
              WHERE pa.position_id = p.id AND pa.is_primary = true
                AND (pa.effective_to IS NULL OR pa.effective_to >= CURRENT_DATE)) AS assigned
     FROM positions p
     LEFT JOIN departments d ON d.id = p.department_id
     LEFT JOIN branches b ON b.id = p.branch_id
     WHERE p.company_id = $1 AND p.tenant_id = $2 AND ($3::bigint IS NULL OR p.id = $3)
     ORDER BY p.code`,
    [ctx.companyId, ctx.tenantId, positionId ?? null]
  );
  const rows: any[] = res.rows.map((r) => {
    const occupied = Number(r.occupied);
    return {
      ...toCamelRow(r),
      occupied,
      vacancy: Math.max(0, Number(r.approved_headcount ?? 0) - occupied),
    };
  });
  const totals = rows.reduce(
    (t, r) => ({
      approved: t.approved + Number(r.approvedHeadcount ?? 0),
      occupied: t.occupied + r.occupied,
      vacancy: t.vacancy + r.vacancy,
    }),
    { approved: 0, occupied: 0, vacancy: 0 }
  );
  return { rows, totals };
}

/** Reference data for org / position / workforce-planning screens. */
export async function orgRefs(client: pg.PoolClient, ctx: Ctx) {
  const list = async (table: string, order = 'name ASC') => {
    const res = await client.query(
      `SELECT * FROM ${table} WHERE company_id = $1 AND tenant_id = $2 ORDER BY ${order}`,
      [ctx.companyId, ctx.tenantId]
    );
    return toCamelRows(res.rows);
  };
  const branches = await list('branches');
  const departments = await list('departments');
  const divisions = await list('divisions');
  const orgUnits = await list('org_units');
  const teams = await list('teams');
  const locations = await list('locations');
  const jobFamilies = await list('job_families');
  const jobGrades = await list('job_grades', 'level ASC');
  const costCentres = await list('cost_centres');
  const positionsRes = await client.query(
    `SELECT p.id, p.code, p.title, p.department_id, d.name AS department_name,
            p.approved_headcount, p.status
     FROM positions p
     LEFT JOIN departments d ON d.id = p.department_id
     WHERE p.company_id = $1 AND p.tenant_id = $2
     ORDER BY p.code LIMIT 500`,
    [ctx.companyId, ctx.tenantId]
  );
  return {
    branches, departments, divisions, orgUnits, teams, locations,
    jobFamilies, jobGrades, costCentres,
    positions: toCamelRows(positionsRes.rows),
  };
}

// ============================================================
// WORKFORCE PLANNING
// ============================================================

export async function createWorkforcePlan(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    planName: string;
    fiscalYear: string;
    periodStart?: string | null;
    periodEnd?: string | null;
    budgetAmount?: number;
    currency?: string | null;
    branchId?: number | null;
    departmentId?: number | null;
    notes?: string | null;
    lines?: Array<{
      positionId: number;
      currentHeadcount?: number;
      plannedHeadcount?: number;
      expectedDepartures?: number;
      retirements?: number;
      newPositions?: number;
      salaryBudget?: number;
      notes?: string | null;
    }>;
  }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  if (!input.planName?.trim()) throw badRequest('Plan name is required');
  const no = await nextDoc(client, ctx, 'WFP');
  const ins = await client.query(
    `INSERT INTO workforce_plans
       (company_id, tenant_id, branch_id, department_id, plan_no, plan_name, fiscal_year,
        period_start, period_end, budget_amount, currency, notes, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'DRAFT',$13) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, input.branchId ?? ctx.branchId ?? null, input.departmentId ?? null,
      no, input.planName.trim(), input.fiscalYear,
      input.periodStart ?? null, input.periodEnd ?? null,
      round2(num(input.budgetAmount)), input.currency ?? 'UGX', input.notes ?? null, ctx.userId ?? null,
    ]
  );
  const planId = Number(ins.rows[0].id);
  for (const l of input.lines ?? []) {
    const cur = Math.max(0, Math.floor(num(l.currentHeadcount)));
    const planned = Math.max(0, Math.floor(num(l.plannedHeadcount, cur)));
    const departures = Math.max(0, Math.floor(num(l.expectedDepartures)));
    const retirements = Math.max(0, Math.floor(num(l.retirements)));
    const newPositions = Math.max(0, Math.floor(num(l.newPositions)));
    const hiring = Math.max(0, planned - cur + departures + retirements);
    await client.query(
      `INSERT INTO workforce_plan_lines
         (plan_id, company_id, tenant_id, position_id, current_headcount, planned_headcount,
          expected_departures, retirements, new_positions, hiring_requirement, salary_budget, currency, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        planId, ctx.companyId, ctx.tenantId, l.positionId, cur, planned, departures, retirements,
        newPositions, hiring, round2(num(l.salaryBudget)), input.currency ?? 'UGX', l.notes ?? null,
      ]
    );
  }
  await emitEvent(client, ctx, { eventType: 'hr.workforce_plan_created', entityType: 'workforce_plans', entityId: planId, entityCode: no });
  await logAudit(client, ctx, { action: 'create', resource: 'workforce_plans', recordId: planId, recordCode: no });
  return { planId, planNo: no, status: 'DRAFT' };
}

export async function submitWorkforcePlan(client: pg.PoolClient, ctx: Ctx, planId: number) {
  const res = await client.query(
    `UPDATE workforce_plans SET status = 'SUBMITTED', submitted_by = $3, submitted_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT'
     RETURNING plan_no, budget_amount, currency`,
    [planId, ctx.tenantId, ctx.userId ?? null]
  );
  if (res.rows.length === 0) throw badRequest('Workforce plan not found or not DRAFT');
  await startWorkflow(client, ctx, {
    entityType: 'hr.workforce_plans',
    entityId: planId,
    entityCode: String(res.rows[0].plan_no),
    amount: num(res.rows[0].budget_amount),
  });
  return { planId, planNo: res.rows[0].plan_no, status: 'SUBMITTED' };
}

/** Scenario simulation: "what if production expands by X%?" */
export async function runWorkforceScenario(
  client: pg.PoolClient,
  ctx: Ctx,
  planId: number,
  input: {
    name: string;
    growthPct?: number;
    avgMonthlySalary?: number | null;
    benefitsPct?: number;
    trainingCostPerHead?: number;
    monthlyPayrollPerHead?: number | null;
    notes?: string | null;
  }
) {
  const planRes = await client.query(
    `SELECT * FROM workforce_plans WHERE id = $1 AND tenant_id = $2`,
    [planId, ctx.tenantId]
  );
  if (planRes.rows.length === 0) throw notFound('Workforce plan not found');
  const plan = planRes.rows[0];
  const linesRes = await client.query(
    `SELECT wl.*, p.code AS position_code, p.title AS position_title
     FROM workforce_plan_lines wl
     JOIN positions p ON p.id = wl.position_id
     WHERE wl.plan_id = $1 ORDER BY p.code`,
    [planId]
  );
  const lines = linesRes.rows.map((l) => ({
    positionId: Number(l.position_id),
    positionCode: String(l.position_code),
    positionTitle: String(l.position_title),
    current: Number(l.current_headcount),
    planned: Number(l.planned_headcount),
    departures: Number(l.expected_departures),
    retirements: Number(l.retirements),
    newPositions: Number(l.new_positions),
    salaryBudget: Number(l.salary_budget),
    currency: String(l.currency ?? plan.currency ?? 'UGX'),
  }));

  const growth = Math.max(0, num(input.growthPct));
  const baselineHeadcount = lines.reduce((s, l) => s + l.current, 0);
  const baselineSalaryBudget = lines.reduce((s, l) => s + l.salaryBudget, 0);
  const avgSalary = num(input.avgMonthlySalary, baselineHeadcount > 0 ? baselineSalaryBudget / 12 / baselineHeadcount : 0);
  const monthlyPerHead = num(input.monthlyPayrollPerHead, avgSalary);
  const benefitsPct = num(input.benefitsPct, 15);
  const trainingPerHead = num(input.trainingCostPerHead);

  // Employer statutory (NSSF employer share) from versioned config, not hard-coded.
  const atDate = str(plan.period_end) ?? new Date().toISOString().slice(0, 10);
  const nssfCfg = await statutory.getStatutoryConfig(client, ctx, 'NSSF', { effectiveDate: atDate.slice(0, 10) });
  const employerRates = (nssfCfg && nssfCfg.rates && !Array.isArray(nssfCfg.rates) ? nssfCfg.rates : {}) as Record<string, unknown>;
  const employerStatutoryPct = Number(employerRates.employer ?? 0) * 100;

  const lineProjections = lines.map((l) => {
    const additional = Math.ceil((l.current * growth) / 100);
    const hires = additional + l.departures + l.retirements + Math.max(0, l.newPositions);
    return {
      positionId: l.positionId,
      positionCode: l.positionCode,
      positionTitle: l.positionTitle,
      currentHeadcount: l.current,
      plannedHeadcount: l.planned,
      growthHeadcount: additional,
      expectedDepartures: l.departures,
      retirements: l.retirements,
      recruitmentRequirement: hires,
    };
  });

  const additionalHeadcount = lineProjections.reduce((s, x) => s + x.growthHeadcount, 0);
  const recruitmentRequirement = lineProjections.reduce((s, x) => s + x.recruitmentRequirement, 0);
  const annualSalaryImpact = round2(additionalHeadcount * monthlyPerHead * 12);
  const annualBenefitsImpact = round2(annualSalaryImpact * (benefitsPct / 100));
  const annualEmployerStatutory = round2(annualSalaryImpact * (employerStatutoryPct / 100));
  const annualPayrollImpact = round2(annualSalaryImpact + annualBenefitsImpact + annualEmployerStatutory);
  const trainingCost = round2(recruitmentRequirement * trainingPerHead);
  const trainingRequirement = {
    heads: recruitmentRequirement,
    estimatedCost: trainingCost,
    courses: Math.max(1, Math.ceil(recruitmentRequirement / 12)),
  };

  const parameters = {
    growthPct: growth,
    avgMonthlySalary: round2(avgSalary),
    monthlyPayrollPerHead: round2(monthlyPerHead),
    benefitsPct,
    trainingCostPerHead: trainingPerHead,
  };
  const results = {
    baseline: { headcount: baselineHeadcount, annualSalaryBudget: round2(baselineSalaryBudget) },
    projected: {
      headcount: baselineHeadcount + additionalHeadcount,
      recruitmentRequirement,
      additionalHeadcount,
    },
    impact: {
      annualSalary: annualSalaryImpact,
      annualBenefits: annualBenefitsImpact,
      annualEmployerStatutory,
      annualPayroll: annualPayrollImpact,
      training: trainingRequirement,
      currency: lines[0]?.currency ?? 'UGX',
    },
    lines: lineProjections,
  };

  const scenarioNo = await nextDoc(client, ctx, 'SCN');
  await client.query(
    `INSERT INTO workforce_scenarios
       (company_id, tenant_id, plan_id, scenario_no, name, parameters, results, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'SAVED',$8)`,
    [
      ctx.companyId, ctx.tenantId, planId, scenarioNo, input.name ?? 'Scenario',
      JSON.stringify(parameters), JSON.stringify(results), ctx.userId ?? null,
    ]
  );
  await logAudit(client, ctx, { action: 'run_scenario', resource: 'workforce_scenarios', recordId: planId, recordCode: scenarioNo, newValues: { results } });
  return { scenarioNo, parameters, results };
}

/** List workforce plans with headcount / budget rollups. */
export async function listWorkforcePlans(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { status?: string | null; fiscalYear?: number | null; q?: string | null; page?: number; pageSize?: number } = {}
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 40));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['wp.tenant_id = $1', 'wp.company_id = $2'];
  if (filters.status) { params.push(filters.status); where.push(`wp.status = $${params.length}`); }
  if (filters.fiscalYear) { params.push(filters.fiscalYear); where.push(`wp.fiscal_year = $${params.length}`); }
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(wp.plan_no ILIKE $${params.length} OR wp.plan_name ILIKE $${params.length})`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `SELECT wp.*, d.name AS department_name, b.name AS branch_name,
            (SELECT count(*)::int FROM workforce_plan_lines wl WHERE wl.plan_id = wp.id) AS line_count,
            (SELECT COALESCE(sum(wl.current_headcount),0)::int FROM workforce_plan_lines wl WHERE wl.plan_id = wp.id) AS current_headcount,
            (SELECT COALESCE(sum(wl.planned_headcount),0)::int FROM workforce_plan_lines wl WHERE wl.plan_id = wp.id) AS planned_headcount,
            (SELECT COALESCE(sum(wl.hiring_requirement),0)::int FROM workforce_plan_lines wl WHERE wl.plan_id = wp.id) AS hiring_requirement,
            (SELECT count(*)::int FROM workforce_scenarios ws WHERE ws.plan_id = wp.id) AS scenario_count
     FROM workforce_plans wp
     LEFT JOIN departments d ON d.id = wp.department_id
     LEFT JOIN branches b ON b.id = wp.branch_id
     WHERE ${where.join(' AND ')}
     ORDER BY wp.fiscal_year DESC, wp.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const totalRes = await client.query(
    `SELECT count(*)::int AS total FROM workforce_plans wp WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows: toCamelRows(res.rows), page, pageSize, total: Number(totalRes.rows[0].total) };
}

/** Single workforce plan with lines, scenario history and rollups. */
export async function getWorkforcePlan(client: pg.PoolClient, ctx: Ctx, planId: number) {
  const planRes = await client.query(
    `SELECT wp.*, d.name AS department_name, b.name AS branch_name,
            COALESCE(su.first_name || ' ' || su.last_name, '') AS submitted_by_name,
            COALESCE(ap.first_name || ' ' || ap.last_name, '') AS approved_by_name
     FROM workforce_plans wp
     LEFT JOIN departments d ON d.id = wp.department_id
     LEFT JOIN branches b ON b.id = wp.branch_id
     LEFT JOIN users su ON su.id = wp.submitted_by
     LEFT JOIN users ap ON ap.id = wp.approved_by
     WHERE wp.id = $1 AND wp.tenant_id = $2`,
    [planId, ctx.tenantId]
  );
  if (planRes.rows.length === 0) throw notFound('Workforce plan not found');
  const linesRes = await client.query(
    `SELECT wl.*, p.code AS position_code, p.title AS position_title
     FROM workforce_plan_lines wl
     JOIN positions p ON p.id = wl.position_id
     WHERE wl.plan_id = $1 ORDER BY p.code`,
    [planId]
  );
  const scenariosRes = await client.query(
    `SELECT id, scenario_no, name, parameters, results, created_at
     FROM workforce_scenarios WHERE plan_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [planId]
  );
  const lines = linesRes.rows.map((l) => {
    const current = Number(l.current_headcount);
    const planned = Number(l.planned_headcount);
    return {
      ...toCamelRow(l),
      positionCode: String(l.position_code),
      positionTitle: String(l.position_title),
      gap: Math.max(0, planned - current),
      currentHeadcount: current,
      plannedHeadcount: planned,
      hiringRequirement: Number(l.hiring_requirement),
      salaryBudget: Number(l.salary_budget),
    };
  });
  const totals = lines.reduce(
    (t, l) => ({
      currentHeadcount: t.currentHeadcount + l.currentHeadcount,
      plannedHeadcount: t.plannedHeadcount + l.plannedHeadcount,
      gap: t.gap + l.gap,
      hiringRequirement: t.hiringRequirement + l.hiringRequirement,
      salaryBudget: t.salaryBudget + l.salaryBudget,
    }),
    { currentHeadcount: 0, plannedHeadcount: 0, gap: 0, hiringRequirement: 0, salaryBudget: 0 }
  );
  return {
    plan: toCamelRow(planRes.rows[0]),
    lines,
    totals,
    scenarios: toCamelRows(scenariosRes.rows),
  };
}


// ============================================================
// RECRUITMENT / ATS
// ============================================================

const ATS_STAGES = ['SUBMITTED', 'SCREENING', 'SHORTLISTED', 'INTERVIEW', 'ASSESSMENT', 'REFERENCE_CHECK', 'OFFER', 'ACCEPTED', 'REJECTED', 'WITHDRAWN'];
const stageSeq = (s: string) => Math.max(1, ATS_STAGES.indexOf(s) + 1);

/** Create a job requisition from a workforce plan / position. */
export async function createRequisition(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    title: string;
    departmentId?: number | null;
    branchId?: number | null;
    positionId?: number | null;
    jobFamilyId?: number | null;
    jobGradeId?: number | null;
    employmentType?: string;
    headcount?: number;
    salaryMin?: number | null;
    salaryMax?: number | null;
    currency?: string;
    justification?: string | null;
    budgetCode?: string | null;
    hiringManagerId?: number | null;
    requiredQualifications?: string | null;
    requiredSkills?: string[] | null;
    experienceYears?: number | null;
    jobDescription?: string | null;
    isReplacement?: boolean;
    requiredDate?: string | null;
  }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  if (!input.title?.trim()) throw badRequest('Requisition title is required');
  const no = await nextDoc(client, ctx, 'REQ');
  const ins = await client.query(
    `INSERT INTO job_requisitions
       (company_id, tenant_id, branch_id, department_id, position_id, requisition_no, title,
        job_family_id, job_grade_id, employment_type, headcount, salary_min, salary_max, currency,
        justification, budget_code, status, hiring_manager_id, required_qualifications,
        required_skills, experience_years, job_description, is_replacement, required_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'DRAFT',$17,$18,$19,$20,$21,$22,$23)
     RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, input.branchId ?? ctx.branchId ?? null, input.departmentId ?? null,
      input.positionId ?? null, no, input.title.trim(), input.jobFamilyId ?? null,
      input.jobGradeId ?? null, requisitionEmploymentType(input.employmentType), Math.max(1, num(input.headcount, 1)),
      input.salaryMin ?? null, input.salaryMax ?? null, input.currency ?? 'UGX',
      str(input.justification), str(input.budgetCode), input.hiringManagerId ?? null,
      str(input.requiredQualifications), JSON.stringify(input.requiredSkills ?? []),
      input.experienceYears ?? null, str(input.jobDescription), bool(input.isReplacement),
      str(input.requiredDate),
    ]
  );
  const requisitionId = Number(ins.rows[0].id);
  await logAudit(client, ctx, { action: 'create', resource: 'job_requisitions', recordId: requisitionId, recordCode: no });
  await emitEvent(client, ctx, { eventType: 'hr.requisition_created', entityType: 'job_requisitions', entityId: requisitionId, entityCode: no });
  return { requisitionId, requisitionNo: no, status: 'DRAFT' };
}

/** Submit a requisition for approval (DRAFT -> SUBMITTED) and start the configured workflow. */
export async function submitRequisition(client: pg.PoolClient, ctx: Ctx, requisitionId: number) {
  const res = await client.query(
    `UPDATE job_requisitions SET status = 'SUBMITTED', submitted_by = $3, submitted_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT' RETURNING requisition_no, headcount, salary_max, title`,
    [requisitionId, ctx.tenantId, ctx.userId ?? null]
  );
  if (res.rows.length === 0) throw badRequest('Requisition not found or not in DRAFT');
  const row = res.rows[0];
  const indicative = Number(row.headcount ?? 1) * (Number(row.salary_max ?? 0) || 0);
  await startWorkflow(client, ctx, {
    entityType: 'hr.requisitions',
    entityId: requisitionId,
    entityCode: String(row.requisition_no),
    amount: indicative,
  });
  await logAudit(client, ctx, { action: 'submit', resource: 'job_requisitions', recordId: requisitionId, recordCode: String(row.requisition_no) });
  return { requisitionId, requisitionNo: row.requisition_no, status: 'SUBMITTED' };
}

/** Create a vacancy against an APPROVED requisition. */
export async function createVacancy(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    requisitionId: number;
    positionId?: number | null;
    locationId?: number | null;
    title?: string;
    description?: string | null;
    openings?: number;
    closesAt?: string | null;
    externalUrl?: string | null;
    applyUrl?: string | null;
    isInternal?: boolean;
    isExternal?: boolean;
  }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const reqRes = await client.query(
    `SELECT * FROM job_requisitions WHERE id = $1 AND tenant_id = $2`,
    [input.requisitionId, ctx.tenantId]
  );
  if (reqRes.rows.length === 0) throw notFound('Requisition not found');
  const req = reqRes.rows[0];
  if (req.status !== 'APPROVED') throw badRequest('Requisition must be APPROVED before creating a vacancy');
  const no = await nextDoc(client, ctx, 'VAC');
  const ins = await client.query(
    `INSERT INTO vacancies
       (company_id, tenant_id, requisition_id, position_id, location_id, vacancy_no, title, description,
        openings, filled, status, closes_at, external_url, is_internal, is_external, apply_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,'DRAFT',$10,$11,$12,$13,$14) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, input.requisitionId, input.positionId ?? req.position_id ?? null,
      input.locationId ?? null, no, input.title ?? String(req.title), str(input.description),
      Math.max(1, num(input.openings, 1)), str(input.closesAt), str(input.externalUrl),
      bool(input.isInternal, true), bool(input.isExternal, true), str(input.applyUrl),
    ]
  );
  const vacancyId = Number(ins.rows[0].id);
  await logAudit(client, ctx, { action: 'create', resource: 'vacancies', recordId: vacancyId, recordCode: no });
  return { vacancyId, vacancyNo: no, status: 'DRAFT' };
}

/** Publish a vacancy and register its recruitment channels. */
export async function publishVacancy(
  client: pg.PoolClient,
  ctx: Ctx,
  vacancyId: number,
  input: {
    closesAt?: string | null;
    channels?: Array<{ channelType: string; provider?: string | null; url?: string | null }>;
  } = {}
) {
  const res = await client.query(
    `UPDATE vacancies SET status = 'PUBLISHED', published_at = now(), closes_at = COALESCE($3, closes_at)
     WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT' RETURNING vacancy_no, is_internal, is_external`,
    [vacancyId, ctx.tenantId, str(input.closesAt)]
  );
  if (res.rows.length === 0) throw badRequest('Vacancy not found or not DRAFT');
  const row = res.rows[0];
  const channels = input.channels && input.channels.length
    ? input.channels
    : [
        ...(row.is_internal ? [{ channelType: 'INTERNAL_PORTAL' }] : []),
        ...(row.is_external ? [{ channelType: 'EXTERNAL_PORTAL' }] : []),
      ];
  for (const ch of channels) {
    await client.query(
      `INSERT INTO vacancy_channels (company_id, tenant_id, vacancy_id, channel_type, provider, url, status, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE', now())`,
      [ctx.companyId, ctx.tenantId, vacancyId, String(ch.channelType), str(ch.provider), str(ch.url)]
    );
  }
  await logAudit(client, ctx, { action: 'publish', resource: 'vacancies', recordId: vacancyId, recordCode: String(row.vacancy_no) });
  await emitEvent(client, ctx, { eventType: 'hr.vacancy_published', entityType: 'vacancies', entityId: vacancyId, entityCode: String(row.vacancy_no) });
  return { vacancyId, vacancyNo: row.vacancy_no, status: 'PUBLISHED', channels: channels.length };
}

/** Track a public view of a published vacancy (career portal analytics). */
export async function trackVacancyView(
  client: pg.PoolClient,
  ctx: Ctx,
  vacancyId: number,
  input: { source?: string | null; referrer?: string | null; userAgent?: string | null; viewDate?: string | null } = {}
) {
  const res = await client.query(
    `UPDATE vacancies SET views_count = views_count + 1
     WHERE id = $1 AND tenant_id = $2 AND status = 'PUBLISHED' RETURNING vacancy_no`,
    [vacancyId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Published vacancy not found');
  await client.query(
    `INSERT INTO vacancy_views (company_id, tenant_id, vacancy_id, view_date, source, referrer, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ctx.companyId, ctx.tenantId, vacancyId, input.viewDate ?? new Date().toISOString().slice(0, 10), str(input.source), str(input.referrer), str(input.userAgent)]
  );
  return { vacancyId, vacancyNo: res.rows[0].vacancy_no, viewed: true };
}

/** Apply to a vacancy: upsert the candidate by email, then create the application. */
export async function applyToVacancy(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    vacancyId: number;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string | null;
    source?: string | null;
    currentEmployer?: string | null;
    currentTitle?: string | null;
    coverLetter?: string | null;
    expectedSalary?: number | null;
    currency?: string;
    noticePeriodDays?: number | null;
    resumeDocumentId?: number | null;
  }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const vac = await client.query(
    `SELECT * FROM vacancies WHERE id = $1 AND tenant_id = $2 AND status = 'PUBLISHED'`,
    [input.vacancyId, ctx.tenantId]
  );
  if (vac.rows.length === 0) throw badRequest('Vacancy not found or not open');
  if (Number(vac.rows[0].filled) >= Number(vac.rows[0].openings)) throw badRequest('Vacancy has no remaining openings');
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!email) throw badRequest('Candidate email is required');
  const existing = await client.query(
    `SELECT id FROM candidates WHERE tenant_id = $1 AND company_id = $2 AND lower(email) = $3`,
    [ctx.tenantId, ctx.companyId, email]
  );
  let candidateId = existing.rows.length ? Number(existing.rows[0].id) : null;
  if (!candidateId) {
    const cIns = await client.query(
      `INSERT INTO candidates (company_id, tenant_id, first_name, last_name, email, phone, source, current_employer, current_title, resume_document_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTIVE') RETURNING id`,
      [
        ctx.companyId, ctx.tenantId, String(input.firstName).trim(), String(input.lastName).trim(), email,
        str(input.phone), str(input.source), str(input.currentEmployer), str(input.currentTitle),
        input.resumeDocumentId ?? null,
      ]
    );
    candidateId = Number(cIns.rows[0].id);
  }
  const dup = await client.query(
    `SELECT id FROM candidate_applications WHERE tenant_id = $1 AND candidate_id = $2 AND vacancy_id = $3`,
    [ctx.tenantId, candidateId, input.vacancyId]
  );
  if (dup.rows.length) throw badRequest('Candidate has already applied to this vacancy');
  const no = await nextDoc(client, ctx, 'APP');
  const ins = await client.query(
    `INSERT INTO candidate_applications
       (company_id, tenant_id, candidate_id, vacancy_id, application_no, cover_letter, expected_salary,
        currency, notice_period_days, stage_seq, status, applied_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,'SUBMITTED', now()) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, candidateId, input.vacancyId, no, str(input.coverLetter),
      input.expectedSalary ?? null, input.currency ?? 'UGX', input.noticePeriodDays ?? null,
    ]
  );
  const applicationId = Number(ins.rows[0].id);
  await client.query(
    `UPDATE vacancies SET applications_count = applications_count + 1 WHERE id = $1`,
    [input.vacancyId]
  );
  await emitEvent(client, ctx, { eventType: 'hr.application_submitted', entityType: 'candidate_applications', entityId: applicationId, entityCode: no });
  await logAudit(client, ctx, { action: 'create', resource: 'candidate_applications', recordId: applicationId, recordCode: no });
  return { applicationId, applicationNo: no, candidateId, status: 'SUBMITTED' };
}

/** ATS Kanban pipeline: applications grouped by stage column. */
export async function applicationPipeline(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { vacancyId?: number | null; q?: string | null } = {}
) {
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['ca.tenant_id = $1', 'ca.company_id = $2'];
  if (filters.vacancyId) { params.push(filters.vacancyId); where.push(`ca.vacancy_id = $${params.length}`); }
  if (filters.q) {
    params.push(`%${String(filters.q).toLowerCase()}%`);
    where.push(`(lower(c.first_name || ' ' || c.last_name) LIKE $${params.length} OR lower(c.email) LIKE $${params.length})`);
  }
  const res = await client.query(
    `SELECT ca.id, ca.application_no, ca.status, ca.current_rating, ca.applied_at,
            c.id AS candidate_id, c.first_name, c.last_name, c.email, c.phone, c.source, c.current_title,
            v.id AS vacancy_id, v.vacancy_no, v.title AS vacancy_title
     FROM candidate_applications ca
     JOIN candidates c ON c.id = ca.candidate_id
     JOIN vacancies v ON v.id = ca.vacancy_id
     WHERE ${where.join(' AND ')}
     ORDER BY ca.applied_at DESC`,
    params
  );
  const columns = [
    { stage: 'APPLIED', status: 'SUBMITTED' },
    { stage: 'SCREENING', status: 'SCREENING' },
    { stage: 'SHORTLISTED', status: 'SHORTLISTED' },
    { stage: 'INTERVIEW', status: 'INTERVIEW' },
    { stage: 'ASSESSMENT', status: 'ASSESSMENT' },
    { stage: 'REFERENCE_CHECK', status: 'REFERENCE_CHECK' },
    { stage: 'OFFER', status: 'OFFER' },
    { stage: 'HIRED', status: 'ACCEPTED' },
    { stage: 'REJECTED', status: 'REJECTED' },
  ];
  const byStatus = new Map<string, Array<Record<string, unknown>>>();
  for (const row of res.rows) {
    const key = String(row.status);
    if (!byStatus.has(key)) byStatus.set(key, []);
    byStatus.get(key)!.push(toCamelRow(row));
  }
  return columns.map((col) => ({
    stage: col.stage,
    status: col.status,
    count: byStatus.get(col.status)?.length ?? 0,
    applications: byStatus.get(col.status) ?? [],
  }));
}

/** Advance (or reject/withdraw) an application along the ATS pipeline. */
export async function advanceApplication(
  client: pg.PoolClient,
  ctx: Ctx,
  applicationId: number,
  input: { targetStage?: string | null; rating?: number | null; note?: string | null }
) {
  const res = await client.query(
    `SELECT * FROM candidate_applications WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [applicationId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Application not found');
  const app = res.rows[0];
  const current = String(app.status);
  const target = String(input.targetStage ?? ATS_STAGES[stageSeq(current)]) || 'REJECTED';
  const term = ['REJECTED', 'WITHDRAWN'].includes(target);
  if (current === 'ACCEPTED' || current === 'REJECTED' || current === 'WITHDRAWN') {
    throw badRequest(`Application is already ${current}`);
  }
  if (!term && ATS_STAGES.indexOf(current) >= ATS_STAGES.indexOf(target)) {
    throw badRequest(`Cannot move application from ${current} to ${target}`);
  }
 await client.query(
   `UPDATE candidate_applications SET status = $3, stage_seq = $4, current_rating = COALESCE($5, current_rating)
    WHERE id = $1 AND tenant_id = $2`,
   [applicationId, ctx.tenantId, target, stageSeq(target), input.rating ?? null]
 );
  await logAudit(client, ctx, {
    action: 'advance',
    resource: 'candidate_applications',
    recordId: applicationId,
    recordCode: String(app.application_no),
    newValues: { from: current, to: target, note: input.note ?? null },
  });
 return { applicationId, from: current, to: target };
}

/** Schedule an interview for an application. */
export async function scheduleInterview(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    applicationId: number;
    scheduledAt: string;
    mode?: string;
    interviewerIds?: number[];
    durationMinutes?: number | null;
    location?: string | null;
  }
) {
  const app = await client.query(
    `SELECT * FROM candidate_applications WHERE id = $1 AND tenant_id = $2`,
    [input.applicationId, ctx.tenantId]
  );
  if (app.rows.length === 0) throw notFound('Application not found');
  if (['ACCEPTED', 'REJECTED', 'WITHDRAWN'].includes(String(app.rows[0].status))) throw badRequest('Application is closed');
  const no = await nextDoc(client, ctx, 'INT');
  const ins = await client.query(
    `INSERT INTO interviews
       (company_id, tenant_id, application_id, interview_no, scheduled_at, mode, interviewer_ids,
        duration_minutes, location, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SCHEDULED') RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, input.applicationId, no, String(input.scheduledAt),
      input.mode ?? 'IN_PERSON', JSON.stringify(input.interviewerIds ?? []),
      input.durationMinutes ?? 45, str(input.location),
    ]
  );
  const interviewId = Number(ins.rows[0].id);
  if (stageSeq(String(app.rows[0].status)) < stageSeq('INTERVIEW')) {
    await client.query(
      `UPDATE candidate_applications SET status = 'INTERVIEW', stage_seq = $2 WHERE id = $1`,
      [input.applicationId, stageSeq('INTERVIEW')]
    );
  }
  return { interviewId, interviewNo: no };
}

/** Record an assessment result against an application. */
export async function recordAssessment(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    applicationId: number;
    type?: string;
    score?: number | null;
    maxScore?: number | null;
    result?: string;
    assessedAt?: string | null;
    notes?: string | null;
  }
) {
  const app = await client.query(
    `SELECT 1 FROM candidate_applications WHERE id = $1 AND tenant_id = $2`,
    [input.applicationId, ctx.tenantId]
  );
  if (app.rows.length === 0) throw notFound('Application not found');
  const no = await nextDoc(client, ctx, 'ASM');
  const ins = await client.query(
    `INSERT INTO assessments
       (company_id, tenant_id, application_id, assessment_no, type, score, max_score, result, assessed_at, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, input.applicationId, no, input.type ?? 'TECHNICAL',
      input.score ?? null, input.maxScore ?? null, input.result ?? 'PENDING',
      input.assessedAt ?? new Date().toISOString().slice(0, 10), str(input.notes),
    ]
  );
  return { assessmentId: Number(ins.rows[0].id), assessmentNo: no };
}

/** Create a job offer (DRAFT) for a candidate application. */
export async function createOffer(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    applicationId: number;
    positionId?: number | null;
    baseSalary: number;
    allowances?: Record<string, number>;
    benefits?: string | null;
    currency?: string;
    contractType?: string;
    startDate?: string | null;
    probationMonths?: number;
    expiresAt?: string | null;
  }
) {
  const app = await client.query(
    `SELECT * FROM candidate_applications WHERE id = $1 AND tenant_id = $2`,
    [input.applicationId, ctx.tenantId]
  );
  if (app.rows.length === 0) throw notFound('Application not found');
  if (['ACCEPTED', 'REJECTED', 'WITHDRAWN'].includes(String(app.rows[0].status))) throw badRequest('Application is closed');
  const no = await nextDoc(client, ctx, 'OFF');
  const ins = await client.query(
    `INSERT INTO job_offers
       (company_id, tenant_id, application_id, candidate_id, position_id, offer_no, base_salary,
        allowances, benefits, currency, contract_type, start_date, probation_months, status, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'DRAFT',$14,$15) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, input.applicationId, Number(app.rows[0].candidate_id),
      input.positionId ?? null, no, Number(input.baseSalary ?? 0),
      JSON.stringify(input.allowances ?? {}), str(input.benefits) ?? '{}', input.currency ?? 'UGX',
      input.contractType ?? 'FULL_TIME', str(input.startDate), num(input.probationMonths, 6),
      str(input.expiresAt), ctx.userId ?? null,
    ]
  );
  const offerId = Number(ins.rows[0].id);
  await logAudit(client, ctx, { action: 'create', resource: 'job_offers', recordId: offerId, recordCode: no });
  return { offerId, offerNo: no, status: 'DRAFT' };
}

/** Send an offer (DRAFT -> SENT) and move the application to the OFFER stage. */
export async function sendOffer(
  client: pg.PoolClient,
  ctx: Ctx,
  offerId: number,
  input: { expiresAt?: string | null } = {}
) {
  const res = await client.query(
    `UPDATE job_offers SET status = 'SENT', sent_at = now(), expires_at = COALESCE($3, expires_at, now() + interval '14 days')
     WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT' RETURNING offer_no, application_id`,
    [offerId, ctx.tenantId, str(input.expiresAt)]
  );
  if (res.rows.length === 0) throw badRequest('Offer not found or not DRAFT');
  const row = res.rows[0];
  await client.query(
    `UPDATE candidate_applications SET status = 'OFFER', stage_seq = $2 WHERE id = $1`,
    [Number(row.application_id), stageSeq('OFFER')]
  );
  await emitEvent(client, ctx, {
    eventType: 'hr.offer_sent',
    entityType: 'job_offers',
    entityId: offerId,
    entityCode: String(row.offer_no),
    payload: { applicationId: Number(row.application_id) },
  });
  return { offerId, offerNo: row.offer_no, status: 'SENT' };
}

export async function withdrawOffer(client: pg.PoolClient, ctx: Ctx, offerId: number) {
  const res = await client.query(
    `UPDATE job_offers SET status = 'WITHDRAWN' WHERE id = $1 AND tenant_id = $2 AND status IN ('DRAFT','SENT') RETURNING offer_no`,
    [offerId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Offer not found or not actionable');
  return { offerId, offerNo: res.rows[0].offer_no, status: 'WITHDRAWN' };
}

export async function declineOffer(client: pg.PoolClient, ctx: Ctx, offerId: number, reason?: string | null) {
  const res = await client.query(
    `UPDATE job_offers SET status = 'DECLINED', responded_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'SENT' RETURNING offer_no, application_id`,
    [offerId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Offer not found or not SENT');
  const row = res.rows[0];
  await client.query(
    `UPDATE candidate_applications SET status = 'REJECTED', stage_seq = $2 WHERE id = $1`,
    [Number(row.application_id), stageSeq('REJECTED')]
  );
  if (reason) await logAudit(client, ctx, { action: 'decline', resource: 'job_offers', recordId: offerId, recordCode: String(row.offer_no), newValues: { reason } });
  return { offerId, offerNo: row.offer_no, status: 'DECLINED' };
}

/** Accept an offer and convert the candidate into an employee (hire). */
export async function acceptOffer(
  client: pg.PoolClient,
  ctx: Ctx,
  offerId: number,
  input: { startDate?: string | null; employeeNo?: string | null; notes?: string | null } = {}
) {
  const offerRes = await client.query(
    `SELECT * FROM job_offers WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [offerId, ctx.tenantId]
  );
  if (offerRes.rows.length === 0) throw notFound('Offer not found');
  const offer = offerRes.rows[0];
  if (offer.status !== 'SENT') throw badRequest('Offer must be SENT before acceptance');
  const appRes = await client.query(
    `SELECT * FROM candidate_applications WHERE id = $1 AND tenant_id = $2`,
    [Number(offer.application_id), ctx.tenantId]
  );
  if (appRes.rows.length === 0) throw notFound('Application not found');
  const app = appRes.rows[0];
  const candRes = await client.query(
    `SELECT * FROM candidates WHERE id = $1 AND tenant_id = $2`,
    [Number(offer.candidate_id), ctx.tenantId]
  );
  if (candRes.rows.length === 0) throw notFound('Candidate not found');
  const cand = candRes.rows[0];
  const posRes = await client.query(
    `SELECT * FROM positions WHERE id = $1 AND tenant_id = $2`,
    [Number(offer.position_id), ctx.tenantId]
  );
  const pos = posRes.rows[0] ?? null;
  const startDate = str(input.startDate) ?? str(offer.start_date) ?? new Date().toISOString().slice(0, 10);
  const probationMonths = num(offer.probation_months, 0);
  const employeeNo = str(input.employeeNo) ?? (await nextDoc(client, ctx, 'EMP'));
  const status = probationMonths > 0 ? 'PROBATION' : 'ACTIVE';
  let probationEnd: string | null = null;
  if (probationMonths > 0) {
    const d = new Date(startDate + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + probationMonths);
    probationEnd = d.toISOString().slice(0, 10);
  }
  const empRes = await client.query(
    `INSERT INTO employees
       (company_id, tenant_id, branch_id, department_id, position_id, division_id, org_unit_id, team_id,
        location_id, job_family_id, job_grade_id, cost_centre_id, employee_no, first_name, last_name,
        email, phone, position, hire_date, salary_type, base_salary, status, employment_type, probation_end_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'MONTHLY',$20,$21,$22,$23)
     RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, pos ? pos.branch_id : ctx.branchId ?? null, pos ? pos.department_id : null,
      Number(offer.position_id), pos ? pos.division_id : null, pos ? pos.org_unit_id : null, pos ? pos.team_id : null,
      pos ? pos.location_id : null, pos ? pos.job_family_id : null, pos ? pos.job_grade_id : null, pos ? pos.cost_centre_id : null,
      employeeNo, String(cand.first_name), String(cand.last_name), String(cand.email ?? ''), str(cand.phone),
      pos ? String(pos.title) : null, startDate, Number(offer.base_salary ?? 0), status,
      contractType(offer.contract_type), probationEnd,
    ]
  );
  const employeeId = Number(empRes.rows[0].id);
  await client.query(
    `INSERT INTO employment_contracts (employee_id, contract_type, start_date, salary, allowances, status)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE')`,
    [employeeId, contractType(offer.contract_type), startDate, Number(offer.base_salary ?? 0), JSON.stringify(offer.allowances ?? {})]
  );
  await client.query(
    `INSERT INTO position_assignments
       (company_id, tenant_id, employee_id, position_id, effective_from, assignment_type, is_primary, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,'HIRE', true, $6, $7)`,
    [ctx.companyId, ctx.tenantId, employeeId, Number(offer.position_id), startDate, str(input.notes), ctx.userId ?? null]
  );
  // Onboarding: create the instance from the first ACTIVE checklist.
  let checklistId: number | null = null;
  const clRes = await client.query(
    `SELECT id FROM onboarding_checklists WHERE company_id = $1 AND tenant_id = $2 AND status = 'ACTIVE' ORDER BY id LIMIT 1`,
    [ctx.companyId, ctx.tenantId]
  );
  let instanceId: number | null = null;
  if (clRes.rows.length) {
    checklistId = Number(clRes.rows[0].id);
    const tasks = await client.query(
      `SELECT * FROM onboarding_tasks WHERE checklist_id = $1 AND status = 'ACTIVE' ORDER BY sort_order, id`,
      [checklistId]
    );
    const no = await nextDoc(client, ctx, 'OB');
    const ins = await client.query(
      `INSERT INTO onboarding_instances (company_id, tenant_id, employee_id, offer_id, checklist_id, instance_no, status)
       VALUES ($1,$2,$3,$4,$5,$6,'PENDING') RETURNING id`,
      [ctx.companyId, ctx.tenantId, employeeId, offerId, checklistId, no]
    );
    instanceId = Number(ins.rows[0].id);
    for (const t of tasks.rows) {
      await client.query(
        `INSERT INTO onboarding_instance_tasks (instance_id, task_id, status) VALUES ($1,$2,'PENDING')
         ON CONFLICT (instance_id, task_id) DO NOTHING`,
        [instanceId, Number(t.id)]
      );
    }
  }
  // Update offer, application, vacancy.
  await client.query(
    `UPDATE job_offers SET status = 'ACCEPTED', responded_at = now() WHERE id = $1`,
    [offerId]
  );
  await client.query(
    `UPDATE candidate_applications SET status = 'ACCEPTED', stage_seq = $2 WHERE id = $1`,
    [Number(offer.application_id), stageSeq('ACCEPTED')]
  );
  await client.query(
    `UPDATE candidates SET status = 'ARCHIVED' WHERE id = $1`,
    [Number(offer.candidate_id)]
  );
  await client.query(
    `UPDATE vacancies SET filled = filled + 1,
        status = CASE WHEN filled + 1 >= openings THEN 'CLOSED' ELSE status END
     WHERE id = $1`,
    [Number(app.vacancy_id)]
  );
  await emitEvent(client, ctx, { eventType: 'hr.employee_hired', entityType: 'employees', entityId: employeeId, entityCode: employeeNo, payload: { offerId, candidateId: Number(offer.candidate_id) } });
  await logAudit(client, ctx, { action: 'hire', resource: 'job_offers', recordId: offerId, recordCode: String(offer.offer_no), newValues: { employeeId, employeeNo, startDate } });
  return { offerId, employeeId, employeeNo, startDate, status, onboardingInstanceId: instanceId };
}

/** Recruitment pipeline: vacancies with candidates and stage counts. */
export async function listVacancyPipeline(client: pg.PoolClient, ctx: Ctx, vacancyId?: number | null, status?: string | null) {
  const where: string[] = ['v.tenant_id = $1', 'v.company_id = $2'];
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  if (vacancyId) { params.push(vacancyId); where.push(`v.id = $${params.length}`); }
  if (status) { params.push(status); where.push(`v.status = $${params.length}`); }
  const vacRes = await client.query(
    `SELECT v.*, r.requisition_no, r.title AS requisition_title,
        (SELECT count(*)::int FROM candidate_applications ca WHERE ca.vacancy_id = v.id) AS total_applications
     FROM vacancies v
     LEFT JOIN job_requisitions r ON r.id = v.requisition_id
     WHERE ${where.join(' AND ')} ORDER BY v.created_at DESC LIMIT 100`,
    params
  );
  const vacancies = [];
  for (const v of vacRes.rows) {
    const appsRes = await client.query(
      `SELECT ca.id, ca.application_no, ca.status, ca.stage_seq, ca.expected_salary, ca.currency, ca.applied_at,
              c.first_name, c.last_name, c.email, c.phone, c.current_title, c.current_employer
       FROM candidate_applications ca
       JOIN candidates c ON c.id = ca.candidate_id
       WHERE ca.vacancy_id = $1 ORDER BY ca.applied_at DESC`,
      [Number(v.id)]
    );
    const stageCounts: Record<string, number> = {};
    for (const a of appsRes.rows) stageCounts[String(a.status)] = (stageCounts[String(a.status)] ?? 0) + 1;
    vacancies.push({ ...toCamelRow(v), applications: toCamelRows(appsRes.rows), stageCounts });
  }
  return vacancies;
}

/** Attach an existing document to a candidate profile (CV/resume or supporting document). */
export async function attachCandidateDocument(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { candidateId: number; documentId: number; isResume?: boolean }
) {
  const cand = await client.query(
    `SELECT 1 FROM candidates WHERE id = $1 AND tenant_id = $2`,
    [input.candidateId, ctx.tenantId]
  );
  if (cand.rows.length === 0) throw notFound('Candidate not found');
  const doc = await client.query(
    `SELECT 1 FROM documents WHERE id = $1 AND tenant_id = $2`,
    [input.documentId, ctx.tenantId]
  );
  if (doc.rows.length === 0) throw notFound('Document not found');
  await client.query(
    `INSERT INTO document_links (document_id, entity_type, entity_id)
     VALUES ($1, 'candidates', $2)
     ON CONFLICT (document_id, entity_type, entity_id) DO NOTHING`,
    [input.documentId, input.candidateId]
  );
  if (input.isResume) {
    await client.query(
      `UPDATE candidates SET resume_document_id = $1 WHERE id = $2 AND tenant_id = $3`,
      [input.documentId, input.candidateId, ctx.tenantId]
    );
  }
  return { candidateId: input.candidateId, documentId: input.documentId, isResume: !!input.isResume };
}

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** Upload a PDF CV/document, store it under tenant-scoped storage and link it to a candidate. */
export async function uploadCandidateDocument(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { candidateId: number; file: UploadedFile; title?: string | null; category?: string | null; isResume?: boolean }
) {
  const cand = await client.query(
    `SELECT id, company_id FROM candidates WHERE id = $1 AND tenant_id = $2`,
    [input.candidateId, ctx.tenantId]
  );
  if (cand.rows.length === 0) throw notFound('Candidate not found');

  const file = input.file;
  if (!file || !file.buffer || file.buffer.length === 0) throw badRequest('A file is required');
  if (file.size > MAX_DOCUMENT_BYTES) throw badRequest('File exceeds the 10 MB limit');
  const originalName = String(file.originalname ?? 'document.pdf').replace(/[\\/]/g, '_');
  const isPdf = file.mimetype === 'application/pdf' || /\.pdf$/i.test(originalName);
  if (!isPdf) throw badRequest('Only PDF documents are supported');

  const checksum = createHash('sha256').update(file.buffer).digest('hex');
  const parsed = parsePdf(file.buffer);
  if (!parsed.ok) throw badRequest(parsed.error ?? 'Invalid PDF file');

  const isResume = input.isResume === true;
  const title = (input.title ?? '').trim() || originalName.replace(/\.pdf$/i, '');
  const category = (input.category ?? '').trim() || (isResume ? 'CV' : 'DOCUMENT');
  const companyId = Number(cand.rows[0].company_id);
  const docNo = await nextDoc(client, ctx, isResume ? `CV${companyId}` : `DOC${companyId}`);
  const safeName = originalName.replace(/[^A-Za-z0-9._-]+/g, '_');
  const relDir = `hr/${ctx.tenantId}/${input.candidateId}`;
  const storageKey = `${relDir}/${docNo}-${safeName}`;
  mkdirSync(path.join(config.storageRoot, relDir), { recursive: true });
  writeFileSync(path.join(config.storageRoot, storageKey), file.buffer);

  const attributes = {
    pdf: {
      version: parsed.version,
      pageCount: parsed.pageCount,
      encrypted: parsed.encrypted,
      title: parsed.metadata.title,
      author: parsed.metadata.author,
      textExcerpt: parsed.text.slice(0, 4000),
      textLength: parsed.textLength,
      parsedAt: new Date().toISOString(),
    },
  };

  const ins = await client.query(
    `INSERT INTO documents
       (company_id, tenant_id, doc_no, title, description, category, file_name, mime_type,
        file_size, storage_key, checksum, status, uploaded_by, attributes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'SUBMITTED',$12,$13)
     RETURNING *`,
    [companyId, ctx.tenantId, docNo, title, null, category, originalName, 'application/pdf',
     file.buffer.length, storageKey, checksum, ctx.userId ?? null, JSON.stringify(attributes)]
  );
  const doc = toCamelRow(ins.rows[0]);
  const documentId = Number(doc.id);

  await client.query(
    `INSERT INTO document_links (document_id, entity_type, entity_id)
     VALUES ($1, 'candidates', $2)
     ON CONFLICT (document_id, entity_type, entity_id) DO NOTHING`,
    [documentId, input.candidateId]
  );
  if (isResume) {
    await client.query(
      `UPDATE candidates SET resume_document_id = $1 WHERE id = $2 AND tenant_id = $3`,
      [documentId, input.candidateId, ctx.tenantId]
    );
  }

  await logAudit(client, ctx, {
    action: 'upload',
    resource: 'documents',
    recordId: documentId,
    recordCode: docNo,
    newValues: {
      candidateId: input.candidateId,
      category,
      isResume,
      pageCount: parsed.pageCount,
      textLength: parsed.textLength,
      encrypted: parsed.encrypted,
      checksum,
    },
  });

  return { ...doc, isResume, attributes };
}

/** Stream a candidate document from tenant-scoped storage. */
export async function getCandidateDocumentFile(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { candidateId: number; documentId: number }
) {
  const linked = await client.query(
    `SELECT d.* FROM documents d
     JOIN document_links dl ON dl.document_id = d.id
     WHERE dl.entity_type = 'candidates' AND dl.entity_id = $1
       AND d.id = $2 AND d.tenant_id = $3`,
    [input.candidateId, input.documentId, ctx.tenantId]
  );
  if (linked.rows.length === 0) throw notFound('Document not found for this candidate');
  const doc = toCamelRow(linked.rows[0]);
  const storageKey = String(doc.storageKey ?? '');
  if (!storageKey) throw notFound('Document has no stored file');

  const root = path.resolve(config.storageRoot);
  const abs = path.resolve(root, storageKey);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw badRequest('Invalid document storage path');
  }
  let buffer: Buffer;
  try {
    buffer = readFileSync(abs);
  } catch {
    throw notFound('Document file not found on storage');
  }
  await logAudit(client, ctx, {
    action: 'download',
    resource: 'documents',
    recordId: input.documentId,
    recordCode: String(doc.docNo ?? ''),
    metadata: { candidateId: input.candidateId },
  });
  return { buffer, doc };
}

/** Full candidate record with applications, interviews, assessments and offers. */
export async function getCandidate(client: pg.PoolClient, ctx: Ctx, candidateId: number) {
 const res = await client.query(
   `SELECT * FROM candidates WHERE id = $1 AND tenant_id = $2`,
   [candidateId, ctx.tenantId]
 );
 if (res.rows.length === 0) throw notFound('Candidate not found');

  // Candidate documents: linked documents plus the resume/CV when set.
  const linked = await client.query(
    `SELECT d.* FROM documents d
     JOIN document_links dl ON dl.document_id = d.id
     WHERE dl.entity_type = 'candidates' AND dl.entity_id = $1 AND d.tenant_id = $2
     ORDER BY d.created_at DESC`,
    [candidateId, ctx.tenantId]
  );
  const documents = toCamelRows(linked.rows);
  const resumeId = res.rows[0].resume_document_id ? Number(res.rows[0].resume_document_id) : null;
  if (resumeId) {
    const idx = documents.findIndex((d) => Number(d.id) === resumeId);
    if (idx >= 0) {
      documents[idx] = { ...documents[idx], isResume: true };
    } else {
      const resume = await client.query(
        `SELECT * FROM documents WHERE id = $1 AND tenant_id = $2`,
        [resumeId, ctx.tenantId]
      );
      if (resume.rows.length) documents.unshift({ ...toCamelRow(resume.rows[0]), isResume: true });
    }
  }
 const applications = await client.query(
   `SELECT ca.*, v.vacancy_no, v.title AS vacancy_title
    FROM candidate_applications ca JOIN vacancies v ON v.id = ca.vacancy_id
    WHERE ca.candidate_id = $1 ORDER BY ca.applied_at DESC`,
   [candidateId]
 );
 const appIds = applications.rows.map((r) => Number(r.id));
 const interviews = appIds.length
   ? (await client.query(`SELECT * FROM interviews WHERE application_id = ANY($1) ORDER BY scheduled_at`, [appIds])).rows
   : [];
 const assessments = appIds.length
   ? (await client.query(`SELECT * FROM assessments WHERE application_id = ANY($1) ORDER BY assessed_at`, [appIds])).rows
   : [];
 const offers = appIds.length
   ? (await client.query(`SELECT * FROM job_offers WHERE application_id = ANY($1) ORDER BY created_at`, [appIds])).rows
   : [];
 return {
   candidate: toCamelRow(res.rows[0]),
   applications: toCamelRows(applications.rows),
   interviews: toCamelRows(interviews),
   assessments: toCamelRows(assessments),
   offers: toCamelRows(offers),
    documents,
 };
}


// ============================================================
// ONBOARDING
// ============================================================

export async function startOnboarding(client: pg.PoolClient, ctx: Ctx, instanceId: number) {
  const res = await client.query(
    `UPDATE onboarding_instances SET status = 'IN_PROGRESS', started_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING' RETURNING instance_no`,
    [instanceId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Onboarding instance not found or not PENDING');
  return { instanceId, status: 'IN_PROGRESS' };
}

export async function completeOnboardingTask(client: pg.PoolClient, ctx: Ctx, instanceId: number, taskId: number, notes?: string | null) {
  const inst = await client.query(
    `SELECT id FROM onboarding_instances WHERE id = $1 AND tenant_id = $2`,
    [instanceId, ctx.tenantId]
  );
  if (inst.rows.length === 0) throw notFound('Onboarding instance not found');
  const res = await client.query(
    `UPDATE onboarding_instance_tasks SET status = 'COMPLETED', completed_by = $3, completed_at = now(), notes = COALESCE($4, notes)
     WHERE instance_id = $1 AND task_id = $2 RETURNING task_id`,
    [instanceId, taskId, ctx.userId ?? null, str(notes)]
  );
  if (res.rows.length === 0) throw notFound('Task not found on this instance');
  const remaining = await client.query(
    `SELECT count(*)::int AS n FROM onboarding_instance_tasks
     WHERE instance_id = $1 AND status <> 'COMPLETED'`,
    [instanceId]
  );
  return { instanceId, taskId, status: 'COMPLETED', remaining: Number(remaining.rows[0].n) };
}

export async function completeOnboarding(client: pg.PoolClient, ctx: Ctx, instanceId: number) {
  const inst = await client.query(
    `SELECT * FROM onboarding_instances WHERE id = $1 AND tenant_id = $2`,
    [instanceId, ctx.tenantId]
  );
  if (inst.rows.length === 0) throw notFound('Onboarding instance not found');
  const pending = await client.query(
    `SELECT count(*)::int AS n FROM onboarding_instance_tasks
     WHERE instance_id = $1 AND status <> 'COMPLETED'`,
    [instanceId]
  );
  if (Number(pending.rows[0].n) > 0) throw badRequest(`${pending.rows[0].n} onboarding task(s) still pending`);
  await client.query(
    `UPDATE onboarding_instances SET status = 'COMPLETED', completed_at = now() WHERE id = $1`,
    [instanceId]
  );
  const employeeId = Number(inst.rows[0].employee_id);
  // Promotion out of probation happens via contract/position changes; keep employee status.
  await logAudit(client, ctx, { action: 'complete', resource: 'onboarding_instances', recordId: instanceId, recordCode: String(inst.rows[0].instance_no) });
  await emitEvent(client, ctx, { eventType: 'hr.onboarding_completed', entityType: 'onboarding_instances', entityId: instanceId, entityCode: String(inst.rows[0].instance_no), payload: { employeeId } });
  return { instanceId, status: 'COMPLETED', employeeId };
}

export async function getOnboarding(client: pg.PoolClient, ctx: Ctx, instanceId: number) {
  const res = await client.query(
    `SELECT ob.*, e.employee_no, e.first_name, e.last_name, e.status AS employee_status,
            cl.name AS checklist_name, COALESCE(p.title, e.position) AS position_name
     FROM onboarding_instances ob
     JOIN employees e ON e.id = ob.employee_id
     LEFT JOIN onboarding_checklists cl ON cl.id = ob.checklist_id
     LEFT JOIN positions p ON p.id = e.position_id
     WHERE ob.id = $1 AND ob.tenant_id = $2`,
    [instanceId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Onboarding instance not found');
  const tasks = await client.query(
    `SELECT ot.task_no, ot.title, ot.category, ot.due_days, ot.is_required, ot.description,
            oit.id AS instance_task_id, oit.task_id, oit.status, oit.completed_by, oit.completed_at, oit.notes
     FROM onboarding_instance_tasks oit
     JOIN onboarding_tasks ot ON ot.id = oit.task_id
     WHERE oit.instance_id = $1 ORDER BY ot.sort_order, ot.id`,
    [instanceId]
  );
  return { instance: toCamelRow(res.rows[0]), tasks: toCamelRows(tasks.rows) };
}

export async function listOnboardings(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { status?: string | null; employeeId?: number | null; q?: string | null; page?: number; pageSize?: number } = {}
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 40));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['ob.tenant_id = $1', 'ob.company_id = $2'];
  if (filters.status) { params.push(filters.status); where.push(`ob.status = $${params.length}`); }
  if (filters.employeeId) { params.push(filters.employeeId); where.push(`ob.employee_id = $${params.length}`); }
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(ob.instance_no ILIKE $${params.length} OR e.first_name ILIKE $${params.length} OR e.last_name ILIKE $${params.length})`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `SELECT ob.*, e.employee_no, e.first_name, e.last_name, e.status AS employee_status,
            cl.name AS checklist_name, COALESCE(p.title, e.position) AS position_name,
            (SELECT count(*)::int FROM onboarding_instance_tasks oit
              WHERE oit.instance_id = ob.id AND oit.status NOT IN ('COMPLETED','SKIPPED')) AS pending_tasks
     FROM onboarding_instances ob
     JOIN employees e ON e.id = ob.employee_id
     LEFT JOIN onboarding_checklists cl ON cl.id = ob.checklist_id
     LEFT JOIN positions p ON p.id = e.position_id
     WHERE ${where.join(' AND ')}
     ORDER BY ob.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const totalRes = await client.query(
    `SELECT count(*)::int AS total FROM onboarding_instances ob
     JOIN employees e ON e.id = ob.employee_id
     WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows: toCamelRows(res.rows), page, pageSize, total: Number(totalRes.rows[0].total) };
}

// ============================================================
// LEAVE: ACCRUALS + BALANCES
// ============================================================

function monthsElapsed(year: number, at: Date): number {
  if (year < at.getUTCFullYear()) return 12;
  return Math.min(12, at.getUTCMonth() + 1);
}

/** Accrue leave for all active employees for a year. Idempotent per month (deterministic totals). */
export async function runLeaveAccrual(client: pg.PoolClient, ctx: Ctx, year?: number | null) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const at = new Date();
  const targetYear = year ?? at.getUTCFullYear();
  const employees = await client.query(
    `SELECT id, hire_date FROM employees
     WHERE tenant_id = $1 AND company_id = $2 AND status IN ${ACTIVE_EMPLOYEE_STATUS}`,
    [ctx.tenantId, ctx.companyId]
  );
  const types = await client.query(
    `SELECT * FROM leave_types WHERE tenant_id = $1 AND company_id = $2 AND status = 'ACTIVE'`,
    [ctx.tenantId, ctx.companyId]
  );
  const policies = await client.query(
    `SELECT * FROM leave_policies WHERE tenant_id = $1 AND company_id = $2 AND status = 'ACTIVE'`,
    [ctx.tenantId, ctx.companyId]
  );
  const rules = await client.query(
    `SELECT * FROM leave_accrual_rules WHERE tenant_id = $1 AND company_id = $2`,
    [ctx.tenantId, ctx.companyId]
  );
  const policyByType = new Map<number, Record<string, unknown>>();
  for (const p of policies.rows) policyByType.set(Number(p.leave_type_id), p);
  const ruleByPolicy = new Map<number, Record<string, unknown>>();
  for (const r of rules.rows) ruleByPolicy.set(Number(r.policy_id), r);
  const months = monthsElapsed(targetYear, at);
  const lines: Array<Record<string, unknown>> = [];
  let accruedCount = 0;
  for (const emp of employees.rows) {
    for (const lt of types.rows) {
      const policy = policyByType.get(Number(lt.id));
      const rule = policy ? ruleByPolicy.get(Number(policy.id)) : null;
      let perYear = Number(lt.days_per_year ?? 0);
      let cap: number | null = null;
      let minServiceDays = 0;
      if (rule) {
        const rate = Number(rule.accrual_rate ?? 0);
        if (rate > 0) perYear = String(rule.rule_type) === 'MONTHLY' ? rate * 12 : rate;
        cap = rule.cap != null ? Number(rule.cap) : null;
        minServiceDays = Number(rule.minimum_service_days ?? 0);
      }
      if (perYear <= 0) continue;
      const hire = emp.hire_date ? Date.parse(String(emp.hire_date).slice(0, 10) + 'T00:00:00Z') : NaN;
      const serviceDays = Number.isFinite(hire) ? Math.max(0, Math.floor((Date.now() - hire) / 86400000)) : 0;
      if (serviceDays < minServiceDays) continue;
      const accrued = Math.min(cap ?? perYear, round2((perYear / 12) * months));
      const prevYear = await client.query(
        `SELECT available FROM leave_balances
         WHERE tenant_id = $1 AND company_id = $2 AND employee_id = $3 AND leave_type_id = $4 AND year = $5`,
        [ctx.tenantId, ctx.companyId, Number(emp.id), Number(lt.id), targetYear - 1]
      );
      const carryoverLimit = Number(lt.carryover_limit ?? 0);
      const opening = prevYear.rows.length
        ? (carryoverLimit > 0 ? Math.min(carryoverLimit, Number(prevYear.rows[0].available)) : Number(prevYear.rows[0].available))
        : 0;
      const existing = await client.query(
        `SELECT id, used, adjusted FROM leave_balances
         WHERE tenant_id = $1 AND company_id = $2 AND employee_id = $3 AND leave_type_id = $4 AND year = $5`,
        [ctx.tenantId, ctx.companyId, Number(emp.id), Number(lt.id), targetYear]
      );
     if (existing.rows.length) {
       const used = Number(existing.rows[0].used ?? 0);
       const adjusted = Number(existing.rows[0].adjusted ?? 0);
        const available = round2(opening + accrued - used + adjusted);
       await client.query(
          `UPDATE leave_balances SET opening_balance = $2, accrued = $3, available = $4
           WHERE id = $1`,
          [Number(existing.rows[0].id), opening, accrued, available]
       );
     } else {
        const available = round2(opening + accrued);
       const ins = await client.query(
         `INSERT INTO leave_balances
            (company_id, tenant_id, employee_id, leave_type_id, year, opening_balance, accrued, used, adjusted, available)
           VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,$8) RETURNING id`,
          [ctx.companyId, ctx.tenantId, Number(emp.id), Number(lt.id), targetYear, opening, accrued, available]
       );
        lines.push({ employeeId: Number(emp.id), leaveTypeId: Number(lt.id), balanceId: Number(ins.rows[0].id) });
      }
      accruedCount++;
    }
  }
  await logAudit(client, ctx, { action: 'accrue', resource: 'leave_balances', recordId: targetYear, recordCode: String(targetYear), newValues: { employees: employees.rows.length, types: types.rows.length } });
  return { year: targetYear, months, accrued: accruedCount, lines: lines.slice(0, 50) };
}

export async function listLeaveBalances(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { employeeId?: number | null; year?: number | null; leaveTypeId?: number | null } = {}
) {
  const where: string[] = ['lb.tenant_id = $1', 'lb.company_id = $2'];
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  if (filters.employeeId) { params.push(filters.employeeId); where.push(`lb.employee_id = $${params.length}`); }
  if (filters.year) { params.push(filters.year); where.push(`lb.year = $${params.length}`); }
  if (filters.leaveTypeId) { params.push(filters.leaveTypeId); where.push(`lb.leave_type_id = $${params.length}`); }
  const res = await client.query(
    `SELECT lb.*, lt.code AS leave_type_code, lt.name AS leave_type_name, lt.is_paid,
            e.employee_no, e.first_name, e.last_name
     FROM leave_balances lb
     JOIN leave_types lt ON lt.id = lb.leave_type_id
     JOIN employees e ON e.id = lb.employee_id
     WHERE ${where.join(' AND ')} ORDER BY e.last_name, lt.code, lb.year DESC`,
    params
  );
  return toCamelRows(res.rows);
}

// ============================================================
// PERFORMANCE
// ============================================================

export async function createPerformanceGoal(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    employeeId: number;
    title: string;
    description?: string | null;
    category?: string;
    startDate?: string | null;
    dueDate?: string | null;
    weight?: number;
    kpis?: Array<{ name: string; unit?: string; targetValue?: number; weight?: number }>;
  }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  if (!input.title?.trim()) throw badRequest('Goal title is required');
  const ins = await client.query(
    `INSERT INTO performance_goals
       (company_id, tenant_id, employee_id, title, description, category, start_date, due_date, weight, progress, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,'NOT_STARTED') RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, Number(input.employeeId), input.title.trim(), str(input.description),
      input.category ?? 'PERFORMANCE', str(input.startDate), str(input.dueDate),
      input.weight != null ? Number(input.weight) : 1,
    ]
  );
  const goalId = Number(ins.rows[0].id);
  const kpis = [];
  for (const k of input.kpis ?? []) {
    const kIns = await client.query(
      `INSERT INTO performance_kpis
         (company_id, tenant_id, employee_id, goal_id, name, unit, target_value, weight, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE') RETURNING id`,
      [ctx.companyId, ctx.tenantId, Number(input.employeeId), goalId, k.name, str(k.unit), k.targetValue ?? null, k.weight ?? 1]
    );
    kpis.push({ kpiId: Number(kIns.rows[0].id) });
  }
  return { goalId, kpis };
}

export async function updateKpi(
  client: pg.PoolClient,
  ctx: Ctx,
  kpiId: number,
  input: { actualValue?: number | null; status?: string; notes?: string | null }
) {
  const kpiStatus = input.status != null ? String(input.status).toUpperCase() : 'ACTIVE';
  if (!['ACTIVE', 'ACHIEVED', 'MISSED', 'INACTIVE'].includes(kpiStatus)) throw badRequest(`Invalid KPI status: ${kpiStatus}`);
  const res = await client.query(
    `UPDATE performance_kpis SET actual_value = COALESCE($3, actual_value), status = $4
     WHERE id = $1 AND tenant_id = $2 RETURNING goal_id, target_value, actual_value, weight, status`,
    [kpiId, ctx.tenantId, input.actualValue ?? null, kpiStatus]
  );
  if (res.rows.length === 0) throw notFound('KPI not found');
  const row = res.rows[0];
  // Recompute goal progress from its KPIs (weighted average of actual/target).
  const kpis = await client.query(
    `SELECT target_value, actual_value, weight FROM performance_kpis WHERE goal_id = $1`,
    [Number(row.goal_id)]
  );
  let total = 0;
  let weight = 0;
  for (const k of kpis.rows) {
    const t = Number(k.target_value) || 0;
    if (t > 0 && k.actual_value != null) {
      total += Math.min(1, Number(k.actual_value) / t) * Number(k.weight || 1);
      weight += Number(k.weight || 1);
    }
  }
  const progress = weight > 0 ? round2((total / weight) * 100) : 0;
  await client.query(
    `UPDATE performance_goals SET progress = $2 WHERE id = $1`,
    [Number(row.goal_id), progress]
  );
  if (input.notes) await logAudit(client, ctx, { action: 'update', resource: 'performance_kpis', recordId: kpiId, newValues: { actualValue: input.actualValue, status: input.status } });
  return { kpiId, progress, kpiStatus: row.status };
}

export async function startPerformanceReview(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    employeeId: number;
    reviewType?: string;
    periodStart?: string | null;
    periodEnd?: string | null;
    dueDate?: string | null;
    reviewerId?: number | null;
  }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const ins = await client.query(
    `INSERT INTO performance_reviews
       (company_id, tenant_id, employee_id, review_type, period_start, period_end, status, reviewer_id, due_date)
     VALUES ($1,$2,$3,$4,$5,$6,'IN_PROGRESS',$7,$8) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, Number(input.employeeId), input.reviewType ?? 'ANNUAL',
      str(input.periodStart) ?? new Date().toISOString().slice(0, 8) + '01',
      str(input.periodEnd) ?? new Date().toISOString().slice(0, 10),
      input.reviewerId ?? null, str(input.dueDate),
    ]
  );
  return { reviewId: Number(ins.rows[0].id), status: 'IN_PROGRESS' };
}

export async function completeReview(
  client: pg.PoolClient,
  ctx: Ctx,
  reviewId: number,
  input: { overallRating?: number | null; summary?: string | null }
) {
  const res = await client.query(
    `UPDATE performance_reviews SET status = 'COMPLETED', overall_rating = COALESCE($3, overall_rating), summary = COALESCE($4, summary)
     WHERE id = $1 AND tenant_id = $2 AND status = 'IN_PROGRESS' RETURNING id`,
    [reviewId, ctx.tenantId, input.overallRating ?? null, str(input.summary)]
  );
  if (res.rows.length === 0) throw badRequest('Review not found or not IN_PROGRESS');
  return { reviewId, status: 'COMPLETED' };
}

export async function createPip(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    employeeId: number;
    reason: string;
    startDate?: string | null;
    endDate?: string | null;
    goals?: Array<{ title: string; target: string }>;
  }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  if (!input.reason?.trim()) throw badRequest('PIP reason is required');
  const ins = await client.query(
    `INSERT INTO performance_improvement_plans
       (company_id, tenant_id, employee_id, reason, start_date, end_date, goals, progress, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,0,'OPEN') RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, Number(input.employeeId), input.reason.trim(),
      str(input.startDate) ?? new Date().toISOString().slice(0, 10), str(input.endDate), JSON.stringify(input.goals ?? []),
    ]
  );
  const pipId = Number(ins.rows[0].id);
  await logAudit(client, ctx, { action: 'create', resource: 'performance_improvement_plans', recordId: pipId });
  return { pipId, status: 'OPEN' };
}

export async function closePip(client: pg.PoolClient, ctx: Ctx, pipId: number, outcome?: string | null) {
  const res = await client.query(
    `UPDATE performance_improvement_plans SET status = 'CLOSED', progress = 100
     WHERE id = $1 AND tenant_id = $2 AND status = 'OPEN' RETURNING id`,
    [pipId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('PIP not found or not OPEN');
  if (outcome) await logAudit(client, ctx, { action: 'close', resource: 'performance_improvement_plans', recordId: pipId, newValues: { outcome } });
  return { pipId, status: 'CLOSED' };
}


// ============================================================
// EMPLOYEE RELATIONS
// ============================================================

export async function registerGrievance(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    employeeId: number;
    category: string;
    subject: string;
    description?: string | null;
    priority?: string;
  }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  if (!input.subject?.trim()) throw badRequest('Grievance subject is required');
  const ins = await client.query(
    `INSERT INTO grievances (company_id, tenant_id, employee_id, category, subject, description, priority, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'OPEN') RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, Number(input.employeeId), String(input.category),
      input.subject.trim(), str(input.description), input.priority ?? 'MEDIUM',
    ]
  );
  const grievanceId = Number(ins.rows[0].id);
  await logAudit(client, ctx, { action: 'create', resource: 'grievances', recordId: grievanceId });
  await emitEvent(client, ctx, {
    eventType: 'hr.grievance.opened',
    entityType: 'grievances',
    entityId: grievanceId,
    entityCode: `GRV-${grievanceId}`,
    payload: { employeeId: Number(input.employeeId), category: input.category },
    severity: input.priority === 'URGENT' || input.priority === 'HIGH' ? 'WARN' : 'INFO',
  });
  return { grievanceId, status: 'OPEN' };
}

export async function resolveGrievance(
  client: pg.PoolClient,
  ctx: Ctx,
  grievanceId: number,
  input: { resolution: string; resolvedBy?: number | null }
) {
  const res = await client.query(
    `UPDATE grievances SET status = 'RESOLVED', resolution = $3, resolved_by = COALESCE($4, resolved_by), resolved_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'OPEN' RETURNING id, employee_id`,
    [grievanceId, ctx.tenantId, String(input.resolution), input.resolvedBy ?? ctx.userId ?? null]
  );
  if (res.rows.length === 0) throw badRequest('Grievance not found or not OPEN');
  await emitEvent(client, ctx, {
    eventType: 'hr.grievance.resolved',
    entityType: 'grievances',
    entityId: grievanceId,
    entityCode: `GRV-${grievanceId}`,
    payload: { employeeId: Number(res.rows[0].employee_id) },
  });
  return { grievanceId, status: 'RESOLVED' };
}

export async function startInvestigation(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { grievanceId?: number | null; disciplinaryCaseId?: number | null; investigatorUserId?: number | null }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  if (!input.grievanceId && !input.disciplinaryCaseId) throw badRequest('An investigation must reference a grievance or disciplinary case');
  const ins = await client.query(
    `INSERT INTO investigations
       (company_id, tenant_id, case_type, grievance_id, disciplinary_case_id, investigator_user_id, started_at, status)
     VALUES ($1,$2,$6,$3,$4,$5, now(), 'IN_PROGRESS') RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, input.grievanceId ?? null, input.disciplinaryCaseId ?? null,
      input.investigatorUserId ?? ctx.userId ?? null,
      input.grievanceId ? 'GRIEVANCE' : 'DISCIPLINARY',
    ]
  );
  const investigationId = Number(ins.rows[0].id);
  if (input.grievanceId) {
    await client.query(
      `UPDATE grievances SET status = 'INVESTIGATING' WHERE id = $1`,
      [input.grievanceId]
    );
  }
  return { investigationId, status: 'IN_PROGRESS' };
}

export async function completeInvestigation(
  client: pg.PoolClient,
  ctx: Ctx,
  investigationId: number,
  input: { findings: string; disciplinaryCaseId?: number | null }
) {
  const res = await client.query(
    `UPDATE investigations SET status = 'COMPLETED', completed_at = now(), findings = $3,
        disciplinary_case_id = COALESCE($4, disciplinary_case_id)
     WHERE id = $1 AND tenant_id = $2 AND status = 'IN_PROGRESS' RETURNING id, grievance_id`,
    [investigationId, ctx.tenantId, String(input.findings), input.disciplinaryCaseId ?? null]
  );
  if (res.rows.length === 0) throw badRequest('Investigation not found or not IN_PROGRESS');
  const row = res.rows[0];
  if (row.grievance_id) {
    await client.query(
      `UPDATE grievances SET status = 'OPEN' WHERE id = $1 AND status = 'INVESTIGATING'`,
      [Number(row.grievance_id)]
    );
  }
  return { investigationId, status: 'COMPLETED' };
}

export async function openDisciplinaryCase(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    employeeId: number;
    incidentDate?: string | null;
    category: string;
    description?: string | null;
  }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const no = await nextDoc(client, ctx, 'DSC');
  const ins = await client.query(
    `INSERT INTO disciplinary_cases
       (company_id, tenant_id, employee_id, case_no, incident_date, category, description, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'REPORTED') RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, Number(input.employeeId), no,
      str(input.incidentDate) ?? new Date().toISOString().slice(0, 10), String(input.category), str(input.description),
    ]
  );
  const caseId = Number(ins.rows[0].id);
  await logAudit(client, ctx, { action: 'create', resource: 'disciplinary_cases', recordId: caseId, recordCode: no });
  return { caseId, caseNo: no, status: 'REPORTED' };
}

export async function recordDisciplinaryAction(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    caseId: number;
    actionType: string;
    description?: string | null;
    effectiveDate?: string | null;
    durationDays?: number | null;
    decision?: string | null;
  }
) {
  const cs = await client.query(
    `SELECT * FROM disciplinary_cases WHERE id = $1 AND tenant_id = $2`,
    [input.caseId, ctx.tenantId]
  );
  if (cs.rows.length === 0) throw notFound('Disciplinary case not found');
  const ins = await client.query(
    `INSERT INTO disciplinary_actions
       (company_id, tenant_id, employee_id, case_id, action_type, description, effective_date, duration_days, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE') RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, Number(cs.rows[0].employee_id), input.caseId, String(input.actionType),
      str(input.description), str(input.effectiveDate) ?? new Date().toISOString().slice(0, 10), input.durationDays ?? null,
    ]
  );
  const actionId = Number(ins.rows[0].id);
  await client.query(
    `UPDATE disciplinary_cases SET status = 'CLOSED', decision = COALESCE($3, decision), decision_date = now()
     WHERE id = $1 AND tenant_id = $2`,
    [input.caseId, ctx.tenantId, str(input.decision) ?? str(input.actionType)]
  );
  await logAudit(client, ctx, { action: 'record', resource: 'disciplinary_actions', recordId: actionId, recordCode: String(cs.rows[0].case_no) });
  return { actionId, caseId: input.caseId, caseNo: cs.rows[0].case_no, status: 'ISSUED' };
}

export async function issueWarning(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    employeeId: number;
    warningType?: string;
    reason: string;
    issuedAt?: string | null;
    expiresAt?: string | null;
  }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  if (!input.reason?.trim()) throw badRequest('Warning reason is required');
  const ins = await client.query(
    `INSERT INTO warnings
       (company_id, tenant_id, employee_id, warning_type, reason, issued_by, issued_at, expires_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE') RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, Number(input.employeeId), input.warningType ?? 'VERBAL',
      input.reason.trim(), ctx.userId ?? null,
      str(input.issuedAt) ?? new Date().toISOString().slice(0, 10), str(input.expiresAt),
    ]
  );
  const warningId = Number(ins.rows[0].id);
  await emitEvent(client, ctx, {
    eventType: 'hr.warning.issued',
    entityType: 'warnings',
    entityId: warningId,
    entityCode: `WRN-${warningId}`,
    payload: { employeeId: Number(input.employeeId), warningType: input.warningType ?? 'VERBAL' },
    severity: 'WARN',
  });
  return { warningId, status: 'ACTIVE' };
}

// ============================================================
// LEARNING & DEVELOPMENT
// ============================================================

export async function requestTraining(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { trainingId: number; employeeId: number; reason?: string | null }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const ins = await client.query(
    `INSERT INTO training_requests (company_id, tenant_id, employee_id, training_id, reason, status)
     VALUES ($1,$2,$3,$4,$5,'SUBMITTED') RETURNING id`,
    [ctx.companyId, ctx.tenantId, Number(input.employeeId), Number(input.trainingId), str(input.reason)]
  );
  const requestId = Number(ins.rows[0].id);
  await emitEvent(client, ctx, {
    eventType: 'hr.training.requested',
    entityType: 'training_requests',
    entityId: requestId,
    entityCode: `TRN-${requestId}`,
    payload: { employeeId: Number(input.employeeId), trainingId: Number(input.trainingId) },
  });
  return { requestId, status: 'SUBMITTED' };
}

export async function approveTrainingRequest(client: pg.PoolClient, ctx: Ctx, requestId: number) {
  const res = await client.query(
    `UPDATE training_requests SET status = 'APPROVED', approved_by = $3, approved_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'SUBMITTED' RETURNING id, training_id, employee_id`,
    [requestId, ctx.tenantId, ctx.userId ?? null]
  );
  if (res.rows.length === 0) throw badRequest('Training request not found or not SUBMITTED');
  await emitEvent(client, ctx, {
    eventType: 'hr.training.approved',
    entityType: 'training_requests',
    entityId: requestId,
    entityCode: `TRN-${requestId}`,
    payload: { employeeId: Number(res.rows[0].employee_id), trainingId: Number(res.rows[0].training_id) },
  });
  return { requestId, status: 'APPROVED' };
}

export async function enrollTraining(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { sessionId: number; employeeId: number }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const ses = await client.query(
    `SELECT * FROM training_sessions WHERE id = $1 AND tenant_id = $2`,
    [input.sessionId, ctx.tenantId]
  );
  if (ses.rows.length === 0) throw notFound('Training session not found');
  const enrolled = await client.query(
    `SELECT count(*)::int AS n FROM training_enrollments WHERE session_id = $1 AND status = 'ENROLLED'`,
    [input.sessionId]
  );
  const capacity = Number(ses.rows[0].capacity ?? 0);
  if (capacity > 0 && Number(enrolled.rows[0].n) >= capacity) throw badRequest('Training session is at capacity');
  const ins = await client.query(
    `INSERT INTO training_enrollments (company_id, tenant_id, employee_id, session_id, status)
     VALUES ($1,$2,$3,$4,'ENROLLED')
     ON CONFLICT (employee_id, session_id) DO UPDATE SET status = 'ENROLLED' RETURNING id`,
    [ctx.companyId, ctx.tenantId, Number(input.employeeId), Number(input.sessionId)]
  );
  return { enrollmentId: Number(ins.rows[0].id), status: 'ENROLLED' };
}

export async function completeTraining(
  client: pg.PoolClient,
  ctx: Ctx,
  enrollmentId: number,
  input: { score?: number | null }
) {
  const res = await client.query(
    `UPDATE training_enrollments SET status = 'COMPLETED', score = COALESCE($3, score), completed_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'ENROLLED' RETURNING id, employee_id, session_id`,
    [enrollmentId, ctx.tenantId, input.score ?? null]
  );
  if (res.rows.length === 0) throw badRequest('Enrollment not found or not ENROLLED');
  const row = res.rows[0];
  const ses = await client.query(
    `SELECT ts.training_id, tc.certification_renewal_months FROM training_sessions ts
     JOIN training_catalog tc ON tc.id = ts.training_id
     WHERE ts.id = $1`,
    [Number(row.session_id)]
  );
  if (ses.rows.length) {
    const certNo = await nextDoc(client, ctx, 'CERT');
    const issuedAt = new Date().toISOString().slice(0, 10);
    const renewMonths = Number(ses.rows[0].certification_renewal_months ?? 0);
    let expiry: string | null = null;
    if (renewMonths > 0) {
      const d = new Date();
      d.setUTCMonth(d.getUTCMonth() + renewMonths);
      expiry = d.toISOString().slice(0, 10);
    }
    await client.query(
      `INSERT INTO training_certificates
         (company_id, tenant_id, employee_id, training_id, certificate_no, issued_at, expiry_date, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE')`,
      [ctx.companyId, ctx.tenantId, Number(row.employee_id), Number(ses.rows[0].training_id), certNo, issuedAt, expiry]
    );
  }
  return { enrollmentId, status: 'COMPLETED' };
}

// ============================================================
// BENEFITS
// ============================================================

export async function enrollBenefit(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    employeeId: number;
    planId: number;
    dependantId?: number | null;
    effectiveFrom?: string | null;
    effectiveTo?: string | null;
    monthlyCost?: number | null;
  }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const plan = await client.query(
    `SELECT * FROM benefit_plans WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE'`,
    [input.planId, ctx.tenantId]
  );
  if (plan.rows.length === 0) throw badRequest('Benefit plan not found or inactive');
  const existing = await client.query(
    `SELECT id FROM benefit_enrollments
     WHERE tenant_id = $1 AND employee_id = $2 AND plan_id = $3 AND status = 'ACTIVE'`,
    [ctx.tenantId, Number(input.employeeId), Number(input.planId)]
  );
  if (existing.rows.length) throw badRequest('Employee is already enrolled in this plan');
  const ins = await client.query(
    `INSERT INTO benefit_enrollments
       (company_id, tenant_id, employee_id, plan_id, dependant_id, effective_from, effective_to, monthly_cost, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE') RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, Number(input.employeeId), Number(input.planId), input.dependantId ?? null,
      str(input.effectiveFrom) ?? new Date().toISOString().slice(0, 10), str(input.effectiveTo),
      input.monthlyCost ?? (plan.rows[0].cost != null ? Number(plan.rows[0].cost) : null),
    ]
  );
  return { enrollmentId: Number(ins.rows[0].id), status: 'ACTIVE' };
}

export async function resignBenefit(client: pg.PoolClient, ctx: Ctx, enrollmentId: number, effectiveTo?: string | null) {
  const res = await client.query(
    `UPDATE benefit_enrollments SET status = 'CANCELLED', effective_to = COALESCE($3, effective_to, now()::date)
     WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE' RETURNING id`,
    [enrollmentId, ctx.tenantId, str(effectiveTo)]
  );
  if (res.rows.length === 0) throw badRequest('Enrollment not found or not ACTIVE');
  return { enrollmentId, status: 'CANCELLED' };
}

// ============================================================
// ASSET MANAGEMENT
// ============================================================

export async function assignAsset(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    assetId: number;
    employeeId: number;
    expectedReturnDate?: string | null;
    notes?: string | null;
  }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const asset = await client.query(
    `SELECT * FROM assets WHERE id = $1 AND tenant_id = $2`,
    [input.assetId, ctx.tenantId]
  );
  if (asset.rows.length === 0) throw notFound('Asset not found');
  if (String(asset.rows[0].status) === 'IN_USE') throw badRequest('Asset is already assigned');
  const emp = await client.query(
    `SELECT user_id FROM employees WHERE id = $1 AND tenant_id = $2`,
    [input.employeeId, ctx.tenantId]
  );
  if (emp.rows.length === 0) throw notFound('Employee not found');
  const ins = await client.query(
    `INSERT INTO asset_assignments
       (company_id, tenant_id, asset_id, employee_id, assigned_by, assigned_at, expected_return_date, notes, status)
     VALUES ($1,$2,$3,$4,$5, now(), $6,$7,'ASSIGNED') RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, Number(input.assetId), Number(input.employeeId), ctx.userId ?? null,
      str(input.expectedReturnDate), str(input.notes),
    ]
  );
  await client.query(
    `UPDATE assets SET status = 'IN_USE', custodian_user_id = $2 WHERE id = $1`,
    [Number(input.assetId), emp.rows[0].user_id ?? null]
  );
  return { assignmentId: Number(ins.rows[0].id), status: 'ASSIGNED' };
}

export async function returnAsset(
  client: pg.PoolClient,
  ctx: Ctx,
  assignmentId: number,
  input: { condition?: string | null; notes?: string | null }
) {
  const res = await client.query(
    `UPDATE asset_assignments SET status = 'RETURNED', returned_at = now(),
        condition_on_return = COALESCE($3, condition_on_return), notes = COALESCE($4, notes)
     WHERE id = $1 AND tenant_id = $2 AND status = 'ASSIGNED' RETURNING id, asset_id`,
    [assignmentId, ctx.tenantId, str(input.condition), str(input.notes)]
  );
  if (res.rows.length === 0) throw badRequest('Assignment not found or not ASSIGNED');
  await client.query(
    `UPDATE assets SET status = 'IN_STORE', custodian_user_id = NULL WHERE id = $1`,
    [Number(res.rows[0].asset_id)]
  );
  return { assignmentId, status: 'RETURNED' };
}


// ============================================================
// ORGANIZATION BUILDER: POSITIONS / SHIFTS / TIMESHEETS
// ============================================================

export async function createPosition(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    title: string;
    departmentId?: number | null;
    branchId?: number | null;
    divisionId?: number | null;
    orgUnitId?: number | null;
    teamId?: number | null;
    locationId?: number | null;
    jobFamilyId?: number | null;
    jobGradeId?: number | null;
    costCentreId?: number | null;
    reportToPositionId?: number | null;
    approvedHeadcount?: number;
    salaryMin?: number | null;
    salaryMax?: number | null;
    currency?: string;
    requiredQualifications?: string | null;
    requiredSkills?: string[] | null;
    jobDescription?: string | null;
  }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  if (!input.title?.trim()) throw badRequest('Position title is required');
  const code = await nextDoc(client, ctx, 'POS');
  const ins = await client.query(
    `INSERT INTO positions
       (company_id, tenant_id, branch_id, department_id, division_id, org_unit_id, team_id, location_id,
        job_family_id, job_grade_id, cost_centre_id, code, title, report_to_position_id, approved_headcount,
        salary_min, salary_max, currency, required_qualifications, required_skills, job_description, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'APPROVED') RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, input.branchId ?? ctx.branchId ?? null, input.departmentId ?? null,
      input.divisionId ?? null, input.orgUnitId ?? null, input.teamId ?? null, input.locationId ?? null,
      input.jobFamilyId ?? null, input.jobGradeId ?? null, input.costCentreId ?? null, code, input.title.trim(),
      input.reportToPositionId ?? null, Math.max(0, num(input.approvedHeadcount, 1)),
      input.salaryMin ?? null, input.salaryMax ?? null, input.currency ?? 'UGX',
      JSON.stringify(input.requiredQualifications ? [str(input.requiredQualifications)] : []), JSON.stringify(input.requiredSkills ?? []), str(input.jobDescription),
    ]
  );
  const positionId = Number(ins.rows[0].id);
  await logAudit(client, ctx, { action: 'create', resource: 'positions', recordId: positionId, recordCode: code });
  return { positionId, code, title: input.title.trim() };
}

export async function listPositions(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { departmentId?: number | null; status?: string | null; q?: string | null } = {}
) {
  const where: string[] = ['p.tenant_id = $1', 'p.company_id = $2'];
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  if (filters.departmentId) { params.push(filters.departmentId); where.push(`p.department_id = $${params.length}`); }
  if (filters.status) { params.push(filters.status); where.push(`p.status = $${params.length}`); }
  if (filters.q) { params.push(`%${String(filters.q)}%`); where.push(`(p.title ILIKE $${params.length} OR p.code ILIKE $${params.length})`); }
  const res = await client.query(
    `SELECT p.*, d.name AS department_name, b.name AS branch_name,
        (SELECT count(*)::int FROM employees e WHERE e.position_id = p.id AND e.status IN ${ACTIVE_EMPLOYEE_STATUS}) AS occupied
     FROM positions p
     LEFT JOIN departments d ON d.id = p.department_id
     LEFT JOIN branches b ON b.id = p.branch_id
     WHERE ${where.join(' AND ')} ORDER BY p.code LIMIT 200`,
    params
  );
  return res.rows.map((r) => ({
    ...toCamelRow(r),
    occupied: Number(r.occupied),
    vacancy: Math.max(0, Number(r.approved_headcount ?? 0) - Number(r.occupied)),
  }));
}

export async function updatePosition(
  client: pg.PoolClient,
  ctx: Ctx,
  positionId: number,
  input: { title?: string; approvedHeadcount?: number; salaryMin?: number | null; salaryMax?: number | null; status?: string }
) {
  const fields: string[] = [];
  const params: unknown[] = [positionId, ctx.tenantId];
  if (input.title != null) { params.push(String(input.title).trim()); fields.push(`title = $${params.length}`); }
  if (input.approvedHeadcount != null) { params.push(Math.max(0, Number(input.approvedHeadcount))); fields.push(`approved_headcount = $${params.length}`); }
  if (input.salaryMin !== undefined) { params.push(input.salaryMin); fields.push(`salary_min = $${params.length}`); }
  if (input.salaryMax !== undefined) { params.push(input.salaryMax); fields.push(`salary_max = $${params.length}`); }
  if (input.status != null) {
    const posStatus = String(input.status).toUpperCase();
    if (!['PLANNED', 'APPROVED', 'FROZEN', 'CLOSED'].includes(posStatus)) throw badRequest(`Invalid position status: ${posStatus}`);
    params.push(posStatus); fields.push(`status = $${params.length}`);
  }
  if (!fields.length) throw badRequest('Nothing to update');
  const res = await client.query(
    `UPDATE positions SET ${fields.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING id, code`,
    params
  );
  if (res.rows.length === 0) throw notFound('Position not found');
  return { positionId, code: res.rows[0].code };
}

export async function createShift(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    code: string;
    name: string;
    startTime: string;
    endTime: string;
    graceMinutes?: number;
    breakMinutes?: number;
    workHours?: number | null;
    appliesTo?: string[] | null;
    branchId?: number | null;
  }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  if (!input.code?.trim() || !input.startTime || !input.endTime) throw badRequest('Shift code, start and end time are required');
  const ins = await client.query(
    `INSERT INTO shifts (company_id, tenant_id, branch_id, code, name, start_time, end_time, grace_minutes, break_minutes, work_hours, applies_to, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ACTIVE') RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, input.branchId ?? ctx.branchId ?? null, input.code.trim(), input.name.trim(),
      String(input.startTime), String(input.endTime), num(input.graceMinutes, 5), num(input.breakMinutes, 30),
      input.workHours ?? null, JSON.stringify(input.appliesTo ?? []),
    ]
  );
  return { shiftId: Number(ins.rows[0].id), code: input.code.trim() };
}

export async function assignShift(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { employeeId: number; shiftId: number; effectiveFrom: string; effectiveTo?: string | null }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  await client.query(
    `UPDATE shift_assignments SET status = 'INACTIVE', effective_to = COALESCE(effective_to, now()::date)
     WHERE employee_id = $1 AND status = 'ACTIVE'`,
    [Number(input.employeeId)]
  );
  const ins = await client.query(
    `INSERT INTO shift_assignments (company_id, tenant_id, employee_id, shift_id, effective_from, effective_to, status)
     VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE') RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, Number(input.employeeId), Number(input.shiftId),
      String(input.effectiveFrom), str(input.effectiveTo),
    ]
  );
  return { assignmentId: Number(ins.rows[0].id), status: 'ACTIVE' };
}

export async function submitTimesheet(client: pg.PoolClient, ctx: Ctx, timesheetId: number, totalHours?: number | null) {
  const res = await client.query(
    `UPDATE timesheets SET status = 'SUBMITTED', total_hours = COALESCE($3, total_hours)
     WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT' RETURNING id, employee_id`,
    [timesheetId, ctx.tenantId, totalHours ?? null]
  );
  if (res.rows.length === 0) throw badRequest('Timesheet not found or not DRAFT');
  await emitEvent(client, ctx, {
    eventType: 'hr.timesheet.submitted',
    entityType: 'timesheets',
    entityId: timesheetId,
    entityCode: `TS-${timesheetId}`,
    payload: { employeeId: Number(res.rows[0].employee_id) },
  });
  return { timesheetId, status: 'SUBMITTED' };
}

export async function approveTimesheet(client: pg.PoolClient, ctx: Ctx, timesheetId: number) {
  const res = await client.query(
    `UPDATE timesheets SET status = 'APPROVED', approved_by = $3, approved_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'SUBMITTED' RETURNING id, employee_id`,
    [timesheetId, ctx.tenantId, ctx.userId ?? null]
  );
  if (res.rows.length === 0) throw badRequest('Timesheet not found or not SUBMITTED');
  await emitEvent(client, ctx, {
    eventType: 'hr.timesheet.approved',
    entityType: 'timesheets',
    entityId: timesheetId,
    entityCode: `TS-${timesheetId}`,
    payload: { employeeId: Number(res.rows[0].employee_id) },
  });
  return { timesheetId, status: 'APPROVED' };
}

// ============================================================
// EMPLOYEE SELF-SERVICE
// ============================================================

async function employeeForUser(client: pg.PoolClient, ctx: Ctx) {
  if (!ctx.userId) throw badRequest('Authenticated user required');
  const res = await client.query(
    `SELECT e.* FROM employees e
     LEFT JOIN users u ON u.id = $1 AND u.tenant_id = e.tenant_id
     WHERE e.tenant_id = $2 AND (e.user_id = $1 OR u.employee_id = e.id)
     LIMIT 1`,
    [ctx.userId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('No employee record linked to this user');
  return res.rows[0];
}

export async function myProfile(client: pg.PoolClient, ctx: Ctx) {
  const emp = await employeeForUser(client, ctx);
  const deps = await client.query(
    `SELECT * FROM employee_dependants WHERE employee_id = $1 AND tenant_id = $2 ORDER BY full_name`,
    [Number(emp.id), ctx.tenantId]
  );
  const contacts = await client.query(
    `SELECT * FROM employee_emergency_contacts WHERE employee_id = $1 AND tenant_id = $2 ORDER BY is_primary DESC`,
    [Number(emp.id), ctx.tenantId]
  );
  return {
    employee: toCamelRow(emp),
    dependants: toCamelRows(deps.rows),
    emergencyContacts: toCamelRows(contacts.rows),
  };
}

export async function myLeave(client: pg.PoolClient, ctx: Ctx) {
  const emp = await employeeForUser(client, ctx);
  const res = await client.query(
    `SELECT * FROM leave_requests WHERE employee_id = $1 ORDER BY start_date DESC LIMIT 50`,
    [Number(emp.id)]
  );
  const balances = await client.query(
    `SELECT lb.*, lt.code AS leave_type_code, lt.name AS leave_type_name
     FROM leave_balances lb JOIN leave_types lt ON lt.id = lb.leave_type_id
     WHERE lb.employee_id = $1 ORDER BY lb.year DESC, lt.code`,
    [Number(emp.id)]
  );
  return { leave: toCamelRows(res.rows), balances: toCamelRows(balances.rows) };
}

export async function myAttendance(client: pg.PoolClient, ctx: Ctx) {
  const emp = await employeeForUser(client, ctx);
  const res = await client.query(
    `SELECT * FROM attendance WHERE employee_id = $1 ORDER BY work_date DESC LIMIT 60`,
    [Number(emp.id)]
  );
  return toCamelRows(res.rows);
}

export async function myPayslips(client: pg.PoolClient, ctx: Ctx) {
  const emp = await employeeForUser(client, ctx);
  const res = await client.query(
    `SELECT i.*, p.payroll_no, p.period_start, p.period_end, p.status AS payroll_status
     FROM payroll_items i JOIN payrolls p ON p.id = i.payroll_id
     WHERE i.employee_id = $1 AND p.status IN ('APPROVED','RELEASED','PAID')
     ORDER BY p.period_end DESC LIMIT 24`,
    [Number(emp.id)]
  );
  return toCamelRows(res.rows);
}

export async function myDocuments(client: pg.PoolClient, ctx: Ctx) {
  const emp = await employeeForUser(client, ctx);
  const res = await client.query(
    `SELECT d.* FROM documents d
     JOIN document_links dl ON dl.document_id = d.id
     WHERE dl.entity_type = 'employees' AND dl.entity_id = $1 AND d.tenant_id = $2
     ORDER BY d.created_at DESC`,
    [Number(emp.id), ctx.tenantId]
  );
  return toCamelRows(res.rows);
}

export async function myRequests(client: pg.PoolClient, ctx: Ctx) {
  const emp = await employeeForUser(client, ctx);
  const res = await client.query(
    `SELECT * FROM employee_requests WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [Number(emp.id)]
  );
  return toCamelRows(res.rows);
}

// ============================================================
// HR CALENDAR: holidays + approved leave
// ============================================================

export async function hrCalendar(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { startDate?: string | null; endDate?: string | null } = {}
) {
  const start = str(input.startDate) ?? new Date().toISOString().slice(0, 8) + '01';
  const end = str(input.endDate) ?? new Date(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0).toISOString().slice(0, 10);
  const holidays = await client.query(
    `SELECT * FROM holidays WHERE tenant_id = $1 AND company_id = $2`,
    [ctx.tenantId, ctx.companyId]
  );
  const items: Array<Record<string, unknown>> = [];
  for (const h of holidays.rows) {
    const date = String(h.holiday_date).slice(0, 10);
    if (h.is_recurring) {
      const mmdd = date.slice(5);
      const yearStart = Number(start.slice(0, 4));
      const yearEnd = Number(end.slice(0, 4));
      for (let y = yearStart; y <= yearEnd; y++) {
        const candidate = `${y}-${mmdd}`;
        if (candidate >= start && candidate <= end) {
          items.push({ date: candidate, type: 'HOLIDAY', name: String(h.name), recurring: true, holidayId: Number(h.id) });
        }
      }
    } else if (date >= start && date <= end) {
      items.push({ date, type: 'HOLIDAY', name: String(h.name), recurring: false, holidayId: Number(h.id) });
    }
  }
  const leave = await client.query(
    `SELECT l.id, l.start_date, l.end_date, l.days, l.status, e.employee_no, e.first_name, e.last_name, lt.name AS leave_type_name
     FROM leave_requests l
     JOIN employees e ON e.id = l.employee_id
     LEFT JOIN leave_types lt ON lt.id = l.leave_type_id
     WHERE e.tenant_id = $1 AND e.company_id = $2 AND l.status = 'APPROVED'
       AND l.start_date <= $4 AND l.end_date >= $3
     ORDER BY l.start_date`,
    [ctx.tenantId, ctx.companyId, start, end]
  );
  for (const l of leave.rows) {
    items.push({ date: fmtDate(l.start_date), endDate: fmtDate(l.end_date), type: 'LEAVE', name: `${l.first_name} ${l.last_name} - ${l.leave_type_name ?? l.leave_type}`, employeeNo: l.employee_no, leaveId: Number(l.id) });
  }
  items.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { startDate: start, endDate: end, items };
}

// ============================================================
// HCM HOME DASHBOARD
// ============================================================

/** Personalized HCM home dashboard: workforce, recruitment, leave, payroll and lifecycle KPIs. */
export async function hcmDashboard(client: pg.PoolClient, ctx: Ctx) {
  const kpis = await client.query(
    `SELECT
       (SELECT count(*) FROM employees
         WHERE tenant_id = $1 AND company_id = $2 AND status IN ${ACTIVE_EMPLOYEE_STATUS})::int AS headcount,
       (SELECT count(*) FROM employees
         WHERE tenant_id = $1 AND company_id = $2 AND status = 'ON_LEAVE')::int AS on_leave,
       (SELECT count(*) FROM employees
         WHERE tenant_id = $1 AND company_id = $2 AND status = 'PROBATION')::int AS probation,
       (SELECT count(*) FROM positions
         WHERE tenant_id = $1 AND company_id = $2 AND status = 'APPROVED')::int AS active_positions,
       (SELECT count(*) FROM job_requisitions
         WHERE tenant_id = $1 AND company_id = $2 AND status IN ('SUBMITTED','APPROVED'))::int AS open_requisitions,
       (SELECT count(*) FROM vacancies
         WHERE tenant_id = $1 AND company_id = $2 AND status = 'PUBLISHED')::int AS published_vacancies,
       (SELECT count(*) FROM candidate_applications
         WHERE tenant_id = $1 AND company_id = $2 AND status NOT IN ('REJECTED','WITHDRAWN'))::int AS applications_in_pipeline,
       (SELECT count(*) FROM leave_requests l JOIN employees e ON e.id = l.employee_id
         WHERE e.tenant_id = $1 AND e.company_id = $2 AND l.status = 'SUBMITTED')::int AS pending_leave,
       (SELECT count(*) FROM training_requests tr JOIN employees e ON e.id = tr.employee_id
         WHERE e.tenant_id = $1 AND e.company_id = $2 AND tr.status = 'SUBMITTED')::int AS pending_training,
       (SELECT count(*) FROM onboarding_instances oi
         WHERE oi.tenant_id = $1 AND oi.company_id = $2 AND oi.status IN ('PENDING','IN_PROGRESS'))::int AS pending_onboarding,
       (SELECT count(*) FROM employment_contracts ec JOIN employees e ON e.id = ec.employee_id
         WHERE e.tenant_id = $1 AND e.company_id = $2 AND ec.status = 'ACTIVE'
           AND ec.end_date IS NOT NULL AND ec.end_date <= (CURRENT_DATE + interval '90 days'))::int AS expiring_contracts,
       (SELECT count(*) FROM employees
         WHERE tenant_id = $1 AND company_id = $2 AND status = 'TERMINATED'
           AND alumni_date IS NOT NULL AND alumni_date >= (CURRENT_DATE - interval '90 days'))::int AS recent_exits,
       (SELECT COALESCE(sum(gross_total),0) FROM payrolls
         WHERE tenant_id = $1 AND company_id = $2 AND status IN ('APPROVED','RELEASED','PAID')
           AND period_end >= (CURRENT_DATE - interval '45 days'))::numeric AS recent_payroll_gross,
       (SELECT COALESCE(sum(net_total),0) FROM payrolls
         WHERE tenant_id = $1 AND company_id = $2 AND status IN ('APPROVED','RELEASED','PAID')
           AND period_end >= (CURRENT_DATE - interval '45 days'))::numeric AS recent_payroll_net`,
    [ctx.tenantId, ctx.companyId]
  );

  // Approved headcount vs occupied headcount -> net staffing gap.
  const occupancy = await client.query(
    `SELECT COALESCE(sum(p.approved_headcount),0)::int AS approved,
            COALESCE(sum(occ.occupied),0)::int AS occupied
     FROM positions p
     LEFT JOIN (
       SELECT position_id, count(*)::int AS occupied
       FROM employees
       WHERE tenant_id = $1 AND company_id = $2 AND status IN ${ACTIVE_EMPLOYEE_STATUS}
       GROUP BY position_id
     ) occ ON occ.position_id = p.id
     WHERE p.tenant_id = $1 AND p.company_id = $2 AND p.status = 'APPROVED'`,
    [ctx.tenantId, ctx.companyId]
  );

  // ATS pipeline funnel: raw application status counts.
  const pipelineRes = await client.query(
    `SELECT status, count(*)::int AS count
     FROM candidate_applications
     WHERE tenant_id = $1 AND company_id = $2
     GROUP BY status`,
    [ctx.tenantId, ctx.companyId]
  );
  const stageCounts = new Map<string, number>();
  for (const r of pipelineRes.rows) stageCounts.set(String(r.status), Number(r.count));
  const pipeline = [
    'SUBMITTED', 'SCREENING', 'SHORTLISTED', 'INTERVIEW', 'ASSESSMENT',
    'REFERENCE_CHECK', 'OFFER', 'ACCEPTED', 'REJECTED', 'WITHDRAWN',
  ].map((stage) => ({ stage, count: stageCounts.get(stage) ?? 0 }));

  const requisitions = await client.query(
    `SELECT r.id, r.requisition_no, r.title, r.headcount, r.employment_type, r.status,
            r.salary_min, r.salary_max, r.currency, d.name AS department_name
     FROM job_requisitions r
     LEFT JOIN departments d ON d.id = r.department_id
     WHERE r.tenant_id = $1 AND r.company_id = $2 AND r.status IN ('SUBMITTED','APPROVED')
     ORDER BY r.created_at DESC LIMIT 10`,
    [ctx.tenantId, ctx.companyId]
  );

  const vacancies = await client.query(
    `SELECT v.id, v.vacancy_no, v.title, v.openings, v.filled, v.status, v.closes_at, v.published_at,
            d.name AS department_name,
            (SELECT count(*)::int FROM candidate_applications ca WHERE ca.vacancy_id = v.id) AS total_applications
     FROM vacancies v
     LEFT JOIN positions p ON p.id = v.position_id
     LEFT JOIN job_requisitions r ON r.id = v.requisition_id
     LEFT JOIN departments d ON d.id = COALESCE(p.department_id, r.department_id)
     WHERE v.tenant_id = $1 AND v.company_id = $2 AND v.status = 'PUBLISHED'
     ORDER BY v.published_at DESC NULLS LAST LIMIT 10`,
    [ctx.tenantId, ctx.companyId]
  );

  const onboarding = await client.query(
    `SELECT oi.id, oi.instance_no, oi.status, oi.started_at, oi.completed_at, oi.created_at,
            e.employee_no, e.first_name, e.last_name, e.position
     FROM onboarding_instances oi
     JOIN employees e ON e.id = oi.employee_id
     WHERE oi.tenant_id = $1 AND oi.company_id = $2
     ORDER BY oi.created_at DESC LIMIT 8`,
    [ctx.tenantId, ctx.companyId]
  );

  const expiringContracts = await client.query(
    `SELECT ec.id, ec.contract_type, ec.start_date, ec.end_date, ec.status,
            e.employee_no, e.first_name, e.last_name, e.position
     FROM employment_contracts ec
     JOIN employees e ON e.id = ec.employee_id
     WHERE e.tenant_id = $1 AND e.company_id = $2 AND ec.status = 'ACTIVE'
       AND ec.end_date IS NOT NULL AND ec.end_date <= (CURRENT_DATE + interval '90 days')
     ORDER BY ec.end_date LIMIT 10`,
    [ctx.tenantId, ctx.companyId]
  );

  const benefitsExpiring = await client.query(
    `SELECT be.id, be.effective_from, be.effective_to, be.status, be.monthly_cost,
            bp.code AS plan_code, bp.name AS plan_name, bp.category AS plan_category,
            e.employee_no, e.first_name, e.last_name
     FROM benefit_enrollments be
     JOIN benefit_plans bp ON bp.id = be.plan_id
     JOIN employees e ON e.id = be.employee_id
     WHERE be.tenant_id = $1 AND be.company_id = $2 AND be.status = 'ACTIVE'
       AND be.effective_to IS NOT NULL AND be.effective_to <= (CURRENT_DATE + interval '90 days')
     ORDER BY be.effective_to LIMIT 10`,
    [ctx.tenantId, ctx.companyId]
  );

  const birthdays = await client.query(
    `SELECT e.id, e.employee_no, e.first_name, e.last_name, e.dob, e.position
     FROM employees e
     WHERE e.tenant_id = $1 AND e.company_id = $2 AND e.status IN ${ACTIVE_EMPLOYEE_STATUS}
       AND e.dob IS NOT NULL
       AND (
         (to_char(e.dob,'MMDD')::int BETWEEN to_char(CURRENT_DATE,'MMDD')::int
                                         AND to_char(CURRENT_DATE + interval '30 days','MMDD')::int)
         OR (to_char(CURRENT_DATE + interval '30 days','MMDD')::int < to_char(CURRENT_DATE,'MMDD')::int
             AND (to_char(e.dob,'MMDD')::int >= to_char(CURRENT_DATE,'MMDD')::int
                  OR to_char(e.dob,'MMDD')::int <= to_char(CURRENT_DATE + interval '30 days','MMDD')::int))
       )
     ORDER BY to_char(e.dob,'MMDD') LIMIT 10`,
    [ctx.tenantId, ctx.companyId]
  );

  const payrolls = await client.query(
    `SELECT id, payroll_no, period_start, period_end, status, gross_total, net_total
     FROM payrolls WHERE tenant_id = $1 AND company_id = $2
     ORDER BY id DESC LIMIT 5`,
    [ctx.tenantId, ctx.companyId]
  );

  const alumni = await client.query(
    `SELECT e.id, e.employee_no, e.first_name, e.last_name, e.position,
            e.alumni_date, e.offboarding_type, e.exit_reason, e.rehire_eligible
     FROM employees e
     WHERE e.tenant_id = $1 AND e.company_id = $2 AND e.status = 'TERMINATED'
       AND e.alumni_date IS NOT NULL
     ORDER BY e.alumni_date DESC
     LIMIT 8`,
    [ctx.tenantId, ctx.companyId]
  );

  const kpi = toCamelRow(kpis.rows[0]);
  kpi.recentPayrollGross = Number(kpi.recentPayrollGross ?? 0);
  kpi.recentPayrollNet = Number(kpi.recentPayrollNet ?? 0);
  const occ = toCamelRow(occupancy.rows[0]);
  kpi.approvedHeadcount = Number(occ.approved ?? 0);
  kpi.occupiedHeadcount = Number(occ.occupied ?? 0);
  kpi.headcountGap = Math.max(0, Number(kpi.approvedHeadcount) - Number(kpi.occupiedHeadcount));

  return {
    kpis: kpi,
    pipeline,
    openRequisitions: toCamelRows(requisitions.rows),
    publishedVacancies: toCamelRows(vacancies.rows),
    recentOnboarding: toCamelRows(onboarding.rows),
    expiringContracts: toCamelRows(expiringContracts.rows),
    benefitsExpiring: toCamelRows(benefitsExpiring.rows),
    upcomingBirthdays: toCamelRows(birthdays.rows),
    recentPayrolls: toCamelRows(payrolls.rows),
    alumni: toCamelRows(
      alumni.rows.map((r) => ({ ...r, alumni_date: fmtDate(r.alumni_date) }))
    ),
  };
}

// ============================================================
// OFFBOARDING / EXIT CLEARANCE / ALUMNI
// ============================================================

const OFFBOARDING_TYPES = new Set(['RESIGNATION', 'TERMINATION', 'RETIREMENT', 'REDUNDANCY', 'END_OF_CONTRACT', 'TRANSFER', 'OTHER']);

export async function createOffboarding(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    employeeId: number;
    offboardingType?: string | null;
    effectiveDate?: string | null;
    lastWorkingDate?: string | null;
    reason?: string | null;
    checklistId?: number | null;
    finalSettlementRequired?: boolean;
    notes?: string | null;
  }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const emp = await client.query(
    `SELECT * FROM employees WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [input.employeeId, ctx.tenantId, ctx.companyId]
  );
  if (emp.rows.length === 0) throw notFound('Employee not found');
  if (!['ACTIVE', 'PROBATION', 'ON_LEAVE'].includes(String(emp.rows[0].status))) {
    throw badRequest('Only active employees can be offboarded');
  }
  const open = await client.query(
    `SELECT id FROM offboarding_instances
     WHERE employee_id = $1 AND status IN ('DRAFT','IN_PROGRESS','CLEARED')`,
    [input.employeeId]
  );
  if (open.rows.length) throw badRequest('An offboarding case already exists for this employee');

  const offboardingType = String(input.offboardingType ?? 'RESIGNATION').toUpperCase();
  if (!OFFBOARDING_TYPES.has(offboardingType)) throw badRequest('Invalid offboarding type');
  const effectiveDate = str(input.effectiveDate) ?? new Date().toISOString().slice(0, 10);

  let checklistId: number | null = input.checklistId != null ? Number(input.checklistId) : null;
  if (checklistId) {
    const cl = await client.query(
      `SELECT id FROM offboarding_checklists WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE'`,
      [checklistId, ctx.tenantId]
    );
    if (cl.rows.length === 0) throw notFound('Offboarding checklist not found');
  } else {
    const cl = await client.query(
      `SELECT id FROM offboarding_checklists WHERE company_id = $1 AND tenant_id = $2 AND status = 'ACTIVE' ORDER BY id LIMIT 1`,
      [ctx.companyId, ctx.tenantId]
    );
    if (cl.rows.length) checklistId = Number(cl.rows[0].id);
  }

  const no = await nextDoc(client, ctx, 'OB');
  const ins = await client.query(
    `INSERT INTO offboarding_instances
       (company_id, tenant_id, employee_id, checklist_id, instance_no, offboarding_type,
        effective_date, last_working_date, reason, status, final_settlement_required, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DRAFT',$10,$11) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, input.employeeId, checklistId, no, offboardingType,
      effectiveDate, str(input.lastWorkingDate), str(input.reason),
      bool(input.finalSettlementRequired, true), ctx.userId ?? null,
    ]
  );
  const instanceId = Number(ins.rows[0].id);
  let taskCount = 0;
  if (checklistId) {
    const tasks = await client.query(
      `SELECT * FROM offboarding_tasks WHERE checklist_id = $1 AND status = 'ACTIVE' ORDER BY sort_order, id`,
      [checklistId]
    );
    for (const t of tasks.rows) {
      await client.query(
        `INSERT INTO offboarding_instance_tasks (instance_id, task_id, status)
         VALUES ($1,$2,'PENDING') ON CONFLICT (instance_id, task_id) DO NOTHING`,
        [instanceId, Number(t.id)]
      );
      taskCount++;
    }
  }
  await logAudit(client, ctx, {
    action: 'create', resource: 'offboarding_instances', recordId: instanceId, recordCode: no,
    newValues: { employeeId: input.employeeId, offboardingType, effectiveDate, taskCount },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.offboarding_created', entityType: 'offboarding_instances', entityId: instanceId,
    entityCode: no, payload: { employeeId: input.employeeId, offboardingType },
  });
  return { instanceId, instanceNo: no, status: 'DRAFT', employeeId: input.employeeId, taskCount };
}

export async function startOffboarding(client: pg.PoolClient, ctx: Ctx, instanceId: number) {
  const res = await client.query(
    `UPDATE offboarding_instances SET status = 'IN_PROGRESS', started_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT' RETURNING instance_no, employee_id`,
    [instanceId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Offboarding instance not found or not DRAFT');
  await logAudit(client, ctx, { action: 'start', resource: 'offboarding_instances', recordId: instanceId, recordCode: String(res.rows[0].instance_no) });
  return { instanceId, status: 'IN_PROGRESS' };
}

export async function completeOffboardingTask(
  client: pg.PoolClient,
  ctx: Ctx,
  instanceId: number,
  taskId: number,
  input: { status?: string | null; notes?: string | null } = {}
) {
  const inst = await client.query(
    `SELECT id, instance_no FROM offboarding_instances WHERE id = $1 AND tenant_id = $2`,
    [instanceId, ctx.tenantId]
  );
  if (inst.rows.length === 0) throw notFound('Offboarding instance not found');
  const status = String(input.status ?? 'COMPLETED').toUpperCase();
  if (!['COMPLETED', 'WAIVED', 'IN_PROGRESS'].includes(status)) throw badRequest('Invalid task status');
  const res = await client.query(
    `UPDATE offboarding_instance_tasks
     SET status = $3, completed_by = $4,
         completed_at = CASE WHEN $3 IN ('COMPLETED','WAIVED') THEN now() ELSE completed_at END,
         notes = COALESCE($5, notes)
     WHERE instance_id = $1 AND task_id = $2 RETURNING task_id`,
    [instanceId, taskId, status, ctx.userId ?? null, str(input.notes)]
  );
  if (res.rows.length === 0) throw notFound('Task not found on this instance');
  const remaining = await client.query(
    `SELECT count(*)::int AS n FROM offboarding_instance_tasks
     WHERE instance_id = $1 AND status NOT IN ('COMPLETED','WAIVED')`,
    [instanceId]
  );
  return { instanceId, taskId, status, remaining: Number(remaining.rows[0].n) };
}

export async function completeOffboarding(
  client: pg.PoolClient,
  ctx: Ctx,
  instanceId: number,
  input: { exitInterviewNotes?: string | null; alumniDate?: string | null; rehireEligible?: boolean } = {}
) {
  const inst = await client.query(
    `SELECT * FROM offboarding_instances WHERE id = $1 AND tenant_id = $2`,
    [instanceId, ctx.tenantId]
  );
  if (inst.rows.length === 0) throw notFound('Offboarding instance not found');
  if (inst.rows[0].status !== 'IN_PROGRESS') throw badRequest('Offboarding must be IN_PROGRESS to complete');
  const pending = await client.query(
    `SELECT count(*)::int AS n FROM offboarding_instance_tasks
     WHERE instance_id = $1 AND status NOT IN ('COMPLETED','WAIVED')`,
    [instanceId]
  );
  if (Number(pending.rows[0].n) > 0) throw badRequest(`${pending.rows[0].n} offboarding task(s) still pending`);

  const employeeId = Number(inst.rows[0].employee_id);
  const effectiveDate = str(input.alumniDate) ?? fmtDate(inst.rows[0].effective_date);
  const offboardingType = String(inst.rows[0].offboarding_type);
  const exitReason = str(inst.rows[0].reason);
  await client.query(
    `UPDATE offboarding_instances
     SET status = 'COMPLETED', completed_at = now(), exit_interview_notes = COALESCE($2, exit_interview_notes)
     WHERE id = $1`,
    [instanceId, str(input.exitInterviewNotes)]
  );
  await client.query(
    `UPDATE employees
     SET status = 'TERMINATED', termination_date = $2, alumni_date = $3,
         offboarding_type = $4, exit_reason = $5, rehire_eligible = $6
     WHERE id = $1`,
    [employeeId, effectiveDate, effectiveDate, offboardingType, exitReason, bool(input.rehireEligible, true)]
  );
  await client.query(
    `UPDATE employment_contracts SET status = 'TERMINATED'
     WHERE employee_id = $1 AND status = 'ACTIVE'`,
    [employeeId]
  );
  await client.query(
    `UPDATE position_assignments SET effective_to = $2
     WHERE employee_id = $1 AND is_primary AND effective_to IS NULL`,
    [employeeId, effectiveDate]
  );
  await logAudit(client, ctx, {
    action: 'complete', resource: 'offboarding_instances', recordId: instanceId,
    recordCode: String(inst.rows[0].instance_no),
    newValues: { employeeId, effectiveDate, offboardingType, exitReason },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.employee_exited', entityType: 'offboarding_instances', entityId: instanceId,
    entityCode: String(inst.rows[0].instance_no),
    payload: { employeeId, offboardingType, effectiveDate, exitReason },
  });
  return { instanceId, employeeId, status: 'COMPLETED', effectiveDate, offboardingType };
}

export async function cancelOffboarding(client: pg.PoolClient, ctx: Ctx, instanceId: number, reason?: string | null) {
  const res = await client.query(
    `UPDATE offboarding_instances SET status = 'CANCELLED'
     WHERE id = $1 AND tenant_id = $2 AND status IN ('DRAFT','IN_PROGRESS')
     RETURNING instance_no`,
    [instanceId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Offboarding instance not found or not cancellable');
  await logAudit(client, ctx, {
    action: 'cancel', resource: 'offboarding_instances', recordId: instanceId,
    recordCode: String(res.rows[0].instance_no), newValues: { reason: str(reason) },
  });
  return { instanceId, status: 'CANCELLED' };
}

export async function getOffboarding(client: pg.PoolClient, ctx: Ctx, instanceId: number) {
  const res = await client.query(
    `SELECT ob.*, e.employee_no, e.first_name, e.last_name, e.status AS employee_status,
            cl.name AS checklist_name
     FROM offboarding_instances ob
     JOIN employees e ON e.id = ob.employee_id
     LEFT JOIN offboarding_checklists cl ON cl.id = ob.checklist_id
     WHERE ob.id = $1 AND ob.tenant_id = $2`,
    [instanceId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Offboarding instance not found');
  const tasks = await client.query(
    `SELECT ot.task_no, ot.title, ot.category, ot.due_days, ot.is_required, ot.description,
            oit.id AS instance_task_id, oit.task_id, oit.status, oit.completed_by, oit.completed_at, oit.notes
     FROM offboarding_instance_tasks oit
     JOIN offboarding_tasks ot ON ot.id = oit.task_id
     WHERE oit.instance_id = $1 ORDER BY ot.sort_order, ot.id`,
    [instanceId]
  );
  return { instance: toCamelRow(res.rows[0]), tasks: toCamelRows(tasks.rows) };
}

export async function listOffboardings(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { status?: string | null; employeeId?: number | null; q?: string | null; page?: number; pageSize?: number } = {}
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 40));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['ob.tenant_id = $1', 'ob.company_id = $2'];
  if (filters.status) { params.push(filters.status); where.push(`ob.status = $${params.length}`); }
  if (filters.employeeId) { params.push(filters.employeeId); where.push(`ob.employee_id = $${params.length}`); }
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(ob.instance_no ILIKE $${params.length} OR e.first_name ILIKE $${params.length} OR e.last_name ILIKE $${params.length})`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `SELECT ob.*, e.employee_no, e.first_name, e.last_name, e.status AS employee_status,
            cl.name AS checklist_name,
            (SELECT count(*)::int FROM offboarding_instance_tasks oit
              WHERE oit.instance_id = ob.id AND oit.status NOT IN ('COMPLETED','WAIVED')) AS pending_tasks
     FROM offboarding_instances ob
     JOIN employees e ON e.id = ob.employee_id
     LEFT JOIN offboarding_checklists cl ON cl.id = ob.checklist_id
     WHERE ${where.join(' AND ')}
     ORDER BY ob.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const totalRes = await client.query(
    `SELECT count(*)::int AS total FROM offboarding_instances ob
     JOIN employees e ON e.id = ob.employee_id
     WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows: toCamelRows(res.rows), page, pageSize, total: Number(totalRes.rows[0].total) };
}

// ============================================================
// EMPLOYEE MOVEMENTS (promotion / transfer / secondment) + SALARY HISTORY
// ============================================================

const MOVEMENT_TYPES = new Set(['PROMOTION', 'TRANSFER', 'SECONDMENT', 'DEMOTION', 'ROTATION']);

export async function recordMovement(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    employeeId: number;
    positionId: number;
    movementType: string;
    effectiveFrom: string;
    notes?: string | null;
    reason?: string | null;
    salary?: number | null;
    salaryEffective?: string | null;
  }
) {
  if (!ctx.companyId) throw badRequest('Company context required');
  const movementType = String(input.movementType ?? 'TRANSFER').toUpperCase();
  if (!MOVEMENT_TYPES.has(movementType)) throw badRequest('Invalid movement type');
  const emp = await client.query(
    `SELECT * FROM employees WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [input.employeeId, ctx.tenantId, ctx.companyId]
  );
  if (emp.rows.length === 0) throw notFound('Employee not found');
  const pos = await client.query(
    `SELECT * FROM positions WHERE id = $1 AND tenant_id = $2`,
    [input.positionId, ctx.tenantId]
  );
  if (pos.rows.length === 0) throw notFound('Position not found');
  const effectiveFrom = str(input.effectiveFrom) ?? new Date().toISOString().slice(0, 10);
  const assignmentType = movementType === 'PROMOTION' || movementType === 'DEMOTION' ? 'PROMOTION' : movementType === 'ROTATION' ? 'TRANSFER' : movementType;
  const oldSalary = Number(emp.rows[0].base_salary ?? 0);
  const newSalary = input.salary != null ? Number(input.salary) : null;

  await client.query(
    `UPDATE position_assignments SET effective_to = $2
     WHERE employee_id = $1 AND is_primary AND effective_to IS NULL`,
    [input.employeeId, effectiveFrom]
  );
  await client.query(
    `INSERT INTO position_assignments
       (company_id, tenant_id, employee_id, position_id, effective_from, assignment_type, is_primary, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8)`,
    [ctx.companyId, ctx.tenantId, input.employeeId, input.positionId, effectiveFrom, assignmentType, str(input.notes), ctx.userId ?? null]
  );
  await client.query(
    `UPDATE employees
     SET position_id = $2, position = $3, department_id = $4, branch_id = $5, division_id = $6,
         org_unit_id = $7, team_id = $8, location_id = $9, job_family_id = $10, job_grade_id = $11,
         cost_centre_id = $12
     WHERE id = $1`,
    [
      input.employeeId, Number(pos.rows[0].id), String(pos.rows[0].title),
      pos.rows[0].department_id, pos.rows[0].branch_id, pos.rows[0].division_id,
      pos.rows[0].org_unit_id, pos.rows[0].team_id, pos.rows[0].location_id,
      pos.rows[0].job_family_id, pos.rows[0].job_grade_id, pos.rows[0].cost_centre_id,
    ]
  );
  const mov = await client.query(
    `INSERT INTO employee_movements
       (company_id, tenant_id, employee_id, movement_type, from_position_id, to_position_id,
        effective_from, old_salary, new_salary, reason, notes, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'APPROVED',$12) RETURNING id`,
    [
      ctx.companyId, ctx.tenantId, input.employeeId, movementType,
      emp.rows[0].position_id ?? null, pos.rows[0].id, effectiveFrom,
      oldSalary, newSalary, str(input.reason), str(input.notes), ctx.userId ?? null,
    ]
  );
  const movementId = Number(mov.rows[0].id);
  let salaryHistoryId: number | null = null;
  if (newSalary != null && newSalary !== oldSalary) {
    const sh = await client.query(
      `INSERT INTO salary_histories
         (company_id, tenant_id, employee_id, old_salary, new_salary, effective_date, reason, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'HR',$8) RETURNING id`,
      [ctx.companyId, ctx.tenantId, input.employeeId, oldSalary, newSalary,
       str(input.salaryEffective) ?? effectiveFrom, str(input.reason), ctx.userId ?? null]
    );
    salaryHistoryId = Number(sh.rows[0].id);
    await client.query(`UPDATE employees SET base_salary = $2 WHERE id = $1`, [input.employeeId, newSalary]);
  }
  const eventType = movementType === 'PROMOTION' || movementType === 'DEMOTION' ? 'hr.employee_promoted' : 'hr.employee_transferred';
  await logAudit(client, ctx, {
    action: 'record_movement', resource: 'employee_movements', recordId: movementId,
    recordCode: String(movementType), newValues: { employeeId: input.employeeId, movementType, effectiveFrom, salary: newSalary },
  });
  await emitEvent(client, ctx, {
    eventType, entityType: 'employee_movements', entityId: movementId,
    entityCode: String(movementType),
    payload: { employeeId: input.employeeId, movementType, toPositionId: pos.rows[0].id, effectiveFrom, salary: newSalary },
  });
  return { movementId, employeeId: input.employeeId, movementType, effectiveFrom, salaryHistoryId };
}

// ============================================================
// EMPLOYEE LIFECYCLE TIMELINE
// ============================================================

export async function employeeTimeline(client: pg.PoolClient, ctx: Ctx, employeeId: number) {
  const emp = await client.query(
    `SELECT * FROM employees WHERE id = $1 AND tenant_id = $2`,
    [employeeId, ctx.tenantId]
  );
  if (emp.rows.length === 0) throw notFound('Employee not found');
  const events: Array<{
    date: string; eventType: string; title: string;
    entityType: string; entityId: number; entityCode?: string | null; metadata?: Record<string, unknown>;
  }> = [];
  const e = emp.rows[0];
  const push = (date: string, eventType: string, title: string, entityType: string, entityId: number, entityCode?: string | null, metadata?: Record<string, unknown>) => {
    const d = fmtDate(date);
    if (d) events.push({ date: d, eventType, title, entityType, entityId, entityCode: entityCode ?? null, metadata });
  };
  if (e.hire_date) push(String(e.hire_date), 'HIRE', 'Joined company', 'employees', employeeId, String(e.employee_no ?? ''), { position: e.position });
  if (e.probation_end_date) push(String(e.probation_end_date), 'CONFIRMED', 'Probation completed', 'employees', employeeId, String(e.employee_no ?? ''));
  if (e.alumni_date) push(String(e.alumni_date), 'EXIT', 'Exited organization', 'offboarding_instances', employeeId, String(e.employee_no ?? ''), { offboardingType: e.offboarding_type, exitReason: e.exit_reason });

  const onb = await client.query(
    `SELECT * FROM onboarding_instances WHERE employee_id = $1 AND status = 'COMPLETED' ORDER BY completed_at`,
    [employeeId]
  );
  for (const r of onb.rows) push(String(r.completed_at ?? r.created_at), 'ONBOARDING_COMPLETED', 'Onboarding completed', 'onboarding_instances', Number(r.id), String(r.instance_no));

  const movs = await client.query(
    `SELECT em.*, p.title AS position_title FROM employee_movements em
     LEFT JOIN positions p ON p.id = em.to_position_id
     WHERE em.employee_id = $1 ORDER BY em.effective_from`,
    [employeeId]
  );
  for (const m of movs.rows) {
    const label = String(m.movement_type).toLowerCase().replace(/_/g, ' ');
    push(String(m.effective_from), String(m.movement_type), `${label} — ${m.position_title ?? ''}`.trim(), 'employee_movements', Number(m.id), null, { salary: m.new_salary });
  }

  const contracts = await client.query(
    `SELECT * FROM employment_contracts WHERE employee_id = $1 ORDER BY start_date`,
    [employeeId]
  );
  for (const c of contracts.rows) {
    push(String(c.start_date), 'CONTRACT_START', `Contract started (${String(c.contract_type).toLowerCase()})`, 'employment_contracts', Number(c.id));
    if (c.end_date) push(String(c.end_date), 'CONTRACT_END', 'Contract ends', 'employment_contracts', Number(c.id));
  }

  const reviews = await client.query(
    `SELECT * FROM performance_reviews WHERE employee_id = $1 AND status = 'COMPLETED' ORDER BY period_end`,
    [employeeId]
  );
  for (const r of reviews.rows) push(String(r.period_end ?? r.created_at), 'PERFORMANCE_REVIEW_COMPLETED', 'Performance review completed', 'performance_reviews', Number(r.id), null, { overallRating: r.overall_rating });

  const trainings = await client.query(
    `SELECT te.id, te.completed_at, ts.code AS session_code FROM training_enrollments te
     LEFT JOIN training_sessions ts ON ts.id = te.session_id
     WHERE te.employee_id = $1 AND te.status = 'COMPLETED' ORDER BY te.completed_at`,
    [employeeId]
  );
  for (const r of trainings.rows) push(String(r.completed_at ?? r.created_at), 'TRAINING_COMPLETED', 'Training completed', 'training_enrollments', Number(r.id), r.session_code ? String(r.session_code) : null);

  const warnings = await client.query(
    `SELECT * FROM warnings WHERE employee_id = $1 ORDER BY issued_at`,
    [employeeId]
  );
  for (const w of warnings.rows) push(String(w.issued_at), 'WARNING', `Warning: ${String(w.warning_type ?? 'issued').toLowerCase()}`, 'warnings', Number(w.id));

  const discipline = await client.query(
    `SELECT * FROM disciplinary_cases WHERE employee_id = $1 AND status = 'CLOSED' ORDER BY decision_date`,
    [employeeId]
  );
  for (const d of discipline.rows) push(String(d.decision_date ?? d.created_at), 'DISCIPLINARY_CLOSED', 'Disciplinary case closed', 'disciplinary_cases', Number(d.id), String(d.case_no ?? ''));

  const assets = await client.query(
    `SELECT * FROM asset_assignments WHERE employee_id = $1 AND returned_at IS NOT NULL ORDER BY returned_at`,
    [employeeId]
  );
  for (const a of assets.rows) push(String(a.returned_at), 'ASSET_RETURNED', 'Asset returned', 'asset_assignments', Number(a.id));

  const leave = await client.query(
    `SELECT * FROM leave_requests WHERE employee_id = $1 AND status = 'APPROVED' ORDER BY approved_at`,
    [employeeId]
  );
  for (const l of leave.rows) push(String(l.approved_at ?? l.created_at), 'LEAVE_APPROVED', `Leave approved (${String(l.leave_type).toLowerCase()}, ${l.days} day${Number(l.days) === 1 ? '' : 's'})`, 'leave_requests', Number(l.id));

  const offboard = await client.query(
    `SELECT * FROM offboarding_instances WHERE employee_id = $1 AND status = 'COMPLETED' ORDER BY effective_date`,
    [employeeId]
  );
  for (const ob of offboard.rows) push(String(ob.effective_date), 'OFFBOARDING_COMPLETED', 'Offboarding completed', 'offboarding_instances', Number(ob.id), String(ob.instance_no), { offboardingType: ob.offboarding_type });

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { employeeId, employeeNo: e.employee_no, firstName: e.first_name, lastName: e.last_name, events };
}
