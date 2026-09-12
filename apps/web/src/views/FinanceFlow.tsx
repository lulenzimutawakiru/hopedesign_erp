import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmtMoney, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { useCompanyProfile } from '../company';
import { navigate, useHashQuery } from '../router';
import { Badge, ErrorBanner, PageLoader, Modal, Pager } from '../components/ui';
import { ConfirmDialog, EmptyState, Skeleton } from '../components/os';
import DownloadMenu from '../components/DownloadMenu';

type Rec = Record<string, unknown>;

// A module tile may be reachable through any one of several equivalent permission
// codes (for example the legacy finance.efris.* codes and the granular efris.*
// governance codes introduced with the EFRIS production module).
type FinanceTile = { href: string; label: string; hint: string; perm: string; perms?: string[] };

function canAny(user: Parameters<typeof can>[0], permissions: string[]): boolean {
  return permissions.some((permission) => can(user, permission));
}

const JOURNAL_STATUSES = ['DRAFT', 'POSTED', 'VOID'];
const EXPENSE_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'VOID'];
const ADVANCE_STATUSES = ['POSTED', 'SETTLED', 'VOID'];
const BUDGET_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'ACTIVE', 'CLOSED'];
const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE', 'CONTRA_ASSET', 'CONTRA_LIABILITY', 'CONTRA_EQUITY', 'CONTRA_REVENUE', 'CONTRA_EXPENSE'];
const BANK_TYPES = ['CURRENT', 'SAVINGS', 'MOBILE_MONEY', 'CASH'];
const TAX_TYPES = ['VAT', 'WHT', 'EXCISE', 'WITHHOLDING_VAT'];
const PERIOD_STATUSES = ['OPEN', 'LOCKED', 'CLOSED'];

// Shared list-screen furniture: remembered page size and the server-side sort
// whitelists mirrored from listJournals / listExpenses in the API service.
const FIN_PAGE_SIZES = [25, 50, 100];
const FIN_PAGE_SIZE_KEY = 'hope.finance.pageSize';
const loadFinPageSize = (): number => {
  try { const n = Number(localStorage.getItem(FIN_PAGE_SIZE_KEY)); return FIN_PAGE_SIZES.includes(n) ? n : FIN_PAGE_SIZES[0]; }
  catch { return FIN_PAGE_SIZES[0]; }
};
const saveFinPageSize = (n: number): void => {
  try { localStorage.setItem(FIN_PAGE_SIZE_KEY, String(n)); } catch { /* storage unavailable */ }
};
const JOURNAL_SORT_COLUMNS = ['entry_no', 'entry_date', 'journal_type', 'reference_code', 'total_debit', 'total_credit', 'status'];
const JOURNAL_SORT_LABELS: Record<string, string> = {
  entry_no: 'Entry', entry_date: 'Date', journal_type: 'Type',
  reference_code: 'Source', total_debit: 'Debit', total_credit: 'Credit', status: 'Status',
};
const EXPENSE_SORT_COLUMNS = ['expense_no', 'expense_date', 'account_code', 'vendor', 'reference', 'amount', 'method', 'status'];
const EXPENSE_SORT_LABELS: Record<string, string> = {
  expense_no: 'Expense', expense_date: 'Date', account_code: 'Account', vendor: 'Vendor',
  reference: 'Reference', amount: 'Amount', method: 'Method', status: 'Status',
};
const BUDGET_SORT_COLUMNS = ['budget_no', 'period', 'lines', 'amount', 'status'];
const BUDGET_SORT_LABELS: Record<string, string> = {
  budget_no: 'Budget', period: 'Period', lines: 'Lines', amount: 'Amount', status: 'Status',
};
const ADVANCE_SORT_COLUMNS = ['advance_no', 'advance_date', 'holder', 'bank', 'amount', 'outstanding', 'purpose', 'status'];
const ADVANCE_SORT_LABELS: Record<string, string> = {
  advance_no: 'Advance', advance_date: 'Date', holder: 'Holder', bank: 'Source',
  amount: 'Amount', outstanding: 'Outstanding', purpose: 'Purpose', status: 'Status',
};

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

function StatusSelect({ value, onChange, options, label = 'Filter by status', placeholder = 'All statuses' }: { value: string; onChange: (v: string) => void; options: string[]; label?: string; placeholder?: string }) {
  return (
    <select className="search-input" style={{ maxWidth: 180 }} value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {options.map((s) => (
        <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
      ))}
    </select>
  );
}

