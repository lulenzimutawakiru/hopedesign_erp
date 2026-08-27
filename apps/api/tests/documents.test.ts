import { describe, it, expect } from 'vitest';
import { api, auth, loginAs, pool, db, deleteEmployees } from './helpers.js';

async function asTenant(tenantId: number, companyId: number, sql: string, params: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_app_context($1,$2,NULL,NULL)', [tenantId, companyId]);
    const res = await client.query(sql, params);
    await client.query('COMMIT');
    return res;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

describe('branded document exports', () => {
  async function quotationId(token: string): Promise<number> {
    const create = await api.post('/api/ops/sales/quotations').set(auth(token)).send({
      customerId: 1,
      items: [{ productId: 3, quantity: 2, unitPrice: 12500, taxPercent: 18 }],
    });
    expect(create.status).toBe(200);
    return Number(create.body.data.quotationId);
  }

  it('exports a quotation PDF with company letterhead and document title', async () => {
    const { token } = await loginAs('sarah.sales');
    const id = await quotationId(token);
    const res = await api.get(`/api/documents/sales-quotation/${id}?format=pdf`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    const buf = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const text = buf.toString('latin1');
    expect(text).toContain('Hope Design Group Ltd');
    expect(text).toContain('QUOTATION');
    expect(text).toContain('TIN');
    expect(text).toContain('BILL TO');
    expect(text).toContain('DOCUMENT AUTHENTICITY');
  });

  it('exports quotation JSON with company branding and party metadata', async () => {
    const { token } = await loginAs('sarah.sales');
    const id = await quotationId(token);
    const res = await api.get(`/api/documents/sales-quotation/${id}?format=json`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.meta.company.name).toMatch(/Hope Design/);
    expect(res.body.meta.company.tin).toBeTruthy();
    expect(res.body.meta.company.legalName).toBeTruthy();
    expect(res.body.meta.company.brandColor).toMatch(/^#[0-9a-f]{6}$/i);
    expect(res.body.meta.company.brandColorSecondary).toMatch(/^#[0-9a-f]{6}$/i);
    expect(typeof res.body.meta.company.logoUrl).toBe('string');
    expect(res.body.meta.title).toBe('Quotation');
    expect(res.body.meta.docNo).toBeTruthy();
    expect(Array.isArray(res.body.meta.parties)).toBe(true);
    expect(res.body.meta.authenticity.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.meta.authenticity.verifyUrl).toContain('#doc=');
  });

  it('prints a report with the formal letterhead and authenticity block', async () => {
    const { token } = await loginAs('admin');
    const print = await api.get('/api/reports/inventory-summary?format=print').set(auth(token));
    expect(print.status).toBe(200);
    expect(print.headers['content-type']).toContain('text/html');
    expect(print.text).toContain('Inventory Summary');
    expect(print.text).toContain('letterhead');
    expect(print.text).toContain('Hope Design Group Ltd');
    expect(print.text).toContain('--navy: #');
    expect(print.text).toContain('--teal: #');
    // The letterhead renders the brand mark, or the uploaded logo when one is configured.
    expect(print.text).toMatch(/class="brand-(mark|logo)"/);
    expect(print.text).toContain('TIN');
    expect(print.text).toContain('Management report');
    expect(print.text).toContain('Document authenticity');
  });

  it('uses saved brand colours and logo in exports, falling back when unset', async () => {
    const { token } = await loginAs('admin');
    // Uploaded brand files survive settings resets, so clear any leftover state explicitly.
    await api.delete('/api/settings/logo').set(auth(token));
    await api.delete('/api/settings/favicon').set(auth(token));
    await api.delete('/api/settings/signature').set(auth(token));
    await api.delete('/api/settings/footer-logo').set(auth(token));
    await api.post('/api/settings/reset').set(auth(token)).send({ category: 'general' });

    const plain = await api.get('/api/reports/inventory-summary?format=print').set(auth(token));
    expect(plain.status).toBe(200);
    expect(plain.text).toContain('--navy: #1261A0');
    expect(plain.text).toContain('--teal: #00A6A6');
    expect(plain.text).not.toContain('class="brand-logo"');
    expect(plain.text).toContain('class="brand-mark"');
    expect(plain.text).not.toContain('class="foot-logo"');

    const set = await api.patch('/api/settings').set(auth(token)).send({
      category: 'general',
      values: {
        brand_color: '#123456',
        brand_color_secondary: '#654321',
        logo_url: 'https://example.com/hope-logo.png',
        footer_logo_url: 'https://example.com/hope-footer-logo.png',
      },
    });
    expect(set.status).toBe(200);

    const id = await quotationId(token);
    const json = await api.get(`/api/documents/sales-quotation/${id}?format=json`).set(auth(token));
    expect(json.status).toBe(200);
    expect(json.body.meta.company.brandColor).toBe('#123456');
    expect(json.body.meta.company.brandColorSecondary).toBe('#654321');
    expect(json.body.meta.company.logoUrl).toBe('https://example.com/hope-logo.png');

    const print = await api.get('/api/reports/inventory-summary?format=print').set(auth(token));
    expect(print.status).toBe(200);
    expect(print.text).toContain('--navy: #123456');
    expect(print.text).toContain('--teal: #654321');
    expect(print.text).toContain('class="brand-logo"');
    expect(print.text).toContain('hope-logo.png');
    expect(print.text).toContain('class="foot-logo"');
    expect(print.text).toContain('hope-footer-logo.png');

    await api.post('/api/settings/reset').set(auth(token)).send({ category: 'general' });
    await api.delete('/api/settings/logo').set(auth(token));
    await api.delete('/api/settings/footer-logo').set(auth(token));
  });
});

describe('finance document exports in all formats', () => {
  async function expenseId(token: string): Promise<number> {
    const accts = await api.get('/api/ops/finance/accounts').set(auth(token));
    const expAcct = accts.body.data.find((a: { code: string }) => a.code === '6100');
    expect(expAcct).toBeTruthy();
    const res = await api.post('/api/ops/finance/expenses').set(auth(token)).send({
      expenseDate: '2026-08-20',
      accountId: expAcct.id,
      amount: 120000,
      vendor: 'Doc Test Vendor',
      reference: `DOC-EXP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      method: 'CASH',
      description: 'Stationery purchase',
    });
    expect(res.status).toBe(200);
    return Number(res.body.data.expenseId);
  }

  async function budget(token: string): Promise<{ id: number; tenantId: number; companyId: number }> {
    const accts = await api.get('/api/ops/finance/accounts').set(auth(token));
    const expenseAccts = accts.body.data.filter(
      (a: { accountType: string; isPosting: boolean }) => a.accountType === 'EXPENSE' && a.isPosting
    );
    expect(expenseAccts.length).toBeGreaterThan(0);
    const res = await api.post('/api/ops/finance/budgets').set(auth(token)).send({
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      status: 'DRAFT',
      lines: [{ accountId: expenseAccts[0].id, amount: 500000 }],
    });
    expect(res.status).toBe(200);
    return res.body.data.budget;
  }

  it('exports an expense in PDF, Excel, CSV, and JSON', async () => {
    const { token } = await loginAs('admin');
    const id = await expenseId(token);

    const pdf = await api.get(`/api/documents/expense/${id}?format=pdf`).set(auth(token));
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const buf = Buffer.isBuffer(pdf.body) ? pdf.body : Buffer.from(pdf.body);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buf.toString('latin1')).toContain('EXPENSE VOUCHER');

    const xlsx = await api.get(`/api/documents/expense/${id}?format=xlsx`).set(auth(token));
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');

    const csv = await api.get(`/api/documents/expense/${id}?format=csv`).set(auth(token));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('EXPENSE VOUCHER');

    const json = await api.get(`/api/documents/expense/${id}?format=json`).set(auth(token));
    expect(json.status).toBe(200);
    expect(json.body.meta.title).toBe('Expense Voucher');
    expect(json.body.meta.docNo).toBeTruthy();
    expect(json.body.meta.authenticity.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('exports a budget in PDF, Excel, CSV, and JSON', async () => {
    const { token } = await loginAs('admin');
    const created = await budget(token);
    try {
      const pdf = await api.get(`/api/documents/budget/${created.id}?format=pdf`).set(auth(token));
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      const buf = Buffer.isBuffer(pdf.body) ? pdf.body : Buffer.from(pdf.body);
      expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');

      const xlsx = await api.get(`/api/documents/budget/${created.id}?format=xlsx`).set(auth(token));
      expect(xlsx.status).toBe(200);
      expect(xlsx.headers['content-type']).toContain('spreadsheetml');

      const csv = await api.get(`/api/documents/budget/${created.id}?format=csv`).set(auth(token));
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.text).toContain('BUDGET');

      const json = await api.get(`/api/documents/budget/${created.id}?format=json`).set(auth(token));
      expect(json.status).toBe(200);
      expect(json.body.meta.title).toBe('Budget');
      expect(json.body.meta.docNo).toBeTruthy();
    } finally {
      await asTenant(created.tenantId, created.companyId, 'DELETE FROM budgets WHERE id = $1', [created.id]);
    }
  });
});

describe('payslip document exports', () => {
  it('prints and downloads a branded confidential payslip from a calculated run', async () => {
    const { token } = await loginAs('hr.hannah');
    const emp = await api.post('/api/ops/hr/employees').set(auth(token)).send({
      firstName: 'Payslip',
      lastName: `Doc${Date.now()}`,
      position: 'Clerk',
      baseSalary: 3000000,
      bankName: 'Stanbic',
      bankAccountNo: '0987654321',
      tin: '1234567893',
      nssfNo: 'NSSF-99001',
    });
    expect(emp.status).toBe(200);
    const employeeId = Number(emp.body.data.employeeId);

    const group = await db(
      `INSERT INTO payroll_groups (company_id, tenant_id, code, name, frequency, salary_currency, status)
       VALUES ((SELECT company_id FROM employees WHERE id=$1),(SELECT tenant_id FROM employees WHERE id=$1),$2,'Payslip Doc Group','MONTHLY','UGX','ACTIVE')
       RETURNING id`,
      [employeeId, `PSDOC-${Date.now()}`]
    );
    const groupId = Number(group.rows[0].id);
    await db(
      `INSERT INTO employee_payroll_profiles (company_id, tenant_id, employee_id, payroll_group_id, payment_method, currency, status)
       VALUES ((SELECT company_id FROM employees WHERE id=$1),(SELECT tenant_id FROM employees WHERE id=$1),$1,$2,'BANK_TRANSFER','UGX','ACTIVE')`,
      [employeeId, groupId]
    );

    const day = String(10 + Math.floor(Math.random() * 18)).padStart(2, '0');
    const run = await api.post('/api/ops/hr/payrolls').set(auth(token)).send({
      periodStart: `2027-11-${day}`,
      periodEnd: `2027-11-${day}`,
      payrollGroupId: groupId,
    });
    expect(run.status).toBe(200);
    const payrollId = Number(run.body.data.payrollId);

    const detail = await api.get(`/api/ops/hr/payrolls/${payrollId}`).set(auth(token));
    expect(detail.status).toBe(200);
    const items = detail.body.data.items as { id: string | number; employeeId: string; payslipNo: string; netPay: string }[];
    const mine = items.find((i) => Number(i.employeeId) === employeeId);
    expect(mine).toBeTruthy();
    const slipId = Number(mine!.id);

    try {
      const json = await api.get(`/api/documents/payslip/${slipId}?format=json`).set(auth(token));
      expect(json.status).toBe(200);
      expect(json.body.meta.title).toBe('Payslip');
      expect(json.body.meta.docNo).toBe(mine!.payslipNo);
      expect(json.body.meta.classification).toBe('Confidential');
      expect(json.body.meta.company.name).toMatch(/Hope Design/);
      expect(Array.isArray(json.body.meta.parties)).toBe(true);
      expect(json.body.meta.parties.some((p: { heading: string }) => p.heading === 'Employee')).toBe(true);

      const pdf = await api.get(`/api/documents/payslip/${slipId}?format=pdf`).set(auth(token));
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      const buf = Buffer.isBuffer(pdf.body) ? pdf.body : Buffer.from(pdf.body);
      expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      const text = buf.toString('latin1');
      expect(text).toContain('PAYSLIP');
      expect(text).toContain('Hope Design Group Ltd');
      expect(text).toContain('PAYE');
      expect(text).toContain('NSSF');
      expect(text).toContain('CONFIDENTIAL');
      expect(text).toContain(mine!.payslipNo);
      // Watermark must paint behind the body text: its op sits at the start of
      // the page content stream, before the document heading. It is drawn as a
      // professional security pattern: the label repeats across the page, so
      // more than one copy appears in the stream.
      // Image XObjects (photo / QR) are emitted before page content streams, so
      // locate the page-1 content stream by its heading text.
      const streams = Array.from(text.matchAll(/stream\r?\n([\s\S]*?)endstream/g), (m) => m[1]);
      const page1 = streams.find((s) => s.includes('PAYSLIP')) ?? streams[0] ?? '';
      const labelTj = '(CONFIDENTIAL) Tj';
      expect(page1.split(labelTj).length - 1).toBeGreaterThan(1);
      expect(text.indexOf('CONFIDENTIAL')).toBeGreaterThanOrEqual(0);
      expect(text.indexOf('CONFIDENTIAL')).toBeLessThan(text.indexOf('PAYSLIP'));

      const printed = await api.get(`/api/documents/payslip/${slipId}?format=print`).set(auth(token));
      expect(printed.status).toBe(200);
      expect(printed.headers['content-type']).toContain('text/html');
      expect(printed.text).toContain('Payslip');
      expect(printed.text).toContain('letterhead');
      expect(printed.text).toContain('Hope Design Group Ltd');
      expect(printed.text).toContain('Earnings and deductions');
      expect(printed.text).toContain('PAYE');
      expect(printed.text).toContain('Confidential');
      expect(printed.text).not.toContain('0987654321');
      expect(printed.text).toContain('****4321');

      const unknown = await api.get('/api/documents/payslip/99999999?format=json').set(auth(token));
      expect(unknown.status).toBe(404);
    } finally {
      await db(`DELETE FROM payrolls WHERE id = $1`, [payrollId]);
      await db(`DELETE FROM employee_payroll_profiles WHERE employee_id = $1`, [employeeId]);
      await deleteEmployees([employeeId]);
      await db(`DELETE FROM payroll_groups WHERE id = $1`, [groupId]);
    }
  }, 30_000);
});
