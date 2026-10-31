import pg from 'pg';
import { Ctx } from '../db.js';

/** The factory every route starts from. Kept in one place so origin is consistent. */
export const FACTORY_ORIGIN = {
  address: 'Plot 59 Kyambogo Drive, Kyambogo',
  // Kyambogo, Kampala — approximate centroid; refined in the map picker when needed.
  lat: 0.3476,
  lng: 32.6316,
};

const AVG_SPEED_KMH = 40; // mixed city/highway truck speed, used for the ETA estimate

/** Great-circle distance in kilometres (haversine). */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

/** Short origin label for a route name, e.g. "Kyambogo" from the factory address. */
function originName(origin: string): string {
  const parts = origin.split(',').map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || 'Factory';
}

async function nextCode(client: pg.PoolClient, ctx: Ctx, prefix: string): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, prefix]);
  return String(res.rows[0].code);
}

export interface RouteGeo {
  destinationLat?: number | null;
  destinationLng?: number | null;
  origin?: string;
  originLat?: number | null;
  originLng?: number | null;
}

/**
 * Find-or-create the Route that serves a delivery destination.
 *
 * Routes are keyed on (origin, destination) so repeatedly delivering to the same
 * place reuses one route instead of piling up duplicates. When destination
 * coordinates are known the distance and estimated driving time are computed and
 * stored; when they are not (e.g. an address typed into dispatch without a map)
 * the route is still created with origin + destination and the geography can be
 * completed later in the map picker.
 */
export async function ensureRouteForDestination(
  client: pg.PoolClient,
  ctx: Ctx,
  destination: string,
  geo: RouteGeo = {}
): Promise<{ routeId: number; created: boolean }> {
  const dest = destination.trim();
  if (!dest) throw new Error('A destination is required to create a route');

  const origin = (geo.origin ?? FACTORY_ORIGIN.address).trim();
  const destNorm = dest.toLowerCase();
  const originNorm = origin.toLowerCase();

  const existing = await client.query(
    `SELECT id FROM routes
      WHERE company_id = $1
        AND lower(trim(destination)) = $2
        AND lower(trim(COALESCE(origin,''))) = $3
      ORDER BY id LIMIT 1`,
    [ctx.companyId ?? null, destNorm, originNorm]
  );
  if (existing.rows.length > 0) {
    const routeId = Number(existing.rows[0].id);
    // Top up geography if we now know it but the row was created without it.
    const originLat = geo.originLat ?? FACTORY_ORIGIN.lat;
    const originLng = geo.originLng ?? FACTORY_ORIGIN.lng;
    if (geo.destinationLat != null && geo.destinationLng != null) {
      const km = haversineKm(originLat, originLng, geo.destinationLat, geo.destinationLng);
      await client.query(
        `UPDATE routes
            SET origin_lat = COALESCE(origin_lat, $1),
                origin_lng = COALESCE(origin_lng, $2),
                destination_lat = COALESCE(destination_lat, $3),
                destination_lng = COALESCE(destination_lng, $4),
                distance_km = COALESCE(distance_km, $5),
                estimated_hours = COALESCE(estimated_hours, $6)
          WHERE id = $7`,
        [originLat, originLng, geo.destinationLat, geo.destinationLng, km, Math.round((km / AVG_SPEED_KMH) * 10) / 10, routeId]
      );
    }
    return { routeId, created: false };
  }

  const originLat = geo.originLat ?? FACTORY_ORIGIN.lat;
  const originLng = geo.originLng ?? FACTORY_ORIGIN.lng;
  const hasGeo = geo.destinationLat != null && geo.destinationLng != null;
  const km = hasGeo ? haversineKm(originLat, originLng, geo.destinationLat!, geo.destinationLng!) : null;
  const hours = km != null ? Math.round((km / AVG_SPEED_KMH) * 10) / 10 : null;

  const code = await nextCode(client, ctx, 'RT');
  const name = `${originName(origin)} → ${dest}`;
  const ins = await client.query(
    `INSERT INTO routes
       (company_id, tenant_id, code, name, origin, destination,
        origin_lat, origin_lng, destination_lat, destination_lng,
        distance_km, estimated_hours)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      ctx.companyId ?? null,
      ctx.tenantId,
      code,
      name,
      origin,
      dest,
      originLat,
      originLng,
      geo.destinationLat ?? null,
      geo.destinationLng ?? null,
      km,
      hours,
    ]
  );
  return { routeId: Number(ins.rows[0].id), created: true };
}

/**
 * Keep a logistics Trip in lockstep with a dispatched delivery note.
 *
 * Dispatch already records the vehicle and driver on the delivery note; this
 * turns that into a Trip the logistics module can act on directly, pulling the
 * customer and destination out of the sales order so nothing has to be re-keyed.
 * It also makes sure a Route exists for that destination and links the trip to it.
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

  // Feed the route master data too: every delivery destination is a route.
  const { routeId } = destination
    ? await ensureRouteForDestination(client, ctx, destination)
    : { routeId: null };

  const existing = await client.query(
    `SELECT id, trip_no FROM trips WHERE delivery_note_id = $1 AND tenant_id = $2 ORDER BY id LIMIT 1`,
    [deliveryNoteId, ctx.tenantId]
  );

  if (existing.rows.length > 0) {
    const tripId = Number(existing.rows[0].id);
    await client.query(
      `UPDATE trips
          SET vehicle_id = $1, driver_id = $2, customer_id = $3, destination = $4,
              route_id = $5, started_at = COALESCE(started_at, $6)
        WHERE id = $7`,
      [row.vehicle_id ?? null, row.driver_id ?? null, customerId, destination, routeId, startedAt, tripId]
    );
    return { tripId, tripNo: String(existing.rows[0].trip_no) };
  }

  const tripNo = await nextCode(client, ctx, 'TRP');
  const ins = await client.query(
    `INSERT INTO trips
       (company_id, tenant_id, trip_no, vehicle_id, driver_id, delivery_note_id,
        customer_id, destination, route_id, started_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'IN_TRANSIT')
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
      routeId,
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
