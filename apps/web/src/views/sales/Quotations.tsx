import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, fmtMoney, fmtNum } from '../../api';
import { useAuth, can } from '../../auth';
import { navigate } from '../../router';
import { Badge, ErrorBanner, PageLoader } from '../../components/ui';

type Rec = Record<string, unknown>;
type Scope = 'my' | 'open' | 'all';

const SCOPES: { id: Scope; label: string }[] = [
  { id: 'my', label: 'My Quotations' },
  { id: 'open', label: 'Quotations' },
  { id: 'all', label: 'All' },
];

/** Odoo 19 Sales opens on the quotation list, filtered to the current salesperson. */
export default function Quotations() {
  const { user } = useAuth();
  const [scope, setScope] = useState<Scope>('my');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: '40', scope });
    if (q.trim()) params.set('q', q.trim());
    const r = await api<{ data: { rows: Rec[]; total: number } }>(`/api/ops/sales/quotations?${params.toString()}`);
    setRows(r.data.rows ?? []);
    setTotal(Number(r.data.total ?? 0));
  }, [page, q, scope]);

  useEffect(() => {
    setBusy(true);
    load()
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load quotations'))
      .finally(() => setBusy(false));
  }, [load]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="sales">Sales</p>
          <h1>Quotations</h1>
          <p className="muted">A quotation becomes a sales order when it is confirmed.</p>
        </div>
        <div className="head-actions">
          {can(user, 'sales.quotations.create') && (
            <button className="btn btn-primary" type="button" onClick={() => navigate('/sales/quotations/new')}>New</button>
          )}
        </div>
      </header>
      <div className="toolbar toolbar-sticky">
        <div className="toolbar-left">
          <div className="preset-row" role="tablist" aria-label="Quotation filters">
            {SCOPES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`preset-chip${scope === item.id ? ' is-on' : ''}`}
                onClick={() => { setScope(item.id); setPage(1); }}
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
      {busy ? <PageLoader label="Loading quotations…" /> : (
        <div className="table-wrap card">
          <table className="data">
            <thead>
              <tr>
                <th>Number</th>
                <th>Quotation date</th>
                <th>Customer</th>
                <th>Salesperson</th>
                <th>Expiration</th>
                <th className="cell-num">Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const id = Number(row.id);
                return (
                  <tr key={id} className="row-click" onClick={() => navigate(`/sales/quotations/${id}`)}>
                    <td className="cell-mono">{String(row.quotationNo ?? '')}</td>
                    <td>{fmtDate(row.quotationDate)}</td>
                    <td>{String(row.customerName ?? '')}</td>
                    <td>{String(row.salespersonName ?? '') || '—'}</td>
                    <td>{row.validUntil ? fmtDate(row.validUntil) : '—'}</td>
                    <td className="cell-num">{fmtMoney(row.total)}</td>
                    <td><Badge value={row.status} /></td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)', padding: 28 }}>No quotations yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="pager">
        <span>{fmtNum(total)} quotations</span>
        <button className="btn btn-sm" type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
        <button className="btn btn-sm" type="button" disabled={page * 40 >= total} onClick={() => setPage((p) => p + 1)}>Next ›</button>
      </div>
    </div>
  );
}
