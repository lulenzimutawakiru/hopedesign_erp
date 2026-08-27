import { Router } from 'express';
import { query } from '../db.js';
import { can } from '../middleware/authorize.js';
import { asyncHandler, forbidden, notFound, snakeToCamel } from '../utils.js';
import { ENTITIES } from './registry.js';
import { columnsOf, permName, writableOf } from './crudFactory.js';

export const metaRouter = Router();

const ALL_COLUMN_INFO_SQL = `
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = $1
  ORDER BY ordinal_position
`;

interface ColumnInfo {
  name: string;
  camel: string;
  dataType: string;
  nullable: boolean;
  hasDefault: boolean;
  writable: boolean;
}

/** Full catalogue of CRUD entities plus their view permissions (no row data). */
metaRouter.get(
  '/entities',
  asyncHandler(async (req, res) => {
    const perms = req.auth!.permissions;
    const out = ENTITIES.map((cfg) => ({
      module: cfg.module,
      resource: cfg.resource,
      table: cfg.table,
      label: cfg.label,
      codeColumn: cfg.codeColumn ?? null,
      statusColumn: cfg.statusColumn ?? null,
      searchable: cfg.searchable ?? [],
      hasCreate: can(perms, permName(cfg, 'create')),
      hasView: can(perms, permName(cfg, 'view')),
      hasUpdate: can(perms, permName(cfg, 'update')),
      hasSubmit: can(perms, permName(cfg, 'submit')),
      hasApprove: can(perms, permName(cfg, 'approve')),
      hasDelete: can(perms, permName(cfg, 'delete')),
    }));
    res.json({ data: out });
  })
);

/** Column metadata for one entity, used to auto-generate forms and tables. */
metaRouter.get(
  '/entities/:module/:resource',
  asyncHandler(async (req, res) => {
    const cfg = ENTITIES.find(
      (e) => e.module === req.params.module && e.resource === req.params.resource
    );
    if (!cfg) throw notFound('Entity not found');
    const viewPerm = permName(cfg, 'view');
    if (!can(req.auth!.permissions, viewPerm)) throw forbidden(`Missing permission: ${viewPerm}`);

    const cols = await columnsOf(cfg.table);
    const writable = writableOf(cfg, cols);
    const infoRes = await query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      ALL_COLUMN_INFO_SQL,
      [cfg.table]
    );
    const info = new Map(infoRes.rows.map((r) => [String(r.column_name), r]));
    const columns: ColumnInfo[] = cols.map((name) => {
      const i = info.get(name);
      return {
        name,
        camel: snakeToCamel(name),
        dataType: i?.data_type ?? 'text',
        nullable: i?.is_nullable === 'YES',
        hasDefault: Boolean(i?.column_default),
        writable: writable.includes(name),
      };
    });
    res.json({
      data: {
        table: cfg.table,
        module: cfg.module,
        resource: cfg.resource,
        label: cfg.label,
        entityType: cfg.entityType ?? null,
        codeColumn: cfg.codeColumn ?? null,
        statusColumn: cfg.statusColumn ?? null,
        searchable: cfg.searchable ?? [],
        qrEntityType: cfg.qrEntityType ?? null,
        columns,
        writable,
      },
    });
  })
);
