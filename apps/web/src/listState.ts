export interface ListState {
  q: string;
  page: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  tab?: string;
  scrollY?: number;
  extras?: Record<string, string>;
}

const prefix = 'hope.os.list.';

export function listKey(path: string): string {
  return path.split('?')[0].replace(/\/\d+$/, '') || '/';
}

export function saveListState(path: string, state: ListState) {
  try {
    sessionStorage.setItem(prefix + listKey(path), JSON.stringify(state));
  } catch { /* ignore */ }
}

export function loadListState(path: string): ListState | null {
  try {
    const raw = sessionStorage.getItem(prefix + listKey(path));
    if (!raw) return null;
    return JSON.parse(raw) as ListState;
  } catch {
    return null;
  }
}

export function listHref(path: string): string {
  const st = loadListState(path);
  if (!st) return path;
  const q = new URLSearchParams();
  if (st.q) q.set('q', st.q);
  if (st.page && st.page > 1) q.set('page', String(st.page));
  if (st.tab) q.set('tab', st.tab);
  if (st.sort) q.set('sort', st.sort);
  if (st.dir) q.set('dir', st.dir);
  if (st.extras) {
    for (const [k, v] of Object.entries(st.extras)) if (v) q.set(k, v);
  }
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}
