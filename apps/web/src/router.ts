import { useEffect, useState } from 'react';

function rawHash(): string {
  return window.location.hash.replace(/^#/, '') || '/dashboard';
}

export function currentPath(): string {
  return rawHash().split('?')[0] || '/dashboard';
}

export function currentQuery(): URLSearchParams {
  const qs = rawHash().split('?')[1] ?? '';
  return new URLSearchParams(qs);
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
