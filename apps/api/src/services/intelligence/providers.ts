import type { DiscoveryProvider, DiscoveryQuery, DiscoveryResult } from './types.js';

/**
 * Search-provider integrations (section E).
 *
 * The only implemented provider is the deterministic sandbox: it produces
 * clearly-marked synthetic prospects (`raw.synthetic = true`) so the whole
 * discovery -> enrich -> score -> review -> CRM pipeline can run end-to-end
 * without any external credential and without ever being mistaken for real
 * data. A real provider (Google Places, Apollo, ...) plugs into the same
 * `DiscoveryProvider` interface; credentials live in the environment and are
 * never stored in the database.
 *
 * Do NOT scrape search engines or directories in ways that violate their terms;
 * a future real provider must respect rate limits, robots restrictions and
 * access controls.
 */

export function providerName(): string {
  return (process.env.SEARCH_PROVIDER ?? 'sandbox').trim().toLowerCase();
}

// Deterministic PRNG so a given query always yields the same synthetic set,
// which makes duplicate detection idempotent across repeated campaign runs.
function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface CatalogueEntry {
  name: string;
  industry: string;
  country: string;
  region: string;
  city: string;
  employeesMin: number;
  employeesMax: number;
  revenueMin: number;
  revenueMax: number;
}

// Synthetic catalogue. Names are fictional; no real business is implied.
const CATALOGUE: CatalogueEntry[] = [
  { name: 'Acacia Print House', industry: 'Printing & Publishing', country: 'Uganda', region: 'Central', city: 'Kampala', employeesMin: 25, employeesMax: 60, revenueMin: 400_000_000, revenueMax: 900_000_000 },
  { name: 'Kampala Paper Traders', industry: 'Stationery & Office Supplies', country: 'Uganda', region: 'Central', city: 'Kampala', employeesMin: 10, employeesMax: 30, revenueMin: 150_000_000, revenueMax: 400_000_000 },
  { name: 'Nile Valley Packaging', industry: 'Packaging', country: 'Uganda', region: 'Eastern', city: 'Jinja', employeesMin: 40, employeesMax: 120, revenueMin: 800_000_000, revenueMax: 2_000_000_000 },
  { name: 'Mbarara Bookbinders', industry: 'Printing & Publishing', country: 'Uganda', region: 'Western', city: 'Mbarara', employeesMin: 8, employeesMax: 20, revenueMin: 80_000_000, revenueMax: 250_000_000 },
  { name: 'Entebbe Office Supply Co', industry: 'Stationery & Office Supplies', country: 'Uganda', region: 'Central', city: 'Entebbe', employeesMin: 5, employeesMax: 15, revenueMin: 50_000_000, revenueMax: 150_000_000 },
  { name: 'Gulu Media & Print', industry: 'Media & Advertising', country: 'Uganda', region: 'Northern', city: 'Gulu', employeesMin: 12, employeesMax: 35, revenueMin: 100_000_000, revenueMax: 300_000_000 },
  { name: 'Nairobi Educational Press', industry: 'Education', country: 'Kenya', region: 'Nairobi County', city: 'Nairobi', employeesMin: 50, employeesMax: 150, revenueMin: 1_000_000_000, revenueMax: 3_000_000_000 },
  { name: 'Mombasa Carton Works', industry: 'Packaging', country: 'Kenya', region: 'Coast', city: 'Mombasa', employeesMin: 30, employeesMax: 90, revenueMin: 600_000_000, revenueMax: 1_500_000_000 },
  { name: 'Dar es Salaam Printers', industry: 'Printing & Publishing', country: 'Tanzania', region: 'Dar es Salaam', city: 'Dar es Salaam', employeesMin: 35, employeesMax: 100, revenueMin: 500_000_000, revenueMax: 1_200_000_000 },
  { name: 'Kigali Stationers', industry: 'Stationery & Office Supplies', country: 'Rwanda', region: 'Kigali City', city: 'Kigali', employeesMin: 8, employeesMax: 25, revenueMin: 90_000_000, revenueMax: 280_000_000 },
  { name: 'Arua Community Press', industry: 'Printing & Publishing', country: 'Uganda', region: 'Northern', city: 'Arua', employeesMin: 6, employeesMax: 18, revenueMin: 40_000_000, revenueMax: 120_000_000 },
  { name: 'Mbale Label & Pack', industry: 'Packaging', country: 'Uganda', region: 'Eastern', city: 'Mbale', employeesMin: 20, employeesMax: 55, revenueMin: 300_000_000, revenueMax: 800_000_000 },
  { name: 'Lira Office Solutions', industry: 'Stationery & Office Supplies', country: 'Uganda', region: 'Northern', city: 'Lira', employeesMin: 4, employeesMax: 12, revenueMin: 30_000_000, revenueMax: 100_000_000 },
  { name: 'Kisumu Book Distributors', industry: 'Education', country: 'Kenya', region: 'Nyanza', city: 'Kisumu', employeesMin: 15, employeesMax: 40, revenueMin: 200_000_000, revenueMax: 600_000_000 },
  { name: 'Arusha Print & Promo', industry: 'Media & Advertising', country: 'Tanzania', region: 'Arusha', city: 'Arusha', employeesMin: 10, employeesMax: 28, revenueMin: 120_000_000, revenueMax: 350_000_000 },
  { name: 'Kampala Hygiene Supplies', industry: 'FMCG & Retail', country: 'Uganda', region: 'Central', city: 'Kampala', employeesMin: 18, employeesMax: 50, revenueMin: 250_000_000, revenueMax: 700_000_000 },
  { name: 'Fort Portal Education Trust', industry: 'Education', country: 'Uganda', region: 'Western', city: 'Fort Portal', employeesMin: 40, employeesMax: 120, revenueMin: 300_000_000, revenueMax: 900_000_000 },
  { name: 'Nakuru Publishing House', industry: 'Printing & Publishing', country: 'Kenya', region: 'Rift Valley', city: 'Nakuru', employeesMin: 22, employeesMax: 60, revenueMin: 350_000_000, revenueMax: 900_000_000 },
  { name: 'Mwanza Paper Mills', industry: 'Packaging', country: 'Tanzania', region: 'Mwanza', city: 'Mwanza', employeesMin: 60, employeesMax: 180, revenueMin: 1_500_000_000, revenueMax: 4_000_000_000 },
  { name: 'Musanze School Suppliers', industry: 'Education', country: 'Rwanda', region: 'Northern', city: 'Musanze', employeesMin: 7, employeesMax: 20, revenueMin: 70_000_000, revenueMax: 200_000_000 },
  { name: 'Kampala Carton & Corrugated', industry: 'Packaging', country: 'Uganda', region: 'Central', city: 'Kampala', employeesMin: 45, employeesMax: 130, revenueMin: 900_000_000, revenueMax: 2_500_000_000 },
  { name: 'Jinja School Press', industry: 'Printing & Publishing', country: 'Uganda', region: 'Eastern', city: 'Jinja', employeesMin: 14, employeesMax: 38, revenueMin: 140_000_000, revenueMax: 400_000_000 },
  { name: 'Eldoret Office Emporium', industry: 'Stationery & Office Supplies', country: 'Kenya', region: 'Rift Valley', city: 'Eldoret', employeesMin: 6, employeesMax: 16, revenueMin: 60_000_000, revenueMax: 180_000_000 },
  { name: 'Kampala Corporate Print', industry: 'Media & Advertising', country: 'Uganda', region: 'Central', city: 'Kampala', employeesMin: 16, employeesMax: 45, revenueMin: 200_000_000, revenueMax: 550_000_000 },
];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function matchesCriteria(entry: CatalogueEntry, query: DiscoveryQuery): boolean {
  if (query.industries && query.industries.length > 0) {
    const wanted = query.industries.map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (wanted.length > 0 && !wanted.includes(entry.industry.toLowerCase())) return false;
  }
  if (query.countries && query.countries.length > 0) {
    const wanted = query.countries.map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (wanted.length > 0 && !wanted.includes(entry.country.toLowerCase())) return false;
  }
  if (query.cities && query.cities.length > 0) {
    const wanted = query.cities.map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (wanted.length > 0 && !wanted.includes(entry.city.toLowerCase())) return false;
  }
  if (query.regions && query.regions.length > 0) {
    const wanted = query.regions.map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (wanted.length > 0 && !wanted.includes(entry.region.toLowerCase())) return false;
  }
  if (query.minEmployees != null && entry.employeesMax < query.minEmployees) return false;
  if (query.maxEmployees != null && entry.employeesMin > query.maxEmployees) return false;
  const q = String(query.query ?? '').trim().toLowerCase();
  if (q) {
    const hay = `${entry.name} ${entry.industry} ${entry.city}`.toLowerCase();
    if (!q.split(/\s+/).some((term) => hay.includes(term))) return false;
  }
  return true;
}

