/**
 * Shared sanitizers + organizational scope resolution for the Hikvision admin
 * surfaces (devices / events / attendance). Scope enforcement mirrors ABAC:
 * a user bound to a company or branch can never read or write rows outside it,
 * even when an ID is passed directly in the URL or payload (IDOR defence).
 */
import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, forbidden } from '../../utils.js';

export interface OrgScope {
  tenantId: number;
  companyId: number | null;
  branchId: number | null;
  departmentId: number | null;
}

export function cleanInt(v: unknown, max = 2_147_483_647, min = 1): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.trunc(n) : null;
}

export function cleanStr(v: unknown, max = 255): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, max);
}

export function cleanBool(v: unknown): boolean | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || String(v).toLowerCase() === 'true') return true;
  if (v === 0 || v === '0' || String(v).toLowerCase() === 'false') return false;
  return null;
}

export function cleanStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((x) => x.length > 0).slice(0, 50);
  if (typeof v === 'string' && v.trim() !== '') {
    return v.split(',').map((x) => x.trim()).filter((x) => x.length > 0).slice(0, 50);
  }
  return [];
}

export function cleanIso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Validate that a company id exists inside the caller's tenant. */
async function requireCompany(c: pg.PoolClient, tenantId: number, companyId: number): Promise<void> {
  const res = await c.query('SELECT 1 FROM companies WHERE id = $1 AND tenant_id = $2', [companyId, tenantId]);
  if (res.rows.length === 0) throw forbidden('Company is outside your tenant scope');
}

/**
 * Resolve the effective organizational scope for an admin action.
 * Hard bounds come from the authenticated context (ctx.companyId/branchId);
 * request-supplied ids may only narrow within those bounds. Department and
 * branch references are verified against the resolved company first.
 */
export async function resolveOrg(
  c: pg.PoolClient,
  ctx: Ctx,
  requested: { companyId?: unknown; branchId?: unknown; departmentId?: unknown } = {}
): Promise<OrgScope> {
  const tenantId = Number(ctx.tenantId);
  if (!Number.isInteger(tenantId) || tenantId <= 0) throw badRequest('Tenant context is missing');
  const hardCompany = ctx.companyId ? Number(ctx.companyId) : null;
  const hardBranch = ctx.branchId ? Number(ctx.branchId) : null;

  let companyId = requested.companyId !== undefined ? cleanInt(requested.companyId) : null;
  if (hardCompany !== null) {
    if (companyId !== null && companyId !== hardCompany) throw forbidden('Cross-company access denied');
    companyId = hardCompany;
  }

  let branchId = requested.branchId !== undefined ? cleanInt(requested.branchId) : null;
  if (hardBranch !== null) {
    if (branchId !== null && branchId !== hardBranch) throw forbidden('Cross-branch access denied');
    branchId = hardBranch;
  }

  if (branchId !== null) {
    const b = await c.query('SELECT company_id FROM branches WHERE id = $1 AND tenant_id = $2', [branchId, tenantId]);
    if (b.rows.length === 0) throw forbidden('Branch is outside your scope');
    if (companyId === null) companyId = Number(b.rows[0].company_id);
    else if (Number(b.rows[0].company_id) !== companyId) throw forbidden('Branch does not belong to the resolved company');
  }

  if (companyId !== null) await requireCompany(c, tenantId, companyId);

  let departmentId = requested.departmentId !== undefined ? cleanInt(requested.departmentId) : null;
  if (departmentId !== null) {
    const d = await c.query(
      'SELECT company_id, branch_id FROM departments WHERE id = $1 AND tenant_id = $2',
      [departmentId, tenantId]
    );
    if (d.rows.length === 0) throw forbidden('Department is outside your scope');
    if (companyId !== null && Number(d.rows[0].company_id) !== companyId) {
      throw forbidden('Department does not belong to the resolved company');
    }
    if (branchId !== null) {
      const dbranch = d.rows[0].branch_id === null ? null : Number(d.rows[0].branch_id);
      if (dbranch !== null && dbranch !== branchId) throw forbidden('Department does not belong to the resolved branch');
    } else if (d.rows[0].branch_id !== null && companyId === null) {
      companyId = Number(d.rows[0].company_id);
      branchId = Number(d.rows[0].branch_id);
    }
  }

  return { tenantId, companyId, branchId, departmentId };
}

/** WHERE fragment (with params) that confines a query to the resolved scope. */
export function scopeWhere(scope: OrgScope, alias: string): { clause: string; params: unknown[] } {
  const conds: string[] = [`${alias}.tenant_id = $1`];
  const params: unknown[] = [scope.tenantId];
  if (scope.companyId !== null) {
    params.push(scope.companyId);
    conds.push(`${alias}.company_id = $${params.length}`);
  }
  if (scope.branchId !== null && (alias === 'd' || alias === 'e' || alias === 'r')) {
    params.push(scope.branchId);
    conds.push(`${alias}.branch_id = $${params.length}`);
  }
  return { clause: conds.join(' AND '), params };
}