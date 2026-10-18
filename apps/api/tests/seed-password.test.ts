import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// Load the CommonJS seed module via Node's own require so the pure password
// policy is exercised without a database and without Vite's CJS/ESM interop.
const require = createRequire(import.meta.url);
const { resolveSeedPassword, randomSeedPassword, DEV_DEFAULT } = require(
  '../../../packages/db/src/seed-password.js'
) as {
  resolveSeedPassword: (env?: Record<string, string | undefined>) => string;
  randomSeedPassword: (length?: number) => string;
  DEV_DEFAULT: string;
};

describe('resolveSeedPassword (SEC-004)', () => {
  it('keeps the documented default outside production (dev/test seed + CI login)', () => {
    expect(resolveSeedPassword({})).toBe(DEV_DEFAULT);
    expect(resolveSeedPassword({ NODE_ENV: 'development' })).toBe(DEV_DEFAULT);
    expect(resolveSeedPassword({ NODE_ENV: 'test' })).toBe(DEV_DEFAULT);
  });

  it('uses an explicit operator-supplied secret verbatim', () => {
    expect(resolveSeedPassword({ SEED_ADMIN_PASSWORD: 'xK9!vQ2#mZ8@wR4$tY7^pL1&nB3*cF6' })).toBe(
      'xK9!vQ2#mZ8@wR4$tY7^pL1&nB3*cF6'
    );
  });

  it('refuses to seed with the default credentials in production', () => {
    expect(() => resolveSeedPassword({ NODE_ENV: 'production' })).toThrow(/SEED_ADMIN_PASSWORD/);
  });

  it('allows an explicit secret even in production', () => {
    expect(
      resolveSeedPassword({ NODE_ENV: 'production', SEED_ADMIN_PASSWORD: 'prod-secret' })
    ).toBe('prod-secret');
  });
});

describe('randomSeedPassword (SEC-004)', () => {
  it('produces unique, URL-safe strings of the requested length', () => {
    const a = randomSeedPassword(24);
    const b = randomSeedPassword(24);
    expect(a).toHaveLength(24);
    expect(b).toHaveLength(24);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
