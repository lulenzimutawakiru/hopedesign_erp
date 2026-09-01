import pg from 'pg';
import crypto from 'crypto';
import { Ctx } from '../db.js';
import { badRequest, notFound, conflict, forbidden, toCamelRow, toCamelRows, toISODate } from '../utils.js';
import { startWorkflow, decideTask } from './workflow.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';
import { notifyUserAdvanced } from './communication.js';

type Row = Record<string, unknown>;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const todayIso = (): string => new Date().toISOString().slice(0, 10);

async function nextDoc(client: pg.PoolClient, ctx: Ctx, prefix: string, pad = 8): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,$3) AS code', [ctx.tenantId, prefix, pad]);
  return String(res.rows[0].code);
}

/** Whole months of continuous service between two dates (for statutory notice). */
function serviceMonths(startDate: string | null | undefined, asOf?: string): number {
  if (!startDate) return 0;
  const s = new Date(`${startDate.slice(0, 10)}T00:00:00Z`);
  const e = asOf ? new Date(`${asOf.slice(0, 10)}T00:00:00Z`) : new Date();
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
  let months = (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth());
  if (e.getUTCDate() < s.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/**
 * Statutory notice under the Employment Act (Cap. 226), s.58(3), as amended, derived from the
 * ACTIVE NOTICE_PERIOD rule bands in the database - never hard-coded.
 * Returns 0 when no active rule is loaded or service is below the first band
 * (contractual notice then applies).
 */
function statutoryNoticeDays(months: number, rule: Row | null): number {
  const bands = ruleBands(rule);
  if (bands.length === 0) return 0;
  let days = 0;
  for (const b of bands) {
    const min = Number(b.service_months_min ?? 0);
    const max = b.service_months_max == null ? Number.POSITIVE_INFINITY : Number(b.service_months_max);
    if (months > min && months <= max) days = Math.max(days, Number(b.notice_days ?? 0));
  }
  return days;
}

/** Rule payloads may be a JSON object (keyed thresholds) or an array of bands. */
function ruleBands(rule: Row | null): Array<Record<string, unknown>> {
  if (!rule) return [];
  const r = rule.rules;
  return Array.isArray(r) ? (r as Array<Record<string, unknown>>) : [];
}

function dateDiffDays(start: string | null | undefined, end: string | null | undefined): number {
  if (!start || !end) return Number.NaN;
  const s = Date.parse(`${start.slice(0, 10)}T00:00:00Z`);
  const e = Date.parse(`${end.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return Number.NaN;
  return Math.floor((e - s) / 86400000);
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function verificationSecret(): string {
  return crypto.randomBytes(18).toString('base64url');
}

function verificationCode(): string {
  return crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, '').toUpperCase().slice(0, 12);
}

function daysBetweenIso(a: string, b: string): number {
  const s = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const e = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  return Math.floor((e - s) / 86400000);
}

function intervalDaysClause(alias: string, daysParamIdx: number): string {
  return `${alias} BETWEEN CURRENT_DATE AND (CURRENT_DATE + ($${daysParamIdx} || ' days')::interval)`;
}

/** Resolve the employee row linked to the requesting user, if any (self-service). */
async function employeeIdForUser(client: pg.PoolClient, ctx: Ctx): Promise<number | null> {
  if (!ctx.userId) return null;
  const res = await client.query(
    `SELECT id FROM employees WHERE user_id = $1 AND tenant_id = $2 LIMIT 1`,
    [ctx.userId, ctx.tenantId]
  );
  return res.rows.length ? Number(res.rows[0].id) : null;
}

// ---------------------------------------------------------------------------
// Lists & detail
// ---------------------------------------------------------------------------

export interface ContractListFilters {
  q?: string;
  status?: string;
  statuses?: string[];
  contractType?: string;
  employeeId?: number;
  departmentId?: number;
  branchId?: number;
  expiringWithinDays?: number;
  probationEndingWithinDays?: number;
  page?: number;
  pageSize?: number;
}

export async function listContracts(client: pg.PoolClient, ctx: Ctx, filters: ContractListFilters = {}) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 40));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['ec.tenant_id = $1', 'ec.company_id = $2', 'ec.deleted_at IS NULL'];
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    const n = params.length;
    where.push(
      `(ec.contract_no ILIKE $${n} OR ec.job_title ILIKE $${n} OR e.first_name ILIKE $${n} OR e.last_name ILIKE $${n} OR e.employee_no ILIKE $${n})`
    );
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`ec.status = $${params.length}`);
  }
  if (filters.statuses?.length) {
    params.push(filters.statuses);
    where.push(`ec.status = ANY($${params.length}::text[])`);
  }
  if (filters.contractType) {
    params.push(filters.contractType);
    where.push(`ec.contract_type = $${params.length}`);
  }
  if (filters.employeeId) {
    params.push(filters.employeeId);
    where.push(`ec.employee_id = $${params.length}`);
  }
  if (filters.departmentId) {
    params.push(filters.departmentId);
    where.push(`ec.department_id = $${params.length}`);
  }
  if (filters.branchId) {
    params.push(filters.branchId);
    where.push(`ec.branch_id = $${params.length}`);
  }
  if (filters.expiringWithinDays != null) {
    params.push(filters.expiringWithinDays);
    where.push(`ec.end_date IS NOT NULL AND ${intervalDaysClause('ec.end_date', params.length)}`);
  }
  if (filters.probationEndingWithinDays != null) {
    params.push(filters.probationEndingWithinDays);
    where.push(`ec.probation_end_date IS NOT NULL AND ${intervalDaysClause('ec.probation_end_date', params.length)}`);
  }
  const whereSql = where.join(' AND ');
  const countRes = await client.query(
    `SELECT count(*)::int AS total FROM employment_contracts ec
     JOIN employees e ON e.id = ec.employee_id WHERE ${whereSql}`,
    params
  );
  const total = Number(countRes.rows[0].total);
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `SELECT ec.id, ec.contract_no, ec.contract_type, ec.status, ec.version, ec.start_date, ec.end_date,
            ec.job_title, ec.salary, ec.gross_salary, ec.currency, ec.salary_frequency,
            ec.probation_start_date, ec.probation_end_date, ec.legal_framework_version,
            ec.template_id, ec.executed_document_id, ec.created_at, ec.updated_at,
            e.id AS employee_id, e.employee_no, e.first_name, e.last_name,
            d.name AS department_name, b.name AS branch_name, c.name AS company_name
     FROM employment_contracts ec
     JOIN employees e ON e.id = ec.employee_id
     LEFT JOIN departments d ON d.id = ec.department_id
     LEFT JOIN branches b ON b.id = ec.branch_id
     JOIN companies c ON c.id = ec.company_id
     WHERE ${whereSql}
     ORDER BY ec.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: toCamelRows(res.rows), total, page, pageSize };
}

export async function myContracts(client: pg.PoolClient, ctx: Ctx, filters: { page?: number; pageSize?: number } = {}) {
  const employeeId = await employeeIdForUser(client, ctx);
  if (!employeeId) return { items: [], total: 0, page: 1, pageSize: 0, employeeId: null };
  const out = await listContracts(client, ctx, { ...filters, employeeId });
  return { ...out, employeeId };
}

export async function getContract(client: pg.PoolClient, ctx: Ctx, contractId: number) {
  const res = await client.query(
    `SELECT ec.*, e.employee_no, e.first_name, e.last_name, e.email AS employee_email, e.phone AS employee_phone,
            e.address AS employee_address, e.dob, e.national_id, e.hire_date,
            e.photo_path, e.photo_mime, e.photo_kind, (e.photo_path IS NOT NULL) AS has_photo,
            d.name AS department_name, b.name AS branch_name, c.name AS company_name, c.legal_name AS company_legal_name,
            c.address AS company_address, c.phone AS company_phone, c.email AS company_email, c.tin,
            c.website AS company_website,
            emp_rep.first_name || ' ' || emp_rep.last_name AS reporting_manager_name
     FROM employment_contracts ec
     JOIN employees e ON e.id = ec.employee_id
     LEFT JOIN departments d ON d.id = ec.department_id
     LEFT JOIN branches b ON b.id = ec.branch_id
     JOIN companies c ON c.id = ec.company_id
     LEFT JOIN employees emp_rep ON emp_rep.id = ec.reporting_manager
     WHERE ec.id = $1 AND ec.tenant_id = $2 AND ec.company_id = $3 AND ec.deleted_at IS NULL`,
    [contractId, ctx.tenantId, ctx.companyId]
  );
  if (res.rows.length === 0) throw notFound('Contract not found');
  const contract = toCamelRow(res.rows[0]);

  const [termsRes, allowancesRes, benefitsRes, signaturesRes, approvalsRes, complianceRes, variationsRes, renewalsRes, certsRes, docsRes] =
    await Promise.all([
      client.query(`SELECT * FROM employment_terms WHERE contract_id = $1 ORDER BY sort_order, id`, [contractId]),
      client.query(`SELECT * FROM contract_allowances WHERE contract_id = $1 ORDER BY id`, [contractId]),
      client.query(`SELECT * FROM contract_benefits WHERE contract_id = $1 ORDER BY id`, [contractId]),
      client.query(`SELECT * FROM contract_signatures WHERE contract_id = $1 ORDER BY id`, [contractId]),
      client.query(
        `SELECT ca.*, u.first_name AS approver_first_name, u.last_name AS approver_last_name
         FROM contract_approvals ca LEFT JOIN users u ON u.id = ca.approver_user_id
         WHERE ca.contract_id = $1 ORDER BY ca.step_seq`, [contractId]
      ),
      client.query(
        `SELECT * FROM compliance_checks WHERE contract_id = $1 ORDER BY checked_at DESC LIMIT 10`, [contractId]
      ),
      client.query(`SELECT * FROM contract_variations WHERE contract_id = $1 ORDER BY id`, [contractId]),
      client.query(`SELECT * FROM contract_renewals WHERE contract_id = $1 ORDER BY id`, [contractId]),
      client.query(`SELECT * FROM certificate_of_service WHERE contract_id = $1 ORDER BY id`, [contractId]),
      client.query(`SELECT * FROM contract_documents WHERE contract_id = $1 ORDER BY id`, [contractId]),
    ]);

  const auditRes = await client.query(
    `SELECT id, action, resource, record_id, record_code, user_id, ip, user_agent, device, metadata, created_at
     FROM audit_logs
     WHERE tenant_id = $1 AND company_id = $2 AND resource = 'employment_contracts' AND record_id = $3
     ORDER BY id DESC LIMIT 50`,
    [ctx.tenantId, ctx.companyId, contractId]
  );

  return {
    contract,
    terms: toCamelRows(termsRes.rows),
    allowances: toCamelRows(allowancesRes.rows),
    benefits: toCamelRows(benefitsRes.rows),
    signatures: toCamelRows(signaturesRes.rows),
    approvals: toCamelRows(approvalsRes.rows),
    compliance: toCamelRows(complianceRes.rows),
    variations: toCamelRows(variationsRes.rows),
    renewals: toCamelRows(renewalsRes.rows),
    certificates: toCamelRows(certsRes.rows),
    documents: toCamelRows(docsRes.rows),
    audit: toCamelRows(auditRes.rows),
  };
}

async function loadContractRow(client: pg.PoolClient, ctx: Ctx, contractId: number, expectedStatus?: string[]) {
  const res = await client.query(
    `SELECT ec.*, e.employee_no, e.first_name, e.last_name, e.user_id AS employee_user_id,
            e.position AS employee_position
     FROM employment_contracts ec JOIN employees e ON e.id = ec.employee_id
     WHERE ec.id = $1 AND ec.tenant_id = $2 AND ec.company_id = $3 AND ec.deleted_at IS NULL`,
    [contractId, ctx.tenantId, ctx.companyId]
  );
  if (res.rows.length === 0) throw notFound('Contract not found');
  const row = res.rows[0];
  if (expectedStatus && !expectedStatus.includes(String(row.status))) {
    throw badRequest(`Contract is ${row.status}; expected ${expectedStatus.join(' or ')}`);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Templates, clauses, legal rules (read side)
// ---------------------------------------------------------------------------

export async function listTemplates(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT ct.*, ctv.version AS current_version
     FROM contract_templates ct
     LEFT JOIN contract_template_versions ctv
       ON ctv.template_id = ct.id AND ctv.status = 'ACTIVE'
     WHERE ct.company_id = $1 AND ct.tenant_id = $2 AND ct.deleted_at IS NULL AND ct.status <> 'ARCHIVED'
     ORDER BY ct.name`,
    [ctx.companyId, ctx.tenantId]
  );
  return toCamelRows(res.rows);
}

export async function getTemplate(client: pg.PoolClient, ctx: Ctx, templateId: number) {
  const tpl = await client.query(
    `SELECT ct.* FROM contract_templates ct
     WHERE ct.id = $1 AND ct.company_id = $2 AND ct.tenant_id = $3 AND ct.deleted_at IS NULL`,
    [templateId, ctx.companyId, ctx.tenantId]
  );
  if (tpl.rows.length === 0) throw notFound('Template not found');
  const versions = await client.query(
    `SELECT * FROM contract_template_versions WHERE template_id = $1 ORDER BY version DESC`,
    [templateId]
  );
  return { template: toCamelRow(tpl.rows[0]), versions: toCamelRows(versions.rows) };
}

export async function listClauses(client: pg.PoolClient, ctx: Ctx, filters: { category?: string; status?: string; q?: string } = {}) {
  const params: unknown[] = [ctx.companyId, ctx.tenantId];
  const where = ['cc.company_id = $1', 'cc.tenant_id = $2', 'cc.deleted_at IS NULL'];
  if (filters.category) {
    params.push(filters.category);
    where.push(`cc.category = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`cc.status = $${params.length}`);
  } else {
    where.push(`cc.status = 'ACTIVE'`);
  }
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    where.push(`(cc.clause_code ILIKE $${params.length} OR cc.name ILIKE $${params.length})`);
  }
  const res = await client.query(
    `SELECT cc.*, lr.name AS legal_rule_name, lr.law, lr.law_chapter, lr.section
     FROM contract_clauses cc
     LEFT JOIN legal_rules lr ON lr.id = cc.legal_rule_id
     WHERE ${where.join(' AND ')} ORDER BY cc.category, cc.name`,
    params
  );
  return toCamelRows(res.rows);
}

export async function listLegalRules(client: pg.PoolClient, ctx: Ctx, filters: { status?: string; code?: string } = {}) {
  const params: unknown[] = [ctx.tenantId];
  const where = ['lr.tenant_id = $1'];
  if (filters.status) {
    params.push(filters.status);
    where.push(`lr.status = $${params.length}`);
  }
  if (filters.code) {
    params.push(filters.code);
    where.push(`lr.code = $${params.length}`);
  }
  const res = await client.query(
    `SELECT lr.* FROM legal_rules lr WHERE ${where.join(' AND ')} ORDER BY lr.code, lr.version DESC`,
    params
  );
  return toCamelRows(res.rows);
}

export async function listEmploymentTypes(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT * FROM employment_types WHERE tenant_id = $1 AND status = 'ACTIVE' ORDER BY id`,
    [ctx.tenantId]
  );
  return toCamelRows(res.rows);
}

// ---------------------------------------------------------------------------
// Clause governance
// Tenants may create custom clauses and version their own clause content, but
// centrally controlled statutory clauses (linked to a legal rule or seeded by
// the platform) are frozen and may not be modified by tenants.
// ---------------------------------------------------------------------------

/** A clause is centrally controlled when it is statutory (rule-linked) or was seeded by the platform. */
function isCentrallyControlled(row: Row): boolean {
  return row.legal_rule_id != null || row.created_by == null;
}

export interface CreateClauseInput {
  clauseCode?: string;
  name?: string;
  category?: string;
  text?: string;
  requiredFlag?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  applicableEmployeeTypes?: string[];
  applicableContractTypes?: string[];
  conflictsWith?: string[];
}

/** Tenant-created custom clause. Never linked to a statutory rule; never self-validated. */
export async function createClause(client: pg.PoolClient, ctx: Ctx, input: CreateClauseInput): Promise<Row> {
  const code = String(input.clauseCode ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{1,63}$/.test(code)) {
    throw badRequest('Clause code must be 2-64 characters using letters, digits, underscore or hyphen.');
  }
  if (!String(input.name ?? '').trim()) throw badRequest('Clause name is required.');
  if (!String(input.text ?? '').trim()) throw badRequest('Clause text is required.');
  if (input.requiredFlag && !['REQUIRED', 'OPTIONAL', 'CONDITIONAL'].includes(input.requiredFlag)) {
    throw badRequest('requiredFlag must be REQUIRED, OPTIONAL or CONDITIONAL.');
  }
  const existing = await client.query(
    `SELECT 1 FROM contract_clauses WHERE company_id = $1 AND tenant_id = $2 AND clause_code = $3 AND deleted_at IS NULL LIMIT 1`,
    [ctx.companyId, ctx.tenantId, code]
  );
  if (existing.rows.length) throw conflict(`A clause with code ${code} already exists.`);
  const category = String(input.category ?? '').trim() || 'General';
  const text = String(input.text).trim();
  const name = String(input.name).trim();
  const requiredFlag = String(input.requiredFlag ?? 'OPTIONAL');
  const res = await client.query(
    `INSERT INTO contract_clauses (
       company_id, tenant_id, clause_code, name, category, text, version, status,
       effective_from, effective_to, legal_reference, legal_rule_id, required_flag,
       applicable_employee_types, applicable_contract_types, rule_conditions,
       conflicts_with, created_by, approved_by, approval_date, validation_status
     ) VALUES ($1,$2,$3,$4,$5,$6,1,'ACTIVE',$7,$8,NULL,NULL,$9,$10,$11,'[]'::jsonb,$12,$13,NULL,NULL,'PENDING_REVIEW')
     RETURNING *`,
    [
      ctx.companyId, ctx.tenantId, code, name, category, text,
      input.effectiveFrom ? input.effectiveFrom.slice(0, 10) : null,
      input.effectiveTo ? input.effectiveTo.slice(0, 10) : null,
      requiredFlag,
      pgArr(input.applicableEmployeeTypes ?? []),
      pgArr(input.applicableContractTypes ?? []),
      pgArr(input.conflictsWith ?? []),
      ctx.userId ?? null,
    ]
  );
  const row = res.rows[0] as Row;
  await client.query(
    `INSERT INTO contract_clause_versions (
       company_id, tenant_id, clause_id, version, name, category, text, status,
       effective_from, effective_to, legal_reference, legal_rule_id, required_flag,
       applicable_employee_types, applicable_contract_types, rule_conditions,
       conflicts_with, created_by, validation_status
     ) VALUES ($1,$2,$3,1,$4,$5,$6,'ACTIVE',$7,$8,NULL,NULL,$9,$10,$11,'[]'::jsonb,$12,$13,'PENDING_REVIEW')`,
    [
      ctx.companyId, ctx.tenantId, row.id, name, category, text,
      input.effectiveFrom ? input.effectiveFrom.slice(0, 10) : null,
      input.effectiveTo ? input.effectiveTo.slice(0, 10) : null,
      requiredFlag,
      pgArr(input.applicableEmployeeTypes ?? []),
      pgArr(input.applicableContractTypes ?? []),
      pgArr(input.conflictsWith ?? []),
      ctx.userId ?? null,
    ]
  );
  return toCamelRows([row])[0];
}

export interface CreateClauseVersionInput {
  name?: string;
  category?: string;
  text?: string;
  status?: string;
  effectiveFrom?: string;
  effectiveTo?: string | null;
}

/**
 * Creates a new version of a tenant-owned clause. The superseded version is
 * snapshotted into contract_clause_versions for the audit trail and the head
 * row is advanced. Statutory/centrally controlled clauses are frozen.
 */
export async function createClauseVersion(
  client: pg.PoolClient,
  ctx: Ctx,
  clauseId: number,
  input: CreateClauseVersionInput
): Promise<Row> {
  const cur = await client.query(
    `SELECT * FROM contract_clauses WHERE id = $1 AND company_id = $2 AND tenant_id = $3 AND deleted_at IS NULL`,
    [clauseId, ctx.companyId, ctx.tenantId]
  );
  if (cur.rows.length === 0) throw notFound('Clause not found');
  const row = cur.rows[0] as Row;
  if (isCentrallyControlled(row)) {
    throw forbidden(
      'Centrally controlled statutory clauses may not be modified by tenants. Contact platform support to amend the clause.'
    );
  }
  if (input.status && !['ACTIVE', 'DRAFT', 'ARCHIVED', 'SUPERSEDED'].includes(input.status)) {
    throw badRequest('status must be ACTIVE, DRAFT, ARCHIVED or SUPERSEDED.');
  }
  if (input.text != null && !String(input.text).trim()) throw badRequest('Clause text may not be empty.');

  const newVersion = Number(row.version ?? 1) + 1;
  const name = String(input.name ?? row.name);
  const category = String(input.category ?? row.category);
  const text = String(input.text ?? row.text).trim();
  const status = String(input.status ?? row.status ?? 'ACTIVE');
  const effectiveFrom = input.effectiveFrom ? input.effectiveFrom.slice(0, 10) : row.effective_from;
  const effectiveTo = input.effectiveTo !== undefined ? (input.effectiveTo ? input.effectiveTo.slice(0, 10) : null) : row.effective_to;

  // Snapshot the superseded version into history before advancing the head row.
  await client.query(
    `INSERT INTO contract_clause_versions (
       company_id, tenant_id, clause_id, version, name, category, text, status,
       effective_from, effective_to, legal_reference, legal_rule_id, required_flag,
       applicable_employee_types, applicable_contract_types, rule_conditions,
       conflicts_with, created_by, law, law_chapter, section, law_source, validation_status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     ON CONFLICT (clause_id, version) DO NOTHING`,
    [
      ctx.companyId, ctx.tenantId, row.id, row.version, row.name, row.category, row.text, row.status,
      row.effective_from, row.effective_to, row.legal_reference, row.legal_rule_id, row.required_flag,
      row.applicable_employee_types ?? '{}', row.applicable_contract_types ?? '{}', row.rule_conditions ?? '[]',
      row.conflicts_with ?? '{}', row.created_by, row.law, row.law_chapter, row.section, row.law_source,
      row.validation_status,
    ]
  );

  // A tenant edit invalidates the previous legal review: the new version is pending review.
  const updated = await client.query(
    `UPDATE contract_clauses
     SET name = $3, category = $4, text = $5, version = $6, status = $7,
         effective_from = $8, effective_to = $9, validation_status = 'PENDING_REVIEW',
         updated_at = now()
     WHERE id = $1 AND company_id = $2 AND tenant_id = $10
     RETURNING *`,
    [clauseId, ctx.companyId, name, category, text, newVersion, status, effectiveFrom, effectiveTo, ctx.tenantId]
  );
  const head = updated.rows[0] as Row;

  await client.query(
    `INSERT INTO contract_clause_versions (
       company_id, tenant_id, clause_id, version, name, category, text, status,
       effective_from, effective_to, legal_reference, legal_rule_id, required_flag,
       applicable_employee_types, applicable_contract_types, rule_conditions,
       conflicts_with, created_by, law, law_chapter, section, law_source, validation_status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
    [
      ctx.companyId, ctx.tenantId, head.id, head.version, head.name, head.category, head.text, head.status,
      head.effective_from, head.effective_to, head.legal_reference, head.legal_rule_id, head.required_flag,
      head.applicable_employee_types ?? '{}', head.applicable_contract_types ?? '{}', head.rule_conditions ?? '[]',
      head.conflicts_with ?? '{}', head.created_by, head.law, head.law_chapter, head.section, head.law_source,
      head.validation_status,
    ]
  );
  return toCamelRows([head])[0];
}


// ---------------------------------------------------------------------------
// Compensation & clause machinery
// ---------------------------------------------------------------------------

/** Postgres TEXT[] literal (json() cannot encode Postgres arrays). */
function pgArr(arr: string[] | undefined | null): string {
  return arr && arr.length ? `{${arr.join(',')}}` : '{}';
}

function pgArrToArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v !== 'string') return [];
  const s = v.trim();
  if (s === '' || s === '{}') return [];
  return s
    .replace(/^\{/, '')
    .replace(/\}$/, '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function clampNum(v: unknown, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Latest ACTIVE version of a legal rule for the tenant. */
async function activeRule(client: pg.PoolClient, ctx: Ctx, code: string): Promise<Row | null> {
  const res = await client.query(
    `SELECT * FROM legal_rules
     WHERE tenant_id = $1 AND code = $2 AND status = 'ACTIVE'
     ORDER BY version DESC LIMIT 1`,
    [ctx.tenantId, code]
  );
  return res.rows.length ? (res.rows[0] as Row) : null;
}

function ruleValue(rule: Row | null, key: string): unknown {
  if (!rule) return undefined;
  const rules = (rule.rules ?? {}) as Record<string, unknown>;
  return rules[key];
}

function activeRuleSnapshot(rule: Row | null): { code: string; version: number } | null {
  if (!rule) return null;
  return { code: String(rule.code), version: Number(rule.version) };
}

/** Legal framework descriptor for new contracts; org override via app_settings. */
async function legalFrameworkVersion(client: pg.PoolClient, ctx: Ctx): Promise<string> {
  const fallback =
    'Employment Act (Cap. 226, Laws of Uganda), as amended - ULII consolidation current version 5 June 2026, including the Employment (Amendment) Act, 2025';
  const res = await client.query(
    `SELECT value FROM app_settings
     WHERE tenant_id = $1 AND category = 'hr.contracts' AND key = 'legal_framework_version'
       AND (company_id = $2 OR (company_id IS NULL AND $2 IS NULL))
     ORDER BY (company_id IS NOT NULL) DESC LIMIT 1`,
    [ctx.tenantId, ctx.companyId ?? null]
  );
  if (res.rows.length === 0) return fallback;
  const v = String(res.rows[0].value ?? '');
  return v.trim() ? v.trim() : fallback;
}

export interface AllowanceInput {
  allowanceType: string;
  name?: string;
  amount?: number;
  percentage?: number;
  frequency?: string;
  currency?: string;
  taxable?: boolean;
  payrollTreatment?: string;
  effectiveDate?: string;
  endDate?: string;
}

export interface BenefitInput {
  benefitType: string;
  name?: string;
  employerCost?: number;
  employeeContribution?: number;
  frequency?: string;
  currency?: string;
  taxable?: boolean;
  effectiveDate?: string;
  endDate?: string;
}

export interface CompensationInput {
  basic?: number;
  gross?: number;
  currency?: string;
  frequency?: string;
  allowances?: AllowanceInput[];
  benefits?: BenefitInput[];
}

export interface ProbationInput {
  startDate?: string;
  endDate?: string;
  durationDays?: number;
  review30Day?: string;
  review60Day?: string;
  reviewFinalDate?: string;
}

export interface CreateContractInput {
  employeeId: number;
  contractType: string;
  templateId?: number;
  startDate?: string;
  endDate?: string;
  jobTitle?: string;
  jobCode?: string;
  departmentId?: number;
  branchId?: number;
  location?: string;
  reportingManager?: number;
  employeeCategory?: string;
  probation?: ProbationInput;
  noticePeriodDays?: number;
  noticeBasis?: string;
  workingHoursPerWeek?: number;
  workingDays?: string[];
  restDays?: string[];
  annualLeaveDays?: number;
  salary?: CompensationInput;
  currency?: string;
  grossSalary?: number;
  employerRepName?: string;
  employerRepTitle?: string;
  renewalEligibility?: boolean;
  expiryNotificationDate?: string;
  reason?: string;
  changeReason?: string;
  previousContractId?: number;
  clauseCodes?: string[];
  employmentTypeConfirmed?: boolean;
  handlesPersonalData?: boolean;
  hasConfidentialAccess?: boolean;
  overtimeEligible?: boolean;
}

/** Default approved template per contract type (fallback if no templateId). */
const TYPE_TEMPLATE_CODES: Record<string, string> = {
  PERMANENT: 'TMPL-PERM',
  FIXED_TERM: 'TMPL-FIXED',
  PROBATIONARY: 'TMPL-PROB',
  PART_TIME: 'TMPL-PERM',
  TEMPORARY: 'TMPL-FIXED',
  APPRENTICESHIP: 'TMPL-PERM',
  CASUAL: 'TMPL-PERM',
  INTERNSHIP: 'TMPL-PERM',
  CONSULTANCY: 'TMPL-PERM',
  SECONDMENT: 'TMPL-PERM',
  RENEWAL: 'TMPL-VAR',
  VARIATION: 'TMPL-VAR',
  PROMOTION: 'TMPL-PROMO',
  TRANSFER: 'TMPL-VAR',
  SALARY_ADJUSTMENT: 'TMPL-SAL',
  OTHER: 'TMPL-PERM',
};

function evaluateCondition(
  cond: { field?: string; op?: string; value?: unknown },
  vars: Record<string, unknown>
): boolean {
  const field = cond.field ? String(cond.field) : '';
  const actual = vars[field];
  const expected = cond.value;
  switch (String(cond.op ?? 'eq')) {
    case 'eq':
      return String(actual ?? '') === String(expected ?? '');
    case 'ne':
      return String(actual ?? '') !== String(expected ?? '');
    case 'gt':
      return Number(actual ?? 0) > Number(expected ?? 0);
    case 'gte':
      return Number(actual ?? 0) >= Number(expected ?? 0);
    case 'lt':
      return Number(actual ?? 0) < Number(expected ?? 0);
    case 'lte':
      return Number(actual ?? 0) <= Number(expected ?? 0);
    case 'in':
      return Array.isArray(expected) && expected.map(String).includes(String(actual ?? ''));
    case 'not_in':
      return Array.isArray(expected) && !expected.map(String).includes(String(actual ?? ''));
    default:
      return false;
  }
}

function variableTokens(text: string): string[] {
  const out: string[] = [];
  const re = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

function resolveVariables(text: string, vars: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (whole, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null || v === '') return whole;
    return String(v);
  });
}

function buildVariableMap(
  employee: Row,
  company: Row,
  contract: Row,
  salaryTerms: Row[],
  allowances: Row[],
  probation: Row | null,
  flags: { overtimeEligible?: boolean; hasConfidentialAccess?: boolean; handlesPersonalData?: boolean }
): Record<string, unknown> {
  const basicRow = salaryTerms.find((t) => String(t.component_type) === 'BASIC');
  const grossRow = salaryTerms.find((t) => String(t.component_type) === 'GROSS');
  const basic = basicRow ? Number(basicRow.amount ?? 0) : Number(employee.base_salary ?? contract.salary ?? 0);
  const gross = grossRow ? Number(grossRow.amount ?? 0) : Number(contract.gross_salary ?? basic);
  const currency = String(contract.currency ?? company.currency ?? 'UGX');
  const frequency = String(contract.salary_frequency ?? 'MONTHLY');
  const fmt = (n: number): string => (n > 0 ? n.toLocaleString('en-US') : '');
  return {
    'employee.full_name': `${String(employee.first_name ?? '')} ${String(employee.last_name ?? '')}`.trim(),
    'employee.employee_number': String(employee.employee_no ?? ''),
    'employee.address': String(employee.address ?? ''),
    'employee.job_title': String(contract.job_title ?? employee.position ?? ''),
    'employee.department': String(contract.department_name ?? ''),
    'employee.manager': String(contract.reporting_manager_name ?? ''),
    'employment.start_date': String(contract.start_date ?? ''),
    'employment.contract_end_date': contract.end_date ? String(contract.end_date) : '',
    'employment.contract_type': String(contract.contract_type ?? ''),
    'employment.contract_no': String(contract.contract_no ?? ''),
    'salary.basic': fmt(basic),
    'salary.gross': fmt(gross),
    'salary.currency': currency,
    'salary.pay_frequency': frequency,
    'company.legal_name': String(company.legal_name ?? company.name ?? ''),
    'company.address': String(company.address ?? ''),
    'company.representative': String(contract.employer_rep_name ?? ''),
    'company.representative_title': String(contract.employer_rep_title ?? ''),
    'workplace.location': String(contract.location ?? company.address ?? ''),
    'working_hours': String(contract.working_hours_per_week ?? ''),
    'annual_leave_days': String(contract.annual_leave_days ?? ''),
    'probation.end_date': probation ? String(probation.end_date ?? '') : '',
    'contract.notice_period': String(contract.notice_period_days ?? ''),
    employment_type: String(contract.contract_type ?? ''),
    has_allowances: (allowances ?? []).length > 0,
    overtime_eligible: flags.overtimeEligible ?? true,
    has_confidential_access: flags.hasConfidentialAccess ?? true,
    handles_personal_data: flags.handlesPersonalData ?? true,
  };
}

interface SelectedClauses {
  clauses: Row[];
  sections: Array<{ sectionCode: string; sectionName: string; clauses: string[] }>;
}

/** Map clause codes onto the contract section they belong in. */
export const CONTRACT_CLAUSE_SECTION: Record<string, string> = {
  APPOINTMENT: 'EMPLOYMENT',
  FIXED_TERM: 'EMPLOYMENT',
  PROBATION: 'EMPLOYMENT',
  PROMOTION: 'EMPLOYMENT',
  VARIATION: 'EMPLOYMENT',
  SECONDMENT: 'EMPLOYMENT',
  RENEWAL: 'EMPLOYMENT',
  DUTIES: 'DUTIES',
  SALARY: 'COMPENSATION',
  ALLOWANCES: 'COMPENSATION',
  COMMISSION: 'COMPENSATION',
  BONUS: 'COMPENSATION',
  OVERTIME: 'COMPENSATION',
  WAGES_PAYMENT: 'COMPENSATION',
  PAY_SLIPS: 'COMPENSATION',
  DEDUCTIONS: 'COMPENSATION',
  WORKING_HOURS: 'WORKING_HOURS',
  WORKING_TIME: 'WORKING_HOURS',
  WEEKLY_REST: 'WORKING_HOURS',
  REST_BREAKS: 'WORKING_HOURS',
  PUBLIC_HOLIDAYS: 'WORKING_HOURS',
  ANNUAL_LEAVE: 'LEAVE',
  SICK_LEAVE: 'LEAVE',
  MATERNITY_LEAVE: 'LEAVE',
  PATERNITY_LEAVE: 'LEAVE',
  COMPASSIONATE_LEAVE: 'LEAVE',
  NON_DISCRIMINATION: 'RIGHTS',
  EQUAL_PAY: 'RIGHTS',
  FORCED_LABOUR_PROHIBITION: 'RIGHTS',
  PREGNANCY_PROTECTION: 'RIGHTS',
  SEXUAL_HARASSMENT: 'RIGHTS',
  CHILD_LABOUR_PROHIBITION: 'RIGHTS',
  YOUNG_PERSONS_EMPLOYMENT: 'RIGHTS',
  CONFIDENTIALITY: 'CONFIDENTIALITY',
  DATA_PROTECTION: 'CONFIDENTIALITY',
  INTELLECTUAL_PROPERTY: 'CONFIDENTIALITY',
  COMPANY_PROPERTY: 'CONFIDENTIALITY',
  IT_ACCEPTABLE_USE: 'CONFIDENTIALITY',
  CYBERSECURITY: 'CONFIDENTIALITY',
  CONFLICT_OF_INTEREST: 'CONFIDENTIALITY',
  NON_SOLICITATION: 'CONFIDENTIALITY',
  ANTI_BRIBERY: 'CONFIDENTIALITY',
  ANTI_FRAUD: 'CONFIDENTIALITY',
  HEALTH_SAFETY: 'CONFIDENTIALITY',
  WORKPLACE_CONDUCT: 'CONFIDENTIALITY',
  NOTICE: 'TERMINATION',
  TERMINATION: 'TERMINATION',
  REDUNDANCY: 'TERMINATION',
  DISCIPLINARY: 'TERMINATION',
  GRIEVANCE: 'TERMINATION',
  DISPUTE_RESOLUTION: 'TERMINATION',
  SUMMARY_DISMISSAL: 'TERMINATION',
  UNFAIR_TERMINATION: 'TERMINATION',
  TERMINAL_BENEFITS: 'TERMINATION',
  REDUNDANCY_NOTICE: 'TERMINATION',
  NON_COMPETE_CAUTION: 'TERMINATION',
  GOVERNING_LAW: 'GENERAL',
  CERTIFICATE_OF_SERVICE: 'GENERAL',
  EMPLOYMENT_RECORDS: 'GENERAL',
};

function clauseSectionCode(clauseCode: string): string {
  return CONTRACT_CLAUSE_SECTION[clauseCode] ?? 'GENERAL';
}

function clauseAppliesToType(clause: Row, contractType: string): boolean {
  const types = pgArrToArray(clause.applicable_contract_types);
  return types.length === 0 || types.includes(contractType);
}

function clauseConditionsPass(clause: Row, vars: Record<string, unknown>): boolean {
  const conditions = (clause.rule_conditions ?? []) as Array<{ field?: string; op?: string; value?: unknown }>;
  if (conditions.length === 0) return true;
  return conditions.every((c) => evaluateCondition(c, vars));
}

function addClauseToSection(
  sections: Array<{ sectionCode: string; sectionName: string; clauses: string[] }>,
  clauseCode: string
): void {
  if (sections.some((s) => s.clauses.includes(clauseCode))) return;
  const sectionCode = clauseSectionCode(clauseCode);
  let sec = sections.find((s) => s.sectionCode === sectionCode);
  if (!sec) {
    sec = { sectionCode, sectionName: '', clauses: [] };
    const sigIdx = sections.findIndex((s) => s.sectionCode === 'SIGNATURES');
    if (sigIdx >= 0) sections.splice(sigIdx, 0, sec);
    else sections.push(sec);
  }
  sec.clauses.push(clauseCode);
}

/**
 * Instantiate clauses from the template, extra codes chosen in the composer,
 * and every REQUIRED clause that applies to the contract type. Extra codes
 * are attached even when their rule conditions would otherwise hide them, so
 * a printed contract includes every clause the user selected.
 */
async function selectClauses(
  client: pg.PoolClient,
  ctx: Ctx,
  templateContent: Array<{ section_code?: string; clauses?: string[] }> | null,
  contractType: string,
  vars: Record<string, unknown>,
  extraCodes?: string[]
): Promise<SelectedClauses> {
  const extra = new Set((extraCodes ?? []).map((c) => String(c).toUpperCase()).filter(Boolean));
  const sections: Array<{ sectionCode: string; sectionName: string; clauses: string[] }> = [];
  const templateCodes = new Set<string>();
  for (const sec of templateContent ?? []) {
    const codes = (sec.clauses ?? []).map((c) => String(c).toUpperCase()).filter(Boolean);
    sections.push({ sectionCode: String(sec.section_code ?? ''), sectionName: '', clauses: [...codes] });
    for (const c of codes) templateCodes.add(c);
  }

  const res = await client.query(
    `SELECT * FROM contract_clauses
     WHERE company_id = $1 AND tenant_id = $2 AND status = 'ACTIVE' AND deleted_at IS NULL`,
    [ctx.companyId, ctx.tenantId]
  );
  const byCode = new Map<string, Row>();
  for (const row of res.rows) byCode.set(String((row as Row).clause_code).toUpperCase(), row as Row);

  const included = new Set<string>();
  const clauses: Row[] = [];
  const consider = (code: string, bypassConditions: boolean): void => {
    const clause = byCode.get(code);
    if (!clause || included.has(code)) return;
    if (!clauseAppliesToType(clause, contractType)) return;
    if (!bypassConditions && !clauseConditionsPass(clause, vars)) return;
    included.add(code);
    clauses.push(clause);
    addClauseToSection(sections, code);
  };

  for (const code of templateCodes) consider(code, false);
  for (const code of extra) consider(code, true);
  for (const [code, clause] of byCode) {
    if (String(clause.required_flag ?? '') !== 'REQUIRED') continue;
    consider(code, false);
  }

  if (sections.length > 0) {
    const secRes = await client.query(
      `SELECT code, name FROM contract_sections WHERE tenant_id = $1`,
      [ctx.tenantId]
    );
    const names = new Map<string, string>();
    for (const r of secRes.rows) names.set(String((r as Row).code), String((r as Row).name));
    for (const s of sections) s.sectionName = names.get(s.sectionCode) ?? s.sectionCode.replace(/_/g, ' ');
  }
  return { clauses, sections };
}


// ---------------------------------------------------------------------------
// Create & validate contracts
// ---------------------------------------------------------------------------

interface JoinedContract {
  row: Row;
}

/** Reload a contract joined with employee/department/manager/company names. */
async function loadContractJoined(client: pg.PoolClient, ctx: Ctx, contractId: number): Promise<JoinedContract> {
  const res = await client.query(
    `SELECT ec.*, e.employee_no, e.first_name, e.last_name, e.address, e.user_id AS employee_user_id,
            e.hire_date AS employee_hire_date, e.base_salary, e.position AS employee_position,
            d.name AS department_name,
            (m.first_name || ' ' || m.last_name) AS reporting_manager_name,
            c.name AS company_name, c.legal_name AS company_legal_name, c.address AS company_address,
            c.currency AS company_currency
     FROM employment_contracts ec
     JOIN employees e ON e.id = ec.employee_id
     LEFT JOIN departments d ON d.id = ec.department_id
     LEFT JOIN employees m ON m.id = ec.reporting_manager
     JOIN companies c ON c.id = ec.company_id
     WHERE ec.id = $1 AND ec.tenant_id = $2 AND ec.company_id = $3 AND ec.deleted_at IS NULL`,
    [contractId, ctx.tenantId, ctx.companyId]
  );
  if (res.rows.length === 0) throw notFound('Contract not found');
  return { row: res.rows[0] as Row };
}

interface ContractCompensation {
  salaryTerms: Row[];
  allowances: Row[];
  benefits: Row[];
  probation: Row | null;
}

async function loadContractCompensation(
  client: pg.PoolClient,
  ctx: Ctx,
  contractId: number
): Promise<ContractCompensation> {
  const [termsRes, allowRes, benefitRes, probRes] = await Promise.all([
    client.query(`SELECT * FROM salary_contract_terms WHERE contract_id = $1 ORDER BY id`, [contractId]),
    client.query(`SELECT * FROM contract_allowances WHERE contract_id = $1 ORDER BY id`, [contractId]),
    client.query(`SELECT * FROM contract_benefits WHERE contract_id = $1 ORDER BY id`, [contractId]),
    client.query(`SELECT * FROM probation_records WHERE contract_id = $1 ORDER BY id DESC LIMIT 1`, [contractId]),
  ]);
  return {
    salaryTerms: termsRes.rows as Row[],
    allowances: allowRes.rows as Row[],
    benefits: benefitRes.rows as Row[],
    probation: probRes.rows.length ? (probRes.rows[0] as Row) : null,
  };
}

async function activeRuleSnapshotAll(client: pg.PoolClient, ctx: Ctx): Promise<Array<{ code: string; version: number }>> {
  const res = await client.query(
    `SELECT code, version FROM legal_rules WHERE tenant_id = $1 AND status = 'ACTIVE'`,
    [ctx.tenantId]
  );
  return res.rows.map((r) => ({ code: String(r.code), version: Number(r.version) }));
}

interface ProbationPlan {
  startDate: string;
  endDate: string | null;
  durationDays: number;
  review30Day: string | null;
  review60Day: string | null;
  reviewFinalDate: string | null;
}

async function probationFromInput(
  client: pg.PoolClient,
  ctx: Ctx,
  input: CreateContractInput,
  startDate: string
): Promise<ProbationPlan | null> {
  const p = input.probation;
  if (!p || (p.startDate == null && p.endDate == null && p.durationDays == null)) return null;
  const pStart = p.startDate ? p.startDate.slice(0, 10) : startDate;
  let pEnd = p.endDate ? p.endDate.slice(0, 10) : null;
  let pDuration = p.durationDays != null ? Number(p.durationDays) : Number.NaN;
  if (!Number.isFinite(pDuration)) {
    pDuration = pEnd ? dateDiffDays(pStart, pEnd) : 0;
  }
  if (pEnd == null && pDuration > 0) pEnd = addDays(pStart, pDuration);
  return {
    startDate: pStart,
    endDate: pEnd,
    durationDays: Number.isFinite(pDuration) ? pDuration : 0,
    review30Day: p.review30Day ? p.review30Day.slice(0, 10) : addDays(pStart, 30),
    review60Day: p.review60Day ? p.review60Day.slice(0, 10) : (pDuration >= 60 ? addDays(pStart, 60) : null),
    reviewFinalDate: p.reviewFinalDate ? p.reviewFinalDate.slice(0, 10) : pEnd,
  };
}

export interface CreateContractResult {
  contractId: number;
  contractNo: string;
  status: string;
  legalFrameworkVersion: string;
  warnings: string[];
}

export async function createContract(
  client: pg.PoolClient,
  ctx: Ctx,
  input: CreateContractInput
): Promise<CreateContractResult> {
  const contractType = String(input.contractType ?? '').toUpperCase();
  if (!contractType) throw badRequest('Contract type is required');

  const typeRes = await client.query(
    `SELECT * FROM employment_types WHERE tenant_id = $1 AND code = $2 AND status = 'ACTIVE'`,
    [ctx.tenantId, contractType]
  );
  if (typeRes.rows.length === 0) throw badRequest(`Unsupported contract type: ${contractType}`);
  const empType = typeRes.rows[0] as Row;

  const warnings: string[] = [];
  if (String(empType.is_employment) !== 'true') {
    if (!input.employmentTypeConfirmed) {
      throw badRequest(
        `${String(empType.name ?? contractType)} is not an employment contract. Confirm the engagement type before continuing.`
      );
    }
    warnings.push(
      'Non-employment agreement: this engagement is not an employment contract under the Employment Act (Cap. 226), as amended. A consultancy or contractor agreement may be required instead.'
    );
  }

  const empRes = await client.query(
    `SELECT * FROM employees WHERE id = $1 AND tenant_id = $2`,
    [input.employeeId, ctx.tenantId]
  );
  if (empRes.rows.length === 0) throw notFound('Employee not found');
  const employee = empRes.rows[0] as Row;

  const companyRes = await client.query(
    `SELECT * FROM companies WHERE id = $1 AND tenant_id = $2`,
    [Number(employee.company_id ?? ctx.companyId), ctx.tenantId]
  );
  if (companyRes.rows.length === 0) throw notFound('Company not found');
  const company = companyRes.rows[0] as Row;

  const startDate = (input.startDate ?? todayIso()).slice(0, 10);
  const endDate = input.endDate ? input.endDate.slice(0, 10) : null;

  // The contractual notice period may never fall below the statutory minimum.
  const serviceM = serviceMonths(String(employee.hire_date ?? ''), startDate);
  const noticeRule = await activeRule(client, ctx, 'NOTICE_PERIOD');
  const statutoryNotice = statutoryNoticeDays(serviceM, noticeRule);
  const noticePeriodDays = Math.max(Number(input.noticePeriodDays ?? 0), statutoryNotice);

  const probation = await probationFromInput(client, ctx, input, startDate);
  if (probation) {
    const maxRule = await activeRule(client, ctx, 'PROBATION_MAX_DURATION');
    const maxDaysRaw = ruleValue(maxRule, 'max_duration_days');
    const maxDays = maxDaysRaw == null || !Number.isFinite(Number(maxDaysRaw)) ? null : Number(maxDaysRaw);
    if (maxDays != null && probation.durationDays > maxDays) {
      throw badRequest(
        `Probationary period of ${probation.durationDays} days exceeds the applicable maximum of ${maxDays} days.`
      );
    }
  }

  // Resolve template (explicit id or the approved default for the type).
  let templateRow: Row | null = null;
  let templateVersionRow: Row | null = null;
  if (input.templateId) {
    const t = await client.query(
      `SELECT * FROM contract_templates
       WHERE id = $1 AND company_id = $2 AND tenant_id = $3 AND deleted_at IS NULL
         AND status IN ('ACTIVE','DRAFT')`,
      [input.templateId, ctx.companyId, ctx.tenantId]
    );
    if (t.rows.length === 0) throw notFound('Template not found');
    templateRow = t.rows[0] as Row;
    const tv = await client.query(
      `SELECT * FROM contract_template_versions WHERE template_id = $1 AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1`,
      [input.templateId]
    );
    if (tv.rows.length === 0) throw badRequest('Template has no active version');
    templateVersionRow = tv.rows[0] as Row;
  } else {
    const code = TYPE_TEMPLATE_CODES[contractType] ?? 'TMPL-PERM';
    const t = await client.query(
      `SELECT ct.*, ctv.id AS template_version_id, ctv.version AS template_version, ctv.content AS template_content
       FROM contract_templates ct
       JOIN contract_template_versions ctv ON ctv.template_id = ct.id AND ctv.status = 'ACTIVE'
       WHERE ct.company_id = $1 AND ct.tenant_id = $2 AND ct.code = $3 AND ct.deleted_at IS NULL AND ct.status = 'ACTIVE'
       ORDER BY ctv.version DESC LIMIT 1`,
      [ctx.companyId, ctx.tenantId, code]
    );
    if (t.rows.length === 0) throw badRequest(`No active template found for contract type ${contractType}`);
    templateRow = t.rows[0] as Row;
    templateVersionRow = t.rows[0] as Row;
  }
  const templateId = Number(templateRow.id);
  const templateVersionId = Number(templateVersionRow.id);
  const templateContent = (templateVersionRow.content ?? []) as Array<{ section_code?: string; clauses?: string[] }>;

  // Compensation snapshot (authoritative statutory deductions remain with payroll).
  const basic = Number(input.salary?.basic ?? employee.base_salary ?? 0);
  const gross = Number(input.salary?.gross ?? input.grossSalary ?? basic);
  const currency = String(input.salary?.currency ?? input.currency ?? company.currency ?? 'UGX');
  const frequency = String(input.salary?.frequency ?? 'MONTHLY');
  const leaveDefaultRule = await activeRule(client, ctx, 'ANNUAL_LEAVE');
  const annualLeaveDays = Number(input.annualLeaveDays ?? ruleValue(leaveDefaultRule, 'annual_leave_days') ?? 0);
  const workHoursDefaultRule = await activeRule(client, ctx, 'WORKING_TIME');
  const workingHoursPerWeek =
    input.workingHoursPerWeek != null ? Number(input.workingHoursPerWeek) : Number(ruleValue(workHoursDefaultRule, 'max_hours_per_week') ?? 0);
  const departmentId =
    input.departmentId != null ? input.departmentId : employee.department_id != null ? Number(employee.department_id) : null;
  const branchId = input.branchId != null ? input.branchId : employee.branch_id != null ? Number(employee.branch_id) : null;
  const jobTitle = String(input.jobTitle ?? employee.position ?? '');
  const location = String(input.location ?? company.address ?? '');
  const employerRepName = String(input.employerRepName ?? company.legal_name ?? company.name ?? '');
  const employerRepTitle = String(input.employerRepTitle ?? 'Authorised Representative');
  const expiryNotificationDate = input.expiryNotificationDate
    ? input.expiryNotificationDate.slice(0, 10)
    : endDate
      ? addDays(endDate, -30)
      : null;
  const legalFramework = await legalFrameworkVersion(client, ctx);
  const legalRulesSnapshot = await activeRuleSnapshotAll(client, ctx);

  const cols = [
    'employee_id', 'contract_type', 'start_date', 'end_date', 'salary', 'gross_salary', 'salary_frequency',
    'currency', 'legal_framework_version', 'legal_rules_snapshot', 'template_id', 'template_version_id',
    'department_id', 'branch_id', 'location', 'reporting_manager', 'job_title', 'job_code', 'employee_category',
    'probation_start_date', 'probation_end_date', 'probation_duration_days', 'notice_period_days', 'notice_basis',
    'working_hours_per_week', 'working_days', 'rest_days', 'annual_leave_days', 'employer_rep_name',
    'employer_rep_title', 'renewal_eligibility', 'expiry_notification_date', 'reason', 'change_reason',
    'previous_contract_id', 'status', 'created_by',
  ];
  const vals: unknown[] = [
    input.employeeId, contractType, startDate, endDate, basic, gross, frequency, currency, legalFramework,
    JSON.stringify(legalRulesSnapshot), templateId, templateVersionId, departmentId, branchId, location || null,
    input.reportingManager ?? null, jobTitle || null, input.jobCode ?? null, input.employeeCategory ?? null,
    probation ? probation.startDate : null, probation ? probation.endDate : null, probation ? probation.durationDays : null,
    noticePeriodDays || null, input.noticeBasis ?? null, workingHoursPerWeek, pgArr(input.workingDays), pgArr(input.restDays),
    annualLeaveDays, employerRepName || null, employerRepTitle || null, input.renewalEligibility ?? false,
    expiryNotificationDate, input.reason ?? null, input.changeReason ?? null, input.previousContractId ?? null,
    'DRAFT', ctx.userId ?? null,
  ];
  const ph = vals.map((_, i) => `$${i + 1}`).join(',');
  const ins = await client.query(
    `INSERT INTO employment_contracts (${cols.join(',')}) VALUES (${ph}) RETURNING id, contract_no, status`,
    vals
  );
  const contractId = Number(ins.rows[0].id);
  const contractNo = String(ins.rows[0].contract_no);
  const status = String(ins.rows[0].status);

  // Compensation children: salary terms, allowances, benefits, probation.
  if (basic > 0 || gross > 0) {
    await client.query(
      `INSERT INTO salary_contract_terms
         (company_id, tenant_id, contract_id, component_type, name, amount, frequency, currency, taxable, effective_date, source)
       VALUES ($1,$2,$3,'BASIC','Basic Salary',$4,$5,$6,true,$7,'contract')`,
      [ctx.companyId, ctx.tenantId, contractId, basic, frequency, currency, startDate]
    );
    await client.query(
      `INSERT INTO salary_contract_terms
         (company_id, tenant_id, contract_id, component_type, name, amount, frequency, currency, taxable, effective_date, source)
       VALUES ($1,$2,$3,'GROSS','Gross Salary',$4,$5,$6,true,$7,'contract')`,
      [ctx.companyId, ctx.tenantId, contractId, gross, frequency, currency, startDate]
    );
  }
  for (const a of input.salary?.allowances ?? []) {
    const name = String(a.name ?? a.allowanceType ?? 'Allowance');
    const allowanceType = String(a.allowanceType ?? 'OTHER');
    const amount = a.amount != null ? Number(a.amount) : null;
    const percentage = a.percentage != null ? Number(a.percentage) : null;
    const aFreq = String(a.frequency ?? frequency);
    const aCcy = String(a.currency ?? currency);
    const aStart = a.effectiveDate ? a.effectiveDate.slice(0, 10) : startDate;
    const aEnd = a.endDate ? a.endDate.slice(0, 10) : null;
    await client.query(
      `INSERT INTO contract_allowances
         (company_id, tenant_id, contract_id, allowance_type, name, amount, percentage, frequency, currency, taxable, payroll_treatment, effective_date, end_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [ctx.companyId, ctx.tenantId, contractId, allowanceType, name, amount, percentage, aFreq, aCcy, a.taxable ?? true, a.payrollTreatment ?? null, aStart, aEnd]
    );
    await client.query(
      `INSERT INTO salary_contract_terms
         (company_id, tenant_id, contract_id, component_type, name, amount, percentage, frequency, currency, taxable, payroll_treatment, effective_date, end_date, source)
       VALUES ($1,$2,$3,'ALLOWANCE',$4,$5,$6,$7,$8,$9,$10,$11,$12,'contract')`,
      [ctx.companyId, ctx.tenantId, contractId, name, amount, percentage, aFreq, aCcy, a.taxable ?? true, a.payrollTreatment ?? null, aStart, aEnd]
    );
  }
  for (const b of input.salary?.benefits ?? []) {
    await client.query(
      `INSERT INTO contract_benefits
         (company_id, tenant_id, contract_id, benefit_type, name, employer_cost, employee_contribution, frequency, currency, taxable, effective_date, end_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [ctx.companyId, ctx.tenantId, contractId, String(b.benefitType ?? 'OTHER'), String(b.name ?? b.benefitType ?? 'Benefit'), b.employerCost != null ? Number(b.employerCost) : null, b.employeeContribution != null ? Number(b.employeeContribution) : null, String(b.frequency ?? frequency), String(b.currency ?? currency), b.taxable ?? false, b.effectiveDate ? b.effectiveDate.slice(0, 10) : startDate, b.endDate ? b.endDate.slice(0, 10) : null]
    );
  }
  if (probation) {
    await client.query(
      `INSERT INTO probation_records
         (company_id, tenant_id, contract_id, employee_id, start_date, end_date, duration_days, review_30_day, review_60_day, review_final_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ctx.companyId, ctx.tenantId, contractId, input.employeeId, probation.startDate, probation.endDate, probation.durationDays, probation.review30Day, probation.review60Day, probation.reviewFinalDate]
    );
  }

  // Reload with trigger-backfilled values, then build the document content.
  const joined = await loadContractJoined(client, ctx, contractId);
  const comp = await loadContractCompensation(client, ctx, contractId);
  const flags = {
    overtimeEligible: input.overtimeEligible ?? true,
    hasConfidentialAccess: input.hasConfidentialAccess ?? true,
    handlesPersonalData: input.handlesPersonalData ?? true,
  };
  const employeeMap = { ...joined.row, position: joined.row.employee_position } as Row;
  const companyMap = {
    name: joined.row.company_name,
    legal_name: joined.row.company_legal_name,
    address: joined.row.company_address,
    currency: joined.row.company_currency,
  } as Row;
  const vars = buildVariableMap(employeeMap, companyMap, joined.row, comp.salaryTerms, comp.allowances, comp.probation, flags);
  const { clauses, sections } = await selectClauses(client, ctx, templateContent, contractType, vars, input.clauseCodes);

  const clauseByCode = new Map<string, Row>();
  for (const c of clauses) clauseByCode.set(String(c.clause_code), c);

  const content: { sections: Array<Record<string, unknown>>; variables: Record<string, unknown>; unresolved: string[] } = {
    sections: sections.map((sec) => ({
      sectionCode: sec.sectionCode,
      sectionName: sec.sectionName,
      clauses: sec.clauses
        .filter((code) => clauseByCode.has(code))
        .map((code) => {
          const c = clauseByCode.get(code) as Row;
          return {
            clauseCode: String(c.clause_code),
            name: String(c.name),
            text: resolveVariables(String(c.text ?? ''), vars),
            legalReference: c.legal_reference ? String(c.legal_reference) : null,
            required: String(c.required_flag ?? 'OPTIONAL'),
          };
        }),
    })),
    variables: vars,
    unresolved: [],
  };

  const unresolvedSet = new Set<string>();
  for (const c of clauses) {
    for (const tok of variableTokens(String(c.text ?? ''))) {
      const v = vars[tok];
      if (v === undefined || v === null || v === '') unresolvedSet.add(tok);
    }
  }
  content.unresolved = [...unresolvedSet].sort();

  let order = 0;
  for (const sec of content.sections) {
    for (const cl of sec.clauses as Array<Record<string, unknown>>) {
      order += 1;
      const clause = clauseByCode.get(String(cl.clauseCode));
      await client.query(
        `INSERT INTO employment_terms
           (company_id, tenant_id, contract_id, term_type, title, description, value, clause_id, clause_version, legal_reference, sort_order)
         VALUES ($1,$2,$3,'CLAUSE',$4,NULL,$5,$6,$7,$8,$9)`,
        [ctx.companyId, ctx.tenantId, contractId, String(cl.name), JSON.stringify({ text: cl.text, clauseCode: cl.clauseCode }), clause ? Number(clause.id) : null, clause ? Number(clause.version) : null, cl.legalReference ? String(cl.legalReference) : null, order]
      );
    }
  }
  await client.query(
    `UPDATE employment_contracts SET content = $1, updated_by = $2 WHERE id = $3`,
    [JSON.stringify(content), ctx.userId ?? null, contractId]
  );

  await logAudit(client, ctx, {
    action: 'contract.create',
    resource: 'employment_contracts',
    recordId: contractId,
    recordCode: contractNo,
    newValues: { contractType, startDate, status: 'DRAFT', templateId },
    metadata: { templateVersionId, legalFramework },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.contract_created',
    entityType: 'hr.contracts',
    entityId: contractId,
    entityCode: contractNo,
    payload: { contractType, status: 'DRAFT', startDate },
  });

  return { contractId, contractNo, status, legalFrameworkVersion: legalFramework, warnings };
}

// ---------------------------------------------------------------------------
// Compliance validation
// ---------------------------------------------------------------------------

export interface ComplianceIssue {
  code: string;
  check: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  legalRef?: string;
  ruleCode?: string;
  reason: string;
}

export interface ValidateContractResult {
  result: 'GREEN' | 'AMBER' | 'RED';
  issues: ComplianceIssue[];
  summary: { passed: number; warnings: number; failed: number };
  legalFrameworkVersion: string;
}

export async function validateContract(
  client: pg.PoolClient,
  ctx: Ctx,
  contractId: number
): Promise<ValidateContractResult> {
  const { row } = await loadContractJoined(client, ctx, contractId);
  const legalFramework = String(row.legal_framework_version ?? (await legalFrameworkVersion(client, ctx)));
  const termsRes = await client.query(
    `SELECT * FROM employment_terms WHERE contract_id = $1 AND term_type = 'CLAUSE' ORDER BY sort_order`,
    [contractId]
  );
  const terms = termsRes.rows as Row[];
  const comp = await loadContractCompensation(client, ctx, contractId);

  const issues: ComplianceIssue[] = [];
  const add = (
    code: string,
    check: string,
    status: 'PASS' | 'WARN' | 'FAIL',
    reason: string,
    opts: { legalRef?: string; ruleCode?: string } = {}
  ) => {
    issues.push({ code, check, status, reason, legalRef: opts.legalRef, ruleCode: opts.ruleCode });
  };
  const lawRef = 'Employment Act (Cap. 226, Laws of Uganda), as amended';
  const particularsRule = await activeRule(client, ctx, 'WRITTEN_PARTICULARS');
  const requiredParticulars = ((ruleValue(particularsRule, 'required_particulars') as string[]) ?? []).map((x) => String(x));
  const required = (key: string) => requiredParticulars.includes(key);

  const employeeName = `${String(row.first_name ?? '')} ${String(row.last_name ?? '')}`.trim();

  if (required('employer_identity')) {
    const legalName = String(row.company_legal_name ?? '');
    add(
      'EMPLOYER_IDENTITY',
      'Employer identified',
      legalName ? 'PASS' : 'FAIL',
      legalName ? `Employer: ${legalName}.` : 'The employer legal name must be identified in the contract.',
      { legalRef: lawRef, ruleCode: 'WRITTEN_PARTICULARS' }
    );
    if (!String(row.company_address ?? '')) {
      add('EMPLOYER_ADDRESS', 'Employer address', 'WARN', 'The employer physical/postal address is not recorded.', {
        legalRef: lawRef,
        ruleCode: 'WRITTEN_PARTICULARS',
      });
    }
  }
  if (!String(row.employer_rep_name ?? '')) {
    add('EMPLOYER_REPRESENTATIVE', 'Employer representative', 'WARN', 'No employer representative is recorded; add one before requesting signatures.', { legalRef: lawRef });
  }
  if (required('employee_identity')) {
    add(
      'EMPLOYEE_IDENTITY',
      'Employee identified',
      employeeName ? 'PASS' : 'FAIL',
      employeeName ? `Employee: ${employeeName}.` : 'The employee full legal name must be identified.',
      { legalRef: lawRef, ruleCode: 'WRITTEN_PARTICULARS' }
    );
  }
  if (required('start_date')) {
    add(
      'START_DATE',
      'Employment start date',
      row.start_date ? 'PASS' : 'FAIL',
      row.start_date ? `Start date: ${String(row.start_date)}.` : 'The employment start date is required.',
      { legalRef: lawRef, ruleCode: 'WRITTEN_PARTICULARS' }
    );
  }
  if (required('job_title')) {
    const jt = String(row.job_title ?? '');
    add(
      'JOB_TITLE',
      'Job title',
      jt ? 'PASS' : 'FAIL',
      jt ? `Job title: ${jt}.` : 'The job title is required.',
      { legalRef: lawRef, ruleCode: 'WRITTEN_PARTICULARS' }
    );
  }
  if (required('workplace')) {
    const workplace = String(row.location ?? row.company_address ?? '');
    add(
      'WORKPLACE',
      'Workplace',
      workplace ? 'PASS' : 'FAIL',
      workplace ? `Workplace: ${workplace}.` : 'The workplace or work location is required.',
      { legalRef: lawRef, ruleCode: 'WRITTEN_PARTICULARS' }
    );
  }
  if (required('compensation')) {
    const salary = Number(row.salary ?? 0);
    add(
      'COMPENSATION',
      'Compensation',
      salary > 0 ? 'PASS' : 'FAIL',
      salary > 0 ? `Basic salary recorded (${Number(row.gross_salary ?? salary).toLocaleString('en-US')} ${String(row.currency ?? 'UGX')}).` : 'The basic salary must be recorded.',
      { legalRef: lawRef, ruleCode: 'WRITTEN_PARTICULARS' }
    );
  }
  if (required('payment_interval')) {
    const freq = String(row.salary_frequency ?? '');
    const valid = ['MONTHLY', 'WEEKLY', 'FORTNIGHTLY', 'HOURLY', 'DAILY', 'ANNUAL'].includes(freq);
    add(
      'PAYMENT_INTERVAL',
      'Payment interval',
      valid ? 'PASS' : 'FAIL',
      valid ? `Payment interval: ${freq}.` : 'The salary payment interval must be specified.',
      { legalRef: lawRef, ruleCode: 'WRITTEN_PARTICULARS' }
    );
  }
  if (required('working_hours')) {
    const wh = Number(row.working_hours_per_week ?? 0);
    add(
      'WORKING_HOURS',
      'Working hours',
      wh > 0 ? 'PASS' : 'FAIL',
      wh > 0 ? `Normal working hours: ${wh} per week.` : 'The normal working hours must be specified.',
      { legalRef: lawRef, ruleCode: 'WRITTEN_PARTICULARS' }
    );
  }

  // Hours of work (Employment Act (Cap. 226), s.52, as amended): normal hours may not exceed 48 per week.
  const workTimeRule = await activeRule(client, ctx, 'WORKING_TIME');
  const maxWeeklyHoursRaw = ruleValue(workTimeRule, 'max_hours_per_week');
  const maxWeeklyHours = maxWeeklyHoursRaw == null ? null : Number(maxWeeklyHoursRaw);
  const recordedHours = Number(row.working_hours_per_week ?? 0);
  if (maxWeeklyHours != null && Number.isFinite(maxWeeklyHours) && recordedHours > 0) {
    add(
      'WORKING_TIME',
      'Hours of work',
      recordedHours <= maxWeeklyHours ? 'PASS' : 'FAIL',
      recordedHours <= maxWeeklyHours
        ? `Normal working hours: ${recordedHours} per week (statutory maximum ${maxWeeklyHours}).`
        : `Normal working hours of ${recordedHours} per week exceed the statutory maximum of ${maxWeeklyHours} hours (Employment Act (Cap. 226), s.52, as amended).`,
      { legalRef: `${lawRef}, s.52`, ruleCode: 'WORKING_TIME' }
    );
  }

  // Weekly rest (Employment Act (Cap. 226), s.50, as amended): at least 24 consecutive hours of rest each week.
  const weeklyRestRule = await activeRule(client, ctx, 'WEEKLY_REST');
  const maxConsecutiveDaysRaw = ruleValue(weeklyRestRule, 'max_consecutive_working_days');
  const maxConsecutiveDays = maxConsecutiveDaysRaw == null ? null : Number(maxConsecutiveDaysRaw);
  const scheduledDays = pgArrToArray(row.working_days);
  if (maxConsecutiveDays != null && Number.isFinite(maxConsecutiveDays) && scheduledDays.length > 0) {
    add(
      'WEEKLY_REST',
      'Weekly rest',
      scheduledDays.length <= maxConsecutiveDays ? 'PASS' : 'FAIL',
      scheduledDays.length <= maxConsecutiveDays
        ? `Working days per week: ${scheduledDays.length} (statutory maximum ${maxConsecutiveDays} consecutive days).`
        : `The employee is scheduled to work ${scheduledDays.length} days per week, exceeding the maximum of ${maxConsecutiveDays} consecutive working days without a weekly rest of at least 24 hours (Employment Act (Cap. 226), s.50, as amended).`,
      { legalRef: `${lawRef}, s.50`, ruleCode: 'WEEKLY_REST' }
    );
  }
  if (required('leave')) {
    const leaveRule = await activeRule(client, ctx, 'ANNUAL_LEAVE');
    const statutoryMinRaw = ruleValue(leaveRule, 'annual_leave_days');
    const statutoryMin = statutoryMinRaw == null ? null : Number(statutoryMinRaw);
    const leaveDays = Number(row.annual_leave_days ?? 0);
    if (statutoryMin != null && Number.isFinite(statutoryMin)) {
      add(
        'ANNUAL_LEAVE',
        'Annual leave',
        leaveDays >= statutoryMin ? 'PASS' : 'FAIL',
        leaveDays >= statutoryMin
          ? `Annual leave: ${leaveDays} days (statutory minimum ${statutoryMin}).`
          : `Annual leave of ${leaveDays} days is below the statutory minimum of ${statutoryMin} working days.`,
        { legalRef: lawRef, ruleCode: 'ANNUAL_LEAVE' }
      );
    }
  }
  if (required('notice')) {
    const noticeDays = Number(row.notice_period_days ?? 0);
    const serviceM = serviceMonths(String(row.employee_hire_date ?? ''), String(row.start_date ?? ''));
    const noticeRule = await activeRule(client, ctx, 'NOTICE_PERIOD');
    const statutory = statutoryNoticeDays(serviceM, noticeRule);
    add(
      'NOTICE',
      'Notice period',
      noticeDays >= statutory ? 'PASS' : 'FAIL',
      noticeDays >= statutory
        ? `Notice: ${noticeDays} days (statutory minimum ${statutory}).`
        : `The notice period of ${noticeDays} days is below the statutory minimum of ${statutory} days for this length of service.`,
      { legalRef: `${lawRef}, s.58(3)`, ruleCode: 'NOTICE_PERIOD' }
    );
  }

  const contractType = String(row.contract_type ?? '');
  if (contractType === 'PROBATIONARY' || comp.probation) {
    const maxRule = await activeRule(client, ctx, 'PROBATION_MAX_DURATION');
    const maxDaysRaw = ruleValue(maxRule, 'max_duration_days');
    const maxDays = maxDaysRaw == null || !Number.isFinite(Number(maxDaysRaw)) ? null : Number(maxDaysRaw);
    if (!comp.probation) {
      add('PROBATION', 'Probation period', 'FAIL', 'A probationary contract must include a probation period.', {
        legalRef: lawRef,
        ruleCode: 'PROBATION_MAX_DURATION',
      });
    } else {
      const dur = Number(comp.probation.duration_days ?? 0);
      const ok = dur > 0 && (maxDays == null || dur <= maxDays);
      add(
        'PROBATION',
        'Probation period',
        ok ? 'PASS' : 'FAIL',
        ok
          ? `Probation: ${dur} days${maxDays != null ? ` (maximum ${maxDays})` : ''}.`
          : `The probation period (${dur} days) must be positive${maxDays != null ? ` and must not exceed ${maxDays} days` : ''}.`,
        { legalRef: lawRef, ruleCode: 'PROBATION_MAX_DURATION' }
      );
    }
  }
  if (contractType === 'FIXED_TERM' && !row.end_date) {
    add('FIXED_TERM_DURATION', 'Fixed-term duration', 'FAIL', 'A fixed-term contract must have an end date.', { legalRef: lawRef });
  }

  // Conflicting clause detection.
  const clauseCodes = new Set<string>();
  for (const t of terms) {
    const v = (t.value ?? {}) as Record<string, unknown>;
    if (v.clauseCode) clauseCodes.add(String(v.clauseCode));
  }
  if (clauseCodes.size > 0) {
    const clRes = await client.query(
      `SELECT clause_code, conflicts_with FROM contract_clauses
       WHERE company_id = $1 AND tenant_id = $2 AND clause_code = ANY($3)`,
      [ctx.companyId, ctx.tenantId, [...clauseCodes]]
    );
    for (const c of clRes.rows as Row[]) {
      for (const other of pgArrToArray(c.conflicts_with)) {
        if (clauseCodes.has(other)) {
          add(
            'CONFLICTING_CLAUSES',
            'Conflicting clauses',
            'FAIL',
            `Clauses ${String(c.clause_code)} and ${other} conflict and must not appear together.`,
            { legalRef: lawRef }
          );
        }
      }
    }
  }

  // Statutory rights may never be waived.
  const waiverRule = await activeRule(client, ctx, 'STATUTORY_RIGHTS_NON_WAIVER');
  const patterns = ((ruleValue(waiverRule, 'block_clause_patterns') as string[]) ?? []).map((x) => String(x));
  let waiverFound = false;
  if (patterns.length > 0) {
    for (const t of terms) {
      const v = (t.value ?? {}) as Record<string, unknown>;
      const lower = String(v.text ?? '').toLowerCase();
      for (const p of patterns) {
        if (p && lower.includes(String(p).toLowerCase())) {
          waiverFound = true;
          add(
            'STATUTORY_RIGHTS',
            'Statutory rights',
            'FAIL',
            `Block clause: ${String(p)} conflicts with applicable employment law. Statutory employment rights may not be waived.`,
            { legalRef: lawRef, ruleCode: 'STATUTORY_RIGHTS_NON_WAIVER' }
          );
          break;
        }
      }
      if (waiverFound) break;
    }
  }

  // Required smart variables must resolve before approval.
  const content = (row.content ?? {}) as { unresolved?: unknown };
  const unresolved = Array.isArray(content.unresolved) ? content.unresolved.map(String) : [];
  if (unresolved.length > 0) {
    const varRes = await client.query(
      `SELECT code, name FROM contract_variables WHERE tenant_id = $1 AND is_required = true`,
      [ctx.tenantId]
    );
    const requiredVars = new Set(varRes.rows.map((r) => String(r.code)));
    const missingRequired = unresolved.filter((u) => requiredVars.has(u));
    if (missingRequired.length > 0) {
      add(
        'UNRESOLVED_VARIABLES',
        'Variable resolution',
        'WARN',
        `Required variable(s) not resolved: ${missingRequired.map((u) => `{{${u}}}`).join(', ')}. Resolve before approval.`
      );
    }
  }

  const passed = issues.filter((i) => i.status === 'PASS').length;
  const warnings = issues.filter((i) => i.status === 'WARN').length;
  const failed = issues.filter((i) => i.status === 'FAIL').length;
  const result: 'GREEN' | 'AMBER' | 'RED' = failed > 0 ? 'RED' : warnings > 0 ? 'AMBER' : 'GREEN';

  await client.query(
    `INSERT INTO compliance_checks (company_id, tenant_id, contract_id, result, issues, checked_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [ctx.companyId, ctx.tenantId, contractId, result, JSON.stringify(issues), ctx.userId ?? null]
  );
  if (String(row.status ?? '') === 'DRAFT') {
    await client.query(
      `UPDATE employment_contracts SET status = 'VALIDATING', updated_by = $1 WHERE id = $2`,
      [ctx.userId ?? null, contractId]
    );
  }
  await logAudit(client, ctx, {
    action: 'contract.validate',
    resource: 'employment_contracts',
    recordId: contractId,
    recordCode: String(row.contract_no ?? ''),
    newValues: { result, passed, warnings, failed },
  });

  return { result, issues, summary: { passed, warnings, failed }, legalFrameworkVersion: legalFramework };
}


// ---------------------------------------------------------------------------
// Submission, workflow, signatures & verification
// ---------------------------------------------------------------------------

export interface SubmitContractResult {
  contractId: number;
  status: string;
  workflowInstanceId: number | null;
  readyForSignature: boolean;
}

/** Submit a validated contract into the configured approval workflow. */
export async function submitContract(
  client: pg.PoolClient,
  ctx: Ctx,
  contractId: number
): Promise<SubmitContractResult> {
  const row = await loadContractRow(client, ctx, contractId, ['DRAFT', 'VALIDATING']);

  // Compliance gate: the latest check must be GREEN. RED always blocks; AMBER
  // blocks too unless an administrator has configured an explicit override.
  const checkRes = await client.query(
    `SELECT result, issues FROM compliance_checks WHERE contract_id = $1 ORDER BY checked_at DESC, id DESC LIMIT 1`,
    [contractId]
  );
  const latest = checkRes.rows[0];
  if (!latest) {
    throw badRequest('Run compliance validation before submitting the contract');
  }
  const complianceResult = String(latest.result ?? 'RED');
  if (complianceResult !== 'GREEN') {
    const issues = (latest.issues as unknown as ComplianceIssue[]) ?? [];
    const failed = issues.filter((i) => i.status === 'FAIL');
    throw badRequest(
      complianceResult === 'RED'
        ? `Compliance check is RED: ${failed.length} blocking issue(s). Correct and re-validate before submitting.`
        : 'Compliance check is AMBER. Resolve the warnings or have HR review before submitting.'
    );
  }

  await client.query(
    `UPDATE employment_contracts SET status = 'SUBMITTED', submitted_at = now(), updated_by = $1 WHERE id = $2`,
    [ctx.userId ?? null, contractId]
  );
  await logAudit(client, ctx, {
    action: 'contract.submit',
    resource: 'employment_contracts',
    recordId: contractId,
    recordCode: String(row.contract_no ?? ''),
    newValues: { status: 'SUBMITTED' },
  });

  // Define the required signatories up front (status NOT_SENT). They become
  // active only when HR sends the contract for signature.
  const sigExists = await client.query(
    `SELECT 1 FROM contract_signatures WHERE contract_id = $1 AND signer_type = 'EMPLOYEE' LIMIT 1`,
    [contractId]
  );
  if (sigExists.rows.length === 0) {
    const employeeName = `${String(row.first_name ?? '')} ${String(row.last_name ?? '')}`.trim();
    await client.query(
      `INSERT INTO contract_signatures
         (company_id, tenant_id, contract_id, signer_type, signer_user_id, signer_name, signer_email, status)
       VALUES
         ($1,$2,$3,'EMPLOYEE',$4,$5,NULL,'NOT_SENT'),
         ($1,$2,$3,'EMPLOYER_REPRESENTATIVE',NULL,$6,NULL,'NOT_SENT')`,
      [
        ctx.companyId,
        ctx.tenantId,
        contractId,
        row.employee_user_id ? Number(row.employee_user_id) : null,
        employeeName,
        row.employer_rep_name ? String(row.employer_rep_name) : null,
      ]
    );
  }

  const workflowInstanceId = await startWorkflow(client, ctx, {
    entityType: 'hr.contracts',
    entityId: contractId,
    entityCode: String(row.contract_no ?? ''),
    amount: Number(row.gross_salary ?? 0),
  });

  // Auto-approved (no workflow configured): move straight to signature stage.
  const after = await loadContractRow(client, ctx, contractId);
  const status = String(after.status ?? 'SUBMITTED');
  let readyForSignature = false;
  if (status === 'SENT_FOR_SIGNATURE') {
    await client.query(
      `UPDATE employment_contracts SET sent_for_signature_at = COALESCE(sent_for_signature_at, now()), updated_by = $1 WHERE id = $2`,
      [ctx.userId ?? null, contractId]
    );
    readyForSignature = true;
  }

  return { contractId, status, workflowInstanceId, readyForSignature };
}

export interface RequestSignatureInput {
  /** EMPLOYEE | EMPLOYER_REPRESENTATIVE | WITNESS | ALL (default) */
  signerType?: string;
}

/** Send an approved contract for signature; pending signatories move to SENT. */
export async function requestSignature(
  client: pg.PoolClient,
  ctx: Ctx,
  contractId: number,
  input: RequestSignatureInput = {}
) {
  const row = await loadContractRow(client, ctx, contractId, ['SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED']);
  const signerType = input.signerType ? String(input.signerType).toUpperCase() : 'ALL';
  if (!['ALL', 'EMPLOYEE', 'EMPLOYER_REPRESENTATIVE', 'WITNESS'].includes(signerType)) {
    throw badRequest(`Unsupported signer type: ${signerType}`);
  }

  const upd = await client.query(
    `UPDATE contract_signatures
     SET status = 'SENT', sent_at = now()
     WHERE contract_id = $1 AND status = 'NOT_SENT' AND ($2 = 'ALL' OR signer_type = $2)`,
    [contractId, signerType]
  );
  if (Number(upd.rowCount) === 0) {
    throw badRequest('No pending signature rows matched; the contract may already be fully sent or signed');
  }

  await client.query(
    `UPDATE employment_contracts SET sent_for_signature_at = COALESCE(sent_for_signature_at, now()), updated_by = $1 WHERE id = $2`,
    [ctx.userId ?? null, contractId]
  );
  await logAudit(client, ctx, {
    action: 'contract.send_for_signature',
    resource: 'employment_contracts',
    recordId: contractId,
    recordCode: String(row.contract_no ?? ''),
    newValues: { signerType, sent: Number(upd.rowCount) },
  });

  const employeeUserId = row.employee_user_id ? Number(row.employee_user_id) : null;
  if (employeeUserId && (signerType === 'ALL' || signerType === 'EMPLOYEE')) {
    await notifyUserAdvanced(client, ctx, employeeUserId, {
      type: 'SIGNATURE_REQUEST',
      title: 'Contract ready to sign',
      body: `Contract ${String(row.contract_no ?? '')} is ready for your signature.`,
      link: `/hr/contracts/${contractId}`,
      entityType: 'hr.contracts',
      entityId: contractId,
      severity: 'SUCCESS',
      actionRequired: true,
      data: { contractNo: row.contract_no },
    });
  }
  await emitEvent(client, ctx, {
    eventType: 'hr.contract_sent_for_signature',
    entityType: 'hr.contracts',
    entityId: contractId,
    entityCode: String(row.contract_no ?? ''),
    payload: { signerType, sent: Number(upd.rowCount) },
  });

  const sigRes = await client.query(`SELECT * FROM contract_signatures WHERE contract_id = $1 ORDER BY id`, [contractId]);
  return toCamelRows(sigRes.rows);
}
export interface SignContractInput {
  signerType: 'EMPLOYEE' | 'EMPLOYER_REPRESENTATIVE' | 'WITNESS';
  /** Raw signature payload (typed name, drawing token or remote signature). */
  signature?: string;
  /** Public URL of the uploaded signature image for this signatory. */
  signatureUrl?: string;
  witnessName?: string;
  witnessEmail?: string;
}

export interface SignContractResult {
  contractId: number;
  signerType: string;
  status: string;
  executed: boolean;
  signatures: Array<Record<string, unknown>>;
  /** One-time verification secret; returned only when the contract is executed. */
  secret?: string;
  verificationCode?: string;
}

/** Record a signature. When the last required signatory signs, the contract is executed. */
export async function signContract(
  client: pg.PoolClient,
  ctx: Ctx,
  contractId: number,
  input: SignContractInput
): Promise<SignContractResult> {
  const signerType = String(input.signerType ?? '').toUpperCase();
  if (!['EMPLOYEE', 'EMPLOYER_REPRESENTATIVE', 'WITNESS'].includes(signerType)) {
    throw badRequest('signerType must be EMPLOYEE, EMPLOYER_REPRESENTATIVE or WITNESS');
  }
  const row = await loadContractRow(client, ctx, contractId, ['SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED']);

  if (signerType === 'EMPLOYEE') {
    const employeeUserId = row.employee_user_id ? Number(row.employee_user_id) : null;
    if (!employeeUserId || !ctx.userId || Number(ctx.userId) !== employeeUserId) {
      throw forbidden('You may only sign your own contract');
    }
  }

  if (signerType === 'WITNESS') {
    const witnessName = String(input.witnessName ?? '').trim();
    if (!witnessName) throw badRequest('witnessName is required for a witness signature');
    await client.query(
      `INSERT INTO contract_signatures
         (company_id, tenant_id, contract_id, signer_type, signer_name, signer_email, status, signed_at, ip, user_agent, device, signature_url)
       VALUES ($1,$2,$3,'WITNESS',$4,$5,'SIGNED',now(),$6,$7,$8,$9)`,
      [
        ctx.companyId,
        ctx.tenantId,
        contractId,
        witnessName,
        input.witnessEmail ? String(input.witnessEmail) : null,
        ctx.ip ?? null,
        ctx.userAgent ?? null,
        ctx.device ?? null,
        input.signatureUrl ? String(input.signatureUrl) : null,
      ]
    );
    await logAudit(client, ctx, {
      action: 'contract.sign',
      resource: 'employment_contracts',
      recordId: contractId,
      recordCode: String(row.contract_no ?? ''),
      newValues: { signerType: 'WITNESS', status: 'SIGNED' },
    });
    const sigRes = await client.query(`SELECT * FROM contract_signatures WHERE contract_id = $1 ORDER BY id`, [contractId]);
    return {
      contractId,
      signerType,
      status: String(row.status),
      executed: false,
      signatures: toCamelRows(sigRes.rows),
    };
  }

  const sigRes = await client.query(
    `SELECT * FROM contract_signatures WHERE contract_id = $1 AND signer_type = $2 FOR UPDATE`,
    [contractId, signerType]
  );
  const sig = sigRes.rows[0] as Row | undefined;
  if (!sig) throw badRequest(`No ${signerType} signature record exists for this contract`);
  if (String(sig.status) === 'SIGNED') throw conflict(`The ${signerType} signature has already been provided`);
  if (!['NOT_SENT', 'SENT', 'VIEWED'].includes(String(sig.status))) {
    throw badRequest(`Signature is ${String(sig.status)} and cannot be completed`);
  }

  await client.query(
    `UPDATE contract_signatures
     SET status = 'SIGNED', signed_at = now(), signer_user_id = COALESCE(signer_user_id, $1),
         signature = COALESCE($2, signature), signature_url = COALESCE($3, signature_url),
         ip = $4, user_agent = $5, device = $6
     WHERE id = $7`,
    [
      ctx.userId ?? null,
      input.signature ? String(input.signature) : null,
      input.signatureUrl ? String(input.signatureUrl) : null,
      ctx.ip ?? null,
      ctx.userAgent ?? null,
      ctx.device ?? null,
      Number(sig.id),
    ]
  );
  await logAudit(client, ctx, {
    action: 'contract.sign',
    resource: 'employment_contracts',
    recordId: contractId,
    recordCode: String(row.contract_no ?? ''),
    newValues: { signerType, status: 'SIGNED' },
  });

  // Determine whether every required signatory has now signed.
  const statusRes = await client.query(
    `SELECT signer_type, status, signed_at FROM contract_signatures
     WHERE contract_id = $1 AND signer_type IN ('EMPLOYEE','EMPLOYER_REPRESENTATIVE')`,
    [contractId]
  );
  const byType = new Map<string, Row>(statusRes.rows.map((r) => [String(r.signer_type), r as Row]));
  const bothSigned =
    byType.get('EMPLOYEE')?.status === 'SIGNED' && byType.get('EMPLOYER_REPRESENTATIVE')?.status === 'SIGNED';

  if (!bothSigned) {
    await client.query(
      `UPDATE employment_contracts SET status = 'PARTIALLY_SIGNED', updated_by = $1 WHERE id = $2`,
      [ctx.userId ?? null, contractId]
    );
    const partialRes = await client.query(`SELECT * FROM contract_signatures WHERE contract_id = $1 ORDER BY id`, [contractId]);
    return {
      contractId,
      signerType,
      status: 'PARTIALLY_SIGNED',
      executed: false,
      signatures: toCamelRows(partialRes.rows),
    };
  }

  // ---- Fully executed: freeze the record, issue the executed copy + QR secret ----
  const secret = verificationSecret();
  const verificationCodeValue = verificationCode();
  const content = (row.content as Row) ?? {};
  const docHash = sha256(
    JSON.stringify({ contractNo: String(row.contract_no ?? ''), version: Number(row.version ?? 1), content })
  );
  const documentNo = await nextDoc(client, ctx, 'EXEC');

  const docRes = await client.query(
    `INSERT INTO contract_documents
       (company_id, tenant_id, contract_id, document_type, document_no, file_name, mime_type, doc_hash, status)
     VALUES ($1,$2,$3,'EXECUTED_COPY',$4,$5,'application/pdf',$6,'EXECUTED')
     RETURNING id`,
    [ctx.companyId, ctx.tenantId, contractId, documentNo, `${documentNo}.pdf`, docHash]
  );
  const documentId = Number(docRes.rows[0].id);

  await client.query(
    `INSERT INTO document_verification
       (company_id, tenant_id, document_no, document_type, verification_code, secret_hash, doc_hash, status)
     VALUES ($1,$2,$3,'EMPLOYMENT_CONTRACT',$4,$5,$6,'ACTIVE')`,
    [ctx.companyId, ctx.tenantId, String(row.contract_no ?? ''), verificationCodeValue, sha256(secret), docHash]
  );

  const employeeSignedAt = byType.get('EMPLOYEE')?.signed_at ?? null;
  const employerSignedAt = byType.get('EMPLOYER_REPRESENTATIVE')?.signed_at ?? null;

  await client.query(
    `UPDATE employment_contracts
     SET status = 'EXECUTED', doc_hash = $1, executed_document_id = $2,
         signed_by_employee_at = $3, signed_by_employer_at = $4, updated_by = $5
     WHERE id = $6`,
    [docHash, documentId, employeeSignedAt, employerSignedAt, ctx.userId ?? null, contractId]
  );
  await logAudit(client, ctx, {
    action: 'contract.execute',
    resource: 'employment_contracts',
    recordId: contractId,
    recordCode: String(row.contract_no ?? ''),
    newValues: { status: 'EXECUTED', documentNo, docHash, verificationCode: verificationCodeValue },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.contract_executed',
    entityType: 'hr.contracts',
    entityId: contractId,
    entityCode: String(row.contract_no ?? ''),
    payload: { contractNo: row.contract_no, version: row.version, docHash, verificationCode: verificationCodeValue },
  });

  const employeeUserId = row.employee_user_id ? Number(row.employee_user_id) : null;
  if (employeeUserId) {
    await notifyUserAdvanced(client, ctx, employeeUserId, {
      type: 'CONTRACT_EXECUTED',
      title: 'Contract executed',
      body: `Contract ${String(row.contract_no ?? '')} has been fully signed and executed.`,
      link: `/hr/contracts/${contractId}`,
      entityType: 'hr.contracts',
      entityId: contractId,
      severity: 'SUCCESS',
      data: { contractNo: row.contract_no },
    });
  }

  const finalRes = await client.query(`SELECT * FROM contract_signatures WHERE contract_id = $1 ORDER BY id`, [contractId]);
  return {
    contractId,
    signerType,
    status: 'EXECUTED',
    executed: true,
    secret,
    verificationCode: verificationCodeValue,
    signatures: toCamelRows(finalRes.rows),
  };
}

export interface VerifyContractInput {
  code: string;
  secret: string;
}

/**
 * Verify an executed contract via its one-time secret + verification code.
 * The lookup, counter update, audit trail and access log run inside a
 * SECURITY DEFINER function so unauthenticated verification cannot read PII
 * and cannot be blocked by row-level security.
 */
export async function verifyContractDocument(client: pg.PoolClient, ctx: Ctx, input: VerifyContractInput) {
  const code = String(input.code ?? '').trim();
  const secret = String(input.secret ?? '').trim();
  if (!code || !secret) throw badRequest('Verification code and secret are required');
  if (code.length > 80 || secret.length > 128) throw badRequest('Verification payload is not valid');
  const res = await client.query(
    `SELECT verify_contract_document($1,$2,$3,$4,$5,$6,$7) AS result`,
    [
      code,
      secret,
      ctx.ip ?? null,
      ctx.userAgent ?? null,
      ctx.device ?? null,
      ctx.userId ?? null,
      ctx.correlationId ?? null,
    ]
  );
  return res.rows[0].result;
}

export interface ContractVerificationQr {
  contractId: number;
  contractNo: string;
  status: string;
  verificationCode: string;
  verifyCount: number;
  firstVerifiedAt: string | null;
  token: string;
  verifyUrl: string;
  reason: string | null;
}

/**
 * Verification payload for an executed/active contract. Reuses the one-time
 * verification row created at execution and issues a fresh HMAC-signed QR URL
 * that opens the public portal and auto-verifies via verify-document.
 */
export async function verificationQr(
  client: pg.PoolClient,
  ctx: Ctx,
  contractId: number
): Promise<ContractVerificationQr> {
  const row = await loadContractRow(client, ctx, contractId, ['EXECUTED', 'ACTIVE', 'VARIED', 'RENEWED']);
  const verRes = await client.query(
    `SELECT verification_code, verify_count, first_verified_at
     FROM document_verification
     WHERE company_id = $1 AND tenant_id = $2 AND document_no = $3 AND document_type = 'EMPLOYMENT_CONTRACT'
       AND status = 'ACTIVE'
     ORDER BY id DESC LIMIT 1`,
    [ctx.companyId, ctx.tenantId, String(row.contract_no ?? '')]
  );
  const ver = verRes.rows[0] ?? null;
  const { issueEmploymentContractToken } = await import('./documents.js');
  const issued = await issueEmploymentContractToken(client, ctx, contractId);
  return {
    contractId,
    contractNo: String(row.contract_no ?? ''),
    status: String(row.status ?? ''),
    verificationCode: ver ? String(ver.verification_code ?? '') : '',
    verifyCount: ver ? Number(ver.verify_count ?? 0) : 0,
    firstVerifiedAt: ver?.first_verified_at ? new Date(ver.first_verified_at).toISOString() : null,
    token: issued.token,
    verifyUrl: issued.verifyUrl,
    reason: issued.reason,
  };
}

// ---------------------------------------------------------------------------
// Draft updates, variations, renewals, certificates & dashboard
// ---------------------------------------------------------------------------

export interface UpdateContractDraftInput {
  endDate?: string | null;
  jobTitle?: string;
  jobCode?: string;
  departmentId?: number | null;
  branchId?: number | null;
  location?: string;
  reportingManager?: number | null;
  employeeCategory?: string;
  probation?: ProbationInput;
  noticePeriodDays?: number;
  noticeBasis?: string;
  workingHoursPerWeek?: number;
  workingDays?: string[];
  restDays?: string[];
  annualLeaveDays?: number;
  salary?: CompensationInput;
  currency?: string;
  grossSalary?: number;
  employerRepName?: string;
  employerRepTitle?: string;
  renewalEligibility?: boolean;
  expiryNotificationDate?: string | null;
  reason?: string;
  changeReason?: string;
}

/** Patch a DRAFT contract. Executed/active contracts are immutable; use a variation. */
export async function updateContractDraft(
  client: pg.PoolClient,
  ctx: Ctx,
  contractId: number,
  input: UpdateContractDraftInput
) {
  const row = await loadContractRow(client, ctx, contractId, ['DRAFT', 'VALIDATING']);
  const sets: string[] = [];
  const params: unknown[] = [ctx.tenantId, ctx.companyId, contractId];
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  const addSet = (col: string, value: unknown) => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
    oldValues[col] = row[col] ?? null;
    newValues[col] = value ?? null;
  };

  const startDate = toISODate(row.start_date) ?? todayIso();
  if (input.endDate != null) addSet('end_date', input.endDate ? String(input.endDate).slice(0, 10) : null);
  if (input.jobTitle != null) addSet('job_title', input.jobTitle ? String(input.jobTitle) : null);
  if (input.jobCode != null) addSet('job_code', input.jobCode ? String(input.jobCode) : null);
  if (input.departmentId != null) addSet('department_id', Number(input.departmentId) || null);
  if (input.branchId != null) addSet('branch_id', Number(input.branchId) || null);
  if (input.location != null) addSet('location', input.location ? String(input.location) : null);
  if (input.reportingManager != null) addSet('reporting_manager', Number(input.reportingManager) || null);
  if (input.employeeCategory != null) addSet('employee_category', input.employeeCategory ? String(input.employeeCategory) : null);
  if (input.noticeBasis != null) addSet('notice_basis', input.noticeBasis ? String(input.noticeBasis) : null);
  if (input.workingHoursPerWeek != null) addSet('working_hours_per_week', Number(input.workingHoursPerWeek));
  if (input.workingDays != null) addSet('working_days', pgArr(input.workingDays));
  if (input.restDays != null) addSet('rest_days', pgArr(input.restDays));
  if (input.annualLeaveDays != null) addSet('annual_leave_days', Number(input.annualLeaveDays));
  if (input.currency != null) addSet('currency', String(input.currency));
  if (input.grossSalary != null) addSet('gross_salary', Number(input.grossSalary));
  if (input.employerRepName != null) addSet('employer_rep_name', input.employerRepName ? String(input.employerRepName) : null);
  if (input.employerRepTitle != null) addSet('employer_rep_title', input.employerRepTitle ? String(input.employerRepTitle) : null);
  if (input.renewalEligibility != null) addSet('renewal_eligibility', Boolean(input.renewalEligibility));
  if (input.expiryNotificationDate != null) {
    addSet('expiry_notification_date', input.expiryNotificationDate ? String(input.expiryNotificationDate).slice(0, 10) : null);
  }
  if (input.reason != null) addSet('reason', input.reason ? String(input.reason) : null);
  if (input.changeReason != null) addSet('change_reason', input.changeReason ? String(input.changeReason) : null);
  if (input.salary?.basic != null) addSet('salary', Number(input.salary.basic));
  if (input.salary?.frequency != null) addSet('salary_frequency', String(input.salary.frequency));
  if (input.salary?.currency != null) addSet('currency', String(input.salary.currency));
  if (input.noticePeriodDays != null) {
    // The contractual notice period may never fall below the statutory minimum.
    const hireRes = await client.query(`SELECT hire_date FROM employees WHERE id = $1`, [Number(row.employee_id)]);
    const hireDate = hireRes.rows.length ? String(hireRes.rows[0].hire_date ?? '') : '';
    const noticeRule = await activeRule(client, ctx, 'NOTICE_PERIOD');
    addSet('notice_period_days', Math.max(Number(input.noticePeriodDays), statutoryNoticeDays(serviceMonths(hireDate, startDate), noticeRule)));
  }

  let probationPlan: ProbationPlan | null = null;
  if (input.probation) {
    probationPlan = await probationFromInput(client, ctx, input as CreateContractInput, startDate);
    if (probationPlan) {
      const maxRule = await activeRule(client, ctx, 'PROBATION_MAX_DURATION');
      const maxDaysRaw = ruleValue(maxRule, 'max_duration_days');
      const maxDays = maxDaysRaw == null || !Number.isFinite(Number(maxDaysRaw)) ? null : Number(maxDaysRaw);
      if (maxDays != null && probationPlan.durationDays > maxDays) {
        throw badRequest(
          `Probationary period of ${probationPlan.durationDays} days exceeds the applicable maximum of ${maxDays} days.`
        );
      }
      addSet('probation_start_date', probationPlan.startDate);
      addSet('probation_end_date', probationPlan.endDate);
      addSet('probation_duration_days', probationPlan.durationDays);
    }
  }

  if (sets.length > 0) {
    sets.push(`updated_by = $${params.length + 1}`, 'updated_at = now()');
    params.push(ctx.userId ?? null);
    await client.query(
      `UPDATE employment_contracts SET ${sets.join(', ')}
       WHERE tenant_id = $1 AND company_id = $2 AND id = $3 AND deleted_at IS NULL`,
      params
    );
  }

  if (probationPlan) {
    await client.query(`DELETE FROM probation_records WHERE contract_id = $1`, [contractId]);
    await client.query(
      `INSERT INTO probation_records
         (company_id, tenant_id, contract_id, employee_id, start_date, end_date, duration_days,
          review_30_day, review_60_day, review_final_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        ctx.companyId, ctx.tenantId, contractId, Number(row.employee_id),
        probationPlan.startDate, probationPlan.endDate, probationPlan.durationDays,
        probationPlan.review30Day, probationPlan.review60Day, probationPlan.reviewFinalDate,
      ]
    );
  }

  if (sets.length > 0) {
    await logAudit(client, ctx, {
      action: 'contract.update',
      resource: 'employment_contracts',
      recordId: contractId,
      recordCode: String(row.contract_no ?? ''),
      oldValues,
      newValues,
    });
  }
  return getContract(client, ctx, contractId);
}

export interface VariationChange {
  field: string;
  label?: string;
  oldValue?: unknown;
  newValue?: unknown;
}

export interface CreateVariationInput {
  variationType: string;
  reason?: string;
  changes?: VariationChange[];
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  effectiveDate?: string;
}

const VARIATION_TYPES = [
  'SALARY', 'JOB_TITLE', 'DEPARTMENT_TRANSFER', 'WORKPLACE_TRANSFER', 'WORKING_HOURS',
  'ALLOWANCE', 'BENEFITS', 'PROMOTION', 'DEMOTION', 'REPORTING_LINE',
  'CONTRACT_EXTENSION', 'CONTRACT_RENEWAL', 'OTHER',
];

/** Record an intended variation against an executed/active contract (DRAFT). */
export async function createVariation(
  client: pg.PoolClient,
  ctx: Ctx,
  contractId: number,
  input: CreateVariationInput
) {
  const variationType = String(input.variationType ?? '').toUpperCase();
  if (!VARIATION_TYPES.includes(variationType)) {
    throw badRequest(`Unsupported variation type: ${variationType}`);
  }
  const row = await loadContractRow(client, ctx, contractId, ['EXECUTED', 'ACTIVE']);
  const numRes = await client.query(
    `SELECT next_contract_no($1, $2, 'VARIATION', COALESCE($3::date, CURRENT_DATE)) AS code`,
    [ctx.tenantId, ctx.companyId, input.effectiveDate ? String(input.effectiveDate).slice(0, 10) : null]
  );
  const variationNo = String(numRes.rows[0].code);
  const changes = Array.isArray(input.changes)
    ? input.changes.map((c) => ({
        field: String(c.field ?? ''),
        label: c.label != null ? String(c.label) : undefined,
        oldValue: c.oldValue ?? null,
        newValue: c.newValue ?? null,
      }))
    : [];
  const ins = await client.query(
    `INSERT INTO contract_variations
       (company_id, tenant_id, contract_id, variation_no, variation_type, reason, changes,
        old_values, new_values, effective_date, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DRAFT',$11)
     RETURNING *`,
    [
      ctx.companyId, ctx.tenantId, contractId, variationNo, variationType,
      input.reason ? String(input.reason) : null,
      JSON.stringify(changes),
      JSON.stringify(input.oldValues ?? {}),
      JSON.stringify(input.newValues ?? {}),
      input.effectiveDate ? String(input.effectiveDate).slice(0, 10) : null,
      ctx.userId ?? null,
    ]
  );
  const variation = toCamelRow(ins.rows[0]);
  await logAudit(client, ctx, {
    action: 'contract.variation.create',
    resource: 'contract_variations',
    recordId: Number(variation.id),
    recordCode: variationNo,
    newValues: { variationType, contractId, status: 'DRAFT' },
    metadata: { changes },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.contract_variation_created',
    entityType: 'hr.contracts',
    entityId: contractId,
    entityCode: String(row.contract_no ?? ''),
    payload: { variationId: variation.id, variationNo, variationType, status: 'DRAFT' },
  });
  return variation;
}

interface DerivedContractOptions {
  startDate: string;
  endDate: string | null;
  changeReason: string;
  newValues: Record<string, unknown>;
}

/**
 * Insert a derived contract row (VARIATION / RENEWAL) from an executed source.
 * The source contract is never mutated; the trigger assigns the new number and
 * bumps the version. Statutory rights are inherited unchanged from the source.
 */
async function insertDerivedContract(
  client: pg.PoolClient,
  ctx: Ctx,
  source: Row,
  contractType: string,
  opts: DerivedContractOptions
): Promise<number> {
  const nv = opts.newValues;
  const jobTitle = nv.jobTitle != null ? String(nv.jobTitle) : source.job_title != null ? String(source.job_title) : null;
  const jobCode = nv.jobCode != null ? String(nv.jobCode) : source.job_code != null ? String(source.job_code) : null;
  const departmentId = nv.departmentId != null ? Number(nv.departmentId) : source.department_id != null ? Number(source.department_id) : null;
  const branchId = nv.branchId != null ? Number(nv.branchId) : source.branch_id != null ? Number(source.branch_id) : null;
  const location = nv.location != null ? String(nv.location) : source.location != null ? String(source.location) : null;
  const workingHours = nv.workingHoursPerWeek != null ? Number(nv.workingHoursPerWeek) : source.working_hours_per_week != null ? Number(source.working_hours_per_week) : null;
  const annualLeave = nv.annualLeaveDays != null ? Number(nv.annualLeaveDays) : source.annual_leave_days != null ? Number(source.annual_leave_days) : null;
  const noticeDays = nv.noticePeriodDays != null ? Number(nv.noticePeriodDays) : source.notice_period_days != null ? Number(source.notice_period_days) : null;
  const noticeBasis = nv.noticeBasis != null ? String(nv.noticeBasis) : source.notice_basis != null ? String(source.notice_basis) : null;
  const basic = nv.basic != null ? Number(nv.basic) : source.salary != null ? Number(source.salary) : 0;
  const gross = nv.gross != null ? Number(nv.gross) : source.gross_salary != null ? Number(source.gross_salary) : basic;
  const currency = nv.currency != null ? String(nv.currency) : source.currency != null ? String(source.currency) : 'UGX';
  const frequency = nv.frequency != null ? String(nv.frequency) : source.salary_frequency != null ? String(source.salary_frequency) : 'MONTHLY';
  const workingDays = nv.workingDays != null ? pgArr(nv.workingDays as string[]) : pgArr(pgArrToArray(source.working_days));
  const restDays = nv.restDays != null ? pgArr(nv.restDays as string[]) : pgArr(pgArrToArray(source.rest_days));

  const ins = await client.query(
    `INSERT INTO employment_contracts
       (employee_id, contract_type, start_date, end_date, salary, gross_salary, salary_frequency, currency,
        job_title, job_code, department_id, branch_id, location, reporting_manager, employee_category,
        working_hours_per_week, working_days, rest_days, annual_leave_days, notice_period_days, notice_basis,
        employer_rep_name, employer_rep_title, renewal_eligibility, expiry_notification_date,
        legal_framework_version, legal_rules_snapshot, template_id, template_version_id, template_snapshot,
        version, previous_contract_id, change_reason, reason, content, status, created_by)
     VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
        $31,$32,$33,$34,$35,'EXECUTED',$36)
     RETURNING id, contract_no, version`,
    [
      Number(source.employee_id), contractType, opts.startDate, opts.endDate, basic, gross, frequency, currency,
      jobTitle, jobCode, departmentId, branchId, location,
      source.reporting_manager != null ? Number(source.reporting_manager) : null,
      source.employee_category != null ? String(source.employee_category) : null,
      workingHours, workingDays, restDays, annualLeave, noticeDays, noticeBasis,
      source.employer_rep_name != null ? String(source.employer_rep_name) : null,
      source.employer_rep_title != null ? String(source.employer_rep_title) : null,
      source.renewal_eligibility != null ? Boolean(source.renewal_eligibility) : false,
      toISODate(source.expiry_notification_date),
      source.legal_framework_version != null ? String(source.legal_framework_version) : null,
      JSON.stringify(source.legal_rules_snapshot ?? []),
      source.template_id != null ? Number(source.template_id) : null,
      source.template_version_id != null ? Number(source.template_version_id) : null,
      JSON.stringify(source.template_snapshot ?? {}),
      Number(source.version ?? 1) + 1,
      Number(source.id),
      opts.changeReason || null,
      opts.changeReason || null,
      JSON.stringify({ source: 'derived', contractType, previousContractId: Number(source.id), newValues: nv }),
      ctx.userId ?? null,
    ]
  );
  return Number(ins.rows[0].id);
}

async function insertAllowanceRow(
  client: pg.PoolClient,
  ctx: Ctx,
  contractId: number,
  a: Record<string, unknown>
) {
  await client.query(
    `INSERT INTO contract_allowances
       (company_id, tenant_id, contract_id, allowance_type, name, amount, percentage, frequency, currency,
        taxable, payroll_treatment, effective_date, end_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      ctx.companyId, ctx.tenantId, contractId,
      String(a.allowance_type ?? a.allowanceType ?? 'OTHER'),
      String(a.name ?? 'Allowance'),
      a.amount != null ? Number(a.amount) : null,
      a.percentage != null ? Number(a.percentage) : null,
      String(a.frequency ?? 'MONTHLY'),
      String(a.currency ?? 'UGX'),
      a.taxable != null ? Boolean(a.taxable) : true,
      a.payroll_treatment != null ? String(a.payroll_treatment) : null,
      toISODate(a.effective_date),
      toISODate(a.end_date),
    ]
  );
}

async function insertBenefitRow(
  client: pg.PoolClient,
  ctx: Ctx,
  contractId: number,
  b: Record<string, unknown>
) {
  await client.query(
    `INSERT INTO contract_benefits
       (company_id, tenant_id, contract_id, benefit_type, name, employer_cost, employee_contribution,
        frequency, currency, taxable, effective_date, end_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      ctx.companyId, ctx.tenantId, contractId,
      String(b.benefit_type ?? b.benefitType ?? 'OTHER'),
      String(b.name ?? 'Benefit'),
      b.employer_cost != null ? Number(b.employer_cost) : null,
      b.employee_contribution != null ? Number(b.employee_contribution) : null,
      String(b.frequency ?? 'MONTHLY'),
      String(b.currency ?? 'UGX'),
      b.taxable != null ? Boolean(b.taxable) : false,
      toISODate(b.effective_date),
      toISODate(b.end_date),
    ]
  );
}

/** Copy compensation/terms children to the derived contract, applying overrides. */
async function copyContractChildren(
  client: pg.PoolClient,
  ctx: Ctx,
  sourceContractId: number,
  targetContractId: number,
  newValues: Record<string, unknown>
) {
  const termsRes = await client.query(`SELECT * FROM salary_contract_terms WHERE contract_id = $1`, [sourceContractId]);
  for (const t of termsRes.rows as Row[]) {
    let amount = t.amount != null ? Number(t.amount) : null;
    if (String(t.component_type) === 'BASIC' && newValues.basic != null) amount = Number(newValues.basic);
    if (String(t.component_type) === 'GROSS' && newValues.gross != null) amount = Number(newValues.gross);
    await client.query(
      `INSERT INTO salary_contract_terms
         (company_id, tenant_id, contract_id, component_type, name, amount, percentage, frequency, currency,
          taxable, payroll_treatment, effective_date, end_date, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'variation')`,
      [
        ctx.companyId, ctx.tenantId, targetContractId, String(t.component_type), String(t.name ?? ''),
        amount, t.percentage != null ? Number(t.percentage) : null,
        String(t.frequency ?? 'MONTHLY'), String(t.currency ?? 'UGX'),
        t.taxable != null ? Boolean(t.taxable) : true,
        t.payroll_treatment != null ? String(t.payroll_treatment) : null,
        toISODate(t.effective_date),
        toISODate(t.end_date),
      ]
    );
  }

  if (Array.isArray(newValues.allowances) && (newValues.allowances as unknown[]).length > 0) {
    for (const a of newValues.allowances as Array<Record<string, unknown>>) {
      await insertAllowanceRow(client, ctx, targetContractId, a);
    }
  } else {
    const allowRes = await client.query(`SELECT * FROM contract_allowances WHERE contract_id = $1`, [sourceContractId]);
    for (const a of allowRes.rows as Row[]) await insertAllowanceRow(client, ctx, targetContractId, a as Record<string, unknown>);
  }

  if (Array.isArray(newValues.benefits) && (newValues.benefits as unknown[]).length > 0) {
    for (const b of newValues.benefits as Array<Record<string, unknown>>) {
      await insertBenefitRow(client, ctx, targetContractId, b);
    }
  } else {
    const benefitRes = await client.query(`SELECT * FROM contract_benefits WHERE contract_id = $1`, [sourceContractId]);
    for (const b of benefitRes.rows as Row[]) await insertBenefitRow(client, ctx, targetContractId, b as Record<string, unknown>);
  }

  const termsRes2 = await client.query(`SELECT * FROM employment_terms WHERE contract_id = $1 ORDER BY sort_order, id`, [sourceContractId]);
  for (const t of termsRes2.rows as Row[]) {
    await client.query(
      `INSERT INTO employment_terms
         (company_id, tenant_id, contract_id, term_type, title, description, value, clause_id,
          clause_version, legal_reference, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        ctx.companyId, ctx.tenantId, targetContractId, String(t.term_type ?? 'CUSTOM'),
        String(t.title ?? ''), t.description != null ? String(t.description) : null,
        JSON.stringify(t.value ?? {}),
        t.clause_id != null ? Number(t.clause_id) : null,
        t.clause_version != null ? Number(t.clause_version) : null,
        t.legal_reference != null ? String(t.legal_reference) : null,
        Number(t.sort_order ?? 0),
      ]
    );
  }
}

/** Apply an approved variation: freeze the old contract and create the derived VARIATION contract. */
export async function applyVariation(client: pg.PoolClient, ctx: Ctx, variationId: number) {
  const vRes = await client.query(
    `SELECT * FROM contract_variations WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [variationId, ctx.tenantId, ctx.companyId]
  );
  if (vRes.rows.length === 0) throw notFound('Variation not found');
  const variation = vRes.rows[0] as Row;
  if (['APPLIED', 'REJECTED', 'ARCHIVED'].includes(String(variation.status))) {
    throw badRequest(`Variation is ${String(variation.status)} and cannot be applied`);
  }
  const oldRow = await loadContractRow(client, ctx, Number(variation.contract_id), ['EXECUTED', 'ACTIVE']);
  const oldId = Number(oldRow.id);
  const newValues = (variation.new_values ?? {}) as Record<string, unknown>;
  const effectiveDate = toISODate(variation.effective_date) ?? toISODate(oldRow.start_date) ?? todayIso();
  const endDate =
    newValues.endDate != null
      ? toISODate(newValues.endDate)
      : oldRow.end_date
        ? toISODate(oldRow.end_date)
        : null;

  const newContractId = await insertDerivedContract(client, ctx, oldRow, 'VARIATION', {
    startDate: effectiveDate,
    endDate,
    changeReason: variation.reason ? String(variation.reason) : String(variation.variation_type),
    newValues,
  });
  await copyContractChildren(client, ctx, oldId, newContractId, newValues);

  await client.query(
    `UPDATE employment_contracts SET status = 'VARIED', updated_by = $1, updated_at = now() WHERE id = $2`,
    [ctx.userId ?? null, oldId]
  );
  await client.query(
    `UPDATE contract_variations SET status = 'APPLIED', new_contract_id = $1, approved_by = $2, approved_at = now() WHERE id = $3`,
    [newContractId, ctx.userId ?? null, variationId]
  );

  const documentNo = await nextDoc(client, ctx, 'VAR');
  await client.query(
    `INSERT INTO contract_documents
       (company_id, tenant_id, contract_id, document_type, document_no, file_name, mime_type, doc_hash, status)
     VALUES ($1,$2,$3,'VARIATION',$4,$5,'application/pdf',$6,'EXECUTED')`,
    [
      ctx.companyId, ctx.tenantId, newContractId, documentNo, `${documentNo}.pdf`,
      sha256(JSON.stringify({ variationId, oldContractNo: String(oldRow.contract_no ?? ''), newValues })),
    ]
  );
  await logAudit(client, ctx, {
    action: 'contract.variation.apply',
    resource: 'contract_variations',
    recordId: variationId,
    recordCode: String(variation.variation_no ?? ''),
    newValues: { status: 'APPLIED', oldContractId: oldId, newContractId, documentNo },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.contract_variation_applied',
    entityType: 'hr.contracts',
    entityId: oldId,
    entityCode: String(oldRow.contract_no ?? ''),
    payload: { variationId, oldContractId: oldId, newContractId, documentNo },
  });
  return { variationId, oldContractId: oldId, newContractId, status: 'APPLIED' };
}

export interface CreateRenewalInput {
  newStartDate?: string;
  newEndDate?: string;
  reason?: string;
  renewalEligibility?: boolean;
}

/** Record an intended renewal against an executed/active contract (DRAFT). */
export async function createRenewal(
  client: pg.PoolClient,
  ctx: Ctx,
  contractId: number,
  input: CreateRenewalInput
) {
  const newStartDate = String(input.newStartDate ?? '').slice(0, 10);
  if (!newStartDate) throw badRequest('newStartDate is required for a renewal');
  const row = await loadContractRow(client, ctx, contractId, ['EXECUTED', 'ACTIVE']);
  if (String(row.renewal_eligibility) === 'false' && input.renewalEligibility !== true) {
    throw badRequest('This contract is not marked as renewable; set renewalEligibility to renew it');
  }
  const renewalNo = await nextDoc(client, ctx, 'RNW');
  const ins = await client.query(
    `INSERT INTO contract_renewals
       (company_id, tenant_id, contract_id, renewal_no, new_start_date, new_end_date, reason,
        renewal_eligibility, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9)
     RETURNING *`,
    [
      ctx.companyId, ctx.tenantId, contractId, renewalNo, newStartDate,
      input.newEndDate ? String(input.newEndDate).slice(0, 10) : null,
      input.reason ? String(input.reason) : null,
      input.renewalEligibility ?? true,
      ctx.userId ?? null,
    ]
  );
  const renewal = toCamelRow(ins.rows[0]);
  await logAudit(client, ctx, {
    action: 'contract.renewal.create',
    resource: 'contract_renewals',
    recordId: Number(renewal.id),
    recordCode: renewalNo,
    newValues: { contractId, newStartDate, status: 'DRAFT' },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.contract_renewal_created',
    entityType: 'hr.contracts',
    entityId: contractId,
    entityCode: String(row.contract_no ?? ''),
    payload: { renewalId: renewal.id, renewalNo, status: 'DRAFT' },
  });
  return renewal;
}

/** Apply an approved renewal: freeze the old contract and create the derived RENEWAL contract. */
export async function applyRenewal(client: pg.PoolClient, ctx: Ctx, renewalId: number) {
  const rRes = await client.query(
    `SELECT * FROM contract_renewals WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [renewalId, ctx.tenantId, ctx.companyId]
  );
  if (rRes.rows.length === 0) throw notFound('Renewal not found');
  const renewal = rRes.rows[0] as Row;
  if (['APPLIED', 'REJECTED', 'ARCHIVED'].includes(String(renewal.status))) {
    throw badRequest(`Renewal is ${String(renewal.status)} and cannot be applied`);
  }
  const oldRow = await loadContractRow(client, ctx, Number(renewal.contract_id), ['EXECUTED', 'ACTIVE']);
  const oldId = Number(oldRow.id);
  const newContractId = await insertDerivedContract(client, ctx, oldRow, 'RENEWAL', {
    startDate: toISODate(renewal.new_start_date) ?? todayIso(),
    endDate: toISODate(renewal.new_end_date),
    changeReason: renewal.reason ? String(renewal.reason) : 'Contract renewal',
    newValues: {},
  });
  await copyContractChildren(client, ctx, oldId, newContractId, {});

  await client.query(
    `UPDATE employment_contracts SET status = 'RENEWED', updated_by = $1, updated_at = now() WHERE id = $2`,
    [ctx.userId ?? null, oldId]
  );
  await client.query(
    `UPDATE contract_renewals SET status = 'APPLIED', new_contract_id = $1, approved_by = $2, approved_at = now() WHERE id = $3`,
    [newContractId, ctx.userId ?? null, renewalId]
  );

  const documentNo = await nextDoc(client, ctx, 'RNW');
  await client.query(
    `INSERT INTO contract_documents
       (company_id, tenant_id, contract_id, document_type, document_no, file_name, mime_type, doc_hash, status)
     VALUES ($1,$2,$3,'RENEWAL',$4,$5,'application/pdf',$6,'EXECUTED')`,
    [
      ctx.companyId, ctx.tenantId, newContractId, documentNo, `${documentNo}.pdf`,
      sha256(JSON.stringify({ renewalId, oldContractNo: String(oldRow.contract_no ?? ''), newStartDate: renewal.new_start_date })),
    ]
  );
  await logAudit(client, ctx, {
    action: 'contract.renewal.apply',
    resource: 'contract_renewals',
    recordId: renewalId,
    recordCode: String(renewal.renewal_no ?? ''),
    newValues: { status: 'APPLIED', oldContractId: oldId, newContractId, documentNo },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.contract_renewal_applied',
    entityType: 'hr.contracts',
    entityId: oldId,
    entityCode: String(oldRow.contract_no ?? ''),
    payload: { renewalId, oldContractId: oldId, newContractId, documentNo },
  });
  return { renewalId, oldContractId: oldId, newContractId, status: 'APPLIED' };
}

export interface CreateCertificateInput {
  employeeId: number;
  contractId?: number;
  periodStart?: string;
  periodEnd?: string;
  natureOfBusiness?: string;
  position?: string;
  wagesAtTermination?: number;
  reasonForTermination?: string;
}

/** Create a statutory certificate of service (DRAFT). Issued only after employment ends. */
export async function createCertificateOfService(
  client: pg.PoolClient,
  ctx: Ctx,
  input: CreateCertificateInput
) {
  const employeeId = Number(input.employeeId);
  if (!employeeId) throw badRequest('employeeId is required');
  const empRes = await client.query(
    `SELECT * FROM employees WHERE id = $1 AND tenant_id = $2`,
    [employeeId, ctx.tenantId]
  );
  if (empRes.rows.length === 0) throw notFound('Employee not found');
  const employee = empRes.rows[0] as Row;

  let contractRow: Row | null = null;
  if (input.contractId != null) {
    const loadedContract = await loadContractRow(client, ctx, Number(input.contractId));
    if (Number(loadedContract.employee_id) !== employeeId) {
      throw badRequest('Contract does not belong to the employee');
    }
    contractRow = loadedContract;
  }
  const employeeTerminated = String(employee.status ?? '') === 'TERMINATED';
  const contractEnded = contractRow ? ['TERMINATED', 'EXPIRED'].includes(String(contractRow.status)) : false;
  if (!employeeTerminated && !contractEnded) {
    throw badRequest(
      'A certificate of service may only be issued after the employment has ended (terminated employee or terminated/expired contract).'
    );
  }

  const periodStart = input.periodStart
    ? String(input.periodStart).slice(0, 10)
    : toISODate(contractRow?.start_date) ?? toISODate(employee.hire_date) ?? todayIso();
  const periodEnd = input.periodEnd
    ? String(input.periodEnd).slice(0, 10)
    : toISODate(contractRow?.end_date) ?? todayIso();
  const numRes = await client.query(
    `SELECT next_contract_no($1, $2, 'CERTIFICATE', CURRENT_DATE) AS code`,
    [ctx.tenantId, ctx.companyId]
  );
  const certNo = String(numRes.rows[0].code);
  const ins = await client.query(
    `INSERT INTO certificate_of_service
       (company_id, tenant_id, cert_no, employee_id, contract_id, period_start, period_end,
        nature_of_business, position, wages_at_termination, reason_for_termination, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'DRAFT',$12)
     RETURNING *`,
    [
      ctx.companyId, ctx.tenantId, certNo, employeeId,
      contractRow ? Number(contractRow.id) : null,
      periodStart, periodEnd,
      input.natureOfBusiness ? String(input.natureOfBusiness) : null,
      input.position ? String(input.position) : String(contractRow?.job_title ?? employee.position ?? ''),
      input.wagesAtTermination != null
        ? Number(input.wagesAtTermination)
        : contractRow
          ? Number(contractRow.gross_salary ?? contractRow.salary ?? 0)
          : 0,
      input.reasonForTermination ? String(input.reasonForTermination) : null,
      ctx.userId ?? null,
    ]
  );
  const cert = toCamelRow(ins.rows[0]);
  await logAudit(client, ctx, {
    action: 'contract.certificate.create',
    resource: 'certificate_of_service',
    recordId: Number(cert.id),
    recordCode: certNo,
    newValues: { employeeId, status: 'DRAFT' },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.certificate_created',
    entityType: 'hr.contracts',
    entityId: Number(cert.id),
    entityCode: certNo,
    payload: { employeeId, status: 'DRAFT' },
  });
  return cert;
}

/** Issue a certificate of service: freezes the document hash and registers the executed copy. */
export async function issueCertificate(client: pg.PoolClient, ctx: Ctx, certId: number) {
  const res = await client.query(
    `SELECT * FROM certificate_of_service WHERE id = $1 AND tenant_id = $2 AND company_id = $3`,
    [certId, ctx.tenantId, ctx.companyId]
  );
  if (res.rows.length === 0) throw notFound('Certificate not found');
  const cert = res.rows[0] as Row;
  if (String(cert.status) === 'ISSUED') throw conflict('Certificate has already been issued');
  if (String(cert.status) !== 'DRAFT') {
    throw badRequest(`Certificate is ${String(cert.status)} and cannot be issued`);
  }
  const docHash = sha256(
    JSON.stringify({
      certNo: cert.cert_no, employeeId: cert.employee_id,
      periodStart: cert.period_start, periodEnd: cert.period_end,
      position: cert.position, wages: cert.wages_at_termination,
    })
  );
  await client.query(
    `UPDATE certificate_of_service SET status = 'ISSUED', issued_by = $1, issued_at = now(), doc_hash = $2 WHERE id = $3`,
    [ctx.userId ?? null, docHash, certId]
  );
  await client.query(
    `INSERT INTO contract_documents
       (company_id, tenant_id, contract_id, document_type, document_no, file_name, mime_type, doc_hash, status)
     VALUES ($1,$2,$3,'CERTIFICATE_OF_SERVICE',$4,$5,'application/pdf',$6,'EXECUTED')`,
    [
      ctx.companyId, ctx.tenantId,
      cert.contract_id != null ? Number(cert.contract_id) : null,
      String(cert.cert_no), `${String(cert.cert_no)}.pdf`, docHash,
    ]
  );
  await logAudit(client, ctx, {
    action: 'contract.certificate.issue',
    resource: 'certificate_of_service',
    recordId: certId,
    recordCode: String(cert.cert_no ?? ''),
    newValues: { status: 'ISSUED', docHash },
  });
  await emitEvent(client, ctx, {
    eventType: 'hr.certificate_issued',
    entityType: 'hr.contracts',
    entityId: certId,
    entityCode: String(cert.cert_no ?? ''),
    payload: { status: 'ISSUED', docHash },
  });
  const after = await client.query(`SELECT * FROM certificate_of_service WHERE id = $1`, [certId]);
  return toCamelRow(after.rows[0]);
}

/** Contracts expiring within N days (end_date within the window). */
export async function expiringContracts(client: pg.PoolClient, ctx: Ctx, days = 30) {
  const n = Math.min(365, Math.max(1, Number(days) || 30));
  return listContracts(client, ctx, { expiringWithinDays: n, pageSize: 100 });
}

/** Contracts whose probation period ends within N days. */
export async function probationEnding(client: pg.PoolClient, ctx: Ctx, days = 30) {
  const n = Math.min(365, Math.max(1, Number(days) || 30));
  return listContracts(client, ctx, { probationEndingWithinDays: n, pageSize: 100 });
}

/** Contracts missing mandatory written particulars (Employment Act s.59). */
export async function missingParticulars(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT ec.id, ec.contract_no, ec.contract_type, ec.status, ec.start_date, ec.job_title, ec.location,
            ec.gross_salary, ec.salary_frequency, ec.working_hours_per_week, ec.annual_leave_days,
            ec.notice_period_days, ec.employer_rep_name, ec.probation_end_date,
            e.employee_no, e.first_name, e.last_name
     FROM employment_contracts ec
     JOIN employees e ON e.id = ec.employee_id
     WHERE ec.tenant_id = $1 AND ec.company_id = $2 AND ec.deleted_at IS NULL
       AND ec.status IN ('DRAFT','VALIDATING','SUBMITTED','HR_REVIEW','MANAGER_REVIEW','FINANCE_REVIEW',
         'LEGAL_REVIEW','APPROVED')
       AND (ec.start_date IS NULL OR ec.job_title IS NULL OR ec.location IS NULL OR ec.gross_salary IS NULL
            OR ec.salary_frequency IS NULL OR ec.working_hours_per_week IS NULL OR ec.annual_leave_days IS NULL
            OR ec.notice_period_days IS NULL OR ec.employer_rep_name IS NULL)
     ORDER BY ec.id DESC`,
    [ctx.tenantId, ctx.companyId]
  );
  const fieldLabels: Array<[string, string]> = [
    ['start_date', 'start date'],
    ['job_title', 'job title'],
    ['location', 'workplace'],
    ['gross_salary', 'gross salary'],
    ['salary_frequency', 'payment interval'],
    ['working_hours_per_week', 'working hours'],
    ['annual_leave_days', 'annual leave'],
    ['notice_period_days', 'notice period'],
    ['employer_rep_name', 'employer representative'],
  ];
  return res.rows.map((r) => {
    const missing = fieldLabels.filter(([col]) => r[col] == null).map(([, label]) => label);
    return { ...toCamelRow(r), missing };
  });
}

export interface ContractAlert {
  kind: 'approval' | 'signature' | 'expiry' | 'probation' | 'missing';
  count: number;
  title: string;
  body: string;
}

export interface ContractDashboardResult {
  kpis: Record<string, number>;
  charts: {
    byType: Array<{ label: string; value: number }>;
    byStatus: Array<{ label: string; value: number }>;
    byDepartment: Array<{ label: string; value: number }>;
    byBranch: Array<{ label: string; value: number }>;
    expiryTrend: Array<{ label: string; value: number }>;
    probationStatus: Array<{ label: string; value: number }>;
  };
  alerts: ContractAlert[];
}

/** HR Contract Dashboard: KPIs, charts and actionable alerts. */
export async function contractDashboard(client: pg.PoolClient, ctx: Ctx): Promise<ContractDashboardResult> {
  const scope = 'ec.tenant_id = $1 AND ec.company_id = $2 AND ec.deleted_at IS NULL';
  const [kpiRes, typeRes, statusRes, deptRes, branchRes, trendRes, probRes, variationRes, renewalRes] =
    await Promise.all([
      client.query(
        `SELECT
           count(*) FILTER (WHERE ec.status IN ('EXECUTED','ACTIVE')) AS active,
           count(*) FILTER (WHERE ec.status IN ('SENT_FOR_SIGNATURE','PARTIALLY_SIGNED')) AS pending_signature,
           count(*) FILTER (WHERE ec.status IN ('SUBMITTED','HR_REVIEW','MANAGER_REVIEW','FINANCE_REVIEW','LEGAL_REVIEW')) AS awaiting_approval,
           count(*) FILTER (WHERE ec.end_date IS NOT NULL
             AND ec.end_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + 30)) AS expiring_30,
           count(*) FILTER (WHERE ec.probation_end_date IS NOT NULL
             AND ec.probation_end_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + 30)) AS probation_ending_30,
           count(*) FILTER (WHERE ec.start_date IS NULL OR ec.job_title IS NULL OR ec.location IS NULL
             OR ec.gross_salary IS NULL OR ec.salary_frequency IS NULL OR ec.working_hours_per_week IS NULL
             OR ec.annual_leave_days IS NULL OR ec.notice_period_days IS NULL OR ec.employer_rep_name IS NULL)
             AS missing_particulars
         FROM employment_contracts ec WHERE ${scope}`,
        [ctx.tenantId, ctx.companyId]
      ),
      client.query(
        `SELECT contract_type AS label, count(*)::int AS value
         FROM employment_contracts ec WHERE ${scope}
         GROUP BY contract_type ORDER BY value DESC, label`,
        [ctx.tenantId, ctx.companyId]
      ),
      client.query(
        `SELECT status AS label, count(*)::int AS value
         FROM employment_contracts ec WHERE ${scope}
         GROUP BY status ORDER BY value DESC, label`,
        [ctx.tenantId, ctx.companyId]
      ),
      client.query(
        `SELECT COALESCE(d.name, 'Unassigned') AS label, count(*)::int AS value
         FROM employment_contracts ec
         LEFT JOIN departments d ON d.id = ec.department_id
         WHERE ${scope} GROUP BY 1 ORDER BY value DESC, label`,
        [ctx.tenantId, ctx.companyId]
      ),
      client.query(
        `SELECT COALESCE(b.name, 'Unassigned') AS label, count(*)::int AS value
         FROM employment_contracts ec
         LEFT JOIN branches b ON b.id = ec.branch_id
         WHERE ${scope} GROUP BY 1 ORDER BY value DESC, label`,
        [ctx.tenantId, ctx.companyId]
      ),
      client.query(
        `SELECT to_char(end_date, 'YYYY-MM') AS label, count(*)::int AS value
         FROM employment_contracts ec
         WHERE ${scope} AND end_date IS NOT NULL
           AND end_date >= CURRENT_DATE AND end_date < (CURRENT_DATE + INTERVAL '6 months')
         GROUP BY 1 ORDER BY 1`,
        [ctx.tenantId, ctx.companyId]
      ),
      client.query(
        `SELECT pr.status AS label, count(*)::int AS value
         FROM probation_records pr
         JOIN employment_contracts ec ON ec.id = pr.contract_id
         WHERE ${scope} GROUP BY 1 ORDER BY value DESC, label`,
        [ctx.tenantId, ctx.companyId]
      ),
      client.query(
        `SELECT count(*)::int AS value FROM contract_variations
         WHERE tenant_id = $1 AND company_id = $2 AND status = 'APPLIED'
           AND created_at >= now() - INTERVAL '30 days'`,
        [ctx.tenantId, ctx.companyId]
      ),
      client.query(
        `SELECT count(*)::int AS value FROM contract_renewals
         WHERE tenant_id = $1 AND company_id = $2 AND status = 'APPLIED'
           AND created_at >= now() - INTERVAL '30 days'`,
        [ctx.tenantId, ctx.companyId]
      ),
    ]);

  const k = kpiRes.rows[0] as Row;
  const kpis: Record<string, number> = {
    active: Number(k.active ?? 0),
    pendingSignature: Number(k.pending_signature ?? 0),
    awaitingApproval: Number(k.awaiting_approval ?? 0),
    expiring30: Number(k.expiring_30 ?? 0),
    probationEnding30: Number(k.probation_ending_30 ?? 0),
    missingParticulars: Number(k.missing_particulars ?? 0),
    variations30: Number(variationRes.rows[0]?.value ?? 0),
    renewals30: Number(renewalRes.rows[0]?.value ?? 0),
  };

  const alerts: ContractAlert[] = [];
  if (kpis.expiring30 > 0) {
    const n = kpis.expiring30;
    alerts.push({ kind: 'expiry', count: n, title: `${n} contract${n === 1 ? '' : 's'} expire soon`, body: `End dates fall within the next 30 days. Review renewals and notices now.` });
  }
  if (kpis.probationEnding30 > 0) {
    const n = kpis.probationEnding30;
    alerts.push({ kind: 'probation', count: n, title: `${n} probation review${n === 1 ? '' : 's'} due`, body: `Probation ends within 30 days. A decision is required before the period lapses.` });
  }
  if (kpis.pendingSignature > 0) {
    const n = kpis.pendingSignature;
    alerts.push({ kind: 'signature', count: n, title: `${n} employee${n === 1 ? '' : 's'} have not signed`, body: `Contracts are sent but still await a signature. Send a reminder or follow up.` });
  }
  if (kpis.missingParticulars > 0) {
    const n = kpis.missingParticulars;
    alerts.push({ kind: 'missing', count: n, title: `${n} contract${n === 1 ? '' : 's'} missing required particulars`, body: `Written particulars are incomplete and cannot be approved until corrected.` });
  }
  if (kpis.awaitingApproval > 0) {
    const n = kpis.awaitingApproval;
    alerts.push({ kind: 'approval', count: n, title: `${n} contract${n === 1 ? '' : 's'} require approval`, body: `Submitted and waiting in the approval workflow. Review decisions are pending.` });
  }

  return {
    kpis,
    charts: {
      byType: toCamelRows(typeRes.rows) as unknown as Array<{ label: string; value: number }>,
      byStatus: toCamelRows(statusRes.rows) as unknown as Array<{ label: string; value: number }>,
      byDepartment: toCamelRows(deptRes.rows) as unknown as Array<{ label: string; value: number }>,
      byBranch: toCamelRows(branchRes.rows) as unknown as Array<{ label: string; value: number }>,
      expiryTrend: toCamelRows(trendRes.rows) as unknown as Array<{ label: string; value: number }>,
      probationStatus: toCamelRows(probRes.rows) as unknown as Array<{ label: string; value: number }>,
    },
    alerts,
  };
}
