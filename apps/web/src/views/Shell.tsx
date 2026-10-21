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
import CommandPalette from './CommandPalette';
import { Toaster } from '../components/toast';
import { WarehouseRoom, OperatorFloor } from './Rooms';
import { Modal, PageLoader } from '../components/ui';

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
  MobileDock,
  MoreDrawer,
  NetworkBanner,
  Sidebar,
  SkipLink,
  useBreakpoint,
} from '../components/nav';
import TopHeader from '../components/TopHeader';
import { isFocusPath, itemVisible, landingModule, normalizePath, requiredPermForPath, track } from '../nav';
import { ModuleSections } from '../components/ModuleSections';
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
      if (e.key === 'Escape') {
        setScannerOpen(false); setCmdOpen(false); setHelpOpen(false); setMoreOpen(false); setSideOpen(false); setGMode(false);
        return;
      }
      // While a blocking overlay owns the keyboard, suppress the shell's
      // bare-letter and '/' shortcuts so they cannot fire underneath an open
      // modal, drawer or palette (e.g. "a" would otherwise jump to Approvals
      // mid-dialog). Ctrl/Cmd+K stays available as an explicit command chord.
      if (document.querySelector('[aria-modal="true"], .modal-backdrop, .more-scrim, .drawer-scrim, .cmd-backdrop, .com-bell-backdrop, .topbar-dropdown')) return;
      if (e.key === '/' && !typing) { e.preventDefault(); setCmdOpen(true); return; }
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

  type RouteEntry = {
    /** Ordered predicate — the first entry whose predicate holds owns the path. */
    match: () => boolean;
    /** The view rendered for this route. */
    render: () => React.ReactNode;
  };

  let body: React.ReactNode;
  if (denied) {
    body = <AccessDenied path={path} />;
  } else {
    // A single typed registry replaces the former ~40-branch if/else dispatch.
    // Order is load-bearing: specific paths (e.g. /people/payroll-settings,
    // /admin/organisation-settings, /communication/mail) must be tried before
    // their parent prefix (/people, /admin, /communication).
    const routes: RouteEntry[] = [
      { match: () => path === '/dashboard' || path === '/' || path === '', render: () => <Dashboard /> },
      { match: () => path === '/work', render: () => <MyWork /> },
      { match: () => path === '/approvals', render: () => <Approvals /> },
      { match: () => path === '/inbox', render: () => <Inbox /> },
      { match: () => path === '/plant/new', render: () => <WorkOrderWizard /> },
      { match: () => path === '/plant' || path.startsWith('/plant/'), render: () => <ManufacturingFlow path={path} /> },
      { match: () => path === '/warehouse' || path === '/warehouse/floor', render: () => <WarehouseRoom handheld={path === '/warehouse/floor' || compact} /> },
      { match: () => path === '/finance' || path.startsWith('/finance/'), render: () => <FinanceFlow path={path} /> },
      { match: () => path === '/spend' || path.startsWith('/spend/'), render: () => <SpendFlow path={path} /> },
      { match: () => path === '/buy' || path.startsWith('/buy/'), render: () => <ProcurementFlow path={path} /> },
      { match: () => path === '/crm' || path.startsWith('/crm/'), render: () => <CrmFlow path={path} /> },
      { match: () => path === '/people/payroll-settings' || path === '/people/statutory-configs', render: () => <PayrollSettings path={path} /> },
      { match: () => path === '/people' || path.startsWith('/people/'), render: () => <HrFlow path={path} /> },
      { match: () => path === '/hikvision' || path.startsWith('/hikvision/'), render: () => <HikvisionFlow path={path} /> },
      { match: () => path === '/operator', render: () => <OperatorFloor /> },
      { match: () => !!opMatch, render: () => <OperatorFloor woId={Number(opMatch!.segments[1])} /> },
      { match: () => path === '/reports', render: () => <Reports /> },
      { match: () => path === '/exports', render: () => <DataExports /> },
      { match: () => path === '/settings', render: () => <Settings /> },
      { match: () => path === '/account', render: () => <Account /> },
      { match: () => path === '/account/security', render: () => <SecuritySettings /> },
      { match: () => path === '/security-jobs', render: () => <SecurityJobs /> },
      { match: () => path === '/qr/scan', render: () => <QrScanner onClose={() => navigate('/dashboard')} /> },
      { match: () => !!qrTraceMatch && qrTraceMatch.segments[1] !== 'scan', render: () => <QrTrace code={decodeURIComponent(qrTraceMatch!.segments[1])} /> },
      { match: () => path === '/packing', render: () => <ReamPacking /> },
      { match: () => path === '/labels', render: () => <LabelVarieties /> },
      { match: () => salesPath, render: () => <SalesFlow path={path} /> },
      { match: () => path === '/inventory-intel' || path.startsWith('/inventory-intel/'), render: () => <InventoryIntel path={path} /> },
      { match: () => inventoryPath, render: () => <InventoryFlow path={path} /> },
      { match: () => serviceDeskPath, render: () => <ServiceDeskFlow path={path} /> },
      { match: () => compliancePath, render: () => <ComplianceFlow path={path} /> },
      { match: () => assetsPath, render: () => <AssetsFlow path={path} /> },
      { match: () => path.startsWith('/admin/organisation-settings'), render: () => <OrganisationSettings path={path} /> },
      { match: () => path === '/admin' || path.startsWith('/admin/'), render: () => <AdminFlow path={path} /> },
      { match: () => path === '/communication/mail' || path.startsWith('/communication/mail/'), render: () => <MailWorkspace path={path} /> },
      { match: () => path === '/communication' || path.startsWith('/communication/'), render: () => <CommunicationFlow path={path} /> },
      { match: () => path === '/documents' || path.startsWith('/documents/'), render: () => <DocumentsFlow path={path} /> },
      { match: () => !!detailMatch, render: () => <EntityDetail route={detailMatch!} /> },
      { match: () => !!listMatch, render: () => <EntityList route={listMatch!} /> },
    ];
    body = routes.find((r) => r.match())?.render() ?? <AccessDenied path={path} />;
  }

  const landing = landingModule(path, user);

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
        <TopHeader
          path={path}
          user={user}
          approvalCount={approvalCount}
          compact={compact}
          focus={focus}
          company={company}
          brandCompany={brandCompany}
          prefs={prefs}
          onOpenSidebar={() => setSideOpen((s) => !s)}
          onOpenSearch={() => setCmdOpen(true)}
          onOpenScanner={() => setScannerOpen(true)}
          onOpenHelp={() => setHelpOpen(true)}
          onToggleFocus={() => setPrefs(savePrefs({ focusMode: !prefs.focusMode }))}
          onPin={() => setPrefs(toggleFavorite(path))}
          onLogout={logout}
        />

        <main id="main-content" className="content" tabIndex={-1}>
          {landing && (
            <div className="page module-sections-page">
              <ModuleSections item={landing} />
            </div>
          )}
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
        <Modal title="Keyboard" onClose={() => setHelpOpen(false)}>
          <p><kbd>Ctrl</kbd>+<kbd>K</kbd> command · <kbd>/</kbd> search · <kbd>S</kbd> scan · <kbd>A</kbd> tasks · <kbd>N</kbd> create</p>
          <p><kbd>G</kbd> then <kbd>D</kbd> dashboard · <kbd>I</kbd> inventory · <kbd>P</kbd> plant · <kbd>H</kbd> warehouse · <kbd>W</kbd> work · <kbd>F</kbd> finance · <kbd>B</kbd> buy · <kbd>C</kbd> CRM · <kbd>E</kbd> people</p>
          <p><kbd>Esc</kbd> closes overlays. <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> move focus.</p>
        </Modal>
      )}
    </div>
  );
}
