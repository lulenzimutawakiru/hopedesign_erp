import { matchRoute } from './router';

/**
 * Single source of truth for "does this path resolve to a real view?"
 *
 * `Shell` (views/Shell.tsx) dispatches routes in the exact same order and
 * renders `<AccessDenied>` when none match. This pure mirror exists so a test
 * can assert that every nav.ts href lands on a real route — a broken link in
 * NAV_GROUPS would otherwise only surface as a silent AccessDenied screen.
 *
 * Keep the predicate order here in lock-step with the `routes` registry in
 * views/Shell.tsx. Specific paths must precede their parent prefixes
 * (e.g. /people/payroll-settings before /people, /admin/organisation-settings
 * before /admin, /communication/mail before /communication).
 */
export function routeMatches(path: string): boolean {
  const salesPath = path === '/sales' || path.startsWith('/sales/') || path.startsWith('/records/sales/');
  const inventoryPath = path === '/inventory' || path.startsWith('/inventory/') || path.startsWith('/records/inventory/');
  const assetsPath = path === '/assets' || path.startsWith('/assets/');
  const serviceDeskPath = path === '/service-desk' || path.startsWith('/service-desk/');
  const isoPath = path === '/compliance/iso' || path.startsWith('/compliance/iso/');
  const compliancePath = path === '/compliance' || path.startsWith('/compliance/');

  const qrTrace = matchRoute(path, '/qr/:code');

  const matches: boolean[] = [
    path === '/dashboard' || path === '/' || path === '',
    path === '/work',
    path === '/approvals',
    path === '/inbox',
    path === '/plant/new',
    path === '/plant' || path.startsWith('/plant/'),
    path === '/warehouse' || path === '/warehouse/floor',
    path === '/finance' || path.startsWith('/finance/'),
    path === '/spend' || path.startsWith('/spend/'),
    path === '/buy' || path.startsWith('/buy/'),
    path === '/crm' || path.startsWith('/crm/'),
    path === '/people/payroll-settings' || path === '/people/statutory-configs',
    path === '/people' || path.startsWith('/people/'),
    path === '/hikvision' || path.startsWith('/hikvision/'),
    path === '/operator',
    !!matchRoute(path, '/operator/:id'),
    path === '/reports',
    path === '/exports',
    path === '/settings',
    path === '/account',
    path === '/account/security',
    path === '/security-jobs',
    path === '/qr/scan',
    !!qrTrace && qrTrace.segments[1] !== 'scan',
    path === '/packing',
    path === '/labels',
    salesPath,
    path === '/inventory-intel' || path.startsWith('/inventory-intel/'),
    inventoryPath,
    serviceDeskPath,
    isoPath,
    compliancePath,
    assetsPath,
    path.startsWith('/admin/organisation-settings'),
    path === '/admin' || path.startsWith('/admin/'),
    path === '/communication/mail' || path.startsWith('/communication/mail/'),
    path === '/communication' || path.startsWith('/communication/'),
    path === '/documents' || path.startsWith('/documents/'),
    !!matchRoute(path, '/records/:module/:resource/:id'),
    !!matchRoute(path, '/records/:module/:resource'),
  ];

  return matches.some(Boolean);
}
