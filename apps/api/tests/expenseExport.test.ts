import { describe, expect, it } from 'vitest';
import { exportExpenses } from '../src/services/expenseExport.js';

const companyCtx = { tenantId: 7, companyId: 3, userId: 8 } as any;

describe('expense export', () => {
  it('limits format, validates date ranges, and emits escaped CSV', async () => {
    const client = {
      query: async (sql: string, params: unknown[]) => {
        if (sql.includes('SELECT')) return { rows: [{ 'Expense No': 'EXP-1', Description: '=HYPERLINK("bad")', Amount: '42.50' }] };
        return { rows: [] };
      },
    } as any;
    const result = await exportExpenses(client, companyCtx, { format: 'csv', from: '2026-01-01', to: '2026-01-31' });
    expect(result.format).toBe('csv');
    expect(result.content).toContain("'=HYPERLINK(\"\"bad\"\")");
    expect(result.rowCount).toBe(1);
  });

  it('rejects unsupported formats and invalid date ranges', async () => {
    const client = { query: async () => ({ rows: [] }) } as any;
    await expect(exportExpenses(client, companyCtx, { format: 'xlsx' })).rejects.toThrow(/csv or json/);
    await expect(exportExpenses(client, companyCtx, { from: '2026-02-01', to: '2026-01-01' })).rejects.toThrow(/on or before/);
    await expect(exportExpenses(client, companyCtx, { from: 'not-a-date' })).rejects.toThrow(/YYYY-MM-DD/);
  });
});
