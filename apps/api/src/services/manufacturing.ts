import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows, toISODate } from '../utils.js';
import { postMove, reserve, consume } from './inventory.js';
import { emitEvent } from './events.js';
import { logAudit } from './audit.js';

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number => Number(v ?? 0);
const pct = (part: number, whole: number) => (whole > 0 ? round2((part / whole) * 100) : 0);

async function nextDoc(client: pg.PoolClient, ctx: Ctx, prefix: string): Promise<string> {
  const res = await client.query('SELECT next_doc_no($1,$2,8) AS code', [ctx.tenantId, prefix]);
  return String(res.rows[0].code);
}

async function getWorkOrder(client: pg.PoolClient, ctx: Ctx, workOrderId: number) {
  const res = await client.query(
    `SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [workOrderId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Work order not found');
  return res.rows[0];
}

async function getMachine(client: pg.PoolClient, ctx: Ctx, machineId: number) {
  const res = await client.query(
    `SELECT * FROM machines WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [machineId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Machine not found');
  return res.rows[0];
}

/** Persist a manufacturing event to both the system event bus and the immutable MES ledger. */
async function mesEvent(
  client: pg.PoolClient,
  ctx: Ctx,
  e: {
    eventType: string;
    entityType?: string | null;
    entityId?: number | null;
    entityCode?: string | null;
    payload?: Record<string, unknown>;
    severity?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
  }
) {
  await emitEvent(client, ctx, {
    eventType: e.eventType,
    entityType: e.entityType,
    entityId: e.entityId,
    entityCode: e.entityCode,
    payload: e.payload,
    severity: e.severity ?? 'INFO',
  });
  await client.query(
    `INSERT INTO manufacturing_events
       (company_id, tenant_id, branch_id, event_type, entity_type, entity_id, entity_code, payload, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      ctx.companyId ?? null,
      ctx.tenantId ?? null,
      ctx.branchId ?? null,
      e.eventType,
      e.entityType ?? null,
      e.entityId ?? null,
      e.entityCode ?? null,
      JSON.stringify(e.payload ?? {}),
      ctx.userId ?? null,
    ]
  );
}

async function upsertAlert(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    alertType: string;
    severity: 'INFO' | 'WARNING' | 'CRITICAL';
    title: string;
    message?: string | null;
    refType?: string | null;
    refId?: number | null;
  }
) {
  await client.query(
    `INSERT INTO production_alerts
       (company_id, tenant_id, branch_id, alert_type, severity, title, message, ref_type, ref_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'OPEN')`,
    [
      ctx.companyId ?? null,
      ctx.tenantId ?? null,
      ctx.branchId ?? null,
      input.alertType,
      input.severity,
      input.title,
      input.message ?? null,
      input.refType ?? null,
      input.refId ?? null,
    ]
  );
}

// ---------------------------------------------------------------------------
// 1. Manufacturing command center
// ---------------------------------------------------------------------------
export async function mesCommandCenter(client: pg.PoolClient, ctx: Ctx) {
  const prod = await client.query(
    `SELECT COALESCE(SUM(quantity),0)::numeric AS planned,
            COALESCE(SUM(produced_qty),0)::numeric AS produced,
            COALESCE(SUM(scrapped_qty),0)::numeric AS scrapped,
            COALESCE(SUM(waste_qty),0)::numeric AS waste
     FROM work_orders
     WHERE tenant_id = $1
       AND status NOT IN ('DRAFT','CANCELLED','REJECTED','CLOSED')
       AND (start_date IS NULL OR start_date <= CURRENT_DATE)
       AND (due_date IS NULL OR due_date >= CURRENT_DATE)`,
    [ctx.tenantId]
  );
  const planned = num(prod.rows[0].planned);
  const produced = num(prod.rows[0].produced);

  const mach = await client.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE machine_state = 'RUNNING')::int AS running,
            COUNT(*) FILTER (WHERE machine_state IN ('BREAKDOWN','MAINTENANCE','OFFLINE'))::int AS down
     FROM machines WHERE tenant_id = $1`,
    [ctx.tenantId]
  );

  const dt = await client.query(
    `SELECT COALESCE(SUM(duration_min) / 60.0, 0)::numeric AS hours
     FROM downtime_events WHERE tenant_id = $1 AND started_at::date = CURRENT_DATE`,
    [ctx.tenantId]
  );

  const avail = await client.query(
    `WITH req AS (
       SELECT wom.product_id, SUM(wom.required_qty - wom.issued_qty)::numeric AS need
       FROM work_order_materials wom
       JOIN work_orders wo ON wo.id = wom.work_order_id
       WHERE wo.tenant_id = $1
         AND wo.status NOT IN ('CANCELLED','REJECTED','CLOSED','COMPLETED')
       GROUP BY wom.product_id
     ),
     free AS (
       SELECT product_id, SUM(quantity - reserved_qty)::numeric AS qty
       FROM inventory WHERE tenant_id = $1 GROUP BY product_id
     )
     SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE COALESCE(f.qty,0) >= COALESCE(r.need,0))::int AS ok
     FROM req r LEFT JOIN free f ON f.product_id = r.product_id`,
    [ctx.tenantId]
  );
  const availTotal = num(avail.rows[0].total);
  const availability = availTotal > 0 ? pct(num(avail.rows[0].ok), availTotal) : 100;

  const quality = await client.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE ir.passed)::int AS passed
     FROM inspection_results ir
     JOIN inspections i ON i.id = ir.inspection_id
     WHERE i.tenant_id = $1 AND ir.passed IS NOT NULL`,
    [ctx.tenantId]
  );
  const qTotal = num(quality.rows[0].total);
  const passRate = qTotal > 0 ? pct(num(quality.rows[0].passed), qTotal) : 100;

  const wasteRate = produced + num(prod.rows[0].waste) + num(prod.rows[0].scrapped) > 0
    ? round2(((num(prod.rows[0].waste) + num(prod.rows[0].scrapped)) / (produced + num(prod.rows[0].waste) + num(prod.rows[0].scrapped))) * 100)
    : 0;

  const oee = await client.query(
    `SELECT COALESCE(AVG(oee_pct),0)::numeric AS oee,
            COALESCE(AVG(availability_pct),0)::numeric AS availability,
            COALESCE(AVG(performance_pct),0)::numeric AS performance,
            COALESCE(AVG(quality_pct),0)::numeric AS quality
     FROM v_machine_oee WHERE machine_id IN (SELECT id FROM machines WHERE tenant_id = $1)`,
    [ctx.tenantId]
  );

  const active = await client.query(
    `SELECT COUNT(*)::int AS active,
            COUNT(*) FILTER (WHERE status = 'SUBMITTED')::int AS pending_approvals,
            COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS awaiting_putaway,
            COUNT(*) FILTER (WHERE due_date < CURRENT_DATE
                              AND status NOT IN ('COMPLETED','CLOSED','CANCELLED','REJECTED'))::int AS delayed,
            COUNT(*) FILTER (WHERE status IN ('MATERIALS_RESERVED','MATERIALS_ISSUED','IN_PROGRESS','QUALITY_INSPECTION'))::int AS in_progress
     FROM work_orders WHERE tenant_id = $1 AND status NOT IN ('DRAFT','CANCELLED','REJECTED','CLOSED')`,
    [ctx.tenantId]
  );

  const shortages = await client.query(
    `WITH req AS (
       SELECT wom.product_id, SUM(wom.required_qty - wom.issued_qty)::numeric AS need
       FROM work_order_materials wom
       JOIN work_orders wo ON wo.id = wom.work_order_id
       WHERE wo.tenant_id = $1 AND wo.status NOT IN ('CANCELLED','REJECTED','CLOSED','COMPLETED')
       GROUP BY wom.product_id
     ),
     free AS (
       SELECT product_id, SUM(quantity - reserved_qty)::numeric AS qty
       FROM inventory WHERE tenant_id = $1 GROUP BY product_id
     )
     SELECT COUNT(*)::int AS count FROM req r
     JOIN free f ON f.product_id = r.product_id
     WHERE COALESCE(f.qty,0) < COALESCE(r.need,0)`,
    [ctx.tenantId]
  );

  const holds = await client.query(
    `SELECT COUNT(*)::int AS count FROM production_quality_holds
     WHERE tenant_id = $1 AND status IN ('HELD','INVESTIGATING','QUARANTINE')`,
    [ctx.tenantId]
  );

  const highWaste = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM work_orders
     WHERE tenant_id = $1
       AND status NOT IN ('DRAFT','CANCELLED','REJECTED','CLOSED')
       AND (produced_qty + waste_qty + scrapped_qty) > 0
       AND (waste_qty + scrapped_qty) * 100.0 / (produced_qty + waste_qty + scrapped_qty) > 5`,
    [ctx.tenantId]
  );

  const variances = await client.query(
    `SELECT COUNT(*)::int AS count FROM production_variances
     WHERE tenant_id = $1 AND variance <> 0`,
    [ctx.tenantId]
  );

  const activeOrders = await client.query(
    `SELECT v.* FROM v_production_progress v
     JOIN work_orders wo ON wo.id = v.work_order_id
     WHERE wo.tenant_id = $1 AND v.status IN ('MATERIALS_RESERVED','MATERIALS_ISSUED','IN_PROGRESS','QUALITY_INSPECTION')
     ORDER BY v.due_date NULLS LAST, v.priority DESC LIMIT 25`,
    [ctx.tenantId]
  );

  const downMachines = await client.query(
    `SELECT id, code, name, machine_state, maintenance_status
     FROM machines
     WHERE tenant_id = $1 AND machine_state IN ('BREAKDOWN','MAINTENANCE','OFFLINE')
     ORDER BY machine_state`,
    [ctx.tenantId]
  );

  return {
    today: {
      planned,
      produced,
      achievement: pct(produced, planned),
      wastePct: wasteRate,
      machinesRunning: num(mach.rows[0].running),
      machinesTotal: num(mach.rows[0].total),
      machinesDown: num(mach.rows[0].down),
      downtimeHours: round2(num(dt.rows[0].hours)),
      materialAvailability: availability,
      qualityPassRate: passRate,
      oee: round2(num(oee.rows[0].oee)),
    },
    oeeFactors: {
      availability: round2(num(oee.rows[0].availability)),
      performance: round2(num(oee.rows[0].performance)),
      quality: round2(num(oee.rows[0].quality)),
    },
    orders: {
      active: num(active.rows[0].active),
      inProgress: num(active.rows[0].in_progress),
      delayed: num(active.rows[0].delayed),
      pendingApprovals: num(active.rows[0].pending_approvals),
      awaitingPutaway: num(active.rows[0].awaiting_putaway),
    },
    alerts: {
      materialShortages: num(shortages.rows[0].count),
      machinesDown: num(mach.rows[0].down),
      qualityHolds: num(holds.rows[0].count),
      highWasteOrders: num(highWaste.rows[0].count),
      productionVariances: num(variances.rows[0].count),
    },
    activeOrders: toCamelRows(activeOrders.rows),
    downMachines: toCamelRows(downMachines.rows),
  };
}

// ---------------------------------------------------------------------------
// 23. OEE with drill-down
// ---------------------------------------------------------------------------
export async function machineOee(client: pg.PoolClient, ctx: Ctx, machineId?: number) {
  const rows = await client.query(
    `SELECT * FROM v_machine_oee
     WHERE machine_id IN (SELECT id FROM machines WHERE tenant_id = $1)
       ${machineId ? 'AND machine_id = $2' : ''}
     ORDER BY machine_code`,
    machineId ? [ctx.tenantId, machineId] : [ctx.tenantId]
  );

  const byMachine = await Promise.all(
    rows.rows.map(async (r) => {
      const mid = num(r.machine_id);
      const downtime = await client.query(
        `SELECT category, COUNT(*)::int AS events, COALESCE(SUM(duration_min),0)::numeric AS minutes
         FROM downtime_events WHERE tenant_id = $1 AND machine_id = $2
         AND ended_at IS NOT NULL AND started_at::date >= CURRENT_DATE - INTERVAL '30 days'
         GROUP BY category ORDER BY minutes DESC`,
        [ctx.tenantId, mid]
      );
      const waste = await client.query(
        `SELECT category, COALESCE(SUM(waste_qty),0)::numeric AS qty
         FROM waste_records WHERE tenant_id = $1 AND machine_id = $2
         GROUP BY category ORDER BY qty DESC`,
        [ctx.tenantId, mid]
      );
      return {
        ...toCamelRow(r),
        downtimeDrilldown: toCamelRows(downtime.rows),
        wasteDrilldown: toCamelRows(waste.rows),
      };
    })
  );

  return machineId ? byMachine[0] ?? null : byMachine;
}

// ---------------------------------------------------------------------------
// 6/47. Machine operations (start/stop/breakdown/maintenance)
// ---------------------------------------------------------------------------
export async function machineOps(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    machineId: number;
    action: 'start' | 'stop' | 'breakdown' | 'maintenance_start' | 'maintenance_complete' | 'setup' | 'changeover' | 'quality_hold' | 'release' | 'offline';
    reason?: string | null;
    workOrderId?: number | null;
  }
) {
  const machine = await getMachine(client, ctx, input.machineId);
  const from = String(machine.machine_state);
  const action = String(input.action);

  const stateMap: Record<string, string> = {
    start: 'RUNNING',
    stop: 'IDLE',
    breakdown: 'BREAKDOWN',
    maintenance_start: 'MAINTENANCE',
    maintenance_complete: 'IDLE',
    setup: 'SETUP',
    changeover: 'CHANGEOVER',
    quality_hold: 'QUALITY_HOLD',
    release: 'IDLE',
    offline: 'OFFLINE',
  };
  const to = stateMap[action];
  if (!to) throw badRequest(`Unsupported machine action: ${action}`);

  const eventTypeMap: Record<string, string> = {
    start: 'machine.started',
    stop: 'machine.stopped',
    breakdown: 'machine.breakdown',
    maintenance_start: 'machine.maintenance.started',
    maintenance_complete: 'machine.maintenance.completed',
    setup: 'machine.setup',
    changeover: 'machine.changeover',
    quality_hold: 'machine.quality_hold',
    release: 'machine.released',
    offline: 'machine.offline',
  };

  await client.query(
    `UPDATE machines
     SET machine_state = $1,
         maintenance_status = CASE
           WHEN $1 = 'MAINTENANCE' THEN 'IN_PROGRESS'
           WHEN $1 IN ('RUNNING','IDLE') AND maintenance_status = 'IN_PROGRESS' THEN 'NONE'
           ELSE maintenance_status END,
         updated_at = now()
     WHERE id = $2 AND tenant_id = $3`,
    [to, input.machineId, ctx.tenantId]
  );

  await client.query(
    `INSERT INTO machine_logs
       (company_id, tenant_id, machine_id, work_order_id, event_type, status_from, status_to, reason, operator_id, occurred_at, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10)`,
    [
      ctx.companyId ?? null,
      ctx.tenantId ?? null,
      input.machineId,
      input.workOrderId ?? null,
      String(action).toUpperCase(),
      from,
      to,
      input.reason ?? null,
      ctx.userId ?? null,
      JSON.stringify({ action }),
    ]
  );

  await mesEvent(client, ctx, {
    eventType: eventTypeMap[action],
    entityType: 'machines',
    entityId: input.machineId,
    entityCode: String(machine.code),
    payload: { from, to, reason: input.reason ?? null, workOrderId: input.workOrderId ?? null },
    severity: action === 'breakdown' ? 'CRITICAL' : 'INFO',
  });

  if (action === 'breakdown') {
    await upsertAlert(client, ctx, {
      alertType: 'MACHINE_BREAKDOWN',
      severity: 'CRITICAL',
      title: `Machine ${machine.code} down`,
      message: input.reason ?? 'Machine breakdown reported',
      refType: 'machines',
      refId: input.machineId,
    });
  }

  await logAudit(client, ctx, {
    action: 'machine_ops',
    resource: 'machines',
    recordId: input.machineId,
    recordCode: String(machine.code),
    newValues: { action, from, to, reason: input.reason ?? null },
  });

  return { machineId: input.machineId, action, from, to, logged: true };
}// ---------------------------------------------------------------------------
// 10. Material availability check (block release when critical material missing)
// ---------------------------------------------------------------------------
export async function materialAvailability(client: pg.PoolClient, ctx: Ctx, workOrderId: number) {
  const wo = await getWorkOrder(client, ctx, workOrderId);
  const checkNo = await nextDoc(client, ctx, 'MAC');

  const rows = await client.query(
    `SELECT wom.id AS requirement_id, wom.product_id, p.code AS product_code, p.name AS product_name,
            wom.required_qty, wom.issued_qty, p.type,
            COALESCE(SUM(i.quantity - i.reserved_qty),0)::numeric AS on_hand,
            COALESCE(SUM(i.reserved_qty),0)::numeric AS reserved
     FROM work_order_materials wom
     JOIN products p ON p.id = wom.product_id
     LEFT JOIN inventory i ON i.product_id = wom.product_id AND i.tenant_id = $1
     WHERE wom.work_order_id = $2
     GROUP BY wom.id, wom.product_id, p.code, p.name, wom.required_qty, wom.issued_qty, p.type
     ORDER BY p.code`,
    [ctx.tenantId, workOrderId]
  );

  const lines = rows.rows.map((r) => {
    const need = Math.max(0, num(r.required_qty) - num(r.issued_qty));
    const onHand = num(r.on_hand);
    const available = onHand >= need;
    return {
      productId: num(r.product_id),
      productCode: String(r.product_code),
      productName: String(r.product_name),
      required: need,
      onHand,
      available,
      critical: !['PACKAGING', 'CONSUMABLE', 'SPARE_PART'].includes(String(r.type)),
    };
  });
  const missingCritical = lines.some((l) => !l.available && l.critical);
  const missingAny = lines.some((l) => !l.available);
  const status = missingCritical ? 'FAIL' : missingAny ? 'PARTIAL' : 'PASS';

  await client.query(
    `INSERT INTO material_availability_checks
       (company_id, tenant_id, work_order_id, check_no, status, result, checked_at, checked_by)
     VALUES ($1,$2,$3,$4,$5,$6,now(),$7)`,
    [
      ctx.companyId ?? null,
      ctx.tenantId ?? null,
      workOrderId,
      checkNo,
      status,
      JSON.stringify(lines),
      ctx.userId ?? null,
    ]
  );

  return {
    workOrderId,
    woNo: String(wo.wo_no),
    checkNo,
    status,
    lines,
    canRelease: status === 'PASS',
    message:
      status === 'PASS'
        ? 'All materials available'
        : status === 'PARTIAL'
          ? 'Some materials are short Ã¢â‚¬â€ supervisor override required to release'
          : 'Critical materials are short Ã¢â‚¬â€ release blocked until override',
  };
}

