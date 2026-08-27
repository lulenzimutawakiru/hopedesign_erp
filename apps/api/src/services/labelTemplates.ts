import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, conflict, notFound } from '../utils.js';
import { logAudit } from './audit.js';

/**
 * Label template (label variety) management.
 *
 * A label template describes one physical label variety: kind (REAM /
 * CARTON / ...), code + name, physical size in mm, target printer model
 * and whether it is the tenant's default for its kind. The Niimbot
 * renderer uses these to size ream/carton QR labels.
 */

export const LABEL_TEMPLATE_KINDS = [
  'PRODUCT', 'BATCH', 'REAM', 'CARTON', 'PALLET', 'ASSET',
  'MACHINE', 'BIN', 'DELIVERY', 'WORK_ORDER',
];

export interface LabelTemplateInput {
  code?: string;
  name?: string;
  kind?: string;
  content?: Record<string, unknown>;
  mmWidth?: number | null;
  mmHeight?: number | null;
  printerModel?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
}

function requireKind(kind: string | undefined, required: boolean): string | null {
  const k = kind == null ? '' : String(kind).toUpperCase().trim();
  if (!k) {
    if (required) throw badRequest('kind is required');
    return null;
  }
  if (!LABEL_TEMPLATE_KINDS.includes(k)) {
    throw badRequest(`kind must be one of: ${LABEL_TEMPLATE_KINDS.join(', ')}`);
  }
  return k;
}

function requireCode(code: string | undefined): string {
  const c = String(code ?? '').toUpperCase().trim();
  if (!c) throw badRequest('code is required');
  if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(c)) {
    throw badRequest('code may contain only letters, digits, dot, dash or underscore');
  }
  return c;
}

function toSize(v: unknown, label: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 400) {
    throw badRequest(`${label} must be a positive number (mm)`);
  }
  return Math.round(n * 100) / 100;
}

function toContent(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      throw badRequest('content must be valid JSON');
    }
    throw badRequest('content must be a JSON object');
  }
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  throw badRequest('content must be a JSON object');
}

export async function listLabelTemplates(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { kind?: string; activeOnly?: boolean } = {}
) {
  const tenantId = ctx.tenantId ?? 0;
  const params: unknown[] = [tenantId];
  const where = ['tenant_id = $1'];
  const kind = requireKind(input.kind, false);
  if (kind) {
    params.push(kind);
    where.push(`kind = $${params.length}`);
  }
  if (input.activeOnly) where.push('is_active = true');
  const res = await client.query(
    `SELECT * FROM label_templates WHERE ${where.join(' AND ')}
     ORDER BY kind, is_default DESC, id`,
    params
  );
  return res.rows;
}

export async function getLabelTemplate(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `SELECT * FROM label_templates WHERE id = $1 AND tenant_id = $2`,
    [id, ctx.tenantId ?? 0]
  );
  if (res.rows.length === 0) throw notFound('Label template not found');
  return res.rows[0];
}

async function clearOtherDefaults(client: pg.PoolClient, ctx: Ctx, kind: string, excludeId: number) {
  await client.query(
    `UPDATE label_templates SET is_default = false
     WHERE tenant_id = $1 AND kind = $2 AND is_default = true AND id <> $3`,
    [ctx.tenantId ?? 0, kind, excludeId]
  );
}

export async function createLabelTemplate(
  client: pg.PoolClient,
  ctx: Ctx,
  input: LabelTemplateInput
) {
  const companyId = ctx.companyId ?? null;
  const tenantId = ctx.tenantId ?? null;
  if (!companyId || !tenantId) throw badRequest('Company context required');
  const code = requireCode(input.code);
  const name = String(input.name ?? '').trim();
  if (!name) throw badRequest('name is required');
  const kind = requireKind(input.kind, true) as string;
  const mmWidth = toSize(input.mmWidth, 'mmWidth');
  const mmHeight = toSize(input.mmHeight, 'mmHeight');
  const isDefault = !!input.isDefault;
  const content = toContent(input.content);

  const ins = await client.query(
    `INSERT INTO label_templates
       (company_id, tenant_id, code, name, kind, content, is_active, mm_width, mm_height, printer_model, is_default)
     VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10)
     RETURNING *`,
    [
      companyId, tenantId, code, name, kind, JSON.stringify(content),
      mmWidth, mmHeight, input.printerModel != null ? String(input.printerModel).trim() || null : null,
      isDefault,
    ]
  ).catch((err: Error & { code?: string }) => {
    if (err.code === '23505') throw conflict(`Label template code '${code}' already exists`);
    throw err;
  });
  const row = ins.rows[0];
  if (isDefault) await clearOtherDefaults(client, ctx, kind, Number(row.id));

  await logAudit(client, ctx, {
    action: 'labels.template.create',
    resource: 'label_templates',
    recordId: Number(row.id),
    recordCode: code,
    metadata: { kind, mmWidth, mmHeight, isDefault },
  });
  return row;
}

