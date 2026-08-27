import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { EntityMeta } from '../api';
import { fmtBool, fmtDate, fmtMoney, fmtNum } from '../api';
import { pick, titleCase } from '../helpers';
import { Badge } from './ui';
import { EmptyState } from './os';
import { loadPrefs } from '../prefs';

const HIDDEN = new Set([
  'id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'attributes', 'secret_hash',
  'tenant_id', 'company_id', 'branch_id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy',
  'tenantId', 'companyId', 'branchId',
]);

export function pickColumns(meta: EntityMeta, max = 7): string[] {
  const cols: string[] = [];
  const push = (name: string) => {
    if (!name || HIDDEN.has(name) || cols.includes(name)) return;
    cols.push(name);
  };
  if (meta.codeColumn) push(meta.codeColumn);
  push('name');
  push('code');
  if (meta.statusColumn) push(meta.statusColumn);
  const preferred = meta.columns.filter((c) => {
    if (HIDDEN.has(c.name) || HIDDEN.has(c.camel)) return false;
    if (c.name.endsWith('_at') || c.name.endsWith('_by')) return false;
    if (c.name.endsWith('_id') && !['customer_id', 'product_id', 'supplier_id'].includes(c.name)) return false;
    return true;
  });
  for (const c of preferred) {
    if (cols.length >= max) break;
    push(c.name);
  }
  if (cols.length === 0) {
    for (const c of meta.columns) {
      if (cols.length >= max) break;
      push(c.name);
    }
  }
  if (cols.length === 0) push('id');
  return cols.slice(0, max);
}

