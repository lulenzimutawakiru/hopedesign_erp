import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound } from '../utils.js';
import { logAudit } from './audit.js';
import { startWorkflow } from './workflow.js';

/**
 * Submit a product master record for maker-checker approval. The approval runs
 * on the parallel `approval_status` column so the lifecycle `status`
 * (ACTIVE/INACTIVE/DISCONTINUED) that pickers and catalogue filters depend on
 * is untouched. Backed by entityType 'inventory.items'.
 */
export async function submitProduct(client: pg.PoolClient, ctx: Ctx, productId: number) {
  const res = await client.query(
    `SELECT * FROM products WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [productId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Product not found');
  const p = res.rows[0];
  if (String(p.status) === 'DISCONTINUED') {
    throw badRequest('Discontinued products cannot be submitted for approval');
  }
  if (String(p.approval_status) === 'SUBMITTED') {
    throw badRequest('Product is already awaiting approval');
  }

  await client.query(`UPDATE products SET approval_status = 'SUBMITTED' WHERE id = $1`, [productId]);
  await logAudit(client, ctx, {
    action: 'submit', resource: 'products', recordId: productId,
    recordCode: String(p.code ?? ''), newValues: { approval_status: 'SUBMITTED' },
  });
  await startWorkflow(client, ctx, {
    entityType: 'inventory.items',
    entityId: productId,
    entityCode: String(p.code ?? ''),
  });
  return { id: productId, approvalStatus: 'SUBMITTED' };
}
