import { Router } from 'express';
import pg from 'pg';
import { query, tx, Ctx } from '../db.js';
import { requirePermission } from '../middleware/authorize.js';
import { asyncHandler, badRequest, notFound, parsePagination, toCamelRows, toCamelRow, camelToSnake } from '../utils.js';
import { logAudit } from '../services/audit.js';
import { startWorkflow, decideTask } from '../services/workflow.js';

export const BASE_EXCLUDED = new Set([
  'id', 'created_at', 'updated_at', 'created_by', 'updated_by',
  'company_id', 'tenant_id', 'branch_id',
]);

/** Lifecycle / posting fields — only workflow and ops services may write these. */
export const PROCESS_EXCLUDED = new Set([
  'status',
  'approved_by', 'approved_at',
  'rejected_by', 'rejected_at',
  'submitted_by', 'submitted_at',
  'cancelled_by', 'cancelled_at',
  'voided_by', 'voided_at',
  'posted_by', 'posted_at',
  'closed_by', 'closed_at',
  'completed_by', 'completed_at',
  'released_by', 'released_at',
  'allocated', 'allocated_qty', 'reserved_qty',
  'dispatched_qty', 'invoiced_qty', 'received_qty', 'delivered_qty',
  'amount_paid', 'gl_posted', 'gl_journal_id',
]);

export interface CrudConfig {
  table: string;
  module: string;
  resource: string;
  label: string;
  entityType?: string;
  idColumn?: string;
  codeColumn?: string;
  codePrefix?: string;
  statusColumn?: string;
  searchable?: string[];
  writable?: string[];
  excluded?: string[];
  listSelect?: string;
  defaultOrder?: string;
  sortable?: string[];
  submit?: (client: pg.PoolClient, ctx: Ctx, id: number) => Promise<Record<string, unknown>>;
  afterCreate?: (client: pg.PoolClient, ctx: Ctx, id: number) => Promise<void>;
  allowDelete?: boolean;
  qrEntityType?: string;
  /** Overrides the resource segment used in permission names (e.g. share `items` perms). */
  permResource?: string;
  /** Row filter applied to every scoped query (list, get, update, transitions, print). */
  filter?: { column: string; values: string[] };
  /** Column values forced on create when the caller omits them. */
  defaults?: Record<string, unknown>;
  transitions?: { cancel?: string; void?: string; archive?: string; restore?: string };
}

export function permName(cfg: CrudConfig, action: string): string {
  return `${cfg.module}.${cfg.permResource ?? cfg.resource}.${action}`;
}

const columnCache = new Map<string, string[]>();

export async function columnsOf(table: string): Promise<string[]> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const res = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table]
  );
  const cols = res.rows.map((r) => String(r.column_name));
  columnCache.set(table, cols);
  return cols;
}

export function writableOf(cfg: CrudConfig, cols: string[]): string[] {
  const excluded = new Set([
    ...BASE_EXCLUDED,
    ...PROCESS_EXCLUDED,
    ...(cfg.statusColumn ? [cfg.statusColumn] : []),
    ...(cfg.excluded ?? []),
  ]);
  if (cfg.writable) return cfg.writable.filter((c) => cols.includes(c) && !excluded.has(c));
  return cols.filter((c) => !excluded.has(c));
}

function idColumn(cfg: CrudConfig): string {
  return cfg.idColumn ?? 'id';
}

async function findPendingTask(ctx: Ctx, entityType: string, entityId: number) {
  if (!ctx.tenantId) return null;
  const res = await query(
    `SELECT t.id, t.status FROM approval_tasks t
     JOIN workflow_instances i ON i.id = t.instance_id
     WHERE i.tenant_id=$1 AND i.entity_type=$2 AND i.entity_id=$3
       AND t.status='PENDING' ORDER BY t.step_seq LIMIT 1`,
    [ctx.tenantId, entityType, entityId], ctx
  );
  return res.rows[0] ? Number(res.rows[0].id) : null;
}

