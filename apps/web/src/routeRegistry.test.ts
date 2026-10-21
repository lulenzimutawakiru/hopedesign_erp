import { describe, expect, it } from 'vitest';
import { ALL_NAV_ITEMS, normalizePath } from './nav';
import { routeMatches } from './routeRegistry';

/** Every href the sidebar / command palette can navigate to. */
function allNavHrefs(): string[] {
  const hrefs: string[] = [];
  for (const item of ALL_NAV_ITEMS) {
    hrefs.push(item.href);
    for (const child of item.children ?? []) hrefs.push(child.href);
  }
  return hrefs;
}

describe('route registry', () => {
  it('every nav item and child href resolves to a real route', () => {
    const missing = allNavHrefs()
      .filter((href) => !routeMatches(normalizePath(href)))
      .sort();
    expect(missing).toEqual([]);
  });

  it('recognises the parameterised routes used by deep links', () => {
    expect(routeMatches(normalizePath('/records/inventory/stock'))).toBe(true);
    expect(routeMatches(normalizePath('/records/production/work_orders'))).toBe(true);
    expect(routeMatches(normalizePath('/records/sales/invoices'))).toBe(true);
    expect(routeMatches(normalizePath('/operator/12'))).toBe(true);
    expect(routeMatches(normalizePath('/qr/ABC123'))).toBe(true);
  });

  it('rejects paths that no route owns', () => {
    expect(routeMatches('/nonsense/route')).toBe(false);
    expect(routeMatches('/records')).toBe(false);
    expect(routeMatches('/operator')).not.toBe(false); // /operator is the index route
  });
});
