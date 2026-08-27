import { Router } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler, badRequest, notFound, toCamelRow, toCamelRows } from '../../utils.js';
import { logAudit } from '../../services/audit.js';

export const projectsOpsRouter = Router();

const PROJECT_STATUSES = ['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];

type OpFn = (client: pg.PoolClient, ctx: Ctx, body: any, params: Record<string, string>) => Promise<unknown>;
type QueryFn = (client: pg.PoolClient, ctx: Ctx, query: Record<string, unknown>, params: Record<string, string>) => Promise<unknown>;

const run = (permission: string, fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx((client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>), req.ctx);
    res.json({ data: out });
  }),
];

const runGet = (permission: string, fn: QueryFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fn(client, req.ctx, req.query as Record<string, unknown>, req.params as Record<string, string>),
      req.ctx
    );
    res.json({ data: out });
  }),
];

const scopeSql = (tenant: unknown, company: unknown, branch: unknown): [string, unknown[]] => {
  return [
    `tenant_id = $1 AND company_id = $2 AND ($3::bigint IS NULL OR branch_id = $3)`,
    [tenant, company, branch],
  ];
};

async function projectBoard(client: pg.PoolClient, ctx: Ctx) {
  const [scope, scopeParams] = scopeSql(ctx.tenantId, ctx.companyId, ctx.branchId);

  const kpis = await client.query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE status = 'PLANNED')::int AS planned,
       count(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
       count(*) FILTER (WHERE status = 'ON_HOLD')::int AS on_hold,
       count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
       count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
       count(DISTINCT manager_user_id)::int AS managers,
       COALESCE(sum(budget) FILTER (WHERE status IN ('PLANNED','ACTIVE','ON_HOLD')), 0)::numeric AS open_budget,
       COALESCE(sum(budget), 0)::numeric AS total_budget,
       COALESCE(sum(CASE WHEN end_date IS NOT NULL AND end_date < CURRENT_DATE
                         AND status IN ('PLANNED','ACTIVE') THEN 1 ELSE 0 END), 0)::int AS overdue
     FROM projects p WHERE ${scope}`,
    scopeParams
  );

  const active = await client.query(
    `SELECT p.id, p.code, p.name, p.status, p.budget, p.currency, p.start_date, p.end_date,
            p.manager_user_id, p.updated_at,
            COALESCE(u.first_name || ' ' || u.last_name, '') AS manager_name,
            COALESCE(pr.committed, 0)::numeric AS committed
     FROM projects p
     LEFT JOIN users u ON u.id = p.manager_user_id
     LEFT JOIN LATERAL (
       SELECT sum(pr.total_estimated) AS committed
       FROM purchase_requisitions pr
       WHERE pr.project_id = p.id AND pr.status IN ('APPROVED','CONVERTED')
     ) pr ON true
     WHERE p.${scope}
       AND p.status IN ('PLANNED','ACTIVE','ON_HOLD')
     ORDER BY (p.status = 'ACTIVE') DESC, p.updated_at DESC
     LIMIT 60`,
    scopeParams
  );

  const upcoming = await client.query(
    `SELECT p.id, p.code, p.name, p.status, p.end_date
     FROM projects p
     WHERE p.${scope} AND p.status IN ('PLANNED','ACTIVE')
       AND p.end_date IS NOT NULL
     ORDER BY p.end_date ASC
     LIMIT 8`,
    scopeParams
  );

  const recent = await client.query(
    `SELECT p.id, p.code, p.name, p.status, p.budget, p.currency, p.updated_at
     FROM projects p
     WHERE p.${scope}
     ORDER BY p.updated_at DESC
     LIMIT 8`,
    scopeParams
  );

  return {
    kpis: toCamelRow(kpis.rows[0]),
    active: toCamelRows(active.rows),
    upcoming: toCamelRows(upcoming.rows),
    recent: toCamelRows(recent.rows),
  };
}

projectsOpsRouter.get('/board', ...runGet('hr.projects.view', (c, ctx) => projectBoard(c, ctx)));

projectsOpsRouter.post(
  '/:id/status',
  ...run('hr.projects.update', async (c, ctx, b, p) => {
    const id = Number(p.id);
    const status = String(b.status ?? '').toUpperCase();
    if (!PROJECT_STATUSES.includes(status)) {
      throw badRequest(`Invalid project status. Allowed: ${PROJECT_STATUSES.join(', ')}`);
    }
    const [scope, scopeParams] = scopeSql(ctx.tenantId, ctx.companyId, ctx.branchId);
    const before = await c.query(
      `SELECT * FROM projects WHERE id = $4 AND ${scope}`,
      [...scopeParams, id]
    );
    if (!before.rows.length) throw notFound('Project not found');
    const prev = String(before.rows[0].status);
    if (prev === status) return before.rows[0];
    await c.query(`UPDATE projects SET status = $1, updated_at = now() WHERE id = $2`, [status, id]);
    await logAudit(c, ctx, {
      action: 'status_change',
      resource: 'projects',
      recordId: id,
      recordCode: String(before.rows[0].code ?? ''),
      oldValues: { status: prev },
      newValues: { status },
    });
    const after = await c.query(`SELECT * FROM projects WHERE id = $1`, [id]);
    return after.rows[0];
  })
);
