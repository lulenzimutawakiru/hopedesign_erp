// Warms route-view code chunks ahead of navigation so a module switch does not
// serialize an extra network round-trip for the JS chunk onto the click.
//
// On the current production topology every request costs ~460ms of RTT, so the
// chunk fetch is a full round-trip of latency on top of the data fetch. These
// dynamic imports match the `lazy(() => import(...))` declarations in
// views/Shell.tsx and dedupe with them (dynamic import of the same specifier
// resolves the same module promise), so warming an already-loaded chunk is a
// no-op and a missed match simply loads nothing.
//
// Keep the prefix list in lock-step with the route dispatch in views/Shell.tsx.

const prefetched = new Set<string>();

interface RouteChunk {
  prefix: string;
  key: string;
  load: () => Promise<unknown>;
}

// Ordered most-specific-first so e.g. /plant/new is matched before /plant.
const ROUTE_CHUNKS: RouteChunk[] = [
  { prefix: '/plant/new', key: 'work-order-wizard', load: () => import('./views/WorkOrderWizard') },
  { prefix: '/plant', key: 'manufacturing', load: () => import('./views/ManufacturingFlow') },
  { prefix: '/finance', key: 'finance', load: () => import('./views/FinanceFlow') },
  { prefix: '/spend', key: 'spend', load: () => import('./views/SpendFlow') },
  { prefix: '/buy', key: 'procurement', load: () => import('./views/ProcurementFlow') },
  { prefix: '/crm', key: 'crm', load: () => import('./views/CrmFlow') },
  { prefix: '/people/payroll-settings', key: 'payroll-settings', load: () => import('./views/PayrollSettings') },
  { prefix: '/people/statutory-configs', key: 'payroll-settings', load: () => import('./views/PayrollSettings') },
  { prefix: '/people', key: 'hr', load: () => import('./views/HrFlow') },
  { prefix: '/hikvision', key: 'hikvision', load: () => import('./views/HikvisionFlow') },
  { prefix: '/settings', key: 'settings', load: () => import('./views/Settings') },
  { prefix: '/account/security', key: 'security-settings', load: () => import('./views/SecuritySettings') },
  { prefix: '/account', key: 'account', load: () => import('./views/Account') },
  { prefix: '/qr', key: 'qr-scanner', load: () => import('./views/QrScanner') },
  { prefix: '/packing', key: 'ream-packing', load: () => import('./views/ReamPacking') },
  { prefix: '/labels', key: 'label-varieties', load: () => import('./views/LabelVarieties') },
  { prefix: '/sales', key: 'sales', load: () => import('./views/SalesFlow') },
  { prefix: '/inventory-intel', key: 'inventory-intel', load: () => import('./views/InventoryIntel') },
  { prefix: '/inventory', key: 'inventory', load: () => import('./views/InventoryFlow') },
  { prefix: '/service-desk', key: 'service-desk', load: () => import('./views/ServiceDeskFlow') },
  { prefix: '/compliance/iso', key: 'compliance-iso', load: () => import('./views/ComplianceIso') },
  { prefix: '/compliance', key: 'compliance', load: () => import('./views/CompliancePdpo') },
  { prefix: '/assets', key: 'assets', load: () => import('./views/AssetsFlow') },
  { prefix: '/admin/organisation-settings', key: 'organisation-settings', load: () => import('./views/OrganisationSettings') },
  { prefix: '/admin', key: 'admin', load: () => import('./views/AdminFlow') },
  { prefix: '/communication/mail', key: 'mail', load: () => import('./features/mail/MailWorkspace') },
  { prefix: '/communication', key: 'communication', load: () => import('./views/CommunicationFlow') },
  { prefix: '/documents', key: 'documents', load: () => import('./views/DocumentsFlow') },
  { prefix: '/esign', key: 'esign', load: () => import('./views/SignRequests') },
  { prefix: '/intelligence', key: 'intelligence', load: () => import('./views/Intelligence') },
  { prefix: '/records', key: 'entity-list', load: () => import('./views/EntityList') },
];

export function prefetchRoute(path: string): void {
  if (!path) return;
  const entry = ROUTE_CHUNKS.find((e) => path.startsWith(e.prefix));
  if (!entry || prefetched.has(entry.key)) return;
  prefetched.add(entry.key);
  entry.load().catch(() => undefined);
}
