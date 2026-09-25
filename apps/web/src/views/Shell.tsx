import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { can, useAuth } from '../auth';
import { useHashRoute, navigate, matchRoute } from '../router';
import { api } from '../api';
import Dashboard from './Dashboard';
import Approvals from './Approvals';
import Inbox from './Inbox';
import MyWork from './MyWork';
import Reports from './Reports';
import DataExports from './DataExports';
import SecurityJobs from './SecurityJobs';
import QrScanner from './QrScanner';
import QrTrace from './QrTrace';
import NotificationsBell from './NotificationsBell';
import CommandPalette from './CommandPalette';
import { Toaster } from '../components/toast';
import { WarehouseRoom, OperatorFloor } from './Rooms';
import { CreateMenu } from '../components/os';
import { PageLoader } from '../components/ui';

// Route-gated views load on demand so the initial shell stays lean.
const EntityList = lazy(() => import('./EntityList'));
const EntityDetail = lazy(() => import('./EntityDetail'));
const Settings = lazy(() => import('./Settings'));
const SecuritySettings = lazy(() => import('./SecuritySettings'));
const ReamPacking = lazy(() => import('./ReamPacking'));
const LabelVarieties = lazy(() => import('./LabelVarieties'));
const SalesFlow = lazy(() => import('./SalesFlow'));
const InventoryFlow = lazy(() => import('./InventoryFlow'));
const ManufacturingFlow = lazy(() => import('./ManufacturingFlow'));
const FinanceFlow = lazy(() => import('./FinanceFlow'));
const SpendFlow = lazy(() => import('./SpendFlow'));
const ProcurementFlow = lazy(() => import('./ProcurementFlow'));
const CrmFlow = lazy(() => import('./CrmFlow'));
const HrFlow = lazy(() => import('./HrFlow'));
const HikvisionFlow = lazy(() => import('./HikvisionFlow'));
const WorkOrderWizard = lazy(() => import('./WorkOrderWizard'));
const AssetsFlow = lazy(() => import('./AssetsFlow'));
const AdminFlow = lazy(() => import('./AdminFlow'));
const CommunicationFlow = lazy(() => import('./CommunicationFlow'));
const MailWorkspace = lazy(() => import('../features/mail/MailWorkspace'));
const DocumentsFlow = lazy(() => import('./DocumentsFlow'));
const InventoryIntel = lazy(() => import('./InventoryIntel'));
const ServiceDeskFlow = lazy(() => import('./ServiceDeskFlow'));
const ComplianceFlow = lazy(() => import('./CompliancePdpo'));
const OrganisationSettings = lazy(() => import('./OrganisationSettings'));
const Account = lazy(() => import('./Account'));
const PayrollSettings = lazy(() => import('./PayrollSettings'));
import { applyPrefs, loadPrefs, savePrefs, toggleFavorite, type Prefs } from '../prefs';
import {
  AccessDenied,
  Breadcrumbs,
  MobileDock,
  ModuleNav,
  MoreDrawer,
  NetworkBanner,
  ScopeChip,
  Sidebar,
  SkipLink,
  UserMenu,
  useBreakpoint,
} from '../components/nav';
import { isFocusPath, itemVisible, normalizePath, requiredPermForPath, track } from '../nav';
import { BrandMark, BrandWordmark, hasBrandAsset } from '../components/BrandMark';
import { useCompanyProfile } from '../company';

/** Badge counts keyed by dashboard exception code (low_stock, ncr, secure, ...). */
function countsByCode(rows?: { code: string; count: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows ?? []) out[row.code] = row.count;
  return out;
}

