import { describe, it, expect } from 'vitest';
import { emailLogoHtml, renderBrandedEmailHtml } from '../src/services/emailBranding.js';
import { renderBrandedHtml, type CompanyProfile } from '../src/services/branding.js';

/**
 * Branding is asset-driven: every mark must come from an uploaded brand asset.
 * These tests pin the "no hard-coded artwork" rule and the aspect-aware sizing
 * that the ~3:1 production wordmarks depend on.
 */

const PRIMARY = 'https://example.com/branding/logo.png';
const SECONDARY = 'https://example.com/branding/footer-logo.png';

function profile(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    name: 'Hope Design Group Ltd',
    tagline: 'For your success',
    legalName: 'Hope Design Group Limited',
    code: 'HDG',
    tin: '',
    vrn: '',
    currency: 'UGX',
    address: 'Namanve',
    phone: '',
    email: '',
    supportEmail: '',
    website: '',
    branchName: 'Kampala',
    branchAddress: '',
    branchPhone: '',
    branchEmail: '',
    verifyUrl: 'https://example.com/verify',
    brandEnabled: true,
    verifyEnabled: true,
    pdfStamp: false,
    footerText: '',
    brandColor: '#1261A0',
    brandColorSecondary: '#FF0000',
    logoUrl: '',
    footerLogoUrl: '',
    signatureUrl: '',
    autoSignEnabled: false,
    autoSignName: '',
    autoSignRole: '',
    ...overrides,
  };
}

describe('email mark rendering', () => {
  it('renders nothing for a missing or non-https asset', () => {
    const opts = { height: 34, maxWidth: 220, alt: 'Hope Design' };
    expect(emailLogoHtml(undefined, opts)).toBe('');
    expect(emailLogoHtml('', opts)).toBe('');
    expect(emailLogoHtml('   ', opts)).toBe('');
    expect(emailLogoHtml('/branding/logo.png', opts)).toBe('');
    expect(emailLogoHtml('http://example.com/logo.png', opts)).toBe('');
  });

  it('sizes by height and keeps the asset aspect ratio', () => {
    const html = emailLogoHtml(PRIMARY, { height: 34, maxWidth: 220, alt: 'Hope Design' });
    expect(html).toContain(`src="${PRIMARY}"`);
    expect(html).toContain('height="34"');
    expect(html).toContain('height:34px;width:auto;max-width:220px;');
    expect(html).not.toContain('width="34"');
  });
});

describe('branded email header and footer', () => {
  it('draws both uploaded marks and no built-in artwork', () => {
    const html = renderBrandedEmailHtml({
      subject: 'Ticket created',
      bodyHtml: 'Hello',
      company: {
        name: 'Hope Design Group Ltd',
        tagline: 'For your success',
        logoUrl: PRIMARY,
        footerLogoUrl: SECONDARY,
        brandColor: '#1261A0',
        brandColorSecondary: '#ff0000',
      },
    });
    expect(html).toContain(`src="${PRIMARY}"`);
    expect(html).toContain(`src="${SECONDARY}"`);
    expect(html).toContain('background:#1261A0');
    expect(html).toContain('background:#ff0000');
    expect(html).not.toContain('>HD<');
    expect(html).not.toContain('HOPE&nbsp;DESIGN');
    expect(html).not.toContain('<svg');
  });

  it('degrades to the company name when no asset is uploaded', () => {
    const html = renderBrandedEmailHtml({
      subject: 'Ticket created',
      bodyHtml: 'Hello',
      company: { name: 'Hope Design Group Ltd', logoUrl: '', footerLogoUrl: '' },
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('Hope Design Group Ltd');
    expect(html).not.toContain('>HD<');
    expect(html).not.toContain('<svg');
  });
});

describe('branded print letterhead', () => {
  const base = {
    title: 'Quotation',
    issuedBy: 'Sales',
    issuedAt: '2026-09-14T09:00:00Z',
    body: '<p>Body</p>',
  };

  it('renders no mark at all when nothing has been uploaded', async () => {
    const html = await renderBrandedHtml({ ...base, company: profile() });
    expect(html).not.toContain('class="brand-logo"');
    expect(html).not.toContain('class="foot-logo"');
  });

  it('renders the primary mark in the header and the secondary mark in the footer', async () => {
    const html = await renderBrandedHtml({
      ...base,
      company: profile({ logoUrl: PRIMARY, footerLogoUrl: SECONDARY }),
    });
    expect(html).toContain(`class="brand-logo" src="${PRIMARY}"`);
    expect(html).toContain(`class="foot-logo" src="${SECONDARY}"`);
  });
});