export async function overrideAvailability(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { workOrderId: number; reason: string }
) {
  const wo = await getWorkOrder(client, ctx, input.workOrderId);
  const check = await client.query(
    `SELECT * FROM material_availability_checks
     WHERE work_order_id = $1 AND tenant_id = $2
     ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [input.workOrderId, ctx.tenantId]
  );
  if (check.rows.length === 0) throw badRequest('Run a material availability check first');
  await client.query(
    `UPDATE material_availability_checks
     SET overridden = true, override_reason = $1, overridden_by = $2, overridden_at = now()
     WHERE id = $3`,
    [input.reason, ctx.userId ?? null, num(check.rows[0].id)]
  );
  await mesEvent(client, ctx, {
    eventType: 'production.material.availability_overridden',
    entityType: 'work_orders',
    entityId: input.workOrderId,
    entityCode: String(wo.wo_no),
    payload: { reason: input.reason },
    severity: 'WARN',
  });
  return { workOrderId: input.workOrderId, overridden: true, reason: input.reason };
}

// ---------------------------------------------------------------------------
// 11. Material reservation
// ---------------------------------------------------------------------------
export async function reserveMaterials(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { workOrderId: number; override?: boolean; reason?: string | null }
) {
  const wo = await getWorkOrder(client, ctx, input.workOrderId);
  const allowed = ['APPROVED', 'RELEASED', 'MATERIALS_RESERVED', 'MATERIALS_ISSUED'];
  if (!allowed.includes(String(wo.status))) {
    throw badRequest(`Work order must be APPROVED/RELEASED to reserve materials (current: ${wo.status})`);
  }

  const check = await client.query(
    `SELECT status, overridden FROM material_availability_checks
     WHERE work_order_id = $1 AND tenant_id = $2 ORDER BY id DESC LIMIT 1`,
    [input.workOrderId, ctx.tenantId]
  );
  const checkStatus = check.rows.length ? String(check.rows[0].status) : null;
  if (checkStatus === 'FAIL' && !input.override && !check.rows[0].overridden) {
    throw badRequest('Critical material shortage Ã¢â‚¬â€ an authorized override is required to reserve');
  }

  const reservationNo = await nextDoc(client, ctx, 'MRV');
  const lines = await client.query(
    `SELECT wom.id, wom.product_id, wom.required_qty, wom.issued_qty, p.type, p.standard_cost
     FROM work_order_materials wom JOIN products p ON p.id = wom.product_id
     WHERE wom.work_order_id = $1`,
    [input.workOrderId]
  );

  const created: Array<Record<string, unknown>> = [];
  for (const l of lines.rows) {
    const productId = num(l.product_id);
    const need = Math.max(0, num(l.required_qty) - num(l.issued_qty));
    if (need <= 0) continue;

    const whRes = await client.query(
      `SELECT i.warehouse_id, COALESCE(SUM(i.quantity - i.reserved_qty),0)::numeric AS free
       FROM inventory i
       WHERE i.product_id = $1 AND i.tenant_id = $2 AND i.quantity - i.reserved_qty > 0
       GROUP BY i.warehouse_id ORDER BY free DESC LIMIT 1`,
      [productId, ctx.tenantId]
    );
    const warehouseId = whRes.rows.length ? num(whRes.rows[0].warehouse_id) : null;
    const canReserve = whRes.rows.length ? num(whRes.rows[0].free) : 0;
    const toReserve = Math.min(need, canReserve);

    let batchRes: { id: number; batch_no: string } | null = null;
    if (toReserve > 0 && warehouseId) {
      const b = await client.query(
        `SELECT pb.id, pb.batch_no FROM product_batches pb
         JOIN inventory i ON i.batch_id = pb.id AND i.warehouse_id = $1
         WHERE pb.product_id = $2 AND i.quantity - i.reserved_qty > 0
           AND pb.status = 'ACTIVE'
         ORDER BY pb.batch_no LIMIT 1`,
        [warehouseId, productId]
      );
      if (b.rows.length) batchRes = { id: num(b.rows[0].id), batch_no: String(b.rows[0].batch_no) };
    }

    let invReservationId: number | null = null;
    if (toReserve > 0 && warehouseId) {
      invReservationId = await reserve(client, ctx, {
        product: productId,
        batch: batchRes?.id ?? null,
        warehouse: warehouseId,
        qty: toReserve,
        refType: 'work_orders',
        refId: input.workOrderId,
      });
    }

    const ins = await client.query(
      `INSERT INTO production_material_reservations
         (company_id, tenant_id, branch_id, reservation_no, work_order_id, product_id, batch_id,
          warehouse_id, required_qty, reserved_qty, status, reserved_at, inventory_reservation_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
               CASE WHEN $10 > 0 THEN 'RESERVED' ELSE 'PARTIAL' END, now(), $11, $12)
       RETURNING id, reservation_no`,
      [
        ctx.companyId ?? null,
        ctx.tenantId ?? null,
        ctx.branchId ?? null,
        reservationNo,
        input.workOrderId,
        productId,
        batchRes?.id ?? null,
        warehouseId ?? null,
        need,
        toReserve,
        invReservationId,
        ctx.userId ?? null,
      ]
    );
    created.push({
      reservationId: num(ins.rows[0].id),
      productId,
      requiredQty: need,
      reservedQty: toReserve,
      shortQty: Math.max(0, need - toReserve),
      status: toReserve >= need ? 'RESERVED' : toReserve > 0 ? 'PARTIAL' : 'PARTIAL',
    });
  }

  if (created.some((r) => num(r.shortQty) === 0) || created.length === 0) {
    await client.query(`UPDATE work_orders SET status = 'MATERIALS_RESERVED', materials_reserved_at = now() WHERE id = $1`, [input.workOrderId]);
  }

  await mesEvent(client, ctx, {
    eventType: 'production.material.reserved',
    entityType: 'work_orders',
    entityId: input.workOrderId,
    entityCode: String(wo.wo_no),
    payload: { reservationNo, lines: created.length, short: created.filter((r) => num(r.shortQty) > 0).length },
  });

  return { workOrderId: input.workOrderId, reservationNo, lines: created };
}

// ---------------------------------------------------------------------------
// 12. Material issue (barcode-first)
// ---------------------------------------------------------------------------
export async function issueMaterialMes(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    workOrderId: number;
    reservationId?: number | null;
    productId: number;
    batchId?: number | null;
    quantity: number;
    fifoConfirmed?: boolean;
    overrideReason?: string | null;
    issueType?: string;
  }
) {
  const wo = await getWorkOrder(client, ctx, input.workOrderId);
  if (!['MATERIALS_RESERVED', 'MATERIALS_ISSUED', 'IN_PROGRESS'].includes(String(wo.status))) {
    throw badRequest(`Work order must have materials reserved (current: ${wo.status})`);
  }
  const qty = Number(input.quantity);
  if (qty <= 0) throw badRequest('Issue quantity must be positive');

  const issueNo = await nextDoc(client, ctx, 'MIS');
  const whRes = await client.query(
    `SELECT warehouse_id, bin_id, quantity, reserved_qty, avg_cost
     FROM inventory
     WHERE product_id = $1 AND tenant_id = $2
       AND ($3::bigint IS NULL OR batch_id = $3)
       AND quantity - reserved_qty > 0
     ORDER BY batch_id NULLS LAST, created_at LIMIT 1`,
    [input.productId, ctx.tenantId, input.batchId ?? null]
  );
  const inv = whRes.rows[0];
  if (!inv) throw badRequest('Material not available on hand for issue');
  const available = num(inv.quantity) - num(inv.reserved_qty);
  if (qty > available) throw badRequest(`Only ${available} available for issue (requested ${qty})`);

  const warehouseId = num(inv.warehouse_id);
  const binId = inv.bin_id != null ? num(inv.bin_id) : null;
  const batchId = inv.batch_id != null ? num(inv.batch_id) : null;
  const unitCost = num(inv.avg_cost);

  const qrRes = await client.query(
    `SELECT qr.id FROM qr_codes qr
     WHERE qr.entity_type = 'BATCH' AND qr.entity_id = $1 LIMIT 1`,
    [batchId]
  );
  const qrId = qrRes.rows.length ? num(qrRes.rows[0].id) : null;

  const moveId = await postMove(client, ctx, {
    movementType: 'PRODUCTION_ISSUE',
    product: input.productId,
    batch: batchId,
    warehouse: warehouseId,
    bin: binId,
    quantity: qty,
    unitCost,
    refType: 'work_orders',
    refId: input.workOrderId,
    refCode: String(wo.wo_no),
    qr: qrId,
    workOrder: input.workOrderId,
    reason: input.overrideReason ?? null,
  });

  const ins = await client.query(
    `INSERT INTO production_material_issues
       (company_id, tenant_id, branch_id, issue_no, work_order_id, reservation_id, product_id, batch_id,
        warehouse_id, bin_id, quantity, unit_cost, issue_type, scanned_at, scanned_by,
        fifo_confirmed, override_reason, override_by, override_at, movement_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),$14,$15,$16,$17,now(),$18)
     RETURNING id`,
    [
      ctx.companyId ?? null,
      ctx.tenantId ?? null,
      ctx.branchId ?? null,
      issueNo,
      input.workOrderId,
      input.reservationId ?? null,
      input.productId,
      batchId,
      warehouseId,
      binId,
      qty,
      unitCost,
      String(input.issueType ?? 'NORMAL'),
      ctx.userId ?? null,
      input.fifoConfirmed ?? true,
      input.overrideReason ?? null,
      ctx.userId ?? null,
      moveId,
    ]
  );
  const issueId = num(ins.rows[0].id);

  if (input.reservationId) {
    const resv = await client.query(
      `SELECT * FROM production_material_reservations WHERE id = $1 FOR UPDATE`,
      [input.reservationId]
    );
    if (resv.rows.length) {
      const issued = num(resv.rows[0].issued_qty) + qty;
      await client.query(
        `UPDATE production_material_reservations
         SET issued_qty = $1, issued_at = now(),
             status = CASE WHEN $1 >= required_qty THEN 'ISSUED' WHEN $1 > 0 THEN 'PARTIAL' ELSE status END
         WHERE id = $2`,
        [issued, input.reservationId]
      );
      if (resv.rows[0].inventory_reservation_id) {
        await consume(client, num(resv.rows[0].inventory_reservation_id));
      }
    }
  }

  await client.query(
    `UPDATE work_order_materials SET issued_qty = issued_qty + $1 WHERE work_order_id = $2 AND product_id = $3`,
    [qty, input.workOrderId, input.productId]
  );

  const allIssued = await client.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE issued_qty >= required_qty)::int AS done
     FROM work_order_materials WHERE work_order_id = $1`,
    [input.workOrderId]
  );
  if (num(allIssued.rows[0].done) === num(allIssued.rows[0].total)) {
    await client.query(
      `UPDATE work_orders SET status = 'MATERIALS_ISSUED', materials_issued_at = now() WHERE id = $1`,
      [input.workOrderId]
    );
  }

  await mesEvent(client, ctx, {
    eventType: 'production.material.issued',
    entityType: 'work_orders',
    entityId: input.workOrderId,
    entityCode: String(wo.wo_no),
    payload: { issueNo, productId: input.productId, batchId, quantity: qty },
  });

  return { issueId, issueNo, movementId: moveId, quantity: qty, batchId };
}

// ---------------------------------------------------------------------------
// 42. Production board (kanban stages)
// ---------------------------------------------------------------------------
export async function productionBoard(client: pg.PoolClient, ctx: Ctx) {
  const stages = ['PLANNED', 'READY', 'MATERIALS_READY', 'IN_PRODUCTION', 'QUALITY', 'COMPLETED'];
  const stageMap: Record<string, string[]> = {
    PLANNED: ['DRAFT', 'SUBMITTED', 'APPROVED'],
    READY: ['RELEASED'],
    MATERIALS_READY: ['MATERIALS_RESERVED', 'MATERIALS_ISSUED'],
    IN_PRODUCTION: ['IN_PROGRESS'],
    QUALITY: ['QUALITY_INSPECTION'],
    COMPLETED: ['COMPLETED', 'CLOSED'],
  };
  const res = await client.query(
    `SELECT v.* FROM v_production_progress v
     JOIN work_orders wo ON wo.id = v.work_order_id
     WHERE wo.tenant_id = $1 AND v.status NOT IN ('CANCELLED','REJECTED')
     ORDER BY v.due_date NULLS LAST, v.priority DESC`,
    [ctx.tenantId]
  );
  const byStage: Record<string, Array<Record<string, unknown>>> = {};
  for (const s of stages) byStage[s] = [];
  for (const r of res.rows) {
    const st = String(r.status);
    for (const s of stages) {
      if (stageMap[s].includes(st)) {
        byStage[s].push(toCamelRow(r));
        break;
      }
    }
  }
  return { stages, byStage };
}

