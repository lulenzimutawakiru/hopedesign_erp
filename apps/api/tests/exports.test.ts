import { describe, it, expect } from 'vitest';
import { api, auth, loginAs } from './helpers.js';

describe('data exports: formats, tenant info and audit trail', () => {
  it('lists exportable tables including the ream/carton domain tables', async () => {
    const { token } = await loginAs('admin');
    const res = await api.get('/api/import-export/exports/tables').set(auth(token));
    expect(res.status).toBe(200);
    const tables = res.body.data as { table: string; label: string }[];
    const names = tables.map((t) => t.table);
    expect(names).toContain('customers');
    expect(names).toContain('reams');
    expect(names).toContain('cartons');
    expect(names).toContain('qr_codes');
  });

  it('exports customers as CSV with the csv content type', async () => {
    const { token } = await loginAs('admin');
    const res = await api.get('/api/import-export/exports/customers?format=csv').set(auth(token));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const csv = res.text;
    expect(csv.length).toBeGreaterThan(0);
    expect(csv.split('\n').length).toBeGreaterThan(1);
  });

  it('exports customers as XLSX with the spreadsheet content type', async () => {
    const { token } = await loginAs('admin');
    const res = await api.get('/api/import-export/exports/customers?format=xlsx').set(auth(token));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(Number(res.headers['content-length'] ?? 0)).toBeGreaterThan(0);
  });

  it('exports customers as JSON with a data array and meta', async () => {
    const { token } = await loginAs('admin');
    const res = await api.get('/api/import-export/exports/customers?format=json').set(auth(token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.meta.format).toBe('json');
    expect(res.body.meta.table).toBe('customers');
  });

  it('includes tenant/company/branch info when includeTenant=1', async () => {
    const { token } = await loginAs('admin');
    const csvRes = await api.get('/api/import-export/exports/customers?format=csv&includeTenant=1').set(auth(token));
    expect(csvRes.status).toBe(200);
    expect(csvRes.text).toContain('Tenant Code');
    expect(csvRes.text).toContain('Tenant Name');
    expect(csvRes.text).toContain('Company Code');
    expect(csvRes.text).toContain('Exported By');

    const jsonRes = await api.get('/api/import-export/exports/customers?format=json&includeTenant=1').set(auth(token));
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.body.meta.tenant.tenantCode).toBeTruthy();
    expect(jsonRes.body.meta.tenant.companyCode).toBeTruthy();
    expect(jsonRes.body.meta.tenant.exportedBy).toBeTruthy();
  });

  it('never leaks QR secrets in exported files', async () => {
    const { token } = await loginAs('admin');
    const res = await api.get('/api/import-export/exports/qr_codes?format=csv').set(auth(token));
    expect(res.status).toBe(200);
    const firstLine = res.text.split('\n')[0].toLowerCase();
    expect(firstLine).not.toContain('secret');
    expect(res.text).not.toContain('secret_hash');
  });

  it('records who exported, what format and when in the history endpoint', async () => {
    const { token } = await loginAs('admin');
    await api.get('/api/import-export/exports/reams?format=xlsx&includeTenant=1').set(auth(token));
    const history = await api.get('/api/import-export/exports/history').set(auth(token));
    expect(history.status).toBe(200);
    const entry = (history.body.data as Record<string, unknown>[]).find(
      (h) => h.resource === 'reams' && h.action === 'export' && h.format === 'xlsx'
    );
    expect(entry).toBeTruthy();
    expect(entry!.user).toBeTruthy();
    expect(entry!.rows).toBeGreaterThan(0);
    expect(entry!.tenantCode).toBeTruthy();
    expect(entry!.companyCode).toBeTruthy();
  });

  it('audits report exports and print view with the acting user', async () => {
    const { token } = await loginAs('admin');
    const csv = await api.get('/api/reports/inventory-summary?format=csv').set(auth(token));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');

    const print = await api.get('/api/reports/inventory-summary?format=print').set(auth(token));
    expect(print.status).toBe(200);
    expect(print.headers['content-type']).toContain('text/html');
    expect(print.text).toContain('Inventory Summary');

    const history = await api.get('/api/import-export/exports/history').set(auth(token));
    const exportEntry = (history.body.data as Record<string, unknown>[]).find(
      (h) => h.resource === 'inventory-summary' && h.action === 'export' && h.format === 'csv'
    );
    expect(exportEntry).toBeTruthy();
    const printEntry = (history.body.data as Record<string, unknown>[]).find(
      (h) => h.resource === 'inventory-summary' && h.action === 'print'
    );
    expect(printEntry).toBeTruthy();
  });
});
