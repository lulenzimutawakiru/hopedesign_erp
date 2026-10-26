/**
 * Gates the ISO operating records put in front of existing business actions.
 * The register stays an assessment. These checks are what make a control
 * implemented: the action is refused when the record is missing.
 */
import pg from 'pg';
import { Ctx, query } from '../../db.js';
import { badRequest } from '../../utils.js';

const OUTBOUND = new Set(['DISPTACH', 'DELIVERY']);

export async function assertSupplierApproved(
  client: pg.PoolClient,
  ctx: Ctx,
  supplierId: number,
): Promise<void> {
  const res = await client.query(
    `SELECT code, status, iso_review_status, iso_review_due
       FROM suppliers WHERE id = $1 AND tenant_id = $2`,
    [supplierId, ctx.tenantId],
  );
  if (res.rows.length === 0) throw badRequest('Supplier not found');
  const row = res.rows[0] as {
    code: string;
    status: string;
    iso_review_status: string;
    iso_review_due: string | Date | null;
  };
  const due = row.iso_review_due ? String(row.iso_review_due).slice(0, 10) : null;
  const today = new Date().toISOString().slice(0, 10);
  const buyable = ['ACTIVE', 'APPROVED'].includes(String(row.status))
    && row.iso_review_status === 'APPROVED'
    && (due == null || due >= today);
  if (!buyable) {
    throw badRequest(
      `Supplier ${row.code} has no current quality and security approval. Record the review and the security clause before raising a purchase order.`,
    );
  }
}

export async function assertNoQualityHold(
  client: pg.PoolClient,
  ctx: Ctx,
  productId: number,
  batchId?: number | null,
): Promise<void> {
  const res = await client.query(
    `SELECT hold_no FROM quality_holds
      WHERE tenant_id = $1 AND product_id = $2 AND status = 'HELD'
        AND ($3::bigint IS NULL OR batch_id IS NULL OR batch_id = $3)
     UNION ALL
     SELECT hold_no FROM production_quality_holds
      WHERE tenant_id = $1 AND product_id = $2
        AND status IN ('HELD', 'INVESTIGATING', 'QUARANTINE')
     LIMIT 1`,
    [ctx.tenantId, productId, batchId ?? null],
  );
  if (res.rows.length > 0) {
    throw badRequest(`Quality hold ${res.rows[0].hold_no} blocks dispatch of this product.`);
  }
}

export async function assertOutboundAllowed(
  client: pg.PoolClient,
  ctx: Ctx,
  movementType: string,
  productId: number,
  batchId?: number | null,
): Promise<void> {
  if (!OUTBOUND.has(movementType)) return;
  await assertNoQualityHold(client, ctx, productId, batchId);
  await assertPreservation(client, ctx, productId);
}

async function assertPreservation(client: pg.PoolClient, ctx: Ctx, productId: number): Promise<void> {
  const limit = await client.query(
    `SELECT id, payload FROM iso_entries
      WHERE tenant_id = $1 AND entry_type = 'preservation_limit' AND status = 'CURRENT'
        AND subject_table = 'products' AND subject_id = $2
      ORDER BY id DESC LIMIT 1`,
    [ctx.tenantId, productId],
  );
  if (limit.rows.length === 0) return;
  const payload = (limit.rows[0].payload ?? {}) as { min?: number; max?: number; unit?: string };
  const reading = await client.query(
    `SELECT payload FROM iso_entries
      WHERE tenant_id = $1 AND entry_type = 'preservation_reading' AND status = 'CURRENT'
        AND subject_table = 'products' AND subject_id = $2
      ORDER BY id DESC LIMIT 1`,
    [ctx.tenantId, productId],
  );
  if (reading.rows.length === 0) {
    throw badRequest('A preservation limit is in force and this product has no current reading.');
  }
  const value = Number((reading.rows[0].payload as { value?: number } | null)?.value);
  const min = Number(payload.min);
  const max = Number(payload.max);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw badRequest(`Preservation reading ${value} ${payload.unit ?? ''} is outside ${min} to ${max}.`);
  }
}

export async function assertWorkOrderReady(
  client: pg.PoolClient,
  ctx: Ctx,
  workOrderId: number,
  productId: number,
): Promise<void> {
  const res = await client.query(
    `SELECT entry_type FROM iso_entries
      WHERE tenant_id = $1 AND status = 'CURRENT'
        AND entry_type IN ('quality_plan', 'project_gate', 'measurement_plan')
        AND (
          (subject_table = 'work_orders' AND subject_id = $2)
          OR (subject_table = 'products' AND subject_id = $3)
        )`,
    [ctx.tenantId, workOrderId, productId],
  );
  const have = new Set(res.rows.map((row) => String(row.entry_type)));
  const missing = ['quality_plan', 'project_gate', 'measurement_plan'].filter((kind) => !have.has(kind));
  if (missing.length > 0) {
    throw badRequest(`Work order cannot start until a current ${missing.join(', ')} is recorded.`);
  }
}

export async function assertRequirementReviewed(
  client: pg.PoolClient,
  ctx: Ctx,
  quotationId: number,
): Promise<void> {
  const res = await client.query(
    `SELECT 1 FROM iso_entries
      WHERE tenant_id = $1 AND entry_type = 'requirement_review' AND status = 'CURRENT'
        AND subject_table = 'sales_quotations' AND subject_id = $2
        AND payload->>'accepted' = 'true'
      LIMIT 1`,
    [ctx.tenantId, quotationId],
  );
  if (res.rows.length === 0) {
    throw badRequest('Quotation cannot be converted until its customer requirements have been reviewed.');
  }
}

export async function assertScreeningClear(
  client: pg.PoolClient,
  ctx: Ctx,
  candidateId: number,
): Promise<void> {
  const res = await client.query(
    `SELECT 1 FROM iso_entries
      WHERE tenant_id = $1 AND entry_type = 'screening' AND status = 'CURRENT'
        AND subject_table = 'candidates' AND subject_id = $2
        AND payload->>'outcome' = 'CLEAR'
      LIMIT 1`,
    [ctx.tenantId, candidateId],
  );
  if (res.rows.length === 0) {
    throw badRequest('An offer cannot be sent until screening of this candidate is recorded as clear.');
  }
}

export async function assertErasureProven(
  client: pg.PoolClient,
  ctx: Ctx,
  requestId: number,
): Promise<void> {
  const res = await client.query(
    `SELECT 1 FROM iso_entries
      WHERE tenant_id = $1 AND entry_type = 'deletion_proof' AND status = 'CURRENT'
        AND (payload->>'subjectRequestId')::bigint = $2
        AND payload->>'backupsWiped' = 'true'
        AND payload->>'filesWiped' = 'true'
      LIMIT 1`,
    [ctx.tenantId, requestId],
  );
  if (res.rows.length === 0) {
    throw badRequest('Erasure cannot be completed until backups and stored files are recorded as wiped.');
  }
}

/** Title of an approved policy this user still has to accept, or null. */
export async function pendingAcknowledgement(userId: number, companyId: number, tenantId: number): Promise<string | null> {
  try {
    const res = await query(
      'SELECT iso_pending_acknowledgement($1, $2) AS title',
      [userId, companyId],
      { tenantId, userId },
    );
    const title = res.rows[0]?.title;
    return title ? String(title) : null;
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
    // The gate is absent until migration 0207 has been applied.
    if (code === '42883' || code === '42P01') return null;
    throw err;
  }
}