// ---------------------------------------------------------------------------
// 26/27. Production schedule + finite capacity load
// ---------------------------------------------------------------------------
export async function productionSchedule(client: pg.PoolClient, ctx: Ctx, from?: string | null, to?: string | null) {
  const params: unknown[] = [ctx.tenantId];
  let where = `wo.tenant_id = $1`;
  if (from) { params.push(from); where += ` AND pse.planned_start >= $${params.length}::date`; }
  if (to) { params.push(to); where += ` AND pse.planned_end <= $${params.length}::date + INTERVAL '1 day'`; }
  const res = await client.query(
    `SELECT pse.id, pse.schedule_id, ps.schedule_no, pse.work_order_id, wo.wo_no,
            pse.machine_id, m.code AS machine_code, pse.work_centre_id, wc.code AS work_centre_code,
            pse.planned_start, pse.planned_end, pse.priority, pse.sequence, pse.changeover_min, pse.status,
            wo.product_id, p.code AS product_code, p.name AS product_name, wo.quantity, wo.produced_qty
     FROM production_schedule_entries pse
     JOIN production_schedules ps ON ps.id = pse.schedule_id
     JOIN work_orders wo ON wo.id = pse.work_order_id
     LEFT JOIN machines m ON m.id = pse.machine_id
     LEFT JOIN work_centres wc ON wc.id = pse.work_centre_id
     LEFT JOIN products p ON p.id = wo.product_id
     WHERE ${where}
     ORDER BY pse.planned_start, pse.sequence`,
    params
  );
  return toCamelRows(res.rows);
}

export async function scheduleLoad(client: pg.PoolClient, ctx: Ctx, from?: string | null, to?: string | null) {
  const params: unknown[] = [ctx.tenantId];
  let where = `mc.tenant_id = $1`;
  if (from) { params.push(from); where += ` AND mc.capacity_date >= $${params.length}::date`; }
  if (to) { params.push(to); where += ` AND mc.capacity_date <= $${params.length}::date`; }
  const cap = await client.query(
    `SELECT mc.*, m.code AS machine_code, m.name AS machine_name
     FROM machine_capacity mc JOIN machines m ON m.id = mc.machine_id
     WHERE ${where} ORDER BY mc.capacity_date, m.code`,
    params
  );
  const entries = await productionSchedule(client, ctx, from, to);
  const byMachine = new Map<number, { machineCode: string; loadMinutes: number }>();
  for (const e of entries as Array<Record<string, unknown>>) {
    if (e.machineId == null) continue;
    const mid = num(e.machineId);
    const start = new Date(String(e.plannedStart)).getTime();
    const end = new Date(String(e.plannedEnd)).getTime();
    const minutes = Math.max(0, (end - start) / 60000);
    const cur = byMachine.get(mid) ?? { machineCode: String(e.machineCode ?? ''), loadMinutes: 0 };
    cur.loadMinutes += minutes;
    byMachine.set(mid, cur);
  }
  const rows = cap.rows.map((r) => {
    const mid = num(r.machine_id);
    const load = byMachine.get(mid);
    const remaining = num(r.remaining_hours);
    const loadHours = load ? round2(load.loadMinutes / 60) : 0;
    return {
      ...toCamelRow(r),
      scheduledLoadHours: loadHours,
      overloaded: loadHours > remaining,
      overloadHours: round2(Math.max(0, loadHours - remaining)),
    };
  });
  return { capacity: rows, entries };
}// ---------------------------------------------------------------------------
// 25. Digital shift handover
// ---------------------------------------------------------------------------
export async function createShiftHandover(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    workOrderId?: number | null;
    machineId?: number | null;
    fromShiftCode: string;
    toShiftCode?: string | null;
    shiftDate?: string | null;
    producedQty?: number | null;
    outstandingQty?: number | null;
    machineStatus?: string | null;
    issues?: string | null;
    materialStatus?: string | null;
    qualityStatus?: string | null;
    handoverNotes?: string | null;
  }
) {
  const handoverNo = await nextDoc(client, ctx, 'SHO');
  const ins = await client.query(
    `INSERT INTO production_shift_handovers
       (company_id, tenant_id, branch_id, handover_no, work_order_id, machine_id, from_shift_code,
        to_shift_code, shift_date, produced_qty, outstanding_qty, machine_status, issues,
        material_status, quality_status, handover_notes, from_operator_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'PENDING')
     RETURNING id`,
    [
      ctx.companyId ?? null,
      ctx.tenantId ?? null,
      ctx.branchId ?? null,
      handoverNo,
      input.workOrderId ?? null,
      input.machineId ?? null,
      input.fromShiftCode,
      input.toShiftCode ?? null,
      input.shiftDate ?? new Date().toISOString().slice(0, 10),
      input.producedQty ?? 0,
      input.outstandingQty ?? 0,
      input.machineStatus ?? null,
      input.issues ?? null,
      input.materialStatus ?? null,
      input.qualityStatus ?? null,
      input.handoverNotes ?? null,
      ctx.userId ?? null,
    ]
  );
  const id = num(ins.rows[0].id);
  await mesEvent(client, ctx, {
    eventType: 'production.shift_handover_created',
    entityType: 'production_shift_handovers',
    entityId: id,
    entityCode: handoverNo,
    payload: { machineId: input.machineId ?? null, workOrderId: input.workOrderId ?? null },
  });
  return { id, handoverNo, status: 'PENDING' };
}

export async function acknowledgeShiftHandover(client: pg.PoolClient, ctx: Ctx, handoverId: number) {
  const res = await client.query(
    `UPDATE production_shift_handovers
     SET status = 'ACKNOWLEDGED', acknowledged_at = now(), acknowledged_by = $1, to_operator_id = $1
     WHERE id = $2 AND tenant_id = $3 AND status = 'PENDING'
     RETURNING handover_no`,
    [ctx.userId ?? null, handoverId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Handover not found or already acknowledged');
  await mesEvent(client, ctx, {
    eventType: 'production.shift_handover_acknowledged',
    entityType: 'production_shift_handovers',
    entityId: handoverId,
    entityCode: String(res.rows[0].handover_no),
  });
  return { id: handoverId, status: 'ACKNOWLEDGED' };
}

export async function listShiftHandovers(client: pg.PoolClient, ctx: Ctx, openOnly = false) {
  const res = await client.query(
    `SELECT h.*, wo.wo_no, m.code AS machine_code
     FROM production_shift_handovers h
     LEFT JOIN work_orders wo ON wo.id = h.work_order_id
     LEFT JOIN machines m ON m.id = h.machine_id
     WHERE h.tenant_id = $1 ${openOnly ? `AND h.status = 'PENDING'` : ''}
     ORDER BY h.id DESC LIMIT 100`,
    [ctx.tenantId]
  );
  return toCamelRows(res.rows);
}

// ---------------------------------------------------------------------------
// 18. Traceability + 44. Electronic batch record
// ---------------------------------------------------------------------------
export async function traceability(client: pg.PoolClient, ctx: Ctx, batchId: number) {
  const ebr = await client.query(
    `SELECT * FROM v_production_batch_ebr WHERE id = $1
     AND product_id IN (SELECT id FROM products WHERE tenant_id = $2)`,
    [batchId, ctx.tenantId]
  );
  if (ebr.rows.length === 0) throw notFound('Production batch not found');
  const batch = ebr.rows[0];

  const rawMaterials = await client.query(
    `SELECT pmi.*, p.code AS product_code, p.name AS product_name, pb.batch_no AS material_batch_no
     FROM production_material_issues pmi
     JOIN products p ON p.id = pmi.product_id
     LEFT JOIN product_batches pb ON pb.id = pmi.batch_id
     WHERE pmi.work_order_id = $1 AND pmi.tenant_id = $2
     ORDER BY pmi.id`,
    [batch.work_order_id ?? null, ctx.tenantId]
  );

  const quality = await client.query(
    `SELECT i.inspection_no, i.kind, i.result AS inspection_result, i.inspected_at, i.inspector_id,
            ir.parameter, ir.actual_value, ir.standard_value, ir.unit, ir.passed
     FROM inspections i
     LEFT JOIN inspection_results ir ON ir.inspection_id = i.id
     WHERE i.work_order_id = $1 AND i.tenant_id = $2
     ORDER BY i.id, ir.id`,
    [batch.work_order_id ?? null, ctx.tenantId]
  );

  const outputs = await client.query(
    `SELECT po.output_type, po.quantity, po.reason, po.recorded_by, po.recorded_at
     FROM production_outputs po
     WHERE po.work_order_id = $1
     ORDER BY po.recorded_at`,
    [batch.work_order_id ?? null]
  );

  const events = await client.query(
    `SELECT event_type, entity_type, entity_id, entity_code, payload, occurred_at, user_id
     FROM manufacturing_events
     WHERE tenant_id = $1
       AND (entity_type = 'production_batches' AND entity_id = $2
            OR entity_type = 'work_orders' AND entity_id = $3)
     ORDER BY occurred_at`,
    [ctx.tenantId, batchId, batch.work_order_id ?? null]
  );

  return {
    batch: toCamelRow(batch),
    rawMaterials: toCamelRows(rawMaterials.rows),
    quality: toCamelRows(quality.rows),
    outputs: toCamelRows(outputs.rows),
    events: toCamelRows(events.rows),
  };
}

export async function batchEbr(client: pg.PoolClient, ctx: Ctx, batchId: number) {
  const t = await traceability(client, ctx, batchId);
  return {
    ebr: t.batch,
    billOfMaterials: t.rawMaterials,
    qualityResults: t.quality,
    productionOutputs: t.outputs,
    eventHistory: t.events,
  };
}

// ---------------------------------------------------------------------------
// 20. Quality hold + disposition
// ---------------------------------------------------------------------------
export async function qualityHold(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { productionBatchId: number; reason: string; heldQty: number }
) {
  const holdNo = await nextDoc(client, ctx, 'QHL');
  const batch = await client.query(
    `SELECT * FROM production_batches WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [input.productionBatchId, ctx.tenantId]
  );
  if (batch.rows.length === 0) throw notFound('Production batch not found');
  const b = batch.rows[0];
  const ins = await client.query(
    `INSERT INTO production_quality_holds
       (company_id, tenant_id, branch_id, hold_no, production_batch_id, work_order_id, product_id,
        reason, held_qty, status, held_by, held_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'HELD',$10,now())
     RETURNING id`,
    [
      ctx.companyId ?? null,
      ctx.tenantId ?? null,
      ctx.branchId ?? null,
      holdNo,
      input.productionBatchId,
      b.work_order_id ?? null,
      num(b.product_id),
      input.reason,
      input.heldQty,
      ctx.userId ?? null,
    ]
  );
  const holdId = num(ins.rows[0].id);
  await client.query(
    `UPDATE production_batches SET status = 'QUALITY_HOLD', quality_result = 'HOLD' WHERE id = $1`,
    [input.productionBatchId]
  );
  if (b.work_order_id) {
    await client.query(`UPDATE work_orders SET status = 'QUALITY_INSPECTION', quality_started_at = now() WHERE id = $1`, [num(b.work_order_id)]);
  }
  await mesEvent(client, ctx, {
    eventType: 'production.quality.failed',
    entityType: 'production_batches',
    entityId: input.productionBatchId,
    entityCode: String(b.batch_no),
    payload: { holdNo, reason: input.reason, heldQty: input.heldQty },
    severity: 'CRITICAL',
  });
  await upsertAlert(client, ctx, {
    alertType: 'QUALITY_FAILURE',
    severity: 'CRITICAL',
    title: `Batch ${b.batch_no} on quality hold`,
    message: input.reason,
    refType: 'production_batches',
    refId: input.productionBatchId,
  });
  return { id: holdId, holdNo, status: 'HELD' };
}

export async function qualityDisposition(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { holdId: number; disposition: string; quantity: number; reason?: string | null; createRework?: boolean }
) {
  const hold = await client.query(
    `SELECT * FROM production_quality_holds WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [input.holdId, ctx.tenantId]
  );
  if (hold.rows.length === 0) throw notFound('Quality hold not found');
  const h = hold.rows[0];
  const disposition = String(input.disposition).toUpperCase();
  const valid = ['RELEASE', 'REWORK', 'DOWNGRADE', 'RETURN_TO_PRODUCTION', 'SCRAP', 'REJECT'];
  if (!valid.includes(disposition)) throw badRequest(`Invalid disposition: ${disposition}`);

  let reworkOrderId: number | null = null;
  if (disposition === 'REWORK' && input.createRework && h.work_order_id) {
    const rw = await createRework(client, ctx, {
      sourceWorkOrderId: num(h.work_order_id),
      productionBatchId: num(h.production_batch_id),
      productId: num(h.product_id),
      quantity: input.quantity,
      notes: input.reason ?? null,
    });
    reworkOrderId = num(rw.id);
  }

  await client.query(
    `INSERT INTO quality_dispositions
       (company_id, tenant_id, hold_id, disposition, quantity, reason, decided_by, decided_at, rework_order_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8)`,
    [
      ctx.companyId ?? null,
      ctx.tenantId ?? null,
      input.holdId,
      disposition,
      input.quantity,
      input.reason ?? null,
      ctx.userId ?? null,
      reworkOrderId,
    ]
  );

  const newHoldStatus = disposition === 'RELEASE' ? 'RELEASED' : 'DISPOSED';
  await client.query(
    `UPDATE production_quality_holds
     SET status = $1, released_by = $2, released_at = now() WHERE id = $3`,
    [newHoldStatus, ctx.userId ?? null, input.holdId]
  );

  const batchNext: Record<string, string> = {
    RELEASE: 'COMPLETED',
    REWORK: 'REWORK',
    DOWNGRADE: 'CLOSED',
    RETURN_TO_PRODUCTION: 'IN_PRODUCTION',
    SCRAP: 'CLOSED',
    REJECT: 'REJECTED',
  };
  await client.query(
    `UPDATE production_batches SET status = $1 WHERE id = $2`,
    [batchNext[disposition] ?? 'CLOSED', num(h.production_batch_id)]
  );
  if (disposition === 'SCRAP' || disposition === 'REJECT') {
    const batch = await client.query(
      `SELECT * FROM production_batches WHERE id = $1`,
      [num(h.production_batch_id)]
    );
    if (batch.rows.length) {
      await client.query(
        `INSERT INTO scrap_records
           (company_id, tenant_id, work_order_id, production_batch_id, product_id, scrap_type, quantity, reason, recorded_by, recorded_at)
         VALUES ($1,$2,$3,$4,$5,'FINAL',$6,$7,$8,now())`,
        [
          ctx.companyId ?? null,
          ctx.tenantId ?? null,
          h.work_order_id ?? null,
          num(h.production_batch_id),
          num(h.product_id),
          input.quantity,
          input.reason ?? `Quality disposition: ${disposition}`,
          ctx.userId ?? null,
        ]
      );
    }
  }

  await mesEvent(client, ctx, {
    eventType: 'production.quality.disposed',
    entityType: 'production_quality_holds',
    entityId: input.holdId,
    entityCode: String(h.hold_no),
    payload: { disposition, quantity: input.quantity, reworkOrderId },
    severity: disposition === 'SCRAP' || disposition === 'REJECT' ? 'WARN' : 'INFO',
  });

  return { holdId: input.holdId, disposition, reworkOrderId };
}// ---------------------------------------------------------------------------
// 21. Scrap and waste
// ---------------------------------------------------------------------------
export async function recordScrap(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    workOrderId: number;
    productionBatchId?: number | null;
    machineId?: number | null;
    productId?: number | null;
    scrapType?: string;
    quantity: number;
    unitCost?: number | null;
    reason?: string | null;
  }
) {
  const wo = await getWorkOrder(client, ctx, input.workOrderId);
  const qty = Number(input.quantity);
  if (qty <= 0) throw badRequest('Scrap quantity must be positive');
  const productId = input.productId != null ? Number(input.productId) : num(wo.product_id);
  const unitCost = input.unitCost != null ? Number(input.unitCost) : num(wo.standard_cost);

  const moveId = await postMove(client, ctx, {
    movementType: 'SCRAP',
    product: productId,
    quantity: qty,
    unitCost,
    refType: 'work_orders',
    refId: input.workOrderId,
    refCode: String(wo.wo_no),
    workOrder: input.workOrderId,
    reason: input.reason ?? null,
  });

  const ins = await client.query(
    `INSERT INTO scrap_records
       (company_id, tenant_id, branch_id, work_order_id, production_batch_id, machine_id, operator_id,
        shift_code, product_id, scrap_type, quantity, unit_cost, reason, recorded_by, recorded_at, movement_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),$15)
     RETURNING id`,
    [
      ctx.companyId ?? null,
      ctx.tenantId ?? null,
      ctx.branchId ?? null,
      input.workOrderId,
      input.productionBatchId ?? null,
      input.machineId ?? null,
      ctx.userId ?? null,
      null,
      productId,
      String(input.scrapType ?? 'PRODUCTION'),
      qty,
      unitCost,
      input.reason ?? null,
      ctx.userId ?? null,
      moveId,
    ]
  );
  const id = num(ins.rows[0].id);

  await client.query(
    `UPDATE work_orders SET scrapped_qty = scrapped_qty + $1, actual_waste_cost = actual_waste_cost + $2 WHERE id = $3`,
    [qty, qty * unitCost, input.workOrderId]
  );
  if (input.productionBatchId) {
    await client.query(
      `UPDATE production_batches SET scrap_qty = scrap_qty + $1 WHERE id = $2`,
      [qty, input.productionBatchId]
    );
  }

  await mesEvent(client, ctx, {
    eventType: 'production.scrap.recorded',
    entityType: 'work_orders',
    entityId: input.workOrderId,
    entityCode: String(wo.wo_no),
    payload: { scrapId: id, productId, quantity: qty, reason: input.reason ?? null },
    severity: 'WARN',
  });
  return { id, scrapNo: `SCR-${id}`, movementId: moveId };
}

export async function recordWaste(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    workOrderId: number;
    productionBatchId?: number | null;
    machineId?: number | null;
    wasteType?: string;
    category?: string;
    inputQty?: number | null;
    wasteQty: number;
    reason?: string | null;
  }
) {
  const wo = await getWorkOrder(client, ctx, input.workOrderId);
  const wasteQty = Number(input.wasteQty);
  if (wasteQty <= 0) throw badRequest('Waste quantity must be positive');
  const wasteType = String(input.wasteType ?? 'NORMAL');
  const category = String(input.category ?? 'OTHER');
  const isAbnormal = wasteType === 'ABNORMAL';

  const ins = await client.query(
    `INSERT INTO waste_records
       (company_id, tenant_id, branch_id, work_order_id, production_batch_id, machine_id, operator_id,
        shift_code, waste_type, category, input_qty, waste_qty, reason, is_abnormal, recorded_by, recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
     RETURNING id`,
    [
      ctx.companyId ?? null,
      ctx.tenantId ?? null,
      ctx.branchId ?? null,
      input.workOrderId,
      input.productionBatchId ?? null,
      input.machineId ?? null,
      ctx.userId ?? null,
      null,
      wasteType,
      category,
      input.inputQty ?? 0,
      wasteQty,
      input.reason ?? null,
      isAbnormal,
      ctx.userId ?? null,
    ]
  );
  const id = num(ins.rows[0].id);
  await client.query(
    `UPDATE work_orders SET waste_qty = waste_qty + $1 WHERE id = $2`,
    [wasteQty, input.workOrderId]
  );
  if (input.productionBatchId) {
    await client.query(
      `UPDATE production_batches SET scrap_qty = scrap_qty + $1 WHERE id = $2`,
      [wasteQty, input.productionBatchId]
    );
  }
  await mesEvent(client, ctx, {
    eventType: 'production.waste.recorded',
    entityType: 'work_orders',
    entityId: input.workOrderId,
    entityCode: String(wo.wo_no),
    payload: { wasteId: id, category, wasteQty, isAbnormal },
    severity: isAbnormal ? 'WARN' : 'INFO',
  });
  if (isAbnormal) {
    await upsertAlert(client, ctx, {
      alertType: 'HIGH_WASTE',
      severity: 'WARNING',
      title: `Abnormal waste on ${wo.wo_no}`,
      message: `${category}: ${wasteQty} units recorded as abnormal`,
      refType: 'work_orders',
      refId: input.workOrderId,
    });
  }
  return { id, wasteNo: `WST-${id}`, isAbnormal };
}

