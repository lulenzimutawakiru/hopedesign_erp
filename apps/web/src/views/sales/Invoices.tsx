import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, fmtMoney, fmtNum } from '../../api';
import { useAuth, can } from '../../auth';
import { navigate, useHashQuery } from '../../router';
import { Badge, ErrorBanner, PageLoader } from '../../components/ui';
import { localToday } from './odooSales';

type Rec = Record<string, unknown>;
type Scope = 'unpaid' | 'overdue' | 'paid' | 'drafts' | 'all';

const SCOPES: { id: Scope; label: string }[] = [
  { id: 'unpaid', label: 'Unpaid' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'paid', label: 'Paid' },
  { id: 'drafts', label: 'Drafts' },
  { id: 'all', label: 'All' },
];

const PAGE_SIZE = 40;

function asScope(raw: string | null): Scope {
  const value = (raw ?? 'unpaid').toLowerCase();
  return SCOPES.some((item) => item.id === value) ? value as Scope : 'unpaid';
}

function rowOverdue(row: Rec): boolean {
  const status = String(row.status ?? '');
  if (['VOID', 'PAID', 'DRAFT'].includes(status)) return false;
  if (!(Number(row.amountDue ?? 0) > 0.005)) return false;
  const when = String(row.dueDate ?? row.invoiceDate ?? '').slice(0, 10);
  return Boolean(when) && when < localToday();
}

/** Customer invoices, with the balance and due date the old document list left off. */
export default function Invoices() {
  const { user } = useAuth();
  const query = useHashQuery();
  const queryScope = asScope(query.get('scope'));
  const [scope, setScope] = useState<Scope>(queryScope);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [outstanding, setOutstanding] = useState(0);
  const [overdueCount, setOverdueCount] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    setScope(queryScope);
    setPage(1);
  }, [queryScope]);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), scope });
    if (q.trim()) params.set('q', q.trim());
    const r = await api<{ data: { rows: Rec[]; total: number; outstanding: number; overdueCount: number } }>(
      `/api/ops/sales/invoice-desk?${params.toString()}`,
    );
    setRows(r.data.rows ?? []);
    setTotal(Number(r.data.total ?? 0));
    setOutstanding(Number(r.data.outstanding ?? 0));
    setOverdueCount(Number(r.data.overdueCount ?? 0));
  }, [page, q, scope]);

  useEffect(() => {
    setBusy(true);
    load()
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load invoices'))
      .finally(() => setBusy(false));
  }, [load]);

  const chooseScope = (next: Scope) => {
    setScope(next);
    setPage(1);
    navigate('/sales/invoices', { replace: true, query: next === 'unpaid' ? {} : { scope: next } });
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="sales">Sales</p>
          <h1>Invoices</h1>
          <p className="muted">Outstanding {fmtMoney(outstanding)} · {fmtNum(overdueCount)} overdue</p>
        </div>
        <div className="head-actions">
          {can(user, 'sales.invoices.create') && (
            <button className="btn btn-primary" type="button" onClick={() => navigate('/sales/invoices/new')}>New</button>
          )}
        </div>
      </header>
      <div className="toolbar toolbar-sticky">
        <div className="toolbar-left">
          <div className="preset-row" role="tablist" aria-label="Invoice filters">
            {SCOPES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`preset-chip${scope === item.id ? ' is-on' : ''}`}
                onClick={() => chooseScope(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <input
            className="search-input"
            placeholder="Search number or customer…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
          />
        </div>
      </div>
      {error && <ErrorBanner error={error} />}
      {busy ? <PageLoader label="Loading invoices…" /> : (
        <div className="table-wrap card">
          <table className="data">
            <thead>
              <tr>
                <th>Number</th>
                <th>Customer</th>
                <th>Invoice date</th>
                <th>Due date</th>
                <th className="cell-num">Total</th>
                <th className="cell-num">Amount due</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const id = Number(row.id);
                const overdue = rowOverdue(row);
                return (
                  <tr key={id} className="row-click" onClick={() => navigate(`/sales/invoices/${id}`)}>
                    <td className="cell-mono">{String(row.invoiceNo ?? '')}</td>
                    <td>{String(row.customerName ?? '')}</td>
                    <td>{fmtDate(row.invoiceDate)}</td>
                    <td className={overdue ? 'sale-overdue' : undefined}>{row.dueDate ? fmtDate(row.dueDate) : '—'}</td>
                    <td className="cell-num">{fmtMoney(row.total)}</td>
                    <td className="cell-num">{fmtMoney(row.amountDue)}</td>
                    <td><Badge value={row.status} /></td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)', padding: 28 }}>No invoices in this view</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="pager">
        <span>{fmtNum(total)} invoices</span>
        <button className="btn btn-sm" type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
        <button className="btn btn-sm" type="button" disabled={page * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)}>Next ›</button>
      </div>
    </div>
  );
}
