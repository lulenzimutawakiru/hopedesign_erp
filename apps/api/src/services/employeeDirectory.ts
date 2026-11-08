import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { logAudit } from './audit.js';

/**
 * Odoo "Employees" directory parity.
 *
 * The employee master already carries the HCM structure (department, position,
 * location, division, team…) and payroll profile. This service adds the two
 * things Odoo's hr.employee screen is built around that were still missing:
 *  - a flat/grouped directory (kanban + manager/coach pickers), and
 *  - the private-information collections (dependants, emergency contacts,
 *    skills, qualifications, certifications, work history) that existed in the
 *    schema but had no API or UI.
 */

const DIRECTORY_STATUSES = ['ACTIVE', 'PROBATION', 'ON_LEAVE', 'SUSPENDED'];

const DIRECTORY_SELECT = `
  e.id, e.employee_no, e.employee_number, e.first_name, e.last_name, e.position,
  e.status, e.hire_date, e.email, e.work_email, e.work_phone, e.mobile_phone,
  e.work_permit_no, e.badge_id, e.tags, e.department_id, e.manager_id, e.coach_id,
  e.location_id, e.photo_path,
  d.code AS department_code, d.name AS department_name,
  m.first_name AS manager_first_name, m.last_name AS manager_last_name,
  c.first_name AS coach_first_name, c.last_name AS coach_last_name,
  loc.name AS location_name,
  (e.photo_path IS NOT NULL) AS has_photo`;

function directoryRow() {
  return `SELECT ${DIRECTORY_SELECT}
     FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN employees m ON m.id = e.manager_id
     LEFT JOIN employees c ON c.id = e.coach_id
     LEFT JOIN locations loc ON loc.id = e.location_id`;
}

/** Flat directory of everyone still on the books (for manager/coach pickers). */
export async function employeePicker(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `${directoryRow()}
     WHERE e.company_id = $1 AND e.tenant_id = $2 AND e.status = ANY($3)
     ORDER BY e.last_name, e.first_name`,
    [ctx.companyId, ctx.tenantId, DIRECTORY_STATUSES]
  );
  return toCamelRows(res.rows);
}

/** Kanban directory: everyone grouped by department, plus an ungrouped bucket. */
export async function employeeDirectory(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `${directoryRow()}
     WHERE e.company_id = $1 AND e.tenant_id = $2 AND e.status = ANY($3)
     ORDER BY d.name NULLS LAST, e.last_name, e.first_name`,
    [ctx.companyId, ctx.tenantId, DIRECTORY_STATUSES]
  );
  const departments: Array<{ id: number | null; name: string; employees: Record<string, unknown>[] }> = [];
  const byId = new Map<number, { id: number | null; name: string; employees: Record<string, unknown>[] }>();
  const ungrouped: Record<string, unknown>[] = [];
  for (const r of res.rows) {
    const row = toCamelRow(r);
    if (r.department_id == null) {
      ungrouped.push(row);
      continue;
    }
    const key = Number(r.department_id);
    let bucket = byId.get(key);
    if (!bucket) {
      bucket = { id: key, name: String(r.department_name ?? 'Department'), employees: [] };
      byId.set(key, bucket);
      departments.push(bucket);
    }
    bucket.employees.push(row);
  }
  return { departments, ungrouped };
}

// --- Private information -----------------------------------------------------

export const PRIVATE_KINDS = [
  'dependants',
  'emergencyContacts',
  'skills',
  'qualifications',
  'certifications',
  'workHistory',
] as const;
export type PrivateKind = (typeof PRIVATE_KINDS)[number];

type ColType = 'text' | 'num' | 'int' | 'bool' | 'date';

interface ColDef {
  sql: string;
  type: ColType;
  required?: boolean;
}

const KIND_DEFS: Record<PrivateKind, { table: string; cols: Record<string, ColDef> }> = {
  dependants: {
    table: 'employee_dependants',
    cols: {
      fullName: { sql: 'full_name', type: 'text', required: true },
      relationship: { sql: 'relationship', type: 'text' },
      dob: { sql: 'dob', type: 'date' },
      gender: { sql: 'gender', type: 'text' },
      nationalId: { sql: 'national_id', type: 'text' },
      isBeneficiary: { sql: 'is_beneficiary', type: 'bool' },
    },
  },
  emergencyContacts: {
    table: 'employee_emergency_contacts',
    cols: {
      fullName: { sql: 'full_name', type: 'text', required: true },
      relationship: { sql: 'relationship', type: 'text' },
      phone: { sql: 'phone', type: 'text', required: true },
      email: { sql: 'email', type: 'text' },
      address: { sql: 'address', type: 'text' },
      isPrimary: { sql: 'is_primary', type: 'bool' },
    },
  },
  skills: {
    table: 'employee_skills',
    cols: {
      skillName: { sql: 'skill_name', type: 'text', required: true },
      proficiency: { sql: 'proficiency', type: 'text' },
      yearsExperience: { sql: 'years_experience', type: 'num' },
      lastUsedYear: { sql: 'last_used_year', type: 'int' },
      notes: { sql: 'notes', type: 'text' },
    },
  },
  qualifications: {
    table: 'employee_qualifications',
    cols: {
      qualificationType: { sql: 'qualification_type', type: 'text' },
      institution: { sql: 'institution', type: 'text', required: true },
      qualificationName: { sql: 'qualification_name', type: 'text', required: true },
      fieldOfStudy: { sql: 'field_of_study', type: 'text' },
      grade: { sql: 'grade', type: 'text' },
      startDate: { sql: 'start_date', type: 'date' },
      endDate: { sql: 'end_date', type: 'date' },
      country: { sql: 'country', type: 'text' },
    },
  },
  certifications: {
    table: 'employee_certifications',
    cols: {
      name: { sql: 'name', type: 'text', required: true },
      issuer: { sql: 'issuer', type: 'text' },
      certNo: { sql: 'cert_no', type: 'text' },
      issueDate: { sql: 'issue_date', type: 'date' },
      expiryDate: { sql: 'expiry_date', type: 'date' },
      status: { sql: 'status', type: 'text' },
    },
  },
  workHistory: {
    table: 'employee_work_history',
    cols: {
      employer: { sql: 'employer', type: 'text', required: true },
      jobTitle: { sql: 'job_title', type: 'text' },
      startDate: { sql: 'start_date', type: 'date' },
      endDate: { sql: 'end_date', type: 'date' },
      salary: { sql: 'salary', type: 'num' },
      currency: { sql: 'currency', type: 'text' },
      reasonForLeaving: { sql: 'reason_for_leaving', type: 'text' },
      isCurrent: { sql: 'is_current', type: 'bool' },
    },
  },
};

