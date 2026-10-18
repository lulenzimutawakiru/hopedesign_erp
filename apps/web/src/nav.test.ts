import { describe, expect, it } from 'vitest';
import type { MeUser } from './auth';
import { bestChildHref, groupNavChildren, landingModule } from './nav';

const admin = { permissions: ['*'], roles: [] } as unknown as MeUser;

describe('submenu visibility', () => {
  it('highlights the longest matching section, not the module home', () => {
    const children = [
      { href: '/finance' },
      { href: '/finance/journals' },
      { href: '/finance/journals/new' },
    ];
    expect(bestChildHref(children, '/finance/journals/42')).toBe('/finance/journals');
    expect(bestChildHref(children, '/finance')).toBe('/finance');
    expect(bestChildHref(children, '/people')).toBeUndefined();
  });

  it('keeps section groups in nav order', () => {
    const groups = groupNavChildren([
      { id: 'a', group: 'Ledger' },
      { id: 'b', group: 'Ledger' },
      { id: 'c', group: 'Tax' },
      { id: 'd' },
    ]);
    expect(groups.map((g) => g.group)).toEqual(['Ledger', 'Tax', '']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('selects the finance dashboard and hides the directory on a record', () => {
    expect(landingModule('/finance', admin)?.id).toBe('finance');
    expect(landingModule('/finance', admin)?.children?.some((c) => c.href === '/finance/accounts')).toBe(true);
    expect(landingModule('/finance/journals/9', admin)).toBeUndefined();
    expect(landingModule('/plant/dashboard', admin)?.id).toBe('production');
    expect(landingModule('/service-desk/dashboard', admin)?.id).toBe('service_desk');
    expect(landingModule('/dashboard', admin)).toBeUndefined();
  });

  it('keeps every administration section on child screens', () => {
    const labels = [
      'Dashboard', 'Database', 'Users', 'Roles', 'Policies', 'SoD', 'Security', 'Sessions',
      'Audit', 'Settings', 'Features', 'Health', 'Backups', 'Delegations', 'Signatures',
      'Organisation Settings',
    ];
    for (const path of ['/admin', '/admin/users', '/admin/organisation-settings/tax', '/admin/delegations/4']) {
      const item = landingModule(path, admin);
      expect(item?.id).toBe('adminhome');
      expect(item?.children?.map((c) => c.label)).toEqual(labels);
    }
  });

  it('hides administration sections the user cannot open', () => {
    const usersOnly = { permissions: ['admin.users.view'], roles: [] } as unknown as MeUser;
    const item = landingModule('/admin/users', usersOnly);
    expect(item?.children?.map((c) => c.label)).toEqual(['Dashboard', 'Users']);
  });
});
