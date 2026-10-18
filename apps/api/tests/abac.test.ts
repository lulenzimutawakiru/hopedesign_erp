import { describe, it, expect } from 'vitest';
import { condMatch, attrMatches } from '../src/abac.js';

const noRef = () => undefined;

describe('condMatch', () => {
  it('matches scalar equality', () => {
    expect(condMatch('finance', 'finance', noRef)).toBe(true);
    expect(condMatch('finance', 'sales', noRef)).toBe(false);
  });

  it('matches legacy array membership', () => {
    expect(condMatch(['post', 'release'], 'post', noRef)).toBe(true);
    expect(condMatch(['post', 'release'], 'approve', noRef)).toBe(false);
  });

  it('matches $in / $not_in / $outside', () => {
    expect(condMatch({ $in: ['post', 'release'] }, 'post', noRef)).toBe(true);
    expect(condMatch({ $in: ['post', 'release'] }, 'approve', noRef)).toBe(false);
    expect(condMatch({ $not_in: ['post', 'release'] }, 'approve', noRef)).toBe(true);
    expect(condMatch({ $outside: ['08:00', '18:00'] }, '07:00', noRef)).toBe(true);
  });

  it('matches $eq / $ne', () => {
    expect(condMatch({ $eq: 1 }, 1, noRef)).toBe(true);
    expect(condMatch({ $eq: 1 }, 2, noRef)).toBe(false);
    expect(condMatch({ $ne: 1 }, 2, noRef)).toBe(true);
  });

  it('matches numeric comparisons and $between', () => {
    expect(condMatch({ $gte: 100 }, 150, noRef)).toBe(true);
    expect(condMatch({ $gt: 100 }, 100, noRef)).toBe(false);
    expect(condMatch({ $lte: 500 }, 500, noRef)).toBe(true);
    expect(condMatch({ $between: [100, 500] }, 300, noRef)).toBe(true);
    expect(condMatch({ $between: [100, 500] }, 50, noRef)).toBe(false);
  });

  it('matches $exists / $missing', () => {
    expect(condMatch({ $missing: true }, undefined, noRef)).toBe(true);
    expect(condMatch({ $missing: true }, 'x', noRef)).toBe(false);
    expect(condMatch({ $exists: true }, 'x', noRef)).toBe(true);
    expect(condMatch({ $exists: true }, null, noRef)).toBe(false);
  });

  it('SEC-002: a multi-operator object is a conjunction, not first-match-wins', () => {
    const range = { $gte: 100, $lte: 500 };
    expect(condMatch(range, 50, noRef)).toBe(false); // fails both bounds
    expect(condMatch(range, 300, noRef)).toBe(true); // inside both bounds
    expect(condMatch(range, 600, noRef)).toBe(false); // fails the upper bound
  });

  it('returns true for an empty operator object (no constraint)', () => {
    expect(condMatch({}, 42, noRef)).toBe(true);
  });

  it('returns false for an unknown operator', () => {
    expect(condMatch({ $unknown: true }, 42, noRef)).toBe(false);
  });

  it('resolves $ref through the supplied resolver', () => {
    const ref = (r: string) => (r === 'resource.owner_user_id' ? 7 : undefined);
    expect(condMatch({ $ref: 'resource.owner_user_id' }, 7, ref)).toBe(true);
    expect(condMatch({ $ref: 'resource.owner_user_id' }, 8, ref)).toBe(false);
  });
});

describe('attrMatches', () => {
  it('ANDs every attribute condition against the source', () => {
    const attr = { module: 'finance', action: { $in: ['post', 'release'] } };
    expect(attrMatches(attr, { module: 'finance', action: 'post' }, noRef)).toBe(true);
    expect(attrMatches(attr, { module: 'finance', action: 'approve' }, noRef)).toBe(false);
    expect(attrMatches(attr, { module: 'sales', action: 'post' }, noRef)).toBe(false);
  });
});
