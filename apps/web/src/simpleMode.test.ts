import { describe, expect, it } from 'vitest';
import type { MeUser } from './auth';
import {
  defaultsToSimpleMode,
  effectiveSimpleMode,
  SIMPLE_APPS,
  SIMPLE_TASKS,
  visibleSimpleApps,
  visibleSimpleTasks,
} from './simpleMode';
import { routeMatches } from './routeRegistry';

/** Minimal MeUser factory — only the fields these functions actually read. */
function user(permissions: string[] = [], roles: string[] = []): MeUser {
  return {
    permissions,
    roles: roles.map((role_code) => ({ role_code, role_id: 1, company_id: null, branch_id: null })),
  } as unknown as MeUser;
}

describe('simple mode', () => {
  describe('defaultsToSimpleMode', () => {
    it('defaults shop-floor personas to simple mode', () => {
      expect(defaultsToSimpleMode(user([], ['storekeeper']))).toBe(true);
      expect(defaultsToSimpleMode(user([], ['machine_operator']))).toBe(true);
      expect(defaultsToSimpleMode(user([], ['quality_inspector']))).toBe(true);
    });

    it('leaves office / management personas in full view', () => {
      expect(defaultsToSimpleMode(user([], ['accountant']))).toBe(false);
      expect(defaultsToSimpleMode(user([], ['account_manager']))).toBe(false);
      expect(defaultsToSimpleMode(user([], ['hr_manager']))).toBe(false);
    });

    it('treats a signed-out user as full view (no default)', () => {
      expect(defaultsToSimpleMode(null)).toBe(false);
    });
  });

  describe('effectiveSimpleMode', () => {
    it('falls back to the role default when no preference is set', () => {
      expect(effectiveSimpleMode(user([], ['storekeeper']), { simpleMode: undefined })).toBe(true);
      expect(effectiveSimpleMode(user([], ['accountant']), { simpleMode: undefined })).toBe(false);
    });

    it('lets an explicit preference override the role default', () => {
      expect(effectiveSimpleMode(user([], ['accountant']), { simpleMode: true })).toBe(true);
      expect(effectiveSimpleMode(user([], ['storekeeper']), { simpleMode: false })).toBe(false);
    });
  });

  describe('visibility gating', () => {
    it('shows nothing to a user with no permissions', () => {
      expect(visibleSimpleApps(user())).toHaveLength(0);
      expect(visibleSimpleTasks(user())).toHaveLength(0);
    });

    it('shows only the apps the user is permitted to open', () => {
      const apps = visibleSimpleApps(user(['sales.orders.view']));
      expect(apps.map((a) => a.id)).toEqual(['sales']);
    });

    it('shows every app and task to a super-admin', () => {
      expect(visibleSimpleApps(user(['*']))).toHaveLength(SIMPLE_APPS.length);
      expect(visibleSimpleTasks(user(['*']))).toHaveLength(SIMPLE_TASKS.length);
    });
  });

  describe('navigation', () => {
    it('points every app and task at a real route', () => {
      for (const a of SIMPLE_APPS) {
        expect(routeMatches(a.href), `${a.id} -> ${a.href}`).toBe(true);
      }
      for (const t of SIMPLE_TASKS) {
        expect(routeMatches(t.href), `${t.id} -> ${t.href}`).toBe(true);
      }
    });
  });
});
