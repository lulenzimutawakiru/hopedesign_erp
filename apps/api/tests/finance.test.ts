import { describe, it, expect } from 'vitest';
import { api, auth, loginAs, pool } from './helpers.js';

describe('Finance double-entry ledger', () => {
  it('rejects an unbalanced journal and posts a balanced one', async () => {
    const { token } = await loginAs('admin');
    const accts = await api.get('/api/ops/finance/accounts').set(auth(token));
    expect(accts.status).toBe(200);
    const bank = accts.body.data.find((a: { code: string }) => a.code === '1100');
    const cash = accts.body.data.find((a: { code: string }) => a.code === '1200');
    expect(bank && cash).toBeTruthy();

    const bad = await api.post('/api/ops/finance/journals').set(auth(token)).send({
      entryDate: '2026-08-18',
      description: 'Unbalanced test',
      post: true,
      lines: [
        { accountId: bank.id, debit: 1000, credit: 0 },
        { accountId: cash.id, debit: 0, credit: 1 },
      ],
    });
    expect(bad.status).toBe(400);

    const ok = await api.post('/api/ops/finance/journals').set(auth(token)).send({
      entryDate: '2026-08-18',
      description: 'Treasury transfer test',
      post: true,
      lines: [
        { accountId: cash.id, debit: 25000, credit: 0 },
        { accountId: bank.id, debit: 0, credit: 25000 },
      ],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.entryId).toBeTruthy();
    expect(ok.body.data.status).toBe('POSTED');

    const detail = await api.get(`/api/ops/finance/journals/${ok.body.data.entryId}`).set(auth(token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.journal.status).toBe('POSTED');
    expect(Number(detail.body.data.journal.totalDebit)).toBe(25000);
    expect(Number(detail.body.data.journal.totalCredit)).toBe(25000);
    expect(detail.body.data.lines.length).toBe(2);
  });

  it('keeps the trial balance in balance and exposes AR/AP/cash', async () => {
    const { token } = await loginAs('admin');
    const tb = await api.get('/api/ops/finance/trial-balance').set(auth(token));
    expect(tb.status).toBe(200);
    const { debit, credit } = tb.body.data.totals;
    expect(Math.round(Number(debit) * 100)).toBe(Math.round(Number(credit) * 100));

    const summary = await api.get('/api/ops/finance/summary').set(auth(token));
    expect(summary.status).toBe(200);
    expect(summary.body.data.trialBalanceOk).toBe(true);

    const banks = await api.get('/api/ops/finance/banks').set(auth(token));
    expect(banks.status).toBe(200);
    expect(Array.isArray(banks.body.data.rows)).toBe(true);

    const ar = await api.get('/api/ops/finance/ar').set(auth(token));
    expect(ar.status).toBe(200);
    const ap = await api.get('/api/ops/finance/ap').set(auth(token));
    expect(ap.status).toBe(200);
  });

  it('blocks posting into a locked period and allows reopen', async () => {
    const { token } = await loginAs('admin');
    const periods = await api.get('/api/ops/finance/periods').set(auth(token));
    expect(periods.status).toBe(200);
    const covers = (p: { startDate: string; endDate: string }, day: string) => {
      const s = String(p.startDate).slice(0, 10);
      const e = String(p.endDate).slice(0, 10);
      return s <= day && e >= day;
    };
    const aug = periods.body.data.find((p: { startDate: string; endDate: string }) => covers(p, '2026-08-18'));
    expect(aug).toBeTruthy();

    const lock = await api.post(`/api/ops/finance/periods/${aug.id}/lock`).set(auth(token)).send({});
    expect(lock.status).toBe(200);
    expect(lock.body.data.status).toBe('LOCKED');

    const accts = await api.get('/api/ops/finance/accounts').set(auth(token));
    const bank = accts.body.data.find((a: { code: string }) => a.code === '1100');
    const cash = accts.body.data.find((a: { code: string }) => a.code === '1200');
    const blocked = await api.post('/api/ops/finance/journals').set(auth(token)).send({
      entryDate: '2026-08-18',
      description: 'Should fail in locked period',
      post: true,
      lines: [
        { accountId: cash.id, debit: 10, credit: 0 },
        { accountId: bank.id, debit: 0, credit: 10 },
      ],
    });
    expect(blocked.status).toBe(400);

    const open = await api.post(`/api/ops/finance/periods/${aug.id}/open`).set(auth(token)).send({});
    expect(open.status).toBe(200);
    expect(open.body.data.status).toBe('OPEN');
  });
});

/** Run a statement as the admin tenant so RLS lets us insert/delete test rows. */
async function execAsTenant(tenantId: number, companyId: number, sql: string, params: unknown[] = []) {
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

const uniqueSuffix = () => Math.random().toString(36).slice(2, 8).toUpperCase();

describe('Finance CRUD+ workflows', () => {
  it('creates, updates, and deactivates a chart of accounts entry', async () => {
    const { token } = await loginAs('admin');
    const code = `T${uniqueSuffix()}`;
    let created: { id: number; tenantId: number; companyId: number; isActive: boolean; code: string } | undefined;
    try {
      const res = await api.post('/api/ops/finance/accounts').set(auth(token)).send({
        code,
        name: 'Test Account',
        accountType: 'EXPENSE',
        subtype: 'EXPENSE',
        isPosting: true,
        currency: 'UGX',
      });
      expect(res.status).toBe(200);
      created = res.body.data;
      expect(created.code).toBe(code);
      expect(created.isActive).toBe(true);

      const patched = await api.patch(`/api/ops/finance/accounts/${created.id}`).set(auth(token)).send({
        name: 'Test Account Renamed',
        isPosting: false,
      });
      expect(patched.status).toBe(200);
      expect(patched.body.data.name).toBe('Test Account Renamed');
      expect(patched.body.data.isPosting).toBe(false);

      const deact = await api.post(`/api/ops/finance/accounts/${created.id}/deactivate`).set(auth(token)).send({});
      expect(deact.status).toBe(200);
      expect(deact.body.data.isActive).toBe(false);

      const list = await api.get('/api/ops/finance/accounts').set(auth(token));
      const row = list.body.data.find((a: { id: number }) => Number(a.id) === Number(created.id));
      expect(row?.isActive).toBe(false);
    } finally {
      if (created) {
        await execAsTenant(created.tenantId, created.companyId, 'DELETE FROM chart_of_accounts WHERE id = $1', [created.id]);
      }
    }
  });

  it('creates, updates, reconciles transactions for, and deactivates a bank account', async () => {
    const { token } = await loginAs('admin');
    const code = `B${uniqueSuffix()}`;
    let bank: { id: number; tenantId: number; companyId: number; code: string } | undefined;
    let txnId: number | null = null;
    try {
      const res = await api.post('/api/ops/finance/banks').set(auth(token)).send({
        code,
        name: 'Test Bank',
        bankName: 'Test Bank Ltd',
        accountNo: '00000001',
        accountType: 'CURRENT',
        currency: 'UGX',
      });
      expect(res.status).toBe(200);
      bank = res.body.data;
      expect(bank.code).toBe(code);

      const patched = await api.patch(`/api/ops/finance/banks/${bank.id}`).set(auth(token)).send({ name: 'Test Bank Renamed' });
      expect(patched.status).toBe(200);
      expect(patched.body.data.name).toBe('Test Bank Renamed');

      // No API endpoint creates bank transactions, so insert one directly.
      const ins = await execAsTenant(
        bank.tenantId,
        bank.companyId,
        `INSERT INTO bank_transactions (bank_account_id, txn_date, reference, description, debit, credit, reconciled)
         VALUES ($1, '2026-08-20', $2, 'Test deposit', 0, 50000, false) RETURNING id`,
        [bank.id, `TXN-${code}`]
      );
      txnId = Number(ins.rows[0].id);

      const txns = await api.get(`/api/ops/finance/banks/${bank.id}/transactions`).set(auth(token));
      expect(txns.status).toBe(200);
      expect(txns.body.data.length).toBeGreaterThan(0);
      const txn = txns.body.data.find((t: { id: number }) => Number(t.id) === txnId);
      expect(txn).toBeTruthy();
      expect(txn.reconciled).toBe(false);

      const rec = await api.post(`/api/ops/finance/banks/${bank.id}/transactions/${txnId}/reconcile`).set(auth(token)).send({ reconciled: true });
      expect(rec.status).toBe(200);
      expect(rec.body.data.reconciled).toBe(true);

      const deact = await api.post(`/api/ops/finance/banks/${bank.id}/deactivate`).set(auth(token)).send({});
      expect(deact.status).toBe(200);
      expect(deact.body.data.isActive).toBe(false);
    } finally {
      if (bank && txnId) {
        await execAsTenant(bank.tenantId, bank.companyId, 'DELETE FROM bank_transactions WHERE id = $1', [txnId]);
      }
      if (bank) {
        await execAsTenant(bank.tenantId, bank.companyId, 'DELETE FROM bank_accounts WHERE id = $1', [bank.id]);
      }
    }
  });

  it('creates a financial period and rejects overlapping ones', async () => {
    const { token } = await loginAs('admin');
    const code = `FY27-T${uniqueSuffix()}`;
    let period: { id: number; tenantId: number; companyId: number; status: string } | undefined;
    try {
      const res = await api.post('/api/ops/finance/periods').set(auth(token)).send({
        code,
        name: 'Test Period',
        startDate: '2027-08-01',
        endDate: '2027-08-31',
        status: 'OPEN',
      });
      expect(res.status).toBe(200);
      period = res.body.data;
      expect(period.status).toBe('OPEN');

      const dup = await api.post('/api/ops/finance/periods').set(auth(token)).send({
        code: `${code}B`,
        name: 'Overlapping Period',
        startDate: '2027-08-15',
        endDate: '2027-09-15',
      });
      expect(dup.status).toBe(400);

      const list = await api.get('/api/ops/finance/periods').set(auth(token));
      expect(list.body.data.some((p: { code: string }) => p.code === code)).toBe(true);
    } finally {
      if (period) {
        await execAsTenant(period.tenantId, period.companyId, 'DELETE FROM financial_periods WHERE id = $1', [period.id]);
      }
    }
  });

  it('creates, updates, and deactivates a tax code', async () => {
    const { token } = await loginAs('admin');
    const code = `TAX${uniqueSuffix()}`;
    let tax: { id: number; tenantId: number; companyId: number } | undefined;
    try {
      const res = await api.post('/api/ops/finance/taxes').set(auth(token)).send({
        code,
        name: 'Test Tax',
        taxType: 'VAT',
        rate: 5,
      });
      expect(res.status).toBe(200);
      tax = res.body.data;
      expect(Number(tax.rate)).toBe(5);

      const patched = await api.patch(`/api/ops/finance/taxes/${tax.id}`).set(auth(token)).send({
        name: 'Test Tax Updated',
        rate: 7.5,
      });
      expect(patched.status).toBe(200);
      expect(Number(patched.body.data.rate)).toBe(7.5);

      const off = await api.patch(`/api/ops/finance/taxes/${tax.id}`).set(auth(token)).send({ isActive: false });
      expect(off.status).toBe(200);
      expect(off.body.data.isActive).toBe(false);

      const list = await api.get('/api/ops/finance/taxes').set(auth(token));
      const row = list.body.data.find((t: { id: number }) => Number(t.id) === Number(tax.id));
      expect(row?.isActive).toBe(false);
    } finally {
      if (tax) {
        await execAsTenant(tax.tenantId, tax.companyId, 'DELETE FROM taxes WHERE id = $1', [tax.id]);
      }
    }
  });

  it('posts an expense, surfaces it in list/detail, and voids it with a reversal', async () => {
    const { token } = await loginAs('admin');
    const ref = `EXP-${uniqueSuffix()}`;
    const accts = await api.get('/api/ops/finance/accounts').set(auth(token));
    const expAcct = accts.body.data.find((a: { code: string }) => a.code === '6100');
    expect(expAcct).toBeTruthy();

    const res = await api.post('/api/ops/finance/expenses').set(auth(token)).send({
      expenseDate: '2026-08-20',
      accountId: expAcct.id,
      amount: 120000,
      vendor: 'Test Vendor',
      reference: ref,
      method: 'CASH',
      description: 'Stationery purchase',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.expenseId).toBeTruthy();
    expect(res.body.data.expenseNo).toBeTruthy();
    expect(res.body.data.journalId).toBeTruthy();
    const expenseId = res.body.data.expenseId as number;

    const list = await api.get(`/api/ops/finance/expenses?q=${encodeURIComponent(ref)}`).set(auth(token));
    expect(list.status).toBe(200);
    expect(list.body.data.rows.some((e: { id: number }) => Number(e.id) === expenseId)).toBe(true);

    const detail = await api.get(`/api/ops/finance/expenses/${expenseId}`).set(auth(token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.expense.status).toBe('POSTED');
    expect(detail.body.data.journal).toBeTruthy();

    const voided = await api.post(`/api/ops/finance/expenses/${expenseId}/void`).set(auth(token)).send({ reason: 'Wrong vendor' });
    expect(voided.status).toBe(200);
    expect(voided.body.data.status).toBe('VOID');

    const after = await api.get(`/api/ops/finance/expenses/${expenseId}`).set(auth(token));
    expect(after.body.data.expense.status).toBe('VOID');
  });

  it('creates a draft journal, edits it, and posts it', async () => {
    const { token } = await loginAs('admin');
    const accts = await api.get('/api/ops/finance/accounts').set(auth(token));
    const bank = accts.body.data.find((a: { code: string }) => a.code === '1100');
    const cash = accts.body.data.find((a: { code: string }) => a.code === '1200');
    expect(bank && cash).toBeTruthy();

    const draft = await api.post('/api/ops/finance/journals').set(auth(token)).send({
      entryDate: '2026-08-20',
      description: 'Draft transfer',
      post: false,
      lines: [
        { accountId: cash.id, debit: 5000, credit: 0 },
        { accountId: bank.id, debit: 0, credit: 5000 },
      ],
    });
    expect(draft.status).toBe(200);
    expect(draft.body.data.status).toBe('DRAFT');
    const draftId = draft.body.data.entryId as number;

    const edited = await api.patch(`/api/ops/finance/journals/${draftId}`).set(auth(token)).send({
      entryDate: '2026-08-21',
      description: 'Draft transfer (edited)',
      lines: [
        { accountId: cash.id, debit: 7500, credit: 0 },
        { accountId: bank.id, debit: 0, credit: 7500 },
      ],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data.journal.status).toBe('DRAFT');
    expect(edited.body.data.journal.description).toBe('Draft transfer (edited)');
    expect(Number(edited.body.data.journal.totalDebit)).toBe(7500);
    expect(edited.body.data.lines.length).toBe(2);

    const posted = await api.post(`/api/ops/finance/journals/${draftId}/post`).set(auth(token)).send({});
    expect(posted.status).toBe(200);
    expect(posted.body.data.status).toBe('POSTED');
    expect(posted.body.data.entryId).not.toBe(draftId);

    const detail = await api.get(`/api/ops/finance/journals/${posted.body.data.entryId}`).set(auth(token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.journal.status).toBe('POSTED');
    expect(detail.body.data.lines.length).toBe(2);

    // A posted (replaced) draft is no longer editable.
    const locked = await api.patch(`/api/ops/finance/journals/${draftId}`).set(auth(token)).send({ description: 'nope' });
    expect(locked.status).toBe(400);
  });

  it('creates, edits, and workflows a budget through submit/approve/close', async () => {
    const { token } = await loginAs('admin');
    const accts = await api.get('/api/ops/finance/accounts').set(auth(token));
    const expenseAccts = accts.body.data.filter(
      (a: { accountType: string; isPosting: boolean }) => a.accountType === 'EXPENSE' && a.isPosting
    );
    expect(expenseAccts.length).toBeGreaterThan(0);
    const a1 = expenseAccts[0];
    const a2 = expenseAccts[1] ?? expenseAccts[0];

    let budget: { id: number; tenantId: number; companyId: number } | undefined;
    try {
      const res = await api.post('/api/ops/finance/budgets').set(auth(token)).send({
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        status: 'DRAFT',
        lines: [
          { accountId: a1.id, amount: 500000 },
          { accountId: a2.id, amount: 250000 },
        ],
      });
      expect(res.status).toBe(200);
      budget = res.body.data.budget;
      expect(budget.status).toBe('DRAFT');
      expect(res.body.data.lines.length).toBe(2);
      expect(Number(budget.amount)).toBe(750000);

      const patched = await api.patch(`/api/ops/finance/budgets/${budget.id}`).set(auth(token)).send({
        lines: [
          { accountId: a1.id, amount: 600000 },
          { accountId: a2.id, amount: 200000 },
        ],
      });
      expect(patched.status).toBe(200);
      expect(Number(patched.body.data.budget.amount)).toBe(800000);
      expect(patched.body.data.lines.length).toBe(2);

      const submit = await api.post(`/api/ops/finance/budgets/${budget.id}/submit`).set(auth(token)).send({});
      expect(submit.status).toBe(200);
      expect(submit.body.data.budget.status).toBe('SUBMITTED');

      const approve = await api.post(`/api/ops/finance/budgets/${budget.id}/approve`).set(auth(token)).send({});
      expect(approve.status).toBe(200);
      expect(approve.body.data.budget.status).toBe('APPROVED');

      const close = await api.post(`/api/ops/finance/budgets/${budget.id}/close`).set(auth(token)).send({});
      expect(close.status).toBe(200);
      expect(close.body.data.budget.status).toBe('CLOSED');

      // Non-draft budgets cannot be edited.
      const blocked = await api.patch(`/api/ops/finance/budgets/${budget.id}`).set(auth(token)).send({ amount: 1 });
      expect(blocked.status).toBe(400);
    } finally {
      if (budget) {
        await execAsTenant(budget.tenantId, budget.companyId, 'DELETE FROM budgets WHERE id = $1', [budget.id]);
      }
    }
  });

  it('posts an internal cash transfer between bank accounts', async () => {
    const { token } = await loginAs('admin');
    const suffix = uniqueSuffix();
    let from: { id: number; tenantId: number; companyId: number; code: string } | undefined;
    let to: { id: number; tenantId: number; companyId: number; code: string } | undefined;
    let glFrom: { id: number; tenantId: number; companyId: number } | undefined;
    let glTo: { id: number; tenantId: number; companyId: number } | undefined;
    let transferId: number | null = null;
    let journalId: number | null = null;
    try {
      const ga = await api.post('/api/ops/finance/accounts').set(auth(token)).send({
        code: `TSA-${suffix}`,
        name: 'Transfer Source Asset',
        accountType: 'ASSET',
        isPosting: true,
        currency: 'UGX',
      });
      const gb = await api.post('/api/ops/finance/accounts').set(auth(token)).send({
        code: `TTA-${suffix}`,
        name: 'Transfer Target Asset',
        accountType: 'ASSET',
        isPosting: true,
        currency: 'UGX',
      });
      expect(ga.status).toBe(200);
      expect(gb.status).toBe(200);
      glFrom = ga.body.data;
      glTo = gb.body.data;

      const a = await api.post('/api/ops/finance/banks').set(auth(token)).send({
        code: `TFS-${suffix}`,
        name: 'Transfer Source Test',
        accountType: 'CURRENT',
        currency: 'UGX',
        glAccountId: glFrom.id,
      });
      const b = await api.post('/api/ops/finance/banks').set(auth(token)).send({
        code: `TFT-${suffix}`,
        name: 'Transfer Target Test',
        accountType: 'CASH',
        currency: 'UGX',
        glAccountId: glTo.id,
      });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      from = a.body.data;
      to = b.body.data;

      const res = await api.post('/api/ops/finance/banks/transfer').set(auth(token)).send({
        fromBankId: from.id,
        toBankId: to.id,
        amount: 10000,
        transferDate: '2026-08-18',
        reference: `TR-${suffix}`,
        notes: 'Fund petty cash (test)',
      });
      expect(res.status).toBe(200);
      transferId = Number(res.body.data.transferId);
      journalId = Number(res.body.data.journalId);
      expect(transferId).toBeTruthy();
      expect(journalId).toBeTruthy();
      expect(String(res.body.data.transferNo)).toMatch(/^TRF-/);

      const banks = await api.get('/api/ops/finance/banks').set(auth(token));
      const afterFrom = banks.body.data.rows.find((r: { id: number }) => Number(r.id) === Number(from.id));
      const afterTo = banks.body.data.rows.find((r: { id: number }) => Number(r.id) === Number(to.id));
      expect(Number(afterFrom.bookBalance)).toBe(-10000);
      expect(Number(afterTo.bookBalance)).toBe(10000);

      const same = await api.post('/api/ops/finance/banks/transfer').set(auth(token)).send({
        fromBankId: from.id,
        toBankId: from.id,
        amount: 500,
      });
      expect(same.status).toBe(400);

      const list = await api.get('/api/ops/finance/banks/transfers').set(auth(token));
      expect(list.status).toBe(200);
      const t = list.body.data.find((x: { id: number }) => Number(x.id) === transferId);
      expect(t).toBeTruthy();
      expect(String(t.fromCode)).toBe(from.code);
      expect(String(t.toCode)).toBe(to.code);
    } finally {
      if (from && to) {
        await execAsTenant(from.tenantId, from.companyId, 'DELETE FROM bank_transactions WHERE bank_account_id IN ($1,$2)', [from.id, to.id]);
        if (transferId) {
          await execAsTenant(from.tenantId, from.companyId, 'DELETE FROM cash_transfers WHERE id = $1', [transferId]);
        }
        if (journalId) {
          await execAsTenant(from.tenantId, from.companyId, 'DELETE FROM journal_entries WHERE id = $1', [journalId]);
        }
        await execAsTenant(from.tenantId, from.companyId, 'DELETE FROM bank_accounts WHERE id IN ($1,$2)', [from.id, to.id]);
      }
      if (glFrom) {
        await execAsTenant(glFrom.tenantId, glFrom.companyId, 'DELETE FROM chart_of_accounts WHERE id = $1', [glFrom.id]);
      }
      if (glTo) {
        await execAsTenant(glTo.tenantId, glTo.companyId, 'DELETE FROM chart_of_accounts WHERE id = $1', [glTo.id]);
      }
    }
  });
});

describe('Finance AR/AP aging and bank match', () => {
  it('ages open invoices into CURRENT, 1-30, 31-60, 61-90, 91-120 and 120+ buckets', async () => {
    const { token } = await loginAs('admin');
    const periods = await api.get('/api/ops/finance/periods').set(auth(token));
    expect(periods.status).toBe(200);
    const sample = periods.body.data[0] as { tenantId: number; companyId: number };
    const tenantId = Number(sample.tenantId);
    const companyId = Number(sample.companyId);
    expect(tenantId).toBeGreaterThan(0);
    expect(companyId).toBeGreaterThan(0);
    const suffix = uniqueSuffix();
    const nos = ['CURRENT', 'AGING_1_30', 'AGING_31_60', 'AGING_61_90', 'AGING_91_120', 'AGING_120_PLUS'].map(
      (b) => `AR-AGE-${suffix}-${b}`
    );
    try {
      const cust = await execAsTenant(tenantId, companyId, 'SELECT id FROM customers WHERE tenant_id = $1 LIMIT 1', [tenantId]);
      expect(cust.rows.length).toBeGreaterThan(0);
      const customerId = Number(cust.rows[0].id);
      await execAsTenant(
        tenantId,
        companyId,
        `INSERT INTO customer_invoices
           (company_id, tenant_id, invoice_no, customer_id, invoice_date, due_date, status, subtotal, total, amount_paid)
         VALUES
           ($1,$2,$3,$4, CURRENT_DATE, CURRENT_DATE + 10, 'POSTED', 1000, 1000, 0),
           ($1,$2,$5,$4, CURRENT_DATE - 20, CURRENT_DATE - 10, 'POSTED', 2000, 2000, 0),
           ($1,$2,$6,$4, CURRENT_DATE - 50, CURRENT_DATE - 40, 'POSTED', 3000, 3000, 0),
           ($1,$2,$7,$4, CURRENT_DATE - 80, CURRENT_DATE - 70, 'POSTED', 4000, 4000, 0),
           ($1,$2,$8,$4, CURRENT_DATE - 110, CURRENT_DATE - 100, 'POSTED', 5000, 5000, 0),
           ($1,$2,$9,$4, CURRENT_DATE - 150, CURRENT_DATE - 130, 'POSTED', 6000, 6000, 0)`,
        [companyId, tenantId, nos[0], customerId, nos[1], nos[2], nos[3], nos[4], nos[5]]
      );

      const ar = await api.get('/api/ops/finance/ar').set(auth(token));
      expect(ar.status).toBe(200);
      expect(ar.body.data.buckets).toBeTruthy();
      const byNo = new Map(
        (ar.body.data.rows as { invoiceNo: string; bucket: string; isOverdue: boolean; customerId: number }[]).map((r) => [
          r.invoiceNo,
          r,
        ])
      );
      expect(byNo.get(nos[0])?.bucket).toBe('CURRENT');
      expect(byNo.get(nos[0])?.isOverdue).toBe(false);
      expect(byNo.get(nos[1])?.bucket).toBe('AGING_1_30');
      expect(byNo.get(nos[2])?.bucket).toBe('AGING_31_60');
      expect(byNo.get(nos[3])?.bucket).toBe('AGING_61_90');
      expect(byNo.get(nos[4])?.bucket).toBe('AGING_91_120');
      expect(byNo.get(nos[5])?.bucket).toBe('AGING_120_PLUS');
      expect(byNo.get(nos[5])?.isOverdue).toBe(true);
      expect(Number(ar.body.data.buckets.AGING_120_PLUS)).toBeGreaterThanOrEqual(6000);

      const filtered = await api.get('/api/ops/finance/ar?bucket=AGING_1_30').set(auth(token));
      expect(filtered.status).toBe(200);
      expect(filtered.body.data.rows.every((r: { bucket: string }) => r.bucket === 'AGING_1_30')).toBe(true);

      const summary = await api.get('/api/ops/finance/summary').set(auth(token));
      expect(summary.status).toBe(200);
      expect(summary.body.data.dso).toBeDefined();
      expect(summary.body.data.draftJournals).toBeDefined();
      expect(summary.body.data.unreconciledBanks).toBeDefined();
    } finally {
      await execAsTenant(tenantId, companyId, `DELETE FROM customer_invoices WHERE invoice_no = ANY($1::text[])`, [nos]);
    }
  });

  it('matches a bank statement line to the cashbook and requires approval', async () => {
    const { token } = await loginAs('admin');
    const suffix = uniqueSuffix();
    const amount = 87654.12;
    const accts = await api.get('/api/ops/finance/accounts').set(auth(token));
    const bankGl = accts.body.data.find((a: { code: string }) => a.code === '1100');
    const cashGl = accts.body.data.find((a: { code: string }) => a.code === '1200');
    expect(bankGl && cashGl).toBeTruthy();
    const day = '2026-08-18';

    let bank: { id: number; tenantId: number; companyId: number } | undefined;
    let journalId: number | null = null;
    try {
      const created = await api.post('/api/ops/finance/banks').set(auth(token)).send({
        code: `REC-${suffix}`,
        name: 'Recon Test Bank',
        accountType: 'CURRENT',
        currency: 'UGX',
        glAccountId: bankGl.id,
      });
      expect(created.status).toBe(200);
      bank = created.body.data;

      const posted = await api.post('/api/ops/finance/journals').set(auth(token)).send({
        entryDate: day,
        description: `Recon match ${suffix}`,
        post: true,
        lines: [
          { accountId: bankGl.id, debit: amount, credit: 0 },
          { accountId: cashGl.id, debit: 0, credit: amount },
        ],
      });
      expect(posted.status).toBe(200);
      journalId = Number(posted.body.data.entryId);

      const line = await api.post(`/api/ops/finance/banks/${bank.id}/transactions`).set(auth(token)).send({
        txnDate: day,
        reference: `STM-${suffix}`,
        description: `Recon match ${suffix}`,
        debit: amount,
        credit: 0,
      });
      expect(line.status).toBe(200);
      expect(line.body.data.reconciled).toBe(false);

      const auto = await api.post(`/api/ops/finance/banks/${bank.id}/recon/auto-match`).set(auth(token)).send({});
      expect(auto.status).toBe(200);
      expect(Number(auto.body.data.matched)).toBeGreaterThanOrEqual(1);
      expect(auto.body.data.matches.length).toBeGreaterThanOrEqual(1);
      const stmt = auto.body.data.statement.find((t: { reference: string }) => t.reference === `STM-${suffix}`);
      expect(stmt.reconciled).toBe(true);

      const approved = await api.post(`/api/ops/finance/banks/${bank.id}/recon/approve`).set(auth(token)).send({
        statementBalance: amount,
      });
      expect(approved.status).toBe(200);
      expect(approved.body.data.status).toBe('APPROVED');
    } finally {
      if (bank) {
        await execAsTenant(
          bank.tenantId,
          bank.companyId,
          `UPDATE journal_lines SET reconciled = false, bank_transaction_id = NULL
           WHERE bank_transaction_id IN (SELECT id FROM bank_transactions WHERE bank_account_id = $1)`,
          [bank.id]
        );
        await execAsTenant(bank.tenantId, bank.companyId, 'DELETE FROM bank_reconciliation_matches WHERE reconciliation_id IN (SELECT id FROM bank_reconciliations WHERE bank_account_id = $1)', [bank.id]);
        await execAsTenant(bank.tenantId, bank.companyId, 'DELETE FROM bank_reconciliations WHERE bank_account_id = $1', [bank.id]);
        await execAsTenant(bank.tenantId, bank.companyId, 'DELETE FROM bank_transactions WHERE bank_account_id = $1', [bank.id]);
        if (journalId) {
          await execAsTenant(bank.tenantId, bank.companyId, 'DELETE FROM journal_entries WHERE id = $1', [journalId]);
        }
        await execAsTenant(bank.tenantId, bank.companyId, 'DELETE FROM bank_accounts WHERE id = $1', [bank.id]);
      }
    }
  });
});

describe('Finance budget gate and posting rules', () => {
  it('blocks an expense that exceeds available budget and posts one that fits', async () => {
    const { token } = await loginAs('admin');
    const suffix = uniqueSuffix();
    let account: { id: number; tenantId: number; companyId: number } | undefined;
    let budget: { id: number; tenantId: number; companyId: number } | undefined;
    let expenseId: number | null = null;
    let journalId: number | null = null;
    const _now = new Date();
    const monthStart = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-01`;
    const monthEnd = new Date(Date.UTC(_now.getFullYear(), _now.getMonth() + 1, 0)).toISOString().slice(0, 10);
    try {
      const acct = await api.post('/api/ops/finance/accounts').set(auth(token)).send({
        code: `BG${suffix}`,
        name: 'Budget gate expense',
        accountType: 'EXPENSE',
        isPosting: true,
        currency: 'UGX',
      });
      expect(acct.status).toBe(200);
      account = acct.body.data;

      const created = await api.post('/api/ops/finance/budgets').set(auth(token)).send({
        periodStart: monthStart,
        periodEnd: monthEnd,
        status: 'DRAFT',
        lines: [{ accountId: account.id, amount: 50000 }],
      });
      expect(created.status).toBe(200);
      budget = created.body.data.budget;
      await api.post(`/api/ops/finance/budgets/${budget.id}/submit`).set(auth(token)).send({});
      const approve = await api.post(`/api/ops/finance/budgets/${budget.id}/approve`).set(auth(token)).send({});
      expect(approve.status).toBe(200);

      const check = await api.get(`/api/ops/finance/budget/check?accountId=${account.id}&amount=40000&docType=EXPENSE`).set(auth(token));
      expect(check.status).toBe(200);
      expect(check.body.data.result).toBe('ALLOW');
      expect(Number(check.body.data.available)).toBe(50000);

      const blocked = await api.post('/api/ops/finance/expenses').set(auth(token)).send({
        expenseDate: monthStart,
        accountId: account.id,
        amount: 80000,
        method: 'CASH',
        description: 'Over budget',
      });
      expect(blocked.status).toBe(400);
      expect(String(blocked.body.error.message)).toMatch(/Budget exceeded/i);

      const ok = await api.post('/api/ops/finance/expenses').set(auth(token)).send({
        expenseDate: monthStart,
        accountId: account.id,
        amount: 12000,
        method: 'CASH',
        description: 'Within budget',
      });
      expect(ok.status).toBe(200);
      expenseId = Number(ok.body.data.expenseId);
      journalId = Number(ok.body.data.journalId);

      const after = await api.get(`/api/ops/finance/budgets/${budget.id}`).set(auth(token));
      expect(after.status).toBe(200);
      expect(Number(after.body.data.budget.actual)).toBeGreaterThanOrEqual(12000);
      expect(Number(after.body.data.budget.available)).toBeLessThanOrEqual(38000);
    } finally {
      if (account && expenseId) {
        await execAsTenant(account.tenantId, account.companyId, 'DELETE FROM expenses WHERE id = $1', [expenseId]);
      }
      if (account && journalId) {
        await execAsTenant(account.tenantId, account.companyId, 'DELETE FROM journal_entries WHERE id = $1', [journalId]);
      }
      if (budget) {
        await execAsTenant(budget.tenantId, budget.companyId, 'DELETE FROM budget_commitments WHERE budget_id = $1', [budget.id]);
        await execAsTenant(budget.tenantId, budget.companyId, 'DELETE FROM budget_lines WHERE budget_id = $1', [budget.id]);
        await execAsTenant(budget.tenantId, budget.companyId, 'DELETE FROM budgets WHERE id = $1', [budget.id]);
      }
      if (account) {
        await execAsTenant(account.tenantId, account.companyId, 'DELETE FROM chart_of_accounts WHERE id = $1', [account.id]);
      }
    }
  });

  it('posts a sales invoice journal from the active posting rule', async () => {
    const { token } = await loginAs('admin');
    const rules = await api.get('/api/ops/finance/posting-rules?event=SALES_INVOICE').set(auth(token));
    expect(rules.status).toBe(200);
    expect(rules.body.data.length).toBeGreaterThan(0);

    const applied = await api.post('/api/ops/finance/posting-rules/apply').set(auth(token)).send({
      event: 'SALES_INVOICE',
      amount: 118000,
      net: 100000,
      tax: 18000,
      entryDate: '2026-08-18',
      description: 'Posting rule runtime',
    });
    expect(applied.status).toBe(200);
    expect(applied.body.data.entryId).toBeTruthy();
    const entryId = Number(applied.body.data.entryId);

    const journal = await api.get(`/api/ops/finance/journals/${entryId}`).set(auth(token));
    expect(journal.status).toBe(200);
    expect(journal.body.data.journal.status).toBe('POSTED');
    expect(Math.round(Number(journal.body.data.journal.totalDebit) * 100)).toBe(
      Math.round(Number(journal.body.data.journal.totalCredit) * 100)
    );
    expect(journal.body.data.lines.length).toBeGreaterThanOrEqual(2);

    const tenantId = Number(journal.body.data.journal.tenantId);
    const companyId = Number(journal.body.data.journal.companyId);
    await execAsTenant(tenantId, companyId, 'DELETE FROM journal_entries WHERE id = $1', [entryId]);
  });
});