// ---------------------------------------------------------------------------
// 22. Downtime management
// ---------------------------------------------------------------------------
export async function recordDowntimeMes(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    machineId: number;
    workOrderId?: number | null;
    productionBatchId?: number | null;
    category: string;
    reason?: string | null;
    startedAt?: string | null;
    endedAt?: string | null;
    durationMin?: number | null;
  }
) {
  const machine = await getMachine(client, ctx, input.machineId);
  const category = String(input.category).toUpperCase();
  const valid = ['MECHANICAL', 'ELECTRICAL', 'MATERIAL_SHORTAGE', 'QUALITY_ISSUE', 'SETUP', 'CHANGEOVER', 'CLEANING', 'OPERATOR', 'UTILITY_FAILURE', 'MAINTENANCE', 'OTHER'];
  if (!valid.includes(category)) throw badRequest(`Invalid downtime category: ${category}`);

  const startedAt = input.startedAt ?? new Date().toISOString();
  let durationMin = input.durationMin ?? 0;
  if (input.endedAt) {
    durationMin = Math.max(0, Math.round((new Date(input.endedAt).getTime() - new Date(startedAt).getTime()) / 60000));
  }

  const ins = await client.query(
    `INSERT INTO downtime_events
       (company_id, tenant_id, branch_id, work_order_id, production_batch_id, machine_id,
        operator_id, category, reason, started_at, ended_at, duration_min, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      ctx.companyId ?? null,
      ctx.tenantId ?? null,
      ctx.branchId ?? null,
      input.workOrderId ?? null,
      input.productionBatchId ?? null,
      input.machineId,
      ctx.userId ?? null,
      category,
      input.reason ?? null,
      startedAt,
      input.endedAt ?? null,
      durationMin,
      ctx.userId ?? null,
    ]
  );
  const id = num(ins.rows[0].id);

  await client.query(
    `UPDATE machines SET downtime_hours = downtime_hours + $1 WHERE id = $2`,
    [durationMin / 60, input.machineId]
  );
  if (input.workOrderId) {
    await client.query(
      `INSERT INTO production_downtime
         (work_order_id, machine_id, downtime_type, reason, started_at, ended_at, minutes, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.workOrderId,
        input.machineId,
        category === 'QUALITY_ISSUE' ? 'QUALITY' : category === 'MATERIAL_SHORTAGE' ? 'MATERIAL_SHORTAGE' : category === 'MAINTENANCE' ? 'CORRECTIVE_MAINTENANCE' : category === 'SETUP' ? 'SETUP' : category === 'OPERATOR' ? 'OPERATOR' : category === 'UTILITY_FAILURE' ? 'POWER' : 'OTHER',
        input.reason ?? null,
        startedAt,
        input.endedAt ?? null,
        Math.round(durationMin),
        ctx.userId ?? null,
      ]
    );
  }
  await client.query(
    `INSERT INTO machine_logs
       (company_id, tenant_id, machine_id, work_order_id, event_type, status_from, status_to, reason, operator_id, occurred_at, payload)
     VALUES ($1,$2,$3,$4,'BREAKDOWN',$5,'BREAKDOWN',$6,$7,now(),$8)`,
    [
      ctx.companyId ?? null,
      ctx.tenantId ?? null,
      input.machineId,
      input.workOrderId ?? null,
      String(machine.machine_state),
      input.reason ?? null,
      ctx.userId ?? null,
      JSON.stringify({ category, durationMin }),
    ]
  );

  await mesEvent(client, ctx, {
    eventType: 'production.downtime.recorded',
    entityType: 'machines',
    entityId: input.machineId,
    entityCode: String(machine.code),
    payload: { downtimeId: id, category, durationMin, workOrderId: input.workOrderId ?? null },
    severity: category === 'MECHANICAL' || category === 'ELECTRICAL' ? 'WARN' : 'INFO',
  });
  return { id, downtimeNo: `DT-${id}`, category, durationMin };
}

// ---------------------------------------------------------------------------
// 29. Production costing
// ---------------------------------------------------------------------------
export async function productionCosting(client: pg.PoolClient, ctx: Ctx, workOrderId?: number) {
  const where = workOrderId ? `AND pc.work_order_id = $2` : '';
  const params: unknown[] = [ctx.tenantId];
  if (workOrderId) params.push(workOrderId);
  const rows = await client.query(
    `SELECT pc.*, wo.wo_no, p.code AS product_code, p.name AS product_name, wo.quantity, wo.produced_qty
     FROM production_costs pc
     JOIN work_orders wo ON wo.id = pc.work_order_id
     JOIN products p ON p.id = wo.product_id
     WHERE wo.tenant_id = $1 ${where}
     ORDER BY pc.id DESC LIMIT 200`,
    params
  );
  return toCamelRows(rows.rows);
}

