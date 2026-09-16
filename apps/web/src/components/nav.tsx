import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { can, useAuth, type MeUser } from '../auth';
import { navigate } from '../router';
import { listHref } from '../listState';
import {
  type BadgeKind,
  type Breakpoint,
  type Crumb,
  type NavChild,
  type NavGroup,
  type NavItem,
  breakpointOf,
  childActive,
  crumbsFor,
  moduleActive,
  moduleChildrenFor,
  recordTabs,
  track,
  visibleGroups,
} from '../nav';
import { personaLabel, personaOf } from '../work';
import { StaffPhoto } from './ui';
import { BrandMark } from './BrandMark';
import { shortCompanyName } from '../company';
import { CreateMenu } from './os';

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(() => breakpointOf(window.innerWidth));
  useEffect(() => {
    const onResize = () => setBp(breakpointOf(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return bp;
}

export function useOnline(): boolean {
  const [on, setOn] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOn(true);
    const down = () => setOn(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return on;
}

export function SkipLink() {
  return (
    <a className="skip-link" href="#main-content">Skip to content</a>
  );
}

export function NetworkBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="net-banner" role="status">
      Offline — actions will not complete until the connection is restored.
    </div>
  );
}

export function AccessDenied({ path }: { path: string }) {
  return (
    <div className="page access-denied">
      <h1>This module is not available</h1>
      <p className="muted">You are signed in, but this view is outside your clearance or is not activated for the organisation. Identity administration lives under Administration → Users.</p>
      <p className="cell-mono muted">{path}</p>
      <div className="quick-actions">
        <button className="btn btn-primary" onClick={() => navigate('/dashboard')}>Return to my day</button>
        <button className="btn" onClick={() => history.back()}>Go back</button>
      </div>
    </div>
  );
}

export function Breadcrumbs({ path, extra, tail }: { path: string; extra?: Crumb[]; tail?: string }) {
  const items = crumbsFor(path, extra);
  if (tail) items.push({ label: tail });
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {items.map((it, i) => (
        <span key={`${it.label}-${i}`}>
          {i > 0 && <span className="crumb-sep">/</span>}
          {it.href && i < items.length - 1 ? (
            <button className="crumb-link" onClick={() => navigate(listHref(it.href!))}>{it.label}</button>
          ) : (
            <span aria-current={i === items.length - 1 ? 'page' : undefined}>{it.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function ModuleNav({ path, user }: { path: string; user: MeUser | null }) {
  const children = moduleChildrenFor(path, user);
  const navRef = useRef<HTMLElement>(null);
  const [sectionQuery, setSectionQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // The module root (for example /finance) is itself a child, so a plain prefix test
  // marked it active on every sub-page and produced two aria-current tabs. Only the
  // most specific matching child is the current page.
  const activeHref = children
    .filter((c) => childActive(c.href, path))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  const isActive = (href: string) => href === activeHref;
  const grouped = children.some((c) => c.group);
  // Large workspaces overflow the strip by 2-4x (Finance has 36 destinations, HR 44),
  // which strands most of them behind a scroll. Anything this big gets a section
  // filter, and grouped workspaces additionally collapse into their sections.
  const filterable = children.length > 12;
  const collapsible = grouped && filterable;
  const activeGroup = children.find((c) => c.href === activeHref)?.group ?? '';
  const needle = sectionQuery.trim().toLowerCase();
  // Filtering overrides collapse, and the section holding the current page can never
  // be hidden, so no destination becomes unreachable.
  const sectionOpen = (group: string) =>
    !collapsible || !!needle || group === activeGroup || collapsed[group] !== true;
  const matches = (c: NavChild) =>
    !needle || `${c.label} ${c.keywords ?? ''}`.toLowerCase().includes(needle);
  // Drop collapse and filter state when the user moves to another module, otherwise a
  // collapse made in Finance silently applies to any section name they share.
  const moduleKey = path.split('/')[1] ?? '';
  useEffect(() => {
    setCollapsed({});
    setSectionQuery('');
  }, [moduleKey]);
  // The strip scrolls horizontally and large workspaces such as Finance have more
  // sections than fit on screen, so bring the current destination into view.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const el = nav.querySelector(".tab[aria-current='page']") as HTMLElement | null;
    if (!el) return;
    const navRect = nav.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    if (elRect.left < navRect.left || elRect.right > navRect.right) {
      nav.scrollLeft += elRect.left - navRect.left - 12;
    }
  }, [activeHref, path, collapsed, sectionQuery]);
  if (children.length < 2) return null;
  const groups = new Map<string, number>();
  for (const c of children) {
    const g = c.group ?? '';
    groups.set(g, (groups.get(g) ?? 0) + 1);
  }
  // A single-item section that restates its own heading adds no orientation,
  // so the heading is dropped there ("Approvals Approvals" -> "Approvals").
  const redundantHeading = (g: string, label: string) =>
    groups.get(g) === 1 && g.trim().toLowerCase() === label.trim().toLowerCase();
  const groupsWithMatches = new Set(
    children.filter((c) => matches(c) && sectionOpen(c.group ?? '')).map((c) => c.group ?? ''),
  );
  const anyCollapsed = children.some((c) => !sectionOpen(c.group ?? ''));
  const toggleGroup = (g: string) => setCollapsed((prev) => ({ ...prev, [g]: prev[g] !== true }));
  let lastGroup = '';
  const tabs = children.map((c) => {
    const g = c.group ?? '';
    const open = sectionOpen(g);
    const visible = matches(c) && open;
    const heading =
      g && g !== lastGroup && groupsWithMatches.has(g) && !redundantHeading(g, c.label) ? g : '';
    lastGroup = g;
    return (
      <Fragment key={c.id}>
        {heading &&
          (collapsible ? (
            <button
              type="button"
              className="module-nav-group is-toggle"
              aria-expanded={open}
              title={open ? `Collapse ${heading}` : `Expand ${heading}`}
              onClick={() => toggleGroup(g)}
            >
              <span className="module-nav-caret" aria-hidden="true">
                {open ? '\u25be' : '\u25b8'}
              </span>
              {heading}
            </button>
          ) : (
            <span className="module-nav-group" aria-hidden="true">{heading}</span>
          ))}
        {visible && (
          <button
            className={`tab ${isActive(c.href) ? 'active' : ''}`}
            aria-current={isActive(c.href) ? 'page' : undefined}
            onClick={() => { track('module_nav', { href: c.href }); navigate(c.href); }}
          >
            {c.label}
          </button>
        )}
      </Fragment>
    );
  });
  const empty = needle && groupsWithMatches.size === 0;
  return (
    <div className="module-nav-wrap">
      {filterable && (
        <div className="module-nav-tools">
          <input
            className="module-nav-filter"
            type="search"
            value={sectionQuery}
            onChange={(e) => setSectionQuery(e.target.value)}
            placeholder="Filter sections"
            aria-label="Filter sections"
          />
          {collapsible && !needle && (
            <button
              type="button"
              className="module-nav-toggle"
              onClick={() =>
                setCollapsed(() =>
                  anyCollapsed
                    ? {}
                    : Object.fromEntries(
                        [...groups.keys()].filter((g) => g !== activeGroup).map((g) => [g, true]),
                      ),
                )
              }
            >
              {anyCollapsed ? 'Expand all' : 'Collapse all'}
            </button>
          )}
        </div>
      )}
      <nav
        ref={navRef}
        className={`module-nav${grouped ? ' module-nav-grouped' : ''}${needle ? ' is-filtering' : ''}`}
        aria-label="Module"
      >
        {tabs}
        {empty && (
          <span className="module-nav-empty" role="status">
            {`No sections match "${sectionQuery.trim()}"`}
          </span>
        )}
      </nav>
    </div>
  );
}

export function RecordNav({
  module,
  resource,
  tab,
  onTab,
}: {
  module: string;
  resource: string;
  tab: string;
  onTab: (id: string) => void;
}) {
  const tabs = recordTabs(module, resource);
  return (
    <nav className="module-nav record-nav" aria-label="Record">
      {tabs.map((t) => (
        <button
          key={t.id}
          className={`tab ${tab === t.id ? 'active' : ''}`}
          onClick={() => {
            if (t.href && t.id !== tab) navigate(t.href);
            else onTab(t.id);
          }}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}

export function StickyActions({ children }: { children: ReactNode }) {
  return <div className="sticky-actions">{children}</div>;
}

function badgeCount(kind: BadgeKind | undefined, counts: Record<string, number>): number {
  if (!kind) return 0;
  return counts[kind] ?? 0;
}

export function Sidebar({
  path,
  user,
  companyName,
  companyCode,
  companyLogo,
  collapsed,
  open,
  peek,
  onPeek,
  counts,
  favorites,
  recents,
  onNavigate,
  onToggle,
}: {
  path: string;
  user: MeUser | null;
  companyName?: string;
  companyCode?: string;
  companyLogo?: string;
  collapsed: boolean;
  open: boolean;
  peek: boolean;
  onPeek: (v: boolean) => void;
  counts: Record<string, number>;
  favorites: string[];
  recents: { href: string; label: string }[];
  onNavigate: (href: string) => void;
  onToggle: () => void;
}) {
  const groups = visibleGroups(user);
  const expanded = !collapsed || peek;
  const go = (href: string) => {
    track('nav_click', { href });
    onNavigate(href);
  };
  return (
    <aside
      className={`sidebar ${open ? 'sidebar-open' : ''} ${collapsed ? 'is-collapsed' : ''} ${peek ? 'is-peek' : ''}`}
      onMouseEnter={() => { if (collapsed) onPeek(true); }}
      onMouseLeave={() => { if (collapsed) onPeek(false); }}
      aria-label="Primary"
    >
      <div className="sidebar-brand" onClick={() => go('/dashboard')} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && go('/dashboard')}>
        <BrandMark size="md" logoUrl={companyLogo} />
        {expanded && (
          <div>
            <strong>{shortCompanyName(companyName || 'Company')}</strong>
            {companyCode ? <span className="brand-sub">{companyCode}</span> : null}
          </div>
        )}
      </div>
      {expanded && <div className="persona-chip">{personaLabel(personaOf(user))}</div>}
      <nav className="sidebar-nav">
        {favorites.length > 0 && (
          <>
            {expanded && <div className="nav-group-label">Pinned</div>}
            {favorites.map((href) => {
              const item = groups.flatMap((g) => g.items).find((i) => i.href === href);
              if (!item) return null;
              return (
                <NavButton key={`fav-${href}`} item={item} path={path} expanded={expanded} count={badgeCount(item.badge, counts)} onClick={() => go(item.href)} />
              );
            })}
          </>
        )}
        {groups.map((g) => (
          <NavGroupBlock key={g.id} group={g} path={path} expanded={expanded} counts={counts} onClick={go} />
        ))}
        {expanded && recents.length > 0 && (
          <>
            <div className="nav-group-label">Recent</div>
            {recents.slice(0, 5).map((r) => (
              <button key={r.href} className="nav-item" onClick={() => go(r.href)}>{r.label}</button>
            ))}
          </>
        )}
      </nav>
      <div className="sidebar-foot">
        <button className="btn btn-sm btn-ghost" onClick={onToggle} aria-pressed={collapsed} aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}>
          {expanded ? 'Collapse' : '»'}
        </button>
      </div>
    </aside>
  );
}

function NavGroupBlock({
  group,
  path,
  expanded,
  counts,
  onClick,
}: {
  group: NavGroup;
  path: string;
  expanded: boolean;
  counts: Record<string, number>;
  onClick: (href: string) => void;
}) {
  return (
    <div className="nav-group">
      {expanded && <div className="nav-group-label">{group.label}</div>}
      {group.items.map((item) => (
        <NavButton
          key={item.id}
          item={item}
          path={path}
          expanded={expanded}
          count={badgeCount(item.badge, counts)}
          onClick={() => onClick(item.href)}
        />
      ))}
    </div>
  );
}

function NavButton({
  item,
  path,
  expanded,
  count,
  onClick,
}: {
  item: NavItem;
  path: string;
  expanded: boolean;
  count: number;
  onClick: () => void;
}) {
  const active = moduleActive(item.href, path);
  return (
    <button
      data-mod={item.id}
      title={item.label}
      aria-current={active ? 'page' : undefined}
      className={`nav-item ${active ? 'nav-active' : ''}`}
      onClick={onClick}
    >
      <span className="nav-dot" aria-hidden />
      {expanded ? item.label : item.label.slice(0, 1)}
      {expanded && count > 0 && <span className="count-badge">{count}</span>}
      {!expanded && count > 0 && <span className="count-badge nav-dot-badge">{count > 9 ? '9+' : count}</span>}
    </button>
  );
}

export function MoreDrawer({
  open,
  onClose,
  path,
  user,
  counts,
  onNavigate,
  onScan,
}: {
  open: boolean;
  onClose: () => void;
  path: string;
  user: MeUser | null;
  counts: Record<string, number>;
  onNavigate: (href: string) => void;
  onScan: () => void;
}) {
  const groups = visibleGroups(user);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="more-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="more-drawer" role="dialog" aria-label="All modules">
        <div className="modal-head">
          <h3>Modules</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="drawer-body">
          <button className="handheld-scan" onClick={() => { onClose(); onScan(); }}>◉ Scan QR</button>
          {groups.map((g) => (
            <div key={g.id} className="nav-group">
              <div className="nav-group-label">{g.label}</div>
              {g.items.map((item) => (
                <button
                  key={item.id}
                  data-mod={item.id}
                  className={`nav-item more-item ${moduleActive(item.href, path) ? 'nav-active' : ''}`}
                  onClick={() => { onNavigate(item.href); onClose(); }}
                >
                  <span className="nav-dot" aria-hidden />
                  {item.label}
                  {badgeCount(item.badge, counts) > 0 && <span className="count-badge">{badgeCount(item.badge, counts)}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

export function MobileDock({
  path,
  onScan,
  onMore,
  taskCount,
}: {
  path: string;
  onScan: () => void;
  onMore: () => void;
  taskCount: number;
}) {
  return (
    <nav className="mobile-dock" aria-label="Primary mobile">
      <button className={path === '/dashboard' ? 'active' : ''} onClick={() => navigate('/dashboard')}>
        <span className="dock-ico" aria-hidden>⌂</span>Home
      </button>
      <button className={path === '/work' ? 'active' : ''} onClick={() => navigate('/work')}>
        <span className="dock-ico" aria-hidden>▣</span>Work
      </button>
      <button className="dock-scan" onClick={onScan} aria-label="Scan QR">
        <span className="dock-scan-orb">◉</span>Scan
      </button>
      <button className={path === '/inbox' || path === '/approvals' ? 'active' : ''} onClick={() => navigate('/inbox')}>
        <span className="dock-ico" aria-hidden>☑</span>Tasks
        {taskCount > 0 && <span className="count-badge">{taskCount}</span>}
      </button>
      <button className={path.startsWith('/people') ? 'active' : ''} onClick={onMore}>
        <span className="dock-ico" aria-hidden>☰</span>More
      </button>
    </nav>
  );
}

function ScopeRow({ k, v }: { k: string; v: string }) {
  if (!v || v === '—') return null;
  return (
    <div className="scope-row">
      <span>{k}</span>
      <strong>{v}</strong>
    </div>
  );
}

export function ScopeChip({ user }: { user: MeUser | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  if (!user) return null;
  const company = user.company_name ?? user.tenant_name ?? user.company_code ?? 'Company';
  const branch = user.branch_name ?? user.branch_code ?? '';
  const dept = user.department_name ?? user.department_code ?? '';
  return (
    <div className="scope-wrap" ref={ref}>
      <button
        type="button"
        className="scope-chip"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={[company, branch, dept].filter(Boolean).join(' · ')}
      >
        <span>{user.company_code ?? user.tenant_code ?? ''}</span>
        {user.branch_code || user.branch_name ? (
          <span className="muted"> · {user.branch_code ?? user.branch_name}</span>
        ) : null}
      </button>
      {open && (
        <div className="topbar-dropdown account-pop scope-pop" role="dialog" aria-label="Session scope">
          <div className="account-id" style={{ cursor: 'default' }}>
            <span className="account-avatar" aria-hidden>{(user.company_code ?? 'HD').slice(0, 2)}</span>
            <span className="account-id-copy">
              <strong>{company}</strong>
              <span>{[branch || 'All branches', dept || 'All departments'].join(' · ')}</span>
            </span>
          </div>
          <div className="account-sep" />
          <ScopeRow k="You" v={[user.requester_name ?? [user.first_name, user.last_name].filter(Boolean).join(' '), user.job_title].filter(Boolean).join(' · ')} />
          <ScopeRow k="Location" v={[user.requesting_location_code, user.requesting_location_name].filter(Boolean).join(' · ') || branch} />
          <ScopeRow k="Cost centre" v={[user.cost_centre_code, user.cost_centre_name].filter(Boolean).join(' · ')} />
          <ScopeRow k="Project" v={[user.project_code, user.project_name].filter(Boolean).join(' · ')} />
          <ScopeRow k="Fiscal year" v={user.fiscal_year_code ?? user.fiscal_year_name ?? ''} />
          {(user.default_priority || user.default_procurement_category || user.default_currency_code) && (
            <>
              <div className="account-sep" />
              <p className="scope-caption">Requisition defaults</p>
              <ScopeRow k="Priority" v={user.default_priority ?? ''} />
              <ScopeRow k="Category" v={user.default_procurement_category ?? ''} />
              <ScopeRow k="Currency" v={user.default_currency_code ?? ''} />
            </>
          )}
          <p className="search-hint">This sign-in is bound to this company and branch. Switch by signing in again.</p>
        </div>
      )}
    </div>
  );
}

export function UserMenu({
  user,
  prefsLabel,
  onHelp,
  onFocus,
  onPin,
  onLogout,
  focusMode,
}: {
  user: MeUser | null;
  prefsLabel: string;
  onHelp: () => void;
  onFocus: () => void;
  onPin: () => void;
  onLogout: () => void;
  focusMode: boolean;
}) {
  const { photoRev } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || 'Account';
  const photoSrc = '/api/auth/me/photo?r=' + photoRev;
  const go = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  return (
    <div className="topbar-item" ref={ref}>
      <button className="account-trigger" onClick={() => setOpen((s) => !s)} aria-label="Account" aria-expanded={open}>
        <StaffPhoto path={photoSrc} hasPhoto={user?.has_photo} name={name} size={34} round />
      </button>
      {open && (
        <div className="topbar-dropdown account-pop" role="menu">
          <button type="button" className="account-id" onClick={() => go(() => navigate('/account'))}>
            <StaffPhoto path={photoSrc} hasPhoto={user?.has_photo} name={name} size={40} round />
            <span className="account-id-copy">
              <strong>{name}</strong>
              <span>{user?.email}</span>
              <span>{personaLabel(personaOf(user))}{user?.job_title ? ` · ${user.job_title}` : ''}</span>
            </span>
          </button>
          <div className="account-sep" />
          <button type="button" className="account-row" onClick={() => go(onPin)}>
            <span>Pin this view</span>
          </button>
          <button type="button" className="account-row" onClick={() => go(onFocus)}>
            <span>{focusMode ? 'Exit floor mode' : 'Floor mode'}</span>
            <span className="account-row-meta">{focusMode ? 'On' : 'Off'}</span>
          </button>
          <button type="button" className="account-row" onClick={() => go(() => navigate('/work'))}>
            <span>My activity</span>
          </button>
          <button type="button" className="account-row" onClick={() => go(onHelp)}>
            <span>Keyboard shortcuts</span>
            <kbd>?</kbd>
          </button>
          <div className="account-sep" />
          <button type="button" className="account-row" onClick={() => go(() => navigate('/account'))}>
            <span>Preferences</span>
            <span className="account-row-meta">{prefsLabel}</span>
          </button>
          <button type="button" className="account-row" onClick={() => go(() => navigate('/account/security'))}>
            <span>Security & MFA</span>
          </button>
          {can(user, 'admin.settings.view') && (
            <button type="button" className="account-row" onClick={() => go(() => navigate('/settings'))}>
              <span>Organisation settings</span>
            </button>
          )}
          <div className="account-sep" />
          <button type="button" className="account-row account-row-out" onClick={() => go(onLogout)}>
            <span>Sign out</span>
          </button>
        </div>
      )}
    </div>
  );
}

export function HeaderCreate() {
  return <CreateMenu />;
}

export function canSee(user: MeUser | null, perm?: string) {
  return !perm || can(user, perm);
}
