import { describe, it, expect } from 'vitest';
import { can, scopeFilter } from '../src/middleware/authorize.js';

const req = (auth?: unknown) => ({ auth } as never);

describe('can (RBAC wildcards)', () => {
  it('denies when there is no user', () => {
    expect(can(undefined, 'sales.orders.create')).toBe(false);
  });

  it('matches exact permission, module wildcard and full wildcard', () => {
    expect(can(['sales.orders.create'], 'sales.orders.create')).toBe(true);
    expect(can(['sales.orders.*'], 'sales.orders.create')).toBe(true);
    expect(can(['sales.*'], 'sales.orders.create')).toBe(true);
    expect(can(['*'], 'sales.orders.create')).toBe(true);
    expect(can(['system.admin.all'], 'sales.orders.create')).toBe(true);
    expect(can(['sales.orders.read'], 'sales.orders.create')).toBe(false);
  });
});

describe('scopeFilter (SEC-005)', () => {
  it('denies unauthenticated callers', () => {
    expect(scopeFilter('t')(req(undefined))).toEqual({ clause: '1=0', params: [] });
  });

  it('fails closed for an ordinary user without company/branch scope', () => {
    const user = { permissions: ['security_printing.jobs.view'], company_id: null, branch_id: null };
    expect(scopeFilter('t')(req(user))).toEqual({ clause: '1=0', params: [] });
  });

  it('parameterizes company and branch scope (no SQL interpolation)', () => {
    const user = { permissions: ['security_printing.jobs.view'], company_id: 7, branch_id: 9 };
    expect(scopeFilter('t')(req(user))).toEqual({
      clause: 't.company_id = $1 AND t.branch_id = $2',
      params: [7, 9],
    });
  });

  it('scopes by company alone when no branch is set', () => {
    const user = { permissions: ['security_printing.jobs.view'], company_id: 7, branch_id: null };
    expect(scopeFilter('t')(req(user))).toEqual({ clause: 't.company_id = $1', params: [7] });
  });

  it('allows tenant-wide administrators without an explicit scope', () => {
    for (const permissions of [['system.admin.all'], ['*']]) {
      const user = { permissions, company_id: null, branch_id: null };
      expect(scopeFilter('t')(req(user))).toEqual({ clause: 'TRUE', params: [] });
    }
  });
});
