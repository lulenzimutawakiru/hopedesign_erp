import pg from 'pg';
import { Ctx } from '../db.js';

/** Number the trip from the shared document sequence (TRP prefix). */
async function nextTripNo(client: pg.PoolClient, ctx: Ctx): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, 'TRP']);
  return String(res.rows[0].code);
}

/**
 * Keep a logistics Trip in lockstep with a dispatched delivery note.
 *
 * Dispatch already records the vehicle and driver on the delivery note; this
 * turns that into a Trip the logistics module can act on directly, pulling the
 * customer and destination out of the sales order so nothing has to be re-keyed.
 * Idempotent: called again for the same note it updates the existing trip rather
 * than duplicating it.
 */
export async function syncTripForDelivery(
  client: pg.PoolClient,
  ctx: Ctx,
  deliveryNoteId: number
): Promise<{ tripId: number; tripNo: string } | null> {
  const dn = await client.query(
    `SELECT dn.id, dn.vehicle_id, dn.driver_id, dn.dispatch_date,
            so.customer_id,
            COALESCE(NULLIF(c.shipping_address, ''), c.address, c.name) AS destination
       FROM delivery_notes dn
       JOIN sales_orders so ON so.id = dn.order_id
       JOIN customers c ON c.id = so.customer_id
      WHERE dn.id = $1 AND dn.tenant_id = $2`,
    [deliveryNoteId, ctx.tenantId]
  );
  if (dn.rows.length === 0) return null;

  const row = dn.rows[0];
  const customerId = row.customer_id != null ? Number(row.customer_id) : null;
  const destination = row.destination != null ? String(row.destination) : null;
  const startedAt =
    row.dispatch_date != null
      ? new Date(String(row.dispatch_date)).toISOString()
      : new Date().toISOString();

  const existing = await client.query(
    `SELECT id, trip_no FROM trips WHERE delivery_note_id = $1 AND tenant_id = $2 ORDER BY id LIMIT 1`,
    [deliveryNoteId, ctx.tenantId]
  );

  if (existing.rows.length > 0) {
    const tripId = Number(existing.rows[0].id);
    await client.query(
      `UPDATE trips
          SET vehicle_id = $1, driver_id = $2, customer_id = $3, destination = $4,
              started_at = COALESCE(started_at, $5)
        WHERE id = $6`,
      [row.vehicle_id ?? null, row.driver_id ?? null, customerId, destination, startedAt, tripId]
    );
    return { tripId, tripNo: String(existing.rows[0].trip_no) };
  }

  const tripNo = await nextTripNo(client, ctx);
  const ins = await client.query(
    `INSERT INTO trips
       (company_id, tenant_id, trip_no, vehicle_id, driver_id, delivery_note_id,
        customer_id, destination, started_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'IN_TRANSIT')
     RETURNING id`,
    [
      ctx.companyId ?? null,
      ctx.tenantId,
      tripNo,
      row.vehicle_id ?? null,
      row.driver_id ?? null,
      deliveryNoteId,
      customerId,
      destination,
      startedAt,
    ]
  );
  return { tripId: Number(ins.rows[0].id), tripNo };
}

/** Close every open trip linked to a delivery note once the goods are delivered. */
export async function completeTripForDelivery(
  client: pg.PoolClient,
  ctx: Ctx,
  deliveryNoteId: number
): Promise<number> {
  const res = await client.query(
    `UPDATE trips
        SET status = 'COMPLETED', ended_at = now()
      WHERE delivery_note_id = $1 AND tenant_id = $2
        AND status NOT IN ('COMPLETED','CANCELLED')
      RETURNING id`,
    [deliveryNoteId, ctx.tenantId]
  );
  return res.rowCount ?? 0;
}