function syntheticPhone(rand: () => number): string {
  // Clearly synthetic: Ugandan +256 prefix with a zeroed subscriber block.
  const block = Math.floor(rand() * 90) + 10;
  return `+256 000 00${block}`;
}

export class SandboxProvider implements DiscoveryProvider {
  readonly name = 'sandbox';

  async search(query: DiscoveryQuery): Promise<DiscoveryResult[]> {
    const maxResults = Math.max(1, Math.min(100, Number(query.maxResults ?? 25)));
    const seedKey = JSON.stringify({
      q: query.query ?? '',
      industries: query.industries ?? [],
      countries: query.countries ?? [],
      regions: query.regions ?? [],
      cities: query.cities ?? [],
      minEmployees: query.minEmployees ?? null,
      maxEmployees: query.maxEmployees ?? null,
    });
    const rand = mulberry32(hashString(seedKey));

    const matches = CATALOGUE.filter((entry) => matchesCriteria(entry, query));
    // Deterministic shuffle, then take the first maxResults.
    const shuffled = matches
      .map((entry) => ({ entry, order: rand() }))
      .sort((a, b) => a.order - b.order)
      .map(({ entry }) => entry)
      .slice(0, maxResults);

    return shuffled.map((entry, index) => {
      const slug = slugify(entry.name);
      const hasEmail = rand() > 0.25;
      const hasPhone = rand() > 0.35;
      return {
        name: entry.name,
        legalName: `${entry.name} Ltd`,
        website: `https://${slug}.example.com`,
        email: hasEmail ? `hello@${slug}.example.com` : null,
        phone: hasPhone ? syntheticPhone(rand) : null,
        industry: entry.industry,
        country: entry.country,
        region: entry.region,
        city: entry.city,
        employeesMin: entry.employeesMin,
        employeesMax: entry.employeesMax,
        revenueMin: entry.revenueMin,
        revenueMax: entry.revenueMax,
        description: `Synthetic ${entry.industry.toLowerCase()} profile in ${entry.city}, ${entry.country}.`,
        sourceRank: index + 1,
        sourceProvider: 'sandbox',
        sourceQuery: query.query ?? null,
        raw: { synthetic: true, provider: 'sandbox', catalogueIndex: CATALOGUE.indexOf(entry) },
      };
    });
  }
}

/** The discovery provider for this environment (sandbox until a real one is wired). */
export function resolveProvider(): DiscoveryProvider {
  return new SandboxProvider();
}
