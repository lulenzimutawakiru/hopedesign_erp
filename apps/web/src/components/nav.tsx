import { useEffect, useRef, useState, type ReactNode } from 'react';
import { can, type MeUser } from '../auth';
import { navigate } from '../router';
import { listHref } from '../listState';
import {
  type BadgeKind,
  type Breakpoint,
  type Crumb,
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
  if (children.length < 2) return null;
  return (
    <nav className="module-nav" aria-label="Module">
      {children.map((c) => (
        <button
          key={c.id}
          className={`tab ${childActive(c.href, path) ? 'active' : ''}`}
          onClick={() => { track('module_nav', { href: c.href }); navigate(c.href); }}
        >
          {c.label}
        </button>
      ))}
    </nav>
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
        <BrandMark size="md" />
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

export function ScopeChip({ user }: { user: MeUser | null }) {
  const [open, setOpen] = useState(false);
  if (!user) return null;
  const scopes = uniqueScopes(user);
  return (
    <div className="scope-wrap">
      <button className="scope-chip" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog" title={`${user.company_name ?? user.tenant_name ?? ''}${(user.company_name ?? user.tenant_name) ? ' · ' : ''}${user.company_code ?? user.tenant_code ?? ''}${user.branch_id ? ` · ${user.branch_name ?? ''} (${user.branch_code ?? ''})` : ''}${user.department_id ? ` · ${user.department_name ?? ''} (${user.department_code ?? ''})` : ''}${user.division_id ? ` · ${user.division_name ?? ''} (${user.division_code ?? ''})` : ''}${user.requester_code ? ` · Requester ${user.requester_name ?? ''} (${user.requester_code ?? ''})` : ''}${user.requesting_location_code ? ` · Requesting ${user.requesting_location_name ?? ''} (${user.requesting_location_code ?? ''})` : ''}${user.cost_centre_code ? ` · Cost Centre ${user.cost_centre_name ?? ''} (${user.cost_centre_code ?? ''})` : ''}${user.project_code ? ` · Project ${user.project_name ?? ''} (${user.project_code ?? ''})` : ''}${user.budget_code ? ` · Budget ${user.budget_code}` : ''}${user.fiscal_year_code ? ` · Fiscal Year ${user.fiscal_year_code}` : ''}${user.request_date ? ` · Requested ${user.request_date}` : ''}${user.required_by_date ? ` · Required by ${user.required_by_date}` : ''}${user.default_priority ? ` · Priority ${user.default_priority}` : ''}${user.default_procurement_category ? ` · Category ${user.default_procurement_category}` : ''}${user.default_purpose ? ` · Purpose set` : ''}${user.default_business_justification ? ` · Justification set` : ''}${user.default_delivery_location ? ` · Delivery set` : ''}${user.default_currency_code ? ` · Currency ${user.default_currency_code}` : ''}${user.default_expected_total ? ` · Expected ${Number(user.default_expected_total).toLocaleString()}` : ''}${user.default_confidentiality_level ? ` · Confidentiality ${user.default_confidentiality_level}` : ''}${user.default_emergency_purchase ? ` · Emergency default` : ''}${user.default_recurring_purchase ? ` · Recurring default` : ''}`.trim()}>
        <span>{user.company_code ?? user.tenant_code ?? ''}</span>
        {user.branch_id ? <span className="muted"> · {user.branch_code ?? user.branch_name ?? `B${user.branch_id}`}</span> : null}
      </button>
      {open && (
        <div className="topbar-dropdown scope-pop" role="dialog" aria-label="Organisational scope">
          <div className="dropdown-head">{user.company_name ?? user.tenant_name ?? user.tenant_code ?? 'Working context'}</div>
          <div className="search-hint">Company {user.company_code ?? user.tenant_code ?? (user.company_id ? `#${user.company_id}` : '—')} · Branch {user.branch_code ?? user.branch_name ?? (user.branch_id ? `#${user.branch_id}` : 'all')} · Dept {user.department_code ?? user.department_name ?? user.department_id ?? 'all'} · Div {user.division_code ?? user.division_name ?? user.division_id ?? 'all'}</div>
          <div className="search-hint">Default Company {user.default_company_code ?? '—'} · default for new requisitions</div>
<div className="search-hint">Default Branch {user.default_branch_code ?? '—'} · default for new requisitions</div>
<div className="search-hint">Default Fiscal Year {user.default_fiscal_year_code ?? '—'} · default for new requisitions</div>
          <div className="search-hint">Requester {user.requester_name ?? user.email ?? 'you'} ({user.requester_code ?? user.id ?? '—'}){user.job_title ? ` · ${user.job_title}` : ''}</div>
          <div className="search-hint">Requesting Location {user.requesting_location_code ?? user.branch_code ?? '—'} · {user.requesting_location_name ?? user.branch_name ?? 'branch'}{user.requesting_location_address ? ` — ${user.requesting_location_address}` : ''}</div>
          <div className="search-hint">Cost Centre {user.cost_centre_code ?? '—'} · {user.cost_centre_name ?? 'unassigned'}</div>
          <div className="search-hint">Project {user.project_code ?? '—'} · {user.project_name ?? 'unassigned'}</div>
          <div className="search-hint">Budget {user.budget_code ?? '—'} · {user.budget_status ?? 'unassigned'}{user.budget_amount != null ? ` (UGX ${Number(user.budget_amount).toLocaleString('en-UG')})` : ''}</div>
          <div className="search-hint">Fiscal Year {user.fiscal_year_code ?? '—'} · {user.fiscal_year_name ?? 'unassigned'}{user.fiscal_year_start ? ` (${user.fiscal_year_start} → ${user.fiscal_year_end ?? '—'})` : ''}{user.fiscal_year_status ? ` · ${user.fiscal_year_status}` : ''}</div>
          <div className="search-hint">Request Date {user.request_date ?? '—'} · today (org business date)</div>
          <div className="search-hint">Required By {user.required_by_date ?? '—'} · {user.default_lead_days ? `${user.default_lead_days}-day lead` : 'no default lead'}</div>
          <div className="search-hint">Priority {user.default_priority ?? '—'} · default for new requisitions</div>
          <div className="search-hint">Procurement Category {user.default_procurement_category ?? '—'} · default for new requisitions</div>
          <div className="search-hint">Purpose {user.default_purpose ? `"${user.default_purpose.length > 64 ? user.default_purpose.slice(0, 64) + '…' : user.default_purpose}"` : '—'} · default justification</div>
          <div className="search-hint">Business Justification {user.default_business_justification ? `"${user.default_business_justification.length > 64 ? user.default_business_justification.slice(0, 64) + '…' : user.default_business_justification}"` : '—'} · default for new requisitions</div>
          <div className="search-hint">Delivery Location {user.default_delivery_location ? `"${user.default_delivery_location.length > 64 ? user.default_delivery_location.slice(0, 64) + '…' : user.default_delivery_location}"` : '—'} · default for new requisitions</div>
          <div className="search-hint">Currency {user.default_currency_code ?? '—'} · default for new requisitions</div>
          <div className="search-hint">Expected Total Value {user.default_expected_total ? Number(user.default_expected_total).toLocaleString() : '—'} · default for new requisitions</div>
          <div className="search-hint">Confidentiality Level {user.default_confidentiality_level ?? '—'} · default for new requisitions</div>
          <div className="search-hint">Emergency Purchase {user.default_emergency_purchase ? 'Yes' : 'No'} · default for new requisitions</div>
          <div className="search-hint">Recurring Purchase {user.default_recurring_purchase ? 'Yes' : 'No'} · default for new requisitions</div>
          {scopes.map((s) => (
            <div key={s} className={`search-item ${s === `c${user.company_id}-b${user.branch_id}` ? 'is-current' : ''}`}>
              <span>{s === `c${user.company_id}-b${user.branch_id}` ? 'Current session' : s}</span>
            </div>
          ))}
          {scopes.length > 1 && (
            <p className="search-hint">Scope is bound to this session by RBAC and ABAC. Switching company or branch requires a scoped re-authentication — it cannot be done in the client.</p>
          )}
          <button className="search-item" onClick={() => setOpen(false)}>Close</button>
        </div>
      )}
    </div>
  );
}

function uniqueScopes(user: MeUser): string[] {
  const set = new Set<string>();
  set.add(`c${user.company_id}-b${user.branch_id}`);
  for (const r of user.roles ?? []) set.add(`c${r.company_id}-b${r.branch_id}`);
  return [...set];
}

export function UserMenu({
  user,
  prefsLabel,
  onPrefs,
  onHelp,
  onFocus,
  onPin,
  onLogout,
  focusMode,
}: {
  user: MeUser | null;
  prefsLabel: string;
  onPrefs: () => void;
  onHelp: () => void;
  onFocus: () => void;
  onPin: () => void;
  onLogout: () => void;
  focusMode: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  return (
    <div className="topbar-item" ref={ref}>
      <button className="icon-btn" onClick={() => setOpen((s) => !s)} aria-label="Account" aria-expanded={open}>
        {(user?.first_name?.[0] ?? 'U').toUpperCase()}
      </button>
      {open && (
        <div className="topbar-dropdown" role="menu">
          <div className="dropdown-head">{user?.first_name} {user?.last_name}</div>
          <div className="search-hint">{user?.email}</div>
          <div className="search-hint">{personaLabel(personaOf(user))} · {user?.job_title ?? 'Named session'}</div>
          <button className="search-item" onClick={() => { onPin(); setOpen(false); }}>Pin this view</button>
          <button className="search-item" onClick={() => { onPrefs(); }}>Preferences · {prefsLabel}</button>
          <button className="search-item" onClick={() => { onFocus(); setOpen(false); }}>{focusMode ? 'Exit floor mode' : 'Floor mode'}</button>
          <button className="search-item" onClick={() => navigate('/work')}>My activity</button>
          <button className="search-item" onClick={() => { onHelp(); setOpen(false); }}>Keyboard shortcuts</button>
          <button className="btn btn-sm btn-block" onClick={onLogout}>Sign out</button>
          {can(user, 'admin.settings.view') && <button className="search-item" onClick={() => { setOpen(false); navigate('/settings'); }}>Settings</button>}
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
