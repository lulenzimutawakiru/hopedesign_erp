import { safeFetch } from './safeFetch.js';
import type { WebsiteIntel } from './types.js';

/**
 * Business-website intelligence (section F).
 *
 * Extracts a small, deterministic profile from a business's public website.
 * Real hosts go through `safeFetch` (SSRF-guarded, size/timeout-capped). The
 * reserved `.example.com` hosts used by the sandbox provider are synthesised
 * locally so tests stay hermetic and the pipeline runs without outbound calls.
 *
 * Everything here is treated as untrusted data and only ever feeds scoring /
 * classification — never executed and never treated as instructions.
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /\+?[\d][\d\s().-]{6,}\d/g;
const TITLE_RE = /<title[^>]*>([^<]+)<\/title>/i;
const META_DESC_RE =
  /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i;
const SOCIAL_HOSTS = ['facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 'instagram.com', 'youtube.com'];

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v.trim());
  }
  return out.slice(0, 8);
}

function titleCase(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Deterministic synthetic profile for the reserved sandbox domain. */
function syntheticIntel(url: string): WebsiteIntel {
  const host = new URL(url).hostname;
  const slug = host.split('.')[0];
  const name = titleCase(slug);
  return {
    websiteOk: true,
    title: `${name} — Official Site`,
    description: `Synthetic website profile for ${name}.`,
    emails: [`hello@${slug}.example.com`],
    phones: [],
    socials: [],
    textSample: `${name} provides products and services across its region.`,
    finalUrl: url,
  };
}

/** Build a website-intelligence profile for a prospect's website URL. */
export async function intelligenceFromWebsite(url: string | null | undefined): Promise<WebsiteIntel> {
  const raw = String(url ?? '').trim();
  if (!raw) return { websiteOk: false, error: 'NO_WEBSITE' };

  if (raw.toLowerCase().includes('.example.com')) {
    return syntheticIntel(raw);
  }

  const res = await safeFetch(raw);
  if (!res.ok || !res.text) {
    return { websiteOk: false, error: res.error ?? 'FETCH_FAILED', finalUrl: res.finalUrl };
  }

  const text = res.text;
  const titleMatch = text.match(TITLE_RE);
  const descMatch = text.match(META_DESC_RE);
  const emails = dedupe(text.match(EMAIL_RE) ?? []);
  const phones = dedupe(text.match(PHONE_RE) ?? []);
  const socials = SOCIAL_HOSTS.filter((host) => text.toLowerCase().includes(host));
  const textSample = stripTags(text).slice(0, 2000) || null;

  return {
    websiteOk: true,
    title: titleMatch ? titleMatch[1].trim() : null,
    description: descMatch ? descMatch[1].trim() : null,
    emails,
    phones,
    socials,
    textSample,
    finalUrl: res.finalUrl,
  };
}
