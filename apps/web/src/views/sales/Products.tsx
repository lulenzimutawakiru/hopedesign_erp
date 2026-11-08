import { useEffect, useMemo, useState } from 'react';
import { api, fmtMoney, fmtNum } from '../../api';
import { Badge, ErrorBanner, PageLoader } from '../../components/ui';

type Rec = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);

/** Sellable product catalogue, surfaced from the Sales app (Odoo Sales > Products). */
export default function SalesProducts() {
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/sales/products')
      .then((r) => setRows(Array.isArray(r.data) ? r.data : []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Products failed'));
  }, []);

  const filtered = useMemo(() => {
    if (!q.trim()) return rows;
    const s = q.trim().toLowerCase();
    return rows.filter((r) => `${r.code} ${r.name}`.toLowerCase().includes(s));
  }, [rows, q]);

  if (error) return <ErrorBanner error={error} />;
  if (!rows.length) return <PageLoader variant="page" label="Loading products…" />;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="mod-kicker" data-mod="sales">Sales</p>
          <h1>Products</h1>
          <p className="muted">Sellable catalogue — list price, cost and gross margin.</p>
        </div>
      </header>
      <div className="toolbar">
        <input className="search-input" placeholder="Search products…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search products" />
        <span className="muted">{filtered.length} products</span>
      </div>
      <div className="table-wrap card">
        <table className="data">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Type</th>
              <th className="cell-num">List price</th>
              <th className="cell-num">Cost</th>
              <th className="cell-num">Margin</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const price = n(r.listPrice ?? r.standardPrice);
              const cost = n(r.standardCost);
              const margin = price > 0 ? ((price - cost) / price) * 100 : null;
              return (
                <tr key={String(r.id)}>
                  <td className="cell-mono">{String(r.code)}</td>
                  <td>{String(r.name)}</td>
                  <td><Badge value={r.type} /></td>
                  <td className="cell-num">{fmtMoney(price)}</td>
                  <td className="cell-num">{fmtMoney(cost)}</td>
                  <td className="cell-num">{margin != null ? `${fmtNum(Math.round(margin))}%` : '—'}</td>
                </tr>
              );
            })}
            {filtered.length === 0 && <tr><td className="muted" colSpan={6}>No products match “{q}”.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ marginTop: 12 }}>List price reflects the product's standard price; customers on a price list see their assigned price when quoting.</p>
    </div>
  );
}
