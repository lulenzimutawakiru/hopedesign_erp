import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { pool } from './helpers.js';
import type { Ctx } from '../src/db.js';
import { completeWorkOrder, recordLabour } from '../src/services/production.js';
import { postInventoryValueChange, postAbnormalLoss } from '../src/services/finance.js';
import { costingDesk } from '../src/services/manufacturing.js';
import { listProductionCosts, postProductionCost } from '../src/services/finance-advanced.js';

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

  it('full lifecycle: issue material -> labour -> good output -> complete -> GL postings', async () => {
    await client.query('BEGIN');
    try {
      const product = (await client.query(
        `SELECT id, type FROM products WHERE tenant_id = $1 LIMIT 1`,
        [CTX.tenantId]
      )).rows[0];
      expect(product).toBeTruthy();

      const machine = (await client.query(
        `INSERT INTO machines (company_id, tenant_id, code, name, hourly_rate, utility_rate_per_kwh)
         VALUES ($1,$2,'TEST-MACH-LIFE','Lifecycle machine',10000,200) RETURNING id`,
        [CTX.companyId, CTX.tenantId]
      )).rows[0];

      const wo = (await client.query(
        `INSERT INTO work_orders (company_id, tenant_id, wo_no, product_id, quantity, produced_qty, standard_cost, status)
         VALUES ($1,$2,'TEST-WO-LIFE',$3,100,80,70000,'IN_PROGRESS') RETURNING id`,
        [CTX.companyId, CTX.tenantId, product.id]
      )).rows[0];
      const woId = Number(wo.id);

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
      await client.query(
        `INSERT INTO allocation_rules (company_id, tenant_id, code, name, driver, rate, is_active)
         VALUES ($1,$2,'TEST-OH-LIFE','Lifecycle overhead','MACHINE_HOURS',1000,true)`,
        [CTX.companyId, CTX.tenantId]
      );

      // Material issue -> Dr WIP / Cr Raw (negative = credit the stock account).
      const issueEntry = await postInventoryValueChange(client, CTX, {
        productId: Number(product.id),
        productType: String(product.type),
        amount: -(10 * 300),
        entryDate: '2026-11-17',
        description: 'Material issue TEST-WO-LIFE',
        journalType: 'PRODUCTION',
        refType: 'work_orders',
        refId: woId,
        refCode: 'TEST-WO-LIFE',
      });
      expect(issueEntry).toBeTruthy();

      // Good output -> Dr FG / Cr WIP (positive = debit the stock account).
      const outputEntry = await postInventoryValueChange(client, CTX, {
        productId: Number(product.id),
        productType: String(product.type),
        amount: 80 * 300,
        entryDate: '2026-11-17',
        description: 'Good output TEST-WO-LIFE',
        journalType: 'PRODUCTION',
        refType: 'work_orders',
        refId: woId,
        refCode: 'TEST-WO-LIFE',
      });
      expect(outputEntry).toBeTruthy();

      await completeWorkOrder(client, CTX, woId);

      const row = (await client.query(
        `SELECT actual_material_cost, actual_labour_cost, actual_machine_cost, actual_overhead_cost,
                actual_cost, cost_variance, yield_percent, status
         FROM work_orders WHERE id = $1`,
        [woId]
      )).rows[0];
      expect(row.status).toBe('COMPLETED');
      expect(Number(row.actual_machine_cost)).toBe(30000);
      // overhead = 2h * 1000 = 2000 (single rule in this lifecycle)
      expect(Number(row.actual_overhead_cost)).toBe(2000);
      expect(Number(row.actual_material_cost)).toBe(3000);
      expect(Number(row.actual_labour_cost)).toBe(25000);
      expect(Number(row.actual_cost)).toBe(60000);
      expect(Number(row.cost_variance)).toBe(10000);
      expect(Number(row.yield_percent)).toBe(80);

      // The two production journals must have hit distinct WIP vs inventory accounts.
      const issueLines = (await client.query(
        `SELECT a.code, l.debit, l.credit FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.entry_id = $1`,
        [issueEntry]
      )).rows;
      expect(issueLines.find((l) => l.code === '10111410' && Number(l.debit) === 3000)).toBeTruthy();
      expect(issueLines.find((l) => l.code === '10111400' && Number(l.credit) === 3000)).toBeTruthy();

      const outputLines = (await client.query(
        `SELECT a.code, l.debit, l.credit FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.entry_id = $1`,
        [outputEntry]
      )).rows;
      expect(outputLines.find((l) => l.code === '10111400' && Number(l.debit) === 24000)).toBeTruthy();
      expect(outputLines.find((l) => l.code === '10111410' && Number(l.credit) === 24000)).toBeTruthy();
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

describe('production cost accounting (WIP general-ledger postings)', () => {
  let client: pg.PoolClient;

  beforeAll(async () => {
    client = await pool.connect();
  });

  afterAll(async () => {
    if (client) client.release();
  });

  it('posts Dr FG / Cr WIP for a production completion move (WIP is now a distinct account)', async () => {
    await client.query('BEGIN');
    try {
      const product = (await client.query(
        `SELECT id, type FROM products WHERE tenant_id = $1 LIMIT 1`,
        [CTX.tenantId]
      )).rows[0];
      expect(product).toBeTruthy();

      const entryId = await postInventoryValueChange(client, CTX, {
        productId: Number(product.id),
        productType: String(product.type),
        amount: 50000,
        entryDate: '2026-11-17',
        description: 'Production output GL test',
        journalType: 'PRODUCTION',
        refType: 'work_orders',
        refId: 999999,
        refCode: 'TEST-GL',
      });
      expect(entryId).toBeTruthy();

      const lines = (await client.query(
        `SELECT a.code, l.debit, l.credit
         FROM journal_lines l
         JOIN chart_of_accounts a ON a.id = l.account_id
         WHERE l.entry_id = $1`,
        [entryId]
      )).rows;

      const fg = lines.find((l) => l.code === '10111400');
      const wip = lines.find((l) => l.code === '10111410');
      expect(fg).toBeTruthy();
      expect(wip).toBeTruthy();
      expect(Number(fg.debit)).toBe(50000);
      expect(Number(wip.credit)).toBe(50000);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('posts Dr Abnormal loss / Cr WIP for abnormal production loss', async () => {
    await client.query('BEGIN');
    try {
      const entryId = await postAbnormalLoss(client, CTX, {
        amount: 7000,
        description: 'Abnormal waste GL test',
        refType: 'waste_records',
        refId: 999998,
        refCode: 'WST-TEST',
      });
      expect(entryId).toBeTruthy();

      const lines = (await client.query(
        `SELECT a.code, l.debit, l.credit
         FROM journal_lines l
         JOIN chart_of_accounts a ON a.id = l.account_id
         WHERE l.entry_id = $1`,
        [entryId]
      )).rows;

      expect(lines.find((l) => l.code === '10251820' && Number(l.debit) === 7000)).toBeTruthy();
      expect(lines.find((l) => l.code === '10111410' && Number(l.credit) === 7000)).toBeTruthy();
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

describe('production cost accounting (Phase 5 filter set)', () => {
  let client: pg.PoolClient;

  beforeAll(async () => {
    client = await pool.connect();
  });

  afterAll(async () => {
    if (client) client.release();
  });

  it('costingDesk accepts the date/MO/product/facility/status/costing-status filters', async () => {
    const desk = await costingDesk(client, CTX, {
      from: '2020-01-01',
      workOrderId: 999999, // impossible id -> empty set, proves the filter is applied
      status: 'COMPLETED',
    });
    expect(desk).toHaveProperty('summary');
    expect(desk).toHaveProperty('rows');
    expect(desk.rows).toHaveLength(0);
  });

  it('listProductionCosts accepts the work-order and product filters', async () => {
    const rows = await listProductionCosts(client, CTX, { workOrderId: 999999, productId: 999999 });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it('refuses to post finished-goods value for an in-progress work order', async () => {
    await client.query('BEGIN');
    try {
      const product = (await client.query(
        `SELECT id FROM products WHERE tenant_id = $1 LIMIT 1`,
        [CTX.tenantId]
      )).rows[0];
      const wo = (await client.query(
        `INSERT INTO work_orders (company_id, tenant_id, wo_no, product_id, quantity, status)
         VALUES ($1,$2,$3,$4,10,'IN_PROGRESS') RETURNING id`,
        [CTX.companyId, CTX.tenantId, 'TEST-WO-POSTGATE', product.id]
      )).rows[0];
      const pc = (await client.query(
        `INSERT INTO production_costs (company_id, tenant_id, work_order_id, product_id, cost_date, quantity, expected_cost, actual_cost, variance, status)
         VALUES ($1,$2,$3,$4,'2026-11-17',10,1000,1000,0,'CALCULATED') RETURNING id`,
        [CTX.companyId, CTX.tenantId, Number(wo.id), product.id]
      )).rows[0];
      await expect(postProductionCost(client, CTX, Number(pc.id))).rejects.toThrow(/completed/i);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
