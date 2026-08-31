/**
 * Branded email rendering for all HOPE DESIGN ERP outgoing mail.
 * Every email sent through sendEmail() (Resend or Bird) is wrapped in this
 * template so recipients always see the HOPE DESIGN GROUP LTD identity.
 *
 * The template is email-client safe: tables + inline styles, no external CSS,
 * no scripts. Brand palette: navy #0F172A, red #FF0000, sky blue #87CEEB,
 * white #FFFFFF.
 */

export interface CompanyBrand {
  name: string;
  tagline?: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
}

export const DEFAULT_COMPANY: CompanyBrand = {
  name: 'HOPE DESIGN GROUP LTD',
  tagline: 'Paper Manufacturing & Printing',
  address: 'Plot 12, Namanve Industrial Park, Kampala, Uganda',
  phone: '+256 414 000 000',
  email: 'info@hopedesign.co.ug',
  website: 'https://hopedesign.co.ug',
};

export const BRAND_COLORS = {
  navy: '#0F172A',
  red: '#FF0000',
  sky: '#87CEEB',
  white: '#FFFFFF',
  canvas: '#F4F6FA',
  border: '#E2E8F0',
  muted: '#64748B',
} as const;

const FONT = 'Arial, Helvetica, sans-serif';

export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isFullEmailDocument(html: string): boolean {
  const h = String(html ?? '').trim().toLowerCase();
  return h.startsWith('<!doctype html') || h.startsWith('<html');
}

/** Convert plain text into simple, safe HTML paragraphs. */
export function textToHtml(text: string): string {
  return escapeHtml(text)
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return '';
      if (/^[-*•]\s+/.test(t)) {
        return `<p style="margin:0 0 10px;padding:0;">• ${t.replace(/^[-*•]\s+/, '')}</p>`;
      }
      return `<p style="margin:0 0 10px;padding:0;">${t}</p>`;
    })
    .join('');
}

/** Strip HTML to a plain-text version (for clients that only show text). */
export function stripTags(html: string): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface BrandedEmailOptions {
  subject?: string;
  /** Content of the message. May be HTML or plain text. */
  bodyHtml: string;
  company?: CompanyBrand;
}

export function renderBrandedEmailHtml(opts: BrandedEmailOptions): string {
  const company = opts.company ?? DEFAULT_COMPANY;
  const body = /<\/?[a-z][\s\S]*>/i.test(opts.bodyHtml)
    ? opts.bodyHtml
    : textToHtml(opts.bodyHtml);
  const tagline = company.tagline ? escapeHtml(company.tagline) : '';
  const contactLines = [
    company.address,
    company.phone,
    company.email ? `<a href="mailto:${escapeHtml(company.email)}" style="color:${BRAND_COLORS.navy};text-decoration:underline;">${escapeHtml(company.email)}</a>` : '',
    company.website ? `<a href="${escapeHtml(company.website)}" style="color:${BRAND_COLORS.navy};text-decoration:underline;">${escapeHtml(company.website)}</a>` : '',
  ]
    .filter((l) => String(l).trim().length > 0)
    .join(' &nbsp;·&nbsp; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(opts.subject ?? company.name)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND_COLORS.canvas};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(company.name)}${tagline ? ' — ' + tagline : ''}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND_COLORS.canvas};padding:28px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${BRAND_COLORS.white};border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(15,23,42,0.08);">
        <tr>
          <td style="background:${BRAND_COLORS.navy};padding:22px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="font-family:${FONT};">
                  <div style="font-size:22px;font-weight:700;color:${BRAND_COLORS.white};letter-spacing:1px;line-height:1.2;">HOPE&nbsp;DESIGN</div>
                  <div style="font-size:11px;font-weight:600;color:${BRAND_COLORS.sky};letter-spacing:3px;margin-top:3px;text-transform:uppercase;">Group&nbsp;Ltd${tagline ? ' &nbsp;·&nbsp; ' + tagline : ''}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="height:4px;font-size:0;line-height:0;background:${BRAND_COLORS.red};">&nbsp;</td>
        </tr>
        <tr>
          <td style="padding:30px 32px;font-family:${FONT};font-size:14px;line-height:1.65;color:${BRAND_COLORS.navy};">
            ${body}
          </td>
        </tr>
        <tr>
          <td style="background:#F8FAFC;border-top:1px solid ${BRAND_COLORS.border};padding:20px 32px;font-family:${FONT};">
            <div style="font-size:13px;font-weight:700;color:${BRAND_COLORS.navy};letter-spacing:.4px;">${escapeHtml(company.name)}</div>
            ${contactLines ? `<div style="font-size:12px;color:${BRAND_COLORS.muted};margin-top:6px;line-height:1.7;">${contactLines}</div>` : ''}
            <div style="font-size:11px;color:#94A3B8;margin-top:12px;line-height:1.6;border-top:1px solid ${BRAND_COLORS.border};padding-top:10px;">
              This is an automated message from the HOPE DESIGN ERP. Please do not reply to this email. &copy; ${new Date().getFullYear()} ${escapeHtml(company.name)}. All rights reserved.
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/**
 * Brand the content of an outgoing email before dispatch.
 * - A complete HTML document is passed through untouched.
 * - An HTML fragment or plain text is wrapped in the branded template.
 * - A plain-text version is always produced for text-only clients.
 */
export function brandEmailContent(opts: {
  subject: string;
  html?: string | null;
  text?: string | null;
}): { html: string; text: string } {
  const subject = String(opts.subject ?? 'HOPE DESIGN ERP');
  const html = opts.html ? String(opts.html) : '';
  const text = opts.text ? String(opts.text) : '';
  if (html && isFullEmailDocument(html)) {
    return { html, text: text || stripTags(html) };
  }
  const bodySource = html || text;
  const bodyHtml = bodySource || '';
  return {
    html: renderBrandedEmailHtml({ subject, bodyHtml }),
    text: text || stripTags(bodyHtml),
  };
}
