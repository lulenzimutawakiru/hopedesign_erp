import pg from 'pg';
import { Ctx } from '../db.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../utils.js';
import { logAudit } from './audit.js';

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number => Number(v ?? 0);

const TYPES = ['MACHINE', 'LABOUR', 'ASSEMBLY', 'QC', 'PACKAGING'];

export interface WorkCentreInput {
  code?: string;
  name?: string;
  type?: string;
  capacity?: number | null;
  capacityUnit?: string | null;
  hourlyCost?: number;
  overheadRate?: number;
  department?: string | null;
  availableHours?: number;
  efficiencyTarget?: number;
  utilisationTarget?: number;
  shiftConfig?: unknown;
  facilityId?: number | null;
  isActive?: boolean;
}

const wcColumns: Array<[keyof WorkCentreInput, string, (v: unknown) => unknown]> = [
  ['code', 'code', (v) => String(v ?? '').trim()],
  ['name', 'name', (v) => String(v ?? '')],
  ['type', 'type', (v) => String(v ?? 'MACHINE')],
  ['capacity', 'capacity', (v) => (v != null && v !== '' ? Number(v) : null)],
  ['capacityUnit', 'capacity_unit', (v) => (v != null && v !== '' ? String(v) : null)],
  ['hourlyCost', 'hourly_cost', (v) => Number(v ?? 0)],
  ['overheadRate', 'overhead_rate', (v) => Number(v ?? 0)],
  ['department', 'department', (v) => (v != null && v !== '' ? String(v) : null)],
  ['availableHours', 'available_hours', (v) => (v != null && v !== '' ? Number(v) : 8)],
  ['efficiencyTarget', 'efficiency_target', (v) => (v != null && v !== '' ? Number(v) : 0.85)],
  ['utilisationTarget', 'utilisation_target', (v) => (v != null && v !== '' ? Number(v) : 0.8)],
  ['shiftConfig', 'shift_config', (v) => (v ?? [])],
  ['facilityId', 'facility_id', (v) => (v != null && v !== '' ? Number(v) : null)],
  ['isActive', 'status', (v) => (v === false ? 'INACTIVE' : 'ACTIVE')],
];

/** Work centres with machine / routing-operation counts and a per-centre OEE. */
export async function workCentresDesk(client: pg.PoolClient, ctx: Ctx) {
  const res = await client.query(
    `SELECT wc.*, f.name AS facility_name,
       (SELECT count(*) FROM machines m WHERE m.work_centre_id = wc.id)::int AS machine_count,
       (SELECT count(*) FILTER (WHERE machine_state = 'RUNNING') FROM machines m WHERE m.work_centre_id = wc.id)::int AS machines_running,
       (SELECT count(*) FILTER (WHERE machine_state IN ('BREAKDOWN','MAINTENANCE','OFFLINE')) FROM machines m WHERE m.work_centre_id = wc.id)::int AS machines_down,
       (SELECT count(*) FROM routing_operations ro WHERE ro.work_centre_id = wc.id)::int AS operation_count,
       (SELECT count(*) FROM production_schedule_entries pse WHERE pse.work_centre_id = wc.id AND pse.planned_end >= now())::int AS scheduled_jobs
     FROM work_centres wc
     LEFT JOIN production_facilities f ON f.id = wc.facility_id
     WHERE wc.tenant_id = $1
     ORDER BY wc.code`,
    [ctx.tenantId]
  );

  const oee = await client.query(
    `SELECT m.work_centre_id, COALESCE(avg(v.oee_pct), 0)::numeric AS oee_avg
     FROM machines m
     JOIN v_machine_oee v ON v.machine_id = m.id
     WHERE m.tenant_id = $1 AND m.work_centre_id IS NOT NULL
     GROUP BY m.work_centre_id`,
    [ctx.tenantId]
  );
  const oeeMap = new Map<number, number>();
  for (const r of oee.rows) oeeMap.set(Number(r.work_centre_id), Number(r.oee_avg));

  return toCamelRows(res.rows).map((r) => ({
    ...r,
    oeeAvg: round2(oeeMap.get(Number(r.id)) ?? 0),
    efficiencyTargetPct: round2(num(r.efficiencyTarget) * 100),
    utilisationTargetPct: round2(num(r.utilisationTarget) * 100),
  }));
}

export async function workCentreDetail(client: pg.PoolClient, ctx: Ctx, id: number) {
  const hdr = await client.query(
    `SELECT wc.*, f.name AS facility_name
     FROM work_centres wc
     LEFT JOIN production_facilities f ON f.id = wc.facility_id
     WHERE wc.id = $1 AND wc.tenant_id = $2`,
    [id, ctx.tenantId]
  );
  if (hdr.rows.length === 0) throw notFound('Work centre not found');

  const machines = await client.query(
    `SELECT m.* FROM machines m WHERE m.work_centre_id = $1 AND m.tenant_id = $2 ORDER BY m.code`,
    [id, ctx.tenantId]
  );
  const operations = await client.query(
    `SELECT ro.*, r.code AS routing_code, r.name AS routing_name, p.code AS product_code, p.name AS product_name
     FROM routing_operations ro
     JOIN routings r ON r.id = ro.routing_id
     JOIN products p ON p.id = r.product_id
     WHERE ro.work_centre_id = $1
     ORDER BY r.code, ro.seq`,
    [id]
  );

  return {
    ...toCamelRow(hdr.rows[0]),
    machines: toCamelRows(machines.rows),
    operations: toCamelRows(operations.rows),
  };
}

