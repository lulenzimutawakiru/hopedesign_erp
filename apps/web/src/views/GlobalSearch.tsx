import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';

interface SearchHit {
  label: string;
  table: string;
  matches: Record<string, unknown>[];
}

export default function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => {
    const t = setTimeout(async () => {
      const term = q.trim();
      if (term.length < 2) {
        setResults([]);
        return;
      }
      setBusy(true);
      try {
        const r = await api<{ data: SearchHit[] }>(`/api/search?q=${encodeURIComponent(term)}&limit=6`);
        setResults(r.data);
      } catch {
        setResults([]);
      } finally {
        setBusy(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const count = results.reduce((n, r) => n + r.matches.length, 0);

  const openRecord = (table: string, match: Record<string, unknown>) => {
    setOpen(false);
    setQ('');
    navigate(`/records/${table}/${String(match.id)}`);
  };

  return (
    <div className="global-search" ref={ref}>
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Search customers, orders, QR codes, machines…  ( / )"
        className="search-input"
      />
      {open && q.trim().length >= 2 && (
        <div className="search-dropdown">
          {busy && <div className="search-hint">Searching…</div>}
          {!busy && count === 0 && <div className="search-hint">No matches for “{q}”</div>}
          {results.map((r) => (
            <div key={r.table} className="search-group">
              <div className="search-group-label">{r.label}</div>
              {r.matches.map((m) => (
                <button key={String(m.id)} className="search-item" onClick={() => openRecord(r.table, m)}>
                  <span className="search-item-title">
                    {String(m[r.label === 'Product' ? 'name' : 'code'] ?? m.id ?? '')}
                  </span>
                  <span className="search-item-sub">
                    {String(m.name ?? m.customer_name ?? m.supplier_name ?? '')} · #{String(m.id)}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