function Overview() {
  const company = useCompanyProfile();
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
          <h1>Books of {company.name}</h1>
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
  const q = useHashQuery();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(loadFinPageSize);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState(q.get('q') ?? '');
  const [status, setStatus] = useState(q.get('status') ?? '');
  const committedSearch = q.get('q') ?? '';
  const committedStatus = q.get('status') ?? '';
  const sortBy = JOURNAL_SORT_COLUMNS.includes(q.get('sortBy') ?? '') ? (q.get('sortBy') as string) : '';
  const sortDir: 'asc' | 'desc' = q.get('sortDir') === 'asc' ? 'asc' : 'desc';
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (committedSearch) p.set('q', committedSearch);
    if (committedStatus) p.set('status', committedStatus);
    if (sortBy) { p.set('sortBy', sortBy); p.set('sortDir', sortDir); }
    return p;
  }, [committedSearch, committedStatus, sortBy, sortDir]);
  // Single funnel for filter and sort changes: each one returns to page 1 and
  // never drops a search draft typed since the last committed search.
  const writeQuery = (extra: Record<string, string>) => {
    const next: Record<string, string> = { ...Object.fromEntries(qs), ...extra };
    if (!('q' in extra) && committedSearch !== search) {
      if (search) next.q = search; else delete next.q;
    }
    for (const [k, v] of Object.entries(next)) if (!v) delete next[k];
    if (!next.sortBy) delete next.sortDir;
    setPage(1);
    navigate('/finance/journals', { query: next });
  };
  const setSort = (col: string) => {
    if (sortBy !== col) return writeQuery({ sortBy: col, sortDir: 'asc' });
    if (sortDir === 'asc') return writeQuery({ sortBy: col, sortDir: 'desc' });
    return writeQuery({ sortBy: '' });
  };
  useEffect(() => {
    let alive = true;
    setRefreshing(true);
    setError('');
    const p = new URLSearchParams(qs);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/finance/journals?${p}`)
      .then((r) => { if (!alive) return; setRows(r.data.rows ?? []); setTotal(r.data.total ?? 0); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Journals failed'); })
      .finally(() => { if (alive) { setRefreshing(false); setLoading(false); } });
    return () => { alive = false; };
  }, [qs, page, pageSize]);
  // Keep the filter drafts in step with back/forward navigation.
  useEffect(() => { setSearch(committedSearch); setStatus(committedStatus); }, [committedSearch, committedStatus]);
  // Filter as the user types instead of only on Enter.
  useEffect(() => {
    if (committedSearch === search) return;
    const t = setTimeout(() => writeQuery({ q: search }), 300);
    return () => clearTimeout(t);
  }, [search, committedSearch, qs]);
  // Never strand the user on a page that no longer exists once filters narrow.
  useEffect(() => {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (page > pages) setPage(pages);
  }, [total, pageSize, page]);
  const clearAll = () => navigate('/finance/journals', { query: {} });
  const hasFilters = Boolean(committedSearch || committedStatus);
  const activeFilters: Array<{ key: string; label: string; value: string }> = [];
  if (committedSearch) activeFilters.push({ key: 'q', label: 'Search', value: committedSearch });
  if (committedStatus) activeFilters.push({ key: 'status', label: 'Status', value: committedStatus.replace(/_/g, ' ') });
  const removeFilter = (key: string) => {
    const next: Record<string, string> = { ...Object.fromEntries(qs) };
    delete next[key];
    setPage(1);
    navigate('/finance/journals', { query: next });
  };
  const changePageSize = (n: number) => { setPageSize(n); setPage(1); saveFinPageSize(n); };
  const sortMark = (col: string) => (sortBy === col ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : '');
  const ariaSort = (col: string): 'ascending' | 'descending' | undefined =>
    sortBy === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined;
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
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <input className="search-input" type="search" value={search} aria-label="Search journals"
            placeholder="Search entry no, description, source..."
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && committedSearch !== search) writeQuery({ q: search }); }} />
          <StatusSelect value={status} onChange={(v) => { setStatus(v); writeQuery({ status: v }); }} options={JOURNAL_STATUSES} />
          {hasFilters && <button className="btn btn-sm btn-ghost" onClick={clearAll}>Clear filters</button>}
        </div>
        {(activeFilters.length > 0 || sortBy) && (
          <div className="filter-chips" style={{ padding: '12px 0 0' }}>
            {activeFilters.map((f) => (
              <span key={f.key} className="filter-chip">
                <b>{f.label}</b>{f.value ? `: ${f.value}` : ''}
                <button type="button" title="Remove filter" aria-label={`Remove ${f.label} filter`} onClick={() => removeFilter(f.key)}>{'\u00D7'}</button>
              </span>
            ))}
            {sortBy && (
              <span className="filter-chip">
                <b>Sort</b>{`: ${JOURNAL_SORT_LABELS[sortBy] ?? sortBy} ${sortDir === 'asc' ? 'ascending' : 'descending'}`}
                <button type="button" title="Clear sort" aria-label="Clear sort" onClick={() => writeQuery({ sortBy: '' })}>{'\u00D7'}</button>
              </span>
            )}
            <button className="btn btn-sm btn-ghost" onClick={clearAll}>Clear all</button>
          </div>
        )}
      </div>
      {error && <ErrorBanner error={error} />}
      <section className={`card card-pad${refreshing && !loading ? ' is-refreshing' : ''}`} aria-busy={refreshing && !loading}>
        <div className="card-head">
          <h3>Journals ({total.toLocaleString()})</h3>
          {!loading && total > 0 && (
            <span className="muted" style={{ fontSize: 12 }} role="status" aria-live="polite">
              Showing {((page - 1) * pageSize + 1).toLocaleString()}-{Math.min(page * pageSize, total).toLocaleString()} of {total.toLocaleString()}
              {sortBy ? ` \u00B7 sorted by ${JOURNAL_SORT_LABELS[sortBy] ?? sortBy} (${sortDir === 'asc' ? 'ascending' : 'descending'})` : ''}
            </span>
          )}
        </div>
        {loading ? <Skeleton rows={6} /> : rows.length === 0 ? (
          hasFilters ? (
            <EmptyState title="No journal entries match these filters"
              body={committedSearch ? `Nothing matches "${committedSearch}" with the other filters applied. Clear them to see the full ledger.` : 'Nothing matches the current filters. Clear them to see the full ledger.'}
              action="Clear filters" onAction={clearAll} />
          ) : (
            <EmptyState title="No journal entries yet" body="Postings from sales, receipts, GRN, production and expenses appear here automatically. You can also write a manual journal."
              action={can(user, 'finance.journals.create') ? 'New journal' : undefined} onAction={() => navigate('/finance/journals/new')} />
          )
        ) : (
          <>
            <div className="record-cards mobile-only">
              {rows.map((r) => (
                <div key={`card-${String(r.id)}`} className="record-card" onClick={() => navigate(`/finance/journals/${r.id}`)}>
                  <div className="record-card-top">
                    <strong className="cell-mono">{String(r.entryNo)}</strong>
                    <Badge value={r.status} />
                  </div>
                  <div className="record-card-meta">
                    <span>{String(r.entryDate).slice(0, 10)}</span>
                    <span>{String(r.journalType).replace(/_/g, ' ')}</span>
                    <span>{fmtMoney(r.totalDebit)}</span>
                  </div>
                  <div>{String(r.description)}</div>
                </div>
              ))}
            </div>
            <div className="table-wrap desktop-only">
              <table className="data">
                <thead>
                  <tr>
                    <th aria-sort={ariaSort('entry_no')}><button className="th-btn" title="Sort by entry number" onClick={() => setSort('entry_no')}>Entry{sortMark('entry_no')}</button></th>
                    <th aria-sort={ariaSort('entry_date')}><button className="th-btn" title="Sort by date" onClick={() => setSort('entry_date')}>Date{sortMark('entry_date')}</button></th>
                    <th aria-sort={ariaSort('journal_type')}><button className="th-btn" title="Sort by type" onClick={() => setSort('journal_type')}>Type{sortMark('journal_type')}</button></th>
                    <th>Description</th>
                    <th aria-sort={ariaSort('reference_code')}><button className="th-btn" title="Sort by source document" onClick={() => setSort('reference_code')}>Source{sortMark('reference_code')}</button></th>
                    <th className="cell-num" aria-sort={ariaSort('total_debit')}><button className="th-btn" title="Sort by debit total" onClick={() => setSort('total_debit')}>Debit{sortMark('total_debit')}</button></th>
                    <th className="cell-num" aria-sort={ariaSort('total_credit')}><button className="th-btn" title="Sort by credit total" onClick={() => setSort('total_credit')}>Credit{sortMark('total_credit')}</button></th>
                    <th aria-sort={ariaSort('status')}><button className="th-btn" title="Sort by status" onClick={() => setSort('status')}>Status{sortMark('status')}</button></th>
                  </tr>
                </thead>
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
                </tbody>
              </table>
            </div>
          </>
        )}
        {!loading && <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={changePageSize} pageSizes={FIN_PAGE_SIZES} />}
      </section>
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
  const q = useHashQuery();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(loadFinPageSize);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState(q.get('q') ?? '');
  const [status, setStatus] = useState(q.get('status') ?? '');
  const committedSearch = q.get('q') ?? '';
  const committedStatus = q.get('status') ?? '';
  const sortBy = EXPENSE_SORT_COLUMNS.includes(q.get('sortBy') ?? '') ? (q.get('sortBy') as string) : '';
  const sortDir: 'asc' | 'desc' = q.get('sortDir') === 'asc' ? 'asc' : 'desc';
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (committedSearch) p.set('q', committedSearch);
    if (committedStatus) p.set('status', committedStatus);
    if (sortBy) { p.set('sortBy', sortBy); p.set('sortDir', sortDir); }
    return p;
  }, [committedSearch, committedStatus, sortBy, sortDir]);
  const writeQuery = (extra: Record<string, string>) => {
    const next: Record<string, string> = { ...Object.fromEntries(qs), ...extra };
    if (!('q' in extra) && committedSearch !== search) {
      if (search) next.q = search; else delete next.q;
    }
    for (const [k, v] of Object.entries(next)) if (!v) delete next[k];
    if (!next.sortBy) delete next.sortDir;
    setPage(1);
    navigate('/finance/expenses', { query: next });
  };
  const setSort = (col: string) => {
    if (sortBy !== col) return writeQuery({ sortBy: col, sortDir: 'asc' });
    if (sortDir === 'asc') return writeQuery({ sortBy: col, sortDir: 'desc' });
    return writeQuery({ sortBy: '' });
  };
  useEffect(() => {
    let alive = true;
    setRefreshing(true);
    setError('');
    const p = new URLSearchParams(qs);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/finance/expenses?${p}`)
      .then((r) => { if (!alive) return; setRows(r.data.rows ?? []); setTotal(r.data.total ?? 0); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Expenses failed'); })
      .finally(() => { if (alive) { setRefreshing(false); setLoading(false); } });
    return () => { alive = false; };
  }, [qs, page, pageSize]);
  useEffect(() => { setSearch(committedSearch); setStatus(committedStatus); }, [committedSearch, committedStatus]);
  useEffect(() => {
    if (committedSearch === search) return;
    const t = setTimeout(() => writeQuery({ q: search }), 300);
    return () => clearTimeout(t);
  }, [search, committedSearch, qs]);
  useEffect(() => {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (page > pages) setPage(pages);
  }, [total, pageSize, page]);
  const clearAll = () => navigate('/finance/expenses', { query: {} });
  const hasFilters = Boolean(committedSearch || committedStatus);
  const activeFilters: Array<{ key: string; label: string; value: string }> = [];
  if (committedSearch) activeFilters.push({ key: 'q', label: 'Search', value: committedSearch });
  if (committedStatus) activeFilters.push({ key: 'status', label: 'Status', value: committedStatus.replace(/_/g, ' ') });
  const removeFilter = (key: string) => {
    const next: Record<string, string> = { ...Object.fromEntries(qs) };
    delete next[key];
    setPage(1);
    navigate('/finance/expenses', { query: next });
  };
  const changePageSize = (n: number) => { setPageSize(n); setPage(1); saveFinPageSize(n); };
  const sortMark = (col: string) => (sortBy === col ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : '');
  const ariaSort = (col: string): 'ascending' | 'descending' | undefined =>
    sortBy === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined;
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
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <input className="search-input" type="search" value={search} aria-label="Search expenses"
            placeholder="Search expense no, vendor, reference..."
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && committedSearch !== search) writeQuery({ q: search }); }} />
          <StatusSelect value={status} onChange={(v) => { setStatus(v); writeQuery({ status: v }); }} options={EXPENSE_STATUSES} />
          {hasFilters && <button className="btn btn-sm btn-ghost" onClick={clearAll}>Clear filters</button>}
        </div>
        {(activeFilters.length > 0 || sortBy) && (
          <div className="filter-chips" style={{ padding: '12px 0 0' }}>
            {activeFilters.map((f) => (
              <span key={f.key} className="filter-chip">
                <b>{f.label}</b>{f.value ? `: ${f.value}` : ''}
                <button type="button" title="Remove filter" aria-label={`Remove ${f.label} filter`} onClick={() => removeFilter(f.key)}>{'\u00D7'}</button>
              </span>
            ))}
            {sortBy && (
              <span className="filter-chip">
                <b>Sort</b>{`: ${EXPENSE_SORT_LABELS[sortBy] ?? sortBy} ${sortDir === 'asc' ? 'ascending' : 'descending'}`}
                <button type="button" title="Clear sort" aria-label="Clear sort" onClick={() => writeQuery({ sortBy: '' })}>{'\u00D7'}</button>
              </span>
            )}
            <button className="btn btn-sm btn-ghost" onClick={clearAll}>Clear all</button>
          </div>
        )}
      </div>
      {error && <ErrorBanner error={error} />}
      <section className={`card card-pad${refreshing && !loading ? ' is-refreshing' : ''}`} aria-busy={refreshing && !loading}>
        <div className="card-head">
          <h3>Expenses ({total.toLocaleString()})</h3>
          {!loading && total > 0 && (
            <span className="muted" style={{ fontSize: 12 }} role="status" aria-live="polite">
              Showing {((page - 1) * pageSize + 1).toLocaleString()}-{Math.min(page * pageSize, total).toLocaleString()} of {total.toLocaleString()}
              {sortBy ? ` \u00B7 sorted by ${EXPENSE_SORT_LABELS[sortBy] ?? sortBy} (${sortDir === 'asc' ? 'ascending' : 'descending'})` : ''}
            </span>
          )}
        </div>
        {loading ? <Skeleton rows={6} /> : rows.length === 0 ? (
          hasFilters ? (
            <EmptyState title="No expenses match these filters"
              body={committedSearch ? `Nothing matches "${committedSearch}" with the other filters applied. Clear them to see every expense.` : 'Nothing matches the current filters. Clear them to see every expense.'}
              action="Clear filters" onAction={clearAll} />
          ) : (
            <EmptyState title="No expenses yet" body="Record petty cash and bank payments here; each one posts straight to the ledger."
              action={can(user, 'finance.expenses.create') ? 'Post expense' : undefined} onAction={() => navigate('/finance/expenses/new')} />
          )
        ) : (
          <>
            <div className="record-cards mobile-only">
              {rows.map((r) => (
                <div key={`card-${String(r.id)}`} className="record-card" onClick={() => navigate(`/finance/expenses/${r.id}`)}>
                  <div className="record-card-top">
                    <strong className="cell-mono">{String(r.expenseNo)}</strong>
                    <Badge value={r.status} />
                  </div>
                  <div className="record-card-meta">
                    <span>{String(r.expenseDate).slice(0, 10)}</span>
                    <span>{String(r.vendor ?? '') || 'No vendor'}</span>
                    <span>{fmtMoney(r.amount)}</span>
                  </div>
                  <div className="cell-mono">{String(r.accountCode)} {String(r.accountName)}</div>
                </div>
              ))}
            </div>
            <div className="table-wrap desktop-only">
              <table className="data">
                <thead>
                  <tr>
                    <th aria-sort={ariaSort('expense_no')}><button className="th-btn" title="Sort by expense number" onClick={() => setSort('expense_no')}>Expense{sortMark('expense_no')}</button></th>
                    <th aria-sort={ariaSort('expense_date')}><button className="th-btn" title="Sort by date" onClick={() => setSort('expense_date')}>Date{sortMark('expense_date')}</button></th>
                    <th aria-sort={ariaSort('account_code')}><button className="th-btn" title="Sort by account" onClick={() => setSort('account_code')}>Account{sortMark('account_code')}</button></th>
                    <th aria-sort={ariaSort('vendor')}><button className="th-btn" title="Sort by vendor" onClick={() => setSort('vendor')}>Vendor{sortMark('vendor')}</button></th>
                    <th aria-sort={ariaSort('reference')}><button className="th-btn" title="Sort by reference" onClick={() => setSort('reference')}>Reference{sortMark('reference')}</button></th>
                    <th className="cell-num" aria-sort={ariaSort('amount')}><button className="th-btn" title="Sort by amount" onClick={() => setSort('amount')}>Amount{sortMark('amount')}</button></th>
                    <th aria-sort={ariaSort('method')}><button className="th-btn" title="Sort by payment method" onClick={() => setSort('method')}>Method{sortMark('method')}</button></th>
                    <th aria-sort={ariaSort('status')}><button className="th-btn" title="Sort by status" onClick={() => setSort('status')}>Status{sortMark('status')}</button></th>
                  </tr>
                </thead>
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
                </tbody>
              </table>
            </div>
          </>
        )}
        {!loading && <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={changePageSize} pageSizes={FIN_PAGE_SIZES} />}
      </section>
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
  const q = useHashQuery();
  const [data, setData] = useState<{ rows: Rec[]; total: number; overdue: number; buckets?: Rec } | null>(null);
  const [error, setError] = useState('');
  const [bucket, setBucket] = useState(q.get('bucket') ?? '');
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [collect, setCollect] = useState<Rec | null>(null);
  const [busy, setBusy] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('BANK_TRANSFER');
  const [payRef, setPayRef] = useState('');
  const isAr = kind === 'ar';
  const path = isAr ? '/finance/ar' : '/finance/ap';
  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (bucket) p.set('bucket', bucket);
    setRefreshing(true);
    setError('');
    api<{ data: { rows: Rec[]; total: number; overdue: number; buckets?: Rec } }>(`/api/ops/finance/${kind}${p.toString() ? `?${p}` : ''}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Ledger failed'))
      .finally(() => setRefreshing(false));
  }, [kind, bucket]);
  useEffect(() => { load(); }, [load]);
  // Keep the aging bucket in step with back/forward navigation.
  useEffect(() => { setBucket(q.get('bucket') ?? ''); }, [q]);
  const chooseBucket = (key: string) => {
    const next = bucket === key ? '' : key;
    setBucket(next);
    navigate(path, { query: next ? { bucket: next } : {} });
  };
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
  if (error && !data) return <ErrorBanner error={error} />;
  if (!data) return <PageLoader label="Opening subledger..." />;
  const buckets = (data.buckets ?? {}) as Rec;
  const SORTS: Record<string, (r: Rec) => string | number> = {
    document: (r) => String((isAr ? r.invoiceNo : r.supplierInvoiceNo) ?? ''),
    party: (r) => String((isAr ? r.customerName : r.supplierName) ?? ''),
    invoiceDate: (r) => String(r.invoiceDate ?? ''),
    dueDate: (r) => String(r.dueDate ?? ''),
    daysOverdue: (r) => Number(r.daysOverdue ?? 0),
    total: (r) => Number(r.total ?? 0),
    amountPaid: (r) => Number(r.amountPaid ?? 0),
    balance: (r) => Number(r.balance ?? 0),
    bucket: (r) => String(r.bucket ?? ''),
  };
  const SORT_LABELS: Record<string, string> = {
    document: 'Document', party: isAr ? 'Customer' : 'Supplier', invoiceDate: 'Date', dueDate: 'Due',
    daysOverdue: 'Days', total: 'Total', amountPaid: 'Paid', balance: 'Balance', bucket: 'Bucket',
  };
  const term = search.trim().toLowerCase();
  const searched = term
    ? data.rows.filter((r) => (isAr
        ? `${String(r.invoiceNo ?? '')} ${String(r.customerName ?? '')}`
        : `${String(r.supplierInvoiceNo ?? '')} ${String(r.supplierName ?? '')}`
      ).toLowerCase().includes(term))
    : data.rows;
  const rows = sortBy
    ? [...searched].sort((a, b) => {
        const av = SORTS[sortBy](a); const bv = SORTS[sortBy](b);
        const cmp = typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv));
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : searched;
  const setSort = (col: string) => {
    if (sortBy !== col) { setSortBy(col); setSortDir('asc'); return; }
    if (sortDir === 'asc') { setSortDir('desc'); return; }
    setSortBy('');
  };
  const sortMark = (col: string) => (sortBy === col ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : '');
  const ariaSort = (col: string): 'ascending' | 'descending' | undefined =>
    sortBy === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined;
  const visibleBalance = rows.reduce((sum, r) => sum + Number(r.balance ?? 0), 0);
  const hasFilters = Boolean(search.trim() || bucket);
  const clearFilters = () => { setSearch(''); setSortBy(''); setBucket(''); navigate(path, { query: {} }); };
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
            onClick={() => chooseBucket(key)}
            aria-pressed={bucket === key}
            title={bucket === key ? `Stop filtering to ${label}` : `Show only ${label} balances`}
            style={{ textAlign: 'left', cursor: 'pointer', border: '1px solid var(--line)' }}
          >
            <span className="muted">{label}</span>
            <strong>{fmtMoney(buckets[key] ?? 0)}</strong>
          </button>
        ))}
      </div>
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="toolbar" style={{ marginBottom: hasFilters || sortBy ? 10 : 0 }}>
          <input className="search-input" type="search" value={search} aria-label={isAr ? 'Search receivables' : 'Search payables'}
            placeholder={isAr ? 'Search invoice no or customer...' : 'Search invoice no or supplier...'}
            onChange={(e) => setSearch(e.target.value)} />
          {bucket && (
            <span className="filter-chip">
              <b>Bucket</b>{`: ${AGING_LABELS.find(([k]) => k === bucket)?.[1] ?? bucket}`}
              <button type="button" title="Remove filter" aria-label="Remove bucket filter" onClick={() => chooseBucket(bucket)}>{'\u00D7'}</button>
            </span>
          )}
          {hasFilters && <button className="btn btn-sm btn-ghost" onClick={clearFilters}>Clear filters</button>}
        </div>
        {(hasFilters || sortBy) && (
          <div className="filter-chips" style={{ padding: '12px 0 0' }}>
            {search.trim() && (
              <span className="filter-chip">
                <b>Search</b>{`: ${search.trim()}`}
                <button type="button" title="Clear search" aria-label="Clear search" onClick={() => setSearch('')}>{'\u00D7'}</button>
              </span>
            )}
            {sortBy && (
              <span className="filter-chip">
                <b>Sort</b>{`: ${SORT_LABELS[sortBy] ?? sortBy} ${sortDir === 'asc' ? 'ascending' : 'descending'}`}
                <button type="button" title="Clear sort" aria-label="Clear sort" onClick={() => setSortBy('')}>{'\u00D7'}</button>
              </span>
            )}
            <button className="btn btn-sm btn-ghost" onClick={clearFilters}>Clear all</button>
          </div>
        )}
      </div>
      <section className={`card card-pad${refreshing ? ' is-refreshing' : ''}`} aria-busy={refreshing}>
        <div className="card-head">
          <h3>Open balances ({rows.length.toLocaleString()})</h3>
          <span className="muted" style={{ fontSize: 12 }} role="status" aria-live="polite">
            {rows.length === data.rows.length
              ? `${fmtMoney(visibleBalance)} outstanding`
              : `${rows.length.toLocaleString()} of ${data.rows.length.toLocaleString()} shown \u00B7 ${fmtMoney(visibleBalance)} outstanding`}
          </span>
        </div>
        {rows.length === 0 ? (
          hasFilters ? (
            <EmptyState title="Nothing matches these filters"
              body={search.trim() ? `No open balance matches "${search.trim()}"${bucket ? ' in this aging bucket' : ''}.` : 'No open balances in this aging bucket.'}
              action="Clear filters" onAction={clearFilters} />
          ) : (
            <EmptyState title="No open balances" body={isAr ? 'Every posted customer invoice is fully settled. New open invoices appear here as soon as they are posted.' : 'Every posted supplier invoice is fully paid. New open invoices appear here as soon as they are posted.'} />
          )
        ) : (
          <>
            <div className="record-cards mobile-only">
              {rows.map((r) => (
                <div key={`card-${String(r.id)}`} className="record-card" onClick={() => openInvoice(r)}>
                  <div className="record-card-top">
                    <strong className="cell-mono">{String(isAr ? r.invoiceNo : r.supplierInvoiceNo)}</strong>
                    <Badge value={String(r.bucket).replace('AGING_', '').replace('_PLUS', '+')} />
                  </div>
                  <div className="record-card-meta">
                    <span>{String(isAr ? r.customerName : r.supplierName)}</span>
                    <span>{String(r.invoiceDate).slice(0, 10)}</span>
                    <span>{fmtNum(r.daysOverdue)}d</span>
                    <span>{fmtMoney(r.balance)}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="table-wrap desktop-only">
              <table className="data">
                <thead>
                  <tr>
                    <th aria-sort={ariaSort('document')}><button className="th-btn" title="Sort by document" onClick={() => setSort('document')}>Document{sortMark('document')}</button></th>
                    <th aria-sort={ariaSort('party')}><button className="th-btn" title={`Sort by ${isAr ? 'customer' : 'supplier'}`} onClick={() => setSort('party')}>{isAr ? 'Customer' : 'Supplier'}{sortMark('party')}</button></th>
                    <th aria-sort={ariaSort('invoiceDate')}><button className="th-btn" title="Sort by invoice date" onClick={() => setSort('invoiceDate')}>Date{sortMark('invoiceDate')}</button></th>
                    <th aria-sort={ariaSort('dueDate')}><button className="th-btn" title="Sort by due date" onClick={() => setSort('dueDate')}>Due{sortMark('dueDate')}</button></th>
                    <th className="cell-num" aria-sort={ariaSort('daysOverdue')}><button className="th-btn" title="Sort by days overdue" onClick={() => setSort('daysOverdue')}>Days{sortMark('daysOverdue')}</button></th>
                    <th className="cell-num" aria-sort={ariaSort('total')}><button className="th-btn" title="Sort by invoice total" onClick={() => setSort('total')}>Total{sortMark('total')}</button></th>
                    <th className="cell-num" aria-sort={ariaSort('amountPaid')}><button className="th-btn" title="Sort by amount paid" onClick={() => setSort('amountPaid')}>Paid{sortMark('amountPaid')}</button></th>
                    <th className="cell-num" aria-sort={ariaSort('balance')}><button className="th-btn" title="Sort by balance" onClick={() => setSort('balance')}>Balance{sortMark('balance')}</button></th>
                    <th aria-sort={ariaSort('bucket')}><button className="th-btn" title="Sort by aging bucket" onClick={() => setSort('bucket')}>Bucket{sortMark('bucket')}</button></th>
                    {isAr && <th />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
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
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modal, setModal] = useState<Rec | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [confirm, setConfirm] = useState<Rec | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const load = useCallback(() => {
    setRefreshing(true);
    api<{ data: { rows: Rec[]; cash: number } }>('/api/ops/finance/banks')
      .then((r) => setData(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Banks failed'))
      .finally(() => { setRefreshing(false); setLoading(false); });
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
  const rows = data?.rows ?? [];
  const SORTS: Record<string, (r: Rec) => string | number> = {
    code: (r) => String(r.code ?? ''),
    name: (r) => String(r.name ?? ''),
    type: (r) => String(r.accountType ?? ''),
    bank: (r) => String(r.bankName ?? ''),
    account: (r) => String(r.accountNo ?? ''),
    gl: (r) => String(r.glCode ?? ''),
    balance: (r) => Number(r.bookBalance || 0),
    unmatched: (r) => Number(r.unreconciledCount || 0),
  };
  const SORT_LABELS: Record<string, string> = {
    code: 'Code', name: 'Name', type: 'Type', bank: 'Bank',
    account: 'Account', gl: 'GL', balance: 'Book balance', unmatched: 'Unmatched',
  };
  const term = search.trim().toLowerCase();
  const filtered = rows.filter((r) => {
    if (typeFilter && String(r.accountType) !== typeFilter) return false;
    if (!term) return true;
    return `${String(r.code ?? '')} ${String(r.name ?? '')} ${String(r.bankName ?? '')} ${String(r.accountNo ?? '')} ${String(r.glCode ?? '')}`.toLowerCase().includes(term);
  });
  const visible = sortBy && SORTS[sortBy]
    ? [...filtered].sort((a, b) => {
        const av = SORTS[sortBy](a); const bv = SORTS[sortBy](b);
        const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : filtered;
  const setSort = (col: string) => {
    if (sortBy !== col) { setSortBy(col); setSortDir('asc'); return; }
    if (sortDir === 'asc') { setSortDir('desc'); return; }
    setSortBy('');
  };
  const sortMark = (col: string) => (sortBy === col ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : '');
  const ariaSort = (col: string): 'ascending' | 'descending' | undefined =>
    sortBy === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined;
  const hasFilters = Boolean(term || typeFilter);
  const clearFilters = () => { setSearch(''); setTypeFilter(''); setSortBy(''); };
  const activeFilters: Array<{ key: string; label: string; value: string }> = [];
  if (search.trim()) activeFilters.push({ key: 'q', label: 'Search', value: search.trim() });
  if (typeFilter) activeFilters.push({ key: 'type', label: 'Type', value: typeFilter.replace(/_/g, ' ') });
  const removeFilter = (key: string) => {
    if (key === 'q') setSearch('');
    if (key === 'type') setTypeFilter('');
  };
  const totalBook = filtered.reduce((sum, r) => sum + Number(r.bookBalance || 0), 0);
  const cashOnly = filtered.filter((r) => ['CASH', 'MOBILE_MONEY'].includes(String(r.accountType)))
    .reduce((sum, r) => sum + Number(r.bookBalance || 0), 0);
  const unmatched = filtered.reduce((sum, r) => sum + Number(r.unreconciledCount || 0), 0);
  const openNew = () => { setModal(null); setModalOpen(true); };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Treasury</p>
          <h1>Bank and cash</h1>
          <p className="muted">Book balance = opening balance plus posted GL movements on the linked account.</p>
        </div>
        <div className="head-actions">
          {can(user, 'finance.banks.update') && <button className="btn" onClick={() => navigate('/finance/transfers')}>Transfer</button>}
          {can(user, 'finance.banks.create') && <button className="btn btn-primary" onClick={openNew}>New bank</button>}
        </div>
      </header>
      <div className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-label">Accounts</span>
          <span className="kpi-value">{data ? fmtNum(filtered.length) : '\u2014'}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Total book balance</span>
          <span className="kpi-value">{data ? fmtMoney(totalBook) : '\u2014'}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Cash and mobile money</span>
          <span className="kpi-value">{data ? fmtMoney(cashOnly) : '\u2014'}</span>
        </div>
        <div className={`kpi-card${data && unmatched > 0 ? ' card-warn' : ''}`}>
          <span className="kpi-label">Unmatched statement lines</span>
          <span className="kpi-value">{data ? fmtNum(unmatched) : '\u2014'}</span>
        </div>
      </div>
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="toolbar" style={{ marginBottom: hasFilters ? 10 : 0 }}>
          <input className="search-input" type="search" value={search} aria-label="Search bank accounts"
            placeholder="Search code, name, bank, account no..."
            onChange={(e) => setSearch(e.target.value)} />
          <StatusSelect value={typeFilter} onChange={setTypeFilter} options={BANK_TYPES}
            label="Filter by account type" placeholder="All types" />
          {hasFilters && <button className="btn btn-sm btn-ghost" onClick={clearFilters}>Clear filters</button>}
        </div>
        {activeFilters.length > 0 && (
          <div className="filter-chips" style={{ padding: '12px 0 0' }}>
            {activeFilters.map((f) => (
              <span key={f.key} className="filter-chip">
                <b>{f.label}</b>{f.value ? `: ${f.value}` : ''}
                <button type="button" title="Remove filter" aria-label={`Remove ${f.label} filter`} onClick={() => removeFilter(f.key)}>{'\u00D7'}</button>
              </span>
            ))}
            <button className="btn btn-sm btn-ghost" onClick={clearFilters}>Clear all</button>
          </div>
        )}
      </div>
      {error && <ErrorBanner error={error} />}
      <section className={`card card-pad${refreshing && !loading ? ' is-refreshing' : ''}`} aria-busy={refreshing && !loading}>
        <div className="card-head">
          <h3>Bank accounts ({filtered.length}{hasFilters ? ` of ${rows.length}` : ''})</h3>
          {sortBy && (
            <span className="muted" style={{ fontSize: 12 }} role="status" aria-live="polite">
              Sorted by {SORT_LABELS[sortBy] ?? sortBy} ({sortDir === 'asc' ? 'ascending' : 'descending'})
            </span>
          )}
        </div>
        {!data ? (loading ? <Skeleton rows={4} /> : null) : filtered.length === 0 ? (
          hasFilters ? (
            <EmptyState title="No bank accounts match these filters"
              body={term ? `Nothing matches "${search.trim()}" with the other filters applied.` : 'Nothing matches the current filter.'}
              action="Clear filters" onAction={clearFilters} />
          ) : (
            <EmptyState title="No bank accounts yet"
              body="Create a bank or cash account to track a book balance, post transfers and reconcile statements."
              action={can(user, 'finance.banks.create') ? 'New bank' : undefined} onAction={openNew} />
          )
        ) : (
          <>
            <div className="record-cards mobile-only">
              {visible.map((r) => (
                <div key={`card-${String(r.id)}`} className="record-card" onClick={() => navigate(`/finance/banks/${r.id}`)}>
                  <div className="record-card-top">
                    <strong className="cell-mono">{String(r.code)}</strong>
                    <span className="muted">{String(r.accountType ?? '').replace(/_/g, ' ')}</span>
                  </div>
                  <div><strong>{String(r.name)}</strong></div>
                  <div className="record-card-meta">
                    <span>{String(r.bankName ?? '') || '\u2014'}</span>
                    <span className="cell-mono">{String(r.accountNo ?? '') || '\u2014'}</span>
                    <span>GL {String(r.glCode ?? '') || '\u2014'}</span>
                  </div>
                  <div className="record-card-meta">
                    <span>Balance {fmtMoney(r.bookBalance)}</span>
                    <span>{Number(r.unreconciledCount || 0) > 0 ? `${fmtNum(r.unreconciledCount)} unmatched` : 'All matched'}</span>
                  </div>
                  <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="btn btn-sm" onClick={() => navigate(`/finance/banks/${r.id}`)}>Reconcile</button>
                    {can(user, 'finance.banks.update') && <button className="btn btn-sm" onClick={() => { setModal(r); setModalOpen(true); }}>Edit</button>}
                  </div>
                </div>
              ))}
            </div>
            <div className="table-wrap desktop-only">
              <table className="data">
                <thead>
                  <tr>
                    <th aria-sort={ariaSort('code')}><button className="th-btn" title="Sort by code" onClick={() => setSort('code')}>Code{sortMark('code')}</button></th>
                    <th aria-sort={ariaSort('name')}><button className="th-btn" title="Sort by name" onClick={() => setSort('name')}>Name{sortMark('name')}</button></th>
                    <th aria-sort={ariaSort('type')}><button className="th-btn" title="Sort by account type" onClick={() => setSort('type')}>Type{sortMark('type')}</button></th>
                    <th aria-sort={ariaSort('bank')}><button className="th-btn" title="Sort by bank" onClick={() => setSort('bank')}>Bank{sortMark('bank')}</button></th>
                    <th aria-sort={ariaSort('account')}><button className="th-btn" title="Sort by account number" onClick={() => setSort('account')}>Account{sortMark('account')}</button></th>
                    <th aria-sort={ariaSort('gl')}><button className="th-btn" title="Sort by GL code" onClick={() => setSort('gl')}>GL{sortMark('gl')}</button></th>
                    <th className="cell-num" aria-sort={ariaSort('balance')}><button className="th-btn" title="Sort by book balance" onClick={() => setSort('balance')}>Book balance{sortMark('balance')}</button></th>
                    <th className="cell-num" aria-sort={ariaSort('unmatched')}><button className="th-btn" title="Sort by unmatched statement lines" onClick={() => setSort('unmatched')}>Unmatched{sortMark('unmatched')}</button></th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/finance/banks/${r.id}`)}>
                      <td className="cell-mono">{String(r.code)}</td>
                      <td>{String(r.name)}</td>
                      <td>{String(r.accountType ?? '').replace(/_/g, ' ')}</td>
                      <td>{String(r.bankName ?? '') || '\u2014'}</td>
                      <td className="cell-mono">{String(r.accountNo ?? '') || '\u2014'}</td>
                      <td className="cell-mono">{String(r.glCode ?? '') || '\u2014'}</td>
                      <td className="cell-num">{fmtMoney(r.bookBalance)}</td>
                      <td className="cell-num">{Number(r.unreconciledCount || 0) > 0 ? fmtNum(r.unreconciledCount) : <span className="muted">{'\u2014'}</span>}</td>
                      <td>
                        <div className="row-actions">
                          <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); navigate(`/finance/banks/${r.id}`); }}>Reconcile</button>
                          {can(user, 'finance.banks.update') && <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setModal(r); setModalOpen(true); }}>Edit</button>}
                          {can(user, 'finance.banks.update') && <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setConfirm(r); }}>Deactivate</button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const load = useCallback(() => {
    setRefreshing(true);
    api<{ data: Rec[] }>('/api/ops/finance/banks/transfers')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Transfers failed'))
      .finally(() => { setRefreshing(false); setLoading(false); });
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
  const all = rows ?? [];
  const SORTS: Record<string, (r: Rec) => string | number> = {
    transfer: (r) => String(r.transferNo ?? ''),
    date: (r) => String(r.transferDate ?? ''),
    from: (r) => String(r.fromCode ?? ''),
    to: (r) => String(r.toCode ?? ''),
    amount: (r) => Number(r.amount || 0),
    reference: (r) => String(r.reference ?? ''),
  };
  const SORT_LABELS: Record<string, string> = {
    transfer: 'Transfer', date: 'Date', from: 'From account', to: 'To account', amount: 'Amount', reference: 'Reference',
  };
  const term = search.trim().toLowerCase();
  const filtered = all.filter((r) => {
    if (!term) return true;
    return [
      String(r.transferNo ?? ''), String(r.transferDate ?? '').slice(0, 10),
      String(r.fromCode ?? ''), String(r.fromName ?? ''),
      String(r.toCode ?? ''), String(r.toName ?? ''),
      String(r.reference ?? ''), String(r.notes ?? ''),
    ].join(' ').toLowerCase().includes(term);
  });
  const visible = sortBy && SORTS[sortBy]
    ? [...filtered].sort((a, b) => {
        const av = SORTS[sortBy](a); const bv = SORTS[sortBy](b);
        const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : filtered;
  const setSort = (col: string) => {
    if (sortBy !== col) { setSortBy(col); setSortDir('asc'); return; }
    if (sortDir === 'asc') { setSortDir('desc'); return; }
    setSortBy('');
  };
  const sortMark = (col: string) => (sortBy === col ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : '');
  const ariaSort = (col: string): 'ascending' | 'descending' | undefined =>
    sortBy === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined;
  const hasFilters = Boolean(term);
  const clearFilters = () => { setSearch(''); setSortBy(''); };
  const removeFilter = () => setSearch('');
  const crossCurrency = filtered.filter((r) => String(r.fromCurrency ?? '') !== String(r.toCurrency ?? '')).length;
  const byCurrency = Object.entries(filtered.reduce<Record<string, { total: number; count: number }>>((acc, r) => {
    const code = String(r.fromCurrency ?? '').trim() || 'UGX';
    const bucket = acc[code] ?? { total: 0, count: 0 };
    bucket.total += Number(r.amount || 0);
    bucket.count += 1;
    acc[code] = bucket;
    return acc;
  }, {})).map(([currency, v]) => ({ currency, total: v.total, count: v.count })).sort((a, b) => b.total - a.total);
  const openNew = () => setModalOpen(true);
  const capped = all.length >= 100;
  const crossOf = (r: Rec) => String(r.fromCurrency ?? '') !== String(r.toCurrency ?? '');
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Treasury</p>
          <h1>Internal transfers</h1>
          <p className="muted">Move cash between bank and cash accounts (e.g. KCB Dollar to Petty Cash). Each transfer posts a double-entry TRANSFER journal.</p>
        </div>
        {can(user, 'finance.banks.update') && (
          <button className="btn btn-primary" onClick={openNew}>New transfer</button>
        )}
      </header>
      <div className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-label">Transfers</span>
          <span className="kpi-value">{rows ? fmtNum(filtered.length) : '\u2014'}</span>
          {hasFilters && <span className="kpi-sub">of {fmtNum(all.length)} total</span>}
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Cross-currency</span>
          <span className="kpi-value">{rows ? fmtNum(crossCurrency) : '\u2014'}</span>
          <span className="kpi-sub">Transfers that applied an exchange rate</span>
        </div>
        {byCurrency.slice(0, 2).map((c) => (
          <div key={c.currency} className="kpi-card">
            <span className="kpi-label">{c.currency} moved</span>
            <span className="kpi-value">{fmtMoney(c.total)}</span>
            <span className="kpi-sub">{fmtNum(c.count)} {c.count === 1 ? 'transfer' : 'transfers'}</span>
          </div>
        ))}
      </div>
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="toolbar" style={{ marginBottom: hasFilters ? 10 : 0 }}>
          <input className="search-input" type="search" value={search} aria-label="Search internal transfers"
            placeholder="Search transfer no, account, reference, notes..."
            onChange={(e) => setSearch(e.target.value)} />
          {hasFilters && <button className="btn btn-sm btn-ghost" onClick={clearFilters}>Clear filters</button>}
        </div>
        {hasFilters && (
          <div className="filter-chips" style={{ padding: '12px 0 0' }}>
            <span className="filter-chip">
              <b>Search</b>: {search.trim()}
              <button type="button" title="Remove filter" aria-label="Remove search filter" onClick={removeFilter}>{'\u00D7'}</button>
            </span>
            <button className="btn btn-sm btn-ghost" onClick={clearFilters}>Clear all</button>
          </div>
        )}
      </div>
      {error && <ErrorBanner error={error} />}
      <section className={`card card-pad${refreshing && !loading ? ' is-refreshing' : ''}`} aria-busy={refreshing && !loading}>
        <div className="card-head">
          <h3>Internal transfers ({filtered.length}{hasFilters ? ` of ${all.length}` : ''})</h3>
          {sortBy && (
            <span className="muted" style={{ fontSize: 12 }} role="status" aria-live="polite">
              Sorted by {SORT_LABELS[sortBy] ?? sortBy} ({sortDir === 'asc' ? 'ascending' : 'descending'})
            </span>
          )}
        </div>
        {capped && (
          <p className="muted" style={{ margin: '0 0 10px', fontSize: 12 }}>
            Showing the most recent {fmtNum(all.length)} transfers. Older transfers are not listed here.
          </p>
        )}
        {!rows ? (loading ? <Skeleton rows={5} /> : null) : filtered.length === 0 ? (
          hasFilters ? (
            <EmptyState title="No transfers match this search"
              body={`Nothing matches "${search.trim()}".`}
              action="Clear filters" onAction={clearFilters} />
          ) : (
            <EmptyState title="No internal transfers yet"
              body="Move cash between accounts to fund petty cash and other cash books. Each transfer posts a double-entry journal."
              action={can(user, 'finance.banks.update') ? 'New transfer' : undefined} onAction={openNew} />
          )
        ) : (
          <>
            <div className="record-cards mobile-only">
              {visible.map((r) => (
                <div key={`card-${String(r.id)}`} className="record-card">
                  <div className="record-card-top">
                    <strong className="cell-mono">{String(r.transferNo)}</strong>
                    <span className="muted">{String(r.transferDate ?? '').slice(0, 10)}</span>
                  </div>
                  <div className="record-card-meta">
                    <span><span className="cell-mono">{String(r.fromCode)}</span> {String(r.fromName ?? '')}</span>
                    <span>{'\u2192'}</span>
                    <span><span className="cell-mono">{String(r.toCode)}</span> {String(r.toName ?? '')}</span>
                  </div>
                  <div className="record-card-meta">
                    <span>Amount {fmtMoney(r.amount)} {String(r.fromCurrency ?? '')}</span>
                    {crossOf(r) && <span>Credited {fmtMoney(r.toAmount)} {String(r.toCurrency ?? '')} at {fmtNum(r.exchangeRate)}</span>}
                  </div>
                  <div className="record-card-meta">
                    <span>Ref: {String(r.reference ?? '').trim() || '\u2014'}</span>
                  </div>
                  {String(r.notes ?? '').trim() ? <div className="record-card-meta"><span>{String(r.notes)}</span></div> : null}
                </div>
              ))}
            </div>
            <div className="table-wrap desktop-only">
              <table className="data">
                <thead>
                  <tr>
                    <th aria-sort={ariaSort('transfer')}><button className="th-btn" title="Sort by transfer number" onClick={() => setSort('transfer')}>Transfer{sortMark('transfer')}</button></th>
                    <th aria-sort={ariaSort('date')}><button className="th-btn" title="Sort by date" onClick={() => setSort('date')}>Date{sortMark('date')}</button></th>
                    <th aria-sort={ariaSort('from')}><button className="th-btn" title="Sort by source account" onClick={() => setSort('from')}>From{sortMark('from')}</button></th>
                    <th aria-sort={ariaSort('to')}><button className="th-btn" title="Sort by destination account" onClick={() => setSort('to')}>To{sortMark('to')}</button></th>
                    <th className="cell-num" aria-sort={ariaSort('amount')}><button className="th-btn" title="Sort by amount" onClick={() => setSort('amount')}>Amount{sortMark('amount')}</button></th>
                    <th>Exchange rate</th>
                    <th aria-sort={ariaSort('reference')}><button className="th-btn" title="Sort by reference" onClick={() => setSort('reference')}>Reference{sortMark('reference')}</button></th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={String(r.id)}>
                      <td className="cell-mono">{String(r.transferNo)}</td>
                      <td>{String(r.transferDate ?? '').slice(0, 10)}</td>
                      <td><span className="cell-mono">{String(r.fromCode)}</span> <span className="muted">{String(r.fromName ?? '')}</span></td>
                      <td><span className="cell-mono">{String(r.toCode)}</span> <span className="muted">{String(r.toName ?? '')}</span></td>
                      <td className="cell-num">{fmtMoney(r.amount)} <span className="muted">{String(r.fromCurrency ?? '')}</span></td>
                      <td>{crossOf(r) ? <><span className="cell-mono">{fmtNum(r.exchangeRate)}</span> <span className="muted">{String(r.toCurrency)} per 1 {String(r.fromCurrency)}</span></> : <span className="muted">{'\u2014'}</span>}</td>
                      <td>{String(r.reference ?? '').trim() || '\u2014'}</td>
                      <td className="muted" title={String(r.notes ?? '')}>{String(r.notes ?? '').trim() || '\u2014'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
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
  const [rows, setRows] = useState<Rec[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const load = useCallback(() => {
    setRefreshing(true);
    api<{ data: Rec[] }>('/api/ops/finance/periods')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Periods failed'))
      .finally(() => { setRefreshing(false); setLoading(false); });
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
  const all = rows ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const covers = (r: Rec) => {
    const start = String(r.startDate ?? '').slice(0, 10);
    const end = String(r.endDate ?? '').slice(0, 10);
    return Boolean(start && end && start <= today && today <= end);
  };
  const SORTS: Record<string, (r: Rec) => string | number> = {
    code: (r) => String(r.code ?? ''),
    name: (r) => String(r.name ?? ''),
    start: (r) => String(r.startDate ?? ''),
    end: (r) => String(r.endDate ?? ''),
    status: (r) => String(r.status ?? ''),
  };
  const SORT_LABELS: Record<string, string> = {
    code: 'Code', name: 'Name', start: 'Start', end: 'End', status: 'Status',
  };
  const term = search.trim().toLowerCase();
  const filtered = all.filter((r) => {
    if (statusFilter && String(r.status) !== statusFilter) return false;
    if (!term) return true;
    return [
      String(r.code ?? ''), String(r.name ?? ''),
      String(r.startDate ?? '').slice(0, 10), String(r.endDate ?? '').slice(0, 10),
      String(r.status ?? ''),
    ].join(' ').toLowerCase().includes(term);
  });
  const visible = sortBy && SORTS[sortBy]
    ? [...filtered].sort((a, b) => {
        const av = SORTS[sortBy](a); const bv = SORTS[sortBy](b);
        const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : filtered;
  const setSort = (col: string) => {
    if (sortBy !== col) { setSortBy(col); setSortDir('asc'); return; }
    if (sortDir === 'asc') { setSortDir('desc'); return; }
    setSortBy('');
  };
  const sortMark = (col: string) => (sortBy === col ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : '');
  const ariaSort = (col: string): 'ascending' | 'descending' | undefined =>
    sortBy === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined;
  const hasFilters = Boolean(term || statusFilter);
  const clearFilters = () => { setSearch(''); setStatusFilter(''); setSortBy(''); };
  const activeFilters: Array<{ key: string; label: string; value: string }> = [];
  if (search.trim()) activeFilters.push({ key: 'q', label: 'Search', value: search.trim() });
  if (statusFilter) activeFilters.push({ key: 'status', label: 'Status', value: statusFilter });
  const removeFilter = (key: string) => {
    if (key === 'q') setSearch('');
    if (key === 'status') setStatusFilter('');
  };
  const counts: Record<string, number> = { OPEN: 0, LOCKED: 0, CLOSED: 0 };
  for (const r of all) {
    const s = String(r.status ?? '').toUpperCase();
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const currentPeriod = all.filter(covers).sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)))[0] ?? null;
  const currentSub = !rows ? '' : currentPeriod
    ? `${String(currentPeriod.startDate).slice(0, 10)} to ${String(currentPeriod.endDate).slice(0, 10)}`
    : 'No period covers today';
  const openSub = rows && all.length > 0 && counts.OPEN === 0 ? 'No open period, so journals are blocked' : '';
  const actionsFor = (r: Rec) => (
    <div className="row-actions">
      {can(user, 'finance.periods.lock') && r.status === 'OPEN' && <button className="btn btn-sm" disabled={busy} onClick={() => act(Number(r.id), 'lock')}>Lock</button>}
      {can(user, 'finance.periods.close') && r.status !== 'CLOSED' && <button className="btn btn-sm" disabled={busy} onClick={() => act(Number(r.id), 'close')}>Close</button>}
      {can(user, 'finance.periods.open') && r.status !== 'OPEN' && <button className="btn btn-sm" disabled={busy} onClick={() => act(Number(r.id), 'open')}>Reopen</button>}
    </div>
  );
  const openNew = () => setModalOpen(true);
  const pill = { padding: '2px 9px', fontSize: 11 } as const;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Period control</p>
          <h1>Financial periods</h1>
          <p className="muted">Locked or closed periods reject every journal - including sales, GRN and production postings.</p>
        </div>
        {can(user, 'finance.periods.create') && <button className="btn btn-primary" onClick={openNew}>New period</button>}
      </header>
      <div className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-label">Periods</span>
          <span className="kpi-value">{rows ? fmtNum(filtered.length) : '\u2014'}</span>
          {hasFilters && <span className="kpi-sub">of {fmtNum(all.length)} total</span>}
        </div>
        <div className={`kpi-card${all.length > 0 && !currentPeriod ? ' card-warn' : ''}`}>
          <span className="kpi-label">Current period</span>
          <span className="kpi-value">{rows ? (currentPeriod ? String(currentPeriod.code) : '\u2014') : '\u2014'}</span>
          {currentSub && <span className="kpi-sub">{currentSub}</span>}
        </div>
        <div className={`kpi-card${openSub ? ' card-warn' : ''}`}>
          <span className="kpi-label">Open</span>
          <span className="kpi-value">{rows ? fmtNum(counts.OPEN) : '\u2014'}</span>
          {openSub && <span className="kpi-sub">{openSub}</span>}
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Locked</span>
          <span className="kpi-value">{rows ? fmtNum(counts.LOCKED) : '\u2014'}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Closed</span>
          <span className="kpi-value">{rows ? fmtNum(counts.CLOSED) : '\u2014'}</span>
        </div>
      </div>
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="toolbar" style={{ marginBottom: hasFilters ? 10 : 0 }}>
          <input className="search-input" type="search" value={search} aria-label="Search financial periods"
            placeholder="Search code, name, date..."
            onChange={(e) => setSearch(e.target.value)} />
          <StatusSelect value={statusFilter} onChange={setStatusFilter} options={PERIOD_STATUSES}
            label="Filter by period status" placeholder="All statuses" />
          {hasFilters && <button className="btn btn-sm btn-ghost" onClick={clearFilters}>Clear filters</button>}
        </div>
        {activeFilters.length > 0 && (
          <div className="filter-chips" style={{ padding: '12px 0 0' }}>
            {activeFilters.map((f) => (
              <span key={f.key} className="filter-chip">
                <b>{f.label}</b>{f.value ? `: ${f.value}` : ''}
                <button type="button" title="Remove filter" aria-label={`Remove ${f.label} filter`} onClick={() => removeFilter(f.key)}>{'\u00D7'}</button>
              </span>
            ))}
            <button className="btn btn-sm btn-ghost" onClick={clearFilters}>Clear all</button>
          </div>
        )}
      </div>
      {error && <ErrorBanner error={error} />}
      <section className={`card card-pad${refreshing && !loading ? ' is-refreshing' : ''}`} aria-busy={refreshing && !loading}>
        <div className="card-head">
          <h3>Financial periods ({filtered.length}{hasFilters ? ` of ${all.length}` : ''})</h3>
          {sortBy && (
            <span className="muted" style={{ fontSize: 12 }} role="status" aria-live="polite">
              Sorted by {SORT_LABELS[sortBy] ?? sortBy} ({sortDir === 'asc' ? 'ascending' : 'descending'})
            </span>
          )}
        </div>
        {!rows ? (loading ? <Skeleton rows={5} /> : null) : filtered.length === 0 ? (
          hasFilters ? (
            <EmptyState title="No periods match these filters"
              body={term ? `Nothing matches "${search.trim()}" with the other filters applied.` : 'Nothing matches the current filter.'}
              action="Clear filters" onAction={clearFilters} />
          ) : (
            <EmptyState title="No financial periods yet"
              body="Create a period to open the books. Journals, sales and GRN postings all need a period that covers the entry date."
              action={can(user, 'finance.periods.create') ? 'New period' : undefined} onAction={openNew} />
          )
        ) : (
          <>
            <div className="record-cards mobile-only">
              {visible.map((r) => (
                <div key={`card-${String(r.id)}`} className="record-card">
                  <div className="record-card-top">
                    <strong className="cell-mono">{String(r.code)}</strong>
                    <Badge value={r.status} />
                  </div>
                  <div>
                    <strong>{String(r.name)}</strong>
                    {covers(r) && <span className="chip chip-on" style={pill}>Current</span>}
                  </div>
                  <div className="record-card-meta">
                    <span>{String(r.startDate ?? '').slice(0, 10)}</span>
                    <span>{'\u2192'}</span>
                    <span>{String(r.endDate ?? '').slice(0, 10)}</span>
                  </div>
                  {actionsFor(r)}
                </div>
              ))}
            </div>
            <div className="table-wrap desktop-only">
              <table className="data">
                <thead>
                  <tr>
                    <th aria-sort={ariaSort('code')}><button className="th-btn" title="Sort by code" onClick={() => setSort('code')}>Code{sortMark('code')}</button></th>
                    <th aria-sort={ariaSort('name')}><button className="th-btn" title="Sort by name" onClick={() => setSort('name')}>Name{sortMark('name')}</button></th>
                    <th aria-sort={ariaSort('start')}><button className="th-btn" title="Sort by start date" onClick={() => setSort('start')}>Start{sortMark('start')}</button></th>
                    <th aria-sort={ariaSort('end')}><button className="th-btn" title="Sort by end date" onClick={() => setSort('end')}>End{sortMark('end')}</button></th>
                    <th aria-sort={ariaSort('status')}><button className="th-btn" title="Sort by status" onClick={() => setSort('status')}>Status{sortMark('status')}</button></th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={String(r.id)}>
                      <td className="cell-mono">{String(r.code)}</td>
                      <td>{String(r.name)} {covers(r) && <span className="chip chip-on" style={pill}>Current</span>}</td>
                      <td>{String(r.startDate ?? '').slice(0, 10)}</td>
                      <td>{String(r.endDate ?? '').slice(0, 10)}</td>
                      <td><Badge value={r.status} /></td>
                      <td>{actionsFor(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<Rec | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [confirm, setConfirm] = useState<Rec | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const load = useCallback(() => {
    setLoading(true);
    api<{ data: Rec[] }>('/api/ops/finance/accounts')
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'COA failed'))
      .finally(() => setLoading(false));
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
  const SORTS: Record<string, (r: Rec) => string | number> = {
    code: (r) => String(r.code ?? ''),
    name: (r) => String(r.name ?? ''),
    type: (r) => String(r.accountType ?? ''),
    subtype: (r) => String(r.subtype ?? ''),
    parent: (r) => parentCode(r.parentId),
    posting: (r) => (r.isPosting ? 1 : 0),
    status: (r) => (r.isActive === false ? 1 : 0),
  };
  const SORT_LABELS: Record<string, string> = {
    code: 'Code', name: 'Name', type: 'Type', subtype: 'Subtype',
    parent: 'Parent', posting: 'Posting', status: 'Status',
  };
  const term = search.trim().toLowerCase();
  const filtered = rows.filter((r) => {
    if (activeOnly && r.isActive === false) return false;
    if (typeFilter && String(r.accountType) !== typeFilter) return false;
    if (!term) return true;
    return `${String(r.code ?? '')} ${String(r.name ?? '')} ${String(r.subtype ?? '')}`.toLowerCase().includes(term);
  });
  const visible = sortBy && SORTS[sortBy]
    ? [...filtered].sort((a, b) => {
        const av = SORTS[sortBy](a); const bv = SORTS[sortBy](b);
        const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : filtered;
  const setSort = (col: string) => {
    if (sortBy !== col) { setSortBy(col); setSortDir('asc'); return; }
    if (sortDir === 'asc') { setSortDir('desc'); return; }
    setSortBy('');
  };
  const sortMark = (col: string) => (sortBy === col ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : '');
  const ariaSort = (col: string): 'ascending' | 'descending' | undefined =>
    sortBy === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined;
  const hasFilters = Boolean(term || typeFilter || activeOnly);
  const clearFilters = () => { setSearch(''); setTypeFilter(''); setActiveOnly(false); setSortBy(''); };
  const activeFilters: Array<{ key: string; label: string; value: string }> = [];
  if (search.trim()) activeFilters.push({ key: 'q', label: 'Search', value: search.trim() });
  if (typeFilter) activeFilters.push({ key: 'type', label: 'Type', value: typeFilter.replace(/_/g, ' ') });
  if (activeOnly) activeFilters.push({ key: 'active', label: 'Show', value: 'Active only' });
  const removeFilter = (key: string) => {
    if (key === 'q') setSearch('');
    if (key === 'type') setTypeFilter('');
    if (key === 'active') setActiveOnly(false);
  };
  const canEdit = can(user, 'finance.chart_of_accounts.update');
  const canDelete = can(user, 'finance.chart_of_accounts.delete');
  const openNew = () => { setModal(null); setModalOpen(true); };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Master data</p>
          <h1>Chart of accounts</h1>
          <p className="muted">Posting is allowed only on leaf accounts marked posting. Inactive accounts stay on history.</p>
        </div>
        {can(user, 'finance.chart_of_accounts.create') && <button className="btn btn-primary" onClick={openNew}>New account</button>}
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <input className="search-input" type="search" value={search} aria-label="Search accounts"
            placeholder="Search code, name or subtype..."
            onChange={(e) => setSearch(e.target.value)} />
          <StatusSelect value={typeFilter} onChange={setTypeFilter} options={ACCOUNT_TYPES} label="Filter by account type" placeholder="All types" />
          <button type="button" className={activeOnly ? 'chip chip-on' : 'chip'} aria-pressed={activeOnly}
            title="Hide deactivated accounts" onClick={() => setActiveOnly(!activeOnly)}>Active only</button>
          {hasFilters && <button className="btn btn-sm btn-ghost" onClick={clearFilters}>Clear filters</button>}
        </div>
        {(activeFilters.length > 0 || sortBy) && (
          <div className="filter-chips" style={{ padding: '12px 0 0' }}>
            {activeFilters.map((f) => (
              <span key={f.key} className="filter-chip">
                <b>{f.label}</b>{f.value ? `: ${f.value}` : ''}
                <button type="button" title="Remove filter" aria-label={`Remove ${f.label} filter`} onClick={() => removeFilter(f.key)}>{'\u00D7'}</button>
              </span>
            ))}
            {sortBy && (
              <span className="filter-chip">
                <b>Sort</b>{`: ${SORT_LABELS[sortBy] ?? sortBy} ${sortDir === 'asc' ? 'ascending' : 'descending'}`}
                <button type="button" title="Clear sort" aria-label="Clear sort" onClick={() => setSortBy('')}>{'\u00D7'}</button>
              </span>
            )}
            <button className="btn btn-sm btn-ghost" onClick={clearFilters}>Clear all</button>
          </div>
        )}
      </div>
      <section className="card card-pad">
        <div className="card-head">
          <h3>Accounts ({rows.length.toLocaleString()})</h3>
          {!loading && rows.length > 0 && (
            <span className="muted" style={{ fontSize: 12 }} role="status" aria-live="polite">
              {visible.length === rows.length
                ? `${visible.length.toLocaleString()} accounts`
                : `${visible.length.toLocaleString()} of ${rows.length.toLocaleString()} shown`}
              {sortBy ? ` \u00B7 sorted by ${SORT_LABELS[sortBy] ?? sortBy} (${sortDir === 'asc' ? 'ascending' : 'descending'})` : ''}
            </span>
          )}
        </div>
        {loading ? <Skeleton rows={8} /> : rows.length === 0 ? (
          <EmptyState title="No accounts yet" body="The chart of accounts is empty. Create the first account to start posting journals and expenses."
            action={can(user, 'finance.chart_of_accounts.create') ? 'New account' : undefined} onAction={openNew} />
        ) : visible.length === 0 ? (
          <EmptyState title="No accounts match these filters"
            body={search.trim() ? `Nothing matches "${search.trim()}" with the other filters applied.` : 'Nothing matches the current filters.'}
            action="Clear filters" onAction={clearFilters} />
        ) : (
          <>
            <div className="record-cards mobile-only">
              {visible.map((r) => (
                <div key={`card-${String(r.id)}`} className="record-card">
                  <div className="record-card-top">
                    <strong className="cell-mono">{String(r.code)}</strong>
                    <Badge value={r.isActive === false ? 'Inactive' : 'Active'} />
                  </div>
                  <div>{String(r.name)}</div>
                  <div className="record-card-meta">
                    <span>{String(r.accountType).replace(/_/g, ' ')}</span>
                    <span>{r.isPosting ? 'Posting' : 'Heading'}</span>
                    {parentCode(r.parentId) && <span>Parent {parentCode(r.parentId)}</span>}
                  </div>
                  {(canEdit || canDelete) && (
                    <div className="row-actions" style={{ marginTop: 8 }}>
                      {canEdit && <button className="btn btn-sm" onClick={() => { setModal(r); setModalOpen(true); }}>Edit</button>}
                      {canDelete && r.isActive !== false && <button className="btn btn-sm" onClick={() => setConfirm(r)}>Deactivate</button>}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="table-wrap desktop-only">
              <table className="data">
                <thead>
                  <tr>
                    <th aria-sort={ariaSort('code')}><button className="th-btn" title="Sort by code" onClick={() => setSort('code')}>Code{sortMark('code')}</button></th>
                    <th aria-sort={ariaSort('name')}><button className="th-btn" title="Sort by name" onClick={() => setSort('name')}>Name{sortMark('name')}</button></th>
                    <th aria-sort={ariaSort('type')}><button className="th-btn" title="Sort by type" onClick={() => setSort('type')}>Type{sortMark('type')}</button></th>
                    <th aria-sort={ariaSort('subtype')}><button className="th-btn" title="Sort by subtype" onClick={() => setSort('subtype')}>Subtype{sortMark('subtype')}</button></th>
                    <th aria-sort={ariaSort('parent')}><button className="th-btn" title="Sort by parent" onClick={() => setSort('parent')}>Parent{sortMark('parent')}</button></th>
                    <th aria-sort={ariaSort('posting')}><button className="th-btn" title="Sort by posting type" onClick={() => setSort('posting')}>Posting{sortMark('posting')}</button></th>
                    <th aria-sort={ariaSort('status')}><button className="th-btn" title="Sort by status" onClick={() => setSort('status')}>Status{sortMark('status')}</button></th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
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
                          {canEdit && <button className="btn btn-sm" onClick={() => { setModal(r); setModalOpen(true); }}>Edit</button>}
                          {canDelete && r.isActive !== false && <button className="btn btn-sm" onClick={() => setConfirm(r)}>Deactivate</button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
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
  const q = useHashQuery();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(loadFinPageSize);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState(q.get('q') ?? '');
  const [status, setStatus] = useState(q.get('status') ?? '');
  const committedSearch = q.get('q') ?? '';
  const committedStatus = q.get('status') ?? '';
  const sortBy = BUDGET_SORT_COLUMNS.includes(q.get('sortBy') ?? '') ? (q.get('sortBy') as string) : '';
  const sortDir: 'asc' | 'desc' = q.get('sortDir') === 'asc' ? 'asc' : 'desc';
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (committedSearch) p.set('q', committedSearch);
    if (committedStatus) p.set('status', committedStatus);
    if (sortBy) { p.set('sortBy', sortBy); p.set('sortDir', sortDir); }
    return p;
  }, [committedSearch, committedStatus, sortBy, sortDir]);
  // Single funnel for filter and sort changes: each one returns to page 1 and
  // never drops a search draft typed since the last committed search.
  const writeQuery = (extra: Record<string, string>) => {
    const next: Record<string, string> = { ...Object.fromEntries(qs), ...extra };
    if (!('q' in extra) && committedSearch !== search) {
      if (search) next.q = search; else delete next.q;
    }
    for (const [k, v] of Object.entries(next)) if (!v) delete next[k];
    if (!next.sortBy) delete next.sortDir;
    setPage(1);
    navigate('/finance/budgets', { query: next });
  };
  const setSort = (col: string) => {
    if (sortBy !== col) return writeQuery({ sortBy: col, sortDir: 'asc' });
    if (sortDir === 'asc') return writeQuery({ sortBy: col, sortDir: 'desc' });
    return writeQuery({ sortBy: '' });
  };
  useEffect(() => {
    let alive = true;
    setRefreshing(true);
    setError('');
    const p = new URLSearchParams(qs);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/finance/budgets?${p}`)
      .then((r) => { if (!alive) return; setRows(r.data.rows ?? []); setTotal(r.data.total ?? 0); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Budgets failed'); })
      .finally(() => { if (alive) { setRefreshing(false); setLoading(false); } });
    return () => { alive = false; };
  }, [qs, page, pageSize]);
  // Keep the filter drafts in step with back/forward navigation.
  useEffect(() => { setSearch(committedSearch); setStatus(committedStatus); }, [committedSearch, committedStatus]);
  // Filter as the user types instead of only on Enter.
  useEffect(() => {
    if (committedSearch === search) return;
    const t = setTimeout(() => writeQuery({ q: search }), 300);
    return () => clearTimeout(t);
  }, [search, committedSearch, qs]);
  // Never strand the user on a page that no longer exists once filters narrow.
  useEffect(() => {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (page > pages) setPage(pages);
  }, [total, pageSize, page]);
  const clearAll = () => navigate('/finance/budgets', { query: {} });
  const hasFilters = Boolean(committedSearch || committedStatus);
  const activeFilters: Array<{ key: string; label: string; value: string }> = [];
  if (committedSearch) activeFilters.push({ key: 'q', label: 'Search', value: committedSearch });
  if (committedStatus) activeFilters.push({ key: 'status', label: 'Status', value: committedStatus.replace(/_/g, ' ') });
  const removeFilter = (key: string) => {
    const next: Record<string, string> = { ...Object.fromEntries(qs) };
    delete next[key];
    setPage(1);
    navigate('/finance/budgets', { query: next });
  };
  const changePageSize = (n: number) => { setPageSize(n); setPage(1); saveFinPageSize(n); };
  const sortMark = (col: string) => (sortBy === col ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : '');
  const ariaSort = (col: string): 'ascending' | 'descending' | undefined =>
    sortBy === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined;
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
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <input className="search-input" type="search" value={search} aria-label="Search budgets"
            placeholder="Search budget no..."
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && committedSearch !== search) writeQuery({ q: search }); }} />
          <StatusSelect value={status} onChange={(v) => { setStatus(v); writeQuery({ status: v }); }} options={BUDGET_STATUSES} />
          {hasFilters && <button className="btn btn-sm btn-ghost" onClick={clearAll}>Clear filters</button>}
        </div>
        {(activeFilters.length > 0 || sortBy) && (
          <div className="filter-chips" style={{ padding: '12px 0 0' }}>
            {activeFilters.map((f) => (
              <span key={f.key} className="filter-chip">
                <b>{f.label}</b>{f.value ? `: ${f.value}` : ''}
                <button type="button" title="Remove filter" aria-label={`Remove ${f.label} filter`} onClick={() => removeFilter(f.key)}>{'\u00D7'}</button>
              </span>
            ))}
            {sortBy && (
              <span className="filter-chip">
                <b>Sort</b>{`: ${BUDGET_SORT_LABELS[sortBy] ?? sortBy} ${sortDir === 'asc' ? 'ascending' : 'descending'}`}
                <button type="button" title="Clear sort" aria-label="Clear sort" onClick={() => writeQuery({ sortBy: '' })}>{'\u00D7'}</button>
              </span>
            )}
            <button className="btn btn-sm btn-ghost" onClick={clearAll}>Clear all</button>
          </div>
        )}
      </div>
      {error && <ErrorBanner error={error} />}
      <section className={`card card-pad${refreshing && !loading ? ' is-refreshing' : ''}`} aria-busy={refreshing && !loading}>
        <div className="card-head">
          <h3>Budgets ({total.toLocaleString()})</h3>
          {!loading && total > 0 && (
            <span className="muted" style={{ fontSize: 12 }} role="status" aria-live="polite">
              Showing {((page - 1) * pageSize + 1).toLocaleString()}-{Math.min(page * pageSize, total).toLocaleString()} of {total.toLocaleString()}
              {sortBy ? ` \u00B7 sorted by ${BUDGET_SORT_LABELS[sortBy] ?? sortBy} (${sortDir === 'asc' ? 'ascending' : 'descending'})` : ''}
            </span>
          )}
        </div>
        {loading ? <Skeleton rows={6} /> : rows.length === 0 ? (
          hasFilters ? (
            <EmptyState title="No budgets match these filters"
              body={committedSearch ? `Nothing matches "${committedSearch}" with the other filters applied. Clear them to see every budget.` : 'Nothing matches the current filters. Clear them to see every budget.'}
              action="Clear filters" onAction={clearAll} />
          ) : (
            <EmptyState title="No budgets yet" body="Budgets cap what each account may spend in a period. Create one, then add lines per account."
              action={can(user, 'finance.budgets.create') ? 'New budget' : undefined} onAction={() => navigate('/finance/budgets/new')} />
          )
        ) : (
          <>
            <div className="record-cards mobile-only">
              {rows.map((r) => (
                <div key={`card-${String(r.id)}`} className="record-card" onClick={() => navigate(`/finance/budgets/${r.id}`)}>
                  <div className="record-card-top">
                    <strong className="cell-mono">{String(r.budgetNo)}</strong>
                    <Badge value={r.status} />
                  </div>
                  <div className="record-card-meta">
                    <span>{String(r.periodStart).slice(0, 10)} {'\u2192'} {String(r.periodEnd).slice(0, 10)}</span>
                    <span>{fmtNum(r.lineCount)} lines</span>
                    <span>{fmtMoney(r.amount)}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="table-wrap desktop-only">
              <table className="data">
                <thead>
                  <tr>
                    <th aria-sort={ariaSort('budget_no')}><button className="th-btn" title="Sort by budget number" onClick={() => setSort('budget_no')}>Budget{sortMark('budget_no')}</button></th>
                    <th aria-sort={ariaSort('period')}><button className="th-btn" title="Sort by period start" onClick={() => setSort('period')}>Period{sortMark('period')}</button></th>
                    <th className="cell-num" aria-sort={ariaSort('lines')}><button className="th-btn" title="Sort by number of lines" onClick={() => setSort('lines')}>Lines{sortMark('lines')}</button></th>
                    <th className="cell-num" aria-sort={ariaSort('amount')}><button className="th-btn" title="Sort by planned amount" onClick={() => setSort('amount')}>Amount{sortMark('amount')}</button></th>
                    <th aria-sort={ariaSort('status')}><button className="th-btn" title="Sort by status" onClick={() => setSort('status')}>Status{sortMark('status')}</button></th>
                    <th />
                  </tr>
                </thead>
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
                </tbody>
              </table>
            </div>
          </>
        )}
        {!loading && <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={changePageSize} pageSizes={FIN_PAGE_SIZES} />}
      </section>
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
  const q = useHashQuery();
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(loadFinPageSize);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [search, setSearch] = useState(q.get('q') ?? '');
  const [status, setStatus] = useState(q.get('status') ?? '');
  const [busy, setBusy] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [confirm, setConfirm] = useState<Rec | null>(null);
  const committedSearch = q.get('q') ?? '';
  const committedStatus = q.get('status') ?? '';
  const sortBy = ADVANCE_SORT_COLUMNS.includes(q.get('sortBy') ?? '') ? (q.get('sortBy') as string) : '';
  const sortDir: 'asc' | 'desc' = q.get('sortDir') === 'asc' ? 'asc' : 'desc';
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (committedSearch) p.set('q', committedSearch);
    if (committedStatus) p.set('status', committedStatus);
    if (sortBy) { p.set('sortBy', sortBy); p.set('sortDir', sortDir); }
    return p;
  }, [committedSearch, committedStatus, sortBy, sortDir]);
  // Single funnel for filter and sort changes: each one returns to page 1 and
  // never drops a search draft typed since the last committed search.
  const writeQuery = (extra: Record<string, string>) => {
    const next: Record<string, string> = { ...Object.fromEntries(qs), ...extra };
    if (!('q' in extra) && committedSearch !== search) {
      if (search) next.q = search; else delete next.q;
    }
    for (const [k, v] of Object.entries(next)) if (!v) delete next[k];
    if (!next.sortBy) delete next.sortDir;
    setPage(1);
    navigate('/finance/advances', { query: next });
  };
  const setSort = (col: string) => {
    if (sortBy !== col) return writeQuery({ sortBy: col, sortDir: 'asc' });
    if (sortDir === 'asc') return writeQuery({ sortBy: col, sortDir: 'desc' });
    return writeQuery({ sortBy: '' });
  };
  // Bumped after a write so the list refetches without losing filters or page.
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  useEffect(() => {
    let alive = true;
    setRefreshing(true);
    setError('');
    const p = new URLSearchParams(qs);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/finance/advances?${p}`)
      .then((r) => { if (!alive) return; setRows(r.data.rows ?? []); setTotal(r.data.total ?? 0); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Advances failed'); })
      .finally(() => { if (alive) { setRefreshing(false); setLoading(false); } });
    return () => { alive = false; };
  }, [qs, page, pageSize, reloadKey]);
  // Keep the filter drafts in step with back/forward navigation.
  useEffect(() => { setSearch(committedSearch); setStatus(committedStatus); }, [committedSearch, committedStatus]);
  // Filter as the user types instead of only on Enter.
  useEffect(() => {
    if (committedSearch === search) return;
    const t = setTimeout(() => writeQuery({ q: search }), 300);
    return () => clearTimeout(t);
  }, [search, committedSearch, qs]);
  // Never strand the user on a page that no longer exists once filters narrow.
  useEffect(() => {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (page > pages) setPage(pages);
  }, [total, pageSize, page]);
  useEffect(() => { if (autoOpen) setModalOpen(true); }, [autoOpen]);
  const clearAll = () => navigate('/finance/advances', { query: {} });
  const hasFilters = Boolean(committedSearch || committedStatus);
  const activeFilters: Array<{ key: string; label: string; value: string }> = [];
  if (committedSearch) activeFilters.push({ key: 'q', label: 'Search', value: committedSearch });
  if (committedStatus) activeFilters.push({ key: 'status', label: 'Status', value: committedStatus.replace(/_/g, ' ') });
  const removeFilter = (key: string) => {
    const next: Record<string, string> = { ...Object.fromEntries(qs) };
    delete next[key];
    setPage(1);
    navigate('/finance/advances', { query: next });
  };
  const changePageSize = (n: number) => { setPageSize(n); setPage(1); saveFinPageSize(n); };
  const sortMark = (col: string) => (sortBy === col ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : '');
  const ariaSort = (col: string): 'ascending' | 'descending' | undefined =>
    sortBy === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined;
  const save = async (payload: Rec) => {
    setBusy(true); setError('');
    try {
      await api('/api/ops/finance/advances', { method: 'POST', body: JSON.stringify(payload) });
      setModalOpen(false);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const doVoid = async (r: Rec, reason: string) => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/finance/advances/${String(r.id)}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
      setConfirm(null);
      reload();
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
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <input className="search-input" type="search" value={search} aria-label="Search advances"
            placeholder="Search advance no, holder, reference..."
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && committedSearch !== search) writeQuery({ q: search }); }} />
          <StatusSelect value={status} onChange={(v) => { setStatus(v); writeQuery({ status: v }); }} options={ADVANCE_STATUSES} />
          {hasFilters && <button className="btn btn-sm btn-ghost" onClick={clearAll}>Clear filters</button>}
        </div>
        {(activeFilters.length > 0 || sortBy) && (
          <div className="filter-chips" style={{ padding: '12px 0 0' }}>
            {activeFilters.map((f) => (
              <span key={f.key} className="filter-chip">
                <b>{f.label}</b>{f.value ? `: ${f.value}` : ''}
                <button type="button" title="Remove filter" aria-label={`Remove ${f.label} filter`} onClick={() => removeFilter(f.key)}>{'\u00D7'}</button>
              </span>
            ))}
            {sortBy && (
              <span className="filter-chip">
                <b>Sort</b>{`: ${ADVANCE_SORT_LABELS[sortBy] ?? sortBy} ${sortDir === 'asc' ? 'ascending' : 'descending'}`}
                <button type="button" title="Clear sort" aria-label="Clear sort" onClick={() => writeQuery({ sortBy: '' })}>{'\u00D7'}</button>
              </span>
            )}
            <button className="btn btn-sm btn-ghost" onClick={clearAll}>Clear all</button>
          </div>
        )}
      </div>
      {error && <ErrorBanner error={error} />}
      <section className={`card card-pad${refreshing && !loading ? ' is-refreshing' : ''}`} aria-busy={refreshing && !loading}>
        <div className="card-head">
          <h3>Advances ({total.toLocaleString()})</h3>
          {!loading && total > 0 && (
            <span className="muted" style={{ fontSize: 12 }} role="status" aria-live="polite">
              Showing {((page - 1) * pageSize + 1).toLocaleString()}-{Math.min(page * pageSize, total).toLocaleString()} of {total.toLocaleString()}
              {sortBy ? ` \u00B7 sorted by ${ADVANCE_SORT_LABELS[sortBy] ?? sortBy} (${sortDir === 'asc' ? 'ascending' : 'descending'})` : ''}
            </span>
          )}
        </div>
        {loading ? <Skeleton rows={6} /> : rows.length === 0 ? (
          hasFilters ? (
            <EmptyState title="No advances match these filters"
              body={committedSearch ? `Nothing matches "${committedSearch}" with the other filters applied. Clear them to see every advance.` : 'Nothing matches the current filters. Clear them to see every advance.'}
              action="Clear filters" onAction={clearAll} />
          ) : (
            <EmptyState title="No advances yet" body="Cash advanced to staff or for office needs lands here, and stays open until it is settled or voided."
              action={can(user, 'finance.advances.create') ? 'Issue advance' : undefined} onAction={() => setModalOpen(true)} />
          )
        ) : (
          <>
            <div className="record-cards mobile-only">
              {rows.map((r) => (
                <div key={`card-${String(r.id)}`} className="record-card" onClick={() => navigate(`/finance/advances/${r.id}`)}>
                  <div className="record-card-top">
                    <strong className="cell-mono">{String(r.advanceNo)}</strong>
                    <Badge value={r.status} />
                  </div>
                  <div className="record-card-meta">
                    <span>{String(r.advanceDate).slice(0, 10)}</span>
                    <span>{String(r.holderName ?? '') || '\u2014'}</span>
                    <span>{fmtMoney(r.baseAmount)}</span>
                  </div>
                  <div>{String(r.purpose ?? '') || '\u2014'}</div>
                  <div className="record-card-meta">
                    <span>Outstanding {fmtMoney(r.outstanding)}</span>
                    <span>{String(r.bankCode ?? '')}</span>
                  </div>
                  {r.status === 'POSTED' && can(user, 'finance.advances.void') && (
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="btn btn-sm" disabled={busy} onClick={() => setConfirm(r)}>Void</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="table-wrap desktop-only">
              <table className="data">
                <thead>
                  <tr>
                    <th aria-sort={ariaSort('advance_no')}><button className="th-btn" title="Sort by advance number" onClick={() => setSort('advance_no')}>Advance{sortMark('advance_no')}</button></th>
                    <th aria-sort={ariaSort('advance_date')}><button className="th-btn" title="Sort by date" onClick={() => setSort('advance_date')}>Date{sortMark('advance_date')}</button></th>
                    <th aria-sort={ariaSort('holder')}><button className="th-btn" title="Sort by holder" onClick={() => setSort('holder')}>Holder{sortMark('holder')}</button></th>
                    <th aria-sort={ariaSort('bank')}><button className="th-btn" title="Sort by source account" onClick={() => setSort('bank')}>Source{sortMark('bank')}</button></th>
                    <th className="cell-num" aria-sort={ariaSort('amount')}><button className="th-btn" title="Sort by amount" onClick={() => setSort('amount')}>Amount{sortMark('amount')}</button></th>
                    <th className="cell-num" aria-sort={ariaSort('outstanding')}><button className="th-btn" title="Sort by outstanding balance" onClick={() => setSort('outstanding')}>Outstanding{sortMark('outstanding')}</button></th>
                    <th aria-sort={ariaSort('purpose')}><button className="th-btn" title="Sort by purpose" onClick={() => setSort('purpose')}>Purpose{sortMark('purpose')}</button></th>
                    <th aria-sort={ariaSort('status')}><button className="th-btn" title="Sort by status" onClick={() => setSort('status')}>Status{sortMark('status')}</button></th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/finance/advances/${r.id}`)}>
                      <td className="cell-mono">{String(r.advanceNo)}</td>
                      <td>{String(r.advanceDate).slice(0, 10)}</td>
                      <td>{String(r.holderName ?? '')} {r.employeeId ? <span className="muted">(staff)</span> : null}</td>
                      <td><span className="cell-mono">{String(r.bankCode)}</span> <span className="muted">{String(r.bankName ?? '')}</span></td>
                      <td className="cell-num">{fmtMoney(r.baseAmount)} <span className="muted">UGX</span></td>
                      <td className="cell-num">{fmtMoney(r.outstanding)}</td>
                      <td title={String(r.purpose ?? '')}>{String(r.purpose ?? '') || '\u2014'}</td>
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
                </tbody>
              </table>
            </div>
          </>
        )}
        {!loading && <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={changePageSize} pageSizes={FIN_PAGE_SIZES} />}
      </section>
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
  const tiles: FinanceTile[] = [
    { href: '/finance/journals', label: 'Journals', hint: 'Double-entry workflow', perm: 'finance.journals.view' },
    { href: '/finance/posting-rules', label: 'Posting Rules', hint: 'Configurable accounting engine', perm: 'finance.posting_rules.view' },
    { href: '/finance/efris', label: 'EFRIS', hint: 'URA fiscal compliance', perm: 'finance.efris.view', perms: ['finance.efris.view', 'efris.transactions.view', 'efris.dashboard.view'] },
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
          {canAny(user, ['finance.efris.create', 'efris.transactions.submit']) && <button className="btn" onClick={() => navigate('/finance/efris')}>Fiscalize</button>}
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
        {tiles.filter((t) => (t.perms ? canAny(user, t.perms) : can(user, t.perm))).map((t) => (
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
type EfrisStatus = {
  configured: boolean; mode: string; active: boolean; fiscalizationEnabled: boolean;
  secretsResolvable: boolean; taxpayerStatus: string | null; environment: string | null;
  companyTinConfigured: boolean; openErrors: number; pendingTransactions: number;
  fiscalizedTransactions: number; failedTransactions: number;
  lastSuccessfulTransactionAt: string | null; message: string;
};

type EfrisRecon = {
  range: { from: string; to: string };
  generatedAt: string;
  erp: { invoiceCount: number; salesTotal: number; taxTotal: number };
  fiscal: {
    totalCount: number; fiscalizedCount: number; fiscalizedSalesTotal: number;
    fiscalizedTaxTotal: number; pendingCount: number; failedCount: number; cancelledCount: number;
  };
  reconciliation: {
    matchedInvoices: number; unreconciledInvoices: number;
    varianceSales: number; varianceTax: number; balanced: boolean;
  };
  alerts: {
    openErrors: number; errorsLast24h: number; hasFailedFiscalization: boolean;
    hasUnreconciledTransactions: boolean; hasFinanceVariance: boolean; connectionConfigured: boolean;
  };
};

const EFRIS_TABS = [
  ['txn', 'Transactions'],
  ['docs', 'Fiscal documents'],
  ['errors', 'Error centre'],
  ['recon', 'Reconciliation'],
  ['logs', 'Sync logs'],
  ['taxpayers', 'Taxpayers'],
  ['setup', 'Integration setup'],
] as const;

/** Mirrors the efris_taxpayers.efris_status CHECK constraint in migration 0142. */
const EFRIS_TAXPAYER_STATUSES = [
  'NOT_CONFIGURED', 'PENDING_REGISTRATION', 'REGISTERED', 'PENDING_INTEGRATION',
  'TESTING', 'ACTIVE', 'SUSPENDED', 'ERROR', 'DISABLED',
] as const;

/** Mirrors the efris_configurations.mode CHECK constraint. DISABLED is the safe default. */
const EFRIS_MODES = ['DISABLED', 'TEST', 'ACTIVE'] as const;

const EFRIS_TAXPAYER_TYPES = [
  'COMPANY', 'INDIVIDUAL', 'PARTNERSHIP', 'SOLE_PROPRIETOR', 'NGO', 'GOVERNMENT', 'OTHER',
] as const;

/** Name of the two server-side env keys the backend resolves pointer references against. */
const EFRIS_ENV_HINT = 'EFRIS_CLIENT_ID / EFRIS_CLIENT_SECRET';

function EfrisDesk() {
  type EfrisTabKey = 'txn' | 'docs' | 'errors' | 'recon' | 'logs' | 'taxpayers' | 'setup';
  type EfrisPanel = string;
  const { user } = useAuth();
  const [tab, setTab] = useState<EfrisTabKey>('txn');
  const [rows, setRows] = useState<Rec[]>([]);
  const [docs, setDocs] = useState<Rec[]>([]);
  const [logs, setLogs] = useState<Rec[]>([]);
  const [errs, setErrs] = useState<Rec[]>([]);
  const [status, setStatus] = useState<EfrisStatus | null>(null);
  const [recon, setRecon] = useState<EfrisRecon | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [resolveTarget, setResolveTarget] = useState<Rec | null>(null);
  const [openOnly, setOpenOnly] = useState(true);
  const [taxpayers, setTaxpayers] = useState<Rec[]>([]);
  const [configs, setConfigs] = useState<Rec[]>([]);
  const [taxpayerOpen, setTaxpayerOpen] = useState(false);
  const [taxpayerRow, setTaxpayerRow] = useState<Rec | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [configRow, setConfigRow] = useState<Rec | null>(null);
  const [formErr, setFormErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadFailures, setLoadFailures] = useState<Array<{ panel: EfrisPanel; message: string }>>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Every panel is fetched in parallel and every rejection is surfaced by name. The previous
  // version swallowed seven of these eight failures, so a broken panel just looked empty.
  const load = useCallback(() => {
    setRefreshing(true);
    const jobs: Array<[EfrisPanel, Promise<unknown>]> = [
      ['transactions', api<{ data: Rec[] }>('/api/ops/finance/efris').then((r) => setRows(r.data ?? []))],
      ['fiscal documents', api<{ data: Rec[] }>('/api/ops/finance/efris/documents').then((r) => setDocs(r.data ?? []))],
      ['sync logs', api<{ data: Rec[] }>('/api/ops/finance/efris/logs').then((r) => setLogs(r.data ?? []))],
      ['error centre', api<{ data: Rec[] }>('/api/ops/finance/efris/errors').then((r) => setErrs(r.data ?? []))],
      ['connection status', api<{ data: EfrisStatus }>('/api/ops/finance/efris/status').then((r) => setStatus(r.data ?? null))],
      ['reconciliation', api<{ data: EfrisRecon }>('/api/ops/finance/efris/reconciliation').then((r) => setRecon(r.data ?? null))],
      ['taxpayers', api<{ data: Rec[] }>('/api/ops/finance/efris/taxpayers').then((r) => setTaxpayers(r.data ?? []))],
      ['configurations', api<{ data: Rec[] }>('/api/ops/finance/efris/configurations').then((r) => setConfigs(r.data ?? []))],
    ];
    Promise.allSettled(jobs.map(([, job]) => job))
      .then((results) => {
        const failed: Array<{ panel: EfrisPanel; message: string }> = [];
        results.forEach((result, index) => {
          if (result.status !== 'rejected') return;
          const reason: unknown = result.reason;
          failed.push({ panel: jobs[index][0], message: reason instanceof Error ? reason.message : String(reason) });
        });
        setLoadFailures(failed);
      })
      .finally(() => { setRefreshing(false); setLoading(false); });
  }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (id: number, action: string, payload: Rec = {}) => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/finance/efris/${id}/${action}`, { method: 'POST', body: JSON.stringify(payload) });
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const errorAct = async (id: number, action: string, payload: Rec = {}) => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/finance/efris/errors/${id}/${action}`, { method: 'POST', body: JSON.stringify(payload) });
      setResolveTarget(null);
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

  // Taxpayer + configuration admin. Secrets are never posted: the API rejects them by
  // name, and the environment pointer keys are only sent when an admin actually types one.
  const saveTaxpayer = async (payload: Rec) => {
    setBusy(true); setFormErr('');
    try {
      const id = taxpayerRow ? Number(taxpayerRow.id) : null;
      if (id) await api(`/api/ops/finance/efris/taxpayers/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      else await api('/api/ops/finance/efris/taxpayers', { method: 'POST', body: JSON.stringify(payload) });
      setTaxpayerOpen(false); setTaxpayerRow(null);
      load();
    } catch (e) { setFormErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const saveConfiguration = async (payload: Rec) => {
    setBusy(true); setFormErr('');
    try {
      const id = configRow ? Number(configRow.id) : null;
      if (id) await api(`/api/ops/finance/efris/configurations/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      else await api('/api/ops/finance/efris/configurations', { method: 'POST', body: JSON.stringify(payload) });
      setConfigOpen(false); setConfigRow(null);
      load();
    } catch (e) { setFormErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const live = status?.fiscalizationEnabled === true;
  const visibleErrors = openOnly ? errs.filter((e) => !e.resolved) : errs;
  const canQueue = can(user, 'efris.transactions.retry') || can(user, 'finance.efris.sync');
  const canRetry = can(user, 'efris.errors.retry');
  const canArchive = can(user, 'efris.errors.archive');
  const canSubmit = can(user, 'efris.transactions.submit') || can(user, 'finance.efris.create');
  const canManageConfig = can(user, 'efris.configuration.manage');
  const canViewConfig = canManageConfig || can(user, 'efris.configuration.view');
  const visibleTabs = EFRIS_TABS.filter(([t]) => (t === 'taxpayers' || t === 'setup' ? canViewConfig : true));
  // Filtering, sorting and the shared chrome used by every data tab.
  const uniq = (values: unknown[]) => Array.from(new Set(values.map((v) => String(v ?? '').trim()).filter(Boolean))).sort();
  const failedPanel = (panel: EfrisPanel) => loadFailures.some((f) => f.panel === panel);
  const tabRows: Rec[] = tab === 'txn' ? rows
    : tab === 'docs' ? docs
      : tab === 'errors' ? visibleErrors
        : tab === 'logs' ? logs
          : tab === 'taxpayers' ? taxpayers
            : tab === 'setup' ? configs
              : [];
  const sourceCount = tab === 'errors' ? errs.length : tabRows.length;
  const stateOf = (r: Rec): string => tab === 'errors' ? (r.resolved ? 'RESOLVED' : 'OPEN')
    : tab === 'setup' ? String(r.mode ?? '')
      : tab === 'taxpayers' ? String(r.efrisStatus ?? '')
        : tab === 'docs' ? String(r.txnStatus ?? '')
          : String(r.status ?? '');
  const typeOf = (r: Rec): string => tab === 'txn' ? String(r.docType ?? '')
    : tab === 'taxpayers' ? String(r.taxpayerType ?? '')
      : tab === 'errors' ? String(r.stage ?? '')
        : '';
  const haystack = (r: Rec): string => {
    const parts: unknown[] = tab === 'txn'
      ? [r.docRefCode, r.docType, r.status, r.currency, r.fdn, r.verificationCode, r.errorCode, r.lastError]
      : tab === 'docs'
        ? [r.erpDocNo, r.docRefCode, r.fdn, r.verificationCode, r.qrRef, r.txnStatus]
        : tab === 'errors'
          ? [r.stage, r.docRefCode, r.errorCode, r.errorMessage]
          : tab === 'logs'
            ? [r.docRefCode, r.status, r.error]
            : tab === 'taxpayers'
              ? [r.code, r.legalName, r.tradingName, r.tin, r.vatNumber, r.taxpayerType, r.placeOfBusiness, r.branchName, r.efrisStatus]
              : tab === 'setup'
                ? [r.code, r.name, r.taxpayerLegalName, r.taxpayerTin, r.mode]
                : [];
    return parts.map((p) => String(p ?? '')).join(' ').toLowerCase();
  };
  const term = search.trim().toLowerCase();
  const filtered = tabRows.filter((r) => {
    if (statusFilter && stateOf(r) !== statusFilter) return false;
    if (typeFilter && typeOf(r) !== typeFilter) return false;
    if (!term) return true;
    return haystack(r).includes(term);
  });
  const SORTS_BY_TAB: Record<EfrisTabKey, Record<string, (r: Rec) => string | number>> = {
    txn: {
      ref: (r) => String(r.docRefCode ?? ''), type: (r) => String(r.docType ?? ''), date: (r) => String(r.txnDate ?? ''),
      gross: (r) => Number(r.grossAmount ?? 0), tax: (r) => Number(r.taxAmount ?? 0), status: (r) => String(r.status ?? ''),
    },
    docs: {
      doc: (r) => String(r.erpDocNo ?? r.docRefCode ?? ''), fdn: (r) => String(r.fdn ?? ''),
      status: (r) => String(r.txnStatus ?? ''), fiscalized: (r) => String(r.fiscalizedAt ?? ''),
    },
    errors: {
      time: (r) => String(r.createdAt ?? ''), stage: (r) => String(r.stage ?? ''), ref: (r) => String(r.docRefCode ?? ''),
      code: (r) => String(r.errorCode ?? ''), retries: (r) => Number(r.retryCount ?? 0), state: (r) => (r.resolved ? 1 : 0),
    },
    recon: {},
    logs: { time: (r) => String(r.createdAt ?? ''), ref: (r) => String(r.docRefCode ?? ''), status: (r) => String(r.status ?? '') },
    taxpayers: {
      code: (r) => String(r.code ?? ''), name: (r) => String(r.legalName ?? ''), tin: (r) => String(r.tin ?? ''),
      type: (r) => String(r.taxpayerType ?? ''), status: (r) => String(r.efrisStatus ?? ''),
    },
    setup: {
      code: (r) => String(r.code ?? ''), name: (r) => String(r.name ?? ''), mode: (r) => String(r.mode ?? ''),
      active: (r) => (r.isActive ? 1 : 0), duplicate: (r) => Number(r.duplicateWindowSeconds ?? 0),
    },
  };
  const SORT_LABELS_BY_TAB: Record<EfrisTabKey, Record<string, string>> = {
    txn: { ref: 'Ref', type: 'Type', date: 'Date', gross: 'Gross', tax: 'Tax', status: 'Status' },
    docs: { doc: 'ERP document', fdn: 'FDN', status: 'Status', fiscalized: 'Fiscalized at' },
    errors: { time: 'Time', stage: 'Stage', ref: 'Reference', code: 'Code', retries: 'Retries', state: 'State' },
    recon: {},
    logs: { time: 'Time', ref: 'Reference', status: 'Status' },
    taxpayers: { code: 'Code', name: 'Legal name', tin: 'TIN', type: 'Type', status: 'Registration' },
    setup: { code: 'Code', name: 'Name', mode: 'Mode', active: 'Active', duplicate: 'Duplicate window' },
  };
  const activeSorts = SORTS_BY_TAB[tab];
  const SORT_LABELS = SORT_LABELS_BY_TAB[tab];
  const visible = sortBy && activeSorts[sortBy]
    ? [...filtered].sort((a, b) => {
        const av = activeSorts[sortBy](a); const bv = activeSorts[sortBy](b);
        const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : filtered;
  const setSort = (col: string) => {
    if (sortBy !== col) { setSortBy(col); setSortDir('asc'); return; }
    if (sortDir === 'asc') { setSortDir('desc'); return; }
    setSortBy('');
  };
  const sortMark = (col: string) => (sortBy === col ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : '');
  const ariaSort = (col: string): 'ascending' | 'descending' | undefined => (sortBy === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined);
  const statusOptions: string[] = tab === 'setup' ? [...EFRIS_MODES]
    : tab === 'taxpayers' ? [...EFRIS_TAXPAYER_STATUSES]
      : tab === 'errors' ? ['OPEN', 'RESOLVED']
        : tab === 'docs' ? uniq(docs.map((r) => r.txnStatus))
          : tab === 'logs' ? uniq(logs.map((r) => r.status))
            : tab === 'txn' ? uniq(rows.map((r) => r.status))
              : [];
  const typeOptions: string[] = tab === 'taxpayers' ? [...EFRIS_TAXPAYER_TYPES]
    : tab === 'errors' ? uniq(errs.map((r) => r.stage))
      : tab === 'txn' ? uniq(rows.map((r) => r.docType))
        : [];
  const statusFilterName = tab === 'setup' ? 'Configuration mode'
    : tab === 'taxpayers' ? 'Registration'
      : tab === 'errors' ? 'State'
        : tab === 'docs' ? 'Document status'
          : tab === 'logs' ? 'Log status' : 'Status';
  const statusFilterLabel = `Filter by ${statusFilterName.toLowerCase()}`;
  const statusFilterPlaceholder = tab === 'setup' ? 'All modes' : tab === 'taxpayers' ? 'All registrations' : tab === 'errors' ? 'All states' : 'All statuses';
  const typeFilterName = tab === 'taxpayers' ? 'Taxpayer type' : tab === 'errors' ? 'Stage' : 'Document type';
  const typeFilterLabel = `Filter by ${typeFilterName.toLowerCase()}`;
  const typeFilterPlaceholder = tab === 'errors' ? 'All stages' : 'All types';
  const searchPlaceholder = tab === 'txn' ? 'Search reference, type or error...'
    : tab === 'docs' ? 'Search ERP document, FDN or verification code...'
      : tab === 'errors' ? 'Search stage, reference or message...'
        : tab === 'logs' ? 'Search reference, status or error...'
          : tab === 'taxpayers' ? 'Search code, name or TIN...'
            : tab === 'setup' ? 'Search code, name or taxpayer...' : 'Search...';
  const searchLabel = tab === 'txn' ? 'Search transactions'
    : tab === 'docs' ? 'Search fiscal documents'
      : tab === 'errors' ? 'Search errors'
        : tab === 'logs' ? 'Search sync logs'
          : tab === 'taxpayers' ? 'Search taxpayers'
            : tab === 'setup' ? 'Search configurations' : 'Search';
  const hasFilters = Boolean(term || statusFilter || typeFilter || (tab === 'errors' && !openOnly));
  const clearFilters = () => {
    setSearch(''); setStatusFilter(''); setTypeFilter(''); setSortBy('');
    if (tab === 'errors') setOpenOnly(true);
  };
  const activeFilters: Array<{ key: string; label: string; value: string }> = [];
  if (search.trim()) activeFilters.push({ key: 'q', label: 'Search', value: search.trim() });
  if (statusFilter) activeFilters.push({ key: 'status', label: statusFilterName, value: statusFilter.replace(/_/g, ' ') });
  if (typeFilter) activeFilters.push({ key: 'type', label: typeFilterName, value: typeFilter.replace(/_/g, ' ') });
  if (tab === 'errors' && !openOnly) activeFilters.push({ key: 'open', label: 'Show', value: 'Open only' });
  const removeFilter = (key: string) => {
    if (key === 'q') setSearch('');
    if (key === 'status') setStatusFilter('');
    if (key === 'type') setTypeFilter('');
    if (key === 'open') setOpenOnly(true);
  };
  const countSuffix = filtered.length === sourceCount ? '' : ` of ${sourceCount.toLocaleString()}`;
  const statusNote = sortBy
    ? `Sorted by ${SORT_LABELS[sortBy] ?? sortBy} (${sortDir === 'asc' ? 'ascending' : 'descending'})`
    : filtered.length === sourceCount ? '' : `${filtered.length.toLocaleString()} of ${sourceCount.toLocaleString()} shown`;
  const switchTab = (next: EfrisTabKey) => {
    setTab(next); setSearch(''); setStatusFilter(''); setTypeFilter(''); setSortBy(''); setSortDir('asc');
  };
  const chips = activeFilters.length > 0 || sortBy ? (
    <div className="filter-chips" style={{ padding: '12px 0 0' }}>
      {activeFilters.map((f) => (
        <span key={f.key} className="filter-chip">
          <b>{f.label}</b>{f.value ? `: ${f.value}` : ''}
          <button type="button" title="Remove filter" aria-label={`Remove ${f.label} filter`} onClick={() => removeFilter(f.key)}>{'\u00D7'}</button>
        </span>
      ))}
      {sortBy && (
        <span className="filter-chip">
          <b>Sort</b>{`: ${SORT_LABELS[sortBy] ?? sortBy} ${sortDir === 'asc' ? 'ascending' : 'descending'}`}
          <button type="button" title="Clear sort" aria-label="Clear sort" onClick={() => setSortBy('')}>{'\u00D7'}</button>
        </span>
      )}
      <button className="btn btn-sm btn-ghost" onClick={clearFilters}>Clear all</button>
    </div>
  ) : null;

  const loadNote = loadFailures.length > 0 ? (
    <div className="card card-pad card-warn" role="status" aria-live="polite" style={{ marginBottom: 14 }}>
      <h3 style={{ marginTop: 0 }}>Could not load {loadFailures.length === 1 ? '1 panel' : `${loadFailures.length} panels`}</h3>
      <p className="muted" style={{ margin: '6px 0' }}>{loadFailures.map((f) => `${f.panel}: ${f.message}`).join(' \u00B7 ')}</p>
      <p className="muted" style={{ marginBottom: 10 }}>Everything else on this screen is showing what the server last returned.</p>
      <button className="btn btn-sm" disabled={refreshing} onClick={load}>{refreshing ? 'Retrying\u2026' : 'Retry'}</button>
    </div>
  ) : null;

  const filterCard = (
    <div className="card card-pad" style={{ marginBottom: 14 }}>
      <div className="toolbar" style={{ marginBottom: hasFilters || sortBy ? 10 : 0 }}>
        <input className="search-input" type="search" value={search} aria-label={searchLabel} placeholder={searchPlaceholder} onChange={(e) => setSearch(e.target.value)} />
        {statusOptions.length > 0 && <StatusSelect value={statusFilter} onChange={setStatusFilter} options={statusOptions} label={statusFilterLabel} placeholder={statusFilterPlaceholder} />}
        {typeOptions.length > 0 && <StatusSelect value={typeFilter} onChange={setTypeFilter} options={typeOptions} label={typeFilterLabel} placeholder={typeFilterPlaceholder} />}
        {tab === 'errors' && (
          <button type="button" className={openOnly ? 'chip chip-on' : 'chip'} aria-pressed={openOnly} title="Hide resolved errors" onClick={() => setOpenOnly(!openOnly)}>Open only</button>
        )}
        {hasFilters && <button className="btn btn-sm btn-ghost" onClick={clearFilters}>Clear filters</button>}
      </div>
      {chips}
    </div>
  );

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">URA EFRIS</p>
          <h1>Fiscal compliance</h1>
          <p className="muted">
            ERP records and URA fiscal documents stay linked but separate. A transaction is only fiscalized after URA
            returns a fiscal document number and verification code {'\u2014'} the ERP never marks a document fiscalized on its own.
          </p>
        </div>
        <div className="head-actions">
          <button className="btn" disabled={refreshing} onClick={load} title="Re-read every EFRIS panel from the server">{refreshing ? 'Refreshing\u2026' : 'Refresh'}</button>
          {canSubmit && <button className="btn btn-primary" disabled={!live} title={live ? '' : 'EFRIS is not enabled for this company'} onClick={() => setRegisterOpen(true)}>Register document</button>}
        </div>
      </header>

      {error && <ErrorBanner error={error} />}
      {loadNote}

      {status && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <h3>URA connection</h3>
            <Badge value={live ? 'ACTIVE' : status.configured ? status.mode : 'NOT_CONFIGURED'} />
          </div>
          <div className="kpi-grid" style={{ marginBottom: 0 }}>
            <div className={`kpi-card${live ? '' : ' card-warn'}`}>
              <span className="kpi-label">Fiscalization</span>
              <span className={`kpi-value${live ? ' kpi-ok' : ' kpi-warn'}`}>{live ? 'Live' : status.configured ? 'Off' : 'Not set up'}</span>
              <span className="kpi-sub">{live ? 'Documents are sent to URA on submit' : 'Postings stay local until EFRIS is enabled'}</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Taxpayer</span>
              <span className="kpi-value" style={{ fontSize: 18 }}>{String(status.taxpayerStatus ?? 'NOT_CONFIGURED').replace(/_/g, ' ')}</span>
              <span className="kpi-sub">{status.companyTinConfigured ? 'TIN on file' : 'No TIN on file'}</span>
            </div>
            <div className={`kpi-card${status.secretsResolvable ? '' : ' card-warn'}`}>
              <span className="kpi-label">URA credentials</span>
              <span className={`kpi-value${status.secretsResolvable ? ' kpi-ok' : ' kpi-warn'}`} style={{ fontSize: 18 }}>{status.secretsResolvable ? 'Resolvable' : 'Missing'}</span>
              <span className="kpi-sub">{EFRIS_ENV_HINT}</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Pending</span>
              <span className="kpi-value">{fmtNum(status.pendingTransactions)}</span>
              <span className="kpi-sub">waiting to be fiscalized</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Fiscalized</span>
              <span className="kpi-value kpi-ok">{fmtNum(status.fiscalizedTransactions)}</span>
              <span className="kpi-sub">accepted by URA</span>
            </div>
            <div className={`kpi-card${status.failedTransactions > 0 ? ' card-warn' : ''}`}>
              <span className="kpi-label">Failed</span>
              <span className={`kpi-value${status.failedTransactions > 0 ? ' kpi-warn' : ''}`}>{fmtNum(status.failedTransactions)}</span>
              <span className="kpi-sub">{status.failedTransactions > 0 ? 'needs attention' : 'nothing rejected'}</span>
            </div>
            <div className={`kpi-card${status.openErrors > 0 ? ' card-warn' : ''}`}>
              <span className="kpi-label">Open errors</span>
              <span className={`kpi-value${status.openErrors > 0 ? ' kpi-warn' : ''}`}>{fmtNum(status.openErrors)}</span>
              <span className="kpi-sub">{status.openErrors > 0 ? 'see the error centre' : 'error centre is clear'}</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Last successful</span>
              <span className="kpi-value" style={{ fontSize: 15 }}>{status.lastSuccessfulTransactionAt ? String(status.lastSuccessfulTransactionAt).slice(0, 19).replace('T', ' ') : '\u2014'}</span>
              <span className="kpi-sub">most recent URA acceptance</span>
            </div>
          </div>
          {status.message && <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>{status.message}</p>}
        </div>
      )}

      <div className="tabs" style={{ marginBottom: 16 }}>
        {visibleTabs.map(([t, label]) => (
          <button key={t} className={tab === t ? 'tab active' : 'tab'} aria-current={tab === t ? 'page' : undefined} onClick={() => switchTab(t)}>
            {label}{t === 'errors' && errs.some((e) => !e.resolved) ? ` (${errs.filter((e) => !e.resolved).length})` : ''}
          </button>
        ))}
      </div>
      {tab === 'txn' && (
        <>
          {filterCard}
          <section className={`card card-pad${refreshing && !loading ? ' is-refreshing' : ''}`} aria-busy={refreshing && !loading}>
            <div className="card-head">
              <div>
                <h3>Transactions ({filtered.length.toLocaleString()}{countSuffix})</h3>
                <p className="muted" style={{ margin: 0 }}>A row is fiscalized only when URA returns an FDN and verification code. Queue a pending row to send it.</p>
              </div>
              {!loading && statusNote && <span className="muted" style={{ fontSize: 12 }} role="status" aria-live="polite">{statusNote}</span>}
            </div>
            {loading ? <Skeleton rows={6} /> : failedPanel('transactions') ? (
              <EmptyState title="Transactions could not load" body="The server did not return this panel. Retry to ask again." action="Retry" onAction={load} />
            ) : sourceCount === 0 ? (
              <EmptyState title="No EFRIS transactions yet" body="Register a posted invoice to send it to URA for fiscalization."
                action={canSubmit && live ? 'Register document' : undefined} onAction={() => setRegisterOpen(true)} />
            ) : filtered.length === 0 ? (
              <EmptyState title="No transactions match these filters"
                body={term ? `Nothing matches "${search.trim()}" with the other filters applied.` : 'Nothing matches the current filters.'}
                action="Clear filters" onAction={clearFilters} />
            ) : (
              <>
                <div className="record-cards mobile-only">
                  {visible.map((r) => (
                    <div key={`card-${String(r.id)}`} className="record-card">
                      <div className="record-card-top">
                        <strong className="cell-mono">{String(r.docRefCode ?? '')}</strong>
                        <Badge value={r.status} />
                      </div>
                      <div className="record-card-meta">
                        <span>{String(r.docType ?? '').replace(/_/g, ' ')}</span>
                        <span>{String(r.txnDate ?? '').slice(0, 10)}</span>
                        <span>{String(r.currency ?? '')}</span>
                        <span>{fmtMoney(r.grossAmount)}</span>
                        <span>tax {fmtMoney(r.taxAmount)}</span>
                      </div>
                      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                        {r.fdn ? `${String(r.fdn)}${r.verificationCode ? ` / ${String(r.verificationCode)}` : ''}` : r.errorCode ? String(r.errorCode) : 'Not sent to URA yet'}
                      </div>
                      {(canQueue || can(user, 'finance.efris.cancel')) && (
                        <div className="row-actions" style={{ marginTop: 8 }}>
                          {canQueue && ['PENDING', 'QUEUED', 'TRANSMITTED', 'RETRYING', 'FAILED'].includes(String(r.status)) && <button className="btn btn-sm" disabled={busy} onClick={() => act(Number(r.id), 'sync')}>Queue</button>}
                          {can(user, 'finance.efris.cancel') && ['PENDING', 'QUEUED', 'FAILED', 'RETRYING'].includes(String(r.status)) && <button className="btn btn-sm" disabled={busy} onClick={() => act(Number(r.id), 'cancel', { reason: 'Cancelled in ERP' })}>Cancel</button>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="table-wrap desktop-only">
                  <table className="data">
                    <thead>
                      <tr>
                        <th aria-sort={ariaSort('ref')}><button className="th-btn" title="Sort by reference" onClick={() => setSort('ref')}>Ref{sortMark('ref')}</button></th>
                        <th aria-sort={ariaSort('type')}><button className="th-btn" title="Sort by document type" onClick={() => setSort('type')}>Type{sortMark('type')}</button></th>
                        <th aria-sort={ariaSort('date')}><button className="th-btn" title="Sort by date" onClick={() => setSort('date')}>Date{sortMark('date')}</button></th>
                        <th>Currency</th>
                        <th className="cell-num" aria-sort={ariaSort('gross')}><button className="th-btn" title="Sort by gross amount" onClick={() => setSort('gross')}>Gross{sortMark('gross')}</button></th>
                        <th className="cell-num" aria-sort={ariaSort('tax')}><button className="th-btn" title="Sort by tax amount" onClick={() => setSort('tax')}>Tax{sortMark('tax')}</button></th>
                        <th aria-sort={ariaSort('status')}><button className="th-btn" title="Sort by status" onClick={() => setSort('status')}>Status{sortMark('status')}</button></th>
                        <th>FDN / VRC</th>
                        <th>Last error</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((r) => (
                        <tr key={String(r.id)} className={String(r.status) === 'FAILED' ? 'row-warn' : undefined}>
                          <td className="cell-mono">{String(r.docRefCode)}</td>
                          <td>{String(r.docType)}</td>
                          <td>{String(r.txnDate).slice(0, 10)}</td>
                          <td>{String(r.currency)}</td>
                          <td className="cell-num">{fmtMoney(r.grossAmount)}</td>
                          <td className="cell-num">{fmtMoney(r.taxAmount)}</td>
                          <td><Badge value={r.status} /></td>
                          <td className="cell-mono">{r.fdn ? `${String(r.fdn)}${r.verificationCode ? ` / ${String(r.verificationCode)}` : ''}` : '\u2014'}</td>
                          <td className="muted">{r.errorCode ? String(r.errorCode) : r.lastError ? String(r.lastError).slice(0, 60) : '\u2014'}</td>
                          <td>
                            <div className="row-actions">
                              {canQueue && ['PENDING', 'QUEUED', 'TRANSMITTED', 'RETRYING', 'FAILED'].includes(String(r.status)) && <button className="btn btn-sm" disabled={busy} onClick={() => act(Number(r.id), 'sync')}>Queue for fiscalization</button>}
                              {can(user, 'finance.efris.cancel') && ['PENDING', 'QUEUED', 'FAILED', 'RETRYING'].includes(String(r.status)) && <button className="btn btn-sm" disabled={busy} onClick={() => act(Number(r.id), 'cancel', { reason: 'Cancelled in ERP' })}>Cancel</button>}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </>
      )}
      {tab === 'docs' && (
        <>
          {filterCard}
          <section className={`card card-pad${refreshing && !loading ? ' is-refreshing' : ''}`} aria-busy={refreshing && !loading}>
            <div className="card-head">
              <div>
                <h3>Fiscal documents ({filtered.length.toLocaleString()}{countSuffix})</h3>
                <p className="muted" style={{ margin: 0 }}>Fiscal documents issued by URA, matched to the ERP document that produced them.</p>
              </div>
              {!loading && statusNote && <span className="muted" style={{ fontSize: 12 }} role="status" aria-live="polite">{statusNote}</span>}
            </div>
            {loading ? <Skeleton rows={6} /> : failedPanel('fiscal documents') ? (
              <EmptyState title="Fiscal documents could not load" body="The server did not return this panel. Retry to ask again." action="Retry" onAction={load} />
            ) : sourceCount === 0 ? (
              <EmptyState title="No fiscal documents yet" body="URA has not issued a fiscal document for this company. Fiscalize a transaction to create one." />
            ) : filtered.length === 0 ? (
              <EmptyState title="No documents match these filters"
                body={term ? `Nothing matches "${search.trim()}" with the other filters applied.` : 'Nothing matches the current filters.'}
                action="Clear filters" onAction={clearFilters} />
            ) : (
              <>
                <div className="record-cards mobile-only">
                  {visible.map((r) => (
                    <div key={`card-${String(r.id)}`} className="record-card">
                      <div className="record-card-top">
                        <strong className="cell-mono">{String(r.erpDocNo ?? r.docRefCode ?? '')}</strong>
                        <Badge value={r.txnStatus} />
                      </div>
                      <div className="record-card-meta">
                        <span>FDN {r.fdn ? String(r.fdn) : '\u2014'}</span>
                        <span>VRC {r.verificationCode ? String(r.verificationCode) : '\u2014'}</span>
                      </div>
                      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                        {r.fiscalizedAt ? `Fiscalized ${String(r.fiscalizedAt).slice(0, 19).replace('T', ' ')}` : r.transmittedAt ? `Sent ${String(r.transmittedAt).slice(0, 19).replace('T', ' ')}` : 'Not yet sent to URA'}
                      </div>
                      {r.qrRef ? <div className="muted cell-mono" style={{ fontSize: 12, marginTop: 4 }}>QR {String(r.qrRef)}</div> : null}
                    </div>
                  ))}
                </div>
                <div className="table-wrap desktop-only">
                  <table className="data">
                    <thead>
                      <tr>
                        <th aria-sort={ariaSort('doc')}><button className="th-btn" title="Sort by ERP document" onClick={() => setSort('doc')}>ERP document{sortMark('doc')}</button></th>
                        <th aria-sort={ariaSort('fdn')}><button className="th-btn" title="Sort by fiscal document number" onClick={() => setSort('fdn')}>FDN{sortMark('fdn')}</button></th>
                        <th>Verification code</th>
                        <th>Fiscal QR ref</th>
                        <th aria-sort={ariaSort('status')}><button className="th-btn" title="Sort by status" onClick={() => setSort('status')}>Status{sortMark('status')}</button></th>
                        <th aria-sort={ariaSort('fiscalized')}><button className="th-btn" title="Sort by fiscalized time" onClick={() => setSort('fiscalized')}>Fiscalized at{sortMark('fiscalized')}</button></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((r) => (
                        <tr key={String(r.id)}>
                          <td className="cell-mono">{String(r.erpDocNo ?? r.docRefCode ?? '')}</td>
                          <td className="cell-mono">{r.fdn ? String(r.fdn) : '\u2014'}</td>
                          <td className="cell-mono">{r.verificationCode ? String(r.verificationCode) : '\u2014'}</td>
                          <td className="cell-mono">{r.qrRef ? String(r.qrRef) : '\u2014'}</td>
                          <td><Badge value={r.txnStatus} /></td>
                          <td>{r.fiscalizedAt ? String(r.fiscalizedAt).slice(0, 19).replace('T', ' ') : r.transmittedAt ? `sent ${String(r.transmittedAt).slice(0, 19).replace('T', ' ')}` : '\u2014'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </>
      )}
      {tab === 'errors' && (
        <>
          {filterCard}
          <section className={`card card-pad${refreshing && !loading ? ' is-refreshing' : ''}`} aria-busy={refreshing && !loading}>
            <div className="card-head">
              <div>
                <h3>EFRIS error centre ({filtered.length.toLocaleString()}{countSuffix})</h3>
                <p className="muted" style={{ margin: 0 }}>Rejections and failures returned by URA. Retry a row, or resolve it with a written reason.</p>
              </div>
              {!loading && statusNote && <span className="muted" style={{ fontSize: 12 }} role="status" aria-live="polite">{statusNote}</span>}
            </div>
            {loading ? <Skeleton rows={6} /> : failedPanel('error centre') ? (
              <EmptyState title="The error centre could not load" body="The server did not return this panel. Retry to ask again." action="Retry" onAction={load} />
            ) : sourceCount === 0 ? (
              <EmptyState title="No EFRIS errors recorded" body="URA has not rejected anything for this company. Errors appear here the moment a submission fails." />
            ) : filtered.length === 0 ? (
              <EmptyState title="No errors match these filters"
                body={`${term ? `Nothing matches "${search.trim()}" with the other filters applied. ` : 'Nothing matches the current filters. '}${openOnly ? '' : 'Uncheck Open only to include resolved errors.'}`.trim()}
                action="Clear filters" onAction={clearFilters} />
            ) : (
              <>
                <div className="record-cards mobile-only">
                  {visible.map((r) => (
                    <div key={`card-${String(r.id)}`} className="record-card">
                      <div className="record-card-top">
                        <strong className="cell-mono">{String(r.errorCode)}</strong>
                        {r.resolved ? <Badge value="RESOLVED" /> : <Badge value="FAILED" />}
                      </div>
                      <div>{String(r.errorMessage ?? '').slice(0, 140)}</div>
                      <div className="record-card-meta">
                        <span>{String(r.createdAt ?? '').slice(0, 19).replace('T', ' ')}</span>
                        <span>{String(r.stage)}</span>
                        <span className="cell-mono">{String(r.docRefCode ?? '')}</span>
                        <span>{String(r.retryCount ?? 0)} retries</span>
                      </div>
                      {(canRetry || canArchive) && (
                        <div className="row-actions" style={{ marginTop: 8 }}>
                          {!r.resolved && canRetry && <button className="btn btn-sm" disabled={busy} onClick={() => errorAct(Number(r.id), 'retry', {})}>Retry</button>}
                          {!r.resolved && canArchive && <button className="btn btn-sm" disabled={busy} onClick={() => setResolveTarget(r)}>Resolve</button>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="table-wrap desktop-only">
                  <table className="data">
                    <thead>
                      <tr>
                        <th aria-sort={ariaSort('time')}><button className="th-btn" title="Sort by time" onClick={() => setSort('time')}>Time{sortMark('time')}</button></th>
                        <th aria-sort={ariaSort('stage')}><button className="th-btn" title="Sort by stage" onClick={() => setSort('stage')}>Stage{sortMark('stage')}</button></th>
                        <th aria-sort={ariaSort('ref')}><button className="th-btn" title="Sort by reference" onClick={() => setSort('ref')}>Reference{sortMark('ref')}</button></th>
                        <th aria-sort={ariaSort('code')}><button className="th-btn" title="Sort by error code" onClick={() => setSort('code')}>Code{sortMark('code')}</button></th>
                        <th>Message</th>
                        <th className="cell-num" aria-sort={ariaSort('retries')}><button className="th-btn" title="Sort by retries" onClick={() => setSort('retries')}>Retries{sortMark('retries')}</button></th>
                        <th aria-sort={ariaSort('state')}><button className="th-btn" title="Sort by state" onClick={() => setSort('state')}>State{sortMark('state')}</button></th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((r) => (
                        <tr key={String(r.id)} className={r.resolved ? undefined : 'row-warn'}>
                          <td>{String(r.createdAt ?? '').slice(0, 19).replace('T', ' ')}</td>
                          <td>{String(r.stage)}</td>
                          <td className="cell-mono">{String(r.docRefCode ?? '')}</td>
                          <td className="cell-mono">{String(r.errorCode)}</td>
                          <td>{String(r.errorMessage ?? '').slice(0, 90)}</td>
                          <td className="cell-num">{String(r.retryCount ?? 0)}</td>
                          <td>{r.resolved ? <Badge value="RESOLVED" /> : <Badge value="FAILED" />}</td>
                          <td>
                            <div className="row-actions">
                              {!r.resolved && canRetry && <button className="btn btn-sm" disabled={busy} onClick={() => errorAct(Number(r.id), 'retry', {})}>Retry</button>}
                              {!r.resolved && canArchive && <button className="btn btn-sm" disabled={busy} onClick={() => setResolveTarget(r)}>Resolve</button>}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </>
      )}
      {tab === 'recon' && (
        <section className={`card card-pad${refreshing && !loading ? ' is-refreshing' : ''}`} aria-busy={refreshing && !loading}>
          <div className="card-head">
            <div>
              <h3>Reconciliation</h3>
              {recon && <p className="muted" style={{ margin: 0 }}>ERP postings against URA fiscal documents for window {recon.range.from} to {recon.range.to}.</p>}
            </div>
            {recon && <span className="muted" style={{ fontSize: 12 }} role="status" aria-live="polite">Generated {String(recon.generatedAt).slice(0, 19).replace('T', ' ')}</span>}
          </div>
          {loading ? <Skeleton rows={4} /> : !recon ? (
            failedPanel('reconciliation') ? (
              <EmptyState title="Reconciliation could not load" body="The server did not return this panel. Retry to ask again." action="Retry" onAction={load} />
            ) : (
              <EmptyState title="Reconciliation is not available yet" body="The window is built from fiscalized transactions. It appears once EFRIS has data for this company." />
            )
          ) : (
            <>
              <div className="kpi-grid">
                <div className="kpi-card"><span className="kpi-label">ERP invoices</span><span className="kpi-value">{fmtNum(recon.erp.invoiceCount)}</span><span className="kpi-sub">{fmtMoney(recon.erp.salesTotal)}</span></div>
                <div className="kpi-card"><span className="kpi-label">Fiscalized</span><span className="kpi-value kpi-ok">{fmtNum(recon.fiscal.fiscalizedCount)}</span><span className="kpi-sub">{fmtMoney(recon.fiscal.fiscalizedSalesTotal)}</span></div>
                <div className="kpi-card"><span className="kpi-label">Pending</span><span className="kpi-value">{fmtNum(recon.fiscal.pendingCount)}</span><span className="kpi-sub">awaiting URA</span></div>
                <div className={`kpi-card${recon.fiscal.failedCount > 0 ? ' card-warn' : ''}`}><span className="kpi-label">Failed</span><span className={`kpi-value${recon.fiscal.failedCount > 0 ? ' kpi-warn' : ''}`}>{fmtNum(recon.fiscal.failedCount)}</span><span className="kpi-sub">{fmtNum(recon.alerts.openErrors)} open errors</span></div>
                <div className={`kpi-card${recon.reconciliation.varianceSales !== 0 || recon.reconciliation.varianceTax !== 0 ? ' card-warn' : ''}`}><span className="kpi-label">Sales variance</span><span className="kpi-value">{fmtMoney(recon.reconciliation.varianceSales)}</span><span className="kpi-sub">tax {fmtMoney(recon.reconciliation.varianceTax)}</span></div>
                <div className={`kpi-card${recon.reconciliation.unreconciledInvoices ? ' card-warn' : ''}`}><span className="kpi-label">Unreconciled invoices</span><span className="kpi-value">{fmtNum(recon.reconciliation.unreconciledInvoices)}</span><span className="kpi-sub">{fmtNum(recon.reconciliation.matchedInvoices)} matched</span></div>
              </div>
              <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {recon.alerts.hasFailedFiscalization && <Badge value="FAILED" />}
                {recon.alerts.hasUnreconciledTransactions && <Badge value="WARNING" />}
                {recon.alerts.hasFinanceVariance && <Badge value="WARNING" />}
                {recon.reconciliation.balanced && <Badge value="BALANCED" />}
                {!recon.alerts.connectionConfigured && <Badge value="DISABLED" />}
              </div>
            </>
          )}
        </section>
      )}
      {tab === 'logs' && (
        <>
          {filterCard}
          <section className={`card card-pad${refreshing && !loading ? ' is-refreshing' : ''}`} aria-busy={refreshing && !loading}>
            <div className="card-head">
              <div>
                <h3>Sync logs ({filtered.length.toLocaleString()}{countSuffix})</h3>
                <p className="muted" style={{ margin: 0 }}>Every request and response exchanged with URA. The request column shows the payload the ERP sent.</p>
              </div>
              {!loading && statusNote && <span className="muted" style={{ fontSize: 12 }} role="status" aria-live="polite">{statusNote}</span>}
            </div>
            {loading ? <Skeleton rows={6} /> : failedPanel('sync logs') ? (
              <EmptyState title="Sync logs could not load" body="The server did not return this panel. Retry to ask again." action="Retry" onAction={load} />
            ) : sourceCount === 0 ? (
              <EmptyState title="No sync attempts yet" body="Nothing has been sent to URA. Attempts appear here as soon as a transaction is queued." />
            ) : filtered.length === 0 ? (
              <EmptyState title="No log entries match these filters"
                body={term ? `Nothing matches "${search.trim()}" with the other filters applied.` : 'Nothing matches the current filters.'}
                action="Clear filters" onAction={clearFilters} />
            ) : (
              <>
                <div className="record-cards mobile-only">
                  {visible.map((r) => (
                    <div key={`card-${String(r.id)}`} className={`record-card${r.error ? ' card-warn' : ''}`}>
                      <div className="record-card-top">
                        <strong className="cell-mono">{String(r.docRefCode ?? '')}</strong>
                        <Badge value={r.status} />
                      </div>
                      <div className="record-card-meta">
                        <span>{String(r.createdAt ?? '').slice(0, 19).replace('T', ' ')}</span>
                      </div>
                      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                        {r.error ? String(r.error).slice(0, 140) : r.requestPayload ? JSON.stringify(r.requestPayload).slice(0, 140) : 'No error recorded'}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="table-wrap desktop-only">
                  <table className="data">
                    <thead>
                      <tr>
                        <th aria-sort={ariaSort('time')}><button className="th-btn" title="Sort by time" onClick={() => setSort('time')}>Time{sortMark('time')}</button></th>
                        <th aria-sort={ariaSort('ref')}><button className="th-btn" title="Sort by reference" onClick={() => setSort('ref')}>Reference{sortMark('ref')}</button></th>
                        <th aria-sort={ariaSort('status')}><button className="th-btn" title="Sort by status" onClick={() => setSort('status')}>Status{sortMark('status')}</button></th>
                        <th>Error</th>
                        <th>Request</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((r) => (
                        <tr key={String(r.id)} className={r.error ? 'row-warn' : undefined}>
                          <td>{String(r.createdAt ?? '').slice(0, 19).replace('T', ' ')}</td>
                          <td className="cell-mono">{String(r.docRefCode ?? '')}</td>
                          <td><Badge value={r.status} /></td>
                          <td className="muted">{r.error ? String(r.error).slice(0, 80) : '\u2014'}</td>
                          <td className="cell-mono">{r.requestPayload ? JSON.stringify(r.requestPayload).slice(0, 80) : '\u2014'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </>
      )}
      {tab === 'taxpayers' && (
        <>
          {filterCard}
          <section className={`card card-pad${refreshing && !loading ? ' is-refreshing' : ''}`} aria-busy={refreshing && !loading}>
            <div className="card-head">
              <div>
                <h3>Registered taxpayers ({filtered.length.toLocaleString()}{countSuffix})</h3>
                <p className="muted" style={{ margin: 0 }}>
                  Every fiscal document is issued by one legal entity at one place of business. A taxpayer must be
                  REGISTERED before a configuration can point at it.
                </p>
              </div>
              <div className="row-actions">
                {!loading && statusNote && <span className="muted" style={{ fontSize: 12 }} role="status" aria-live="polite">{statusNote}</span>}
                {canManageConfig && (
                  <button className="btn btn-primary" disabled={busy} onClick={() => { setTaxpayerRow(null); setFormErr(''); setTaxpayerOpen(true); }}>New taxpayer</button>
                )}
              </div>
            </div>
            {loading ? <Skeleton rows={5} /> : failedPanel('taxpayers') ? (
              <EmptyState title="Taxpayers could not load" body="The server did not return this panel. Retry to ask again." action="Retry" onAction={load} />
            ) : sourceCount === 0 ? (
              <EmptyState title="No taxpayer registered yet" body="Add the company TIN and place of business to begin."
                action={canManageConfig ? 'New taxpayer' : undefined}
                onAction={canManageConfig ? () => { setTaxpayerRow(null); setFormErr(''); setTaxpayerOpen(true); } : undefined} />
            ) : filtered.length === 0 ? (
              <EmptyState title="No taxpayers match these filters"
                body={term ? `Nothing matches "${search.trim()}" with the other filters applied.` : 'Nothing matches the current filters.'}
                action="Clear filters" onAction={clearFilters} />
            ) : (
              <>
                <div className="record-cards mobile-only">
                  {visible.map((r) => (
                    <div key={`card-${String(r.id)}`} className="record-card">
                      <div className="record-card-top">
                        <strong className="cell-mono">{String(r.code)}</strong>
                        <Badge value={r.efrisStatus} />
                      </div>
                      <div>
                        {String(r.legalName)}
                        {r.isDefault ? <> <Badge value="DEFAULT" /></> : null}
                      </div>
                      {r.tradingName ? <div className="muted" style={{ fontSize: 12 }}>Trading as {String(r.tradingName)}</div> : null}
                      <div className="record-card-meta">
                        <span>TIN {String(r.tin)}</span>
                        <span>{String(r.taxpayerType ?? '\u2014')}</span>
                        <span>{String(r.placeOfBusiness ?? '\u2014')}</span>
                        <span>{String(r.environment ?? 'DISABLED')}</span>
                      </div>
                      {canManageConfig && (
                        <div className="row-actions" style={{ marginTop: 8 }}>
                          <button className="btn btn-sm" disabled={busy} onClick={() => { setTaxpayerRow(r); setFormErr(''); setTaxpayerOpen(true); }}>Edit</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="table-wrap desktop-only">
                  <table className="data">
                    <thead>
                      <tr>
                        <th aria-sort={ariaSort('code')}><button className="th-btn" title="Sort by code" onClick={() => setSort('code')}>Code{sortMark('code')}</button></th>
                        <th aria-sort={ariaSort('name')}><button className="th-btn" title="Sort by legal name" onClick={() => setSort('name')}>Legal name{sortMark('name')}</button></th>
                        <th aria-sort={ariaSort('tin')}><button className="th-btn" title="Sort by TIN" onClick={() => setSort('tin')}>TIN{sortMark('tin')}</button></th>
                        <th>VAT</th>
                        <th aria-sort={ariaSort('type')}><button className="th-btn" title="Sort by taxpayer type" onClick={() => setSort('type')}>Type{sortMark('type')}</button></th>
                        <th>Place of business</th>
                        <th>Branch</th>
                        <th aria-sort={ariaSort('status')}><button className="th-btn" title="Sort by registration status" onClick={() => setSort('status')}>Registration{sortMark('status')}</button></th>
                        <th>Environment</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((r) => (
                        <tr key={String(r.id)}>
                          <td className="cell-mono">{String(r.code)}</td>
                          <td>
                            {String(r.legalName)}
                            {r.tradingName ? <span className="muted"> - {String(r.tradingName)}</span> : null}
                            {r.isDefault ? <> <Badge value="DEFAULT" /></> : null}
                          </td>
                          <td className="cell-mono">{String(r.tin)}</td>
                          <td>{r.vatRegistered ? String(r.vatNumber ?? 'Registered') : 'Not registered'}</td>
                          <td>{String(r.taxpayerType ?? '\u2014')}</td>
                          <td>{String(r.placeOfBusiness ?? '\u2014')}</td>
                          <td>{r.branchName ? `${String(r.branchCode ?? '')} ${String(r.branchName)}`.trim() : '\u2014'}</td>
                          <td><Badge value={r.efrisStatus} /></td>
                          <td>{String(r.environment ?? 'DISABLED')}</td>
                          <td>
                            <div className="row-actions">
                              {canManageConfig && <button className="btn btn-sm" disabled={busy} onClick={() => { setTaxpayerRow(r); setFormErr(''); setTaxpayerOpen(true); }}>Edit</button>}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </>
      )}
      {tab === 'setup' && (
        <>
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <h3>Where URA credentials live</h3>
            <p className="muted">
              The ERP never stores URA secrets. This screen records only the <strong>names</strong> of server environment
              variables - the values stay in the server environment and are read by the backend at submission time. Anything
              that looks like a secret (client secret, password, token, api key) is rejected by the API on sight.
            </p>
            <div className="form-grid">
              <div className="field"><label>Client ID env key</label><div className="cell-mono">EFRIS_CLIENT_ID</div></div>
              <div className="field"><label>Client secret env key</label><div className="cell-mono">EFRIS_CLIENT_SECRET</div></div>
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>
              A configuration can only be set to TEST or ACTIVE once both keys resolve on the server. Leave it DISABLED
              until the URA sandbox values have been loaded and verified there.
            </p>
          </div>
          {filterCard}
          <section className={`card card-pad${refreshing && !loading ? ' is-refreshing' : ''}`} aria-busy={refreshing && !loading}>
            <div className="card-head">
              <div>
                <h3>Integration configurations ({filtered.length.toLocaleString()}{countSuffix})</h3>
                <p className="muted" style={{ margin: 0 }}>Runtime settings per company and taxpayer, including retry behaviour and the duplicate window.</p>
              </div>
              <div className="row-actions">
                {!loading && statusNote && <span className="muted" style={{ fontSize: 12 }} role="status" aria-live="polite">{statusNote}</span>}
                {canManageConfig && (
                  <button className="btn btn-primary" disabled={busy} onClick={() => { setConfigRow(null); setFormErr(''); setConfigOpen(true); }}>New configuration</button>
                )}
              </div>
            </div>
            {loading ? <Skeleton rows={4} /> : failedPanel('configurations') ? (
              <EmptyState title="Integration configurations could not load" body="The server did not return this panel. Retry to ask again." action="Retry" onAction={load} />
            ) : sourceCount === 0 ? (
              <EmptyState title="No EFRIS configuration yet" body="Fiscalization stays off until one exists and is enabled." />
            ) : filtered.length === 0 ? (
              <EmptyState title="No configurations match these filters"
                body={term ? `Nothing matches "${search.trim()}" with the other filters applied.` : 'Nothing matches the current filters.'}
                action="Clear filters" onAction={clearFilters} />
            ) : (
              <>
                <div className="record-cards mobile-only">
                  {visible.map((r) => (
                    <div key={`card-${String(r.id)}`} className="record-card">
                      <div className="record-card-top">
                        <strong className="cell-mono">{String(r.code)}</strong>
                        <Badge value={r.mode} />
                      </div>
                      <div>{String(r.name)}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {r.taxpayerLegalName ? `${String(r.taxpayerLegalName)} (${String(r.taxpayerTin ?? '')})` : 'default taxpayer'}
                      </div>
                      <div className="record-card-meta">
                        <span>Active {r.isActive ? 'yes' : 'no'}</span>
                        <span>Auto submit {r.autoSubmit ? 'yes' : 'no'}</span>
                        <span>Duplicates {String(r.duplicateWindowSeconds ?? 0)}s</span>
                        <span>{r.secretsResolvable ? 'credentials resolved' : r.clientIdRefSet && r.credentialsRefSet ? 'missing in env' : 'not set'}</span>
                      </div>
                      {canManageConfig && (
                        <div className="row-actions" style={{ marginTop: 8 }}>
                          <button className="btn btn-sm" disabled={busy} onClick={() => { setConfigRow(r); setFormErr(''); setConfigOpen(true); }}>Edit</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="table-wrap desktop-only">
                  <table className="data">
                    <thead>
                      <tr>
                        <th aria-sort={ariaSort('code')}><button className="th-btn" title="Sort by code" onClick={() => setSort('code')}>Code{sortMark('code')}</button></th>
                        <th aria-sort={ariaSort('name')}><button className="th-btn" title="Sort by name" onClick={() => setSort('name')}>Name{sortMark('name')}</button></th>
                        <th>Taxpayer</th>
                        <th aria-sort={ariaSort('mode')}><button className="th-btn" title="Sort by mode" onClick={() => setSort('mode')}>Mode{sortMark('mode')}</button></th>
                        <th aria-sort={ariaSort('active')}><button className="th-btn" title="Sort by active state" onClick={() => setSort('active')}>Active{sortMark('active')}</button></th>
                        <th>Auto submit</th>
                        <th>Fiscalize on post</th>
                        <th>Env pointers</th>
                        <th aria-sort={ariaSort('duplicate')}><button className="th-btn" title="Sort by duplicate window" onClick={() => setSort('duplicate')}>Duplicate window{sortMark('duplicate')}</button></th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((r) => (
                        <tr key={String(r.id)}>
                          <td className="cell-mono">{String(r.code)}</td>
                          <td>{String(r.name)}</td>
                          <td>{r.taxpayerLegalName ? `${String(r.taxpayerLegalName)} (${String(r.taxpayerTin ?? '')})` : <span className="muted">default taxpayer</span>}</td>
                          <td><Badge value={r.mode} /></td>
                          <td>{r.isActive ? 'Yes' : 'No'}</td>
                          <td>{r.autoSubmit ? 'Yes' : 'No'}</td>
                          <td>{r.fiscalizeSalesOnPost ? 'Yes' : 'No'}</td>
                          <td>
                            {r.secretsResolvable
                              ? <Badge value="RESOLVED" />
                              : <Badge value={r.clientIdRefSet && r.credentialsRefSet ? 'MISSING IN ENV' : 'NOT SET'} />}
                          </td>
                          <td>{String(r.duplicateWindowSeconds ?? 0)}s</td>
                          <td>
                            <div className="row-actions">
                              {canManageConfig && <button className="btn btn-sm" disabled={busy} onClick={() => { setConfigRow(r); setFormErr(''); setConfigOpen(true); }}>Edit</button>}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </>
      )}
      {taxpayerOpen && <EfrisTaxpayerModal row={taxpayerRow} busy={busy} error={formErr} onClose={() => { setTaxpayerOpen(false); setTaxpayerRow(null); setFormErr(''); }} onSave={saveTaxpayer} />}
      {configOpen && <EfrisConfigModal row={configRow} taxpayers={taxpayers} busy={busy} error={formErr} onClose={() => { setConfigOpen(false); setConfigRow(null); setFormErr(''); }} onSave={saveConfiguration} />}
      {registerOpen && <EfrisRegisterModal busy={busy} onClose={() => setRegisterOpen(false)} onSave={register} />}
      {resolveTarget && <EfrisResolveModal busy={busy} target={resolveTarget} onClose={() => setResolveTarget(null)} onSave={(resolution, cancelTransaction) => errorAct(Number(resolveTarget.id), 'archive', { resolution, cancelTransaction })} />}
    </div>
  );
}

function EfrisResolveModal({ busy, target, onClose, onSave }: { busy: boolean; target: Rec; onClose: () => void; onSave: (resolution: string, cancelTransaction: boolean) => void }) {
  const [resolution, setResolution] = useState('');
  const [cancelTransaction, setCancelTransaction] = useState(false);
  return (
    <Modal
      title="Resolve EFRIS error"
      onClose={onClose}
      footer={<button className="btn btn-primary" disabled={busy || resolution.trim().length < 5} onClick={() => onSave(resolution.trim(), cancelTransaction)}>Record resolution</button>}
    >
      <p className="muted">
        {String(target.errorCode ?? '')} - {String(target.errorMessage ?? '')}
      </p>
      <p className="muted">
        Resolving records why this failure was accepted as closed. It does not fiscalize anything; only a confirmed URA
        response can do that.
      </p>
      <label>Resolution <textarea rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="Corrected TIN and re-submitted; URA accepted." /></label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <input type="checkbox" checked={cancelTransaction} onChange={(e) => setCancelTransaction(e.target.checked)} />
        Also cancel the linked ERP transaction
      </label>
    </Modal>
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
}

function EfrisTaxpayerModal({ row, busy, error, onClose, onSave }: { row: Rec | null; busy: boolean; error: string; onClose: () => void; onSave: (p: Rec) => void }) {
  const init = (key: string): string => (row && row[key] != null ? String(row[key]) : '');
  const [code, setCode] = useState(init('code'));
  const [legalName, setLegalName] = useState(init('legalName'));
  const [tradingName, setTradingName] = useState(init('tradingName'));
  const [tin, setTin] = useState(init('tin'));
  const [vatRegistered, setVatRegistered] = useState(row ? Boolean(row.vatRegistered) : false);
  const [vatNumber, setVatNumber] = useState(init('vatNumber'));
  const [taxpayerType, setTaxpayerType] = useState(init('taxpayerType') || 'COMPANY');
  const [businessSector, setBusinessSector] = useState(init('businessSector'));
  const [placeOfBusiness, setPlaceOfBusiness] = useState(init('placeOfBusiness'));
  const [address, setAddress] = useState(init('address'));
  const [contactName, setContactName] = useState(init('contactName'));
  const [contactEmail, setContactEmail] = useState(init('contactEmail'));
  const [contactPhone, setContactPhone] = useState(init('contactPhone'));
  const [efrisStatus, setEfrisStatus] = useState(init('efrisStatus') || 'NOT_CONFIGURED');
  const [environment, setEnvironment] = useState(init('environment') || 'DISABLED');
  const [branchId, setBranchId] = useState(init('branchId'));
  const [credentialsRef, setCredentialsRef] = useState(init('credentialsRef'));
  const [isDefault, setIsDefault] = useState(row ? Boolean(row.isDefault) : false);
  const [effectiveFrom, setEffectiveFrom] = useState(init('effectiveFrom').slice(0, 10));
  const [effectiveTo, setEffectiveTo] = useState(init('effectiveTo').slice(0, 10));

  const submit = () => onSave({
    code, legalName, tradingName, tin, vatRegistered, vatNumber, taxpayerType,
    businessSector, placeOfBusiness, address, contactName, contactEmail, contactPhone,
    efrisStatus, environment, isDefault,
    branchId: branchId.trim() === '' ? undefined : Number(branchId),
    credentialsRef: credentialsRef.trim() === '' ? undefined : credentialsRef.trim(),
    effectiveFrom: effectiveFrom.trim() === '' ? undefined : effectiveFrom,
    effectiveTo: effectiveTo.trim() === '' ? undefined : effectiveTo,
  });

  return (
    <Modal
      title={row ? `Edit taxpayer ${String(row.code ?? '')}` : 'Register EFRIS taxpayer'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !code.trim() || !legalName.trim() || !tin.trim()} onClick={submit}>
            {row ? 'Save taxpayer' : 'Register taxpayer'}
          </button>
        </>
      }
    >
      <p className="muted">
        Registration tells the ERP which legal entity and place of business issues fiscal documents, and which URA
        environment it may talk to. Only the registration status decides whether the taxpayer is usable.
      </p>
      {error ? <ErrorBanner error={error} /> : null}
      <div className="form-grid">
        <label>Taxpayer code <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="HDG-UG" /></label>
        <label>Legal name <input value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="HOPE DESIGN GROUP LTD" /></label>
        <label>Trading name <input value={tradingName} onChange={(e) => setTradingName(e.target.value)} /></label>
        <label>TIN <input value={tin} onChange={(e) => setTin(e.target.value)} placeholder="1000000000" /></label>
        <label>Taxpayer type
          <input list="efris-taxpayer-types" value={taxpayerType} onChange={(e) => setTaxpayerType(e.target.value)} />
          <datalist id="efris-taxpayer-types">
            {EFRIS_TAXPAYER_TYPES.map((x) => <option key={x} value={x} />)}
          </datalist>
        </label>
        <label>Business sector <input value={businessSector} onChange={(e) => setBusinessSector(e.target.value)} placeholder="Manufacturing" /></label>
        <label>Place of business <input value={placeOfBusiness} onChange={(e) => setPlaceOfBusiness(e.target.value)} placeholder="Plot 12, Kampala" /></label>
        <label>Branch ID (optional) <input type="number" value={branchId} onChange={(e) => setBranchId(e.target.value)} placeholder="defaults to your branch" /></label>
        <label style={{ gridColumn: '1 / -1' }}>Registered address <input value={address} onChange={(e) => setAddress(e.target.value)} /></label>
        <label>Contact name <input value={contactName} onChange={(e) => setContactName(e.target.value)} /></label>
        <label>Contact email <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} /></label>
        <label>Contact phone <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} /></label>
        <label>URA registration status
          <select value={efrisStatus} onChange={(e) => setEfrisStatus(e.target.value)}>
            {EFRIS_TAXPAYER_STATUSES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label>Environment
          <select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
            {EFRIS_MODES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label>Credentials env key (optional)
          <input value={credentialsRef} onChange={(e) => setCredentialsRef(e.target.value)} placeholder="EFRIS_CREDENTIALS" />
        </label>
        <label>Effective from <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></label>
        <label>Effective to <input type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} /></label>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <input type="checkbox" checked={vatRegistered} onChange={(e) => setVatRegistered(e.target.checked)} />
        VAT registered
      </label>
      {vatRegistered && (
        <div className="form-grid">
          <label>VAT number <input value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} /></label>
        </div>
      )}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        Use as the default taxpayer for this company
      </label>
    </Modal>
  );
}

function EfrisConfigModal({ row, taxpayers, busy, error, onClose, onSave }: { row: Rec | null; taxpayers: Rec[]; busy: boolean; error: string; onClose: () => void; onSave: (p: Rec) => void }) {
  const init = (key: string): string => (row && row[key] != null ? String(row[key]) : '');
  const [code, setCode] = useState(init('code'));
  const [name, setName] = useState(init('name'));
  const [taxpayerId, setTaxpayerId] = useState(init('taxpayerId'));
  const [mode, setMode] = useState(init('mode') || 'DISABLED');
  const [baseUrl, setBaseUrl] = useState(init('baseUrl'));
  const [tokenUrl, setTokenUrl] = useState(init('tokenUrl'));
  const [authGrantType, setAuthGrantType] = useState(init('authGrantType') || 'client_credentials');
  const [clientIdRef, setClientIdRef] = useState('');
  const [credentialsRef, setCredentialsRef] = useState('');
  const [timeoutSeconds, setTimeoutSeconds] = useState(init('timeoutSeconds') || '20');
  const [maxAttempts, setMaxAttempts] = useState(init('maxAttempts') || '5');
  const [retryBackoffSeconds, setRetryBackoffSeconds] = useState(init('retryBackoffSeconds') || '120');
  const [pollIntervalSeconds, setPollIntervalSeconds] = useState(init('pollIntervalSeconds') || '30');
  const [duplicateWindowSeconds, setDuplicateWindowSeconds] = useState(init('duplicateWindowSeconds') || '300');
  const [notifyRoleCodes, setNotifyRoleCodes] = useState(
    row && Array.isArray(row.notifyRoleCodes) ? (row.notifyRoleCodes as unknown[]).map((x) => String(x)).join(', ') : ''
  );
  const [payloadMapping, setPayloadMapping] = useState(row ? JSON.stringify(row.payloadMapping ?? {}, null, 2) : '');
  const [securityFlags, setSecurityFlags] = useState(row ? JSON.stringify(row.securityFlags ?? {}, null, 2) : '');
  const [fiscalizeSalesOnPost, setFiscalizeSalesOnPost] = useState(row ? Boolean(row.fiscalizeSalesOnPost) : false);
  const [autoSubmit, setAutoSubmit] = useState(row ? Boolean(row.autoSubmit) : false);
  const [notifyOnFailure, setNotifyOnFailure] = useState(row ? row.notifyOnFailure !== false : true);
  const [isActive, setIsActive] = useState(row ? row.isActive !== false : true);
  const [localErr, setLocalErr] = useState('');

  const numOr = (value: string): unknown => (value.trim() === '' ? undefined : Number(value));
  const jsonOr = (value: string, current: unknown): unknown => {
    const text = value.trim();
    if (text === '') return undefined;
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Payload mapping and security flags must be JSON objects');
    if (row && JSON.stringify(parsed) === JSON.stringify(current ?? {})) return undefined;
    return parsed;
  };
  const submit = () => {
    setLocalErr('');
    try {
      const roles = notifyRoleCodes.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
      const payload: Rec = {
        code, name, mode, authGrantType, baseUrl, tokenUrl,
        fiscalizeSalesOnPost, autoSubmit, notifyOnFailure, isActive,
        taxpayerId: taxpayerId.trim() === '' ? undefined : Number(taxpayerId),
        timeoutSeconds: numOr(timeoutSeconds),
        maxAttempts: numOr(maxAttempts),
        retryBackoffSeconds: numOr(retryBackoffSeconds),
        pollIntervalSeconds: numOr(pollIntervalSeconds),
        duplicateWindowSeconds: numOr(duplicateWindowSeconds),
        notifyRoleCodes: row ? roles : (roles.length ? roles : undefined),
        payloadMapping: jsonOr(payloadMapping, row?.payloadMapping),
        securityFlags: jsonOr(securityFlags, row?.securityFlags),
      };
      // Env pointer keys are only sent when an admin types one; on edit the stored
      // names are never read back from the API, so a blind save would blank them.
      if (clientIdRef.trim() !== '') payload.clientIdRef = clientIdRef.trim();
      if (credentialsRef.trim() !== '') payload.credentialsRef = credentialsRef.trim();
      onSave(payload);
    } catch (e) { setLocalErr(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <Modal
      title={row ? `Edit configuration ${String(row.code ?? '')}` : 'New EFRIS configuration'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !code.trim() || !name.trim()} onClick={submit}>
            {row ? 'Save configuration' : 'Create configuration'}
          </button>
        </>
      }
    >
      <p className="muted">
        TEST and ACTIVE only work once the referenced environment keys exist on the server ({EFRIS_ENV_HINT}).
        Keep the mode DISABLED until the URA sandbox connection has been proven.
      </p>
      {mode !== 'DISABLED' && (
        <p className="muted">
          {row ? (row.secretsResolvable ? 'Environment pointers currently resolve on the server.' : 'Environment pointers do not resolve on the server yet - the change will be refused.') : 'A new configuration is refused unless its environment pointers resolve on the server.'}
        </p>
      )}
      {error || localErr ? <ErrorBanner error={localErr || error} /> : null}
      <div className="form-grid">
        <label>Configuration code <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="URA-EFRIS-PROD" /></label>
        <label>Name <input value={name} onChange={(e) => setName(e.target.value)} placeholder="URA EFRIS production" /></label>
        <label>Taxpayer
          <select value={taxpayerId} onChange={(e) => setTaxpayerId(e.target.value)}>
            <option value="">Default taxpayer</option>
            {taxpayers.map((t) => <option key={String(t.id)} value={String(t.id)}>{String(t.code)} - {String(t.legalName)}</option>)}
          </select>
        </label>
        <label>Mode
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {EFRIS_MODES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label style={{ gridColumn: '1 / -1' }}>Base URL <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://efris.ura.go.ug/..." /></label>
        <label style={{ gridColumn: '1 / -1' }}>OAuth token URL <input value={tokenUrl} onChange={(e) => setTokenUrl(e.target.value)} placeholder="https://efris.ura.go.ug/..." /></label>
        <label>Grant type <input value={authGrantType} onChange={(e) => setAuthGrantType(e.target.value)} /></label>
        <label>Client ID env key {row ? '(leave blank to keep)' : ''}
          <input value={clientIdRef} onChange={(e) => setClientIdRef(e.target.value)} placeholder={row && row.clientIdRefSet ? 'stored - type to replace' : 'EFRIS_CLIENT_ID'} />
        </label>
        <label>Client secret env key {row ? '(leave blank to keep)' : ''}
          <input value={credentialsRef} onChange={(e) => setCredentialsRef(e.target.value)} placeholder={row && row.credentialsRefSet ? 'stored - type to replace' : 'EFRIS_CLIENT_SECRET'} />
        </label>
        <label>Timeout (seconds) <input type="number" value={timeoutSeconds} onChange={(e) => setTimeoutSeconds(e.target.value)} /></label>
        <label>Max attempts <input type="number" value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} /></label>
        <label>Retry backoff (seconds) <input type="number" value={retryBackoffSeconds} onChange={(e) => setRetryBackoffSeconds(e.target.value)} /></label>
        <label>Poll interval (seconds) <input type="number" value={pollIntervalSeconds} onChange={(e) => setPollIntervalSeconds(e.target.value)} /></label>
        <label>Duplicate window (seconds) <input type="number" value={duplicateWindowSeconds} onChange={(e) => setDuplicateWindowSeconds(e.target.value)} /></label>
        <label style={{ gridColumn: '1 / -1' }}>Notify role codes (comma separated) <input value={notifyRoleCodes} onChange={(e) => setNotifyRoleCodes(e.target.value)} placeholder="cfo, finance_manager, tax_officer" /></label>
        <label style={{ gridColumn: '1 / -1' }}>Payload mapping (JSON object)
          <textarea rows={4} value={payloadMapping} onChange={(e) => setPayloadMapping(e.target.value)} placeholder="{}" />
        </label>
        <label style={{ gridColumn: '1 / -1' }}>Security flags (JSON object)
          <textarea rows={3} value={securityFlags} onChange={(e) => setSecurityFlags(e.target.value)} placeholder="{}" />
        </label>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <input type="checkbox" checked={fiscalizeSalesOnPost} onChange={(e) => setFiscalizeSalesOnPost(e.target.checked)} />
        Fiscalize sales invoices automatically once posted
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <input type="checkbox" checked={autoSubmit} onChange={(e) => setAutoSubmit(e.target.checked)} />
        Auto submit queued documents to URA
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <input type="checkbox" checked={notifyOnFailure} onChange={(e) => setNotifyOnFailure(e.target.checked)} />
        Notify the roles above on fiscalization failure
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Configuration active
      </label>
    </Modal>
  );
}

function TaxCompliance() {
  const { user } = useAuth();
  type TaxPanel = string;
  type TaxSums = { base: number; tax: number; count: number };
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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadFailures, setLoadFailures] = useState<Array<{ panel: TaxPanel; message: string }>>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [jurisdictionFilter, setJurisdictionFilter] = useState('');
  const [sortBy, setSortBy] = useState('txnDate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Every panel is fetched in parallel and every rejection is surfaced by name. The previous
  // version swallowed four of these five failures with `.catch(() => undefined)`, so a broken
  // panel was indistinguishable from a period with no postings.
  const load = useCallback(() => {
    const q = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    setRefreshing(true);
    const jobs: Array<[TaxPanel, Promise<unknown>]> = [
      ['compliance summary', api<{ data: Rec[] }>(`/api/ops/finance/tax/compliance${q}`).then((r) => setSummary(r.data ?? []))],
      ['tax transactions', api<{ data: Rec[] }>(`/api/ops/finance/tax/transactions${q}`).then((r) => setRows(r.data ?? []))],
      ['jurisdictions', api<{ data: Rec[] }>('/api/ops/finance/tax/jurisdictions').then((r) => setJurisdictions(r.data ?? []))],
      ['tax rules', api<{ data: Rec[] }>('/api/ops/finance/tax/rules').then((r) => setRules(r.data ?? []))],
      ['tax catalog', api<{ data: Rec[] }>('/api/ops/finance/taxes').then((r) => setTaxes(r.data ?? []))],
    ];
    Promise.allSettled(jobs.map(([, job]) => job))
      .then((results) => {
        const failed: Array<{ panel: TaxPanel; message: string }> = [];
        results.forEach((result, index) => {
          if (result.status !== 'rejected') return;
          const reason: unknown = result.reason;
          failed.push({ panel: jobs[index][0], message: reason instanceof Error ? reason.message : String(reason) });
        });
        setLoadFailures(failed);
      })
      .finally(() => { setRefreshing(false); setLoading(false); });
  }, [from, to]);
  useEffect(() => { load(); }, [load]);
  const failedPanel = (panel: TaxPanel) => loadFailures.find((f) => f.panel === panel)?.message ?? '';
  const save = async (payload: Rec) => {
    setBusy(true); setError('');
    try {
      await api('/api/ops/finance/tax/transactions', { method: 'POST', body: JSON.stringify(payload) });
      setTxnOpen(false);
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const statusOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => String(r.status ?? '')).filter(Boolean))).sort(),
    [rows],
  );
  const jurisdictionOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => String(r.jurisdictionCode ?? '')).filter(Boolean))).sort(),
    [rows],
  );
  const query = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    const list = rows.filter((r) => {
      if (statusFilter && String(r.status ?? '') !== statusFilter) return false;
      if (jurisdictionFilter && String(r.jurisdictionCode ?? '') !== jurisdictionFilter) return false;
      if (!query) return true;
      return [r.taxCode, r.taxName, r.jurisdictionCode, r.docRefCode, r.docType, r.status]
        .map((v) => String(v ?? '').toLowerCase())
        .some((v) => v.includes(query));
    });
    const dir = sortDir === 'asc' ? 1 : -1;
    const value = (r: Rec): string | number => {
      switch (sortBy) {
        case 'tax': return `${String(r.taxCode ?? '')} ${String(r.taxName ?? '')}`.toLowerCase();
        case 'jurisdiction': return String(r.jurisdictionCode ?? '').toLowerCase();
        case 'doc': return String(r.docRefCode ?? r.docType ?? '').toLowerCase();
        case 'baseAmount': return Number(r.baseAmount ?? 0);
        case 'rate': return Number(r.rate ?? 0);
        case 'taxAmount': return Number(r.taxAmount ?? 0);
        case 'status': return String(r.status ?? '').toLowerCase();
        default: return String(r.txnDate ?? '');
      }
    };
    return list.slice().sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [rows, statusFilter, jurisdictionFilter, query, sortBy, sortDir]);
  const totals = useMemo(
    () => filtered.reduce<TaxSums>(
      (acc, r) => ({ base: acc.base + Number(r.baseAmount ?? 0), tax: acc.tax + Number(r.taxAmount ?? 0), count: acc.count + 1 }),
      { base: 0, tax: 0, count: 0 },
    ),
    [filtered],
  );
  const summaryTotal = useMemo(
    () => summary.reduce<TaxSums>(
      (acc, s) => ({ base: acc.base + Number(s.baseAmount ?? 0), tax: acc.tax + Number(s.taxAmount ?? 0), count: acc.count + Number(s.txnCount ?? 0) }),
      { base: 0, tax: 0, count: 0 },
    ),
    [summary],
  );

  const TAX_SORT_LABELS: Record<string, string> = {
    txnDate: 'date', tax: 'tax', jurisdiction: 'jurisdiction', doc: 'document',
    baseAmount: 'base amount', rate: 'rate', taxAmount: 'tax amount', status: 'status',
  };
  const sortMark = (col: string) => (sortBy === col ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : '');
  const ariaSort = (col: string): 'ascending' | 'descending' | undefined =>
    (sortBy === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined);
  const setSort = (col: string) => {
    if (sortBy !== col) { setSortBy(col); setSortDir('asc'); return; }
    if (sortDir === 'asc') { setSortDir('desc'); return; }
    setSortBy(''); setSortDir('asc');
  };

  const hasFilters = Boolean(query || statusFilter || jurisdictionFilter);
  const activeFilters: Array<{ key: string; label: string; value: string }> = [];
  if (query) activeFilters.push({ key: 'q', label: 'Search', value: search.trim() });
  if (statusFilter) activeFilters.push({ key: 'status', label: 'Status', value: statusFilter.replace(/_/g, ' ') });
  if (jurisdictionFilter) activeFilters.push({ key: 'jurisdiction', label: 'Jurisdiction', value: jurisdictionFilter });
  const removeFilter = (key: string) => {
    if (key === 'q') setSearch('');
    if (key === 'status') setStatusFilter('');
    if (key === 'jurisdiction') setJurisdictionFilter('');
  };
  const clearFilters = () => { setSearch(''); setStatusFilter(''); setJurisdictionFilter(''); };

  const loadNote = loadFailures.length > 0 ? (
    <div className="card card-pad card-warn" role="status" aria-live="polite" style={{ marginBottom: 14 }}>
      <h3 style={{ marginTop: 0 }}>Could not load {loadFailures.length === 1 ? '1 panel' : `${loadFailures.length} panels`}</h3>
      <p className="muted" style={{ margin: '6px 0' }}>{loadFailures.map((f) => `${f.panel}: ${f.message}`).join(' \u00B7 ')}</p>
      <p className="muted" style={{ marginBottom: 10 }}>Everything else on this screen is showing what the server last returned.</p>
      <button className="btn btn-sm" disabled={refreshing} onClick={load}>{refreshing ? 'Retrying\u2026' : 'Retry'}</button>
    </div>
  ) : null;

  const chips = activeFilters.length > 0 || sortBy ? (
    <div className="filter-chips" style={{ padding: '12px 0 0' }}>
      {activeFilters.map((f) => (
        <span key={f.key} className="filter-chip">
          <b>{f.label}</b>{f.value ? `: ${f.value}` : ''}
          <button type="button" title="Remove filter" aria-label={`Remove ${f.label} filter`} onClick={() => removeFilter(f.key)}>{'\u00D7'}</button>
        </span>
      ))}
      {sortBy && (
        <span className="filter-chip">
          <b>Sort</b>{`: ${TAX_SORT_LABELS[sortBy] ?? sortBy} ${sortDir === 'asc' ? 'ascending' : 'descending'}`}
          <button type="button" title="Clear sort" aria-label="Clear sort" onClick={() => { setSortBy(''); setSortDir('asc'); }}>{'\u00D7'}</button>
        </span>
      )}
      <button className="btn btn-sm btn-ghost" onClick={clearFilters}>Clear all</button>
    </div>
  ) : null;

  const filterCard = (
    <div className="card card-pad" style={{ marginBottom: 14 }}>
      <div className="toolbar" style={{ marginBottom: hasFilters || sortBy ? 10 : 0 }}>
        <input className="search-input" type="search" value={search} aria-label="Search tax transactions"
          placeholder="Search tax, jurisdiction, document..."
          onChange={(e) => setSearch(e.target.value)} />
        {statusOptions.length > 0 && <StatusSelect value={statusFilter} onChange={setStatusFilter} options={statusOptions} />}
        {jurisdictionOptions.length > 0 && (
          <StatusSelect value={jurisdictionFilter} onChange={setJurisdictionFilter} options={jurisdictionOptions}
            label="Filter by jurisdiction" placeholder="All jurisdictions" />
        )}
        {hasFilters && <button className="btn btn-sm btn-ghost" onClick={clearFilters}>Clear filters</button>}
      </div>
      {chips}
    </div>
  );

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Uganda tax</p>
          <h1>Tax compliance</h1>
          <p className="muted">Configurable VAT / WHT / excise engine. Rates and rules are editable {'\u2014'} never hardcoded.</p>
        </div>
        <div className="head-actions">
          <label className="muted" style={{ fontSize: 12 }} htmlFor="tax-from">Period</label>
          <input id="tax-from" type="date" value={from} max={to} aria-label="Period start date" title="Period start" onChange={(e) => setFrom(e.target.value)} />
          <input type="date" value={to} min={from} aria-label="Period end date" title="Period end" onChange={(e) => setTo(e.target.value)} />
          <button className="btn" disabled={refreshing} onClick={load} title="Re-read every tax panel from the server">{refreshing ? 'Refreshing\u2026' : 'Refresh'}</button>
          {can(user, 'finance.tax_transactions.create') && <button className="btn btn-primary" onClick={() => setTxnOpen(true)}>Record tax</button>}
        </div>
      </header>

      {error && <ErrorBanner error={error} />}
      {loadNote}

      {loading ? (
        <div className="card card-pad" style={{ marginBottom: 16 }}><Skeleton rows={3} /></div>
      ) : (
        <>
          <div className="kpi-grid">
            <div className={`kpi-card${summary.length > 0 ? '' : ' card-warn'}`}>
              <span className="kpi-label">Total tax in period</span>
              <span className={`kpi-value${summary.length > 0 ? '' : ' kpi-warn'}`}>{fmtMoney(summaryTotal.tax)}</span>
              <span className="kpi-sub">{summary.length > 0 ? `on ${fmtMoney(summaryTotal.base)} base \u00B7 ${fmtNum(summaryTotal.count)} txns` : 'No posted tax lines in this period'}</span>
            </div>
            {summary.map((s) => (
              <div key={String(s.taxCode)} className="kpi-card">
                <span className="kpi-label">{String(s.taxName ?? '') || String(s.taxCode)}{String(s.taxCode) ? ` (${String(s.taxCode)})` : ''}</span>
                <span className="kpi-value">{fmtMoney(s.taxAmount)}</span>
                <span className="kpi-sub">Base {fmtMoney(s.baseAmount)} {'\u00B7'} {fmtNum(s.txnCount)} txns</span>
              </div>
            ))}
          </div>
          <div className="kpi-grid" style={{ marginTop: 16 }}>
            <div className={`kpi-card${jurisdictions.length > 0 ? '' : ' card-warn'}`}>
              <span className="kpi-label">Jurisdictions</span>
              <span className={`kpi-value${jurisdictions.length > 0 ? '' : ' kpi-warn'}`}>{fmtNum(jurisdictions.length)}</span>
              <span className="kpi-sub">{jurisdictions.map((j) => String(j.code ?? '')).filter(Boolean).join(', ') || 'None configured'}</span>
            </div>
            <div className={`kpi-card${rules.length > 0 ? '' : ' card-warn'}`}>
              <span className="kpi-label">Tax rules</span>
              <span className={`kpi-value${rules.length > 0 ? '' : ' kpi-warn'}`}>{fmtNum(rules.length)}</span>
              <span className="kpi-sub">Applies-to: {rules.map((r) => String(r.appliesTo ?? '')).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ') || 'None configured'}</span>
            </div>
          </div>
        </>
      )}

      {filterCard}

      <section className={`card card-pad${refreshing && !loading ? ' is-refreshing' : ''}`} aria-busy={refreshing && !loading}>
        <div className="card-head">
          <h3>Tax transactions ({filtered.length.toLocaleString()})</h3>
          {!loading && (
            <span className="muted" style={{ fontSize: 12 }} role="status" aria-live="polite">
              {filtered.length === rows.length ? `${rows.length.toLocaleString()} in period` : `${filtered.length.toLocaleString()} of ${rows.length.toLocaleString()} in period`}
              {sortBy ? ` \u00B7 sorted by ${TAX_SORT_LABELS[sortBy] ?? sortBy} (${sortDir === 'asc' ? 'ascending' : 'descending'})` : ''}
            </span>
          )}
        </div>
        {loading ? <Skeleton rows={6} /> : failedPanel('tax transactions') && rows.length === 0 ? (
          <EmptyState title="Tax transactions could not load"
            body={`The server did not return this panel: ${failedPanel('tax transactions')}. Retry to ask again.`}
            action="Retry" onAction={load} />
        ) : filtered.length === 0 ? (
          hasFilters ? (
            <EmptyState title="No tax transactions match these filters"
              body={query ? `Nothing matches "${search.trim()}" with the other filters applied. Clear them to see the whole period.` : 'Nothing matches the current filters. Clear them to see the whole period.'}
              action="Clear filters" onAction={clearFilters} />
          ) : (
            <EmptyState title="No tax transactions in this period"
              body="Posted VAT, WHT and excise lines for the selected dates land here. Widen the period, or record a transaction."
              action={can(user, 'finance.tax_transactions.create') ? 'Record tax' : undefined} onAction={() => setTxnOpen(true)} />
          )
        ) : (
          <>
            <div className="record-cards mobile-only">
              {filtered.map((r) => (
                <div key={`card-${String(r.id)}`} className="record-card">
                  <div className="record-card-top">
                    <strong>{String(r.taxCode ?? '') || '\u2014'}</strong>
                    <Badge value={r.status} />
                  </div>
                  <div className="record-card-meta">
                    <span>{String(r.txnDate ?? '').slice(0, 10) || '\u2014'}</span>
                    <span>{String(r.taxName ?? '') || '\u2014'}</span>
                    <span>{String(r.jurisdictionCode ?? '') || '\u2014'}</span>
                  </div>
                  <div className="record-card-meta">
                    <span>Base {fmtMoney(r.baseAmount)}</span>
                    <span>Rate {r.rate === null || r.rate === undefined || r.rate === '' ? '\u2014' : `${String(r.rate)}%`}</span>
                    <span>Tax {fmtMoney(r.taxAmount)}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>{String(r.docRefCode ?? r.docType ?? '') || '\u2014'}</div>
                </div>
              ))}
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th aria-sort={ariaSort('txnDate')}><button className="th-btn" title="Sort by date" onClick={() => setSort('txnDate')}>Date{sortMark('txnDate')}</button></th>
                    <th aria-sort={ariaSort('tax')}><button className="th-btn" title="Sort by tax" onClick={() => setSort('tax')}>Tax{sortMark('tax')}</button></th>
                    <th aria-sort={ariaSort('jurisdiction')}><button className="th-btn" title="Sort by jurisdiction" onClick={() => setSort('jurisdiction')}>Jurisdiction{sortMark('jurisdiction')}</button></th>
                    <th aria-sort={ariaSort('doc')}><button className="th-btn" title="Sort by document" onClick={() => setSort('doc')}>Doc{sortMark('doc')}</button></th>
                    <th className="cell-num" aria-sort={ariaSort('baseAmount')}><button className="th-btn" title="Sort by base amount" onClick={() => setSort('baseAmount')}>Base{sortMark('baseAmount')}</button></th>
                    <th className="cell-num" aria-sort={ariaSort('rate')}><button className="th-btn" title="Sort by rate" onClick={() => setSort('rate')}>Rate{sortMark('rate')}</button></th>
                    <th className="cell-num" aria-sort={ariaSort('taxAmount')}><button className="th-btn" title="Sort by tax amount" onClick={() => setSort('taxAmount')}>Tax{sortMark('taxAmount')}</button></th>
                    <th aria-sort={ariaSort('status')}><button className="th-btn" title="Sort by status" onClick={() => setSort('status')}>Status{sortMark('status')}</button></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={String(r.id)}>
                      <td>{String(r.txnDate ?? '').slice(0, 10) || '\u2014'}</td>
                      <td>{String(r.taxCode ?? '') || '\u2014'}{String(r.taxName ?? '') ? ` \u2014 ${String(r.taxName)}` : ''}</td>
                      <td>{String(r.jurisdictionCode ?? '') || '\u2014'}</td>
                      <td className="cell-mono">{String(r.docRefCode ?? r.docType ?? '') || '\u2014'}</td>
                      <td className="cell-num">{fmtMoney(r.baseAmount)}</td>
                      <td className="cell-num">{r.rate === null || r.rate === undefined || r.rate === '' ? '\u2014' : `${String(r.rate)}%`}</td>
                      <td className="cell-num">{fmtMoney(r.taxAmount)}</td>
                      <td><Badge value={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={4}>Totals {'\u2014'} {totals.count.toLocaleString()} {totals.count === 1 ? 'line' : 'lines'}{hasFilters ? ' (filtered)' : ''}</th>
                    <td className="cell-num">{fmtMoney(totals.base)}</td>
                    <td className="cell-num">{'\u2014'}</td>
                    <td className="cell-num">{fmtMoney(totals.tax)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </section>

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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [module, setModule] = useState('');
  const [docType, setDocType] = useState('');
  const [moduleDraft, setModuleDraft] = useState('');
  const [docTypeDraft, setDocTypeDraft] = useState('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const AUDIT_LIMIT = 200;
  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (module) p.set('module', module);
    if (docType) p.set('docType', docType);
    p.set('limit', String(AUDIT_LIMIT));
    setRefreshing(true);
    setError('');
    api<{ data: Rec[] }>(`/api/ops/finance/audit?${p.toString()}`)
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Audit trail failed'))
      .finally(() => { setRefreshing(false); setLoading(false); });
  }, [module, docType]);
  useEffect(() => { load(); }, [load]);
  // The module / doc-type filters are server-backed, so debounce them: typing
  // "sales" is one request instead of five.
  useEffect(() => {
    if (moduleDraft.trim() === module && docTypeDraft.trim() === docType) return;
    const t = setTimeout(() => { setModule(moduleDraft.trim()); setDocType(docTypeDraft.trim()); }, 300);
    return () => clearTimeout(t);
  }, [moduleDraft, docTypeDraft, module, docType]);
  const fmtTs = (v: unknown) => String(v ?? '').slice(0, 19).replace('T', ' ');
  const changeText = (r: Rec) => (r.newValue ? JSON.stringify(r.newValue) : r.previousValue ? `prev: ${JSON.stringify(r.previousValue)}` : '');
  const SORTS: Record<string, (r: Rec) => string | number> = {
    time: (r) => String(r.createdAt ?? ''),
    user: (r) => String(r.userName ?? r.userEmail ?? 'system'),
    action: (r) => String(r.action ?? ''),
    module: (r) => String(r.module ?? ''),
    docType: (r) => String(r.docType ?? ''),
    docCode: (r) => String(r.docCode ?? ''),
  };
  const SORT_LABELS: Record<string, string> = {
    time: 'Time', user: 'User', action: 'Action', module: 'Module', docType: 'Doc', docCode: 'Ref',
  };
  const term = search.trim().toLowerCase();
  const filtered = term
    ? rows.filter((r) => [r.action, r.module, r.docType, r.docCode, r.userName, r.userEmail, changeText(r)]
        .map((v) => String(v ?? '')).join(' ').toLowerCase().includes(term))
    : rows;
  const visible = sortBy && SORTS[sortBy]
    ? [...filtered].sort((a, b) => {
        const av = SORTS[sortBy](a); const bv = SORTS[sortBy](b);
        const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : filtered;
  const setSort = (col: string) => {
    if (sortBy !== col) { setSortBy(col); setSortDir('asc'); return; }
    if (sortDir === 'asc') { setSortDir('desc'); return; }
    setSortBy('');
  };
  const sortMark = (col: string) => (sortBy === col ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : '');
  const ariaSort = (col: string): 'ascending' | 'descending' | undefined =>
    sortBy === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined;
  const capped = rows.length >= AUDIT_LIMIT;
  const hasFilters = Boolean(module || docType || term);
  const clearFilters = () => {
    setSearch(''); setSortBy('');
    setModuleDraft(''); setDocTypeDraft('');
    setModule(''); setDocType('');
  };
  const activeFilters: Array<{ key: string; label: string; value: string }> = [];
  if (module) activeFilters.push({ key: 'module', label: 'Module', value: module });
  if (docType) activeFilters.push({ key: 'docType', label: 'Doc type', value: docType });
  if (term) activeFilters.push({ key: 'q', label: 'Search', value: search.trim() });
  const removeFilter = (key: string) => {
    if (key === 'module') { setModuleDraft(''); setModule(''); }
    if (key === 'docType') { setDocTypeDraft(''); setDocType(''); }
    if (key === 'q') setSearch('');
  };
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="fin">Compliance</p>
          <h1>Financial audit trail</h1>
          <p className="muted">Immutable for ordinary users. Every create, change, approval, posting and reversal is recorded with actor and value deltas.</p>
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <input className="search-input" type="search" value={search} aria-label="Search loaded audit records"
            placeholder="Search action, user, doc or value..."
            onChange={(e) => setSearch(e.target.value)} />
          <input className="search-input" value={moduleDraft} aria-label="Filter by module" placeholder="Module"
            style={{ maxWidth: 150 }} onChange={(e) => setModuleDraft(e.target.value)} />
          <input className="search-input" value={docTypeDraft} aria-label="Filter by document type" placeholder="Doc type"
            style={{ maxWidth: 160 }} onChange={(e) => setDocTypeDraft(e.target.value)} />
          {hasFilters && <button className="btn btn-sm btn-ghost" onClick={clearFilters}>Clear filters</button>}
        </div>
        {(activeFilters.length > 0 || sortBy) && (
          <div className="filter-chips" style={{ padding: '12px 0 0' }}>
            {activeFilters.map((f) => (
              <span key={f.key} className="filter-chip">
                <b>{f.label}</b>{f.value ? `: ${f.value}` : ''}
                <button type="button" title="Remove filter" aria-label={`Remove ${f.label} filter`} onClick={() => removeFilter(f.key)}>{'\u00D7'}</button>
              </span>
            ))}
            {sortBy && (
              <span className="filter-chip">
                <b>Sort</b>{`: ${SORT_LABELS[sortBy] ?? sortBy} ${sortDir === 'asc' ? 'ascending' : 'descending'}`}
                <button type="button" title="Clear sort" aria-label="Clear sort" onClick={() => setSortBy('')}>{'\u00D7'}</button>
              </span>
            )}
            <button className="btn btn-sm btn-ghost" onClick={clearFilters}>Clear all</button>
          </div>
        )}
      </div>
      <section className={`card card-pad${refreshing && !loading ? ' is-refreshing' : ''}`} aria-busy={refreshing && !loading}>
        <div className="card-head">
          <h3>Records ({rows.length.toLocaleString()})</h3>
          {!loading && rows.length > 0 && (
            <span className="muted" style={{ fontSize: 12 }} role="status" aria-live="polite">
              {visible.length === rows.length
                ? `Showing the most recent ${rows.length.toLocaleString()} entries`
                : `${visible.length.toLocaleString()} of ${rows.length.toLocaleString()} loaded entries shown`}
              {sortBy ? ` \u00B7 sorted by ${SORT_LABELS[sortBy] ?? sortBy} (${sortDir === 'asc' ? 'ascending' : 'descending'})` : ''}
            </span>
          )}
        </div>
        {loading ? <Skeleton rows={8} /> : rows.length === 0 ? (
          <EmptyState title="No audit records"
            body={module || docType ? 'Nothing has been recorded for this module and doc type yet. Clear the filters to see the whole trail.' : 'Nothing has been recorded yet. Every create, change, approval, posting and reversal will appear here.'}
            action={module || docType ? 'Clear filters' : undefined} onAction={clearFilters} />
        ) : visible.length === 0 ? (
          <EmptyState title="Nothing matches these filters"
            body={term ? `No loaded entry matches "${search.trim()}". Search covers only the loaded window; use Module or Doc type to widen the query.` : 'No loaded entry matches the current filters.'}
            action="Clear filters" onAction={clearFilters} />
        ) : (
          <>
            <div className="record-cards mobile-only">
              {visible.map((r) => (
                <div key={`card-${String(r.id)}`} className="record-card">
                  <div className="record-card-top">
                    <strong style={{ fontSize: 13 }}>{fmtTs(r.createdAt)}</strong>
                    <Badge value={r.action} />
                  </div>
                  <div>{String(r.userName ?? r.userEmail ?? 'system')}</div>
                  <div className="record-card-meta">
                    <span>{String(r.module ?? '')}</span>
                    {r.docType ? <span>{String(r.docType)}</span> : null}
                    {r.docCode ? <span className="cell-mono">{String(r.docCode)}</span> : null}
                  </div>
                  {changeText(r) && (
                    <div className="cell-mono" style={{ fontSize: 12, marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{changeText(r)}</div>
                  )}
                </div>
              ))}
            </div>
            <div className="table-wrap desktop-only">
              <table className="data">
                <thead>
                  <tr>
                    <th aria-sort={ariaSort('time')}><button className="th-btn" title="Sort by time" onClick={() => setSort('time')}>Time{sortMark('time')}</button></th>
                    <th aria-sort={ariaSort('user')}><button className="th-btn" title="Sort by user" onClick={() => setSort('user')}>User{sortMark('user')}</button></th>
                    <th aria-sort={ariaSort('action')}><button className="th-btn" title="Sort by action" onClick={() => setSort('action')}>Action{sortMark('action')}</button></th>
                    <th aria-sort={ariaSort('module')}><button className="th-btn" title="Sort by module" onClick={() => setSort('module')}>Module{sortMark('module')}</button></th>
                    <th aria-sort={ariaSort('docType')}><button className="th-btn" title="Sort by doc type" onClick={() => setSort('docType')}>Doc{sortMark('docType')}</button></th>
                    <th aria-sort={ariaSort('docCode')}><button className="th-btn" title="Sort by reference" onClick={() => setSort('docCode')}>Ref{sortMark('docCode')}</button></th>
                    <th>Change</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={String(r.id)}>
                      <td>{fmtTs(r.createdAt)}</td>
                      <td>{String(r.userName ?? r.userEmail ?? 'system')}</td>
                      <td><Badge value={r.action} /></td>
                      <td>{String(r.module ?? '')}</td>
                      <td>{String(r.docType ?? '') || '\u2014'}</td>
                      <td className="cell-mono">{String(r.docCode ?? '') || '\u2014'}</td>
                      <td className="cell-mono" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={changeText(r)}>{changeText(r)}</td>
                      <td>{String(r.ip ?? '') || '\u2014'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {!loading && capped && visible.length > 0 && (
          <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            Only the most recent {AUDIT_LIMIT} entries are loaded. Narrow with Module or Doc type to reach older records.
          </p>
        )}
      </section>
    </div>
  );
}