// Costing desk: standard vs actual cost across every work order, cost mix
// components and per-unit economics driven by the packaging hierarchy.
export async function costingDesk(client: pg.PoolClient, ctx: Ctx) {
  const rows = await client.query(
    `SELECT wo.id, wo.wo_no, wo.status, wo.priority, wo.quantity, wo.produced_qty, wo.scrapped_qty,
            wo.rework_qty, wo.waste_qty, wo.standard_cost, wo.actual_material_cost, wo.actual_labour_cost,
            wo.actual_machine_cost, wo.actual_overhead_cost, wo.actual_waste_cost, wo.actual_other_cost,
            wo.actual_cost, wo.cost_variance, wo.yield_percent, wo.efficiency_percent,
            wo.start_date, wo.due_date, wo.started_at, wo.completed_at,
            p.id AS product_id, p.code AS product_code, p.name AS product_name,
            m.code AS machine_code, m.name AS machine_name,
            u.code AS unit_code, u.name AS unit_name
     FROM work_orders wo
     JOIN products p ON p.id = wo.product_id
     LEFT JOIN machines m ON m.id = wo.machine_id
     LEFT JOIN units u ON u.id = wo.unit_id
     WHERE wo.tenant_id = $1 AND wo.status <> 'DRAFT'
     ORDER BY wo.id DESC LIMIT 400`,
    [ctx.tenantId]
  );
  const sum = await client.query(
    `SELECT COUNT(*)::int AS orders,
            COUNT(*) FILTER (WHERE wo.status IN ('COMPLETED','CLOSED'))::int AS completed,
            COUNT(*) FILTER (WHERE wo.status NOT IN ('COMPLETED','CLOSED','DRAFT'))::int AS open,
            COUNT(*) FILTER (WHERE wo.actual_cost < wo.standard_cost)::int AS favourable,
            COUNT(*) FILTER (WHERE wo.actual_cost > wo.standard_cost)::int AS adverse,
            COALESCE(SUM(wo.standard_cost),0)::numeric AS total_standard,
            COALESCE(SUM(wo.actual_cost),0)::numeric AS total_actual,
            COALESCE(SUM(wo.cost_variance),0)::numeric AS total_variance,
            COALESCE(SUM(wo.actual_material_cost),0)::numeric AS total_material,
            COALESCE(SUM(wo.actual_labour_cost),0)::numeric AS total_labour,
            COALESCE(SUM(wo.actual_machine_cost),0)::numeric AS total_machine,
            COALESCE(SUM(wo.actual_overhead_cost),0)::numeric AS total_overhead,
            COALESCE(SUM(wo.actual_waste_cost),0)::numeric AS total_waste
     FROM work_orders wo WHERE wo.tenant_id = $1 AND wo.status <> 'DRAFT'`,
    [ctx.tenantId]
  );
  const posted = await client.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(pc.actual_cost),0)::numeric AS value
     FROM production_costs pc WHERE pc.tenant_id = $1 AND pc.status = 'POSTED'`,
    [ctx.tenantId]
  );
  const hier = await client.query(
    `SELECT product_id, level_code, qty_per_parent, weight_kg
     FROM packaging_hierarchies WHERE tenant_id = $1 AND is_active = true
     ORDER BY product_id, sort_order`,
    [ctx.tenantId]
  );
  const pkgByProduct = new Map<number, { sheetsPerReam: number; reamKg: number; reamsPerCarton: number; cartonsPerPallet: number; cartonKg: number; palletKg: number }>();
  for (const h of hier.rows) {
    const pid = Number(h.product_id);
    const level = String(h.level_code ?? '').toUpperCase();
    const m = pkgByProduct.get(pid) ?? { sheetsPerReam: 0, reamKg: 0, reamsPerCarton: 0, cartonsPerPallet: 0, cartonKg: 0, palletKg: 0 };
    if (level === 'REAM') {
      m.sheetsPerReam = Number(h.qty_per_parent);
      m.reamKg = Number(h.weight_kg);
    } else if (level === 'CARTON') {
      m.reamsPerCarton = Number(h.qty_per_parent);
      m.cartonKg = Number(h.weight_kg);
    } else if (level === 'PALLET') {
      m.cartonsPerPallet = Number(h.qty_per_parent);
      m.palletKg = Number(h.weight_kg);
    }
    pkgByProduct.set(pid, m);
  }
  const s = sum.rows[0];
  const p = posted.rows[0];
  return {
    summary: {
      orders: Number(s.orders),
      completed: Number(s.completed),
      open: Number(s.open),
      favourable: Number(s.favourable),
      adverse: Number(s.adverse),
      posted: Number(p.count),
      postedValue: round2(Number(p.value)),
      totalStandard: round2(Number(s.total_standard)),
      totalActual: round2(Number(s.total_actual)),
      totalVariance: round2(Number(s.total_variance)),
      variancePct: round2(pct(Number(s.total_variance), Number(s.total_standard))),
      totalMaterial: round2(Number(s.total_material)),
      totalLabour: round2(Number(s.total_labour)),
      totalMachine: round2(Number(s.total_machine)),
      totalOverhead: round2(Number(s.total_overhead)),
      totalWaste: round2(Number(s.total_waste)),
    },
    rows: rows.rows.map((r) => {
      const pkg = pkgByProduct.get(Number(r.product_id)) ?? null;
      const complete = !!pkg && pkg.reamKg > 0 && pkg.reamsPerCarton > 0 && pkg.cartonsPerPallet > 0;
      return toCamelRow({ ...r, pkg: complete ? pkg : null });
    }),
  };
}

export async function workOrderCosting(client: pg.PoolClient, ctx: Ctx, workOrderId: number) {
  const wo = await getWorkOrder(client, ctx, workOrderId);
  const costs = await client.query(
    `SELECT pcc.component_type AS component, COALESCE(SUM(pcc.amount),0)::numeric AS amount
     FROM production_cost_components pcc
     JOIN production_costs pc ON pc.id = pcc.production_cost_id
     WHERE pc.work_order_id = $1 GROUP BY pcc.component_type`,
    [workOrderId]
  );
  const standardCost = num(wo.standard_cost);
  const actualTotal = costs.rows.reduce((s, r) => s + num(r.amount), 0);
  const produced = num(wo.produced_qty) || 1;
  return {
    workOrderId,
    woNo: String(wo.wo_no),
    standardCost,
    actualCost: round2(actualTotal),
    variance: round2(actualTotal - standardCost),
    costPerUnitStandard: round2(standardCost / produced),
    costPerUnitActual: round2(actualTotal / produced),
    components: costs.rows.map((r) => ({ component: String(r.component), amount: num(r.amount) })),
  };
}

// ---------------------------------------------------------------------------
// 45. Manufacturing documents
// ---------------------------------------------------------------------------
const DOC_TYPES = [
  'PRODUCTION_ORDER', 'MATERIAL_REQUISITION', 'MATERIAL_ISSUE_NOTE', 'JOB_CARD', 'ROUTE_SHEET',
  'WORK_ORDER', 'PRODUCTION_REPORT', 'SHIFT_REPORT', 'MACHINE_LOG', 'DOWNTIME_REPORT',
  'WASTE_REPORT', 'SCRAP_REPORT', 'QUALITY_INSPECTION', 'REWORK_ORDER',
  'PRODUCTION_COMPLETION_NOTE', 'FINISHED_GOODS_RECEIPT', 'SHIFT_HANDOVER',
  'MAINTENANCE_REQUEST', 'BATCH_RECORD',
];

export async function generateProductionDocuments(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { workOrderId: number; docTypes: string[] }
) {
  const wo = await getWorkOrder(client, ctx, input.workOrderId);
  const docTypes = input.docTypes.filter((t) => DOC_TYPES.includes(String(t).toUpperCase()));
  if (docTypes.length === 0) throw badRequest('No valid document types supplied');
  const created: Array<Record<string, unknown>> = [];
  for (const dt of docTypes) {
    const docNo = await nextDoc(client, ctx, 'DOC');
    const ins = await client.query(
      `INSERT INTO production_documents
         (company_id, tenant_id, branch_id, doc_type, doc_no, work_order_id, content, status, generated_by, generated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'GENERATED',$8,now())
       RETURNING id, doc_no`,
      [
        ctx.companyId ?? null,
        ctx.tenantId ?? null,
        ctx.branchId ?? null,
        String(dt).toUpperCase(),
        docNo,
        input.workOrderId,
        JSON.stringify({ woNo: String(wo.wo_no), productId: num(wo.product_id), quantity: num(wo.quantity), producedQty: num(wo.produced_qty) }),
        ctx.userId ?? null,
      ]
    );
    created.push({ id: num(ins.rows[0].id), docNo: String(ins.rows[0].doc_no), docType: String(dt).toUpperCase() });
  }
  await mesEvent(client, ctx, {
    eventType: 'production.documents.generated',
    entityType: 'work_orders',
    entityId: input.workOrderId,
    entityCode: String(wo.wo_no),
    payload: { documents: created.map((d) => d.docNo) },
  });
  return { workOrderId: input.workOrderId, documents: created };
}

export async function listProductionDocuments(client: pg.PoolClient, ctx: Ctx, workOrderId?: number) {
  const where = workOrderId ? `AND work_order_id = $2` : '';
  const params: unknown[] = [ctx.tenantId];
  if (workOrderId) params.push(workOrderId);
  const res = await client.query(
    `SELECT d.*, wo.wo_no FROM production_documents d
     LEFT JOIN work_orders wo ON wo.id = d.work_order_id
     WHERE d.tenant_id = $1 ${where}
     ORDER BY d.id DESC LIMIT 200`,
    params
  );
  return toCamelRows(res.rows);
}

// ---------------------------------------------------------------------------
// 38. Production alerts
// ---------------------------------------------------------------------------
export async function listProductionAlerts(client: pg.PoolClient, ctx: Ctx, openOnly = true) {
  const res = await client.query(
    `SELECT * FROM production_alerts
     WHERE tenant_id = $1 ${openOnly ? `AND status <> 'RESOLVED'` : ''}
     ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, id DESC
     LIMIT 100`,
    [ctx.tenantId]
  );
  return toCamelRows(res.rows);
}

export async function ackProductionAlert(client: pg.PoolClient, ctx: Ctx, alertId: number) {
  const res = await client.query(
    `UPDATE production_alerts SET status = 'ACKNOWLEDGED', acknowledged_by = $1, acknowledged_at = now()
     WHERE id = $2 AND tenant_id = $3 AND status = 'OPEN' RETURNING id`,
    [ctx.userId ?? null, alertId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Alert not found or already acknowledged');
  return { id: alertId, status: 'ACKNOWLEDGED' };
}

export async function resolveProductionAlert(client: pg.PoolClient, ctx: Ctx, alertId: number) {
  const res = await client.query(
    `UPDATE production_alerts SET status = 'RESOLVED', resolved_by = $1, resolved_at = now()
     WHERE id = $2 AND tenant_id = $3 RETURNING id`,
    [ctx.userId ?? null, alertId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw badRequest('Alert not found');
  return { id: alertId, status: 'RESOLVED' };
}// ---------------------------------------------------------------------------
// 33. Subcontracting
// ---------------------------------------------------------------------------
export async function createSubcontract(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    workOrderId: number;
    operationId?: number | null;
    supplierId: number;
    productId: number;
    quantity: number;
    vendorCost?: number | null;
    notes?: string | null;
  }
) {
  const wo = await getWorkOrder(client, ctx, input.workOrderId);
  const subconNo = await nextDoc(client, ctx, 'SUB');
  const ins = await client.query(
    `INSERT INTO subcontract_orders
       (company_id, tenant_id, branch_id, subcon_no, work_order_id, operation_id, supplier_id,
        product_id, quantity, status, vendor_cost, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DRAFT',$10,$11)
     RETURNING id`,
    [
      ctx.companyId ?? null,
      ctx.tenantId ?? null,
      ctx.branchId ?? null,
      subconNo,
      input.workOrderId,
      input.operationId ?? null,
      input.supplierId,
      input.productId,
      input.quantity,
      input.vendorCost ?? 0,
      input.notes ?? null,
    ]
  );
  const id = num(ins.rows[0].id);
  await mesEvent(client, ctx, {
    eventType: 'production.subcontract.created',
    entityType: 'subcontract_orders',
    entityId: id,
    entityCode: subconNo,
    payload: { workOrderId: input.workOrderId, supplierId: input.supplierId, quantity: input.quantity },
  });
  return { id, subconNo, status: 'DRAFT' };
}

export async function updateSubcontractStatus(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { subconId: number; status: string; quantity?: number | null; notes?: string | null }
) {
  const status = String(input.status).toUpperCase();
  const valid = ['APPROVED', 'MATERIALS_ISSUED', 'IN_TRANSIT', 'AT_VENDOR', 'RECEIVED', 'QUALITY_INSPECTION', 'COMPLETED', 'CANCELLED'];
  if (!valid.includes(status)) throw badRequest(`Invalid subcontract status: ${status}`);
  const res = await client.query(
    `UPDATE subcontract_orders
     SET status = $1,
         material_issued_qty = CASE WHEN $1 = 'MATERIALS_ISSUED' THEN material_issued_qty + $2 ELSE material_issued_qty END,
         issued_at = CASE WHEN $1 = 'MATERIALS_ISSUED' AND issued_at IS NULL THEN now() ELSE issued_at END,
         received_at = CASE WHEN $1 = 'RECEIVED' THEN now() ELSE received_at END,
         notes = COALESCE($3, notes),
         updated_at = now()
     WHERE id = $4 AND tenant_id = $5 RETURNING subcon_no, work_order_id`,
    [status, input.quantity ?? 0, input.notes ?? null, input.subconId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Subcontract order not found');
  await mesEvent(client, ctx, {
    eventType: 'production.subcontract.updated',
    entityType: 'subcontract_orders',
    entityId: input.subconId,
    entityCode: String(res.rows[0].subcon_no),
    payload: { status, quantity: input.quantity ?? null },
  });
  return { id: input.subconId, status };
}

// ---------------------------------------------------------------------------
// 32. Rework
// ---------------------------------------------------------------------------
export async function createRework(
  client: pg.PoolClient,
  ctx: Ctx,
  input: {
    sourceWorkOrderId: number;
    productionBatchId?: number | null;
    productId: number;
    quantity: number;
    materialRequired?: Record<string, unknown>;
    reworkCost?: number | null;
    notes?: string | null;
  }
) {
  const reworkNo = await nextDoc(client, ctx, 'RWK');
  const ins = await client.query(
    `INSERT INTO rework_orders
       (company_id, tenant_id, branch_id, rework_no, source_work_order_id, production_batch_id,
        product_id, quantity, status, material_required, rework_cost, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9,$10,$11)
     RETURNING id`,
    [
      ctx.companyId ?? null,
      ctx.tenantId ?? null,
      ctx.branchId ?? null,
      reworkNo,
      input.sourceWorkOrderId,
      input.productionBatchId ?? null,
      input.productId,
      input.quantity,
      JSON.stringify(input.materialRequired ?? {}),
      input.reworkCost ?? 0,
      input.notes ?? null,
    ]
  );
  const id = num(ins.rows[0].id);
  await mesEvent(client, ctx, {
    eventType: 'production.rework.created',
    entityType: 'rework_orders',
    entityId: id,
    entityCode: reworkNo,
    payload: { sourceWorkOrderId: input.sourceWorkOrderId, quantity: input.quantity },
  });
  return { id, reworkNo, status: 'DRAFT' };
}

export async function updateReworkStatus(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { reworkId: number; status: string; reworkCost?: number | null; notes?: string | null }
) {
  const status = String(input.status).toUpperCase();
  const valid = ['APPROVED', 'RELEASED', 'IN_PROGRESS', 'QUALITY_INSPECTION', 'COMPLETED', 'REJECTED', 'CANCELLED'];
  if (!valid.includes(status)) throw badRequest(`Invalid rework status: ${status}`);
  const res = await client.query(
    `UPDATE rework_orders
     SET status = $1,
         rework_cost = CASE WHEN $2 IS NOT NULL THEN $2 ELSE rework_cost END,
         notes = COALESCE($3, notes),
         updated_at = now()
     WHERE id = $4 AND tenant_id = $5 RETURNING rework_no`,
    [status, input.reworkCost ?? null, input.notes ?? null, input.reworkId, ctx.tenantId]
  );
  if (res.rows.length === 0) throw notFound('Rework order not found');
  await mesEvent(client, ctx, {
    eventType: 'production.rework.updated',
    entityType: 'rework_orders',
    entityId: input.reworkId,
    entityCode: String(res.rows[0].rework_no),
    payload: { status },
  });
  return { id: input.reworkId, status };
}

// ---------------------------------------------------------------------------
// 51. AI manufacturing assistant (deterministic, read-only insights)
// ---------------------------------------------------------------------------
export async function aiAssistant(client: pg.PoolClient, ctx: Ctx, question?: string | null) {
  const q = String(question ?? '').toLowerCase();

  // Behind schedule: orders past due or behind completion
  const behind = await client.query(
    `SELECT v.wo_no, v.product_name, v.quantity, v.produced_qty, v.completion_pct, v.due_date,
            v.machine_code, v.status
     FROM v_production_progress v
     JOIN work_orders wo ON wo.id = v.work_order_id
     WHERE wo.tenant_id = $1
       AND v.status NOT IN ('COMPLETED','CLOSED','CANCELLED','REJECTED')
       AND (v.due_date < CURRENT_DATE OR v.completion_pct < 100)
     ORDER BY v.due_date NULLS LAST LIMIT 10`,
    [ctx.tenantId]
  );

  // Worst machines by downtime
  const worstDowntime = await client.query(
    `SELECT m.code AS machine_code, m.name AS machine_name,
            COUNT(de.id)::int AS downtime_events,
            COALESCE(SUM(de.duration_min),0)::numeric AS downtime_minutes
     FROM downtime_events de JOIN machines m ON m.id = de.machine_id
     WHERE de.tenant_id = $1 AND de.started_at >= CURRENT_DATE - INTERVAL '30 days'
     GROUP BY m.code, m.name ORDER BY downtime_minutes DESC LIMIT 5`,
    [ctx.tenantId]
  );

  // Highest waste by product
  const highWaste = await client.query(
    `SELECT p.code AS product_code, p.name AS product_name,
            COALESCE(SUM(wo.waste_qty + wo.scrapped_qty),0)::numeric AS waste_total,
            COALESCE(SUM(wo.produced_qty),0)::numeric AS produced_total
     FROM work_orders wo JOIN products p ON p.id = wo.product_id
     WHERE wo.tenant_id = $1
     GROUP BY p.code, p.name
     HAVING COALESCE(SUM(wo.produced_qty),0) > 0
     ORDER BY (COALESCE(SUM(wo.waste_qty + wo.scrapped_qty),0) * 100.0 / COALESCE(SUM(wo.produced_qty),0)) DESC
     LIMIT 5`,
    [ctx.tenantId]
  );

  // At-risk orders (due within 3 days, low completion, or delayed)
  const atRisk = await client.query(
    `SELECT v.wo_no, v.product_name, v.quantity, v.produced_qty, v.completion_pct, v.due_date, v.machine_code
     FROM v_production_progress v
     JOIN work_orders wo ON wo.id = v.work_order_id
     WHERE wo.tenant_id = $1
       AND v.status NOT IN ('COMPLETED','CLOSED','CANCELLED','REJECTED')
       AND (v.due_date < CURRENT_DATE + 3 OR v.completion_pct < 50)
     ORDER BY v.due_date NULLS LAST LIMIT 10`,
    [ctx.tenantId]
  );

  // Cost per ream (from production costs)
  const cost = await client.query(
    `SELECT pc.work_order_id, wo.wo_no, p.code AS product_code,
            COALESCE(SUM(pcc.amount),0)::numeric AS actual_cost,
            wo.produced_qty,
            COALESCE(SUM(pcc.amount),0) / NULLIF(wo.produced_qty,0)::numeric AS cost_per_unit
     FROM production_costs pc
     JOIN work_orders wo ON wo.id = pc.work_order_id
     JOIN products p ON p.id = wo.product_id
     LEFT JOIN production_cost_components pcc ON pcc.production_cost_id = pc.id
     WHERE wo.tenant_id = $1
     GROUP BY pc.work_order_id, wo.wo_no, p.code, wo.produced_qty
     ORDER BY pc.work_order_id DESC LIMIT 10`,
    [ctx.tenantId]
  );

  // Maintenance priority (downtime + hours run)
  const maint = await client.query(
    `SELECT m.code AS machine_code, m.machine_state, m.production_hours,
            m.downtime_hours, m.maintenance_status,
            COALESCE(SUM(de.duration_min),0)::numeric AS downtime_30d
     FROM machines m
     LEFT JOIN downtime_events de ON de.machine_id = m.id AND de.tenant_id = $1
       AND de.started_at >= CURRENT_DATE - INTERVAL '30 days'
     WHERE m.tenant_id = $1
     GROUP BY m.code, m.machine_state, m.production_hours, m.downtime_hours, m.maintenance_status
     ORDER BY downtime_30d DESC, m.production_hours DESC LIMIT 10`,
    [ctx.tenantId]
  );

  // Shortage materials
  const shortages = await client.query(
    `WITH req AS (
       SELECT wom.product_id, SUM(wom.required_qty - wom.issued_qty)::numeric AS need
       FROM work_order_materials wom JOIN work_orders wo ON wo.id = wom.work_order_id
       WHERE wo.tenant_id = $1 AND wo.status NOT IN ('CANCELLED','REJECTED','CLOSED','COMPLETED')
       GROUP BY wom.product_id
     ),
     free AS (
       SELECT product_id, SUM(quantity - reserved_qty)::numeric AS qty
       FROM inventory WHERE tenant_id = $1 GROUP BY product_id
     )
     SELECT p.code AS product_code, p.name AS product_name, r.need, COALESCE(f.qty,0) AS available,
            GREATEST(0, r.need - COALESCE(f.qty,0)) AS shortage
     FROM req r JOIN products p ON p.id = r.product_id
     LEFT JOIN free f ON f.product_id = r.product_id
     WHERE COALESCE(f.qty,0) < r.need ORDER BY shortage DESC LIMIT 10`,
    [ctx.tenantId]
  );

  const answer: Array<{ question: string; insight: string; data: Array<Record<string, unknown>> }> = [];

  if (!q || q.includes('behind') || q.includes('delay') || q.includes('schedule')) {
    answer.push({
      question: 'Why is production behind schedule?',
      insight: `${behind.rows.length} order(s) are behind. Each is below 100% completion or past its due date; review machine availability and material issues shown.`,
      data: toCamelRows(behind.rows),
    });
  }
  if (!q || q.includes('downtime') || q.includes('machine')) {
    answer.push({
      question: 'Which machines are causing the most downtime?',
      insight: worstDowntime.rows.length
        ? `Highest downtime: ${String(worstDowntime.rows[0].machine_code)} (${num(worstDowntime.rows[0].downtime_minutes)} min over 30 days).`
        : 'No downtime events recorded in the last 30 days.',
      data: toCamelRows(worstDowntime.rows),
    });
  }
  if (!q || q.includes('waste') || q.includes('scrap')) {
    answer.push({
      question: 'Which product has the highest waste?',
      insight: highWaste.rows.length
        ? `Highest waste: ${String(highWaste.rows[0].product_code)} (${num(highWaste.rows[0].waste_total)} units waste).`
        : 'No waste data yet.',
      data: toCamelRows(highWaste.rows),
    });
  }
  if (!q || q.includes('shortage') || q.includes('material')) {
    answer.push({
      question: 'Which materials will cause production shortages?',
      insight: shortages.rows.length
        ? `${shortages.rows.length} material(s) short. Largest shortage: ${String(shortages.rows[0].product_code)} (${num(shortages.rows[0].shortage)} units).`
        : 'No material shortages detected.',
      data: toCamelRows(shortages.rows),
    });
  }
  if (!q || q.includes('oee')) {
    const oeeRows = await machineOee(client, ctx);
    const oeeData = Array.isArray(oeeRows) ? oeeRows : oeeRows ? [oeeRows] : [];
    answer.push({
      question: 'What is causing the OEE decline?',
      insight: 'Drill into per-machine OEE factors (availability, performance, quality) and downtime categories via the OEE endpoint.',
      data: oeeData,
    });
  }
  if (!q || q.includes('risk') || q.includes('late') || q.includes('delivery')) {
    answer.push({
      question: 'Which production orders are at risk of late delivery?',
      insight: `${atRisk.rows.length} order(s) at risk (due within 3 days or below 50% completion).`,
      data: toCamelRows(atRisk.rows),
    });
  }
  if (!q || q.includes('cost') || q.includes('ream')) {
    answer.push({
      question: 'What is our actual cost per ream?',
      insight: cost.rows.length
        ? `Latest order ${String(cost.rows[0].wo_no)}: UGX ${num(cost.rows[0].cost_per_unit).toFixed(2)} per unit.`
        : 'No production cost posted yet.',
      data: toCamelRows(cost.rows),
    });
  }
  if (!q || q.includes('maintenance')) {
    answer.push({
      question: 'Which machines should be prioritized for maintenance?',
      insight: maint.rows.length
        ? `Priority: ${String(maint.rows[0].machine_code)} with ${num(maint.rows[0].downtime_30d)} min downtime in 30 days.`
        : 'No maintenance data yet.',
      data: toCamelRows(maint.rows),
    });
  }

  return {
    question: question ?? null,
    generatedAt: new Date().toISOString(),
    note: 'AI insights are deterministic aggregations over live production data. They never execute transactions; a supervisor must authorize any follow-up action.',
    answers: answer,
  };
}

// ---------------------------------------------------------------------------
// 39. Production analytics
// ---------------------------------------------------------------------------
export async function productionAnalytics(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { from?: string | null; to?: string | null; groupBy?: string | null } = {}
) {
  const from = input.from ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const to = input.to ?? new Date().toISOString().slice(0, 10);
  const groupBy = String(input.groupBy ?? 'day');

  const planActual = await client.query(
    `SELECT ${groupBy === 'day' ? 'wo.start_date::date AS period' : "'ALL' AS period"},
            COUNT(*)::int AS orders,
            COALESCE(SUM(wo.quantity),0)::numeric AS planned_qty,
            COALESCE(SUM(wo.produced_qty),0)::numeric AS produced_qty,
            COALESCE(SUM(wo.scrapped_qty),0)::numeric AS scrapped_qty,
            COALESCE(SUM(wo.waste_qty),0)::numeric AS waste_qty,
            COALESCE(SUM(wo.rework_qty),0)::numeric AS rework_qty
     FROM work_orders wo
     WHERE wo.tenant_id = $1
       AND wo.status NOT IN ('DRAFT','CANCELLED','REJECTED')
       AND (wo.start_date IS NULL OR wo.start_date::date BETWEEN $2 AND $3)
     GROUP BY ${groupBy === 'day' ? 'wo.start_date::date' : '1'}`,
    [ctx.tenantId, from, to]
  );

  const byMachine = await client.query(
    `SELECT m.code AS machine_code, COUNT(wo.id)::int AS orders,
            COALESCE(SUM(wo.produced_qty),0)::numeric AS produced_qty,
            COALESCE(SUM(wo.waste_qty + wo.scrapped_qty),0)::numeric AS waste_qty,
            COALESCE(SUM(de.duration_min),0)::numeric AS downtime_minutes
     FROM work_orders wo
     LEFT JOIN machines m ON m.id = wo.machine_id
     LEFT JOIN downtime_events de ON de.machine_id = wo.machine_id AND de.tenant_id = $1
     WHERE wo.tenant_id = $1 AND wo.status NOT IN ('DRAFT','CANCELLED','REJECTED')
     GROUP BY m.code ORDER BY produced_qty DESC`,
    [ctx.tenantId]
  );

  const byShift = await client.query(
    `SELECT CASE
              WHEN EXTRACT(HOUR FROM po.recorded_at) >= 6 AND EXTRACT(HOUR FROM po.recorded_at) < 14 THEN 'A (06-14)'
              WHEN EXTRACT(HOUR FROM po.recorded_at) >= 14 AND EXTRACT(HOUR FROM po.recorded_at) < 22 THEN 'B (14-22)'
              ELSE 'C (22-06)' END AS shift_code,
            COUNT(*)::int AS events, COALESCE(SUM(po.quantity),0)::numeric AS quantity
     FROM production_outputs po
     JOIN work_orders wo ON wo.id = po.work_order_id
     WHERE wo.tenant_id = $1
     GROUP BY 1 ORDER BY quantity DESC`,
    [ctx.tenantId]
  );

  const byOperator = await client.query(
    `SELECT po.recorded_by,
            (COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS operator_name,
            COUNT(*)::int AS postings,
            COALESCE(SUM(po.quantity),0)::numeric AS quantity
     FROM production_outputs po
     JOIN work_orders wo ON wo.id = po.work_order_id
     LEFT JOIN users u ON u.id = po.recorded_by
     WHERE wo.tenant_id = $1
     GROUP BY po.recorded_by, u.first_name, u.last_name ORDER BY quantity DESC LIMIT 20`,
    [ctx.tenantId]
  );

  const byProduct = await client.query(
    `SELECT p.code AS product_code, p.name AS product_name, COUNT(wo.id)::int AS orders,
            COALESCE(SUM(wo.quantity),0)::numeric AS planned_qty,
            COALESCE(SUM(wo.produced_qty),0)::numeric AS produced_qty,
            COALESCE(SUM(wo.waste_qty + wo.scrapped_qty),0)::numeric AS waste_qty
     FROM work_orders wo JOIN products p ON p.id = wo.product_id
     WHERE wo.tenant_id = $1 AND wo.status NOT IN ('DRAFT','CANCELLED','REJECTED')
     GROUP BY p.code, p.name ORDER BY produced_qty DESC`,
    [ctx.tenantId]
  );

  return {
    period: { from, to, groupBy },
    planVsActual: toCamelRows(planActual.rows),
    byMachine: toCamelRows(byMachine.rows),
    byShift: toCamelRows(byShift.rows),
    byOperator: toCamelRows(byOperator.rows),
    byProduct: toCamelRows(byProduct.rows),
    oee: await machineOee(client, ctx),
  };
}

// ---------------------------------------------------------------------------
// 40. Management KPIs
// ---------------------------------------------------------------------------
export async function managementKpis(client: pg.PoolClient, ctx: Ctx) {
  const wo = await client.query(
    `SELECT COUNT(*)::int AS orders,
            COALESCE(SUM(quantity),0)::numeric AS planned_qty,
            COALESCE(SUM(produced_qty),0)::numeric AS produced_qty,
            COALESCE(SUM(scrapped_qty),0)::numeric AS scrapped_qty,
            COALESCE(SUM(waste_qty),0)::numeric AS waste_qty,
            COALESCE(SUM(rework_qty),0)::numeric AS rework_qty,
            COALESCE(SUM(actual_material_cost + actual_labour_cost + actual_machine_cost + actual_overhead_cost + actual_waste_cost + actual_other_cost),0)::numeric AS actual_cost,
            COUNT(*) FILTER (WHERE status IN ('COMPLETED','CLOSED'))::int AS completed,
            COUNT(*) FILTER (WHERE status = 'ON_HOLD')::int AS on_hold,
            COUNT(*) FILTER (WHERE due_date < CURRENT_DATE AND status NOT IN ('COMPLETED','CLOSED','CANCELLED','REJECTED'))::int AS late
     FROM work_orders WHERE tenant_id = $1 AND status NOT IN ('DRAFT','CANCELLED','REJECTED')`,
    [ctx.tenantId]
  );
  const r = wo.rows[0];
  const planned = num(r.planned_qty);
  const produced = num(r.produced_qty);
  const waste = num(r.waste_qty) + num(r.scrapped_qty);

  const q = await client.query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE ir.passed)::int AS passed
     FROM inspection_results ir JOIN inspections i ON i.id = ir.inspection_id
     WHERE i.tenant_id = $1 AND ir.passed IS NOT NULL`,
    [ctx.tenantId]
  );
  const qTotal = num(q.rows[0].total);
  const qualityRejection = qTotal > 0 ? round2((1 - num(q.rows[0].passed) / qTotal) * 100) : 0;

  const oee = await client.query(
    `SELECT COALESCE(AVG(oee_pct),0)::numeric AS oee FROM v_machine_oee
     WHERE machine_id IN (SELECT id FROM machines WHERE tenant_id = $1)`,
    [ctx.tenantId]
  );

  const variance = await client.query(
    `SELECT COALESCE(SUM(variance),0)::numeric AS total_variance FROM production_variances
     WHERE tenant_id = $1`,
    [ctx.tenantId]
  );

  const matUsage = await client.query(
    `SELECT COALESCE(SUM(required_qty - issued_qty),0)::numeric AS diff, COALESCE(SUM(required_qty),0)::numeric AS required
     FROM work_order_materials wom JOIN work_orders wo ON wo.id = wom.work_order_id
     WHERE wo.tenant_id = $1 AND wo.status NOT IN ('DRAFT','CANCELLED','REJECTED')`,
    [ctx.tenantId]
  );

  const util = await client.query(
    `SELECT COALESCE(AVG(utilization_pct),0)::numeric AS utilization FROM machine_capacity mc
     WHERE mc.tenant_id = $1 AND capacity_date = CURRENT_DATE`,
    [ctx.tenantId]
  );

  const reworkOrders = await client.query(
    `SELECT COUNT(*)::int AS count FROM rework_orders WHERE tenant_id = $1`,
    [ctx.tenantId]
  );

  return {
    productionAchievementPct: pct(produced, planned),
    oee: round2(num(oee.rows[0].oee)),
    yieldPct: produced + waste > 0 ? round2((produced / (produced + waste)) * 100) : 100,
    firstPassYieldPct: produced > 0 ? round2(((produced - num(r.scrapped_qty) - num(r.rework_qty)) / produced) * 100) : 100,
    scrapPct: produced > 0 ? round2((num(r.scrapped_qty) / produced) * 100) : 0,
    wastePct: produced + waste > 0 ? round2((waste / (produced + waste)) * 100) : 0,
    downtimePct: 0,
    machineUtilizationPct: round2(num(util.rows[0].utilization)),
    scheduleAdherencePct: num(r.orders) > 0 ? round2((num(r.completed) / num(r.orders)) * 100) : 100,
    productionCostVariance: round2(num(variance.rows[0].total_variance)),
    materialUsageVariancePct: num(matUsage.rows[0].required) > 0 ? round2((num(matUsage.rows[0].diff) / num(matUsage.rows[0].required)) * 100) : 0,
    onTimeProductionPct: num(r.orders) > 0 ? round2(((num(r.orders) - num(r.late)) / num(r.orders)) * 100) : 100,
    reworkPct: produced > 0 ? round2((num(r.rework_qty) / produced) * 100) : 0,
    qualityRejectionPct: qualityRejection,
    summary: {
      orders: num(r.orders),
      plannedQty: planned,
      producedQty: produced,
      wasteQty: waste,
      completedOrders: num(r.completed),
      onHoldOrders: num(r.on_hold),
      lateOrders: num(r.late),
      reworkOrders: num(reworkOrders.rows[0].count),
    },
  };
}

