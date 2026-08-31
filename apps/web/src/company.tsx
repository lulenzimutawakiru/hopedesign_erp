import { useEffect, useState } from 'react';

/** Public company branding profile returned by GET /api/public/company. */
export interface CompanyProfile {
  name: string;
  tagline: string;
  legal_name: string;
  code: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  branch_name: string;
  branch_address: string;
  branch_phone: string;
  branch_email: string;
  brand_color: string;
  brand_color_secondary: string;
  logo_url: string;
  footer_logo_url: string;
  verify_url: string;
}

/** Neutral fallback used while the profile loads or when the API is unavailable. */
export const FALLBACK_COMPANY: CompanyProfile = {
  name: 'Company',
  tagline: '',
  legal_name: '',
  code: '',
  address: '',
  phone: '',
  email: '',
  website: '',
  branch_name: '',
  branch_address: '',
  branch_phone: '',
  branch_email: '',
  brand_color: '#1261A0',
  brand_color_secondary: '#00A6A6',
  logo_url: '',
  footer_logo_url: '',
  verify_url: '/verify',
};

let cached: CompanyProfile | null = null;
let inflight: Promise<CompanyProfile> | null = null;

/** Fetch the tenant company profile once per session and memoize it. */
export async function fetchCompanyProfile(): Promise<CompanyProfile> {
  if (cached) return cached;
  if (!inflight) {
    inflight = (async () => {
      try {
        const res = await fetch('/api/public/company');
        if (!res.ok) return FALLBACK_COMPANY;
        const body = (await res.json()) as { data?: Partial<CompanyProfile> } | null;
        const data = body?.data;
        if (!data || typeof data !== 'object') return FALLBACK_COMPANY;
        return { ...FALLBACK_COMPANY, ...data };
      } catch {
        return FALLBACK_COMPANY;
      } finally {
        inflight = null;
      }
    })();
  }
  return inflight;
}

/** Drop the memoized profile so the next fetch re-reads the API. */
export function clearCompanyProfileCache(): void {
  cached = null;
  inflight = null;
}

/** Hook for views that want the tenant's branding profile. */
export function useCompanyProfile(): CompanyProfile {
  const [profile, setProfile] = useState<CompanyProfile>(FALLBACK_COMPANY);
  useEffect(() => {
    let alive = true;
    void fetchCompanyProfile().then((p) => {
      if (alive) setProfile(p);
    });
    return () => {
      alive = false;
    };
  }, []);
  return profile;
}

const LEGAL_SUFFIX = /\b(limited|ltd|plc|inc|incorporated|llc|corp|corporation|group|company|co\.?|enterprise|holdings)\.?$/i;

/** A compact display name for narrow chrome such as the sidebar. */
export function shortCompanyName(name: string): string {
  const cleaned = name
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .replace(LEGAL_SUFFIX, '')
    .trim()
    .replace(LEGAL_SUFFIX, '')
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  return words.slice(0, 2).join(' ') || name || 'Company';
}

/** Branch label used on login/portal screens, e.g. "Kampala" from branch name or address. */
export function branchLabel(p: CompanyProfile): string {
  const fromName = p.branch_name.replace(/\b(headquarters|hq|branch|office)\b\.?/gi, '').trim();
  if (fromName) return fromName;
  const firstLine = p.branch_address.split(',').map((s) => s.trim()).filter(Boolean)[0] ?? '';
  return firstLine || p.branch_name;
}
