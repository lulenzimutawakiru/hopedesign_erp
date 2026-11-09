import { useMemo, useState } from 'react';
import { downloadReport } from '../api';

/**
 * Reusable reporting furniture shared by the accounting report views:
 * a branded export/print menu, date-range presets, and a client-side
 * sortable column header. These mirror the list-screen furniture already used
 * across the finance module so every report reads as one system.
 */

type ReportFormat = 'pdf' | 'xlsx' | 'csv' | 'print';

/** Branded PDF / Excel / CSV export + print window for a computed report. */
export function ReportExportMenu({
  reportKey,
  filename,
  params,
  disabled,
  onError,
}: {
  reportKey: string;
  filename: string;
  params: URLSearchParams | (() => URLSearchParams);
  disabled?: boolean;
  onError?: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ReportFormat | null>(null);
  const [error, setError] = useState('');
  const run = async (fmt: ReportFormat) => {
    setBusy(fmt);
    setOpen(false);
    setError('');
    try {
      const p = typeof params === 'function' ? params() : params;
      await downloadReport(reportKey, p, fmt, filename);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      onError?.(msg);
    } finally {
      setBusy(null);
    }
  };
  const items: Array<{ id: ReportFormat; label: string; hint: string }> = [
    { id: 'pdf', label: 'PDF', hint: 'Branded document' },
    { id: 'xlsx', label: 'Excel (.xlsx)', hint: 'Formatted workbook' },
    { id: 'csv', label: 'CSV', hint: 'Raw rows' },
  ];
  return (
    <div style={{ position: 'relative', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      <button className="btn btn-sm" type="button" disabled={disabled || busy === 'print'} onClick={() => run('print')}>
        {busy === 'print' ? 'Opening…' : 'Print'}
      </button>
      <button
        className="btn btn-sm"
        type="button"
        aria-expanded={open}
        disabled={disabled || busy != null}
        onClick={() => setOpen((v) => !v)}
      >
        {busy && busy !== 'print' ? 'Preparing…' : 'Export'}
      </button>
      {error && (
        <span role="alert" style={{ position: 'absolute', top: 34, right: 0, maxWidth: 280, fontSize: 12, color: 'var(--danger)', whiteSpace: 'normal' }}>
          {error}
        </span>
      )}
      {open && (
        <div className="topbar-dropdown" style={{ top: 36, minWidth: 190, right: 0 }}>
          <div className="dropdown-head">Export as</div>
          {items.map((f) => (
            <button key={f.id} className="search-item" onClick={() => run(f.id)}>
              <span className="search-item-title">{f.label}</span>
              <span className="search-item-sub">{f.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Date-range presets
// ---------------------------------------------------------------------------

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Today's date (local) as YYYY-MM-DD. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface DatePreset {
  key: string;
  label: string;
  from: string;
  to: string;
}

/** Standard reporting ranges, always in the local calendar. */
export function reportPresets(): DatePreset[] {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const firstOfMonth = new Date(y, m, 1);
  const firstOfLastMonth = new Date(y, m - 1, 1);
  const lastOfLastMonth = new Date(y, m, 0);
  return [
    { key: 'this-month', label: 'This month', from: iso(firstOfMonth), to: today() },
    { key: 'last-month', label: 'Last month', from: iso(firstOfLastMonth), to: iso(lastOfLastMonth) },
    { key: 'this-year', label: 'This year', from: `${y}-01-01`, to: today() },
    { key: 'last-year', label: 'Last year', from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
    { key: 'all', label: 'All time', from: '', to: '' },
  ];
}

/** A row of tappable range chips that set the from/to filter. */
export function DatePresets({
  onApply,
  active,
}: {
  onApply: (from: string, to: string) => void;
  active?: string;
}) {
  const presets = reportPresets();
  return (
    <div className="preset-row" role="group" aria-label="Date range presets">
      {presets.map((p) => {
        const isActive = active === p.key;
        return (
          <button
            key={p.key}
            type="button"
            className={'preset-chip' + (isActive ? ' is-on' : '')}
            aria-pressed={isActive}
            onClick={() => onApply(p.from, p.to)}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Client-side sort
// ---------------------------------------------------------------------------

export type SortDir = 'asc' | 'desc';

export function useClientSort<T extends Record<string, unknown>>(rows: T[]) {
  const [sortBy, setSortBy] = useState<string>('');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const sorted = useMemo(() => {
    if (!sortBy) return rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[sortBy];
      const bv = b[sortBy];
      const an = Number(av);
      const bn = Number(bv);
      const bothNumeric =
        av != null && av !== '' && bv != null && bv !== '' && Number.isFinite(an) && Number.isFinite(bn);
      const cmp = bothNumeric ? an - bn : String(av ?? '').localeCompare(String(bv ?? ''));
      return cmp * dir;
    });
  }, [rows, sortBy, sortDir]);
  const toggle = (col: string) => {
    if (sortBy !== col) {
      setSortBy(col);
      setSortDir('asc');
      return;
    }
    if (sortDir === 'asc') {
      setSortDir('desc');
      return;
    }
    setSortBy('');
    setSortDir('asc');
  };
  return { sorted, sortBy, sortDir, toggle };
}

/** A sortable <th> that reuses the finance list-screen `.th-btn` convention. */
export function SortableTh({
  col,
  label,
  sortBy,
  sortDir,
  onSort,
  numeric,
}: {
  col: string;
  label: string;
  sortBy: string;
  sortDir: SortDir;
  onSort: (col: string) => void;
  numeric?: boolean;
}) {
  const active = sortBy === col;
  return (
    <th
      className={numeric ? 'cell-num' : ''}
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button className="th-btn" title={`Sort by ${label.toLowerCase()}`} onClick={() => onSort(col)}>
        {label}
        {active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  );
}