// ============================================================
// MMS enterprise dashboard + operation desks
// ============================================================

/** Comprehensive Manufacturing Command Center aggregation. */
export async function mfgDashboard(client: pg.PoolClient, ctx: Ctx) {
  const T = ctx.tenantId ?? 0;

  const prod = await client.query(
    `SELECT
       COUNT(*)::int AS orders,
       COALESCE(SUM(quantity) FILTER (WHERE status NOT IN ('DRAFT','CANCELLED','REJECTED')),0)::numeric AS planned_qty,
       COALESCE(SUM(produced_qty) FILTER (WHERE status NOT IN ('DRAFT','CANCELLED','REJECTED')),0)::numeric AS produced_qty,
       COALESCE(SUM(quantity) FILTER (WHERE due_date = CURRENT_DATE AND status NOT IN ('DRAFT','CANCELLED','REJECTED','COMPLETED','CLOSED')),0)::numeric AS planned_today,
       COALESCE(SUM(produced_qty) FILTER (WHERE completed_at::date = CURRENT_DATE),0)::numeric AS output_today,
       COALESCE(SUM(produced_qty) FILTER (WHERE completed_at >= date_trunc('week', CURRENT_DATE)),0)::numeric AS output_week,
       COALESCE(SUM(produced_qty) FILTER (WHERE completed_at >= date_trunc('month', CURRENT_DATE)),0)::numeric AS output_month,
       COALESCE(SUM(waste_qty + scrapped_qty),0)::numeric AS waste_qty,
       COALESCE(AVG(efficiency_percent) FILTER (WHERE efficiency_percent IS NOT NULL),0)::numeric AS efficiency_pct,
       COUNT(*) FILTER (WHERE status IN ('IN_PROGRESS','ON_HOLD','QUALITY_INSPECTION'))::int AS live,
       COUNT(*) FILTER (WHERE status IN ('COMPLETED','CLOSED'))::int AS completed
     FROM work_orders WHERE tenant_id = $1 AND status NOT IN ('CANCELLED','REJECTED')`,
    [T]
  );
  const p = prod.rows[0];
  const plannedQty = num(p.planned_qty);
  const producedQty = num(p.produced_qty);

  const mach = await client.query(
    `SELECT COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE machine_state = 'RUNNING')::int AS running,
       COUNT(*) FILTER (WHERE machine_state = 'IDLE')::int AS idle,
       COUNT(*) FILTER (WHERE machine_state IN ('SETUP','CHANGEOVER'))::int AS setup,
       COUNT(*) FILTER (WHERE machine_state = 'MAINTENANCE')::int AS maintenance,
       COUNT(*) FILTER (WHERE machine_state = 'BREAKDOWN')::int AS breakdown,
       COUNT(*) FILTER (WHERE machine_state = 'OFFLINE')::int AS offline,
       COALESCE(SUM(production_hours),0)::numeric AS running_hours,
       COALESCE(SUM(downtime_hours),0)::numeric AS downtime_hours
     FROM machines WHERE tenant_id = $1`,
    [T]
  );
  const mc = mach.rows[0];

  const cap = await client.query(
    `SELECT COALESCE(SUM(available_hours),0)::numeric AS available,
            COALESCE(SUM(actual_hours),0)::numeric AS actual,
            COALESCE(SUM(downtime_hours + maintenance_hours + changeover_hours),0)::numeric AS lost,
            COALESCE(AVG(oee_pct) FILTER (WHERE oee_pct IS NOT NULL),0)::numeric AS oee,
            COALESCE(AVG(utilization_pct) FILTER (WHERE utilization_pct IS NOT NULL),0)::numeric AS utilization
     FROM machine_capacity WHERE tenant_id = $1 AND capacity_date = CURRENT_DATE`,
    [T]
  );
  const c = cap.rows[0];

  const mat = await client.query(
    `SELECT COALESCE(SUM(i.quantity),0)::numeric AS available,
            COALESCE(SUM(i.reserved_qty),0)::numeric AS reserved
     FROM inventory i JOIN products pr ON pr.id = i.product_id
     WHERE i.tenant_id = $1 AND pr.type IN ('JUMBO_ROLL','PAPER_BOBBIN','SHEET','PACKAGING','CONSUMABLE')`,
    [T]
  );
  const issue = await client.query(
    `SELECT COALESCE(SUM(issued_qty),0)::numeric AS issued,
            COALESCE(SUM(consumed_qty),0)::numeric AS consumed,
            COALESCE(SUM(required_qty),0)::numeric AS required
     FROM production_material_reservations WHERE tenant_id = $1`,
    [T]
  );
  const wip = await client.query(
    `SELECT COALESCE(SUM(wb.quantity),0)::numeric AS qty FROM wip_balances wb WHERE wb.tenant_id = $1`,
    [T]
  );
  const fg = await client.query(
    `SELECT COALESCE(SUM(wo.produced_qty),0)::numeric AS qty
     FROM work_orders wo JOIN products pr ON pr.id = wo.product_id
     WHERE wo.tenant_id = $1 AND wo.status IN ('COMPLETED','CLOSED') AND pr.type IN ('REAM','FINISHED_GOODS')`,
    [T]
  );

  const qres = await client.query(
    `SELECT COUNT(*) FILTER (WHERE ir.passed)::int AS passed,
            COUNT(*) FILTER (WHERE ir.passed = false)::int AS failed,
            COUNT(*)::int AS total
     FROM inspection_results ir JOIN inspections i ON i.id = ir.inspection_id
     WHERE i.tenant_id = $1 AND ir.passed IS NOT NULL`,
    [T]
  );
  const q = qres.rows[0];
  const rework = await client.query(
    `SELECT COALESCE(SUM(rework_qty),0)::numeric AS qty FROM work_orders WHERE tenant_id = $1`,
    [T]
  );
  const defects = await client.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(quantity),0)::numeric AS qty FROM defects WHERE tenant_id = $1`,
    [T]
  );

  const waste = await client.query(
    `SELECT COALESCE(SUM(wr.waste_qty),0)::numeric AS qty,
            COALESCE(SUM(wr.waste_qty * (wo.actual_material_cost / NULLIF(wo.quantity,0))),0)::numeric AS cost,
            COUNT(*) FILTER (WHERE wr.is_abnormal)::int AS abnormal
     FROM waste_records wr JOIN work_orders wo ON wo.id = wr.work_order_id
     WHERE wr.tenant_id = $1`,
    [T]
  );
  const scrap = await client.query(
    `SELECT COALESCE(SUM(quantity),0)::numeric AS qty,
            COALESCE(SUM(quantity * unit_cost),0)::numeric AS value
     FROM scrap_records WHERE tenant_id = $1`,
    [T]
  );
  const stdWaste = await client.query(
    `SELECT COALESCE(SUM(ps.expected_waste_pct * wo.quantity),0)::numeric AS qty
     FROM production_standards ps JOIN work_orders wo ON wo.product_id = ps.product_id AND ps.is_active
     WHERE ps.tenant_id = $1 AND wo.status NOT IN ('DRAFT','CANCELLED','REJECTED')`,
    [T]
  );

  const trend = await client.query(
    `WITH days AS (SELECT generate_series(CURRENT_DATE - 13, CURRENT_DATE, interval '1 day')::date AS day)
     SELECT days.day,
            COALESCE(wp.planned,0)::numeric AS planned,
            COALESCE(wa.actual,0)::numeric AS actual
     FROM days
     LEFT JOIN (SELECT due_date, SUM(quantity) AS planned FROM work_orders
                WHERE tenant_id = $1 AND status NOT IN ('DRAFT','CANCELLED','REJECTED') GROUP BY due_date) wp
       ON wp.due_date = days.day
     LEFT JOIN (SELECT completed_at::date AS d, SUM(produced_qty) AS actual FROM work_orders
                WHERE tenant_id = $1 AND completed_at IS NOT NULL GROUP BY 1) wa
       ON wa.d = days.day
     ORDER BY days.day`,
    [T]
  );

  const machines = await client.query(
    `SELECT m.id, m.code, m.name, m.type, m.machine_state, m.status, m.production_hours, m.downtime_hours,
            m.maintenance_status, m.hourly_rate, m.work_centre_id,
            wc.code AS work_centre_code, wc.name AS work_centre_name,
            (SELECT wo.wo_no FROM work_orders wo
             WHERE wo.machine_id = m.id AND wo.status IN ('IN_PROGRESS','ON_HOLD','QUALITY_INSPECTION')
             ORDER BY wo.id DESC LIMIT 1) AS current_wo,
            (SELECT wo.id FROM work_orders wo
             WHERE wo.machine_id = m.id AND wo.status IN ('IN_PROGRESS','ON_HOLD','QUALITY_INSPECTION')
             ORDER BY wo.id DESC LIMIT 1) AS current_wo_id
     FROM machines m LEFT JOIN work_centres wc ON wc.id = m.work_centre_id
     WHERE m.tenant_id = $1 ORDER BY m.code`,
    [T]
  );

  const alerts = await client.query(
    `SELECT id, alert_type, severity, title, message, status, created_at
     FROM production_alerts WHERE tenant_id = $1 AND status != 'RESOLVED'
     ORDER BY id DESC LIMIT 20`,
    [T]
  );

  const activity = await client.query(
    `SELECT id, event_type, entity_type, entity_code, payload, severity, created_at
     FROM system_events
     WHERE tenant_id = $1 AND event_type LIKE 'production.%'
     ORDER BY id DESC LIMIT 12`,
    [T]
  );

  const wasteQty = num(waste.rows[0].qty);
  const totalOut = producedQty + wasteQty;
  const qTotal = num(q.total);
  const passRate = qTotal > 0 ? pct(num(q.passed), qTotal) : 100;
  const todayPlanned = num(p.planned_today);

  return {
    production: {
      orders: num(p.orders),
      live: num(p.live),
      completed: num(p.completed),
      planned: plannedQty,
      produced: producedQty,
      achievementPct: pct(producedQty, plannedQty),
      efficiencyPct: round2(num(p.efficiency_pct)),
      variance: round2(producedQty - plannedQty),
      plannedToday: todayPlanned,
      outputToday: num(p.output_today),
      achievementTodayPct: pct(num(p.output_today), todayPlanned),
      outputWeek: num(p.output_week),
      outputMonth: num(p.output_month),
    },
    machine: {
      total: num(mc.total),
      running: num(mc.running),
      idle: num(mc.idle),
      setup: num(mc.setup),
      maintenance: num(mc.maintenance),
      breakdown: num(mc.breakdown),
      offline: num(mc.offline),
      runningHours: round2(num(mc.running_hours)),
      downtimeHours: round2(num(mc.downtime_hours)),
      availableHours: round2(num(c.available)),
      actualHours: round2(num(c.actual)),
      lostHours: round2(num(c.lost)),
      oeePct: round2(num(c.oee)),
      utilizationPct: round2(num(c.utilization)),
    },
    material: {
      available: round2(num(mat.rows[0].available)),
      reserved: round2(num(mat.rows[0].reserved)),
      issued: round2(num(issue.rows[0].issued)),
      consumed: round2(num(issue.rows[0].consumed)),
      required: round2(num(issue.rows[0].required)),
      wipQty: round2(num(wip.rows[0].qty)),
      finishedGoods: round2(num(fg.rows[0].qty)),
    },
    quality: {
      passRatePct: round2(passRate),
      rejectionRatePct: round2(100 - passRate),
      passed: num(q.passed),
      failed: num(q.failed),
      total: qTotal,
      reworkQty: round2(num(rework.rows[0].qty)),
      defectCount: num(defects.rows[0].count),
      defectQty: round2(num(defects.rows[0].qty)),
    },
    waste: {
      standardQty: round2(num(stdWaste.rows[0].qty)),
      actualQty: wasteQty,
      wastePct: totalOut > 0 ? round2((wasteQty / totalOut) * 100) : 0,
      cost: round2(num(waste.rows[0].cost)),
      abnormalCount: num(waste.rows[0].abnormal),
      scrapQty: round2(num(scrap.rows[0].qty)),
      scrapValue: round2(num(scrap.rows[0].value)),
    },
    trend: toCamelRows(trend.rows),
    machines: toCamelRows(machines.rows),
    alerts: toCamelRows(alerts.rows),
    activity: toCamelRows(activity.rows),
  };
}

/** Machine status desk: enriched machines with live work order and operator. */
export async function machineStatusDesk(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT m.id, m.code, m.name, m.make, m.model, m.serial_no, m.type, m.machine_state, m.status,
            m.production_hours, m.downtime_hours, m.maintenance_status, m.hourly_rate, m.capacity, m.capacity_unit,
            m.location, m.work_centre_id, wc.code AS work_centre_code, wc.name AS work_centre_name,
            (SELECT wo.wo_no FROM work_orders wo
             WHERE wo.machine_id = m.id AND wo.status IN ('IN_PROGRESS','ON_HOLD','QUALITY_INSPECTION')
             ORDER BY wo.id DESC LIMIT 1) AS current_wo,
            (SELECT wo.id FROM work_orders wo
             WHERE wo.machine_id = m.id AND wo.status IN ('IN_PROGRESS','ON_HOLD','QUALITY_INSPECTION')
             ORDER BY wo.id DESC LIMIT 1) AS current_wo_id,
            (SELECT u.first_name || ' ' || u.last_name FROM work_orders wo JOIN users u ON u.id = wo.operator_id
             WHERE wo.machine_id = m.id AND wo.status IN ('IN_PROGRESS','ON_HOLD')
             ORDER BY wo.id DESC LIMIT 1) AS operator_name
     FROM machines m LEFT JOIN work_centres wc ON wc.id = m.work_centre_id
     WHERE m.tenant_id = $1 ORDER BY wc.code, m.code`,
    [ctx.tenantId ?? 0]
  );
  return toCamelRows(res.rows);
}

