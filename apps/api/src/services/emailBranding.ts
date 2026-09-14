/**
 * Branded email rendering for all HOPE DESIGN outgoing mail.
 * Every email sent through sendEmail() (Resend) is wrapped in this template
 * so recipients always see the HOPE DESIGN GROUP LTD identity.
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
  /** Uploaded primary logo, rendered at the left of the header. Absolute https URL. */
  logoUrl?: string;
  /** Uploaded secondary logo, rendered at the far right of the header. */
  footerLogoUrl?: string;
  /** Primary brand colour for the header band. Falls back to the brand navy. */
  brandColor?: string;
  /** Secondary brand colour for the header accent rule. Falls back to brand red. */
  brandColorSecondary?: string;
}

export interface EmailActionButton {
  label: string;
  url: string;
}

export const DEFAULT_COMPANY: CompanyBrand = {
  name: 'HOPE DESIGN GROUP LTD',
  tagline: 'Paper Manufacturing & Printing',
  address: 'Plot 12, Namanve Industrial Park, Kampala, Uganda',
  phone: '+256 414 000 000',
  email: 'info@hopedesign.jorlentech.com',
  website: 'https://hopedesign.jorlentech.com',
};

export const BRAND_COLORS = {
  navy: '#0F172A',
  red: '#FF0000',
  sky: '#87CEEB',
  white: '#FFFFFF',
  canvas: '#F4F6FA',
  border: '#E2E8F0',
  muted: '#64748B',
  body: '#1E293B',
  softMuted: '#94A3B8',
} as const;

const FONT = 'Arial, Helvetica, sans-serif';
const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

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

/** Turn bare http(s) URLs in (already-escaped) text into styled anchors. */
function autoLinkify(text: string): string {
  return text.replace(URL_RE, (full) => {
    const tail = full.match(/[.,;:!?]+$/)?.[0] ?? '';
    const core = tail ? full.slice(0, -tail.length) : full;
    return `<a href="${core}" style="color:${BRAND_COLORS.navy};font-weight:600;text-decoration:underline;">${core}</a>${tail}`;
  });
}

/** Add brand styling to existing anchors inside an HTML fragment. */
function styleAnchors(html: string): string {
  return String(html).replace(/<a\s+([^>]*?)>/gi, (_m, attrs: string) => {
    const a = String(attrs ?? '');
    if (/\sstyle=/i.test(a)) return `<a ${a}>`;
    return `<a ${a} style="color:${BRAND_COLORS.navy};font-weight:600;text-decoration:underline;">`;
  });
}

/** Render a primary call-to-action button block. */
function renderButton(button: EmailActionButton): string {
  const href = escapeHtml(button.url);
  const label = escapeHtml(button.label);
  return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 6px;">
          <tr>
            <td align="center">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:8px;background:${BRAND_COLORS.navy};mso-padding-alt:14px 30px;">
                    <a href="${href}" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:14px;font-weight:700;color:${BRAND_COLORS.white};text-decoration:none;border-radius:8px;background:${BRAND_COLORS.navy};">${label}&nbsp;&rarr;</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>`;
}

/**
 * Uploaded assets are embedded by absolute https URL only: mail clients block
 * http and relative sources, and an unset value must render nothing rather
 * than a built-in mark.
 */
function httpsUrl(v: string | undefined): string {
  const s = String(v ?? '').trim();
  return /^https:\/\/\S+$/i.test(s) ? s : '';
}

/** Constrain a colour to a literal hex triple so a setting cannot inject CSS. */
function safeHex(v: string | undefined, fallback: string): string {
  const s = String(v ?? '').trim();
  return /^#[0-9a-f]{6}$/i.test(s) ? s : fallback;
}

export interface EmailLogoOptions {
  /** Rendered height in CSS pixels; width follows the asset's own aspect ratio. */
  height: number;
  /** Upper bound so a wide wordmark cannot overflow the message container. */
  maxWidth: number;
  alt: string;
}

/**
 * Render an uploaded logo for email. The height is fixed and the width is left
 * to the asset's own aspect ratio - uploaded wordmarks are roughly 3:1, so a
 * square box would squash them. Returns '' when nothing usable is configured.
 */
export function emailLogoHtml(url: string | undefined, opts: EmailLogoOptions): string {
  const src = httpsUrl(url);
  if (!src) return '';
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(opts.alt)}" height="${opts.height}" style="display:block;height:${opts.height}px;width:auto;max-width:${opts.maxWidth}px;border:0;outline:none;text-decoration:none;">`;
}

/** Convert plain text into simple, safe HTML paragraphs. */
export function textToHtml(text: string): string {
  return escapeHtml(text)
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return '';
      if (/^[-*•]\s+/.test(t)) {
        return `<p style="margin:0 0 10px;padding:0;">• ${autoLinkify(t.replace(/^[-*•]\s+/, ''))}</p>`;
      }
      return `<p style="margin:0 0 10px;padding:0;">${autoLinkify(t)}</p>`;
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
  /** Optional preheader text shown beside the subject in most clients. */
  preheader?: string;
  /** Optional primary call-to-action button rendered after the body. */
  button?: EmailActionButton | null;
}

