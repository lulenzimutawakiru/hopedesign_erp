import { describe, expect, it } from 'vitest';
import { haversineKm } from './geo';

describe('haversineKm', () => {
  it('is zero for the same point', () => {
    expect(haversineKm(0.3476, 32.6316, 0.3476, 32.6316)).toBe(0);
  });

  it('returns a plausible distance between Kyambogo and Jinja', () => {
    // Kyambogo, Kampala -> Jinja (approx 0.4250 N, 33.2030 E): straight line is
    // a little over 60 km even though the road distance is ~80 km.
    const km = haversineKm(0.3476, 32.6316, 0.425, 33.203);
    expect(km).toBeGreaterThan(55);
    expect(km).toBeLessThan(75);
  });

  it('is symmetric', () => {
    const a = haversineKm(0.3, 32.5, 0.4, 32.7);
    const b = haversineKm(0.4, 32.7, 0.3, 32.5);
    expect(a).toBe(b);
  });
});