/** Production standards master data. */
export async function productionStandardsDesk(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT ps.*, p.code AS product_code, p.name AS product_name, p.type AS product_type, u.code AS unit_code
     FROM production_standards ps
     JOIN products p ON p.id = ps.product_id
     LEFT JOIN units u ON u.id = p.unit_id
     WHERE ps.tenant_id = $1
     ORDER BY p.code, ps.version DESC`,
    [ctx.tenantId ?? 0]
  );
  return toCamelRows(res.rows);
}

export async function upsertProductionStandard(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const productId = Number(b.productId);
  if (!productId) throw badRequest('productId is required');
  const existing = await client.query(
    `SELECT id FROM production_standards WHERE tenant_id = $1 AND product_id = $2 AND is_active ORDER BY version DESC LIMIT 1`,
    [ctx.tenantId ?? 0, productId]
  );
  const fields: Record<string, unknown> = {
    company_id: ctx.companyId ?? null,
    tenant_id: ctx.tenantId ?? null,
    branch_id: ctx.branchId ?? null,
    product_id: productId,
    version: existing.rows.length ? Number(existing.rows[0].version) + 1 : 1,
    standard_setup_min: b.standardSetupMin != null ? Number(b.standardSetupMin) : 0,
    standard_run_min_per_unit: b.standardRunMinPerUnit != null ? Number(b.standardRunMinPerUnit) : 0,
    standard_labour_hours: b.standardLabourHours != null ? Number(b.standardLabourHours) : 0,
    expected_output: b.expectedOutput != null ? Number(b.expectedOutput) : null,
    expected_waste_pct: b.expectedWastePct != null ? Number(b.expectedWastePct) : 0,
    waste_tolerance_pct: b.wasteTolerancePct != null ? Number(b.wasteTolerancePct) : 0,
    standard_cost: b.standardCost != null ? Number(b.standardCost) : 0,
    cost_rate: b.costRate != null ? Number(b.costRate) : 0,
    quality_checkpoints: b.qualityCheckpoints != null ? JSON.stringify(b.qualityCheckpoints) : '[]',
    attributes: b.attributes != null ? JSON.stringify(b.attributes) : '{}',
    is_active: b.isActive !== false,
    notes: b.notes != null ? String(b.notes) : null,
    created_by: ctx.userId ?? null,
  };
  await client.query(
    `UPDATE production_standards SET is_active = false WHERE tenant_id = $1 AND product_id = $2 AND is_active`,
    [ctx.tenantId ?? 0, productId]
  );
  const cols = Object.keys(fields);
  const params = cols.map((k, i) => `$${i + 1}`);
  const { rows } = await client.query(
    `INSERT INTO production_standards (${cols.join(', ')}) VALUES (${params.join(', ')}) RETURNING id`,
    cols.map((k) => fields[k])
  );
  await mesEvent(client, ctx, {
    eventType: 'PRODUCTION_STANDARD_UPSERTED',
    entityType: 'production_standards',
    entityId: Number(rows[0].id),
    entityCode: String(productId),
    payload: { productId, version: fields.version },
  });
  return { id: Number(rows[0].id), version: fields.version };
}

/** Quality inspections desk (incoming / in-process / final). */
export async function qualityInspectionsDesk(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown>) {
  const kind = q.kind != null && String(q.kind) !== '' ? String(q.kind) : null;
  const result = q.result != null && String(q.result) !== '' ? String(q.result) : null;
  const res = await client.query(
    `SELECT i.*, p.code AS product_code, p.name AS product_name, wo.wo_no, pb.batch_no,
            (SELECT COALESCE(json_agg(ir ORDER BY ir.id), '[]'::json) FROM inspection_results ir WHERE ir.inspection_id = i.id) AS results
     FROM inspections i
     JOIN products p ON p.id = i.product_id
     LEFT JOIN work_orders wo ON wo.id = i.work_order_id
     LEFT JOIN product_batches pb ON pb.id = i.batch_id
     WHERE i.tenant_id = $1
       AND ($2::text IS NULL OR i.kind = $2)
       AND ($3::text IS NULL OR i.result = $3)
     ORDER BY i.id DESC LIMIT 200`,
    [ctx.tenantId ?? 0, kind, result]
  );
  return toCamelRows(res.rows);
}

export async function createInspection(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const productId = Number(b.productId);
  if (!productId) throw badRequest('productId is required');
  const kind = String(b.kind ?? 'FINAL');
  const inspectionNo = await nextDoc(client, ctx, 'QC');
  const { rows } = await client.query(
    `INSERT INTO inspections
       (company_id, tenant_id, branch_id, inspection_no, plan_id, kind, ref_type, ref_id, product_id,
        batch_id, work_order_id, quantity, sampled_qty, inspector_id, notes, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'SUBMITTED')
     RETURNING id`,
    [
      ctx.companyId ?? null,
      ctx.tenantId ?? null,
      ctx.branchId ?? null,
      inspectionNo,
      b.planId != null ? Number(b.planId) : null,
      kind,
      String(b.refType ?? 'WORK_ORDER'),
      Number(b.refId ?? b.workOrderId ?? 0),
      productId,
      b.batchId != null ? Number(b.batchId) : null,
      b.workOrderId != null ? Number(b.workOrderId) : null,
      b.quantity != null ? Number(b.quantity) : null,
      b.sampledQty != null ? Number(b.sampledQty) : null,
      ctx.userId ?? null,
      b.notes != null ? String(b.notes) : null,
    ]
  );
  await mesEvent(client, ctx, {
    eventType: 'QUALITY_INSPECTION_CREATED',
    entityType: 'inspections',
    entityId: Number(rows[0].id),
    entityCode: inspectionNo,
    payload: { kind, productId, workOrderId: b.workOrderId ?? null },
  });
  return { id: Number(rows[0].id), inspectionNo };
}

export async function submitInspection(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const inspectionId = Number(b.id);
  if (!inspectionId) throw badRequest('inspection id is required');
  const insp = await client.query(
    `SELECT * FROM inspections WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [inspectionId, ctx.tenantId ?? 0]
  );
  if (insp.rows.length === 0) throw notFound('Inspection not found');
  const results = Array.isArray(b.results) ? (b.results as Record<string, unknown>[]) : [];
  for (const r of results) {
    await client.query(
      `INSERT INTO inspection_results (inspection_id, parameter, method, standard_value, actual_value, unit, passed, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        inspectionId,
        String(r.parameter ?? ''),
        r.method != null ? String(r.method) : null,
        r.standardValue != null ? String(r.standardValue) : null,
        r.actualValue != null ? String(r.actualValue) : null,
        r.unit != null ? String(r.unit) : null,
        r.passed != null ? Boolean(r.passed) : null,
        r.notes != null ? String(r.notes) : null,
      ]
    );
  }
  const result = String(b.result ?? 'PASSED').toUpperCase();
  if (!['PASSED', 'FAILED', 'QUARANTINED', 'PENDING'].includes(result)) throw badRequest(`Invalid result: ${result}`);
  await client.query(
    `UPDATE inspections SET result = $2, inspected_at = now(), completed_at = now(), notes = COALESCE($3, notes)
     WHERE id = $1`,
    [inspectionId, result, b.notes != null ? String(b.notes) : null]
  );
  const row = insp.rows[0];
  if (row.batch_id) {
    if (result === 'PASSED') {
      await client.query(
        `UPDATE product_batches SET status = 'COMPLETED' WHERE id = $1 AND status IN ('OPEN','IN_PRODUCTION','QUALITY_HOLD')`,
        [row.batch_id]
      );
    } else if (result === 'FAILED') {
      await client.query(
        `UPDATE product_batches SET status = 'QUALITY_HOLD' WHERE id = $1 AND status IN ('OPEN','IN_PRODUCTION')`,
        [row.batch_id]
      );
    }
  }
  await mesEvent(client, ctx, {
    eventType: 'QUALITY_INSPECTION_RESULT',
    entityType: 'inspections',
    entityId: inspectionId,
    entityCode: String(row.inspection_no),
    payload: { result, tests: results.length, workOrderId: row.work_order_id ?? null },
    severity: result === 'FAILED' ? 'WARN' : 'INFO',
  });
  return { id: inspectionId, result, tests: results.length };
}

/** Non-conformance report desk. */
export async function ncrDesk(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT n.*, p.code AS product_code, p.name AS product_name
     FROM ncrs n LEFT JOIN products p ON p.id = n.product_id
     WHERE n.tenant_id = $1 ORDER BY n.id DESC LIMIT 200`,
    [ctx.tenantId ?? 0]
  );
  return toCamelRows(res.rows);
}

