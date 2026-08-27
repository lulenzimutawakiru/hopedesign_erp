export type Theme = 'light' | 'dark' | 'system';
export type Density = 'compact' | 'comfortable' | 'spacious';

export interface Prefs {
  theme: Theme;
  density: Density;
  sidebarCollapsed: boolean;
  focusMode: boolean;
  favorites: string[];
  recents: { href: string; label: string; at: number }[];
  savedFilters: Record<string, { name: string; q: string }[]>;
}

const KEY = 'hope.os.prefs';

const DEFAULTS: Prefs = {
  theme: 'system',
  density: 'comfortable',
  sidebarCollapsed: false,
  focusMode: false,
  favorites: [],
  recents: [],
  savedFilters: {},
};

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(p: Partial<Prefs>): Prefs {
  const next = { ...loadPrefs(), ...p };
  localStorage.setItem(KEY, JSON.stringify(next));
  applyPrefs(next);
  return next;
}

export function applyPrefs(p: Prefs = loadPrefs()) {
  const root = document.documentElement;
  const dark = p.theme === 'dark' || (p.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.density = p.density;
  root.dataset.sidebar = p.sidebarCollapsed ? 'collapsed' : 'expanded';
  root.dataset.focus = p.focusMode ? 'on' : 'off';
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute('content', dark ? '#08131F' : '#0B1F33');
}

export function toggleFavorite(href: string): Prefs {
  const p = loadPrefs();
  const favorites = p.favorites.includes(href) ? p.favorites.filter((h) => h !== href) : [...p.favorites, href];
  return savePrefs({ favorites });
}

export function pushRecent(href: string, label: string): Prefs {
  const p = loadPrefs();
  const recents = [{ href, label, at: Date.now() }, ...p.recents.filter((r) => r.href !== href)].slice(0, 8);
  return savePrefs({ recents });
}
