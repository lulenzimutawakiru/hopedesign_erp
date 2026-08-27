import { useEffect, useState } from 'react';
import { api, getToken, fmtDate } from '../api';
import { ErrorBanner } from '../components/ui';

interface ExportTable {
  table: string;
  label: string;
}

interface HistoryRow {
  id: number;
  action: string;
  resource: string;
  user: string | null;
  email: string | null;
  tenantCode: string | null;
  tenantName: string | null;
  companyCode: string | null;
  companyName: string | null;
  branchCode: string | null;
  branchName: string | null;
  format: string | null;
  rows: number | null;
  recordCode: string | null;
  ip: string | null;
  createdAt: string;
}

const FORMATS = [
  { id: 'csv', label: 'CSV', mime: 'text/csv' },
  { id: 'xlsx', label: 'Excel (XLSX)', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { id: 'json', label: 'JSON', mime: 'application/json' },
  { id: 'pdf', label: 'PDF', mime: 'application/pdf' },
  { id: 'print', label: 'Print', mime: 'text/html' },
];

export default function DataExports() {
  const [tables, setTables] = useState<ExportTable[]>([]);
  const [table, setTable] = useState('');
  const [includeTenant, setIncludeTenant] = useState(true);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refreshHistory = async () => {
    try {
      const r = await api<{ data: HistoryRow[] }>('/api/import-export/exports/history');
      setHistory(r.data);
    } catch {
      /* history is secondary - do not surface errors here */
    }
  };

  useEffect(() => {
    api<{ data: ExportTable[] }>('/api/import-export/exports/tables')
      .then((r) => {
        setTables(r.data);
        if (r.data[0]) setTable(r.data[0].table);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load export tables'));
    refreshHistory();
  }, []);

  const download = async (fmt: string) => {
    if (!table) return;
    setBusy(true);
    setError('');
    try {
      const q =
        '/api/import-export/exports/' +
        encodeURIComponent(table) +
        '?format=' +
        fmt +
        (includeTenant ? '&includeTenant=1' : '');
      const res = await fetch(q, { headers: { Authorization: 'Bearer ' + (getToken() ?? '') } });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body && body.error && body.error.message ? body.error.message : 'Export failed (' + res.status + ')');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (fmt === 'print') {
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = table + '_export_' + Date.now() + '.' + (fmt === 'xlsx' ? 'xlsx' : fmt);
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
      refreshHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>Data Export</h1>
        <p className="muted">Export any table in CSV, Excel, JSON or branded PDF, or open a print-ready view. Every export and print is audited.</p>
      </header>
      {error && <ErrorBanner error={error} />}

      <div className="card">
        <div className="card-head">
          <h3>New export</h3>
        </div>
        <div className="form-grid" style={{ gridTemplateColumns: 'minmax(220px, 340px) auto auto auto auto auto' }}>
          <label>
            <span>Table</span>
            <select value={table} onChange={(e) => setTable(e.target.value)}>
              {tables.map((t) => (
                <option key={t.table} value={t.table}>
                  {t.label} ({t.table})
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>&nbsp;</span>
            <label className="check">
              <input type="checkbox" checked={includeTenant} onChange={(e) => setIncludeTenant(e.target.checked)} />
              Include tenant info
            </label>
          </div>
          {FORMATS.map((f) => (
            <div className="field" key={f.id}>
              <span>&nbsp;</span>
              <button className="btn" disabled={!table || busy} onClick={() => download(f.id)}>
                {busy ? 'Exporting…' : `Export ${f.label}`}
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Export &amp; print history</h3>
          <button className="btn btn-sm" onClick={refreshHistory}>Refresh</button>
        </div>
        {history.length === 0 ? (
          <p className="muted" style={{ padding: 12 }}>No exports or prints recorded yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Resource</th>
                <th>Format</th>
                <th>Rows</th>
                <th>Tenant</th>
                <th>Company</th>
                <th>Branch</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{fmtDate(h.createdAt)}</td>
                  <td>{h.user ?? h.email ?? '-'}</td>
                  <td><span className="badge">{h.action}</span></td>
                  <td>{h.resource}</td>
                  <td>{h.format ?? '-'}</td>
                  <td>{h.rows ?? '-'}</td>
                  <td>{h.tenantCode ? `${h.tenantCode} · ${h.tenantName ?? ''}` : '-'}</td>
                  <td>{h.companyCode ? `${h.companyCode} · ${h.companyName ?? ''}` : '-'}</td>
                  <td>{h.branchCode ? `${h.branchCode} · ${h.branchName ?? ''}` : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