function camelOf(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function cellValue(row: Record<string, unknown>, name: string): unknown {
  return pick(row, name, camelOf(name));
}

function isNum(name: string): boolean {
  return /(amount|total|subtotal|tax|qty|quantity|price|cost|value|weight|rate|count|balance|limit|percent|_id$)/.test(name);
}

function fmtCell(name: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'boolean') return fmtBool(value);
  if (name === 'id' || /_id$/.test(name)) return String(value);
  if (/date|_at|time/i.test(name)) return fmtDate(value);
  if (isNum(name) && typeof value === 'string' && /^-?\d/.test(value)) {
    if (/amount|total|subtotal|tax|price|cost|value|balance|limit|rate/.test(name)) return fmtMoney(value);
    return fmtNum(value);
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function DataTable({
  meta,
  rows,
  onOpen,
  onCreate,
  emptyTitle,
  emptyBody,
  onLoadMore,
  hasMore,
  loadingMore,
}: {
  meta: EntityMeta;
  rows: Record<string, unknown>[];
  onOpen: (id: number) => void;
  onCreate?: () => void;
  emptyTitle?: string;
  emptyBody?: string;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
}) {
  const all = useMemo(() => pickColumns(meta, 10), [meta]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' } | null>(null);
  const [filter, setFilter] = useState('');
  const [showCols, setShowCols] = useState(false);
  const columns = all.filter((c) => !hidden.includes(c));
  const density = loadPrefs().density;
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [view, setView] = useState<'table' | 'cards'>(() => (typeof window !== 'undefined' && window.innerWidth < 768 ? 'cards' : 'table'));
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!onLoadMore || !hasMore) return;
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !loadingMore) onLoadMore();
    }, { rootMargin: '240px' });
    io.observe(el);
    return () => io.disconnect();
  }, [onLoadMore, hasMore, rows.length]);

  const startResize = (col: string, ev: ReactMouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startW = widths[col] ?? 140;
    const onMove = (e: globalThis.MouseEvent) => {
      setWidths((w) => ({ ...w, [col]: Math.max(72, startW + e.clientX - startX) }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let list = rows;
    if (q) {
      list = list.filter((row) => columns.some((c) => String(cellValue(row, c) ?? '').toLowerCase().includes(q)));
    }
    if (sort) {
      list = [...list].sort((a, b) => {
        const va = cellValue(a, sort.col);
        const vb = cellValue(b, sort.col);
        const cmp = String(va ?? '').localeCompare(String(vb ?? ''), undefined, { numeric: true });
        return sort.dir === 'asc' ? cmp : -cmp;
      });
    }
    return list;
  }, [rows, filter, sort, columns]);

  const toggleSort = (c: string) => {
    setSort((s) => !s || s.col !== c ? { col: c, dir: 'asc' } : s.dir === 'asc' ? { col: c, dir: 'desc' } : null);
  };

  if (rows.length === 0) {
    return (
      <EmptyState
        title={emptyTitle ?? `No ${meta.label.toLowerCase()}s`}
        body={emptyBody ?? 'Nothing matches this view. Create a record or clear filters.'}
        action={onCreate ? `New ${meta.label}` : undefined}
        onAction={onCreate}
      />
    );
  }

  return (
    <div>
      <div className="toolbar">
        <input className="search-input" placeholder="Filter this page…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn btn-sm hide-phone" onClick={() => setShowCols((v) => !v)}>Columns</button>
        <button className="btn btn-sm" onClick={() => setView((v) => v === 'table' ? 'cards' : 'table')}>{view === 'table' ? 'Cards' : 'Table'}</button>
        {showCols && (
          <div className="col-pop">
            {all.map((c) => (
              <label key={c} className="filter-check">
                <input type="checkbox" checked={!hidden.includes(c)} onChange={() => setHidden((h) => h.includes(c) ? h.filter((x) => x !== c) : [...h, c])} />
                {titleCase(c.replace(/Id$/, ''))}
              </label>
            ))}
          </div>
        )}
      </div>
      {view === 'cards' && (
        <div className="record-cards">
          {visible.map((row) => {
            const id = Number(row.id);
            const titleCol = columns[0];
            const subCol = columns[1];
            return (
              <button key={id} className="record-card" onClick={() => onOpen(id)}>
                <div className="record-card-top">
                  <strong className="cell-mono">{fmtCell(titleCol, cellValue(row, titleCol))}</strong>
                  {meta.statusColumn && <Badge value={cellValue(row, meta.statusColumn)} />}
                </div>
                {subCol && <div>{fmtCell(subCol, cellValue(row, subCol))}</div>}
                <div className="record-card-meta muted">
                  {columns.slice(2, 5).map((c) => (
                    <span key={c}>{titleCase(c.replace(/Id$/, ''))}: {fmtCell(c, cellValue(row, c))}</span>
                  ))}
                </div>
                <span className="btn btn-sm">View</span>
              </button>
            );
          })}
        </div>
      )}
      {view === 'table' && <div className={`table-wrap density-${density}`}>
        <table className="data">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c} style={widths[c] ? { width: widths[c], minWidth: widths[c] } : { minWidth: 96 }}>
                  <button className="th-btn" onClick={() => toggleSort(c)}>
                    {titleCase(c.replace(/Id$/, ''))}
                    {sort?.col === c ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </button>
                  <span className="col-resizer" onMouseDown={(e) => startResize(c, e)} />
                </th>
              ))}
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const id = Number(row.id);
              return (
                <tr key={id} className="row-click" onClick={() => onOpen(id)}>
                  {columns.map((c) => {
                    const value = cellValue(row, c);
                    return (
                      <td key={c} className={c === meta.statusColumn ? undefined : isNum(c) ? 'cell-num' : undefined}>
                        {c === meta.statusColumn ? (
                          <Badge value={value} />
                        ) : c === meta.codeColumn ? (
                          <span className="cell-mono">{fmtCell(c, value)}</span>
                        ) : (
                          fmtCell(c, value)
                        )}
                      </td>
                    );
                  })}
                  <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                    <button className="btn btn-sm" onClick={() => onOpen(id)}>Open</button>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={columns.length + 1}>
                  <EmptyState title="No rows on this page" body="The filter hid every row." action="Clear filter" onAction={() => setFilter('')} />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>}
      {hasMore && <div ref={sentinel} className="infinite-sent">{loadingMore ? 'Loading more…' : 'Scroll for more'}</div>}
    </div>
  );
}
