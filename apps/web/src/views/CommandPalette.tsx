import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { COMMANDS, interpretCommand } from '../work';

interface Destination {
  id: string;
  label: string;
  hint: string;
  href: string;
  haystack: string;
}
import {
  NAV_GROUPS,
  hrefForSearchHit,
  itemVisible,
  labelForSearchHit,
  looksLikeQr,
  track,
} from '../nav';

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

  // Every navigable destination the signed-in user can reach. This makes the
  // palette the single search entry point for the whole ERP (Ctrl/Cmd+K).
  const destinations = useMemo<Destination[]>(() => {
    const out: Destination[] = [];
    for (const g of NAV_GROUPS) {
      for (const item of g.items) {
        if (itemVisible(user, item)) {
          out.push({
            id: `nav-${item.id}`,
            label: item.label,
            hint: g.label,
            href: item.href,
            haystack: `${item.label} ${item.keywords ?? ''} ${g.label}`.toLowerCase(),
          });
        }
        for (const c of item.children ?? []) {
          if (!itemVisible(user, { ...c, module: item.module })) continue;
          out.push({
            id: `nav-${item.id}-${c.id}`,
            label: c.label,
            hint: c.group ? `${item.label} \u00B7 ${c.group}` : item.label,
            href: c.href,
            haystack: `${c.label} ${c.keywords ?? ''} ${c.group ?? ''} ${item.label} ${item.keywords ?? ''}`.toLowerCase(),
          });
        }
      }
    }
    return out;
  }, [user]);

  const navMatches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    const seen = new Set<string>();
    return destinations.filter((d) => d.haystack.includes(s)).filter((d) => {
      if (seen.has(d.href)) return false;
      seen.add(d.href);
      return true;
    }).slice(0, 6);
  }, [q, destinations]);

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

  const actionHrefs = new Set(actions.map((x) => x.href));
  const navOnly = navMatches.filter((d) => !actionHrefs.has(d.href));
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
          placeholder="Search invoice, journal, voucher, supplier, account code…"
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
          {navOnly.map((d) => (
            <button key={d.id} className="cmd-item" onClick={() => go(d.href)}>
              <strong>{d.label}</strong>
              <span>{d.hint}</span>
            </button>
          ))}
          {hits.map((g) => (
            <div key={g.table}>
              <div className="search-group-label">{g.label}</div>
              {g.matches.map((m) => {
                const t = labelForSearchHit(String(g.table), m);
                return (
                  <button
                    key={`${g.table}-${m.id}`}
                    className="cmd-item"
                    onClick={() => go(hrefForSearchHit(String(g.table), m))}
                  >
                    <strong>{t.primary}</strong>
                    <span>{t.secondary ? `${g.label} \u00B7 ${t.secondary}` : g.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {actions.length === 0 && hits.length === 0 && navOnly.length === 0 && (
            <div className="search-hint">Nothing matches. Try an invoice, journal, voucher or account code.</div>
          )}
        </div>
      </div>
    </div>
  );
}
