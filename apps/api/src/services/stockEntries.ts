import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, conflict, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { logAudit } from './audit.js';
import { postMove } from './inventory.js';

const ENTRY_TYPES = ['RECEIPT', 'ISSUE', 'TRANSFER'] as const;
type EntryType = (typeof ENTRY_TYPES)[number];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StockEntryLineInput {
  productId?: number; product?: number;
  batchId?: number | null;
  binId?: number | null;
  toBinId?: number | null;
  quantity: number;
  unitId?: number | null;
  unitCost?: number | null;
  expiryDate?: string | null;
  notes?: string | null;
}

export interface StockEntryInput {
  entryType: EntryType;
  warehouseId?: number | null;
  toWarehouseId?: number | null;
  supplierId?: number | null;
  customerId?: number | null;
  workOrderId?: number | null;
  departmentId?: number | null;
  costCentreId?: number | null;
  referenceNo?: string | null;
  notes?: string | null;
  attachmentPath?: string | null;
  clientToken: string;
  /** Timestamp the client last saw this draft. Mismatch on update -> 409. */
  expectedUpdatedAt?: string | null;
  lines: StockEntryLineInput[];
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function validate(input: StockEntryInput): void {
  if (!ENTRY_TYPES.includes(input.entryType)) throw badRequest('entryType must be RECEIPT, ISSUE or TRANSFER');
  if (!input.clientToken || !UUID_RE.test(input.clientToken)) throw badRequest('clientToken must be a UUID');
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw badRequest('At least one line is required');
  if (input.entryType === 'TRANSFER') {
    if (!input.warehouseId || !input.toWarehouseId) throw badRequest('Transfer needs both a source and destination warehouse');
    if (num(input.warehouseId) === num(input.toWarehouseId)) throw badRequest('Source and destination warehouses must differ');
  } else if (!input.warehouseId) {
    throw badRequest('A warehouse is required');
  }
  for (const line of input.lines) {
    const productId = num(line.productId ?? line.product);
    const qty = num(line.quantity);
    if (!productId) throw badRequest('Each line needs a product');
    if (!(qty > 0)) throw badRequest('Each line needs a positive quantity');
  }
}

/** Normalise one line for the DB, or throw if it has no product / positive qty. */
function dbLine(entryId: number, idx: number, line: StockEntryLineInput) {
  return {
    entryId,
    lineNo: idx + 1,
    productId: num(line.productId ?? line.product),
    batchId: line.batchId != null ? num(line.batchId) || null : null,
    binId: line.binId != null ? num(line.binId) || null : null,
    toBinId: line.toBinId != null ? num(line.toBinId) || null : null,
    quantity: num(line.quantity),
    unitId: line.unitId != null ? num(line.unitId) || null : null,
    unitCost: line.unitCost != null ? num(line.unitCost) : 0,
    expiryDate: line.expiryDate && String(line.expiryDate).trim() ? String(line.expiryDate).trim() : null,
    notes: line.notes != null && String(line.notes).trim() ? String(line.notes).trim() : null,
  };
}

function headerColumns(input: StockEntryInput) {
  return {
    entryType: input.entryType,
    warehouseId: input.warehouseId != null ? num(input.warehouseId) || null : null,
    toWarehouseId: input.toWarehouseId != null ? num(input.toWarehouseId) || null : null,
    supplierId: input.supplierId != null ? num(input.supplierId) || null : null,
    customerId: input.customerId != null ? num(input.customerId) || null : null,
    workOrderId: input.workOrderId != null ? num(input.workOrderId) || null : null,
    departmentId: input.departmentId != null ? num(input.departmentId) || null : null,
    costCentreId: input.costCentreId != null ? num(input.costCentreId) || null : null,
    referenceNo: input.referenceNo && String(input.referenceNo).trim() ? String(input.referenceNo).trim() : null,
    notes: input.notes && String(input.notes).trim() ? String(input.notes).trim() : null,
    attachmentPath: input.attachmentPath && String(input.attachmentPath).trim() ? String(input.attachmentPath).trim() : null,
  };
}

/** Load an entry scoped to the current tenant/company, locking it for writes. */
async function lockEntry(client: pg.PoolClient, ctx: Ctx, entryId: number) {
  const res = await client.query(
    `SELECT * FROM stock_entries WHERE id = $1 AND tenant_id = $2 AND company_id = $3 FOR UPDATE`,
    [entryId, ctx.tenantId, ctx.companyId]
  );
  if (res.rows.length === 0) throw notFound('Stock entry not found');
  return res.rows[0];
}

/**
 * Insert or update the draft identified by clientToken, and (when submit is
 * true) post it immediately. Idempotent: a second call with an already-posted
 * token returns the existing entry instead of posting again.
 */
async function upsertAndMaybePost(
  client: pg.PoolClient,
  ctx: Ctx,
  input: StockEntryInput,
  submit: boolean
): Promise<{ entryId: number; entryNo: string; status: string }> {
  validate(input);
  if (!ctx.companyId) throw badRequest('Company context required');
  const companyId = Number(ctx.companyId);

  const existing = await client.query(
    `SELECT id, entry_no, status, updated_at FROM stock_entries WHERE tenant_id = $1 AND client_token = $2 FOR UPDATE`,
    [ctx.tenantId, input.clientToken]
  );

  let entryId: number;
  let entryNo: string;
  let status: string;

  if (existing.rows.length === 0) {
    const noRes = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, 'SE']);
    entryNo = String(noRes.rows[0].code);
    const h = headerColumns(input);
    const ins = await client.query(
      `INSERT INTO stock_entries
         (company_id, tenant_id, branch_id, entry_no, entry_type, status, warehouse_id, to_warehouse_id,
          supplier_id, customer_id, work_order_id, department_id, cost_centre_id,
          reference_no, notes, attachment_path, client_token, created_by)
       VALUES ($1,$2,$3,$4,$5,'DRAFT',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id`,
      [
        companyId, ctx.tenantId, ctx.branchId ?? null, entryNo, h.entryType, h.warehouseId, h.toWarehouseId,
        h.supplierId, h.customerId, h.workOrderId, h.departmentId, h.costCentreId,
        h.referenceNo, h.notes, h.attachmentPath, input.clientToken, ctx.userId ?? null,
      ]
    );
    entryId = Number(ins.rows[0].id);
    status = 'DRAFT';
  } else {
    entryId = Number(existing.rows[0].id);
    entryNo = String(existing.rows[0].entry_no);
    status = String(existing.rows[0].status);
    // A posted entry is final: never overwrite it, never repost it.
    if (status === 'POSTED') return { entryId, entryNo, status };
    if (status === 'CANCELLED') throw badRequest('This entry was cancelled; start a new one');
    // Optimistic-concurrency guard: refuse to overwrite a draft the client has
    // not seen, so two devices editing the same offline draft cannot silently
    // clobber each other.
    if (input.expectedUpdatedAt) {
      const expected = new Date(input.expectedUpdatedAt).getTime();
      const current = new Date(existing.rows[0].updated_at).getTime();
      if (Number.isFinite(expected) && Math.abs(current - expected) > 1000) {
        throw conflict('This draft was changed elsewhere. Reload before saving.');
      }
    }
    const h = headerColumns(input);
    await client.query(
      `UPDATE stock_entries SET
         entry_type = $2, warehouse_id = $3, to_warehouse_id = $4, supplier_id = $5, customer_id = $6,
         work_order_id = $7, department_id = $8, cost_centre_id = $9, reference_no = $10,
         notes = $11, attachment_path = $12, updated_at = now()
       WHERE id = $1`,
      [
        entryId, h.entryType, h.warehouseId, h.toWarehouseId, h.supplierId, h.customerId,
        h.workOrderId, h.departmentId, h.costCentreId, h.referenceNo, h.notes, h.attachmentPath,
      ]
    );
    await client.query(`DELETE FROM stock_entry_lines WHERE entry_id = $1`, [entryId]);
  }

  for (let i = 0; i < input.lines.length; i++) {
    const l = dbLine(entryId, i, input.lines[i]);
    await client.query(
      `INSERT INTO stock_entry_lines
         (entry_id, line_no, product_id, batch_id, bin_id, to_bin_id, quantity, unit_id, unit_cost, expiry_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [l.entryId, l.lineNo, l.productId, l.batchId, l.binId, l.toBinId, l.quantity, l.unitId, l.unitCost, l.expiryDate, l.notes]
    );
  }

  await logAudit(client, ctx, {
    action: submit ? 'submit' : 'save_draft',
    resource: 'stock_entries',
    recordId: entryId,
    recordCode: entryNo,
    newValues: { entryType: input.entryType, lines: input.lines.length },
  });

  if (submit) {
    status = await postEntryInternal(client, ctx, entryId);
  }
  return { entryId, entryNo, status };
}

/** Save a draft (or update an existing one) without posting. */
export async function saveEntry(client: pg.PoolClient, ctx: Ctx, input: StockEntryInput) {
  return upsertAndMaybePost(client, ctx, input, false);
}

/** Save and immediately post. Idempotent on clientToken. */
export async function submitEntry(client: pg.PoolClient, ctx: Ctx, input: StockEntryInput) {
  return upsertAndMaybePost(client, ctx, input, true);
}

async function postEntryInternal(client: pg.PoolClient, ctx: Ctx, entryId: number): Promise<string> {
  const entry = await lockEntry(client, ctx, entryId);
  if (entry.status === 'POSTED') return 'POSTED';
  if (entry.status !== 'DRAFT') throw badRequest(`Entry cannot be posted (current: ${entry.status})`);

  const lines = await client.query(
    `SELECT * FROM stock_entry_lines WHERE entry_id = $1 ORDER BY line_no`,
    [entryId]
  );

  // Restricted / security material must move through the dual-control secure
  // printing workflow, never through the generic quick entry.
  const productIds = lines.rows.map((l) => Number(l.product_id));
  const restricted = await client.query(
    `SELECT code FROM products
      WHERE tenant_id = $1 AND id = ANY($2::bigint[])
        AND (type = 'SECURITY_ITEM' OR security_classification IN ('RESTRICTED','CONFIDENTIAL','SECRET'))`,
    [ctx.tenantId, productIds]
  );
  if (restricted.rows.length > 0) {
    throw badRequest(
      `Restricted or security material ${restricted.rows.map((r) => String(r.code)).join(', ')} must move through the secure-materials workflow, not Quick Entry.`
    );
  }

  const isReceipt = String(entry.entry_type) === 'RECEIPT';
  const isIssue = String(entry.entry_type) === 'ISSUE';
  const workOrderId = entry.work_order_id != null ? Number(entry.work_order_id) : null;

  for (const line of lines.rows) {
    const base = {
      product: Number(line.product_id),
      batch: line.batch_id != null ? Number(line.batch_id) : null,
      quantity: Number(line.quantity),
      unitCost: Number(line.unit_cost) || 0,
      refType: 'stock_entries',
      refId: entryId,
      refCode: String(entry.entry_no),
      reason: entry.notes ?? null,
    };
    if (isReceipt) {
      await postMove(client, ctx, {
        ...base,
        movementType: 'RECEIPT',
        warehouse: Number(entry.warehouse_id),
        bin: line.bin_id != null ? Number(line.bin_id) : null,
      });
      // A receipt is the one place a batch's expiry is first known; record it.
      if (base.batch != null && line.expiry_date != null) {
        await client.query(
          `UPDATE product_batches SET expiry_date = $2 WHERE id = $1 AND tenant_id = $3`,
          [base.batch, line.expiry_date, ctx.tenantId]
        );
      }
    } else if (isIssue) {
      await postMove(client, ctx, {
        ...base,
        movementType: workOrderId != null ? 'PRODUCTION_ISSUE' : 'ISSUE',
        warehouse: Number(entry.warehouse_id),
        bin: line.bin_id != null ? Number(line.bin_id) : null,
        workOrder: workOrderId,
      });
    } else {
      await postMove(client, ctx, {
        ...base,
        movementType: 'TRANSFER_OUT',
        fromWarehouse: Number(entry.warehouse_id),
        fromBin: line.bin_id != null ? Number(line.bin_id) : null,
        toWarehouse: Number(entry.to_warehouse_id),
        toBin: line.to_bin_id != null ? Number(line.to_bin_id) : null,
      });
    }
  }

  await client.query(
    `UPDATE stock_entries SET status = 'POSTED', posted_by = $2, posted_at = now(), updated_at = now()
     WHERE id = $1`,
    [entryId, ctx.userId ?? null]
  );
  await logAudit(client, ctx, {
    action: 'post',
    resource: 'stock_entries',
    recordId: entryId,
    recordCode: String(entry.entry_no),
    newValues: { status: 'POSTED', lines: lines.rows.length },
  });
  return 'POSTED';
}

/** Post an existing draft by id. */
export async function postEntry(client: pg.PoolClient, ctx: Ctx, entryId: number) {
  const status = await postEntryInternal(client, ctx, entryId);
  return { entryId, status };
}

export async function cancelEntry(client: pg.PoolClient, ctx: Ctx, entryId: number) {
  const entry = await lockEntry(client, ctx, entryId);
  if (entry.status !== 'DRAFT') throw badRequest(`Only a draft can be cancelled (current: ${entry.status})`);
  await client.query(`UPDATE stock_entries SET status = 'CANCELLED', updated_at = now() WHERE id = $1`, [entryId]);
  await logAudit(client, ctx, {
    action: 'cancel', resource: 'stock_entries', recordId: entryId,
    recordCode: String(entry.entry_no), newValues: { status: 'CANCELLED' },
  });
  return { entryId, status: 'CANCELLED' };
}

export async function getEntry(client: pg.PoolClient, ctx: Ctx, entryId: number) {
  const res = await client.query(
    `SELECT e.*, w.code AS warehouse_code, w.name AS warehouse_name,
            tw.code AS to_warehouse_code, tw.name AS to_warehouse_name
     FROM stock_entries e
     LEFT JOIN warehouses w ON w.id = e.warehouse_id
     LEFT JOIN warehouses tw ON tw.id = e.to_warehouse_id
     WHERE e.id = $1 AND e.tenant_id = $2 AND e.company_id = $3`,
    [entryId, ctx.tenantId, ctx.companyId]
  );
  if (res.rows.length === 0) throw notFound('Stock entry not found');
  const lines = await client.query(
    `SELECT l.*, p.code AS product_code, p.name AS product_name,
            u.code AS unit_code, u.name AS unit_name
     FROM stock_entry_lines l
     JOIN products p ON p.id = l.product_id
     LEFT JOIN units u ON u.id = l.unit_id
     WHERE l.entry_id = $1 ORDER BY l.line_no`,
    [entryId]
  );
  return { entry: toCamelRow(res.rows[0]), lines: toCamelRows(lines.rows) };
}

export async function listEntries(
  client: pg.PoolClient,
  ctx: Ctx,
  filters: { status?: string | null; page?: number; pageSize?: number }
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25));
  const params: unknown[] = [ctx.tenantId, ctx.companyId];
  const where = ['e.tenant_id = $1', 'e.company_id = $2'];
  if (filters.status && filters.status !== 'ALL') {
    params.push(filters.status);
    where.push(`e.status = $${params.length}`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await client.query(
    `SELECT e.id, e.entry_no, e.entry_type, e.status, e.reference_no, e.notes,
            e.created_at, e.posted_at,
            w.code AS warehouse_code, tw.code AS to_warehouse_code,
            count(l.id)::int AS lines
     FROM stock_entries e
     LEFT JOIN warehouses w ON w.id = e.warehouse_id
     LEFT JOIN warehouses tw ON tw.id = e.to_warehouse_id
     LEFT JOIN stock_entry_lines l ON l.entry_id = e.id
     WHERE ${where.join(' AND ')}
     GROUP BY e.id, w.code, tw.code
     ORDER BY e.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const totalRes = await client.query(
    `SELECT count(*)::int AS n FROM stock_entries e WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { rows: toCamelRows(res.rows), total: Number(totalRes.rows[0].n), page, pageSize };
}