const coerce = (type: ColType, v: unknown): unknown => {
  if (v === undefined || v === null) return null;
  if (type === 'text') {
    const s = String(v).trim();
    return s === '' ? null : s;
  }
  if (type === 'num') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'int') {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  if (type === 'bool') return v === true || v === 'true' || v === 1 || v === '1';
  if (type === 'date') {
    const s = String(v).trim();
    return s === '' ? null : s.slice(0, 10);
  }
  return v;
};

async function employeeCompany(client: pg.PoolClient, ctx: Ctx, employeeId: number): Promise<number> {
  const res = await client.query(
    `SELECT id, company_id FROM employees WHERE id = $1 AND tenant_id = $2`,
    [employeeId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Employee not found');
  return Number(res.rows[0].company_id);
}

/** Read every private-information collection for one employee. */
export async function getEmployeePrivate(client: pg.PoolClient, ctx: Ctx, employeeId: number) {
  await employeeCompany(client, ctx, employeeId);
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const kind of PRIVATE_KINDS) {
    const def = KIND_DEFS[kind];
    const res = await client.query(
      `SELECT * FROM ${def.table} WHERE employee_id = $1 AND tenant_id = $2 ORDER BY id`,
      [employeeId, ctx.tenantId]
    );
    out[kind] = toCamelRows(res.rows);
  }
  return out;
}

/** Insert or update one private-information record (kind-scoped, whitelisted columns). */
export async function savePrivateItem(
  client: pg.PoolClient,
  ctx: Ctx,
  employeeId: number,
  kind: PrivateKind,
  itemId: number | null,
  input: Record<string, unknown>
) {
  if (!PRIVATE_KINDS.includes(kind)) throw badRequest('Unknown private-information type');
  const companyId = await employeeCompany(client, ctx, employeeId);
  const def = KIND_DEFS[kind];

  const provided: Array<[string, ColDef, unknown]> = [];
  for (const [key, col] of Object.entries(def.cols)) {
    if (!(key in input)) continue;
    provided.push([key, col, coerce(col.type, input[key])]);
  }
  for (const [key, col] of Object.entries(def.cols)) {
    if (!col.required) continue;
    if (itemId == null && !(key in input)) throw badRequest(`${key} is required`);
    if (key in input && coerce(col.type, input[key]) === null) throw badRequest(`${key} is required`);
  }

  if (itemId == null) {
    const cols: string[] = ['company_id', 'tenant_id', 'employee_id'];
    const vals: unknown[] = [companyId, ctx.tenantId, employeeId];
    for (const [, col, value] of provided) {
      if (value === null) continue; // let the column default apply
      cols.push(col.sql);
      vals.push(value);
    }
    const res = await client.query(
      `INSERT INTO ${def.table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      vals
    );
    await logAudit(client, ctx, { action: 'create', resource: def.table, recordId: Number(res.rows[0].id), newValues: toCamelRow(res.rows[0]) });
    return toCamelRow(res.rows[0]);
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [, col, value] of provided) {
    vals.push(value);
    sets.push(`${col.sql} = $${vals.length}`);
  }
  if (sets.length === 0) throw badRequest('No fields to update');
  vals.push(itemId, ctx.tenantId);
  const res = await client.query(
    `UPDATE ${def.table} SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${vals.length - 1} AND tenant_id = $${vals.length} AND employee_id = ${employeeId}
     RETURNING *`,
    vals
  );
  if (res.rowCount === 0) throw notFound('Record not found');
  await logAudit(client, ctx, { action: 'update', resource: def.table, recordId: itemId, newValues: toCamelRow(res.rows[0]) });
  return toCamelRow(res.rows[0]);
}

export async function deletePrivateItem(
  client: pg.PoolClient,
  ctx: Ctx,
  employeeId: number,
  kind: PrivateKind,
  itemId: number
) {
  if (!PRIVATE_KINDS.includes(kind)) throw badRequest('Unknown private-information type');
  await employeeCompany(client, ctx, employeeId);
  const def = KIND_DEFS[kind];
  const res = await client.query(
    `DELETE FROM ${def.table} WHERE id = $1 AND tenant_id = $2 AND employee_id = $3 RETURNING id`,
    [itemId, ctx.tenantId, employeeId]
  );
  if (res.rowCount === 0) throw notFound('Record not found');
  await logAudit(client, ctx, { action: 'delete', resource: def.table, recordId: itemId });
  return { id: itemId, deleted: true };
}
