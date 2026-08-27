import { useState } from 'react';
import { getToken } from '../api';

const FORMATS = [
  { id: 'print', label: 'Print' },
  { id: 'pdf', label: 'PDF' },
  { id: 'xlsx', label: 'Excel (XLSX)' },
  { id: 'csv', label: 'CSV' },
  { id: 'json', label: 'JSON' },
];

export default function DownloadMenu({
  type,
  id,
  code,
}: {
  type: string;
  id: number;
  code?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');

  const download = async (fmt: string) => {
    setBusy(fmt);
    try {
      const res = await fetch(`/api/documents/${type}/${id}?format=${fmt}`, {
        headers: { Authorization: 'Bearer ' + (getToken() ?? '') },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          body && body.error && body.error.message
            ? body.error.message
            : 'Download failed (' + res.status + ')'
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (fmt === 'print') {
        const win = window.open(url, '_blank');
        if (!win) {
          URL.revokeObjectURL(url);
          throw new Error('Popup blocked - allow popups for print.');
        }
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        setOpen(false);
        return;
      }
      const a = document.createElement('a');
      a.href = url;
      const safe = String(code ?? '').replace(/[^A-Za-z0-9._-]+/g, '_') || String(id);
      a.download = type + '_' + safe + '.' + fmt;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setOpen(false);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <button className="btn btn-sm" aria-expanded={open} disabled={Boolean(busy)} onClick={() => setOpen((v) => !v)}>
        {busy ? 'Downloading...' : 'Download'}
      </button>
      {open && (
        <div className="topbar-dropdown" style={{ top: 36, minWidth: 200 }}>
          <div className="dropdown-head">Export as</div>
          {FORMATS.map((f) => (
            <button key={f.id} className="search-item" onClick={() => download(f.id)}>
              <span className="search-item-title">{f.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
