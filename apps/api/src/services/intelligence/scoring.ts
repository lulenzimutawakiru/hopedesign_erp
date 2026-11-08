import type { AiAnalysis, AiAnalyzeInput, ScoreFactor, ScoreResult } from './types.js';

/**
 * Deterministic explainable lead scoring (section H) plus the pure helpers the
 * AI engine and duplicate detector both lean on. Everything here is pure — no
 * database, no network — so the tests can pin the exact number for every
 * input. When DeepSeek is configured it only refines `icpFit`, `industryClass`
 * and the rationale; the arithmetic below is always the source of truth.
 */

export interface ScoreInput {
  name?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  industry?: string | null;
  country?: string | null;
  city?: string | null;
  employeesMin?: number | null;
  employeesMax?: number | null;
  revenueMin?: number | null;
  revenueMax?: number | null;
  websiteOk?: boolean;
  websiteEmails?: number;
  icpFit?: number;
  industryClass?: string | null;
}

export function scoreBand(score: number): 'hot' | 'warm' | 'cool' | 'cold' {
  if (score >= 80) return 'hot';
  if (score >= 60) return 'warm';
  if (score >= 40) return 'cool';
  return 'cold';
}

export function scoreProspect(input: ScoreInput): ScoreResult {
  const has = (v: unknown): boolean => v != null && String(v).trim().length > 0;
  const factors: ScoreFactor[] = [];
  const push = (key: string, label: string, points: number, max: number, detail?: string) =>
    factors.push({ key, label, points: Math.max(0, Math.min(max, points)), max, detail });

  // 1. Identity (max 10)
  push('identity', 'Business identity', has(input.name) ? 10 : 0, 10, has(input.name) ? undefined : 'No name');

  // 2. Contact completeness (max 20)
  const emailPts = has(input.email) ? 10 : 0;
  const phonePts = has(input.phone) ? 10 : 0;
  push('contact.email', 'Direct email', emailPts, 10, has(input.email) ? undefined : 'No email');
  push('contact.phone', 'Direct phone', phonePts, 10, has(input.phone) ? undefined : 'No phone');

  // 3. Web presence (max 20)
  const webPts = has(input.website) ? 8 : 0;
  const reachPts = input.websiteOk ? 6 : 0;
  const webEmailPts = (input.websiteEmails ?? 0) > 0 ? 6 : 0;
  push('web.site', 'Has website', webPts, 8, has(input.website) ? undefined : 'No website');
  push('web.reachable', 'Website reachable', reachPts, 6, input.websiteOk ? undefined : 'Not verified');
  push('web.contacts', 'Contact found on site', webEmailPts, 6, (input.websiteEmails ?? 0) > 0 ? `${input.websiteEmails} email(s) on site` : 'None found');

  // 4. Firmographics (max 20)
  const industryPts = has(input.industry) ? 8 : 0;
  const empPts = has(input.employeesMin) || has(input.employeesMax) ? 6 : 0;
  const revPts = has(input.revenueMin) || has(input.revenueMax) ? 6 : 0;
  push('firmo.industry', 'Industry known', industryPts, 8, has(input.industry) ? undefined : 'Unknown industry');
  push('firmo.employees', 'Headcount known', empPts, 6, empPts ? undefined : 'Unknown size');
  push('firmo.revenue', 'Revenue known', revPts, 6, revPts ? undefined : 'Unknown revenue');

  // 5. Geography (max 10)
  const countryPts = has(input.country) ? 5 : 0;
  const cityPts = has(input.city) ? 5 : 0;
  push('geo.country', 'Country known', countryPts, 5, has(input.country) ? undefined : 'Unknown country');
  push('geo.city', 'City known', cityPts, 5, has(input.city) ? undefined : 'Unknown city');

  // 6. ICP fit (max 20), supplied by the AI/heuristic engine.
  const icp = Math.max(0, Math.min(100, Math.round(Number(input.icpFit ?? 0))));
  const icpPts = Math.round((icp / 100) * 20);
  push('icp.fit', 'Ideal-customer fit', icpPts, 20, `ICP fit ${icp}/100`);

  const score = Math.min(100, factors.reduce((sum, f) => sum + f.points, 0));
  return { score, factors, band: scoreBand(score) };
}

// ---------------------------------------------------------------------------
// Name / domain normalisation + duplicate detection (section J)
// ---------------------------------------------------------------------------

const LEGAL_SUFFIXES = /\b(ltd|limited|inc|incorporated|llc|corp|corporation|co|plc|pty|sarl|gmbh|sa|nv|bv|spa|srl|kg|oy|ab|as|fzco|fze)\b\.?/gi;
const NON_ALNUM = /[^a-z0-9]+/g;

