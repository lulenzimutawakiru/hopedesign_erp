import { useEffect, useState } from 'react';

function rawHashValue(): string {
  return window.location.hash.replace(/^#/, '');
}

function hashRoutePath(): string {
  const h = rawHashValue();
  if (!h.startsWith('/')) return '';
  return h.split('?')[0] || '/dashboard';
}

/**
 * Resolve the current route. The ERP normally routes through the hash, but the
 * public verify/invite portals are reached without a session through plain
 * pathname URLs such as /verify#doc=TOKEN or /invite?token=..., so when no hash
 * route exists we fall back to the pathname for those public surfaces.
 */
export function currentPath(): string {
  const route = hashRoutePath();
  if (route) return route;
  const pathname = window.location.pathname.replace(/\/+$/, '');
  if (pathname === '/verify' || pathname.endsWith('/verify')) return '/verify';
  if (pathname === '/invite' || pathname.endsWith('/invite')) return '/invite';
  return '/dashboard';
}

export function currentQuery(): URLSearchParams {
  const h = rawHashValue();
  const qs = h.split('?')[1] ?? '';
  if (qs) return new URLSearchParams(qs);
  // Public pages may carry the query on the pathname (e.g. /invite?token=...).
  return new URLSearchParams(window.location.search);
}

/** Minimal hash router: returns the normalized path (no leading '#' or query). */
export function useHashRoute(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onHash = () => setPath(currentPath());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return path;
}

export function useHashQuery(): URLSearchParams {
  const [q, setQ] = useState(currentQuery);
  useEffect(() => {
    const onHash = () => setQ(currentQuery());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return q;
}

export function navigate(path: string, opts?: { replace?: boolean; query?: Record<string, string | number | undefined> }) {
  let hash = path.startsWith('#') ? path.slice(1) : path;
  if (opts?.query) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== '') q.set(k, String(v));
    }
    const s = q.toString();
    if (s) hash += (hash.includes('?') ? '&' : '?') + s;
  }
  if (opts?.replace) {
    const url = `${location.pathname}${location.search}#${hash}`;
    history.replaceState(null, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  window.location.hash = hash;
}

export interface RouteMatch {
  segments: string[];
}

export function matchRoute(path: string, pattern: string): RouteMatch | null {
  const parts = path.split('/').filter(Boolean);
  const pat = pattern.split('/').filter(Boolean);
  if (parts.length !== pat.length) return null;
  for (let i = 0; i < pat.length; i++) {
    if (pat[i].startsWith(':') || pat[i] === parts[i]) continue;
    return null;
  }
  return { segments: parts };
}
