import { describe, it, expect } from 'vitest';
import { config } from '../src/config.js';

describe('config SEC-007 (DB TLS)', () => {
  it('verifies the database server certificate by default', () => {
    // Regression guard: the pool must not silently downgrade TLS verification.
    // Only an explicit POSTGRES_SSL_REJECT_UNAUTHORIZED=false may relax this.
    expect(config.postgres.rejectUnauthorized).toBe(true);
  });
});
