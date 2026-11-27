// A failed OCR statement used to abort the upload transaction, so the catch
// that marked the receipt FAILED never committed and the expense lost its file.
// These tests use a client that refuses every statement after a failure until
// ROLLBACK TO SAVEPOINT, the same rule Postgres applies.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ocrMock = vi.fn();

vi.mock('../src/services/expenseOcr.js', () => ({
  runReceiptOcr: (...args: unknown[]) => ocrMock(...args),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn() };
});

import { uploadReceipt } from '../src/services/expenses.js';

interface RecordedQuery {
  text: string;
  params: unknown[];
}

function collapsing(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function client(options: { failStatus?: boolean } = {}) {
  const queries: RecordedQuery[] = [];
  let aborted = false;
  return {
    queries,
    query: vi.fn(async (text: string, params: unknown[] = []) => {
      const sql = collapsing(text);
      queries.push({ text: sql, params });
      if (aborted && !/^ROLLBACK TO SAVEPOINT/i.test(sql)) {
        throw new Error('current transaction is aborted, commands ignored until end of transaction block');
      }
      if (/^ROLLBACK TO SAVEPOINT/i.test(sql)) {
        aborted = false;
        return { rows: [] };
      }
      if (/updated_at/i.test(sql)) {
        aborted = true;
        throw new Error('column "updated_at" of relation "expense_receipts" does not exist');
      }
      if (options.failStatus && /ocr_status = 'FAILED'/i.test(sql)) {
        aborted = true;
        throw new Error('column "ocr_status" of relation "expense_receipts" does not exist');
      }
      if (/SELECT created_by FROM expense_transactions/i.test(sql)) {
        return { rows: [{ created_by: 7 }] };
      }
      if (/INSERT INTO expense_receipts/i.test(sql)) {
        return { rows: [{ id: 42 }] };
      }
      if (/SELECT \* FROM expense_receipts/i.test(sql)) {
        return {
          rows: [{
            id: 42,
            file_name: 'note.pdf',
            ocr_status: options.failStatus ? 'PENDING' : 'FAILED',
            tenant_id: 1,
            company_id: 2,
          }],
        };
      }
      return { rows: [] };
    }),
  };
}

const ctx = { tenantId: 1, companyId: 2, userId: 7 };
const file = { originalname: 'note.pdf', mimetype: 'application/pdf', size: 4, buffer: Buffer.from('test') };

describe('receipt upload survives a failed scan', () => {
  beforeEach(() => {
    ocrMock.mockReset();
  });

  it('keeps the receipt when the scan statement aborts the transaction', async () => {
    ocrMock.mockImplementation(async (db: { query: (text: string, params?: unknown[]) => Promise<unknown> }) => {
      await db.query('UPDATE expense_receipts SET updated_at = now() WHERE id = $1', [42]);
      return { id: 42 };
    });
    const db = client();
    const out = await uploadReceipt(db as never, ctx, { refType: 'EXPENSE', refId: 9, file });
    expect(out.id).toBe(42);
    expect(out.ocrStatus).toBe('FAILED');
    const sql = db.queries.map((q) => q.text);
    const rollback = sql.findIndex((q) => q === 'ROLLBACK TO SAVEPOINT receipt_ocr');
    const failed = sql.findIndex((q) => q.includes("ocr_status = 'FAILED'"));
    expect(rollback).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(rollback);
    expect(db.queries[failed].params).toEqual([42, 1, 2]);
  });

  it('keeps the receipt when the failed mark itself is rejected', async () => {
    ocrMock.mockImplementation(async (db: { query: (text: string, params?: unknown[]) => Promise<unknown> }) => {
      await db.query('UPDATE expense_receipts SET updated_at = now() WHERE id = $1', [42]);
      return { id: 42 };
    });
    const db = client({ failStatus: true });
    const out = await uploadReceipt(db as never, ctx, { refType: 'EXPENSE', refId: 9, file });
    expect(out.id).toBe(42);
    expect(out.ocrStatus).toBe('PENDING');
    expect(db.queries.some((q) => q.text === 'ROLLBACK TO SAVEPOINT receipt_ocr_status')).toBe(true);
  });

  it('releases the savepoint when the scan succeeds', async () => {
    ocrMock.mockResolvedValue({ id: 42, ocrStatus: 'EXTRACTED', fileName: 'note.pdf' });
    const db = client();
    const out = await uploadReceipt(db as never, ctx, { refType: 'EXPENSE', refId: 9, file });
    expect(out.ocrStatus).toBe('EXTRACTED');
    expect(db.queries.some((q) => q.text === 'RELEASE SAVEPOINT receipt_ocr')).toBe(true);
    expect(db.queries.some((q) => q.text.includes("ocr_status = 'FAILED'"))).toBe(false);
  });
});
