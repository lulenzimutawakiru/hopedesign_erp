// Shared types and constants for the Natex Intelligence module. Pure — no
// database or network imports, so scoring/dedupe/provider tests can import it.

export const PROSPECT_STATUSES = [
  'NEW',
  'REVIEWED',
  'APPROVED',
  'REJECTED',
  'CONVERTED',
  'DISCARDED',
] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

export const CAMPAIGN_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** One attributable slice of the 0-100 score (section H explainability). */
export interface ScoreFactor {
  key: string;
  label: string;
  points: number;
  max: number;
  detail?: string;
}

export interface ScoreResult {
  score: number;
  factors: ScoreFactor[];
  band: 'hot' | 'warm' | 'cool' | 'cold';
}

/** Targeting criteria for a discovery campaign (also the geographic + industry
 * sections C and D: geography and industry are just query dimensions). */
export interface DiscoveryQuery {
  query?: string;
  industries?: string[];
  countries?: string[];
  regions?: string[];
  cities?: string[];
  keywords?: string[];
  minEmployees?: number | null;
  maxEmployees?: number | null;
  maxResults?: number;
}

/** A raw result from a discovery provider. Explicitly-shaped so a sandbox and a
 * real provider (Google Places, Apollo, ...) both feed the same enrichment pipe. */
export interface DiscoveryResult {
  name: string;
  legalName?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  industry?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  employeesMin?: number | null;
  employeesMax?: number | null;
  revenueMin?: number | null;
  revenueMax?: number | null;
  description?: string | null;
  sourceRank: number;
  sourceProvider: string;
  sourceQuery?: string | null;
  raw: Record<string, unknown>;
}

export interface DiscoveryProvider {
  name: string;
  search(input: DiscoveryQuery): Promise<DiscoveryResult[]>;
}

/** Deterministic website-intelligence extraction (section F). */
export interface WebsiteIntel {
  websiteOk: boolean;
  error?: string | null;
  title?: string | null;
  description?: string | null;
  emails?: string[];
  phones?: string[];
  socials?: string[];
  textSample?: string | null;
  finalUrl?: string | null;
}

/** AI engine output (section G). AI never invents contact fields; it only
 * classifies and explains, and every field here is advisory. */
export interface AiAnalysis {
  industryClass?: string | null;
  icpFit: number;
  rationale: string;
  buyingSignals: string[];
  tags: string[];
  source: 'deepseek' | 'heuristic';
}

export interface AiAnalyzeInput {
  name: string;
  industry?: string | null;
  website?: string | null;
  description?: string | null;
  country?: string | null;
  city?: string | null;
  employees?: string | null;
  /** Untrusted website text. The engine must treat this as data, never as
   * instructions (prompt-injection defence). */
  extractedText?: string | null;
}

export interface AiEngine {
  name: string;
  analyze(input: AiAnalyzeInput): Promise<AiAnalysis>;
}

/** Safe-fetch result (SSRF-guarded website fetch). */
export interface SafeFetchResult {
  ok: boolean;
  status?: number;
  finalUrl?: string;
  contentType?: string | null;
  text?: string;
  sizeBytes?: number;
  error?: string;
}
