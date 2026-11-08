/**
 * Pure-function tests for the Natex Intelligence module.
 *
 * Scoring, deduplication, SSRF URL/IP gating, the deterministic sandbox
 * provider and the heuristic AI fallback are all side-effect-free (or, in the
 * AI engine's case, fall back to the heuristic on any provider error) and are
 * exported precisely so they can be pinned here without a database or any
 * external credential. The async service layer only wraps SQL + these
 * functions, so this is the meaningful unit surface.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  scoreBand,
  scoreProspect,
  normalizeName,
  extractDomain,
  normalizePhone,
  duplicateScore,
  DUPLICATE_THRESHOLD,
  computeIcpFit,
  classifyIndustry,
  heuristicAnalyze,
  type ScoreInput,
} from '../src/services/intelligence/scoring.js';
import {
  validateUrl,
  isPrivateIp,
  isPrivateIpv4,
  isPrivateIpv6,
} from '../src/services/intelligence/safeFetch.js';
import { SandboxProvider } from '../src/services/intelligence/providers.js';
import {
  aiProviderConfigured,
  aiProviderName,
  resolveAiEngine,
  HeuristicEngine,
} from '../src/services/intelligence/ai.js';

function fullInput(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    name: 'Acacia Print House',
    website: 'https://acacia-print.example.com',
    email: 'hello@acacia-print.example.com',
    phone: '+256 700 000 000',
    industry: 'Printing & Publishing',
    country: 'Uganda',
    city: 'Kampala',
    employeesMin: 25,
    employeesMax: 60,
    revenueMin: 400_000_000,
    revenueMax: 900_000_000,
    websiteOk: true,
    websiteEmails: 1,
    icpFit: 100,
    ...overrides,
  };
}

describe('scoreBand', () => {
  it('classifies the four documented bands', () => {
    expect(scoreBand(80)).toBe('hot');
    expect(scoreBand(60)).toBe('warm');
    expect(scoreBand(40)).toBe('cool');
    expect(scoreBand(39)).toBe('cold');
  });
});

describe('scoreProspect (explainable /100)', () => {
  it('scores an empty profile as zero', () => {
    const r = scoreProspect({});
    expect(r.score).toBe(0);
    expect(r.band).toBe('cold');
    expect(r.factors.reduce((s, f) => s + f.points, 0)).toBe(r.score);
  });

  it('sums its factors and never exceeds 100', () => {
    const r = scoreProspect(fullInput());
    expect(r.score).toBe(100);
    expect(r.band).toBe('hot');
    expect(r.factors.map((f) => f.key)).toContain('icp.fit');
  });

  it('drops to cold without a name or contact detail', () => {
    const r = scoreProspect({ name: '', industry: 'Packaging', country: 'Uganda' });
    // identity 0 + firmo.industry 8 + geo.country 5 = 13, icp 0
    expect(r.score).toBe(13);
    expect(r.band).toBe('cold');
  });
});

describe('normalizeName', () => {
  it('strips legal suffixes, punctuation and case', () => {
    expect(normalizeName('Nile Valley Packaging Ltd')).toBe('nile valley packaging');
    expect(normalizeName('Acacia Print House Co.')).toBe('acacia print house');
  });
});

describe('extractDomain', () => {
  it('pulls the host from urls and emails', () => {
    expect(extractDomain('https://www.example.co.ug/x')).toBe('example.co.ug');
    expect(extractDomain('user@example.com')).toBe('example.com');
    expect(extractDomain('example.com')).toBe('example.com');
  });
  it('rejects empties and non-domains', () => {
    expect(extractDomain('')).toBeNull();
    expect(extractDomain('nodot')).toBeNull();
  });
});

describe('normalizePhone', () => {
  it('keeps only digits', () => {
    expect(normalizePhone('+256 700 000 000')).toBe('256700000000');
  });
});

describe('duplicateScore', () => {
  it('reaches the threshold on a strong match without auto-merging', () => {
    const a = { name: 'Nile Valley Packaging', website: 'https://nilevalley.example.com', email: 'hello@nilevalley.example.com', phone: '+256 700 111 222', industry: 'Packaging', city: 'Jinja' };
    const b = { ...a };
    expect(duplicateScore(a, b)).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
  });

  it('does not conflate businesses that merely share a common name', () => {
    // Same name, but everything else differs: score is name-only, below threshold.
    const a = { name: 'Acacia Print House', website: 'https://acacia-print.example.com', email: 'hello@acacia-print.example.com', city: 'Kampala' };
    const b = { name: 'Acacia Print House', website: 'https://acacia-print.ke', email: 'info@acacia-print.ke', city: 'Nairobi' };
    const s = duplicateScore(a, b);
    expect(s).toBe(0.6); // name equality only
    expect(s).toBeLessThan(1);
  });

  it('returns zero for unrelated prospects', () => {
    expect(duplicateScore({ name: 'Alpha Ltd' }, { name: 'Omega Plc' })).toBe(0);
  });
});

describe('heuristic industry + ICP', () => {
  it('classifies a printer as printing and finds ICP keywords', () => {
    const input = { name: 'Acacia Print House', industry: 'Printing & Publishing', website: 'https://acacia.example.com', country: 'Uganda', city: 'Kampala' };
    expect(classifyIndustry(input)).toBe('Printing & Publishing');
    expect(computeIcpFit(input)).toBeGreaterThan(0);
  });

  it('produces an explainable heuristic analysis', () => {
    const out = heuristicAnalyze({ name: 'Acacia Print House', industry: 'Printing & Publishing' });
    expect(out.source).toBe('heuristic');
    expect(out.icpFit).toBeGreaterThanOrEqual(0);
    expect(out.icpFit).toBeLessThanOrEqual(100);
    expect(out.buyingSignals.some((s) => s.includes('printing'))).toBe(true);
  });
});

describe('SSRF URL validation', () => {
  it('accepts public http/https web ports', () => {
    for (const raw of ['https://example.com', 'http://example.com', 'https://example.com:8443', 'https://example.com:8080']) {
      const r = validateUrl(raw);
      expect(r.ok, raw).toBe(true);
    }
  });

  it('rejects non-http schemes, blocked ports and unparseable input', () => {
    expect(validateUrl('ftp://example.com')).toMatchObject({ ok: false, error: 'UNSUPPORTED_SCHEME' });
    expect(validateUrl('https://example.com:22')).toMatchObject({ ok: false, error: 'BLOCKED_PORT' });
    expect(validateUrl('not a url')).toMatchObject({ ok: false, error: 'INVALID_URL' });
  });
});

describe('SSRF IP gating', () => {
  it('flags private/reserved IPv4 ranges', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.1.1', '100.64.0.1', '192.0.0.1', '198.18.0.1', '224.0.0.1', '0.0.0.0']) {
      expect(isPrivateIpv4(ip), ip).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '104.16.0.1', '41.190.10.1']) {
      expect(isPrivateIpv4(ip), ip).toBe(false);
    }
  });

  it('refuses unparseable addresses by default', () => {
    expect(isPrivateIpv4('not-an-ip')).toBe(true);
  });

  it('flags private/reserved IPv6 and v4-mapped loopback', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1']) {
      expect(isPrivateIpv6(ip), ip).toBe(true);
    }
  });

  it('allows public IPv6', () => {
    expect(isPrivateIpv6('2001:4860:4860::8888')).toBe(false);
    expect(isPrivateIpv6('::ffff:8.8.8.8')).toBe(false);
  });

  it('dispatches v4/v6 through isPrivateIp', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('::1')).toBe(true);
  });
});

describe('sandbox discovery provider', () => {
  const provider = new SandboxProvider();

  it('is deterministic for an identical query', async () => {
    const a = await provider.search({ countries: ['Uganda'], industries: ['Packaging'] });
    const b = await provider.search({ countries: ['Uganda'], industries: ['Packaging'] });
    expect(a.map((r) => r.name)).toEqual(b.map((r) => r.name));
  });

  it('marks every result as synthetic sandbox data', async () => {
    const results = await provider.search({});
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.sourceProvider).toBe('sandbox');
      expect(r.raw.synthetic).toBe(true);
      expect(r.website).toMatch(/\.example\.com$/);
    }
  });

  it('filters by country without hardcoding industries', async () => {
    const results = await provider.search({ countries: ['Uganda'] });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.country).toBe('Uganda');
  });

  it('filters by city and industry', async () => {
    const kampala = await provider.search({ cities: ['Kampala'] });
    for (const r of kampala) expect(r.city).toBe('Kampala');
    const packaging = await provider.search({ industries: ['Packaging'] });
    for (const r of packaging) expect(r.industry).toBe('Packaging');
  });

  it('honours the maxResults cap', async () => {
    const results = await provider.search({ maxResults: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

describe('AI engine selection', () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const originalProvider = process.env.AI_PROVIDER;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
    if (originalProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalProvider;
  });

  it('defaults to the heuristic engine when no key is configured', () => {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.AI_PROVIDER;
    expect(aiProviderConfigured()).toBe(false);
    expect(aiProviderName()).toBe('heuristic');
    expect(resolveAiEngine()).toBeInstanceOf(HeuristicEngine);
  });

  it('treats AI_PROVIDER=heuristic as an explicit disable even with a key', () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    process.env.AI_PROVIDER = 'heuristic';
    expect(aiProviderConfigured()).toBe(false);
    expect(aiProviderName()).toBe('heuristic');
  });

  it('the heuristic engine yields the deterministic analysis shape', async () => {
    const out = await new HeuristicEngine().analyze({ name: 'Acacia Print House', industry: 'Printing & Publishing' });
    expect(out.source).toBe('heuristic');
    expect(out.rationale.length).toBeGreaterThan(0);
    expect(Array.isArray(out.tags)).toBe(true);
  });
});