export function crudRouter(cfg: CrudConfig): Router {
  const r = Router();
  const perm = (action: string) => permName(cfg, action);
  const alias = 't';
  const scope = async (req: import('express').Request, tableAlias = alias): Promise<string> => {
    const user = req.auth;
    if (!user) return '1=0';
    const cols = await columnsOf(cfg.table);
    const prefix = tableAlias ? `${tableAlias}.` : '';
    const conds: string[] = [];
    if (user.company_id && cols.includes('company_id')) conds.push(`${prefix}company_id = ${user.company_id}`);
    if (user.branch_id && cols.includes('branch_id')) conds.push(`${prefix}branch_id = ${user.branch_id}`);
    if (cfg.filter?.column && cols.includes(cfg.filter.column) && cfg.filter.values?.length) {
      const quoted = cfg.filter.values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(', ');
      conds.push(`${prefix}${cfg.filter.column} IN (${quoted})`);
    }
    return conds.length ? conds.join(' AND ') : '1=1';
  };
  const idCol = idColumn(cfg);

  // ---------------- list
  r.get(
    '/',
    requirePermission(perm('view')),
    asyncHandler(async (req, res) => {
      const cols = await columnsOf(cfg.table);
      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>);
      const where: string[] = [await scope(req)];
      const params: unknown[] = [];

      for (const [key, raw] of Object.entries(req.query)) {
        const col = camelToSnake(key);
        if (['page', 'pageSize', 'q', 'sort', 'order'].includes(col)) continue;
        if (!cols.includes(col)) continue;
        const val = Array.isArray(raw) ? raw[0] : raw;
        if (val === undefined || val === '') continue;
        params.push(val);
        where.push(`${alias}.${col} = $${params.length}`);
      }

      if (req.query.q && cfg.searchable?.length) {
        const q = String(req.query.q);
        const ors = cfg.searchable.map((c) => `${alias}.${c} ILIKE $${params.length + 1}`);
        params.push(`%${q}%`);
        where.push(`(${ors.join(' OR ')})`);
      }

      let order = cfg.defaultOrder ?? `${alias}.${idCol} DESC`;
      const sort = req.query.sort ? String(req.query.sort) : '';
      if (sort) {
        const dir = req.query.order === 'asc' ? 'ASC' : 'DESC';
        const col = camelToSnake(sort);
        if (cfg.sortable?.includes(col) || cols.includes(col)) {
          order = `${alias}.${col} ${dir}`;
        }
      }

      const select = cfg.listSelect ?? 't.*';
      const sql = `SELECT ${select}, COUNT(*) OVER() AS _total FROM ${cfg.table} t
                   WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      const res2 = await query(sql, [...params, pageSize, offset], req.ctx);
      const total = res2.rows.length ? Number(res2.rows[0]._total) : 0;
      const rows = res2.rows.map((row) => {
        const { _total, ...rest } = row;
        return toCamelRow(rest as Record<string, unknown>);
      });
      res.json({ data: rows, pagination: { page, pageSize, total } });
    })
  );

  // ---------------- get one
  r.get(
    '/:id',
    requirePermission(perm('view')),
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const result = await query(
        `SELECT t.* FROM ${cfg.table} t WHERE t.${idCol}=$1 AND ${await scope(req)}`,
        [id], req.ctx
      );
      if (!result.rows.length) throw notFound(`${cfg.label} not found`);
      res.json({ data: toCamelRow(result.rows[0] as Record<string, unknown>) });
    })
  );

  // ---------------- create
  r.post(
    '/',
    requirePermission(perm('create')),
    asyncHandler(async (req, res) => {
      const cols = await columnsOf(cfg.table);
      const writable = writableOf(cfg, cols);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const merged = { ...(cfg.defaults ?? {}), ...body };
      const entries = Object.entries(merged)
        .map(([k, v]) => [camelToSnake(k), v] as const)
        .filter(([k]) => writable.includes(k) && k !== idCol);
      if (!entries.length) throw badRequest('No writable fields provided');
      const insertCols: string[] = [];
      const params: unknown[] = [];
      const pushCol = (col: string, val: unknown) => {
        if (cols.includes(col)) {
          insertCols.push(col);
          params.push(val);
        }
      };
      pushCol('tenant_id', req.ctx.tenantId ?? null);
      pushCol('company_id', req.ctx.companyId ?? null);
      pushCol('branch_id', req.ctx.branchId ?? null);
      pushCol('created_by', req.ctx.userId ?? null);
      if (cfg.codeColumn && cfg.codePrefix && !entries.some(([k]) => k === cfg.codeColumn)) {
        const codeRes = await query(
          'SELECT next_doc_no($1,$2,8) AS code',
          [req.ctx.tenantId ?? null, cfg.codePrefix], req.ctx
        );
        pushCol(cfg.codeColumn, codeRes.rows[0]?.code ?? null);
      }
      for (const [k, v] of entries) {
        insertCols.push(k);
        params.push(v);
      }
      const placeholders = insertCols.map((_, i) => `$${i + 1}`);
      const ins = await query(
        `INSERT INTO ${cfg.table} (${insertCols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
        params, req.ctx
      );
      const row = ins.rows[0] as Record<string, unknown>;
      const id = Number(row[idCol]);
      await tx(async (client) => {
        await logAudit(client, req.ctx, {
          action: 'create', resource: cfg.table, recordId: id,
          recordCode: cfg.codeColumn ? String(row[cfg.codeColumn] ?? '') : null,
          newValues: body,
        });
      }, req.ctx);
      if (cfg.afterCreate) {
        await tx(async (client) => cfg.afterCreate!(client, req.ctx, id), req.ctx);
      }
      res.status(201).json({ data: toCamelRow(row) });
    })
  );

  // ---------------- update
  r.patch(
    '/:id',
    requirePermission(perm('update')),
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const cols = await columnsOf(cfg.table);
      const writable = writableOf(cfg, cols);
      const before = await query(
        `SELECT t.* FROM ${cfg.table} t WHERE t.${idCol}=$1 AND ${await scope(req)}`,
        [id], req.ctx
      );
      if (!before.rows.length) throw notFound(`${cfg.label} not found`);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const entries = Object.entries(body)
        .map(([k, v]) => [camelToSnake(k), v] as const)
        .filter(([k]) => writable.includes(k) && k !== idCol);
      if (!entries.length) throw badRequest('No writable fields provided');
      const sets = entries.map(([k], i) => `${k} = $${i + 1}`);
      const params: unknown[] = [...entries.map(([, v]) => v), id];
      await query(
        `UPDATE ${cfg.table} SET ${sets.join(', ')} WHERE ${idCol}=$${params.length} AND ${await scope(req, '')}`,
        params, req.ctx
      );
      await tx(async (client) => {
        await logAudit(client, req.ctx, {
          action: 'update', resource: cfg.table, recordId: id,
          recordCode: cfg.codeColumn ? String(before.rows[0][cfg.codeColumn] ?? '') : null,
          oldValues: Object.fromEntries(entries),
          newValues: body,
        });
      }, req.ctx);
      const after = await query(`SELECT t.* FROM ${cfg.table} t WHERE t.${idCol}=$1`, [id], req.ctx);
      res.json({ data: toCamelRow(after.rows[0] as Record<string, unknown>) });
    })
  );

  // ---------------- submit (workflow)
  r.post(
    '/:id/submit',
    requirePermission(perm('submit')),
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const out = await tx(async (client) => {
        if (cfg.submit) return cfg.submit(client, req.ctx, id);
        const before = await client.query(`SELECT t.* FROM ${cfg.table} t WHERE t.${idCol}=$1 AND ${await scope(req)}`, [id]);
        if (!before.rows.length) throw notFound(`${cfg.label} not found`);
        await client.query(
          `UPDATE ${cfg.table} SET status='SUBMITTED' WHERE ${idCol}=$1`,
          [id]
        );
        await logAudit(client, req.ctx, {
          action: 'submit', resource: cfg.table, recordId: id,
          recordCode: cfg.codeColumn ? String(before.rows[0][cfg.codeColumn] ?? '') : null,
          newValues: { status: 'SUBMITTED' },
        });
        if (cfg.entityType) {
          await startWorkflow(client, req.ctx, {
            entityType: cfg.entityType,
            entityId: id,
            entityCode: cfg.codeColumn ? String(before.rows[0][cfg.codeColumn] ?? '') : null,
            amount: before.rows[0].total != null ? Number(before.rows[0].total) : undefined,
          });
        }
        return { id };
      }, req.ctx);
      res.json({ data: out });
    })
  );

  // ---------------- approve / reject
  const decide = (decision: 'APPROVED' | 'REJECTED') => asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!cfg.entityType) throw badRequest('This entity does not support approval via record endpoint');
    const taskId = await findPendingTask(req.ctx, cfg.entityType, id);
    if (!taskId) throw badRequest('No pending approval task for this record');
    const out = await tx(async (client) => decideTask(client, req.ctx, taskId, decision, req.body?.comment ? String(req.body.comment) : undefined), req.ctx);
    res.json({ data: out });
  });
  r.post('/:id/approve', requirePermission(perm('approve')), decide('APPROVED'));
  r.post('/:id/reject', requirePermission(perm('reject')), decide('REJECTED'));

  // ---------------- status transitions (enum-safe via explicit mapping)
  const registerTransition = (action: 'cancel' | 'void' | 'archive' | 'restore', toStatus: string | undefined) => {
    if (!toStatus || !cfg.statusColumn) return;
    r.post(
      `/:id/${action}`,
      requirePermission(perm(action)),
      asyncHandler(async (req, res) => {
        const id = Number(req.params.id);
        const before = await query(
          `SELECT t.* FROM ${cfg.table} t WHERE t.${idCol}=$1 AND ${await scope(req)}`,
          [id], req.ctx
        );
        if (!before.rows.length) throw notFound(`${cfg.label} not found`);
        const tcols = await columnsOf(cfg.table);
        const hasUpdatedBy = tcols.includes('updated_by');
        const updSet = hasUpdatedBy ? `, updated_by=$2` : '';
        const updWhere = hasUpdatedBy ? `${idCol}=$3` : `${idCol}=$2`;
        const updParams: unknown[] = hasUpdatedBy
          ? [toStatus, req.ctx.userId ?? null, id]
          : [toStatus, id];
        await query(
          `UPDATE ${cfg.table} SET ${cfg.statusColumn}=$1${updSet} WHERE ${updWhere} AND ${await scope(req, '')}`,
          updParams, req.ctx
        );
        await tx(async (client) => {
          await logAudit(client, req.ctx, {
            action, resource: cfg.table, recordId: id,
            recordCode: cfg.codeColumn ? String(before.rows[0][cfg.codeColumn] ?? '') : null,
            oldValues: { [cfg.statusColumn!]: before.rows[0][cfg.statusColumn!] },
            newValues: { [cfg.statusColumn!]: toStatus },
          });
        }, req.ctx);
        res.json({ data: { id, status: toStatus } });
      })
    );
  };
  registerTransition('cancel', cfg.transitions?.cancel);
  registerTransition('void', cfg.transitions?.void);
  registerTransition('archive', cfg.transitions?.archive);
  registerTransition('restore', cfg.transitions?.restore);
  // ---------------- audit trail
  r.get(
    '/:id/audit',
    requirePermission(perm('view')),
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const out = await query(
        `SELECT * FROM audit_logs WHERE resource=$1 AND record_id=$2 ORDER BY created_at DESC LIMIT 200`,
        [cfg.table, id], req.ctx
      );
      res.json({ data: toCamelRows(out.rows as Record<string, unknown>[]) });
    })
  );

  // ---------------- delete (only when allowed; financial/security records never)
  if (cfg.allowDelete) {
    r.delete(
      '/:id',
      requirePermission(perm('delete')),
      asyncHandler(async (req, res) => {
        const id = Number(req.params.id);
        const before = await query(`SELECT t.* FROM ${cfg.table} t WHERE t.${idCol}=$1 AND ${await scope(req)}`, [id], req.ctx);
        if (!before.rows.length) throw notFound(`${cfg.label} not found`);
        await query(`DELETE FROM ${cfg.table} WHERE ${idCol}=$1`, [id], req.ctx);
        await tx(async (client) => {
          await logAudit(client, req.ctx, { action: 'delete', resource: cfg.table, recordId: id, oldValues: before.rows[0] as Record<string, unknown> });
        }, req.ctx);
        res.json({ data: { id } });
      })
    );
  }

  // ---------------- print
  r.post(
    '/:id/print',
    requirePermission(cfg.qrEntityType ? [perm('print'), perm('view')] : perm('print')),
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const result = await query(`SELECT t.* FROM ${cfg.table} t WHERE t.${idCol}=$1 AND ${await scope(req)}`, [id], req.ctx);
      if (!result.rows.length) throw notFound(`${cfg.label} not found`);
      const qrs = cfg.qrEntityType
        ? (await query(
            `SELECT code, status, entity_type, entity_id FROM qr_codes
             WHERE tenant_id=$1 AND entity_type=$2 AND entity_id=$3 ORDER BY id`,
            [req.ctx.tenantId, cfg.qrEntityType, id], req.ctx
          )).rows
        : [];
      res.json({ data: toCamelRow(result.rows[0] as Record<string, unknown>), qrCodes: qrs });
    })
  );

  return r;
}