export async function saveWorkCentre(client: pg.PoolClient, ctx: Ctx, id: number | null, input: WorkCentreInput) {
  if (input.type && !TYPES.includes(input.type)) throw badRequest('Unsupported work centre type');
  const companyId = ctx.companyId ?? null;
  if (!companyId) throw badRequest('Company context required');

  if (id == null) {
    if (!input.code || !input.name) throw badRequest('Code and name are required');
    const res = await client.query(
      `INSERT INTO work_centres
         (company_id, tenant_id, facility_id, code, name, type, capacity, capacity_unit,
          hourly_cost, overhead_rate, department, available_hours, efficiency_target,
          utilisation_target, shift_config, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        companyId, ctx.tenantId,
        input.facilityId ?? null,
        String(input.code).trim(), String(input.name).trim(),
        input.type ?? 'MACHINE',
        input.capacity ?? null, input.capacityUnit ?? null,
        num(input.hourlyCost), num(input.overheadRate),
        input.department ?? null,
        input.availableHours != null ? num(input.availableHours) : 8,
        input.efficiencyTarget != null ? num(input.efficiencyTarget) : 0.85,
        input.utilisationTarget != null ? num(input.utilisationTarget) : 0.8,
        input.shiftConfig ?? [], input.isActive === false ? 'INACTIVE' : 'ACTIVE',
      ]
    );
    await logAudit(client, ctx, { action: 'create', resource: 'work_centres', recordId: Number(res.rows[0].id), newValues: toCamelRow(res.rows[0]) });
    return toCamelRow(res.rows[0]);
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  const changes: Record<string, unknown> = {};
  for (const [key, column, cast] of wcColumns) {
    if (!(key in input)) continue;
    const value = cast(input[key]);
    changes[key] = value;
    vals.push(value);
    sets.push(`${column} = $${vals.length}`);
  }
  if (sets.length === 0) throw badRequest('No work centre fields to update');
  vals.push(id);
  const idIdx = vals.length;
  vals.push(ctx.tenantId);
  const tenantIdx = vals.length;
  const res = await client.query(
    `UPDATE work_centres SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${idIdx} AND tenant_id = $${tenantIdx}
     RETURNING *`,
    vals
  );
  if (res.rowCount === 0) throw notFound('Work centre not found');
  await logAudit(client, ctx, { action: 'update', resource: 'work_centres', recordId: id, newValues: changes });
  return toCamelRow(res.rows[0]);
}

export async function deleteWorkCentre(client: pg.PoolClient, ctx: Ctx, id: number) {
  const res = await client.query(
    `UPDATE work_centres SET status = 'INACTIVE', updated_at = now()
     WHERE id = $1 AND tenant_id = $2 RETURNING id, code`,
    [id, ctx.tenantId]
  );
  if (res.rowCount === 0) throw notFound('Work centre not found');
  await logAudit(client, ctx, { action: 'deactivate', resource: 'work_centres', recordId: id, recordCode: res.rows[0].code });
  return { id, deactivated: true };
}

/** Replace a routing's operations in one write (like price-list items). */
export async function saveRoutingOperations(
  client: pg.PoolClient,
  ctx: Ctx,
  routingId: number,
  operations: Array<{
    id?: number | null;
    seq: number;
    name: string;
    workCentreId: number;
    setupTimeMin?: number;
    runTimePerUnitMin?: number;
    teardownTimeMin?: number;
    machineId?: number | null;
    alternativeWorkCentres?: number[];
  }>
) {
  const routing = await client.query(
    `SELECT id FROM routings WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [routingId, ctx.tenantId]
  );
  if (routing.rows.length === 0) throw notFound('Routing not found');

  for (const op of operations) {
    if (!op.workCentreId) throw badRequest('Each operation needs a work centre');
    if (!op.name) throw badRequest('Each operation needs a name');
  }

  await client.query(`DELETE FROM routing_operations WHERE routing_id = $1`, [routingId]);
  for (let i = 0; i < operations.length; i += 1) {
    const op = operations[i];
    await client.query(
      `INSERT INTO routing_operations
         (routing_id, work_centre_id, seq, name, setup_time_min, run_time_per_unit_min,
          teardown_time_min, machine_id, alternative_work_centres)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        routingId,
        op.workCentreId,
        op.seq ?? i + 1,
        op.name,
        op.setupTimeMin ?? 0,
        op.runTimePerUnitMin ?? 0,
        op.teardownTimeMin ?? 0,
        op.machineId ?? null,
        JSON.stringify(op.alternativeWorkCentres ?? []),
      ]
    );
  }

  const ops = await client.query(
    `SELECT ro.id, ro.seq, ro.name, ro.setup_time_min, ro.run_time_per_unit_min, ro.teardown_time_min,
            ro.work_centre_id, ro.machine_id, ro.alternative_work_centres,
            wc.code AS work_centre_code, wc.name AS work_centre_name,
            m.code AS machine_code
     FROM routing_operations ro
     LEFT JOIN work_centres wc ON wc.id = ro.work_centre_id
     LEFT JOIN machines m ON m.id = ro.machine_id
     WHERE ro.routing_id = $1
     ORDER BY ro.seq`,
    [routingId]
  );
  return toCamelRows(ops.rows);
}
