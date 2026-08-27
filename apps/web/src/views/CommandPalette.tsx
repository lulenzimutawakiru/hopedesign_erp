import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { COMMANDS, interpretCommand } from '../work';
import { hrefForSearchHit, looksLikeQr, track } from '../nav';

interface SearchHit {
  label: string;
  table: string;
  matches: Record<string, unknown>[];
}

export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);

  const actions = useMemo(
    () => COMMANDS.filter((c) => !c.perm || can(user, c.perm)).filter((c) => {
      const s = q.trim().toLowerCase();
      if (s.length < 1) return true;
      return (c.label + c.hint + c.keywords).toLowerCase().includes(s);
    }),
    [q, user]
  );

  useEffect(() => {
    if (!open) { setQ(''); setHits([]); setActive(0); return; }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((n) => n + 1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((n) => Math.max(0, n - 1)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => {
      api<{ data: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q.trim())}&limit=5`)
        .then((r) => setHits(r.data ?? []))
        .catch(() => setHits([]));
    }, 180);
    return () => clearTimeout(t);
  }, [open, q]);

  if (!open) return null;

  const go = (href: string) => {
    track('command', { href });
    onClose();
    navigate(href);
  };

  const nl = interpretCommand(q);
  const qrGuess = looksLikeQr(q) ? `/qr/${q.trim()}` : null;

  return (
    <div className="cmd-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmd-box" role="dialog" aria-label="Command palette">
        <input
          autoFocus
          value={q}
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (qrGuess) go(qrGuess);
              else if (nl) go(nl);
              else if (actions[active]) go(actions[active].href);
            }
          }}
          placeholder="Search or type a command…"
          aria-label="Command"
        />
        <div className="cmd-list">
          {qrGuess && (
            <button className="cmd-item active" onClick={() => go(qrGuess)}>
              <strong>QR / trace {q.trim()}</strong>
              <span>Open authorized traceability</span>
            </button>
          )}
          {nl && (
            <button className="cmd-item" onClick={() => go(nl)}>
              <strong>Understood: {q}</strong>
              <span>Open that view</span>
            </button>
          )}
          {actions.map((a, i) => (
            <button
              key={a.id}
              className={`cmd-item ${i === active ? 'active' : ''}`}
              onClick={() => go(a.href)}
            >
              <strong>{a.label}</strong>
              <span>{a.hint}</span>
            </button>
          ))}
          {hits.map((g) => (
            <div key={g.table}>
              <div className="search-group-label">{g.label}</div>
              {g.matches.map((m) => (
                <button
                  key={`${g.table}-${m.id}`}
                  className="cmd-item"
                  onClick={() => go(hrefForSearchHit(String(g.table), m))}
                >
                  <strong>{String(m.code ?? m.order_no ?? m.quotation_no ?? m.name ?? m.id)}</strong>
                  <span>{g.label}</span>
                </button>
              ))}
            </div>
          ))}
          {actions.length === 0 && hits.length === 0 && <div className="search-hint">Nothing matches.</div>}
        </div>
      </div>
    </div>
  );
}
