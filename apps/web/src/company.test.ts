/**
 * Tenant branding helpers.
 *
 * Beyond the name/label formatting, this file pins the caching contract that
 * `fetchCompanyProfile` is responsible for: a real profile is fetched once and
 * reused, while a failure is never memoized, so a tenant whose API was briefly
 * unreachable still picks up its real branding on the next attempt instead of
 * being branded "Company" for the rest of the session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  branchLabel,
  clearCompanyProfileCache,
  FALLBACK_COMPANY,
  fetchCompanyProfile,
  shortCompanyName,
  type CompanyProfile,
} from './company';

const profile = (overrides: Partial<CompanyProfile>): CompanyProfile => ({
  ...FALLBACK_COMPANY,
  ...overrides,
});

const jsonResponse = (data: unknown) => ({ ok: true, json: async () => ({ data }) });

describe('shortCompanyName', () => {
  it('strips stacked legal suffixes', () => {
    // "Group" and "Ltd" both go, leaving the two words worth showing.
    expect(shortCompanyName('Hope Design Group Ltd')).toBe('Hope Design');
    expect(shortCompanyName('Hope Design Group Limited')).toBe('Hope Design');
  });

  it('keeps the first two words when there is nothing to strip', () => {
    expect(shortCompanyName('Kampala Paper Mill')).toBe('Kampala Paper');
  });

  it('collapses incidental whitespace', () => {
    expect(shortCompanyName('  Hope   Design   Group   Ltd  ')).toBe('Hope Design');
  });

  it('falls back to the raw name rather than showing nothing', () => {
    // A name made entirely of legal suffixes must not shrink to an empty label.
    expect(shortCompanyName('Company')).toBe('Company');
    expect(shortCompanyName('')).toBe('Company');
  });
});

describe('branchLabel', () => {
  it('reduces a branch name to the place', () => {
    expect(branchLabel(profile({ branch_name: 'Kampala Branch' }))).toBe('Kampala');
  });

  it('falls back to the address when the name is only a qualifier', () => {
    expect(
      branchLabel(profile({ branch_name: 'Branch', branch_address: 'Ntinda, Kampala' }))
    ).toBe('Ntinda');
  });

  it('takes the first address segment only', () => {
    expect(
      branchLabel(profile({ branch_name: '', branch_address: 'Plot 12, Industrial Area, Kampala' }))
    ).toBe('Plot 12');
  });

  it('returns an empty label rather than inventing one', () => {
    expect(branchLabel(profile({ branch_name: '', branch_address: '' }))).toBe('');
  });
});

describe('fetchCompanyProfile', () => {
  beforeEach(() => {
    clearCompanyProfileCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches a real profile once and reuses it', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ name: 'Hope Design Group Ltd' }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchCompanyProfile();
    const second = await fetchCompanyProfile();

    expect(first.name).toBe('Hope Design Group Ltd');
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('merges the profile over the fallback so missing fields stay usable', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ name: 'Hope Design', phone: '+256 000' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchCompanyProfile();

    expect(result.name).toBe('Hope Design');
    expect(result.phone).toBe('+256 000');
    // Untouched by the API, so it keeps the neutral default.
    expect(result.verify_url).toBe(FALLBACK_COMPANY.verify_url);
  });

  it('does not memoize a failure, so a transient outage stays recoverable', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));
    fetchMock.mockResolvedValueOnce(jsonResponse({ name: 'Hope Design' }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchCompanyProfile()).toBe(FALLBACK_COMPANY);

    // The second attempt must reach the API again, not the fallback.
    expect((await fetchCompanyProfile()).name).toBe('Hope Design');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not memoize an error response', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    fetchMock.mockResolvedValueOnce(jsonResponse({ name: 'Hope Design' }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchCompanyProfile()).toBe(FALLBACK_COMPANY);
    expect((await fetchCompanyProfile()).name).toBe('Hope Design');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not memoize a response that carries no profile', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse(null));
    fetchMock.mockResolvedValueOnce(jsonResponse({ name: 'Hope Design' }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchCompanyProfile()).toBe(FALLBACK_COMPANY);
    expect((await fetchCompanyProfile()).name).toBe('Hope Design');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-reads the API once the cache is cleared', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ name: 'Hope Design' }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchCompanyProfile();
    clearCompanyProfileCache();
    await fetchCompanyProfile();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