export default function Shell() {
  const { user, logout } = useAuth();
  const company = useCompanyProfile();
  const rawPath = useHashRoute();
  const path = normalizePath(rawPath);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [approvalCount, setApprovalCount] = useState(0);
  const [moduleCounts, setModuleCounts] = useState<Record<string, number>>({});
  const [helpOpen, setHelpOpen] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [peek, setPeek] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs());
  const [gMode, setGMode] = useState(false);
  const bp = useBreakpoint();
  const brandCompany = {
    name: company.name !== 'Company' || company.code ? company.name : (user?.company_name ?? user?.tenant_name ?? ''),
    code: company.code || (user?.company_code ?? user?.tenant_code ?? ''),
  };

  useEffect(() => { applyPrefs(prefs); }, [prefs]);
  useEffect(() => {
    const on = (e: Event) => setPrefs((e as CustomEvent<Prefs>).detail);
    window.addEventListener('hope-prefs', on);
    return () => window.removeEventListener('hope-prefs', on);
  }, []);
  useEffect(() => { track('route', { path, bp }); }, [path, bp]);

  useEffect(() => {
    if (rawPath !== path) navigate(path, { replace: true });
  }, [rawPath, path]);

  const compact = bp === 'mobile' || bp === 'phablet';
  const tablet = bp === 'tablet' || bp === 'laptop';
  const collapsed = prefs.sidebarCollapsed || tablet;
  const focus = prefs.focusMode || isFocusPath(path) || (compact && (path === '/warehouse' || path.startsWith('/operator')));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable;
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setCmdOpen(true); return; }
      if (e.key === '/' && !typing) { e.preventDefault(); setCmdOpen(true); return; }
      if (e.key === 'Escape') {
        setScannerOpen(false); setCmdOpen(false); setHelpOpen(false); setMoreOpen(false); setSideOpen(false); setGMode(false);
        return;
      }
      if (typing) return;
      // A bare-letter shortcut must not answer a Ctrl/Cmd chord: Ctrl+S is the
      // save shortcut inside the settings console, Ctrl+A selects text, and so
      // on. Only the chords handled above are modifier-aware.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 's' || e.key === 'S') { setScannerOpen(true); return; }
      if (e.key === 'a' || e.key === 'A') { navigate('/approvals'); return; }
      if (e.key === 'n' || e.key === 'N') { setCmdOpen(true); return; }
      if (e.key === '?') { setHelpOpen(true); return; }
      if (gMode) {
        setGMode(false);
        if (e.key === 'd') navigate('/dashboard');
        if (e.key === 'i') navigate('/inventory/stock');
        if (e.key === 'p') navigate('/plant');
        if (e.key === 'w') navigate('/work');
        if (e.key === 'f') navigate('/finance');
        if (e.key === 'b') navigate('/buy');
        if (e.key === 'c') navigate('/crm');
        if (e.key === 'e') navigate('/people');
        if (e.key === 'h') navigate('/warehouse');
        return;
      }
      if (e.key === 'g' || e.key === 'G') setGMode(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gMode]);

  // Module badges come from the same exception feed the dashboard uses; only
  // fetch it for users who can actually see one of those modules.
  const wantsModuleCounts = useMemo(
    () =>
      can(user, 'inventory.stock.view') ||
      can(user, 'quality.inspections.view') ||
      can(user, 'security_printing.jobs.view'),
    [user]
  );

  useEffect(() => {
    let alive = true;
    const load = () => {
      api<{ count: number }>('/api/approvals/pending-count')
        .then((r) => { if (alive) setApprovalCount(r.count); })
        .catch(() => undefined);
      if (!wantsModuleCounts) return;
      api<{ data: { exceptions?: { code: string; count: number }[] } }>('/api/dashboard/work')
        .then((r) => { if (alive) setModuleCounts(countsByCode(r.data?.exceptions)); })
        .catch(() => undefined);
    };
    load();
    const iv = setInterval(load, 45000);
    return () => { alive = false; clearInterval(iv); };
  }, [wantsModuleCounts]);

  const listMatch = matchRoute(path, '/records/:module/:resource');
  const detailMatch = matchRoute(path, '/records/:module/:resource/:id');
  const qrTraceMatch = matchRoute(path, '/qr/:code');
  const opMatch = matchRoute(path, '/operator/:id');
  const salesPath = path === '/sales' || path.startsWith('/sales/') || path.startsWith('/records/sales/');
  const inventoryPath = path === '/inventory' || path.startsWith('/inventory/') || path.startsWith('/records/inventory/');
  const assetsPath = path === '/assets' || path.startsWith('/assets/');
  const serviceDeskPath = path === '/service-desk' || path.startsWith('/service-desk/');
  const compliancePath = path === '/compliance' || path.startsWith('/compliance/');

  const denied = useMemo(() => {
    const perm = requiredPermForPath(path);
    if (!perm) return false;
    return !itemVisible(user, { perm, module: perm.split('.')[0] });
  }, [path, user]);

  let body: React.ReactNode;
  if (denied) body = <AccessDenied path={path} />;
  else if (path === '/dashboard' || path === '/' || path === '') body = <Dashboard />;
  else if (path === '/work') body = <MyWork />;
  else if (path === '/approvals') body = <Approvals />;
  else if (path === '/inbox') body = <Inbox />;
  else if (path === '/plant/new') body = <WorkOrderWizard />;
  else if (path === '/plant' || path.startsWith('/plant/')) body = <ManufacturingFlow path={path} />;
  else if (path === '/warehouse' || path === '/warehouse/floor') body = <WarehouseRoom handheld={path === '/warehouse/floor' || compact} />;
  else if (path === '/finance' || path.startsWith('/finance/')) body = <FinanceFlow path={path} />;
  else if (path === '/spend' || path.startsWith('/spend/')) body = <SpendFlow path={path} />;
  else if (path === '/buy' || path.startsWith('/buy/')) body = <ProcurementFlow path={path} />;
  else if (path === '/crm' || path.startsWith('/crm/')) body = <CrmFlow path={path} />;
  else if (path === '/people/payroll-settings' || path === '/people/statutory-configs') body = <PayrollSettings path={path} />;
  else if (path === '/people' || path.startsWith('/people/')) body = <HrFlow path={path} />;
  else if (path === '/hikvision' || path.startsWith('/hikvision/')) body = <HikvisionFlow path={path} />;
  else if (path === '/operator') body = <OperatorFloor />;
  else if (opMatch) body = <OperatorFloor woId={Number(opMatch.segments[1])} />;
  else if (path === '/reports') body = <Reports />;
  else if (path === '/exports') body = <DataExports />;
  else if (path === '/settings') body = <Settings />;
  else if (path === '/account') body = <Account />;
  else if (path === '/account/security') body = <SecuritySettings />;
  else if (path === '/security-jobs') body = <SecurityJobs />;
  else if (path === '/qr/scan') body = <QrScanner onClose={() => navigate('/dashboard')} />;
  else if (qrTraceMatch && qrTraceMatch.segments[1] !== 'scan') body = <QrTrace code={decodeURIComponent(qrTraceMatch.segments[1])} />;
  else if (path === '/packing') body = <ReamPacking />;
  else if (path === '/labels') body = <LabelVarieties />;
  else if (salesPath) body = <SalesFlow path={path} />;
  else if (path === '/inventory-intel' || path.startsWith('/inventory-intel/')) body = <InventoryIntel path={path} />;
  else if (inventoryPath) body = <InventoryFlow path={path} />;
  else if (serviceDeskPath) body = <ServiceDeskFlow path={path} />;
  else if (compliancePath) body = <ComplianceFlow path={path} />;
  else if (assetsPath) body = <AssetsFlow path={path} />;
  else if (path.startsWith('/admin/organisation-settings')) body = <OrganisationSettings path={path} />;
  else if (path === '/admin' || path.startsWith('/admin/')) body = <AdminFlow path={path} />;
  else if (path === '/communication/mail' || path.startsWith('/communication/mail/')) body = <MailWorkspace path={path} />;
  else if (path === '/communication' || path.startsWith('/communication/')) body = <CommunicationFlow path={path} />;
  else if (path === '/documents' || path.startsWith('/documents/')) body = <DocumentsFlow path={path} />;
  else if (detailMatch) body = <EntityDetail route={detailMatch} />;
  else if (listMatch) body = <EntityList route={listMatch} />;
  else body = <AccessDenied path={path} />;

  const counts = {
    approvals: approvalCount,
    inventory: moduleCounts.low_stock ?? 0,
    quality: moduleCounts.ncr ?? 0,
    security: moduleCounts.secure ?? 0,
  };

  const go = (href: string) => {
    navigate(href);
    setSideOpen(false);
    setMoreOpen(false);
  };

  const showModuleNav = !denied && !focus && !path.startsWith('/operator');

  return (
    <div className={`app-shell ${collapsed ? 'rail-collapsed' : ''} ${focus ? 'is-focus' : ''} bp-${bp}`}>
      <SkipLink />
      <NetworkBanner />
      {!focus && (
        <Sidebar
          path={path}
          user={user}
          companyName={brandCompany.name}
          companyLogo={company.logo_url}
          companyCode={brandCompany.code}
          collapsed={collapsed && !compact}
          open={sideOpen}
          peek={peek && !compact}
          onPeek={setPeek}
          counts={counts}
          favorites={prefs.favorites}
          recents={prefs.recents}
          onNavigate={go}
          onToggle={() => setPrefs(savePrefs({ sidebarCollapsed: !prefs.sidebarCollapsed }))}
        />
      )}

      {sideOpen && <div className="sidebar-scrim" onClick={() => setSideOpen(false)} />}

      <div className="main-col">
        <header className="topbar">
          {compact && !focus && (
            <button className="icon-btn menu-btn" onClick={() => setSideOpen((s) => !s)} aria-label="Open navigation">☰</button>
          )}
          {focus && (
            <button className="icon-btn" onClick={() => history.back()} aria-label="Back">←</button>
          )}
          {compact && hasBrandAsset(company.logo_url) && (
            <button className="topbar-brand" onClick={() => navigate('/dashboard')} aria-label={`${brandCompany.name} dashboard`}>
              <BrandMark size="sm" logoUrl={company.logo_url} />
            </button>
          )}
          <button className="cmd-open" onClick={() => setCmdOpen(true)} aria-label="Search or command">
            <span>Search or type a command…</span>
            <kbd>Ctrl K</kbd>
          </button>
          <div className="topbar-actions">
            <button className="btn btn-sm btn-scan" onClick={() => setScannerOpen(true)}>Scan QR</button>
            <span className="hide-phone"><CreateMenu /></span>
            <button className="btn btn-sm hide-phone" onClick={() => navigate('/inbox')}>
              Tasks {approvalCount > 0 && <span className="count-badge">{approvalCount}</span>}
            </button>
            <NotificationsBell />
            <ScopeChip user={user} />
            <UserMenu
              user={user}
              prefsLabel={`${prefs.theme} · ${prefs.density}`}
              focusMode={prefs.focusMode}
              onHelp={() => setHelpOpen(true)}
              onFocus={() => setPrefs(savePrefs({ focusMode: !prefs.focusMode }))}
              onPin={() => setPrefs(toggleFavorite(path))}
              onLogout={logout}
            />
          </div>
          <BrandWordmark
            size="md"
            className="topbar-brand-alt hide-phone"
            logoUrl={company.secondary_logo_url}
            title={`${brandCompany.name} logo`}
          />
        </header>

        {showModuleNav && (
          <div className="module-bar">
            <Breadcrumbs path={path} />
            <ModuleNav path={path} user={user} />
          </div>
        )}

        <main id="main-content" className="content" tabIndex={-1}>
          <Suspense fallback={<PageLoader variant="page" />}>{body}</Suspense>
        </main>

        {compact && !focus && (
          <MobileDock
            path={path}
            onScan={() => setScannerOpen(true)}
            onMore={() => setMoreOpen(true)}
            taskCount={approvalCount}
          />
        )}
      </div>

      <MoreDrawer
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        path={path}
        user={user}
        counts={counts}
        onNavigate={go}
        onScan={() => setScannerOpen(true)}
      />

      {scannerOpen && <QrScanner onClose={() => setScannerOpen(false)} sheet={compact} />}
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} />
      <Toaster />
      {helpOpen && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setHelpOpen(false)}>
          <div className="modal" role="dialog" aria-labelledby="kbd-title">
            <div className="modal-head"><h3 id="kbd-title">Keyboard</h3></div>
            <div className="modal-body">
              <p><kbd>Ctrl</kbd>+<kbd>K</kbd> command · <kbd>/</kbd> search · <kbd>S</kbd> scan · <kbd>A</kbd> tasks · <kbd>N</kbd> create</p>
              <p><kbd>G</kbd> then <kbd>D</kbd> dashboard · <kbd>I</kbd> inventory · <kbd>P</kbd> plant · <kbd>H</kbd> warehouse · <kbd>W</kbd> work · <kbd>F</kbd> finance · <kbd>B</kbd> buy · <kbd>C</kbd> CRM · <kbd>E</kbd> people</p>
              <p><kbd>Esc</kbd> closes overlays. <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> move focus.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
