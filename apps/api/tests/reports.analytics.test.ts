import { describe, it, expect } from 'vitest';
import { api, auth, loginAs, db } from './helpers.js';

const uniq = (s: string) => `${s}_${Date.now()}`;

type Row = Record<string, unknown>;

describe('Reports & Analytics: KPI engine, dashboards and custom report builder', () => {
  it('serves the live executive analytics dashboard and enforces RBAC', async () => {
    const { token } = await loginAs('admin');
    const res = await api.get('/api/analytics/executive').set(auth(token));
    expect(res.status).toBe(200);
    const d = res.body.data as Row;
    expect(d.financial).toBeTruthy();
    expect(typeof (d.financial as Row).trialBalance).toBe('number');
    expect(typeof (d.financial as Row).receivables).toBe('number');
    expect(typeof (d.financial as Row).payables).toBe('number');
    expect(d.commercial).toBeTruthy();
    expect(typeof (d.commercial as Row).monthRevenue).toBe('number');
    expect(d.manufacturing).toBeTruthy();
    expect(typeof (d.manufacturing as Row).workOrdersInProgress).toBe('number');
    expect(d.inventory).toBeTruthy();
    expect(typeof (d.inventory as Row).stockValue).toBe('number');
    expect(d.traceability).toBeTruthy();
    expect(typeof (d.traceability as Row).qrScans).toBe('number');
    expect(d.logistics).toBeTruthy();
    expect(typeof (d.logistics as Row).deliveryRatePct).toBe('number');

    // A sales user without executive report rights is denied server-side.
    const { token: sales } = await loginAs('sarah.sales');
    const denied = await api.get('/api/analytics/executive').set(auth(sales));
    expect(denied.status).toBe(403);
  });

  it('manages KPIs: list seeded, create, measure, history, archive; validates and enforces RBAC', async () => {
    const { token } = await loginAs('admin');

    // Seeded KPIs are already present and scoped.
    const list = await api.get('/api/reports/kpis').set(auth(token));
    expect(list.status).toBe(200);
    const seeded = (list.body.data as Row[]).find((k) => k.key === 'stock_value');
    expect(seeded).toBeTruthy();

    // Create a KPI against a real data source.
    const key = uniq('test_revenue');
    const created = await api.post('/api/reports/kpis').set(auth(token)).send({
      key,
      name: 'Test Monthly Revenue',
      description: 'Created by reports.analytics test',
      dataSource: 'v_sales_by_month',
      valueColumn: 'revenue',
      aggregation: 'SUM',
      periodColumn: 'month',
      unit: 'UGX',
      frequency: 'MONTHLY',
      direction: 'HIGHER_BETTER',
      targetValue: 1000000,
      warningThreshold: 90,
      criticalThreshold: 75,
    });
    expect(created.status).toBe(200);
    const kpiId = Number((created.body.data as Row).id);
    expect(created.body.data.key).toBe(key);

    // Measure against live data; status must be a controlled classification.
    const measured = await api.post(`/api/reports/kpis/${kpiId}/measure`).set(auth(token)).send({ period: '2026-08' });
    expect(measured.status).toBe(200);
    const m = (measured.body.data as Row).measurement as Row;
    expect(Number.isFinite(Number((m.actualValue as string)))).toBe(true);
    expect(['EXCELLENT', 'ON_TARGET', 'WARNING', 'CRITICAL', 'NO_DATA']).toContain(m.status);

    // Measurement history persists.
    const hist = await api.get(`/api/reports/kpis/${kpiId}/measurements`).set(auth(token));
    expect(hist.status).toBe(200);
    expect((hist.body.data as Row[]).length).toBeGreaterThanOrEqual(1);

    // Duplicate key is rejected; malformed key is rejected.
    const dup = await api.post('/api/reports/kpis').set(auth(token)).send({ key, dataSource: 'v_sales_by_month' });
    expect(dup.status).toBe(400);
    const bad = await api.post('/api/reports/kpis').set(auth(token)).send({ key: 'BAD KEY!', dataSource: 'v_sales_by_month' });
    expect(bad.status).toBe(400);

    // Archive (soft delete) keeps history queryable.
    const archived = await api.delete(`/api/reports/kpis/${kpiId}`).set(auth(token));
    expect(archived.status).toBe(200);

    // RBAC: an unprivileged user cannot list or create KPIs.
    const { token: sales } = await loginAs('sarah.sales');
    const deniedList = await api.get('/api/reports/kpis').set(auth(sales));
    expect(deniedList.status).toBe(403);
    const deniedCreate = await api.post('/api/reports/kpis').set(auth(sales)).send({ key: uniq('x'), dataSource: 'v_sales_by_month' });
    expect(deniedCreate.status).toBe(403);

    // Cleanup: hard-delete test rows in FK order (audit trigger tolerates it).
    await db(`DELETE FROM analytics_kpi_measurements WHERE kpi_id = $1`, [kpiId]);
    await db(`DELETE FROM analytics_kpi_targets WHERE kpi_id = $1`, [kpiId]);
    await db(`DELETE FROM analytics_kpis WHERE id = $1`, [kpiId]);
  });

  it('manages dashboards: create with widgets, replace widget set, fetch, archive; RBAC denied', async () => {
    const { token } = await loginAs('admin');
    const kpis = await api.get('/api/reports/kpis').set(auth(token));
    const stockKpi = (kpis.body.data as Row[]).find((k) => k.key === 'stock_value');
    expect(stockKpi).toBeTruthy();
    const stockKpiId = Number((stockKpi as Row).id);

    const name = uniq('Dashboard');
    const created = await api.post('/api/reports/dashboards').set(auth(token)).send({
      name,
      description: 'Created by reports.analytics test',
      widgets: [
        { widgetType: 'KPI', title: 'Stock Value', kpiId: stockKpiId },
        { widgetType: 'REPORT', title: 'Trial Balance', reportName: 'trial-balance' },
      ],
    });
    expect(created.status).toBe(200);
    const dashId = Number((created.body.data as Row).id);
    expect(((created.body.data as Row).widgets as Row[]).length).toBe(2);

    // Full-replace the widget set (PATCH sends widgets without ids).
    const replaced = await api.patch(`/api/reports/dashboards/${dashId}`).set(auth(token)).send({
      name,
      widgets: [{ widgetType: 'CHART', title: 'Revenue Trend', kpiId: stockKpiId }],
    });
    expect(replaced.status).toBe(200);
    expect(((replaced.body.data as Row).widgets as Row[]).length).toBe(1);
    expect((((replaced.body.data as Row).widgets as Row[])[0] as Row).widgetType).toBe('CHART');

    const got = await api.get(`/api/reports/dashboards/${dashId}`).set(auth(token));
    expect(got.status).toBe(200);
    expect((got.body.data as Row).name).toBe(name);

    const archived = await api.delete(`/api/reports/dashboards/${dashId}`).set(auth(token));
    expect(archived.status).toBe(200);

    const { token: sales } = await loginAs('sarah.sales');
    const denied = await api.post('/api/reports/dashboards').set(auth(sales)).send({ name: 'Nope' });
    expect(denied.status).toBe(403);

    await db(`DELETE FROM analytics_dashboard_widgets WHERE dashboard_id = $1`, [dashId]);
    await db(`DELETE FROM analytics_dashboards WHERE id = $1`, [dashId]);
  });

  it('custom report builder: sources, create, run against live data, validate; RBAC denied', async () => {
    const { token } = await loginAs('admin');

    const sources = await api.get('/api/reports/sources').set(auth(token));
    expect(sources.status).toBe(200);
    const names = (sources.body.data as Row[]).map((s) => s.name);
    expect(names).toContain('v_sales_by_month');
    expect(names).toContain('work_orders');

    const name = uniq('Test Sales Trend');
    const created = await api.post('/api/reports/custom').set(auth(token)).send({
      name,
      description: 'Created by reports.analytics test',
      dataSource: 'v_sales_by_month',
      visualization: 'bar',
      config: {
        columns: ['month', 'revenue', 'invoice_count'],
        groupBy: [],
        sort: { column: 'month', direction: 'asc' },
        limit: 10,
      },
    });
    expect(created.status).toBe(200);
    const customId = Number((created.body.data as Row).id);

    const run = await api.post(`/api/reports/custom/${customId}/run`).set(auth(token)).send({});
    expect(run.status).toBe(200);
    const out = run.body.data as Row;
    expect(Array.isArray(out.rows)).toBe(true);
    expect(out.columns).toContain('month');
    expect(Number(out.count)).toBe((out.rows as Row[]).length);

    // At least one visible column is required.
    const bad = await api.post('/api/reports/custom').set(auth(token)).send({
      name: uniq('Bad'),
      dataSource: 'v_sales_by_month',
      visualization: 'table',
      config: { columns: [], limit: 5 },
    });
    expect(bad.status).toBe(400);

    const archived = await api.delete(`/api/reports/custom/${customId}`).set(auth(token));
    expect(archived.status).toBe(200);

    const { token: sales } = await loginAs('sarah.sales');
    const denied = await api.post('/api/reports/custom').set(auth(sales)).send({
      name: 'Nope',
      dataSource: 'v_sales_by_month',
      visualization: 'table',
      config: { columns: ['month'], limit: 5 },
    });
    expect(denied.status).toBe(403);

    await db(`DELETE FROM custom_reports WHERE id = $1`, [customId]);
  });
});
