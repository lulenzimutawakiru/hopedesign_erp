import { useCallback, useEffect, useState } from 'react';
import { api, fmtMoney, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, PageLoader, Modal, Pager } from '../components/ui';
import { ConfirmDialog } from '../components/os';
import DownloadMenu from '../components/DownloadMenu';

type Rec = Record<string, unknown>;

const JOURNAL_STATUSES = ['DRAFT', 'POSTED', 'VOID'];
const EXPENSE_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'VOID'];
const ADVANCE_STATUSES = ['POSTED', 'SETTLED', 'VOID'];
const BUDGET_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'ACTIVE', 'CLOSED'];
const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE', 'CONTRA_ASSET', 'CONTRA_LIABILITY', 'CONTRA_EQUITY', 'CONTRA_REVENUE', 'CONTRA_EXPENSE'];
const BANK_TYPES = ['CURRENT', 'SAVINGS', 'MOBILE_MONEY', 'CASH'];
const TAX_TYPES = ['VAT', 'WHT', 'EXCISE', 'WITHHOLDING_VAT'];
const PERIOD_STATUSES = ['OPEN', 'LOCKED', 'CLOSED'];

function viewOf(path: string): { view: string; id: string | null; sub: string | null } {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'finance') return { view: 'overview', id: null, sub: null };
  return { view: parts[1] ?? 'overview', id: parts[2] ?? null, sub: parts[3] ?? null };
}

export default function FinanceFlow({ path }: { path: string }) {
  const { view, id, sub } = viewOf(path);
  if (view === 'journals' && id === 'new') return <JournalComposer />;
  if (view === 'journals' && id && sub === 'edit') return <JournalComposer id={Number(id)} />;
  if (view === 'journals' && id) return <JournalDetail id={Number(id)} />;
  if (view === 'journals') return <JournalList />;
  if (view === 'expenses' && id === 'new') return <ExpenseComposer />;
  if (view === 'expenses' && id) return <ExpenseDetail id={Number(id)} />;
  if (view === 'expenses') return <ExpenseList />;
  if (view === 'budgets' && id === 'new') return <BudgetComposer />;
  if (view === 'budgets' && id && sub === 'edit') return <BudgetComposer id={Number(id)} />;
  if (view === 'budgets' && id) return <BudgetDetail id={Number(id)} />;
  if (view === 'budgets') return <BudgetList />;
  if (view === 'trial-balance') return <TrialBalance />;
  if (view === 'profit-loss') return <ProfitLoss />;
  if (view === 'balance-sheet') return <BalanceSheet />;
  if (view === 'ar') return <ArAp kind="ar" />;
  if (view === 'ap') return <ArAp kind="ap" />;
  if (view === 'banks' && id) return <BankRecon bankId={Number(id)} />;
  if (view === 'banks') return <Banks />;
  if (view === 'transfers') return <CashTransfers />;
  if (view === 'advances' && id === 'new') return <Advances autoOpen />;
  if (view === 'advances' && id) return <AdvanceDetail id={Number(id)} />;
  if (view === 'advances') return <Advances />;
  if (view === 'periods') return <Periods />;
  if (view === 'tax') return <TaxDesk />;
  if (view === 'accounts') return <Coa />;
  if (view === 'advanced') return <AdvancedOverview />;
  if (view === 'posting-rules') return <PostingRules />;
  if (view === 'efris') return <EfrisDesk />;
  if (view === 'tax-compliance') return <TaxCompliance />;
  if (view === 'costing') return <Costing />;
  if (view === 'consolidation' && id) return <ConsolidationDetail id={Number(id)} />;
  if (view === 'consolidation') return <Consolidation />;
  if (view === 'close') return <PeriodClose />;
  if (view === 'audit') return <FinanceAudit />;
  return <Overview />;
}

function StatusSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select className="search-input" style={{ maxWidth: 180 }} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All statuses</option>
      {options.map((s) => (
        <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
      ))}
    </select>
  );
}

function Overview() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/finance/summary')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Finance summary failed'));
  }, []);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening the books..." />;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">General ledger</p>
          <h1>Books of Hope Design</h1>
          <p className="muted">
            Double-entry only. {data.trialBalanceOk ? 'Trial balance is in balance.' : 'Trial balance is out of balance - investigate before period close.'}
          </p>
        </div>
        <div className="head-actions">
          {can(user, 'finance.journals.create') && (
            <button className="btn btn-primary" onClick={() => navigate('/finance/journals/new')}>New journal</button>
          )}
          {can(user, 'finance.expenses.create') && (
            <button className="btn" onClick={() => navigate('/finance/expenses/new')}>Post expense</button>
          )}
          {can(user, 'finance.advances.create') && (
            <button className="btn" onClick={() => navigate('/finance/advances/new')}>Issue advance</button>
          )}
          {can(user, 'finance.budgets.create') && (
            <button className="btn" onClick={() => navigate('/finance/budgets/new')}>New budget</button>
          )}
        </div>
      </header>
      <div className="kpi-grid">
        <button className="kpi-card" onClick={() => navigate('/finance/profit-loss')}>
          <span className="kpi-label">Month revenue</span>
          <span className="kpi-value">{fmtMoney(data.monthRevenue)}</span>
          <span className="kpi-sub">Expense {fmtMoney(data.monthExpense)}</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/finance/profit-loss')}>
          <span className="kpi-label">Month profit</span>
          <span className="kpi-value">{fmtMoney(data.monthProfit)}</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/finance/ar')}>
          <span className="kpi-label">Receivables</span>
          <span className="kpi-value">{fmtMoney(data.ar)}</span>
          <span className="kpi-sub">{fmtMoney(data.arOverdue)} overdue · {fmtMoney(data.arDue7)} due in 7 days</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/finance/ap')}>
          <span className="kpi-label">Payables</span>
          <span className="kpi-value">{fmtMoney(data.ap)}</span>
          <span className="kpi-sub">{fmtMoney(data.apOverdue)} overdue · {fmtMoney(data.apDue7)} due in 7 days</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/finance/banks')}>
          <span className="kpi-label">Cash and bank</span>
          <span className="kpi-value">{fmtMoney(data.cash)}</span>
          <span className="kpi-sub">{fmtNum(data.unreconciledBanks)} unreconciled statement lines</span>
        </button>
        <button className={`kpi-card ${data.trialBalanceOk ? '' : 'card-warn'}`} onClick={() => navigate('/finance/trial-balance')}>
          <span className="kpi-label">Trial balance</span>
          <span className="kpi-value">{data.trialBalanceOk ? 'OK' : 'Break'}</span>
          <span className="kpi-sub">{fmtNum(data.journals)} accounts with activity</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/finance/journals')}>
          <span className="kpi-label">Draft journals</span>
          <span className="kpi-value">{fmtNum(data.draftJournals)}</span>
          <span className="kpi-sub">Awaiting post or approval</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/finance/ar')}>
          <span className="kpi-label">DSO / DPO</span>
          <span className="kpi-value">{fmtNum(data.dso)} / {fmtNum(data.dpo)}</span>
          <span className="kpi-sub">Weighted days outstanding</span>
        </button>
      </div>
      <div className="do-now">
        <button onClick={() => navigate('/finance/journals')}><strong>Journals</strong><span>Posted double-entry</span></button>
        <button onClick={() => navigate('/finance/expenses')}><strong>Expenses</strong><span>Record and void</span></button>
        <button onClick={() => navigate('/finance/advances')}><strong>Advances</strong><span>Staff cash and imprest</span></button>
        <button onClick={() => navigate('/finance/budgets')}><strong>Budgets</strong><span>Plan and approve</span></button>
        <button onClick={() => navigate('/finance/trial-balance')}><strong>Trial balance</strong><span>Debit equals credit</span></button>
        <button onClick={() => navigate('/finance/profit-loss')}><strong>Profit and loss</strong><span>Revenue minus expense</span></button>
        <button onClick={() => navigate('/finance/balance-sheet')}><strong>Balance sheet</strong><span>Assets equal L + E</span></button>
        <button onClick={() => navigate('/finance/periods')}><strong>Periods</strong><span>Lock or close</span></button>
        <button onClick={() => navigate('/finance/tax')}><strong>VAT</strong><span>Output minus input</span></button>
        <button onClick={() => navigate('/finance/accounts')}><strong>Chart of accounts</strong><span>Master data</span></button>
      </div>
    </div>
  );
}
function JournalList() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (q.trim()) p.set('q', q.trim());
    if (status) p.set('status', status);
    api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/finance/journals?${p}`)
      .then((r) => { setRows(r.data.rows ?? []); setTotal(r.data.total ?? 0); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Journals failed'));
  }, [q, status, page]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">General ledger</p>
          <h1>Journal entries</h1>
          <p className="muted">Every posting from sales, receipts, GRN, production and expenses lands here.</p>
        </div>
        {can(user, 'finance.journals.create') && <button className="btn btn-primary" onClick={() => navigate('/finance/journals/new')}>New journal</button>}
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <input className="search-input" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search entry no, description, source..." />
        <StatusSelect value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={JOURNAL_STATUSES} />
        <span className="muted">{total} entries</span>
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Entry</th><th>Date</th><th>Type</th><th>Description</th><th>Source</th><th className="cell-num">Debit</th><th className="cell-num">Credit</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/finance/journals/${r.id}`)}>
                <td className="cell-mono">{String(r.entryNo)}</td>
                <td>{String(r.entryDate).slice(0, 10)}</td>
                <td>{String(r.journalType).replace(/_/g, ' ')}</td>
                <td>{String(r.description)}</td>
                <td className="cell-mono">{String(r.referenceCode ?? '') || '\u2014'}</td>
                <td className="cell-num">{fmtMoney(r.totalDebit)}</td>
                <td className="cell-num">{fmtMoney(r.totalCredit)}</td>
                <td><Badge value={r.status} /></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No journal entries match these filters.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={page} pageSize={20} total={total} onPage={setPage} />
    </div>
  );
}

function JournalDetail({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<{ journal: Rec; lines: Rec[] } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const load = useCallback(() => {
    api<{ data: { journal: Rec; lines: Rec[] } }>(`/api/ops/finance/journals/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Journal failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const act = async (action: 'post' | 'void', reason?: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/ops/finance/journals/${id}/${action}`, {
        method: 'POST',
        body: JSON.stringify(action === 'void' ? { reason: reason ?? 'Voided' } : {}),
      });
      setNotice(action === 'post' ? 'Journal posted to the ledger.' : 'Journal reversed and voided.');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  if (!doc) return error ? <div className="page"><ErrorBanner error={error} /></div> : <PageLoader label="Reading journal..." />;
  const j = doc.journal;
  const canEdit = j.status === 'DRAFT' && can(user, 'finance.journals.create');
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/finance/journals')}>Back</button>
          <h1>Journal <span className="cell-mono">{String(j.entryNo)}</span></h1>
          <p className="muted">{String(j.journalType).replace(/_/g, ' ')} {'\u00b7'} {String(j.entryDate).slice(0, 10)} {'\u00b7'} {String(j.description)}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {canEdit && <button className="btn btn-sm" onClick={() => navigate(`/finance/journals/${id}/edit`)}>Edit</button>}
          <DownloadMenu type="journal" id={id} code={String(j.entryNo)} />
          <Badge value={j.status} />
        </div>
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <section className="card">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Account</th><th>Name</th><th className="cell-num">Debit</th><th className="cell-num">Credit</th></tr></thead>
            <tbody>
              {doc.lines.map((l) => (
                <tr key={String(l.id)}>
                  <td className="cell-mono">{String(l.accountCode)}</td>
                  <td>{String(l.accountName)}</td>
                  <td className="cell-num">{Number(l.debit) ? fmtMoney(l.debit) : ''}</td>
                  <td className="cell-num">{Number(l.credit) ? fmtMoney(l.credit) : ''}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={2}><strong>Total</strong></td>
                <td className="cell-num"><strong>{fmtMoney(j.totalDebit)}</strong></td>
                <td className="cell-num"><strong>{fmtMoney(j.totalCredit)}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <div className="flow-actions" style={{ flexDirection: 'row' }}>
        {j.status === 'DRAFT' && can(user, 'finance.journals.post') && (
          <button className="btn btn-primary" disabled={busy} onClick={() => act('post')}>Post to ledger</button>
        )}
        {j.status === 'POSTED' && can(user, 'finance.journals.void') && (
          <button className="btn btn-danger" disabled={busy} onClick={() => setConfirm(true)}>Reverse / void</button>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          title="Reverse this journal?"
          body="A reversing entry will be posted today and this entry marked VOID. The reason is written to the audit trail."
          confirmLabel="Reverse / void"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={(reason) => { setConfirm(false); void act('void', reason); }}
        />
      )}
    </div>
  );
}

function JournalComposer({ id }: { id?: number }) {
  const isEdit = id != null;
  const [accounts, setAccounts] = useState<Rec[]>([]);
  const [entryNo, setEntryNo] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<{ key: string; accountId: string; debit: string; credit: string }[]>([
    { key: '1', accountId: '', debit: '', credit: '' },
    { key: '2', accountId: '', debit: '', credit: '' },
  ]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(!isEdit);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/finance/accounts')
      .then((r) => setAccounts((r.data ?? []).filter((a) => a.isPosting)))
      .catch(() => undefined);
    if (!isEdit) return;
    api<{ data: { journal: Rec; lines: Rec[] } }>(`/api/ops/finance/journals/${id}`)
      .then((r) => {
        const j = r.data.journal;
        setEntryNo(String(j.entryNo ?? ''));
        setDate(String(j.entryDate).slice(0, 10));
        setDescription(String(j.description ?? ''));
        setLines(r.data.lines.length ? r.data.lines.map((l, i) => ({
          key: String(i),
          accountId: String(l.accountId),
          debit: Number(l.debit) ? String(l.debit) : '',
          credit: Number(l.credit) ? String(l.credit) : '',
        })) : [{ key: '1', accountId: '', debit: '', credit: '' }]);
        setReady(true);
      })
      .catch((e) => { setError(e instanceof Error ? e.message : 'Journal failed'); setReady(true); });
  }, [id, isEdit]);
  const debit = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const credit = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  const save = async (post: boolean) => {
    setError('');
    if (!description.trim()) { setError('Description is required'); return; }
    const payload = lines.filter((l) => l.accountId && (Number(l.debit) || Number(l.credit))).map((l) => ({
      accountId: Number(l.accountId), debit: Number(l.debit || 0), credit: Number(l.credit || 0),
    }));
    setBusy(true);
    try {
      if (isEdit) {
        await api(`/api/ops/finance/journals/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ entryDate: date, description: description.trim(), lines: payload }),
        });
        navigate(`/finance/journals/${id}`);
      } else {
        const r = await api<{ data: { entryId: number } }>('/api/ops/finance/journals', {
          method: 'POST',
          body: JSON.stringify({ entryDate: date, description: description.trim(), lines: payload, post }),
        });
        navigate(`/finance/journals/${r.data.entryId}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  if (!ready) return <PageLoader label="Loading journal..." />;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate(isEdit ? `/finance/journals/${id}` : '/finance/journals')}>Back</button>
          <h1>{isEdit ? `Edit journal ${entryNo}` : 'New journal'}</h1>
          <p className="muted">Debits must equal credits. The period covering the date must be OPEN.</p>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field field-required"><label>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="field field-required" style={{ gridColumn: 'span 2' }}><label>Description</label><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Why this entry exists" /></div>
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <h3>Lines</h3>
          <button className="btn btn-sm" onClick={() => setLines((p) => [...p, { key: `${Date.now()}`, accountId: '', debit: '', credit: '' }])}>+ Line</button>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Account</th><th className="cell-num">Debit</th><th className="cell-num">Credit</th><th /></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td>
                    <select className="cell-input" value={l.accountId} onChange={(e) => setLines((p) => p.map((x) => x.key === l.key ? { ...x, accountId: e.target.value } : x))}>
                      <option value="">Select...</option>
                      {accounts.map((a) => <option key={String(a.id)} value={String(a.id)}>{String(a.code)} {'\u00b7'} {String(a.name)}</option>)}
                    </select>
                  </td>
                  <td><input className="cell-input" inputMode="decimal" value={l.debit} onChange={(e) => setLines((p) => p.map((x) => x.key === l.key ? { ...x, debit: e.target.value, credit: '' } : x))} /></td>
                  <td><input className="cell-input" inputMode="decimal" value={l.credit} onChange={(e) => setLines((p) => p.map((x) => x.key === l.key ? { ...x, credit: e.target.value, debit: '' } : x))} /></td>
                  <td><button className="btn btn-sm" onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))}>Remove</button></td>
                </tr>
              ))}
              <tr>
                <td><strong>Total {Math.round(debit * 100) === Math.round(credit * 100) && debit > 0 ? 'in balance' : 'out of balance'}</strong></td>
                <td className="cell-num"><strong>{fmtMoney(debit)}</strong></td>
                <td className="cell-num"><strong>{fmtMoney(credit)}</strong></td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <div className="sticky-actions" style={{ display: 'flex' }}>
        <button className="btn" disabled={busy} onClick={() => save(false)}>{isEdit ? 'Save changes' : 'Save draft'}</button>
        {!isEdit && <button className="btn btn-primary" disabled={busy} onClick={() => save(true)}>Post now</button>}
      </div>
    </div>
  );
}
function ExpenseList() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (q.trim()) p.set('q', q.trim());
    if (status) p.set('status', status);
    api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/finance/expenses?${p}`)
      .then((r) => { setRows(r.data.rows ?? []); setTotal(r.data.total ?? 0); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Expenses failed'));
  }, [q, status, page]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Expenditure</p>
          <h1>Expenses</h1>
          <p className="muted">Petty cash and bank payments posted straight to the ledger.</p>
        </div>
        {can(user, 'finance.expenses.create') && <button className="btn btn-primary" onClick={() => navigate('/finance/expenses/new')}>Post expense</button>}
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <input className="search-input" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search expense no, vendor, reference..." />
        <StatusSelect value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={EXPENSE_STATUSES} />
        <span className="muted">{total} expenses</span>
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Expense</th><th>Date</th><th>Account</th><th>Vendor</th><th>Reference</th><th className="cell-num">Amount</th><th>Method</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/finance/expenses/${r.id}`)}>
                <td className="cell-mono">{String(r.expenseNo)}</td>
                <td>{String(r.expenseDate).slice(0, 10)}</td>
                <td className="cell-mono">{String(r.accountCode)} {String(r.accountName)}</td>
                <td>{String(r.vendor ?? '') || '\u2014'}</td>
                <td className="cell-mono">{String(r.reference ?? '') || '\u2014'}</td>
                <td className="cell-num">{fmtMoney(r.amount)}</td>
                <td>{String(r.method).replace(/_/g, ' ')}</td>
                <td><Badge value={r.status} /></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No expenses match these filters.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={page} pageSize={20} total={total} onPage={setPage} />
    </div>
  );
}

