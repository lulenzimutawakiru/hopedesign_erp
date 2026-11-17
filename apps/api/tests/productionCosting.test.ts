import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { pool } from './helpers.js';
import type { Ctx } from '../src/db.js';
import { completeWorkOrder, recordLabour } from '../src/services/production.js';

/**
 * Production cost accounting — the costing engine.
 *
 * `completeWorkOrder` must total material, labour, machine (+ electricity),
 * overhead (from allocation rules, with a legacy fallback), waste and rework
 * entirely in SQL NUMERIC, and store the result on the work-order cost columns
 * with variance = standard − actual (positive = favourable). This file seeds a
 * minimal work order and asserts the exact numbers, so the arithmetic cannot
 * silently drift back to JS-float accumulation.
 */

const CTX: Ctx = { tenantId: 2, companyId: 2, userId: 15 };

describe('production cost accounting (costing engine)', () => {
  let client: pg.PoolClient;

  beforeAll(async () => {
    client = await pool.connect();
  });

  afterAll(async () => {
    if (client) client.release();
  });

  it('computes machine + electricity, rule-based overhead and variance in SQL NUMERIC', async () => {
    await client.query('BEGIN');
    try {
      const product = (await client.query(
        `SELECT id FROM products WHERE tenant_id = $1 LIMIT 1`,
        [CTX.tenantId]
      )).rows[0];
      expect(product).toBeTruthy();

      const machine = (await client.query(
        `INSERT INTO machines (company_id, tenant_id, code, name, hourly_rate, utility_rate_per_kwh, power_kw)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [CTX.companyId, CTX.tenantId, 'TEST-MACH-COST', 'Costing test machine', 10000, 200, 50]
      )).rows[0];

      const wo = (await client.query(
        `INSERT INTO work_orders (company_id, tenant_id, wo_no, product_id, quantity, produced_qty, standard_cost, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'IN_PROGRESS') RETURNING id`,
        [CTX.companyId, CTX.tenantId, 'TEST-WO-COST', product.id, 100, 80, 70000]
      )).rows[0];
      const woId = Number(wo.id);

      // 2 hours planned run, 50 kWh consumed.
      await client.query(
        `INSERT INTO work_order_operations (work_order_id, seq, name, machine_id, planned_run_min, kwh_consumed)
         VALUES ($1, 1, 'Cut', $2, 120, 50)`,
        [woId, machine.id]
      );

      await client.query(
        `INSERT INTO work_order_materials (work_order_id, product_id, required_qty, issued_qty, unit_cost)
         VALUES ($1, $2, 10, 10, 300)`,
        [woId, product.id]
      );

      await client.query(
        `INSERT INTO work_order_labour (work_order_id, hours, hourly_rate, cost)
         VALUES ($1, 5, 5000, 25000)`,
        [woId]
      );

      // Overhead: MACHINE_HOURS @1000/h and PRODUCTION_QUANTITY @50/unit.
      await client.query(
        `INSERT INTO allocation_rules (company_id, tenant_id, code, name, driver, rate, is_active)
         VALUES ($1,$2,'TEST-OH-MH','Machine-hour overhead','MACHINE_HOURS',1000,true),
                ($1,$2,'TEST-OH-QTY','Quantity overhead','PRODUCTION_QUANTITY',50,true)`,
        [CTX.companyId, CTX.tenantId]
      );

      await completeWorkOrder(client, CTX, woId);

      const row = (await client.query(
        `SELECT actual_material_cost, actual_labour_cost, actual_machine_cost, actual_overhead_cost,
                actual_waste_cost, actual_other_cost, actual_cost, cost_variance, yield_percent,
                status
         FROM work_orders WHERE id = $1`,
        [woId]
      )).rows[0];

      expect(row.status).toBe('COMPLETED');
      // machine = 2h * 10000 + 50 kWh * 200 = 30000
      expect(Number(row.actual_machine_cost)).toBe(30000);
      // overhead = 2h*1000 (machine hours) + 80 units*50 (quantity) = 6000
      expect(Number(row.actual_overhead_cost)).toBe(6000);
      expect(Number(row.actual_material_cost)).toBe(3000);
      expect(Number(row.actual_labour_cost)).toBe(25000);
      expect(Number(row.actual_waste_cost)).toBe(0);
      expect(Number(row.actual_other_cost)).toBe(0);
      // actual = 3000 + 25000 + 30000 + 6000 = 64000
      expect(Number(row.actual_cost)).toBe(64000);
      // variance = 70000 - 64000 = 6000 (favourable)
      expect(Number(row.cost_variance)).toBe(6000);
      expect(Number(row.yield_percent)).toBe(80);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('defaults labour rate from the employee hourly_rate and stores cost server-side', async () => {
    await client.query('BEGIN');
    try {
      const product = (await client.query(
        `SELECT id FROM products WHERE tenant_id = $1 LIMIT 1`,
        [CTX.tenantId]
      )).rows[0];

      const operator = (await client.query(
        `SELECT id FROM users WHERE username = 'admin' LIMIT 1`
      )).rows[0];

      const emp = (await client.query(
        `INSERT INTO employees (company_id, tenant_id, employee_no, first_name, last_name, hourly_rate, salary_type)
         VALUES ($1,$2,$3,'Cost','Labour',$4,'HOURLY') RETURNING id`,
        [CTX.companyId, CTX.tenantId, 'TEST-EMP-COST', 7500]
      )).rows[0];

      const wo = (await client.query(
        `INSERT INTO work_orders (company_id, tenant_id, wo_no, product_id, quantity, status)
         VALUES ($1,$2,$3,$4,10,'IN_PROGRESS') RETURNING id`,
        [CTX.companyId, CTX.tenantId, 'TEST-WO-LABOUR', product.id]
      )).rows[0];
      const woId = Number(wo.id);

      await recordLabour(client, CTX, {
        workOrderId: woId,
        operatorUserId: Number(operator.id),
        employeeId: Number(emp.id),
        hours: 8,
      });

      const row = (await client.query(
        `SELECT employee_id, hours, hourly_rate, cost FROM work_order_labour WHERE work_order_id = $1`,
        [woId]
      )).rows[0];

      expect(Number(row.employee_id)).toBe(Number(emp.id));
      expect(Number(row.hourly_rate)).toBe(7500);
      // cost = 8 * 7500 = 60000, computed in SQL NUMERIC
      expect(Number(row.cost)).toBe(60000);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