export async function updateLabelTemplate(
  client: pg.PoolClient,
  ctx: Ctx,
  id: number,
  input: LabelTemplateInput
) {
  const existing = await getLabelTemplate(client, ctx, id);
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };

  let kind = String(existing.kind);
  if (input.kind !== undefined) {
    kind = requireKind(input.kind, true) as string;
    push('kind', kind);
  }
  if (input.code !== undefined) push('code', requireCode(input.code));
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw badRequest('name is required');
    push('name', name);
  }
  if (input.content !== undefined) push('content', JSON.stringify(toContent(input.content)));
  if (input.mmWidth !== undefined) push('mm_width', toSize(input.mmWidth, 'mmWidth'));
  if (input.mmHeight !== undefined) push('mm_height', toSize(input.mmHeight, 'mmHeight'));
  if (input.printerModel !== undefined) {
    push('printer_model', input.printerModel != null ? String(input.printerModel).trim() || null : null);
  }
  if (input.isActive !== undefined) push('is_active', !!input.isActive);
  if (input.isDefault !== undefined) push('is_default', !!input.isDefault);

  if (sets.length > 0) {
    params.push(id, ctx.tenantId ?? 0);
    await client.query(
      `UPDATE label_templates SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
       RETURNING *`,
      params
    ).catch((err: Error & { code?: string }) => {
      if (err.code === '23505') throw conflict('Label template code already exists');
      throw err;
    });
  }
  if (input.isDefault) await clearOtherDefaults(client, ctx, kind, id);

  const row = await getLabelTemplate(client, ctx, id);
  await logAudit(client, ctx, {
    action: 'labels.template.update',
    resource: 'label_templates',
    recordId: Number(row.id),
    recordCode: String(row.code),
    metadata: { fields: sets.map((s) => s.split(' ')[0]) },
  });
  return row;
}

/** Make this template the tenant default for its kind. */
export async function setDefaultLabelTemplate(client: pg.PoolClient, ctx: Ctx, id: number) {
  const existing = await getLabelTemplate(client, ctx, id);
  await client.query(
    `UPDATE label_templates SET is_default = false
     WHERE tenant_id = $1 AND kind = $2 AND is_default = true`,
    [ctx.tenantId ?? 0, existing.kind]
  );
  await client.query(
    `UPDATE label_templates SET is_default = true WHERE id = $1 AND tenant_id = $2`,
    [id, ctx.tenantId ?? 0]
  );
  await logAudit(client, ctx, {
    action: 'labels.template.default',
    resource: 'label_templates',
    recordId: Number(existing.id),
    recordCode: String(existing.code),
    metadata: { kind: existing.kind },
  });
  return getLabelTemplate(client, ctx, id);
}

/** Soft-delete (archive) a template so historical labels keep their reference. */
export async function archiveLabelTemplate(client: pg.PoolClient, ctx: Ctx, id: number) {
  const existing = await getLabelTemplate(client, ctx, id);
  await client.query(
    `UPDATE label_templates SET is_active = false, is_default = false
     WHERE id = $1 AND tenant_id = $2`,
    [id, ctx.tenantId ?? 0]
  );
  await logAudit(client, ctx, {
    action: 'labels.template.archive',
    resource: 'label_templates',
    recordId: Number(existing.id),
    recordCode: String(existing.code),
    metadata: { kind: existing.kind },
  });
  return { id: Number(existing.id), archived: true };
}