/** WIP desk: materials and semi-finished units moving through the floor. */
export async function wipDesk(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT wb.*, wo.wo_no, p.code AS product_code, p.name AS product_name,
            m.code AS machine_code, m.name AS machine_name,
            wc.name AS work_centre_name, r.name AS routing_name,
            op.name AS operation_name, u.code AS unit_code
     FROM wip_balances wb
     JOIN work_orders wo ON wo.id = wb.work_order_id
     JOIN products p ON p.id = wb.product_id
     LEFT JOIN machines m ON m.id = wb.machine_id
     LEFT JOIN work_centres wc ON wc.id = wb.work_centre_id
     LEFT JOIN routing_operations op ON op.id = wb.routing_operation_id
     LEFT JOIN routings r ON r.id = wo.routing_id
     LEFT JOIN units u ON u.id = wb.unit_id
     WHERE wb.tenant_id = $1 AND wb.quantity != 0
     ORDER BY wb.updated_at DESC LIMIT 250`,
    [ctx.tenantId ?? 0]
  );
  return toCamelRows(res.rows);
}

/** Production output ledger (good / reject / rework / scrap). */
export async function outputsDesk(client: pg.PoolClient, ctx: Ctx, q: Record<string, unknown>) {
  const outType = q.outputType != null && String(q.outputType) !== '' ? String(q.outputType) : null;
  const res = await client.query(
    `SELECT po.*, wo.wo_no, p.code AS product_code, p.name AS product_name, pb.batch_no
     FROM production_outputs po
     JOIN work_orders wo ON wo.id = po.work_order_id
     JOIN products p ON p.id = wo.product_id
     LEFT JOIN product_batches pb ON pb.id = po.batch_id
     WHERE wo.tenant_id = $1 AND ($2::text IS NULL OR po.output_type = $2)
     ORDER BY po.recorded_at DESC LIMIT 250`,
    [ctx.tenantId ?? 0, outType]
  );
  return toCamelRows(res.rows);
}

/** Material reservations desk. */
export async function reservationDesk(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT pmr.*, wo.wo_no, p.code AS product_code, p.name AS product_name,
            w.code AS warehouse_code, w.name AS warehouse_name, u.code AS unit_code
     FROM production_material_reservations pmr
     JOIN work_orders wo ON wo.id = pmr.work_order_id
     JOIN products p ON p.id = pmr.product_id
     LEFT JOIN warehouses w ON w.id = pmr.warehouse_id
     LEFT JOIN units u ON u.id = p.unit_id
     WHERE pmr.tenant_id = $1
     ORDER BY pmr.id DESC LIMIT 250`,
    [ctx.tenantId ?? 0]
  );
  return toCamelRows(res.rows);
}

/** Material issues desk. */
export async function issueDesk(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT pmi.*, wo.wo_no, p.code AS product_code, p.name AS product_name,
            w.code AS warehouse_code, pb.batch_no
     FROM production_material_issues pmi
     JOIN work_orders wo ON wo.id = pmi.work_order_id
     JOIN products p ON p.id = pmi.product_id
     LEFT JOIN warehouses w ON w.id = pmi.warehouse_id
     LEFT JOIN product_batches pb ON pb.id = pmi.batch_id
     WHERE pmi.tenant_id = $1
     ORDER BY pmi.id DESC LIMIT 250`,
    [ctx.tenantId ?? 0]
  );
  return toCamelRows(res.rows);
}

/** Waste ledger desk. */
export async function wasteDesk(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT wr.*, wo.wo_no, m.code AS machine_code, m.name AS machine_name,
            pb.batch_no, u.code AS unit_code
     FROM waste_records wr
     JOIN work_orders wo ON wo.id = wr.work_order_id
     LEFT JOIN machines m ON m.id = wr.machine_id
     LEFT JOIN product_batches pb ON pb.id = wr.production_batch_id
     LEFT JOIN units u ON u.id = wr.unit_id
     WHERE wr.tenant_id = $1
     ORDER BY wr.recorded_at DESC LIMIT 250`,
    [ctx.tenantId ?? 0]
  );
  return toCamelRows(res.rows);
}

/** Scrap ledger desk. */
export async function scrapDesk(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT sr.*, wo.wo_no, p.code AS product_code, p.name AS product_name,
            m.code AS machine_code, pb.batch_no
     FROM scrap_records sr
     JOIN work_orders wo ON wo.id = sr.work_order_id
     JOIN products p ON p.id = sr.product_id
     LEFT JOIN machines m ON m.id = sr.machine_id
     LEFT JOIN product_batches pb ON pb.id = sr.production_batch_id
     WHERE sr.tenant_id = $1
     ORDER BY sr.recorded_at DESC LIMIT 250`,
    [ctx.tenantId ?? 0]
  );
  return toCamelRows(res.rows);
}

/** Downtime ledger desk. */
export async function downtimeDesk(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT de.*, wo.wo_no, m.code AS machine_code, m.name AS machine_name,
            wc.name AS work_centre_name
     FROM downtime_events de
     JOIN machines m ON m.id = de.machine_id
     LEFT JOIN work_orders wo ON wo.id = de.work_order_id
     LEFT JOIN work_centres wc ON wc.id = de.work_centre_id
     WHERE de.tenant_id = $1
     ORDER BY de.started_at DESC LIMIT 250`,
    [ctx.tenantId ?? 0]
  );
  return toCamelRows(res.rows);
}

/** Gantt schedule data: machine rows x date columns with work order bars. */
export async function ganttDesk(client: pg.PoolClient, ctx: Ctx, from?: string | null, to?: string | null) {
  const fromDate = from ?? null;
  const toDate = to ?? null;
  const res = await client.query(
    `SELECT m.id AS machine_id, m.code AS machine_code, m.name AS machine_name,
            wo.id AS wo_id, wo.wo_no, p.code AS product_code, p.name AS product_name,
            wo.status, wo.priority, wo.quantity, wo.produced_qty, wo.start_date, wo.due_date
     FROM work_orders wo
     JOIN machines m ON m.id = wo.machine_id
     JOIN products p ON p.id = wo.product_id
     WHERE wo.tenant_id = $1 AND wo.status NOT IN ('DRAFT','CANCELLED','REJECTED')
       AND wo.machine_id IS NOT NULL
       AND ($2::date IS NULL OR wo.due_date >= $2)
       AND ($3::date IS NULL OR wo.start_date <= $3)
     ORDER BY m.code, wo.start_date NULLS LAST, wo.id`,
    [ctx.tenantId ?? 0, fromDate, toDate]
  );
  const machines = await client.query(
    `SELECT id, code, name, machine_state FROM machines WHERE tenant_id = $1 ORDER BY code`,
    [ctx.tenantId ?? 0]
  );
  return { bars: toCamelRows(res.rows), machines: toCamelRows(machines.rows) };
}

/** Packaging hierarchy configuration. */
export async function packagingHierarchyDesk(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT ph.*, p.code AS product_code, p.name AS product_name
     FROM packaging_hierarchies ph
     JOIN products p ON p.id = ph.product_id
     WHERE ph.tenant_id = $1
     ORDER BY p.code, ph.sort_order, ph.level`,
    [ctx.tenantId ?? 0]
  );
  return toCamelRows(res.rows);
}

export async function upsertPackagingHierarchy(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const productId = Number(b.productId);
  const level = Number(b.level ?? 1);
  if (!productId) throw badRequest('productId is required');
  await client.query(
    `INSERT INTO packaging_hierarchies
       (company_id, tenant_id, product_id, level, level_code, name, qty_per_parent, weight_kg, sort_order, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (company_id, product_id, level)
     DO UPDATE SET level_code = EXCLUDED.level_code, name = EXCLUDED.name,
       qty_per_parent = EXCLUDED.qty_per_parent, weight_kg = EXCLUDED.weight_kg,
       sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, updated_at = now()`,
    [
      ctx.companyId ?? null,
      ctx.tenantId ?? null,
      productId,
      level,
      String(b.levelCode ?? `LV${level}`),
      String(b.name ?? `Level ${level}`),
      b.qtyPerParent != null ? Number(b.qtyPerParent) : 1,
      b.weightKg != null ? Number(b.weightKg) : null,
      b.sortOrder != null ? Number(b.sortOrder) : level,
      b.isActive !== false,
    ]
  );
  return { productId, level };
}

// ---------------------------------------------------------------------------
// BOM & Engineering desk (bills of materials + routings)
// ---------------------------------------------------------------------------
export async function bomsDesk(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT b.*, p.code AS product_code, p.name AS product_name, p.type AS product_type, u.code AS unit_code,
       (SELECT count(*) FROM bom_items bi WHERE bi.bom_id = b.id) AS item_count,
       (SELECT COALESCE(sum(bi.quantity), 0) FROM bom_items bi WHERE bi.bom_id = b.id) AS total_material_qty
     FROM boms b
     JOIN products p ON p.id = b.product_id
     LEFT JOIN units u ON u.id = b.unit_id
     WHERE b.tenant_id = $1
     ORDER BY p.code, b.version DESC`,
    [ctx.tenantId ?? 0]
  );
  return toCamelRows(res.rows);
}

export async function bomDetail(client: pg.PoolClient, ctx: Ctx, id: number) {
  const hdr = await client.query(
    `SELECT b.*, p.code AS product_code, p.name AS product_name, p.type AS product_type, u.code AS unit_code
     FROM boms b
     JOIN products p ON p.id = b.product_id
     LEFT JOIN units u ON u.id = b.unit_id
     WHERE b.id = $1 AND b.tenant_id = $2`,
    [id, ctx.tenantId ?? 0]
  );
  if (hdr.rows.length === 0) throw notFound('BOM not found');
  const items = await client.query(
    `SELECT bi.id, bi.product_id AS material_id, bi.quantity, bi.scrap_percent, bi.is_consumable,
       p.code AS material_code, p.name AS material_name, p.type AS material_type, u.code AS unit_code
     FROM bom_items bi
     JOIN products p ON p.id = bi.product_id
     LEFT JOIN units u ON u.id = bi.unit_id
     WHERE bi.bom_id = $1
     ORDER BY bi.is_consumable, bi.id`,
    [id]
  );
  return { ...toCamelRow(hdr.rows[0]), items: toCamelRows(items.rows) };
}

export async function routingsDesk(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT r.*, p.code AS product_code, p.name AS product_name,
       (SELECT count(*) FROM routing_operations ro WHERE ro.routing_id = r.id) AS op_count,
       (SELECT COALESCE(sum(ro.setup_time_min + ro.teardown_time_min), 0)
          FROM routing_operations ro WHERE ro.routing_id = r.id) AS setup_teardown_min
     FROM routings r
     JOIN products p ON p.id = r.product_id
     WHERE r.tenant_id = $1
     ORDER BY p.code, r.version DESC`,
    [ctx.tenantId ?? 0]
  );
  return toCamelRows(res.rows);
}

export async function routingDetail(client: pg.PoolClient, ctx: Ctx, id: number) {
  const hdr = await client.query(
    `SELECT r.*, p.code AS product_code, p.name AS product_name
     FROM routings r
     JOIN products p ON p.id = r.product_id
     WHERE r.id = $1 AND r.tenant_id = $2`,
    [id, ctx.tenantId ?? 0]
  );
  if (hdr.rows.length === 0) throw notFound('Routing not found');
  const ops = await client.query(
    `SELECT ro.id, ro.seq, ro.name, ro.setup_time_min, ro.run_time_per_unit_min, ro.teardown_time_min,
       wc.code AS work_centre_code, wc.name AS work_centre_name,
       m.code AS machine_code, m.name AS machine_name
     FROM routing_operations ro
     LEFT JOIN work_centres wc ON wc.id = ro.work_centre_id
     LEFT JOIN machines m ON m.id = ro.machine_id
     WHERE ro.routing_id = $1
     ORDER BY ro.seq`,
    [id]
  );
  return { ...toCamelRow(hdr.rows[0]), operations: toCamelRows(ops.rows) };
}

export async function createBom(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const productId = Number(b.productId);
  if (!productId) throw badRequest('productId is required');
  const code = b.code != null ? String(b.code).trim() : null;
  const res = await client.query(
    `INSERT INTO boms
       (company_id, tenant_id, product_id, code, name, version, quantity, unit_id, is_active, effective_from, effective_to, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id, code, name`,
    [
      ctx.companyId ?? null,
      ctx.tenantId ?? null,
      productId,
      code,
      String(b.name ?? 'BOM'),
      Number(b.version ?? 1),
      b.quantity != null ? Number(b.quantity) : 1,
      b.unitId != null ? Number(b.unitId) : null,
      b.isActive !== false,
      b.effectiveFrom != null ? new Date(String(b.effectiveFrom)) : null,
      b.effectiveTo != null ? new Date(String(b.effectiveTo)) : null,
      String(b.status ?? 'DRAFT'),
    ]
  );
  return toCamelRow(res.rows[0]);
}

export async function createRouting(client: pg.PoolClient, ctx: Ctx, b: Record<string, unknown>) {
  const productId = Number(b.productId);
  if (!productId) throw badRequest('productId is required');
  const code = b.code != null ? String(b.code).trim() : null;
  const res = await client.query(
    `INSERT INTO routings
       (company_id, tenant_id, product_id, code, name, version, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, code, name`,
    [
      ctx.companyId ?? null,
      ctx.tenantId ?? null,
      productId,
      code,
      String(b.name ?? 'Routing'),
      Number(b.version ?? 1),
      b.isActive !== false,
    ]
  );
  return toCamelRow(res.rows[0]);
}