export function normalizeName(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(NON_ALNUM, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractDomain(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  // "user@example.com" -> "example.com"; "https://www.example.co.ug/x" -> "example.co.ug"
  const withoutProtocol = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  let host = withoutProtocol.split(/[/?#]/)[0];
  // An "@" with no scheme is an email address; the domain follows it.
  if (host.includes('@') && !value.includes('://')) host = host.slice(host.lastIndexOf('@') + 1);
  host = host.replace(/^www\./i, '').toLowerCase();
  return host.includes('.') ? host : null;
}

export function normalizePhone(phone: string): string {
  return String(phone ?? '').replace(/\D/g, '');
}

export interface DuplicateCandidate {
  name?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  industry?: string | null;
  city?: string | null;
}

/**
 * Similarity between two prospects in [0, 1]. Deterministic and explainable by
 * construction. A score >= 0.6 flags a candidate as a probable duplicate; the
 * caller links (`duplicate_of`) and never auto-merges (section J requirement).
 */
export function duplicateScore(a: DuplicateCandidate, b: DuplicateCandidate): number {
  let score = 0;

  const nameA = normalizeName(a.name ?? '');
  const nameB = normalizeName(b.name ?? '');
  if (nameA && nameB) {
    if (nameA === nameB) score += 0.6;
    else if (nameA.length >= 4 && nameB.length >= 4 && (nameA.includes(nameB) || nameB.includes(nameA))) {
      score += 0.4;
    }
  }

  const domainA = extractDomain(a.website);
  const domainB = extractDomain(b.website);
  const emailDomainA = extractDomain(a.email);
  const emailDomainB = extractDomain(b.email);
  if (domainA && domainB && domainA === domainB) score += 0.35;
  else if (domainA && emailDomainB && domainA === emailDomainB) score += 0.3;
  else if (domainB && emailDomainA && domainB === emailDomainA) score += 0.3;

  const emailA = String(a.email ?? '').trim().toLowerCase();
  const emailB = String(b.email ?? '').trim().toLowerCase();
  if (emailA && emailA === emailB) score += 0.4;

  const phoneA = normalizePhone(a.phone ?? '');
  const phoneB = normalizePhone(b.phone ?? '');
  if (phoneA && phoneA === phoneB) score += 0.35;

  const indA = String(a.industry ?? '').trim().toLowerCase();
  const indB = String(b.industry ?? '').trim().toLowerCase();
  const cityA = String(a.city ?? '').trim().toLowerCase();
  const cityB = String(b.city ?? '').trim().toLowerCase();
  if (indA && indB && indA === indB && cityA && cityB && cityA === cityB) score += 0.15;

  return Math.min(1, Math.round(score * 100) / 100);
}

export const DUPLICATE_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// Heuristic AI: industry classification + ICP fit (the no-key fallback)
// ---------------------------------------------------------------------------

/** ICP keywords for a paper-manufacturing business (NATEX-A4). Kept in one
 *  place so the heuristic engine and any future tuning share the same list. */
export const ICP_KEYWORDS: ReadonlyArray<[string, number]> = [
  ['printing', 12],
  ['printer', 8],
  ['publishing', 10],
  ['packaging', 12],
  ['stationery', 14],
  ['paper', 12],
  ['office supplies', 12],
  ['book', 6],
  ['label', 6],
  ['carton', 8],
  ['corrugated', 8],
  ['newspaper', 8],
  ['magazine', 6],
  ['copier', 6],
  ['photocopy', 6],
  ['photocopier', 6],
  ['tissue', 6],
  ['hygiene', 4],
  ['branding', 4],
  ['advertising', 6],
  ['marketing', 4],
  ['bindery', 6],
  ['bookbinding', 6],
  ['school', 8],
  ['education', 6],
  ['university', 6],
];

export const INDUSTRY_BUCKETS: ReadonlyArray<[string, string[]]> = [
  ['Printing & Publishing', ['printing', 'printer', 'publishing', 'newspaper', 'magazine', 'book', 'bindery', 'bookbinding', 'copier', 'photocopy', 'photocopier']],
  ['Packaging', ['packaging', 'carton', 'corrugated', 'label', 'box']],
  ['Stationery & Office Supplies', ['stationery', 'paper', 'office supplies', 'office']],
  ['Education', ['school', 'education', 'university', 'college', 'academy']],
  ['Media & Advertising', ['advertising', 'marketing', 'branding', 'media', 'agency']],
  ['FMCG & Retail', ['retail', 'supermarket', 'wholesale', 'fmcg', 'distribution']],
  ['Healthcare', ['hospital', 'clinic', 'pharmacy', 'medical', 'health']],
  ['Government & NGO', ['government', 'ministry', 'ngo', 'nonprofit', 'authority', 'council']],
  ['Hospitality', ['hotel', 'restaurant', 'lodging', 'catering']],
  ['Logistics', ['logistics', 'transport', 'freight', 'courier', 'warehousing']],
];

function collectText(input: AiAnalyzeInput): string {
  return [
    input.industry ?? '',
    input.description ?? '',
    input.website ?? '',
    input.name ?? '',
    input.country ?? '',
    input.city ?? '',
    input.employees ?? '',
    input.extractedText ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

/** Score 0..100 for ideal-customer fit from keyword coverage. */
export function computeIcpFit(input: AiAnalyzeInput): number {
  const text = collectText(input);
  let fit = 0;
  for (const [kw, weight] of ICP_KEYWORDS) {
    if (text.includes(kw)) fit += weight;
  }
  return Math.max(0, Math.min(100, fit));
}

export function classifyIndustry(input: AiAnalyzeInput): string | null {
  const text = collectText(input);
  let best: string | null = null;
  let bestHits = 0;
  for (const [bucket, keywords] of INDUSTRY_BUCKETS) {
    const hits = keywords.filter((k) => text.includes(k)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = bucket;
    }
  }
  return best;
}

/** Deterministic fallback engine: same output shape as the DeepSeek engine. */
export function heuristicAnalyze(input: AiAnalyzeInput): AiAnalysis {
  const text = collectText(input);
  const matched = ICP_KEYWORDS.filter(([kw]) => text.includes(kw)).map(([kw]) => kw);
  const industryClass = classifyIndustry(input);
  const icpFit = computeIcpFit(input);
  const buyingSignals = matched.map((kw) => `Matches ICP keyword: ${kw}`);
  const rationale = matched.length > 0
    ? `Keyword match on ${matched.length} ICP term${matched.length === 1 ? '' : 's'}: ${matched.join(', ')}.`
    : 'No strong ICP keyword match in the available profile.';
  return {
    industryClass,
    icpFit,
    rationale,
    buyingSignals,
    tags: [industryClass, ...matched].filter((t): t is string => Boolean(t)),
    source: 'heuristic',
  };
}