function ExpenseDetail({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<{ expense: Rec; journal: { journal: Rec; lines: Rec[] } | null } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const load = useCallback(() => {
    api<{ data: { expense: Rec; journal: { journal: Rec; lines: Rec[] } | null } }>(`/api/ops/finance/expenses/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Expense failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const voidExpense = async (reason: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/ops/finance/expenses/${id}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
      setNotice('Expense voided. Any posted journal has been reversed.');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  if (!doc) return error ? <div className="page"><ErrorBanner error={error} /></div> : <PageLoader label="Reading expense..." />;
  const e = doc.expense;
  const journal = doc.journal?.journal ?? null;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/finance/expenses')}>Back</button>
          <h1>Expense <span className="cell-mono">{String(e.expenseNo)}</span></h1>
          <p className="muted">{String(e.expenseDate).slice(0, 10)} {'\u00b7'} {String(e.accountCode)} {String(e.accountName)}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DownloadMenu type="expense" id={id} code={String(e.expenseNo)} />
          {journal && <button className="btn btn-sm" onClick={() => navigate(`/finance/journals/${journal.id}`)}>Linked journal</button>}
          <Badge value={e.status} />
        </div>
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field"><label>Amount</label><div className="field-value">{fmtMoney(e.amount)}</div></div>
          <div className="field"><label>Paid from</label><div className="field-value">{String(e.method).replace(/_/g, ' ')}</div></div>
          <div className="field"><label>Vendor</label><div className="field-value">{String(e.vendor ?? '') || '\u2014'}</div></div>
          <div className="field"><label>Reference</label><div className="field-value">{String(e.reference ?? '') || '\u2014'}</div></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Expense account</label><div className="field-value">{String(e.accountCode)} {'\u00b7'} {String(e.accountName)}</div></div>
        </div>
      </section>
      <div className="flow-actions" style={{ flexDirection: 'row' }}>
        {String(e.status) !== 'VOID' && can(user, 'finance.expenses.void') && (
          <button className="btn btn-danger" disabled={busy} onClick={() => setConfirm(true)}>Void expense</button>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          title="Void this expense?"
          body="The expense is marked VOID. If a journal was posted for it, a reversing entry is created today."
          confirmLabel="Void expense"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={(reason) => { setConfirm(false); void voidExpense(reason); }}
        />
      )}
    </div>
  );
}

function ExpenseComposer() {
  const [accounts, setAccounts] = useState<Rec[]>([]);
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [vendor, setVendor] = useState('');
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  const [method, setMethod] = useState('CASH');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [budget, setBudget] = useState<Rec | null>(null);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/finance/accounts')
      .then((r) => setAccounts((r.data ?? []).filter((a) => a.accountType === 'EXPENSE' && a.isPosting)))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!accountId || !(Number(amount) > 0)) { setBudget(null); return; }
    const p = new URLSearchParams({ accountId, amount: String(Number(amount)), docType: 'EXPENSE' });
    api<{ data: Rec }>(`/api/ops/finance/budget/check?${p}`)
      .then((r) => setBudget(r.data))
      .catch(() => setBudget(null));
  }, [accountId, amount]);
  const save = async () => {
    setBusy(true); setError('');
    try {
      const r = await api<{ data: { expenseId: number; journalId?: number } }>('/api/ops/finance/expenses', {
        method: 'POST',
        body: JSON.stringify({ expenseDate: date, accountId: Number(accountId), amount: Number(amount), vendor, reference, description, method }),
      });
      navigate(`/finance/expenses/${r.data.expenseId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/finance/expenses')}>Back</button>
          <h1>Post expense</h1>
          <p className="muted">Dr expense, Cr cash or bank. Posts immediately if the period is open.</p>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field field-required"><label>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="field field-required"><label>Amount</label><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="field"><label>Paid from</label>
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="CASH">Petty cash</option>
              <option value="BANK">Bank</option>
            </select>
          </div>
          <div className="field field-required" style={{ gridColumn: '1 / -1' }}><label>Expense account</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Select...</option>
              {accounts.map((a) => <option key={String(a.id)} value={String(a.id)}>{String(a.code)} {'\u00b7'} {String(a.name)}</option>)}
            </select>
          </div>
          <div className="field"><label>Vendor</label><input value={vendor} onChange={(e) => setVendor(e.target.value)} /></div>
          <div className="field"><label>Reference</label><input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Receipt or voucher no" /></div>
          <div className="field" style={{ gridColumn: 'span 2' }}><label>Description</label><input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        </div>
        {budget && String(budget.result) !== 'NONE' && (
          <p className="muted" style={{ marginTop: 12 }}>
            Budget {String(budget.budgetNo ?? '')}: available {fmtMoney(budget.available)}
            {' · '}approved {fmtMoney(budget.approved)} − committed {fmtMoney(budget.committed)} − actual {fmtMoney(budget.actual)}
            {String(budget.result) === 'BLOCK' ? ' — this expense exceeds available budget and will be blocked.' : ''}
          </p>
        )}
        <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy || !accountId || !amount} onClick={save}>Post expense</button>
      </section>
    </div>
  );
}

function TrialBalance() {
  const [data, setData] = useState<{ rows: Rec[]; totals: Rec } | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    api<{ data: { rows: Rec[]; totals: Rec } }>(`/api/ops/finance/trial-balance?${p}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'TB failed'));
  }, [from, to]);
  useEffect(() => { load(); }, [load]);
  if (error) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Preparing trial balance..." />;
  const ok = Math.round(Number(data.totals.debit) * 100) === Math.round(Number(data.totals.credit) * 100);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Statement</p>
          <h1>Trial balance</h1>
          <p className="muted">{ok ? 'Debits equal credits.' : 'Out of balance - do not close the period.'}</p>
        </div>
      </header>
      <div className="toolbar">
        <input type="date" className="search-input" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <input type="date" className="search-input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        <span className="muted">Leave dates blank for all time</span>
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Code</th><th>Account</th><th>Type</th><th className="cell-num">Debit</th><th className="cell-num">Credit</th><th className="cell-num">Balance</th></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={String(r.id)}>
                <td className="cell-mono">{String(r.code)}</td>
                <td>{String(r.name)}</td>
                <td>{String(r.accountType)}</td>
                <td className="cell-num">{fmtMoney(r.debit)}</td>
                <td className="cell-num">{fmtMoney(r.credit)}</td>
                <td className="cell-num">{fmtMoney(r.balance)}</td>
              </tr>
            ))}
            {data.rows.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>No movements in this range.</td></tr>}
            <tr>
              <td colSpan={3}><strong>Total</strong></td>
              <td className="cell-num"><strong>{fmtMoney(data.totals.debit)}</strong></td>
              <td className="cell-num"><strong>{fmtMoney(data.totals.credit)}</strong></td>
              <td className="cell-num"><strong>{fmtMoney(data.totals.balance)}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProfitLoss() {
  const [data, setData] = useState<Rec | null>(null);
  const [from, setFrom] = useState(() => { const t = new Date(); return `${t.getFullYear()}-01-01`; });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams({ from, to });
    api<{ data: Rec }>(`/api/ops/finance/profit-loss?${p}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'P&L failed'));
  }, [from, to]);
  useEffect(() => { load(); }, [load]);
  if (error) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Preparing profit and loss..." />;
  const rows = (data.rows as Rec[]) ?? [];
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Statement</p>
          <h1>Profit and loss</h1>
          <p className="muted">{String(data.from)} {'\u2192'} {String(data.to)}</p>
        </div>
      </header>
      <div className="toolbar">
        <input type="date" className="search-input" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <input type="date" className="search-input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
      </div>
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Revenue</span><span className="kpi-value">{fmtMoney(data.revenue)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Expense</span><span className="kpi-value">{fmtMoney(data.expense)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Profit</span><span className="kpi-value">{fmtMoney(data.profit)}</span></div>
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Code</th><th>Account</th><th>Type</th><th className="cell-num">Amount</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td className="cell-mono">{String(r.code)}</td>
                <td>{String(r.name)}</td>
                <td>{String(r.accountType)}</td>
                <td className="cell-num">{fmtMoney(r.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BalanceSheet() {
  const [data, setData] = useState<Rec | null>(null);
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<{ data: Rec }>(`/api/ops/finance/balance-sheet?asOf=${asOf}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Balance sheet failed'));
  }, [asOf]);
  useEffect(() => { load(); }, [load]);
  if (error) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Preparing balance sheet..." />;
  const rows = (data.rows as Rec[]) ?? [];
  const ok = Math.round(Number(data.assets) * 100) === Math.round(Number(data.totalLAndE) * 100);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Statement</p>
          <h1>Balance sheet</h1>
          <p className="muted">As of {String(data.asOf)}. {ok ? 'Assets equal liabilities + equity.' : 'Equation does not hold - check postings.'}</p>
        </div>
      </header>
      <div className="toolbar">
        <input type="date" className="search-input" value={asOf} onChange={(e) => setAsOf(e.target.value)} aria-label="As of" />
      </div>
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Assets</span><span className="kpi-value">{fmtMoney(data.assets)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Liabilities</span><span className="kpi-value">{fmtMoney(data.liabilities)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Equity</span><span className="kpi-value">{fmtMoney(data.equity)}</span></div>
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Code</th><th>Account</th><th>Type</th><th className="cell-num">Amount</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td className="cell-mono">{String(r.code)}</td>
                <td>{String(r.name)}</td>
                <td>{String(r.accountType)}</td>
                <td className="cell-num">{fmtMoney(r.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
const AGING_LABELS: [string, string][] = [
  ['CURRENT', 'Current'],
  ['AGING_1_30', '1–30'],
  ['AGING_31_60', '31–60'],
  ['AGING_61_90', '61–90'],
  ['AGING_91_120', '91–120'],
  ['AGING_120_PLUS', '120+'],
];

function ArAp({ kind }: { kind: 'ar' | 'ap' }) {
  const { user } = useAuth();
  const [data, setData] = useState<{ rows: Rec[]; total: number; overdue: number; buckets?: Rec } | null>(null);
  const [error, setError] = useState('');
  const [bucket, setBucket] = useState('');
  const [collect, setCollect] = useState<Rec | null>(null);
  const [busy, setBusy] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('BANK_TRANSFER');
  const [payRef, setPayRef] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (bucket) p.set('bucket', bucket);
    api<{ data: { rows: Rec[]; total: number; overdue: number; buckets?: Rec } }>(`/api/ops/finance/${kind}${p.toString() ? `?${p}` : ''}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Ledger failed'));
  }, [kind, bucket]);
  useEffect(() => { load(); }, [load]);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening subledger..." />;
  const isAr = kind === 'ar';
  const buckets = (data.buckets ?? {}) as Rec;
  const openInvoice = (r: Rec) => navigate(isAr ? `/sales/invoices/${r.id}` : `/buy/invoices/${r.id}`);
  const postReceipt = async () => {
    if (!collect) return;
    setBusy(true); setError('');
    try {
      await api('/api/ops/sales/receipts', {
        method: 'POST',
        body: JSON.stringify({
          invoiceId: collect.id,
          customerId: collect.customerId,
          amount: Number(payAmount),
          method: payMethod,
          reference: payRef || null,
          allocations: [{ invoiceId: collect.id, amount: Number(payAmount) }],
        }),
      });
      setCollect(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">{isAr ? 'Receivables' : 'Payables'}</p>
          <h1>{isAr ? 'Accounts receivable' : 'Accounts payable'}</h1>
          <p className="muted">Open balances from posted invoices. Total {fmtMoney(data.total)} {'\u00b7'} overdue {fmtMoney(data.overdue)}.</p>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="aging-row aging-row-6" style={{ marginBottom: 16 }}>
        {AGING_LABELS.map(([key, label]) => (
          <button
            key={key}
            className={`aging-cell ${bucket === key ? 'aging-cell-active' : ''}`}
            onClick={() => setBucket((cur) => (cur === key ? '' : key))}
            style={{ textAlign: 'left', cursor: 'pointer', border: '1px solid var(--line)' }}
          >
            <span className="muted">{label}</span>
            <strong>{fmtMoney(buckets[key] ?? 0)}</strong>
          </button>
        ))}
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead>
            <tr>
              <th>Document</th>
              <th>{isAr ? 'Customer' : 'Supplier'}</th>
              <th>Date</th>
              <th>Due</th>
              <th className="cell-num">Days</th>
              <th className="cell-num">Total</th>
              <th className="cell-num">Paid</th>
              <th className="cell-num">Balance</th>
              <th>Bucket</th>
              {isAr && <th />}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr
                key={String(r.id)}
                className={`row-click ${r.isOverdue ? 'row-warn' : ''}`}
                onClick={() => openInvoice(r)}
              >
                <td className="cell-mono">{String(isAr ? r.invoiceNo : r.supplierInvoiceNo)}</td>
                <td>{String(isAr ? r.customerName : r.supplierName)}</td>
                <td>{String(r.invoiceDate).slice(0, 10)}</td>
                <td>{r.dueDate ? String(r.dueDate).slice(0, 10) : '\u2014'}</td>
                <td className="cell-num">{fmtNum(r.daysOverdue)}</td>
                <td className="cell-num">{fmtMoney(r.total)}</td>
                <td className="cell-num">{fmtMoney(r.amountPaid)}</td>
                <td className="cell-num">{fmtMoney(r.balance)}</td>
                <td><Badge value={String(r.bucket).replace('AGING_', '').replace('_PLUS', '+')} /></td>
                {isAr && (
                  <td>
                    {can(user, 'sales.receipts.create') && (
                      <button
                        className="btn btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPayAmount(String(r.balance ?? ''));
                          setPayMethod('BANK_TRANSFER');
                          setPayRef('');
                          setCollect(r);
                        }}
                      >
                        Collect
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {data.rows.length === 0 && <tr><td colSpan={isAr ? 10 : 9} className="muted" style={{ textAlign: 'center', padding: 24 }}>No open balances.</td></tr>}
          </tbody>
        </table>
      </div>
      {collect && (
        <Modal title={`Collect ${String(collect.invoiceNo)}`} onClose={() => setCollect(null)} footer={
          <>
            <button className="btn" onClick={() => setCollect(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !(Number(payAmount) > 0)} onClick={() => void postReceipt()}>Post receipt</button>
          </>
        }>
          <p className="muted">{String(collect.customerName)} · due {fmtMoney(collect.balance)}</p>
          <div className="form-grid">
            <div className="field field-required"><label>Amount</label><input inputMode="decimal" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} /></div>
            <div className="field"><label>Method</label>
              <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                <option value="CASH">Cash</option>
                <option value="BANK_TRANSFER">Bank transfer</option>
                <option value="MOBILE_MONEY">Mobile money</option>
                <option value="CHEQUE">Cheque</option>
                <option value="CARD">Card</option>
              </select>
            </div>
            <div className="field"><label>Reference</label><input value={payRef} onChange={(e) => setPayRef(e.target.value)} /></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function BankModal({ row, accounts, onSave, onClose, busy }: { row: Rec | null; accounts: Rec[]; onSave: (p: Rec) => void; onClose: () => void; busy: boolean }) {
  const [code, setCode] = useState(row ? String(row.code ?? '') : '');
  const [name, setName] = useState(row ? String(row.name ?? '') : '');
  const [bankName, setBankName] = useState(row ? String(row.bankName ?? '') : '');
  const [accountNo, setAccountNo] = useState(row ? String(row.accountNo ?? '') : '');
  const [accountType, setAccountType] = useState(row ? String(row.accountType ?? 'CURRENT') : 'CURRENT');
  const [currency, setCurrency] = useState(row ? String(row.currency ?? 'UGX') : 'UGX');
  const [openingBalance, setOpeningBalance] = useState(row ? String(row.openingBalance ?? '') : '');
  const [glAccountId, setGlAccountId] = useState(row && row.glAccountId != null ? String(row.glAccountId) : '');
  const [err, setErr] = useState('');
  const submit = () => {
    if (!name.trim()) { setErr('Name is required'); return; }
    if (!row && !code.trim()) { setErr('Code is required'); return; }
    onSave({
      ...(row ? {} : { code: code.trim().toUpperCase() }),
      name: name.trim(),
      bankName: bankName.trim() || null,
      accountNo: accountNo.trim() || null,
      accountType,
      currency,
      openingBalance: Number(openingBalance || 0),
      glAccountId: glAccountId ? Number(glAccountId) : null,
    });
  };
  return (
    <Modal title={row ? `Edit ${String(row.code)}` : 'New bank account'} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={submit}>{row ? 'Save changes' : 'Create bank'}</button>
      </>
    }>
      {err && <ErrorBanner error={err} />}
      <div className="form-grid">
        {!row && <div className="field field-required"><label>Code</label><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="BNK001" /></div>}
        <div className="field field-required"><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label>Bank</label><input value={bankName} onChange={(e) => setBankName(e.target.value)} /></div>
        <div className="field"><label>Account no</label><input value={accountNo} onChange={(e) => setAccountNo(e.target.value)} /></div>
        <div className="field"><label>Type</label>
          <select value={accountType} onChange={(e) => setAccountType(e.target.value)}>
            {BANK_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        <div className="field"><label>Currency</label><input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></div>
        <div className="field"><label>Opening balance</label><input inputMode="decimal" value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} /></div>
        <div className="field"><label>GL account</label>
          <select value={glAccountId} onChange={(e) => setGlAccountId(e.target.value)}>
            <option value="">None</option>
            {accounts.map((a) => <option key={String(a.id)} value={String(a.id)}>{String(a.code)} {'\u00b7'} {String(a.name)}</option>)}
          </select>
        </div>
      </div>
    </Modal>
  );
}

function BankRecon({ bankId }: { bankId: number }) {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stmtSel, setStmtSel] = useState<number | null>(null);
  const [bookSel, setBookSel] = useState<number | null>(null);
  const [lineOpen, setLineOpen] = useState(false);
  const [txnDate, setTxnDate] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  const [debit, setDebit] = useState('');
  const [credit, setCredit] = useState('');
  const [statementBalance, setStatementBalance] = useState('');
  const load = useCallback(() => {
    api<{ data: Rec }>(`/api/ops/finance/banks/${bankId}/recon`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Reconciliation failed'));
  }, [bankId]);
  useEffect(() => { load(); }, [load]);
  const act = async (path: string, body: Rec = {}) => {
    setBusy(true); setError('');
    try {
      const r = await api<{ data: Rec }>(path, { method: 'POST', body: JSON.stringify(body) });
      if (r.data && (r.data.statement || r.data.recon)) setData(r.data);
      else load();
      setStmtSel(null); setBookSel(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const addLine = async () => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/finance/banks/${bankId}/transactions`, {
        method: 'POST',
        body: JSON.stringify({
          txnDate,
          reference: reference || null,
          description: description || null,
          debit: Number(debit || 0),
          credit: Number(credit || 0),
        }),
      });
      setLineOpen(false); setDebit(''); setCredit(''); setReference(''); setDescription('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  if (!data) return error ? <ErrorBanner error={error} /> : <PageLoader label="Opening bank match..." />;
  const bank = (data.bank ?? {}) as Rec;
  const recon = (data.recon ?? {}) as Rec;
  const statement = (data.statement ?? []) as Rec[];
  const book = (data.book ?? []) as Rec[];
  const matches = (data.matches ?? []) as Rec[];
  const matchByStmt = new Map(matches.map((m) => [Number(m.bankTransactionId), m]));
  const status = String(recon.status ?? 'OPEN');
  const locked = status === 'APPROVED' || status === 'VOID';
  const canRecon = can(user, 'finance.banks.reconcile') && !locked;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/finance/banks')}>Back</button>
          <p className="mod-kicker" data-mod="fin">Treasury</p>
          <h1>Reconcile {String(bank.code)} · {String(bank.name)}</h1>
          <p className="muted">
            Match bank statement lines to posted cashbook journals. {String(recon.reconNo)} · {status}.
            Unmatched statement {fmtNum(data.unmatchedStatement)} · unmatched book {fmtNum(data.unmatchedBook)}.
          </p>
        </div>
        <div className="head-actions">
          {canRecon && <button className="btn" disabled={busy} onClick={() => setLineOpen(true)}>Add statement line</button>}
          {canRecon && <button className="btn" disabled={busy} onClick={() => void act(`/api/ops/finance/banks/${bankId}/recon/auto-match`)}>Auto-match</button>}
          {canRecon && stmtSel && bookSel && (
            <button className="btn btn-primary" disabled={busy} onClick={() => void act(`/api/ops/finance/banks/${bankId}/recon/match`, { statementId: stmtSel, journalLineId: bookSel })}>Match selected</button>
          )}
          {canRecon && status === 'OPEN' && <button className="btn" disabled={busy} onClick={() => void act(`/api/ops/finance/banks/${bankId}/recon/submit`)}>Submit</button>}
          {can(user, 'finance.banks.reconcile') && !locked && (
            <button className="btn btn-primary" disabled={busy} onClick={() => void act(`/api/ops/finance/banks/${bankId}/recon/approve`, { statementBalance: statementBalance ? Number(statementBalance) : null })}>Approve</button>
          )}
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Book balance</span><span className="kpi-value">{fmtMoney(bank.bookBalance)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Unmatched statement</span><span className="kpi-value">{fmtNum(data.unmatchedStatement)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Unmatched cashbook</span><span className="kpi-value">{fmtNum(data.unmatchedBook)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Statement balance</span>
          <input className="search-input" inputMode="decimal" placeholder="From bank statement" value={statementBalance} onChange={(e) => setStatementBalance(e.target.value)} />
        </div>
      </div>
      <div className="recon-split">
        <div className="table-wrap card">
          <h2 style={{ margin: '12px 16px 0', fontSize: 16 }}>Bank statement</h2>
          <table className="data">
            <thead><tr><th>Date</th><th>Ref</th><th>Description</th><th className="cell-num">In</th><th className="cell-num">Out</th><th>Status</th></tr></thead>
            <tbody>
              {statement.map((t) => {
                const match = matchByStmt.get(Number(t.id));
                return (
                  <tr
                    key={String(t.id)}
                    className={`row-click ${stmtSel === Number(t.id) ? 'row-warn' : ''} ${t.reconciled ? '' : ''}`}
                    onClick={() => !t.reconciled && setStmtSel(Number(t.id))}
                  >
                    <td>{String(t.txnDate).slice(0, 10)}</td>
                    <td className="cell-mono">{String(t.reference ?? '')}</td>
                    <td>{String(t.description ?? '')}</td>
                    <td className="cell-num">{Number(t.debit) ? fmtMoney(t.debit) : ''}</td>
                    <td className="cell-num">{Number(t.credit) ? fmtMoney(t.credit) : ''}</td>
                    <td>
                      {match ? (
                        <span className="row-actions">
                          <Badge value={String(match.matchMethod)} />
                          {canRecon && (
                            <button className="btn btn-sm" disabled={busy} onClick={(e) => { e.stopPropagation(); void act(`/api/ops/finance/banks/${bankId}/recon/unmatch`, { matchId: match.id }); }}>Unmatch</button>
                          )}
                        </span>
                      ) : (
                        <Badge value={t.reconciled ? 'Reconciled' : 'Open'} />
                      )}
                    </td>
                  </tr>
                );
              })}
              {statement.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>No statement lines. Add the bank statement.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="table-wrap card">
          <h2 style={{ margin: '12px 16px 0', fontSize: 16 }}>Cashbook (GL {String(bank.glCode ?? 'unlinked')})</h2>
          <table className="data">
            <thead><tr><th>Date</th><th>Journal</th><th>Description</th><th className="cell-num">Debit</th><th className="cell-num">Credit</th><th>Status</th></tr></thead>
            <tbody>
              {book.map((t) => (
                <tr
                  key={String(t.id)}
                  className={`row-click ${bookSel === Number(t.id) ? 'row-warn' : ''}`}
                  onClick={() => !t.reconciled && setBookSel(Number(t.id))}
                >
                  <td>{String(t.entryDate).slice(0, 10)}</td>
                  <td className="cell-mono">{String(t.entryNo)}</td>
                  <td>{String(t.description ?? t.referenceCode ?? '')}</td>
                  <td className="cell-num">{Number(t.debit) ? fmtMoney(t.debit) : ''}</td>
                  <td className="cell-num">{Number(t.credit) ? fmtMoney(t.credit) : ''}</td>
                  <td><Badge value={t.reconciled ? 'Matched' : 'Open'} /></td>
                </tr>
              ))}
              {book.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>{bank.glAccountId ? 'No posted cashbook lines.' : 'Link a GL account to this bank first.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {lineOpen && (
        <Modal title="Add statement line" onClose={() => setLineOpen(false)} footer={
          <>
            <button className="btn" onClick={() => setLineOpen(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy} onClick={() => void addLine()}>Save line</button>
          </>
        }>
          <div className="form-grid">
            <div className="field field-required"><label>Date</label><input type="date" value={txnDate} onChange={(e) => setTxnDate(e.target.value)} /></div>
            <div className="field"><label>Reference</label><input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
            <div className="field"><label>Description</label><input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
            <div className="field"><label>In (debit)</label><input inputMode="decimal" value={debit} onChange={(e) => { setDebit(e.target.value); if (e.target.value) setCredit(''); }} /></div>
            <div className="field"><label>Out (credit)</label><input inputMode="decimal" value={credit} onChange={(e) => { setCredit(e.target.value); if (e.target.value) setDebit(''); }} /></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Banks() {
  const { user } = useAuth();
  const [data, setData] = useState<{ rows: Rec[]; cash: number } | null>(null);
  const [accounts, setAccounts] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<Rec | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [confirm, setConfirm] = useState<Rec | null>(null);
  const load = useCallback(() => {
    api<{ data: { rows: Rec[]; cash: number } }>('/api/ops/finance/banks')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Banks failed'));
  }, []);
  useEffect(() => {
    load();
    api<{ data: Rec[] }>('/api/ops/finance/accounts')
      .then((r) => setAccounts((r.data ?? []).filter((a) => String(a.accountType) === 'ASSET' && a.isPosting)))
      .catch(() => undefined);
  }, [load]);
  const save = async (payload: Rec) => {
    setBusy(true); setError('');
    try {
      if (modal) {
        await api(`/api/ops/finance/banks/${modal.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        await api('/api/ops/finance/banks', { method: 'POST', body: JSON.stringify(payload) });
      }
      setModalOpen(false); setModal(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const deactivate = async () => {
    if (!confirm) return;
    setBusy(true); setError('');
    try {
      await api(`/api/ops/finance/banks/${confirm.id}/deactivate`, { method: 'POST', body: '{}' });
      setConfirm(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  if (!data) return error ? <ErrorBanner error={error} /> : <PageLoader label="Reading bank books..." />;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Treasury</p>
          <h1>Bank and cash</h1>
          <p className="muted">Book balance = opening + posted GL movements on the linked account. Cash {fmtMoney(data.cash)}. {fmtNum((data as Rec).unreconciled)} statement lines still unmatched.</p>
        </div>
        <div className="head-actions">
          {can(user, 'finance.banks.update') && <button className="btn" onClick={() => navigate('/finance/transfers')}>Transfer</button>}
          {can(user, 'finance.banks.create') && <button className="btn btn-primary" onClick={() => { setModal(null); setModalOpen(true); }}>New bank</button>}
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Code</th><th>Name</th><th>Bank</th><th>Account</th><th>GL</th><th className="cell-num">Book balance</th><th className="cell-num">Unmatched</th><th /></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/finance/banks/${r.id}`)}>
                <td className="cell-mono">{String(r.code)}</td>
                <td>{String(r.name)}</td>
                <td>{String(r.bankName ?? '')}</td>
                <td className="cell-mono">{String(r.accountNo ?? '')}</td>
                <td className="cell-mono">{String(r.glCode ?? '')}</td>
                <td className="cell-num">{fmtMoney(r.bookBalance)}</td>
                <td className="cell-num">{fmtNum(r.unreconciledCount)}</td>
                <td>
                  <div className="row-actions">
                    <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); navigate(`/finance/banks/${r.id}`); }}>Reconcile</button>
                    {can(user, 'finance.banks.update') && <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setModal(r); setModalOpen(true); }}>Edit</button>}
                    {can(user, 'finance.banks.update') && <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setConfirm(r); }}>Deactivate</button>}
                  </div>
                </td>
              </tr>
            ))}
            {data.rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No bank accounts yet. Create one to track cash books.</td></tr>}
          </tbody>
        </table>
      </div>
      {modalOpen && <BankModal row={modal} accounts={accounts} busy={busy} onClose={() => { setModalOpen(false); setModal(null); }} onSave={save} />}
      {confirm && (
        <ConfirmDialog
          title="Deactivate bank account?"
          body={`${String(confirm.code)} ${String(confirm.name)} will be hidden from this list. Historical postings stay intact.`}
          confirmLabel="Deactivate"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => { setConfirm(null); void deactivate(); }}
        />
      )}
    </div>
  );
}

function CashTransfers() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[] | null>(null);
  const [banks, setBanks] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const load = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/finance/banks/transfers')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Transfers failed'));
  }, []);
  useEffect(() => {
    load();
    api<{ data: { rows: Rec[]; cash: number } }>('/api/ops/finance/banks')
      .then((r) => setBanks(r.data?.rows ?? []))
      .catch(() => undefined);
  }, [load]);
  const save = async (payload: Rec) => {
    setBusy(true); setError('');
    try {
      await api('/api/ops/finance/banks/transfer', { method: 'POST', body: JSON.stringify(payload) });
      setModalOpen(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  if (!rows) return error ? <ErrorBanner error={error} /> : <PageLoader label="Reading transfers..." />;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Treasury</p>
          <h1>Internal transfers</h1>
          <p className="muted">Move cash between bank and cash accounts (e.g. KCB Dollar to Petty Cash). Each transfer posts a double-entry TRANSFER journal.</p>
        </div>
        {can(user, 'finance.banks.update') && (
          <button className="btn btn-primary" onClick={() => setModalOpen(true)}>New transfer</button>
        )}
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead>
            <tr><th>Transfer</th><th>Date</th><th>From</th><th>To</th><th className="cell-num">Amount</th><th>Exchange rate</th><th>Reference</th><th>Notes</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td className="cell-mono">{String(r.transferNo)}</td>
                <td>{String(r.transferDate).slice(0, 10)}</td>
                <td><span className="cell-mono">{String(r.fromCode)}</span> <span className="muted">{String(r.fromName ?? '')}</span></td>
                <td><span className="cell-mono">{String(r.toCode)}</span> <span className="muted">{String(r.toName ?? '')}</span></td>
                <td className="cell-num">{fmtMoney(r.amount)} <span className="muted">{String(r.fromCurrency ?? '')}</span></td>
                <td>{r.fromCurrency !== r.toCurrency ? <><span className="cell-mono">{fmtNum(r.exchangeRate)}</span> <span className="muted">{String(r.toCurrency)} per 1 {String(r.fromCurrency)}</span></> : <span className="muted">\u2014</span>}</td>
                <td>{String(r.reference ?? '\u2014')}</td>
                <td>{String(r.notes ?? '\u2014')}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No transfers yet. Move cash between accounts to fund petty cash and other cash books.</td></tr>}
          </tbody>
        </table>
      </div>
      {modalOpen && <TransferModal banks={banks} busy={busy} onClose={() => setModalOpen(false)} onSave={save} />}
    </div>
  );
}

function TransferModal({ banks, busy, onClose, onSave }: { banks: Rec[]; busy: boolean; onClose: () => void; onSave: (p: Rec) => void }) {
  const [fromBankId, setFromBankId] = useState('');
  const [toBankId, setToBankId] = useState('');
  const [amount, setAmount] = useState('');
  const [transferDate, setTransferDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [exchangeRate, setExchangeRate] = useState('');
  const [err, setErr] = useState('');
  const fromBank = banks.find((b) => String(b.id) === String(fromBankId));
  const toBank = banks.find((b) => String(b.id) === String(toBankId));
  const fromCurrency = String(fromBank?.currency ?? '');
  const toCurrency = String(toBank?.currency ?? '');
  const cross = Boolean(fromBank && toBank && fromCurrency !== toCurrency);
  const foreignCode = cross ? (fromCurrency === 'UGX' ? toCurrency : fromCurrency) : '';
  const baseCode = cross ? (fromCurrency === 'UGX' ? fromCurrency : toCurrency) : '';
  useEffect(() => {
    if (!cross || exchangeRate) return;
    let alive = true;
    api<{ data: { rate: number | null; rateDate: string | null } }>(`/api/ops/finance/banks/exchange-rate?code=${encodeURIComponent(foreignCode)}`)
      .then((r) => { if (alive && r.data?.rate) setExchangeRate(String(r.data.rate)); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [cross, foreignCode, exchangeRate]);
  const submit = () => {
    if (!fromBankId || !toBankId) { setErr('Select source and target accounts'); return; }
    if (fromBankId === toBankId) { setErr('Source and target must be different accounts'); return; }
    const amt = Number(amount);
    if (!(amt > 0)) { setErr('Enter a positive amount'); return; }
    if (!transferDate) { setErr('Transfer date is required'); return; }
    if (cross && !(Number(exchangeRate) > 0)) { setErr(`Exchange rate required to transfer from ${fromCurrency} to ${toCurrency}`); return; }
    onSave({ fromBankId: Number(fromBankId), toBankId: Number(toBankId), amount: amt, transferDate, reference: reference.trim() || null, notes: notes.trim() || null, ...(cross ? { exchangeRate: Number(exchangeRate) } : {}) });
  };
  return (
    <Modal title="Internal cash transfer" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Posting...' : 'Post transfer'}</button>
      </>
    }>
      {err && <ErrorBanner error={err} />}
      <div className="form-grid">
        <div className="field field-required"><label>From account</label>
          <select value={fromBankId} onChange={(e) => setFromBankId(e.target.value)}>
            <option value="">Select source...</option>
            {banks.map((b) => <option key={String(b.id)} value={String(b.id)}>{String(b.code)} {'\u00b7'} {String(b.name)} ({String(b.currency)} {'\u00b7'} {fmtMoney(b.bookBalance)})</option>)}
          </select>
        </div>
        <div className="field field-required"><label>To account</label>
          <select value={toBankId} onChange={(e) => setToBankId(e.target.value)}>
            <option value="">Select target...</option>
            {banks.map((b) => <option key={String(b.id)} value={String(b.id)}>{String(b.code)} {'\u00b7'} {String(b.name)} ({String(b.currency)} {'\u00b7'} {fmtMoney(b.bookBalance)})</option>)}
          </select>
        </div>
        <div className="field field-required"><label>Amount</label><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></div>
        {cross && <div className="field field-required"><label>Exchange rate ({baseCode} per 1 {foreignCode})</label><input inputMode="decimal" value={exchangeRate} onChange={(e) => setExchangeRate(e.target.value)} placeholder="e.g. 3800" /></div>}
        <div className="field field-required"><label>Date</label><input type="date" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} /></div>
        <div className="field"><label>Reference</label><input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" /></div>
        <div className="field"><label>Notes</label><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Fund weekly petty cash" /></div>
      </div>
    </Modal>
  );
}

function Periods() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const load = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/finance/periods').then((r) => setRows(r.data ?? [])).catch((e) => setError(e instanceof Error ? e.message : 'Periods failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (id: number, action: string) => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/finance/periods/${id}/${action}`, { method: 'POST', body: '{}' });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const save = async (payload: Rec) => {
    setBusy(true); setError('');
    try {
      await api('/api/ops/finance/periods', { method: 'POST', body: JSON.stringify(payload) });
      setModalOpen(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Period control</p>
          <h1>Financial periods</h1>
          <p className="muted">Locked or closed periods reject every journal - including sales, GRN and production postings.</p>
        </div>
        {can(user, 'finance.periods.create') && <button className="btn btn-primary" onClick={() => setModalOpen(true)}>New period</button>}
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Code</th><th>Name</th><th>Start</th><th>End</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td className="cell-mono">{String(r.code)}</td>
                <td>{String(r.name)}</td>
                <td>{String(r.startDate).slice(0, 10)}</td>
                <td>{String(r.endDate).slice(0, 10)}</td>
                <td><Badge value={r.status} /></td>
                <td>
                  <div className="row-actions">
                    {can(user, 'finance.periods.lock') && r.status === 'OPEN' && <button className="btn btn-sm" disabled={busy} onClick={() => act(Number(r.id), 'lock')}>Lock</button>}
                    {can(user, 'finance.periods.close') && r.status !== 'CLOSED' && <button className="btn btn-sm" disabled={busy} onClick={() => act(Number(r.id), 'close')}>Close</button>}
                    {can(user, 'finance.periods.open') && r.status !== 'OPEN' && <button className="btn btn-sm" disabled={busy} onClick={() => act(Number(r.id), 'open')}>Reopen</button>}
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>No periods yet. Create one to open the books.</td></tr>}
          </tbody>
        </table>
      </div>
      {modalOpen && <PeriodModal busy={busy} onClose={() => setModalOpen(false)} onSave={save} />}
    </div>
  );
}

function PeriodModal({ busy, onClose, onSave }: { busy: boolean; onClose: () => void; onSave: (p: Rec) => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [status, setStatus] = useState('OPEN');
  const [err, setErr] = useState('');
  const submit = () => {
    if (!code.trim() || !name.trim() || !startDate || !endDate) { setErr('Code, name, start and end dates are required'); return; }
    onSave({ code: code.trim().toUpperCase(), name: name.trim(), startDate, endDate, status });
  };
  return (
    <Modal title="New financial period" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={submit}>Create period</button>
      </>
    }>
      {err && <ErrorBanner error={err} />}
      <div className="form-grid">
        <div className="field field-required"><label>Code</label><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="2026-09" /></div>
        <div className="field field-required"><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="September 2026" /></div>
        <div className="field field-required"><label>Start</label><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
        <div className="field field-required"><label>End</label><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>
        <div className="field"><label>Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {PERIOD_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
      </div>
    </Modal>
  );
}

function TaxDesk() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [from, setFrom] = useState(() => { const t = new Date(); return `${t.getFullYear()}-01-01`; });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [taxes, setTaxes] = useState<Rec[]>([]);
  const [accounts, setAccounts] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<Rec | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [confirm, setConfirm] = useState<Rec | null>(null);
  const load = useCallback(() => {
    const p = new URLSearchParams({ from, to });
    api<{ data: Rec }>(`/api/ops/finance/tax?${p}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Tax failed'));
  }, [from, to]);
  const loadTaxes = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/finance/taxes')
      .then((r) => setTaxes(r.data ?? []))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    loadTaxes();
    api<{ data: Rec[] }>('/api/ops/finance/accounts')
      .then((r) => setAccounts(r.data ?? []))
      .catch(() => undefined);
  }, [load, loadTaxes]);
  const save = async (payload: Rec) => {
    setBusy(true); setError('');
    try {
      if (modal) {
        await api(`/api/ops/finance/taxes/${modal.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        await api('/api/ops/finance/taxes', { method: 'POST', body: JSON.stringify(payload) });
      }
      setModalOpen(false); setModal(null);
      loadTaxes();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const deactivate = async () => {
    if (!confirm) return;
    setBusy(true); setError('');
    try {
      await api(`/api/ops/finance/taxes/${confirm.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: false }) });
      setConfirm(null);
      loadTaxes();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  if (!data) return error ? <ErrorBanner error={error} /> : <PageLoader label="Reading VAT account..." />;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Tax</p>
          <h1>VAT control</h1>
          <p className="muted">{String(data.from)} {'\u2192'} {String(data.to)}. Taken from VAT account postings, not from invoice reports alone.</p>
        </div>
        {can(user, 'finance.taxes.create') && <button className="btn btn-primary" onClick={() => { setModal(null); setModalOpen(true); }}>New tax code</button>}
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <input type="date" className="search-input" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <input type="date" className="search-input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
      </div>
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Output VAT</span><span className="kpi-value">{fmtMoney(data.outputVat)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Input VAT</span><span className="kpi-value">{fmtMoney(data.inputVat)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Net payable</span><span className="kpi-value">{fmtMoney(data.netVat)}</span></div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3>Tax codes</h3>
          <span className="muted">{taxes.length} codes</span>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Code</th><th>Name</th><th>Type</th><th className="cell-num">Rate</th><th>GL account</th><th>Status</th><th /></tr></thead>
            <tbody>
              {taxes.map((t) => (
                <tr key={String(t.id)} className={t.isActive === false ? 'row-warn' : undefined}>
                  <td className="cell-mono">{String(t.code)}</td>
                  <td>{String(t.name)}</td>
                  <td>{String(t.taxType)}</td>
                  <td className="cell-num">{Number(t.rate)}%</td>
                  <td className="cell-mono">{String(t.accountCode ?? '') || '\u2014'}</td>
                  <td><Badge value={t.isActive === false ? 'Inactive' : 'Active'} /></td>
                  <td>
                    <div className="row-actions">
                      {can(user, 'finance.taxes.update') && <button className="btn btn-sm" onClick={() => { setModal(t); setModalOpen(true); }}>Edit</button>}
                      {can(user, 'finance.taxes.update') && t.isActive !== false && <button className="btn btn-sm" onClick={() => setConfirm(t)}>Deactivate</button>}
                    </div>
                  </td>
                </tr>
              ))}
              {taxes.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>No tax codes yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {modalOpen && <TaxModal row={modal} accounts={accounts} busy={busy} onClose={() => { setModalOpen(false); setModal(null); }} onSave={save} />}
      {confirm && (
        <ConfirmDialog
          title="Deactivate tax code?"
          body={`${String(confirm.code)} ${String(confirm.name)} will stop being offered on new transactions. Historical postings stay intact.`}
          confirmLabel="Deactivate"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => { setConfirm(null); void deactivate(); }}
        />
      )}
    </div>
  );
}

function TaxModal({ row, accounts, busy, onClose, onSave }: { row: Rec | null; accounts: Rec[]; busy: boolean; onClose: () => void; onSave: (p: Rec) => void }) {
  const [code, setCode] = useState(row ? String(row.code ?? '') : '');
  const [name, setName] = useState(row ? String(row.name ?? '') : '');
  const [taxType, setTaxType] = useState(row ? String(row.taxType ?? 'VAT') : 'VAT');
  const [rate, setRate] = useState(row ? String(row.rate ?? '') : '');
  const [accountId, setAccountId] = useState(row && row.accountId != null ? String(row.accountId) : '');
  const [err, setErr] = useState('');
  const submit = () => {
    if (!row && !code.trim()) { setErr('Code is required'); return; }
    if (!name.trim() || !rate) { setErr('Name and rate are required'); return; }
    onSave({
      ...(row ? {} : { code: code.trim().toUpperCase() }),
      name: name.trim(),
      taxType,
      rate: Number(rate),
      accountId: accountId ? Number(accountId) : null,
    });
  };
  return (
    <Modal title={row ? `Edit ${String(row.code)}` : 'New tax code'} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={submit}>{row ? 'Save changes' : 'Create tax'}</button>
      </>
    }>
      {err && <ErrorBanner error={err} />}
      <div className="form-grid">
        {!row && <div className="field field-required"><label>Code</label><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="VAT18" /></div>}
        <div className="field field-required"><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label>Type</label>
          <select value={taxType} onChange={(e) => setTaxType(e.target.value)}>
            {TAX_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        <div className="field field-required"><label>Rate (%)</label><input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>GL account</label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">None</option>
            {accounts.map((a) => <option key={String(a.id)} value={String(a.id)}>{String(a.code)} {'\u00b7'} {String(a.name)}</option>)}
          </select>
        </div>
      </div>
    </Modal>
  );
}
function Coa() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [parents, setParents] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<Rec | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [confirm, setConfirm] = useState<Rec | null>(null);
  const load = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/finance/accounts')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'COA failed'));
  }, []);
  useEffect(() => {
    load();
    api<{ data: Rec[] }>('/api/ops/finance/accounts')
      .then((r) => setParents((r.data ?? []).filter((a) => !a.isPosting)))
      .catch(() => undefined);
  }, [load]);
  const save = async (payload: Rec) => {
    setBusy(true); setError('');
    try {
      if (modal) {
        await api(`/api/ops/finance/accounts/${modal.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        await api('/api/ops/finance/accounts', { method: 'POST', body: JSON.stringify(payload) });
      }
      setModalOpen(false); setModal(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const deactivate = async () => {
    if (!confirm) return;
    setBusy(true); setError('');
    try {
      await api(`/api/ops/finance/accounts/${confirm.id}/deactivate`, { method: 'POST', body: '{}' });
      setConfirm(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const parentCode = (id: unknown) => {
    const p = rows.find((x) => String(x.id) === String(id));
    return p ? String(p.code) : '';
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Master data</p>
          <h1>Chart of accounts</h1>
          <p className="muted">Posting is allowed only on leaf accounts marked posting. Inactive accounts stay on history.</p>
        </div>
        {can(user, 'finance.chart_of_accounts.create') && <button className="btn btn-primary" onClick={() => { setModal(null); setModalOpen(true); }}>New account</button>}
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Subtype</th><th>Parent</th><th>Posting</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className={r.isActive === false ? 'row-warn' : undefined}>
                <td className="cell-mono">{String(r.code)}</td>
                <td>{String(r.name)}</td>
                <td>{String(r.accountType).replace(/_/g, ' ')}</td>
                <td>{String(r.subtype ?? '') || '\u2014'}</td>
                <td className="cell-mono">{parentCode(r.parentId) || '\u2014'}</td>
                <td>{r.isPosting ? 'Yes' : 'Heading'}</td>
                <td><Badge value={r.isActive === false ? 'Inactive' : 'Active'} /></td>
                <td>
                  <div className="row-actions">
                    {can(user, 'finance.chart_of_accounts.update') && <button className="btn btn-sm" onClick={() => { setModal(r); setModalOpen(true); }}>Edit</button>}
                    {can(user, 'finance.chart_of_accounts.delete') && r.isActive !== false && <button className="btn btn-sm" onClick={() => setConfirm(r)}>Deactivate</button>}
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No accounts yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {modalOpen && <AccountModal row={modal} parents={parents} busy={busy} onClose={() => { setModalOpen(false); setModal(null); }} onSave={save} />}
      {confirm && (
        <ConfirmDialog
          title="Deactivate account?"
          body={`${String(confirm.code)} ${String(confirm.name)} will stop accepting new postings. Historical balances stay intact.`}
          confirmLabel="Deactivate"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => { setConfirm(null); void deactivate(); }}
        />
      )}
    </div>
  );
}

function AccountModal({ row, parents, busy, onClose, onSave }: { row: Rec | null; parents: Rec[]; busy: boolean; onClose: () => void; onSave: (p: Rec) => void }) {
  const [code, setCode] = useState(row ? String(row.code ?? '') : '');
  const [name, setName] = useState(row ? String(row.name ?? '') : '');
  const [accountType, setAccountType] = useState(row ? String(row.accountType ?? 'ASSET') : 'ASSET');
  const [subtype, setSubtype] = useState(row ? String(row.subtype ?? '') : '');
  const [parentId, setParentId] = useState(row && row.parentId != null ? String(row.parentId) : '');
  const [isPosting, setIsPosting] = useState(row ? Boolean(row.isPosting) : false);
  const [currency, setCurrency] = useState(row ? String(row.currency ?? 'UGX') : 'UGX');
  const [openingBalance, setOpeningBalance] = useState(row ? String(row.openingBalance ?? '') : '');
  const [err, setErr] = useState('');
  const submit = () => {
    if (!row && !code.trim()) { setErr('Code is required'); return; }
    if (!name.trim()) { setErr('Name is required'); return; }
    onSave({
      ...(row ? {} : { code: code.trim().toUpperCase() }),
      name: name.trim(),
      accountType,
      subtype: subtype.trim() || null,
      parentId: parentId ? Number(parentId) : null,
      isPosting,
      currency,
      openingBalance: Number(openingBalance || 0),
    });
  };
  return (
    <Modal title={row ? `Edit ${String(row.code)}` : 'New account'} onClose={onClose} wide footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={submit}>{row ? 'Save changes' : 'Create account'}</button>
      </>
    }>
      {err && <ErrorBanner error={err} />}
      <div className="form-grid">
        {!row && <div className="field field-required"><label>Code</label><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="5100" /></div>}
        <div className="field field-required"><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label>Type</label>
          <select value={accountType} onChange={(e) => setAccountType(e.target.value)}>
            {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        <div className="field"><label>Subtype</label><input value={subtype} onChange={(e) => setSubtype(e.target.value)} placeholder="e.g. CURRENT_ASSET" /></div>
        <div className="field"><label>Parent (heading)</label>
          <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">None</option>
            {parents.map((a) => <option key={String(a.id)} value={String(a.id)}>{String(a.code)} {'\u00b7'} {String(a.name)}</option>)}
          </select>
        </div>
        <div className="field"><label>Currency</label><input value={currency} onChange={(e) => setCurrency(e.target.value)} /></div>
        <div className="field"><label>Opening balance</label><input inputMode="decimal" value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label><input type="checkbox" checked={isPosting} onChange={(e) => setIsPosting(e.target.checked)} /> Posting account (leaf account journals can post to)</label>
        </div>
      </div>
    </Modal>
  );
}
function BudgetList() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (q.trim()) p.set('q', q.trim());
    if (status) p.set('status', status);
    api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/finance/budgets?${p}`)
      .then((r) => { setRows(r.data.rows ?? []); setTotal(r.data.total ?? 0); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Budgets failed'));
  }, [q, status, page]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Planning</p>
          <h1>Budgets</h1>
          <p className="muted">Expense plans by account. Drafts stay editable until approved.</p>
        </div>
        {can(user, 'finance.budgets.create') && <button className="btn btn-primary" onClick={() => navigate('/finance/budgets/new')}>New budget</button>}
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <input className="search-input" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search budget no..." />
        <StatusSelect value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={BUDGET_STATUSES} />
        <span className="muted">{total} budgets</span>
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Budget</th><th>Period</th><th className="cell-num">Lines</th><th className="cell-num">Amount</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/finance/budgets/${r.id}`)}>
                <td className="cell-mono">{String(r.budgetNo)}</td>
                <td>{String(r.periodStart).slice(0, 10)} {'\u2192'} {String(r.periodEnd).slice(0, 10)}</td>
                <td className="cell-num">{fmtNum(r.lineCount)}</td>
                <td className="cell-num">{fmtMoney(r.amount)}</td>
                <td><Badge value={r.status} /></td>
                <td>
                  <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="btn btn-sm" onClick={() => navigate(`/finance/budgets/${r.id}`)}>Open</button>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>No budgets match these filters.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={page} pageSize={20} total={total} onPage={setPage} />
    </div>
  );
}

function BudgetDetail({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<{ budget: Rec; lines: Rec[] } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ data: { budget: Rec; lines: Rec[] } }>(`/api/ops/finance/budgets/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Budget failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const act = async (action: 'submit' | 'approve' | 'close') => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/ops/finance/budgets/${id}/${action}`, { method: 'POST', body: '{}' });
      setNotice(action === 'submit' ? 'Budget submitted for approval.' : action === 'approve' ? 'Budget approved.' : 'Budget closed.');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  if (!doc) return error ? <div className="page"><ErrorBanner error={error} /></div> : <PageLoader label="Reading budget..." />;
  const b = doc.budget;
  const status = String(b.status);
  const canEdit = can(user, 'finance.budgets.update') && (status === 'DRAFT' || status === 'SUBMITTED');
  const linesTotal = doc.lines.reduce((s, l) => s + Number(l.amount || 0), 0);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/finance/budgets')}>Back</button>
          <h1>Budget <span className="cell-mono">{String(b.budgetNo)}</span></h1>
          <p className="muted">{String(b.periodStart).slice(0, 10)} {'\u2192'} {String(b.periodEnd).slice(0, 10)} {'\u00b7'} {fmtMoney(b.amount)} planned</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DownloadMenu type="budget" id={id} code={String(b.budgetNo)} />
          <Badge value={b.status} />
          {canEdit && <button className="btn" onClick={() => navigate(`/finance/budgets/${id}/edit`)}>Edit</button>}
          {can(user, 'finance.budgets.submit') && status === 'DRAFT' && <button className="btn" disabled={busy} onClick={() => act('submit')}>Submit</button>}
          {can(user, 'finance.budgets.approve') && (status === 'DRAFT' || status === 'SUBMITTED') && <button className="btn btn-primary" disabled={busy} onClick={() => act('approve')}>Approve</button>}
          {can(user, 'finance.budgets.close') && (status === 'APPROVED' || status === 'ACTIVE') && <button className="btn" disabled={busy} onClick={() => act('close')}>Close</button>}
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      {notice && <div className="alert alert-success">{notice}</div>}
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Approved</span><span className="kpi-value">{fmtMoney(b.amount)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Committed</span><span className="kpi-value">{fmtMoney(b.committed)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Actual</span><span className="kpi-value">{fmtMoney(b.actual)}</span></div>
        <div className={`kpi-card ${Number(b.available) < 0 ? 'card-warn' : ''}`}>
          <span className="kpi-label">Available</span>
          <span className="kpi-value">{fmtMoney(b.available)}</span>
          <span className="kpi-sub">Approved − committed − actual</span>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h3>Lines</h3><span className="muted">{doc.lines.length} accounts · {fmtMoney(linesTotal)} planned</span></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Code</th><th>Account</th><th className="cell-num">Approved</th><th className="cell-num">Committed</th><th className="cell-num">Actual</th><th className="cell-num">Available</th><th className="cell-num">Used</th></tr></thead>
            <tbody>
              {doc.lines.map((l) => (
                <tr key={String(l.id)} className={Number(l.available) < 0 ? 'row-warn' : undefined}>
                  <td className="cell-mono">{String(l.accountCode)}</td>
                  <td>{String(l.accountName)}</td>
                  <td className="cell-num">{fmtMoney(l.amount)}</td>
                  <td className="cell-num">{fmtMoney(l.committed)}</td>
                  <td className="cell-num">{fmtMoney(l.actual)}</td>
                  <td className="cell-num">{fmtMoney(l.available)}</td>
                  <td className="cell-num">{fmtNum(l.consumption)}%</td>
                </tr>
              ))}
              <tr>
                <td colSpan={2}><strong>Total</strong></td>
                <td className="cell-num"><strong>{fmtMoney(linesTotal)}</strong></td>
                <td className="cell-num"><strong>{fmtMoney(b.committed)}</strong></td>
                <td className="cell-num"><strong>{fmtMoney(b.actual)}</strong></td>
                <td className="cell-num"><strong>{fmtMoney(b.available)}</strong></td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function BudgetComposer({ id }: { id?: number }) {
  const isEdit = id != null;
  const [accounts, setAccounts] = useState<Rec[]>([]);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [lines, setLines] = useState<{ key: string; accountId: string; amount: string }[]>([{ key: '1', accountId: '', amount: '' }]);
  const [ready, setReady] = useState(!isEdit);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/finance/accounts')
      .then((r) => setAccounts((r.data ?? []).filter((a) => String(a.accountType) === 'EXPENSE' && a.isPosting)))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!isEdit) return;
    api<{ data: { budget: Rec; lines: Rec[] } }>(`/api/ops/finance/budgets/${id}`)
      .then((r) => {
        setPeriodStart(String(r.data.budget.periodStart).slice(0, 10));
        setPeriodEnd(String(r.data.budget.periodEnd).slice(0, 10));
        setLines(r.data.lines.map((l, i) => ({ key: String(l.id ?? i), accountId: String(l.accountId), amount: String(l.amount) })));
        setReady(true);
      })
      .catch((e) => { setError(e instanceof Error ? e.message : 'Budget failed'); setReady(true); });
  }, [id, isEdit]);
  const total = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
  const save = async () => {
    setError('');
    if (!periodStart || !periodEnd) { setError('Budget period start and end are required'); return; }
    const payload = lines.filter((l) => l.accountId && Number(l.amount) > 0).map((l) => ({ accountId: Number(l.accountId), amount: Number(l.amount) }));
    if (!payload.length) { setError('At least one line with a positive amount is required'); return; }
    setBusy(true);
    try {
      if (isEdit) {
        await api(`/api/ops/finance/budgets/${id}`, { method: 'PATCH', body: JSON.stringify({ periodStart, periodEnd, lines: payload }) });
        navigate(`/finance/budgets/${id}`);
      } else {
        const r = await api<{ data: { budget: Rec } }>('/api/ops/finance/budgets', { method: 'POST', body: JSON.stringify({ periodStart, periodEnd, lines: payload }) });
        navigate(`/finance/budgets/${r.data.budget.id}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  if (!ready) return <PageLoader label="Loading budget..." />;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate(isEdit ? `/finance/budgets/${id}` : '/finance/budgets')}>Back</button>
          <h1>{isEdit ? 'Edit budget' : 'New budget'}</h1>
          <p className="muted">Expense accounts only. Drafts and submitted budgets stay editable until approved.</p>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field field-required"><label>Period start</label><input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} /></div>
          <div className="field field-required"><label>Period end</label><input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></div>
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <h3>Lines</h3>
          <button className="btn btn-sm" onClick={() => setLines((p) => [...p, { key: `${Date.now()}`, accountId: '', amount: '' }])}>+ Line</button>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Expense account</th><th className="cell-num">Amount</th><th /></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td>
                    <select className="cell-input" value={l.accountId} onChange={(e) => setLines((p) => p.map((x) => x.key === l.key ? { ...x, accountId: e.target.value } : x))}>
                      <option value="">Select...</option>
                      {accounts.map((a) => <option key={String(a.id)} value={String(a.id)}>{String(a.code)} {'\u00b7'} {String(a.name)}</option>)}
                    </select>
                  </td>
                  <td><input className="cell-input" inputMode="decimal" value={l.amount} onChange={(e) => setLines((p) => p.map((x) => x.key === l.key ? { ...x, amount: e.target.value } : x))} /></td>
                  <td><button className="btn btn-sm" onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))}>Remove</button></td>
                </tr>
              ))}
              <tr>
                <td><strong>Total</strong></td>
                <td className="cell-num"><strong>{fmtMoney(total)}</strong></td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <div className="sticky-actions" style={{ display: 'flex' }}>
        <button className="btn btn-primary" disabled={busy} onClick={save}>{isEdit ? 'Save changes' : 'Create budget'}</button>
      </div>
    </div>
  );
}

// ============================================================
// Staff cash advances / imprest
// ============================================================

function Advances({ autoOpen }: { autoOpen?: boolean }) {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [confirm, setConfirm] = useState<Rec | null>(null);
  const load = useCallback(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (q.trim()) p.set('q', q.trim());
    if (status) p.set('status', status);
    api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/finance/advances?${p}`)
      .then((r) => { setRows(r.data.rows ?? []); setTotal(r.data.total ?? 0); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Advances failed'));
  }, [q, status, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (autoOpen) setModalOpen(true); }, [autoOpen]);
  const save = async (payload: Rec) => {
    setBusy(true); setError('');
    try {
      await api('/api/ops/finance/advances', { method: 'POST', body: JSON.stringify(payload) });
      setModalOpen(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const doVoid = async (r: Rec, reason: string) => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/finance/advances/${String(r.id)}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
      setConfirm(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Treasury</p>
          <h1>Staff advances</h1>
          <p className="muted">Cash advanced to staff or for office needs (imprest), issued from a bank or cash account. Each advance posts Dr Staff Advances (1510), Cr source account.</p>
        </div>
        {can(user, 'finance.advances.create') && (
          <button className="btn btn-primary" onClick={() => setModalOpen(true)}>Issue advance</button>
        )}
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="toolbar">
        <input className="search-input" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search advance no, holder, reference..." />
        <StatusSelect value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={ADVANCE_STATUSES} />
        <span className="muted">{total} advances</span>
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Advance</th><th>Date</th><th>Holder</th><th>Source</th><th className="cell-num">Amount</th><th className="cell-num">Outstanding</th><th>Purpose</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/finance/advances/${r.id}`)}>
                <td className="cell-mono">{String(r.advanceNo)}</td>
                <td>{String(r.advanceDate).slice(0, 10)}</td>
                <td>{String(r.holderName ?? '')} {r.employeeId ? <span className="muted">(staff)</span> : null}</td>
                <td><span className="cell-mono">{String(r.bankCode)}</span> <span className="muted">{String(r.bankName ?? '')}</span></td>
                <td className="cell-num">{fmtMoney(r.baseAmount)} <span className="muted">UGX</span></td>
                <td className="cell-num">{fmtMoney(r.outstanding)}</td>
                <td>{String(r.purpose ?? '') || '\u2014'}</td>
                <td><Badge value={r.status} /></td>
                <td>
                  <div className="row-actions">
                    {r.status === 'POSTED' && can(user, 'finance.advances.void') && (
                      <button className="btn btn-sm" disabled={busy} onClick={(e) => { e.stopPropagation(); setConfirm(r); }}>Void</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 24 }}>No advances yet. Issue cash to a staff member or as imprest for office needs.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={page} pageSize={20} total={total} onPage={setPage} />
      {modalOpen && <AdvanceModal busy={busy} onClose={() => setModalOpen(false)} onSave={save} />}
      {confirm && (
        <ConfirmDialog
          title="Void this advance?"
          body="The advance is marked VOID and any posted journal is reversed. Only advances with no settlements can be voided."
          confirmLabel="Void advance"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => { void doVoid(confirm, reason); }}
        />
      )}
    </div>
  );
}

function AdvanceModal({ busy, onClose, onSave }: { busy: boolean; onClose: () => void; onSave: (p: Rec) => void }) {
  const [banks, setBanks] = useState<Rec[]>([]);
  const [employees, setEmployees] = useState<Rec[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [holderName, setHolderName] = useState('');
  const [bankId, setBankId] = useState('');
  const [amount, setAmount] = useState('');
  const [advanceDate, setAdvanceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [purpose, setPurpose] = useState('');
  const [reference, setReference] = useState('');
  const [exchangeRate, setExchangeRate] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    api<{ data: { rows: Rec[]; cash: number } }>('/api/ops/finance/banks')
      .then((r) => setBanks(r.data?.rows ?? []))
      .catch(() => undefined);
    api<{ data: { rows: Rec[] } }>('/api/ops/hr/employees?status=ACTIVE&pageSize=100')
      .then((r) => setEmployees(r.data?.rows ?? []))
      .catch(() => undefined);
  }, []);
  const bank = banks.find((b) => String(b.id) === String(bankId));
  const currency = String(bank?.currency ?? '');
  const foreign = Boolean(bank && currency && currency !== 'UGX');
  useEffect(() => {
    if (!foreign || exchangeRate) return;
    let alive = true;
    api<{ data: { rate: number | null } }>(`/api/ops/finance/banks/exchange-rate?code=${encodeURIComponent(currency)}`)
      .then((r) => { if (alive && r.data?.rate) setExchangeRate(String(r.data.rate)); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [foreign, currency, exchangeRate]);
  const onEmployee = (v: string) => {
    setEmployeeId(v);
    if (v) {
      const e = employees.find((x) => String(x.id) === v);
      if (e) setHolderName(`${String(e.firstName)} ${String(e.lastName)}`);
    }
  };
  const submit = () => {
    if (!bankId) { setErr('Select the source bank or cash account'); return; }
    const amt = Number(amount);
    if (!(amt > 0)) { setErr('Enter a positive amount'); return; }
    if (!holderName.trim()) { setErr('Holder name is required (or select an employee)'); return; }
    if (!advanceDate) { setErr('Advance date is required'); return; }
    if (foreign && !(Number(exchangeRate) > 0)) { setErr(`Exchange rate required to issue an advance in ${currency}`); return; }
    onSave({
      bankId: Number(bankId),
      amount: amt,
      advanceDate,
      employeeId: employeeId ? Number(employeeId) : null,
      holderName: holderName.trim(),
      purpose: purpose.trim() || null,
      reference: reference.trim() || null,
      ...(foreign ? { exchangeRate: Number(exchangeRate) } : {}),
    });
  };
  return (
    <Modal title="Issue staff advance" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Posting...' : 'Post advance'}</button>
      </>
    }>
      {err && <ErrorBanner error={err} />}
      <div className="form-grid">
        <div className="field"><label>Employee</label>
          <select value={employeeId} onChange={(e) => onEmployee(e.target.value)}>
            <option value="">None - manual holder</option>
            {employees.map((e) => <option key={String(e.id)} value={String(e.id)}>{String(e.firstName)} {String(e.lastName)} {String(e.employeeNo ?? '')}</option>)}
          </select>
        </div>
        <div className="field field-required"><label>Holder name</label><input value={holderName} onChange={(e) => setHolderName(e.target.value)} placeholder="e.g. Office water / airtime advance" /></div>
        <div className="field field-required"><label>From account</label>
          <select value={bankId} onChange={(e) => setBankId(e.target.value)}>
            <option value="">Select source...</option>
            {banks.map((b) => <option key={String(b.id)} value={String(b.id)}>{String(b.code)} {'\u00b7'} {String(b.name)} ({String(b.currency)} {'\u00b7'} {fmtMoney(b.bookBalance)})</option>)}
          </select>
        </div>
        <div className="field field-required"><label>Amount</label><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></div>
        {foreign && <div className="field field-required"><label>Exchange rate (UGX per 1 {currency})</label><input inputMode="decimal" value={exchangeRate} onChange={(e) => setExchangeRate(e.target.value)} placeholder="e.g. 3800" /></div>}
        <div className="field field-required"><label>Date</label><input type="date" value={advanceDate} onChange={(e) => setAdvanceDate(e.target.value)} /></div>
        <div className="field"><label>Purpose</label><input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Office water, airtime, fuel" /></div>
        <div className="field"><label>Reference</label><input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" /></div>
      </div>
    </Modal>
  );
}

function AdvanceDetail({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<{ advance: Rec; settlements: Rec[]; journal: { journal: Rec; lines: Rec[] } | null } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [settleOpen, setSettleOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const load = useCallback(() => {
    api<{ data: { advance: Rec; settlements: Rec[]; journal: { journal: Rec; lines: Rec[] } | null } }>(`/api/ops/finance/advances/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Advance failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const saveSettle = async (payload: Rec) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/ops/finance/advances/${id}/settle`, { method: 'POST', body: JSON.stringify(payload) });
      setSettleOpen(false);
      setNotice('Settlement posted. The advance receivable has been reduced.');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const doVoid = async (reason: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/ops/finance/advances/${id}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
      setNotice('Advance voided. Any posted journal has been reversed.');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  if (!doc) return error ? <div className="page"><ErrorBanner error={error} /></div> : <PageLoader label="Reading advance..." />;
  const a = doc.advance;
  const journal = doc.journal?.journal ?? null;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" onClick={() => navigate('/finance/advances')}>Back</button>
          <h1>Advance <span className="cell-mono">{String(a.advanceNo)}</span></h1>
          <p className="muted">{String(a.advanceDate).slice(0, 10)} {'\u00b7'} {String(a.holderName ?? '')}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {journal && <button className="btn btn-sm" onClick={() => navigate(`/finance/journals/${journal.id}`)}>Linked journal</button>}
          <Badge value={a.status} />
        </div>
      </header>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field"><label>Holder</label><div className="field-value">{String(a.holderName ?? '')}{a.employeeId ? ' (staff)' : ''}</div></div>
          <div className="field"><label>Source account</label><div className="field-value"><span className="cell-mono">{String(a.bankCode)}</span> {String(a.bankName ?? '')}</div></div>
          <div className="field"><label>Amount</label><div className="field-value">{fmtMoney(a.baseAmount)} <span className="muted">UGX base</span></div></div>
          <div className="field"><label>Outstanding</label><div className="field-value">{fmtMoney(a.outstanding)}</div></div>
          <div className="field"><label>Currency</label><div className="field-value">{String(a.currency)}{a.currency !== 'UGX' ? <> {'\u00b7'} {fmtNum(a.exchangeRate)} UGX per 1 {String(a.currency)}</> : null}</div></div>
          <div className="field"><label>Reference</label><div className="field-value">{String(a.reference ?? '') || '\u2014'}</div></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Purpose</label><div className="field-value">{String(a.purpose ?? '') || '\u2014'}</div></div>
        </div>
      </section>
      <div className="flow-actions" style={{ flexDirection: 'row' }}>
        {a.status === 'POSTED' && can(user, 'finance.advances.settle') && (
          <button className="btn btn-primary" disabled={busy} onClick={() => setSettleOpen(true)}>Settle advance</button>
        )}
        {a.status !== 'VOID' && can(user, 'finance.advances.void') && (
          <button className="btn btn-danger" disabled={busy} onClick={() => setConfirm(true)}>Void advance</button>
        )}
      </div>
      <section className="card card-pad">
        <h3>Settlements</h3>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>No</th><th>Date</th><th>Account</th><th className="cell-num">Amount</th><th>Method</th><th>Reference</th></tr></thead>
            <tbody>
              {doc.settlements.map((s) => (
                <tr key={String(s.id)}>
                  <td className="cell-mono">{String(s.settlementNo)}</td>
                  <td>{String(s.settlementDate).slice(0, 10)}</td>
                  <td className="cell-mono">{String(s.accountCode)} {String(s.accountName)}</td>
                  <td className="cell-num">{fmtMoney(s.amount)}</td>
                  <td>{String(s.method).replace(/_/g, ' ')}</td>
                  <td>{String(s.reference ?? '') || '\u2014'}</td>
                </tr>
              ))}
              {doc.settlements.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>No settlements yet. Settle the advance against expense accounts to clear the receivable.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      {settleOpen && <SettleModal advance={a} busy={busy} onClose={() => setSettleOpen(false)} onSave={saveSettle} />}
      {confirm && (
        <ConfirmDialog
          title="Void this advance?"
          body="The advance is marked VOID and any posted journal is reversed. Only advances with no settlements can be voided."
          confirmLabel="Void advance"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={(reason) => { setConfirm(false); void doVoid(reason); }}
        />
      )}
    </div>
  );
}

function SettleModal({ advance, busy, onClose, onSave }: { advance: Rec; busy: boolean; onClose: () => void; onSave: (p: Rec) => void }) {
  const [accounts, setAccounts] = useState<Rec[]>([]);
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [settlementDate, setSettlementDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState('CASH');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/finance/accounts')
      .then((r) => {
        const all = r.data ?? [];
        const exps = all.filter((a) => String(a.accountType) === 'EXPENSE' || String(a.accountType).startsWith('CONTRA'));
        setAccounts(exps.length ? exps : all.filter((a) => a.isPosting !== false));
      })
      .catch(() => undefined);
  }, []);
  const submit = () => {
    const amt = Number(amount);
    if (!(amt > 0)) { setErr('Enter a positive amount'); return; }
    if (amt > Number(advance.outstanding ?? 0) + 0.005) { setErr(`Amount exceeds the outstanding balance of ${fmtMoney(advance.outstanding)}`); return; }
    if (!accountId) { setErr('Select the expense account to settle against'); return; }
    if (!settlementDate) { setErr('Settlement date is required'); return; }
    onSave({ amount: amt, accountId: Number(accountId), settlementDate, method, reference: reference.trim() || null, notes: notes.trim() || null });
  };
  return (
    <Modal title={`Settle advance ${String(advance.advanceNo ?? '')}`} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Posting...' : 'Post settlement'}</button>
      </>
    }>
      {err && <ErrorBanner error={err} />}
      <div className="form-grid">
        <div className="field field-required"><label>Amount (UGX)</label><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`Outstanding ${fmtMoney(advance.outstanding)}`} /></div>
        <div className="field field-required"><label>Settle against</label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Select expense account...</option>
            {accounts.map((a) => <option key={String(a.id)} value={String(a.id)}>{String(a.code)} {'\u00b7'} {String(a.name)}</option>)}
          </select>
        </div>
        <div className="field"><label>Method</label>
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="CASH">Cash</option>
            <option value="BANK">Bank</option>
          </select>
        </div>
        <div className="field field-required"><label>Date</label><input type="date" value={settlementDate} onChange={(e) => setSettlementDate(e.target.value)} /></div>
        <div className="field"><label>Reference</label><input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" /></div>
        <div className="field"><label>Notes</label><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Receipts attached" /></div>
      </div>
    </Modal>
  );
}
// ===================== Advanced Finance & Accounting =====================
function AdvancedOverview() {
  const { user } = useAuth();
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/finance/advanced/summary')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Advanced finance summary failed'));
  }, []);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening the advanced books..." />;
  const tiles = [
    { href: '/finance/journals', label: 'Journals', hint: 'Double-entry workflow', perm: 'finance.journals.view' },
    { href: '/finance/posting-rules', label: 'Posting Rules', hint: 'Configurable accounting engine', perm: 'finance.posting_rules.view' },
    { href: '/finance/efris', label: 'EFRIS', hint: 'URA fiscal compliance', perm: 'finance.efris.view' },
    { href: '/finance/tax-compliance', label: 'Tax Compliance', hint: 'VAT, WHT & filings', perm: 'finance.tax_transactions.view' },
    { href: '/finance/costing', label: 'Manufacturing Costing', hint: 'Production, variance & WIP', perm: 'finance.production_costs.view' },
    { href: '/finance/consolidation', label: 'Consolidation', hint: 'Group financials', perm: 'finance.consolidation.view' },
    { href: '/finance/close', label: 'Period Close', hint: 'Month-end close cockpit', perm: 'finance.close_tasks.view' },
    { href: '/finance/audit', label: 'Audit Trail', hint: 'Immutable financial log', perm: 'finance.audit.view' },
  ];
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Advanced finance</p>
          <h1>Finance & Accounting Command Center</h1>
          <p className="muted">
            {data.trialBalanceOk ? 'Trial balance integrity: OK.' : 'Trial balance integrity: BROKEN - investigate immediately.'}
            {' '}Source transaction → validation → approval → double entry → GL → reporting → audit.
          </p>
        </div>
        <div className="head-actions">
          {can(user, 'finance.journals.create') && <button className="btn btn-primary" onClick={() => navigate('/finance/journals/new')}>New journal</button>}
          {can(user, 'finance.efris.create') && <button className="btn" onClick={() => navigate('/finance/efris')}>Fiscalize</button>}
        </div>
      </header>
      <div className="kpi-grid">
        <button className="kpi-card" onClick={() => navigate('/finance/journals')}>
          <span className="kpi-label">Pending journals</span>
          <span className="kpi-value">{Number(data.pendingJournals)}</span>
          <span className="kpi-sub">Draft / submitted / pending approval</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/finance/efris')}>
          <span className="kpi-label">EFRIS pending</span>
          <span className="kpi-value">{Number(data.pendingEfris)}</span>
          <span className="kpi-sub">{Number(data.fiscalizedEfris)} fiscalized</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/finance/budgets')}>
          <span className="kpi-label">Committed budget</span>
          <span className="kpi-value">{fmtMoney(data.committedBudget)}</span>
          <span className="kpi-sub">Purchase requisitions, POs & contracts</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/finance/costing')}>
          <span className="kpi-label">Production variance</span>
          <span className="kpi-value">{fmtMoney(data.productionVariance)}</span>
          <span className="kpi-sub">Actual vs standard</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/finance/close')}>
          <span className="kpi-label">Open close tasks</span>
          <span className="kpi-value">{Number(data.openCloseTasks)}</span>
          <span className="kpi-sub">Period close cockpit</span>
        </button>
        <button className="kpi-card" onClick={() => navigate('/finance/tax-compliance')}>
          <span className="kpi-label">Tax obligations</span>
          <span className="kpi-value">{fmtMoney(data.taxDue)}</span>
          <span className="kpi-sub">Posted tax transactions</span>
        </button>
      </div>
      <div className="kpi-grid" style={{ marginTop: 16 }}>
        {tiles.filter((t) => can(user, t.perm)).map((t) => (
          <button key={t.href} className="kpi-card" onClick={() => navigate(t.href)}>
            <span className="kpi-label">{t.label}</span>
            <span className="kpi-sub">{t.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PostingRules() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [eventFilter, setEventFilter] = useState('');
  const [applyOpen, setApplyOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const load = useCallback(() => {
    api<{ data: Rec[] }>(`/api/ops/finance/posting-rules${eventFilter ? `?event=${encodeURIComponent(eventFilter)}` : ''}`)
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Posting rules failed'));
  }, [eventFilter]);
  useEffect(() => { load(); }, [load]);
  const save = async (payload: Rec) => {
    setBusy(true); setError('');
    try {
      await api('/api/ops/finance/posting-rules', { method: 'POST', body: JSON.stringify(payload) });
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const apply = async (payload: Rec) => {
    setBusy(true); setError('');
    try {
      const r = await api<{ data: Rec }>('/api/ops/finance/posting-rules/apply', { method: 'POST', body: JSON.stringify(payload) });
      setApplyOpen(false);
      setError(`Posted journal ${String(r.data.entryNo ?? r.data.entryId ?? '')} - ${String(r.data.status ?? 'POSTED')}`);
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Accounting engine</p>
          <h1>Posting rules</h1>
          <p className="muted">Active rules post live sales invoices, receipts and expenses. If a rule is missing or unbalanced, the ledger falls back to the standard double-entry template.</p>
        </div>
        <div className="head-actions">
          <input className="search-input" placeholder="Filter by event" value={eventFilter} onChange={(e) => setEventFilter(e.target.value)} style={{ maxWidth: 200 }} />
          {can(user, 'finance.posting_rules.create') && <button className="btn" onClick={() => setCreateOpen(true)}>New rule</button>}
          {can(user, 'finance.posting_rules.post') && <button className="btn" onClick={() => setApplyOpen(true)}>Apply rule</button>}
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Event</th><th>Code</th><th>Name</th><th>Journal type</th><th>Lines</th><th>Active</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td><Badge value={r.event} /></td>
                <td className="cell-mono">{String(r.code)}</td>
                <td>{String(r.name)}</td>
                <td>{String(r.journalType)}</td>
                <td className="cell-mono">{JSON.stringify(r.lines)}</td>
                <td><Badge value={r.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>No posting rules yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {createOpen && <PostingRuleModal busy={busy} onClose={() => setCreateOpen(false)} onSave={save} />}
      {applyOpen && <ApplyRuleModal busy={busy} onClose={() => setApplyOpen(false)} onSave={apply} />}
    </div>
  );
}

function PostingRuleModal({ busy, onClose, onSave }: { busy: boolean; onClose: () => void; onSave: (p: Rec) => void }) {
  const [event, setEvent] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [journalType, setJournalType] = useState('MANUAL');
  const [lines, setLines] = useState('');
  const submit = () => {
    let parsed: unknown[] = [];
    try { parsed = JSON.parse(lines || '[]'); } catch { onSave({ __error: true } as Rec); return; }
    onSave({ event, code, name, journalType, lines: parsed });
  };
  return (
    <Modal title="New posting rule" onClose={onClose} footer={<button className="btn btn-primary" disabled={busy} onClick={submit}>Create rule</button>}>
      <div className="form-grid">
        <label>Event <input value={event} onChange={(e) => setEvent(e.target.value)} placeholder="GOODS_RECEIVED" /></label>
        <label>Code <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="GRN_STD" /></label>
        <label>Name <input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Journal type <input value={journalType} onChange={(e) => setJournalType(e.target.value)} /></label>
        <label style={{ gridColumn: '1 / -1' }}>
          Lines (JSON) <textarea rows={6} value={lines} onChange={(e) => setLines(e.target.value)} placeholder='[{"accountCode":"1200","debit":"{{amount}}","credit":0}]' />
        </label>
      </div>
    </Modal>
  );
}

function ApplyRuleModal({ busy, onClose, onSave }: { busy: boolean; onClose: () => void; onSave: (p: Rec) => void }) {
  const [event, setEvent] = useState('');
  const [code, setCode] = useState('');
  const [amount, setAmount] = useState('');
  const [net, setNet] = useState('');
  const [tax, setTax] = useState('');
  const [description, setDescription] = useState('');
  const submit = () => onSave({
    event, code: code || undefined, amount: Number(amount), net: net !== '' ? Number(net) : undefined,
    tax: tax !== '' ? Number(tax) : undefined, description: description || undefined,
  });
  return (
    <Modal title="Apply posting rule" onClose={onClose} footer={<button className="btn btn-primary" disabled={busy || !event} onClick={submit}>Post journal</button>}>
      <div className="form-grid">
        <label>Event <input value={event} onChange={(e) => setEvent(e.target.value)} placeholder="SALES_INVOICE" /></label>
        <label>Rule code (optional) <input value={code} onChange={(e) => setCode(e.target.value)} /></label>
        <label>Amount <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label>Net (optional) <input type="number" value={net} onChange={(e) => setNet(e.target.value)} /></label>
        <label>Tax (optional) <input type="number" value={tax} onChange={(e) => setTax(e.target.value)} /></label>
        <label style={{ gridColumn: '1 / -1' }}>Description <input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      </div>
    </Modal>
  );
}
function EfrisDesk() {
  const { user } = useAuth();
  const [tab, setTab] = useState<'txn' | 'docs' | 'logs'>('txn');
  const [rows, setRows] = useState<Rec[]>([]);
  const [docs, setDocs] = useState<Rec[]>([]);
  const [logs, setLogs] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const load = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/finance/efris').then((r) => setRows(r.data ?? [])).catch((e) => setError(e instanceof Error ? e.message : 'EFRIS failed'));
    api<{ data: Rec[] }>('/api/ops/finance/efris/documents').then((r) => setDocs(r.data ?? [])).catch(() => undefined);
    api<{ data: Rec[] }>('/api/ops/finance/efris/logs').then((r) => setLogs(r.data ?? [])).catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (id: number, action: string, payload: Rec = {}) => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/finance/efris/${id}/${action}`, { method: 'POST', body: JSON.stringify(payload) });
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const register = async (payload: Rec) => {
    setBusy(true); setError('');
    try {
      await api('/api/ops/finance/efris', { method: 'POST', body: JSON.stringify(payload) });
      setRegisterOpen(false);
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">URA EFRIS</p>
          <h1>Fiscal compliance adapter</h1>
          <p className="muted">ERP records and fiscal documents stay linked but logically separate. Retries are idempotent - no duplicate fiscal documents.</p>
        </div>
        <div className="head-actions">
          {can(user, 'finance.efris.create') && <button className="btn btn-primary" onClick={() => setRegisterOpen(true)}>Register document</button>}
        </div>
      </header>
      <div className="tabs" style={{ marginBottom: 16 }}>
        {(['txn', 'docs', 'logs'] as const).map((t) => (
          <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
            {t === 'txn' ? 'Transactions' : t === 'docs' ? 'Fiscal documents' : 'Sync logs'}
          </button>
        ))}
      </div>
      {error && <ErrorBanner error={error} />}
      {tab === 'txn' && (
        <div className="table-wrap card">
          <table className="data">
            <thead><tr><th>Ref</th><th>Type</th><th>Date</th><th>Currency</th><th>Gross</th><th>Tax</th><th>Status</th><th>FDN / VRC</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.id)}>
                  <td className="cell-mono">{String(r.docRefCode)}</td>
                  <td>{String(r.docType)}</td>
                  <td>{String(r.txnDate).slice(0, 10)}</td>
                  <td>{String(r.currency)}</td>
                  <td>{fmtMoney(r.grossAmount)}</td>
                  <td>{fmtMoney(r.taxAmount)}</td>
                  <td><Badge value={r.status} /></td>
                  <td className="cell-mono">{String(r.fdn ?? '')}{r.verificationCode ? ` / ${String(r.verificationCode)}` : ''}</td>
                  <td>
                    <div className="row-actions">
                      {can(user, 'finance.efris.sync') && ['PENDING', 'QUEUED', 'TRANSMITTED', 'RETRYING', 'FAILED'].includes(String(r.status)) && <button className="btn btn-sm" disabled={busy} onClick={() => act(Number(r.id), 'sync')}>Sync</button>}
                      {can(user, 'finance.efris.cancel') && ['PENDING', 'QUEUED', 'FAILED', 'RETRYING'].includes(String(r.status)) && <button className="btn btn-sm" disabled={busy} onClick={() => act(Number(r.id), 'cancel', { reason: 'Cancelled in ERP' })}>Cancel</button>}
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 24 }}>No EFRIS transactions. Register a posted invoice to fiscalize it.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'docs' && (
        <div className="table-wrap card">
          <table className="data">
            <thead><tr><th>FDN</th><th>Verification code</th><th>QR ref</th><th>Status</th><th>Transmitted at</th><th>Payload ref</th></tr></thead>
            <tbody>
              {docs.map((r) => (
                <tr key={String(r.id)}>
                  <td className="cell-mono">{String(r.fdn ?? '')}</td>
                  <td className="cell-mono">{String(r.verificationCode ?? '')}</td>
                  <td className="cell-mono">{String(r.fiscalQrRef ?? '')}</td>
                  <td><Badge value={r.status} /></td>
                  <td>{r.transmittedAt ? String(r.transmittedAt) : '-'}</td>
                  <td className="cell-mono">{String(r.responsePayloadRef ?? '')}</td>
                </tr>
              ))}
              {docs.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>No fiscal documents issued yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'logs' && (
        <div className="table-wrap card">
          <table className="data">
            <thead><tr><th>Time</th><th>Status</th><th>Attempt</th><th>Message</th><th>Response ref</th></tr></thead>
            <tbody>
              {logs.map((r) => (
                <tr key={String(r.id)}>
                  <td>{String(r.createdAt)}</td>
                  <td><Badge value={r.status} /></td>
                  <td>{String(r.attemptNo ?? 1)}</td>
                  <td>{String(r.message ?? '')}</td>
                  <td className="cell-mono">{String(r.responsePayloadRef ?? '')}</td>
                </tr>
              ))}
              {logs.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>No sync attempts yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {registerOpen && <EfrisRegisterModal busy={busy} onClose={() => setRegisterOpen(false)} onSave={register} />}
    </div>
  );
}

function EfrisRegisterModal({ busy, onClose, onSave }: { busy: boolean; onClose: () => void; onSave: (p: Rec) => void }) {
  const [docType, setDocType] = useState('SALES_INVOICE');
  const [docRefType, setDocRefType] = useState('sales_invoices');
  const [docRefId, setDocRefId] = useState('');
  const [docRefCode, setDocRefCode] = useState('');
  const [currency, setCurrency] = useState('UGX');
  const [grossAmount, setGrossAmount] = useState('');
  const [taxAmount, setTaxAmount] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const submit = () => onSave({
    docType, docRefType, docRefId: Number(docRefId), docRefCode, currency,
    grossAmount: Number(grossAmount), taxAmount: taxAmount !== '' ? Number(taxAmount) : undefined, idempotencyKey,
  });
  return (
    <Modal title="Register ERP document for EFRIS" onClose={onClose} footer={<button className="btn btn-primary" disabled={busy || !docRefId || !idempotencyKey} onClick={submit}>Register</button>}>
      <div className="form-grid">
        <label>Document type <input value={docType} onChange={(e) => setDocType(e.target.value)} /></label>
        <label>Ref type <input value={docRefType} onChange={(e) => setDocRefType(e.target.value)} /></label>
        <label>Ref ID <input type="number" value={docRefId} onChange={(e) => setDocRefId(e.target.value)} /></label>
        <label>Ref code <input value={docRefCode} onChange={(e) => setDocRefCode(e.target.value)} /></label>
        <label>Currency <input value={currency} onChange={(e) => setCurrency(e.target.value)} /></label>
        <label>Gross amount <input type="number" value={grossAmount} onChange={(e) => setGrossAmount(e.target.value)} /></label>
        <label>Tax amount <input type="number" value={taxAmount} onChange={(e) => setTaxAmount(e.target.value)} /></label>
        <label>Idempotency key <input value={idempotencyKey} onChange={(e) => setIdempotencyKey(e.target.value)} placeholder="inv-2026-0001-sync" /></label>
      </div>
    </Modal>
  );
}function TaxCompliance() {
  const { user } = useAuth();
  const [summary, setSummary] = useState<Rec[]>([]);
  const [rows, setRows] = useState<Rec[]>([]);
  const [jurisdictions, setJurisdictions] = useState<Rec[]>([]);
  const [rules, setRules] = useState<Rec[]>([]);
  const [taxes, setTaxes] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [txnOpen, setTxnOpen] = useState(false);
  const load = useCallback(() => {
    const q = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    api<{ data: Rec[] }>(`/api/ops/finance/tax/compliance${q}`).then((r) => setSummary(r.data ?? [])).catch((e) => setError(e instanceof Error ? e.message : 'Tax compliance failed'));
    api<{ data: Rec[] }>(`/api/ops/finance/tax/transactions${q}`).then((r) => setRows(r.data ?? [])).catch(() => undefined);
    api<{ data: Rec[] }>('/api/ops/finance/tax/jurisdictions').then((r) => setJurisdictions(r.data ?? [])).catch(() => undefined);
    api<{ data: Rec[] }>('/api/ops/finance/tax/rules').then((r) => setRules(r.data ?? [])).catch(() => undefined);
    api<{ data: Rec[] }>('/api/ops/finance/taxes').then((r) => setTaxes(r.data ?? [])).catch(() => undefined);
  }, [from, to]);
  useEffect(() => { load(); }, [load]);
  const save = async (payload: Rec) => {
    setBusy(true); setError('');
    try {
      await api('/api/ops/finance/tax/transactions', { method: 'POST', body: JSON.stringify(payload) });
      setTxnOpen(false);
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Uganda tax</p>
          <h1>Tax compliance</h1>
          <p className="muted">Configurable VAT / WHT / excise engine. Rates and rules are editable - never hardcoded.</p>
        </div>
        <div className="head-actions">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          {can(user, 'finance.tax_transactions.create') && <button className="btn btn-primary" onClick={() => setTxnOpen(true)}>Record tax</button>}
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="kpi-grid">
        {summary.map((s) => (
          <div key={String(s.taxCode)} className="kpi-card">
            <span className="kpi-label">{String(s.taxName)} ({String(s.taxCode)})</span>
            <span className="kpi-value">{fmtMoney(s.taxAmount)}</span>
            <span className="kpi-sub">Base {fmtMoney(s.baseAmount)} · {String(s.txnCount)} txns</span>
          </div>
        ))}
        {summary.length === 0 && <div className="kpi-card"><span className="kpi-label">No posted tax</span><span className="kpi-value">{fmtMoney(0)}</span><span className="kpi-sub">for the selected period</span></div>}
      </div>
      <div className="kpi-grid" style={{ marginTop: 16 }}>
        <div className="kpi-card"><span className="kpi-label">Jurisdictions</span><span className="kpi-value">{jurisdictions.length}</span><span className="kpi-sub">{jurisdictions.map((j) => String(j.code)).join(', ')}</span></div>
        <div className="kpi-card"><span className="kpi-label">Tax rules</span><span className="kpi-value">{rules.length}</span><span className="kpi-sub">Applies-to: {rules.map((r) => String(r.appliesTo)).filter((v, i, a) => a.indexOf(v) === i).join(', ')}</span></div>
      </div>
      <div className="table-wrap card" style={{ marginTop: 16 }}>
        <table className="data">
          <thead><tr><th>Date</th><th>Tax</th><th>Jurisdiction</th><th>Doc</th><th>Base</th><th>Rate</th><th>Tax</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td>{String(r.txnDate).slice(0, 10)}</td>
                <td>{String(r.taxCode)} - {String(r.taxName)}</td>
                <td>{String(r.jurisdictionCode ?? '-')}</td>
                <td className="cell-mono">{String(r.docRefCode ?? r.docType)}</td>
                <td>{fmtMoney(r.baseAmount)}</td>
                <td>{String(r.rate)}%</td>
                <td>{fmtMoney(r.taxAmount)}</td>
                <td><Badge value={r.status} /></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No tax transactions in range.</td></tr>}
          </tbody>
        </table>
      </div>
      {txnOpen && <TaxTxnModal taxes={taxes} busy={busy} onClose={() => setTxnOpen(false)} onSave={save} />}
    </div>
  );
}

function TaxTxnModal({ taxes, busy, onClose, onSave }: { taxes: Rec[]; busy: boolean; onClose: () => void; onSave: (p: Rec) => void }) {
  const [taxId, setTaxId] = useState('');
  const [docType, setDocType] = useState('SALES_INVOICE');
  const [docRefCode, setDocRefCode] = useState('');
  const [baseAmount, setBaseAmount] = useState('');
  const [taxAmount, setTaxAmount] = useState('');
  const submit = () => onSave({
    taxId: Number(taxId), docType, docRefCode: docRefCode || null,
    baseAmount: Number(baseAmount), taxAmount: taxAmount !== '' ? Number(taxAmount) : undefined,
  });
  return (
    <Modal title="Record tax transaction" onClose={onClose} footer={<button className="btn btn-primary" disabled={busy || !taxId || !baseAmount} onClick={submit}>Record</button>}>
      <div className="form-grid">
        <label>Tax code
          <select className="search-input" value={taxId} onChange={(e) => setTaxId(e.target.value)}>
            <option value="">Select tax</option>
            {taxes.map((t) => <option key={String(t.id)} value={String(t.id)}>{String(t.code)} - {String(t.name)} ({String(t.rate)}%)</option>)}
          </select>
        </label>
        <label>Doc type <input value={docType} onChange={(e) => setDocType(e.target.value)} /></label>
        <label>Doc ref code <input value={docRefCode} onChange={(e) => setDocRefCode(e.target.value)} /></label>
        <label>Base amount <input type="number" value={baseAmount} onChange={(e) => setBaseAmount(e.target.value)} /></label>
        <label>Tax amount (blank = auto) <input type="number" value={taxAmount} onChange={(e) => setTaxAmount(e.target.value)} /></label>
      </div>
    </Modal>
  );
}function Costing() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [wip, setWip] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [wipOpen, setWipOpen] = useState(false);
  const load = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/finance/costing/production').then((r) => setRows(r.data ?? [])).catch((e) => setError(e instanceof Error ? e.message : 'Production costing failed'));
    api<{ data: Rec[] }>('/api/ops/finance/costing/wip').then((r) => setWip(r.data ?? [])).catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);
  const save = async (path: string, payload: Rec, close: () => void) => {
    setBusy(true); setError('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(payload) });
      close();
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const post = async (id: number) => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/finance/costing/production/${id}/post`, { method: 'POST', body: '{}' });
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Manufacturing costing</p>
          <h1>Production cost accounting</h1>
          <p className="muted">Raw material + labour + machine + power + consumables + packaging + quality + overhead = production cost. Expected vs actual variance tracked per run.</p>
        </div>
        <div className="head-actions">
          {can(user, 'finance.production_costs.create') && <button className="btn btn-primary" onClick={() => setCaptureOpen(true)}>Capture cost</button>}
          {can(user, 'finance.production_costs.create') && <button className="btn" onClick={() => setWipOpen(true)}>WIP movement</button>}
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Date</th><th>Product</th><th>WO</th><th>Qty</th><th>Expected</th><th>Actual</th><th>Variance</th><th>Cost/unit</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td>{String(r.costDate).slice(0, 10)}</td>
                <td>{String(r.productName ?? r.productId ?? '-')}</td>
                <td className="cell-mono">{String(r.workOrderId ?? '-')}</td>
                <td>{String(r.quantity)}</td>
                <td>{fmtMoney(r.expectedCost)}</td>
                <td>{fmtMoney(r.actualCost)}</td>
                <td>{fmtMoney(r.variance)}</td>
                <td>{fmtMoney(Number(r.quantity) > 0 ? Number(r.actualCost) / Number(r.quantity) : 0)}</td>
                <td><Badge value={r.status} /></td>
                <td>
                  <div className="row-actions">
                    {can(user, 'finance.production_costs.post') && r.status === 'CALCULATED' && <button className="btn btn-sm" disabled={busy} onClick={() => post(Number(r.id))}>Post to GL</button>}
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 24 }}>No production cost captures yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <h2 style={{ marginTop: 24, fontSize: 18 }}>WIP ledger</h2>
      <div className="table-wrap card" style={{ marginTop: 8 }}>
        <table className="data">
          <thead><tr><th>Date</th><th>WO</th><th>Type</th><th>Amount</th><th>Notes</th></tr></thead>
          <tbody>
            {wip.map((r) => (
              <tr key={String(r.id)}>
                <td>{String(r.txnDate).slice(0, 10)}</td>
                <td className="cell-mono">{String(r.workOrderId ?? '-')}</td>
                <td><Badge value={r.txnType} /></td>
                <td>{fmtMoney(r.amount)}</td>
                <td>{String(r.notes ?? '')}</td>
              </tr>
            ))}
            {wip.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>No WIP movements.</td></tr>}
          </tbody>
        </table>
      </div>
      {captureOpen && <CaptureCostModal busy={busy} onClose={() => setCaptureOpen(false)} onSave={(p) => save('/api/ops/finance/costing/production', p, () => setCaptureOpen(false))} />}
      {wipOpen && <WipModal busy={busy} onClose={() => setWipOpen(false)} onSave={(p) => save('/api/ops/finance/costing/wip', p, () => setWipOpen(false))} />}
    </div>
  );
}

function CaptureCostModal({ busy, onClose, onSave }: { busy: boolean; onClose: () => void; onSave: (p: Rec) => void }) {
  const [workOrderId, setWorkOrderId] = useState('');
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [expectedCost, setExpectedCost] = useState('');
  const [components, setComponents] = useState('');
  const submit = () => {
    let parsed: Rec['components'] = [];
    try { parsed = JSON.parse(components || '[]'); } catch { return; }
    onSave({
      workOrderId: workOrderId !== '' ? Number(workOrderId) : null,
      productId: productId !== '' ? Number(productId) : null,
      quantity: Number(quantity), expectedCost: Number(expectedCost), components: parsed,
    });
  };
  return (
    <Modal title="Capture production cost" onClose={onClose} footer={<button className="btn btn-primary" disabled={busy || !quantity || !expectedCost} onClick={submit}>Calculate</button>}>
      <div className="form-grid">
        <label>Work order ID <input type="number" value={workOrderId} onChange={(e) => setWorkOrderId(e.target.value)} /></label>
        <label>Product ID <input type="number" value={productId} onChange={(e) => setProductId(e.target.value)} /></label>
        <label>Quantity <input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
        <label>Expected cost (standard) <input type="number" value={expectedCost} onChange={(e) => setExpectedCost(e.target.value)} /></label>
        <label style={{ gridColumn: '1 / -1' }}>
          Components (JSON) <textarea rows={7} value={components} onChange={(e) => setComponents(e.target.value)} placeholder='[{"componentType":"RAW_MATERIAL","amount":500000},{"componentType":"DIRECT_LABOUR","amount":120000},{"componentType":"MACHINE","amount":80000},{"componentType":"POWER","amount":40000},{"componentType":"OVERHEAD","amount":60000}]' />
        </label>
      </div>
    </Modal>
  );
}

function WipModal({ busy, onClose, onSave }: { busy: boolean; onClose: () => void; onSave: (p: Rec) => void }) {
  const [txnType, setTxnType] = useState('MATERIAL_ISSUE');
  const [workOrderId, setWorkOrderId] = useState('');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const submit = () => onSave({
    txnType, workOrderId: workOrderId !== '' ? Number(workOrderId) : null,
    amount: Number(amount), notes: notes || null,
  });
  return (
    <Modal title="Record WIP movement" onClose={onClose} footer={<button className="btn btn-primary" disabled={busy || !amount} onClick={submit}>Record</button>}>
      <div className="form-grid">
        <label>Type
          <select className="search-input" value={txnType} onChange={(e) => setTxnType(e.target.value)}>
            {['MATERIAL_ISSUE', 'LABOUR', 'MACHINE', 'OVERHEAD', 'COMPLETE', 'SCRAP', 'ADJUSTMENT'].map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
          </select>
        </label>
        <label>Work order ID <input type="number" value={workOrderId} onChange={(e) => setWorkOrderId(e.target.value)} /></label>
        <label>Amount <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label style={{ gridColumn: '1 / -1' }}>Notes <input value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      </div>
    </Modal>
  );
}function Consolidation() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const load = useCallback(() => {
    api<{ data: Rec[] }>('/api/ops/finance/consolidation/runs').then((r) => setRows(r.data ?? [])).catch((e) => setError(e instanceof Error ? e.message : 'Consolidation failed'));
  }, []);
  useEffect(() => { load(); }, [load]);
  const run = async (payload: Rec) => {
    setBusy(true); setError('');
    try {
      const r = await api<{ data: Rec }>('/api/ops/finance/consolidation/runs', { method: 'POST', body: JSON.stringify(payload) });
      setRunOpen(false);
      navigate(`/finance/consolidation/${String(r.data.id)}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Group</p>
          <h1>Financial consolidation</h1>
          <p className="muted">Subsidiary ledgers → FX translation → intercompany elimination → group financial statements.</p>
        </div>
        <div className="head-actions">
          {can(user, 'finance.consolidation.run') && <button className="btn btn-primary" onClick={() => setRunOpen(true)}>Run consolidation</button>}
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Run</th><th>Period</th><th>Target currency</th><th>Status</th><th>Balanced</th><th>Companies</th><th>Run at</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => {
              const res = (r.results as Rec) ?? {};
              const totals = (res.totals as Rec) ?? {};
              const companies = (res.companies as Rec[]) ?? [];
              return (
                <tr key={String(r.id)}>
                  <td className="cell-mono">CR-{String(r.id)}</td>
                  <td>{String(r.periodStart).slice(0, 10)} → {String(r.periodEnd).slice(0, 10)}</td>
                  <td>{String(r.targetCurrency)}</td>
                  <td><Badge value={r.status} /></td>
                  <td>{totals.balanced ? '✓ balanced' : '✗ unbalanced'}</td>
                  <td>{companies.map((c) => String(c.code)).join(', ')}</td>
                  <td>{String(r.createdAt)}</td>
                  <td><button className="btn btn-sm" onClick={() => navigate(`/finance/consolidation/${String(r.id)}`)}>Open</button></td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No consolidation runs yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {runOpen && <ConsolidationRunModal busy={busy} onClose={() => setRunOpen(false)} onSave={run} />}
    </div>
  );
}

function ConsolidationRunModal({ busy, onClose, onSave }: { busy: boolean; onClose: () => void; onSave: (p: Rec) => void }) {
  const [periodStart, setPeriodStart] = useState(`${new Date().getFullYear()}-01-01`);
  const [periodEnd, setPeriodEnd] = useState(new Date().toISOString().slice(0, 10));
  const [targetCurrency, setTargetCurrency] = useState('UGX');
  const submit = () => onSave({ periodStart, periodEnd, targetCurrency });
  return (
    <Modal title="Run consolidation" onClose={onClose} footer={<button className="btn btn-primary" disabled={busy} onClick={submit}>Consolidate</button>}>
      <div className="form-grid">
        <label>Period start <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} /></label>
        <label>Period end <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></label>
        <label>Target currency <input value={targetCurrency} onChange={(e) => setTargetCurrency(e.target.value)} /></label>
      </div>
    </Modal>
  );
}

function ConsolidationDetail({ id }: { id: number }) {
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>(`/api/ops/finance/consolidation/runs/${id}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Consolidation run failed'));
  }, [id]);
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Loading consolidation..." />;
  const res = (data.results as Rec) ?? {};
  const companies = (res.companies as Rec[]) ?? [];
  const consolidated = (res.consolidated as Rec[]) ?? [];
  const eliminations = (res.eliminations as Rec[]) ?? [];
  const totals = (res.totals as Rec) ?? {};
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Group</p>
          <h1>Consolidation run {String(data.id)}</h1>
          <p className="muted">{String(data.periodStart).slice(0, 10)} → {String(data.periodEnd).slice(0, 10)} in {String(data.targetCurrency)}. {totals.balanced ? 'Group trial balance is balanced.' : 'Group trial balance is OUT OF BALANCE.'}</p>
        </div>
        <div className="head-actions"><button className="btn" onClick={() => navigate('/finance/consolidation')}>Back</button></div>
      </header>
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Companies</span><span className="kpi-value">{companies.length}</span><span className="kpi-sub">{companies.map((c) => `${String(c.code)} @ ${String(c.rate)}`).join(', ')}</span></div>
        <div className="kpi-card"><span className="kpi-label">Group debit</span><span className="kpi-value">{fmtMoney(totals.debit)}</span><span className="kpi-sub">credit {fmtMoney(totals.credit)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Eliminations</span><span className="kpi-value">{eliminations.length}</span><span className="kpi-sub">intercompany entries removed</span></div>
      </div>
      <h2 style={{ marginTop: 24, fontSize: 18 }}>Per-company trial balance</h2>
      <div className="table-wrap card" style={{ marginTop: 8 }}>
        <table className="data">
          <thead><tr><th>Company</th><th>Currency</th><th>Rate</th><th>Debit</th><th>Credit</th><th>Balanced</th></tr></thead>
          <tbody>
            {companies.map((c) => {
              const tt = (c.totals as Rec) ?? {};
              return (
                <tr key={String(c.companyId)}>
                  <td>{String(c.code)} - {String(c.name)}</td>
                  <td>{String(c.currency)}</td>
                  <td>{String(c.rate)}</td>
                  <td>{fmtMoney(tt.debit)}</td>
                  <td>{fmtMoney(tt.credit)}</td>
                  <td>{c.balanced ? '✓' : '✗'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <h2 style={{ marginTop: 24, fontSize: 18 }}>Consolidated balances</h2>
      <div className="table-wrap card" style={{ marginTop: 8 }}>
        <table className="data">
          <thead><tr><th>Account</th><th>Name</th><th>Type</th><th>Balance</th><th>Breakdown</th></tr></thead>
          <tbody>
            {consolidated.map((r) => (
              <tr key={String(r.code)}>
                <td className="cell-mono">{String(r.code)}</td>
                <td>{String(r.name)}</td>
                <td>{String(r.accountType)}</td>
                <td>{fmtMoney(r.amount)}</td>
                <td>{(r.companies as Rec[]).map((c) => `${String(c.code)} ${fmtMoney(c.balance)}`).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {eliminations.length > 0 && (
        <>
          <h2 style={{ marginTop: 24, fontSize: 18 }}>Elimination entries</h2>
          <div className="table-wrap card" style={{ marginTop: 8 }}>
            <table className="data">
              <thead><tr><th>Account</th><th>Debit</th><th>Credit</th><th>Description</th></tr></thead>
              <tbody>
                {eliminations.map((e, i) => (
                  <tr key={i}>
                    <td className="cell-mono">{String(e.accountCode)}</td>
                    <td>{fmtMoney(e.debit)}</td>
                    <td>{fmtMoney(e.credit)}</td>
                    <td>{String(e.description)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function PeriodClose() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [periods, setPeriods] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [periodId, setPeriodId] = useState('');
  const load = useCallback(() => {
    const q = periodId ? `?periodId=${encodeURIComponent(periodId)}` : '';
    api<{ data: Rec[] }>(`/api/ops/finance/close-tasks${q}`).then((r) => setRows(r.data ?? [])).catch((e) => setError(e instanceof Error ? e.message : 'Close tasks failed'));
  }, [periodId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/finance/periods').then((r) => setPeriods((r.data ?? []).filter((p) => ['OPEN', 'SOFT_CLOSE'].includes(String(p.status))))).catch(() => undefined);
  }, []);
  const act = async (id: number, action: string, payload: Rec = {}) => {
    setBusy(true); setError('');
    try {
      if (action === 'close-run') {
        await api(`/api/ops/finance/periods/${id}/close-run`, { method: 'POST', body: JSON.stringify(payload) });
        setError('Period closed. Next period seeded.');
      } else {
        await api(`/api/ops/finance/close-tasks/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      }
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const done = rows.filter((r) => ['COMPLETED', 'WAIVED'].includes(String(r.status))).length;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Month-end</p>
          <h1>Financial close command center</h1>
          <p className="muted">{done} of {rows.length} tasks complete for the selected period. All tasks must be COMPLETED or WAIVED before the period can close.</p>
        </div>
        <div className="head-actions">
          <select className="search-input" value={periodId} onChange={(e) => setPeriodId(e.target.value)} style={{ maxWidth: 220 }}>
            <option value="">All periods</option>
            {periods.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.code)} ({String(p.status)})</option>)}
          </select>
          {can(user, 'finance.periods.close') && periodId && <button className="btn btn-primary" disabled={busy} onClick={() => act(Number(periodId), 'close-run')}>Run period close</button>}
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Task</th><th>Period</th><th>Owner</th><th>Status</th><th>Depends on</th><th>Notes</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td>{String(r.taskName)}</td>
                <td>{String(r.periodCode)}</td>
                <td>{String(r.ownerRole ?? '-')}</td>
                <td><Badge value={r.status} /></td>
                <td>{String(r.dependencyName ?? '-')}</td>
                <td>{String(r.notes ?? '')}</td>
                <td>
                  <div className="row-actions">
                    {can(user, 'finance.close_tasks.update') && ['PENDING', 'BLOCKED'].includes(String(r.status)) && <button className="btn btn-sm" disabled={busy} onClick={() => act(Number(r.id), 'update', { status: 'IN_PROGRESS' })}>Start</button>}
                    {can(user, 'finance.close_tasks.update') && ['IN_PROGRESS'].includes(String(r.status)) && <button className="btn btn-sm" disabled={busy} onClick={() => act(Number(r.id), 'update', { status: 'COMPLETED' })}>Complete</button>}
                    {can(user, 'finance.close_tasks.update') && ['PENDING', 'IN_PROGRESS', 'BLOCKED'].includes(String(r.status)) && <button className="btn btn-sm" disabled={busy} onClick={() => act(Number(r.id), 'update', { status: 'WAIVED' })}>Waive</button>}
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>No close tasks for this period.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FinanceAudit() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [module, setModule] = useState('');
  const [docType, setDocType] = useState('');
  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (module) q.set('module', module);
    if (docType) q.set('docType', docType);
    q.set('limit', '200');
    api<{ data: Rec[] }>(`/api/ops/finance/audit?${q.toString()}`)
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Audit trail failed'));
  }, [module, docType]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Compliance</p>
          <h1>Financial audit trail</h1>
          <p className="muted">Immutable for ordinary users. Every create, change, approval, posting and reversal is recorded with actor and value deltas.</p>
        </div>
        <div className="head-actions">
          <input className="search-input" placeholder="Module" value={module} onChange={(e) => setModule(e.target.value)} style={{ maxWidth: 140 }} />
          <input className="search-input" placeholder="Doc type" value={docType} onChange={(e) => setDocType(e.target.value)} style={{ maxWidth: 160 }} />
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Module</th><th>Doc</th><th>Ref</th><th>Change</th><th>IP</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td>{String(r.createdAt)}</td>
                <td>{String(r.userName ?? r.userEmail ?? 'system')}</td>
                <td><Badge value={r.action} /></td>
                <td>{String(r.module)}</td>
                <td>{String(r.docType ?? '')}</td>
                <td className="cell-mono">{String(r.docCode ?? '')}</td>
                <td className="cell-mono" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.newValue ? JSON.stringify(r.newValue) : r.previousValue ? `prev: ${JSON.stringify(r.previousValue)}` : ''}</td>
                <td>{String(r.ip ?? '')}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No audit records.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}