export function renderBrandedEmailHtml(opts: BrandedEmailOptions): string {
  const company = opts.company ?? DEFAULT_COMPANY;
  const rawBody = /<\/?[a-z][\s\S]*>/i.test(opts.bodyHtml) ? opts.bodyHtml : textToHtml(opts.bodyHtml);
  const body = styleAnchors(rawBody);
  const tagline = company.tagline ? escapeHtml(company.tagline) : '';
  const preheaderText = opts.preheader
    ? escapeHtml(opts.preheader)
    : escapeHtml(`${company.name}${tagline ? ' — ' + tagline : ''}`);
  const button = opts.button && opts.button.label && opts.button.url ? renderButton(opts.button) : '';
  const year = new Date().getFullYear();
  const headerBand = safeHex(company.brandColor, BRAND_COLORS.navy);
  const accent = safeHex(company.brandColorSecondary, BRAND_COLORS.red);
  const leftMark = emailLogoHtml(company.logoUrl, {
    height: 34,
    maxWidth: 220,
    alt: company.name,
  });
  const rightMark = emailLogoHtml(company.footerLogoUrl, {
    height: 24,
    maxWidth: 140,
    alt: company.name,
  });
  const wordmark = leftMark
    ? leftMark
    : `<div style="font-size:23px;font-weight:800;color:${BRAND_COLORS.white};letter-spacing:1.5px;line-height:1.1;">${escapeHtml(company.name)}</div>`;

  const contactPairs = (
    [
      ['Address', company.address],
      ['Phone', company.phone],
      ['Email', company.email],
      ['Website', company.website],
    ] as [string, string | undefined][]
  ).filter((p) => p[1] && String(p[1]).trim().length > 0) as [string, string][];

  const contactCells = contactPairs
    .map(([label, value]) => {
      const val =
        label === 'Email' && company.email
          ? `<a href="mailto:${escapeHtml(company.email)}" style="color:${BRAND_COLORS.navy};text-decoration:underline;">${escapeHtml(company.email)}</a>`
          : label === 'Website' && company.website
            ? `<a href="${escapeHtml(company.website)}" style="color:${BRAND_COLORS.navy};text-decoration:underline;">${escapeHtml(company.website)}</a>`
            : escapeHtml(value);
      return `
            <td width="50%" style="padding:10px 16px 10px 0;font-family:${FONT};vertical-align:top;">
              <div style="font-size:10px;font-weight:700;color:${BRAND_COLORS.red};letter-spacing:1.5px;text-transform:uppercase;margin-bottom:3px;">${escapeHtml(label)}</div>
              <div style="font-size:12.5px;color:${BRAND_COLORS.navy};line-height:1.5;">${val}</div>
            </td>`;
    })
    .join('');
  const contactBlock =
    contactPairs.length > 0
      ? `
          <tr>
            <td style="padding:0 36px;background:#F8FAFC;font-family:${FONT};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>${contactCells}</tr>
              </table>
            </td>
          </tr>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(opts.subject ?? company.name)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND_COLORS.canvas};-webkit-text-size-adjust:100%;word-spacing:normal;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:transparent;">${preheaderText}&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND_COLORS.canvas};padding:32px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${BRAND_COLORS.white};border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(15,23,42,0.10);">
        <tr>
          <td style="background:${headerBand};padding:26px 36px 20px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="font-family:${FONT};vertical-align:middle;">
                  ${wordmark}
                  ${tagline ? `<div style="font-size:11px;color:${BRAND_COLORS.softMuted};letter-spacing:.5px;margin-top:6px;line-height:1.5;">${tagline}</div>` : ''}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 36px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td width="50%" style="height:3px;font-size:0;line-height:0;background:${accent};border-radius:2px 0 0 2px;">&nbsp;</td>
                <td width="50%" style="height:3px;font-size:0;line-height:0;background:${BRAND_COLORS.sky};border-radius:0 2px 2px 0;">&nbsp;</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:30px 36px 26px;font-family:${FONT};font-size:15px;line-height:1.7;color:${BRAND_COLORS.body};">
            ${body}
            ${button}
          </td>
        </tr>
        <tr>
          <td style="border-top:1px solid ${BRAND_COLORS.border};background:#F8FAFC;padding:18px 36px 0;font-family:${FONT};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="vertical-align:middle;">
                  <div style="font-size:14px;font-weight:800;color:${BRAND_COLORS.navy};letter-spacing:.4px;">${escapeHtml(company.name)}</div>
                  ${tagline ? `<div style="font-size:12px;color:${BRAND_COLORS.muted};margin-top:2px;">${tagline}</div>` : ''}
                </td>
                <td align="right" style="vertical-align:middle;">${rightMark}</td>
              </tr>
            </table>
          </td>
        </tr>
        ${contactBlock}
        <tr>
          <td style="background:#F8FAFC;padding:14px 36px 22px;font-family:${FONT};">
            <div style="font-size:11px;color:${BRAND_COLORS.softMuted};line-height:1.7;border-top:1px solid ${BRAND_COLORS.border};padding-top:14px;">
              This is an automated message from HOPE DESIGN. Please do not reply to this email.<br>
              &copy; ${year} ${escapeHtml(company.name)}. All rights reserved.
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
  button?: EmailActionButton | null;
  preheader?: string | null;
  /** Tenant brand assets. Omit to render the shipped default identity. */
  company?: CompanyBrand;
}): { html: string; text: string } {
  const subject = String(opts.subject ?? 'HOPE DESIGN');
  const html = opts.html ? String(opts.html) : '';
  const text = opts.text ? String(opts.text) : '';
  if (html && isFullEmailDocument(html)) {
    return { html, text: text || stripTags(html) };
  }
  const bodySource = html || text;
  const bodyHtml = bodySource || '';
  return {
    html: renderBrandedEmailHtml({
      subject,
      bodyHtml,
      company: opts.company,
      button: opts.button ?? undefined,
      preheader: opts.preheader ?? undefined,
    }),
    text: text || stripTags(bodyHtml),
  };
}
