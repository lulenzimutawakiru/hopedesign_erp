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
  /** Uploaded secondary logo, rendered at the far right of the header band. */
  secondaryLogoUrl?: string;
  /** Uploaded footer logo, rendered in the document-control footer. */
  footerLogoUrl?: string;
  /** Primary brand colour for the header band. Falls back to the brand navy. */
  brandColor?: string;
  /** Secondary brand colour for the header accent rule. Falls back to brand red. */
  brandColorSecondary?: string;
  /** Public social profiles, rendered as links in the email footer. */
  socials?: Array<{ label: string; url: string }>;
}

export interface EmailActionButton {
  label: string;
  url: string;
}

export const DEFAULT_COMPANY: CompanyBrand = {
  name: 'HOPE DESIGN GROUP LTD',
  tagline: 'Paper Manufacturing & Printing',
  address: '',
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
export function renderButton(button: EmailActionButton): string {
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

export const EMAIL_SOCIAL_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'social_facebook', label: 'Facebook' },
  { key: 'social_instagram', label: 'Instagram' },
  { key: 'social_linkedin', label: 'LinkedIn' },
  { key: 'social_x', label: 'X' },
  { key: 'social_youtube', label: 'YouTube' },
  { key: 'social_tiktok', label: 'TikTok' },
  { key: 'social_whatsapp', label: 'WhatsApp' },
];

function socialHref(label: string, raw: unknown): string {
  let s = raw == null ? '' : String(raw).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
  if (/^https:\/\/\S+$/i.test(s)) return s;
  if (label === 'WhatsApp') {
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 15) return 'https://wa.me/' + digits;
  }
  return '';
}

/** Public social links stored under General settings. Only https links are rendered. */
export function socialLinksFromValues(values: Record<string, unknown> | null | undefined): Array<{ label: string; url: string }> {
  const src = values && typeof values === 'object' ? values : {};
  const out: Array<{ label: string; url: string }> = [];
  for (const field of EMAIL_SOCIAL_FIELDS) {
    const url = socialHref(field.label, src[field.key]);
    if (url) out.push({ label: field.label, url });
  }
  return out;
}


export function renderBrandedEmailHtml(opts: BrandedEmailOptions): string {
  const company = opts.company ?? DEFAULT_COMPANY;
  const rawBody = /<\/?[a-z][\s\S]*>/i.test(opts.bodyHtml) ? opts.bodyHtml : textToHtml(opts.bodyHtml);
  const body = styleAnchors(rawBody);
  const name = escapeHtml(company.name || '');
  const tagline = company.tagline ? escapeHtml(company.tagline) : '';
  const preheaderText = opts.preheader
    ? escapeHtml(opts.preheader)
    : escapeHtml(company.name + (company.tagline ? ' \u2014 ' + company.tagline : ''));
  const button = opts.button && opts.button.label && opts.button.url ? renderButton(opts.button) : '';
  const year = new Date().getFullYear();
  const headerBand = safeHex(company.brandColor, BRAND_COLORS.navy);
  const accent = safeHex(company.brandColorSecondary, BRAND_COLORS.red);
  const ink = BRAND_COLORS.navy;
  const quiet = '#3D4C5C';
  const headerLogo = emailLogoHtml(company.logoUrl, { height: 42, maxWidth: 168, alt: company.name });
  const secondaryLogo = emailLogoHtml(company.secondaryLogoUrl, { height: 36, maxWidth: 132, alt: company.name });
  const footerLogo = emailLogoHtml(company.footerLogoUrl || company.logoUrl, { height: 40, maxWidth: 148, alt: company.name });

  const contactPairs = [
    ['Address', company.address, ''],
    ['Phone', company.phone, company.phone ? 'tel:' + String(company.phone).replace(/\s/g, '') : ''],
    ['Email', company.email, company.email ? 'mailto:' + company.email : ''],
    ['Website', company.website, company.website && /^https:\/\//i.test(company.website) ? company.website : ''],
  ].filter((row) => row[1] && String(row[1]).trim());

  const contactRows = [];
  for (let i = 0; i < contactPairs.length; i += 2) {
    const pair = contactPairs.slice(i, i + 2);
    const cells = pair.map(([label, value, href]) => {
      const shown = escapeHtml(String(value));
      const inner = href
        ? '<a href="' + escapeHtml(href) + '" style="color:' + ink + ';text-decoration:underline;">' + shown + '</a>'
        : shown;
      return '<td width="50%" valign="top" style="padding:0 16px 14px 0;font-family:' + FONT + ';">'
        + '<div style="margin:0 0 3px;font-size:11px;line-height:1.3;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:' + quiet + ';">' + escapeHtml(label) + '</div>'
        + '<div style="margin:0;font-size:14px;line-height:1.45;font-weight:600;color:' + ink + ';word-break:break-word;">' + inner + '</div>'
        + '</td>';
    }).join('');
    const pad = pair.length === 1 ? '<td width="50%" style="padding:0;font-size:0;line-height:0;">&nbsp;</td>' : '';
    contactRows.push('<tr>' + cells + pad + '</tr>');
  }
  const contactBlock = contactRows.length
    ? '<tr><td style="padding:18px 32px 4px;background:#F7F9FB;font-family:' + FONT + ';">'
      + '<div style="margin:0 0 12px;font-size:12px;line-height:1.3;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:' + quiet + ';">Contact</div>'
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + contactRows.join('') + '</table>'
      + '</td></tr>'
    : '';

  const marks = { Facebook: 'f', Instagram: 'Ig', LinkedIn: 'in', X: 'X', YouTube: 'Yt', TikTok: 'Tt', WhatsApp: 'Wa' };
  const socials = (Array.isArray(company.socials) ? company.socials : []).filter((s) => s && s.label && s.url);
  const socialRows = [];
  for (let i = 0; i < socials.length; i += 2) {
    const pair = socials.slice(i, i + 2);
    const cells = pair.map((s) => {
      const mark = marks[s.label] || String(s.label).slice(0, 2);
      const size = mark.length > 1 ? '11px' : '15px';
      return '<td width="50%" valign="middle" style="padding:0 12px 12px 0;">'
        + '<table role="presentation" cellpadding="0" cellspacing="0"><tr>'
        + '<td bgcolor="' + ink + '" align="center" valign="middle" width="32" height="32" '
        + 'style="width:32px;height:32px;background:' + ink + ';color:#FFFFFF;font-family:' + FONT + ';font-size:' + size + ';font-weight:700;line-height:32px;text-align:center;">'
        + escapeHtml(mark) + '</td>'
        + '<td valign="middle" style="padding-left:10px;font-family:' + FONT + ';font-size:14px;line-height:1.3;font-weight:700;">'
        + '<a href="' + escapeHtml(s.url) + '" style="color:' + ink + ';text-decoration:none;">' + escapeHtml(s.label) + '</a>'
        + '</td></tr></table></td>';
    }).join('');
    const pad = pair.length === 1 ? '<td width="50%" style="padding:0;font-size:0;line-height:0;">&nbsp;</td>' : '';
    socialRows.push('<tr>' + cells + pad + '</tr>');
  }
  const socialBlock = socialRows.length
    ? '<tr><td style="padding:4px 32px 6px;background:#F7F9FB;font-family:' + FONT + ';">'
      + '<div style="margin:0 0 12px;font-size:12px;line-height:1.3;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:' + quiet + ';">Social</div>'
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + socialRows.join('') + '</table>'
      + '</td></tr>'
    : '';

  const headerName = '<div style="margin:0;font-family:' + FONT + ';font-size:22px;line-height:1.25;font-weight:700;letter-spacing:0;color:#FFFFFF;">' + name + '</div>'
    + (tagline ? '<div style="margin:4px 0 0;font-family:' + FONT + ';font-size:13px;line-height:1.4;font-weight:600;letter-spacing:0.02em;color:#F4F7FB;">' + tagline + '</div>' : '');

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
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND_COLORS.canvas};padding:28px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${BRAND_COLORS.white};border:1px solid ${BRAND_COLORS.border};border-radius:10px;overflow:hidden;">
        <tr>
          <td bgcolor="${headerBand}" style="background:${headerBand};padding:24px 32px 22px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                ${headerLogo ? '<td valign="middle" width="180" style="padding-right:16px;vertical-align:middle;">' + headerLogo + '</td>' : ''}
                <td valign="middle" style="vertical-align:middle;font-family:${FONT};">${headerName}</td>
                ${secondaryLogo ? '<td valign="middle" align="right" width="140" style="padding-left:16px;vertical-align:middle;">' + secondaryLogo + '</td>' : ''}
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0;font-size:0;line-height:0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td width="50%" bgcolor="${accent}" style="height:4px;font-size:0;line-height:0;background:${accent};">&nbsp;</td>
                <td width="50%" bgcolor="${BRAND_COLORS.sky}" style="height:4px;font-size:0;line-height:0;background:${BRAND_COLORS.sky};">&nbsp;</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 28px;font-family:${FONT};font-size:15px;line-height:1.65;color:${BRAND_COLORS.body};">
            ${body}
            ${button}
          </td>
        </tr>
        <tr>
          <td bgcolor="#F7F9FB" style="background:#F7F9FB;border-top:1px solid ${BRAND_COLORS.border};padding:22px 32px 16px;font-family:${FONT};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                ${footerLogo ? '<td valign="middle" width="160" style="padding-right:16px;vertical-align:middle;">' + footerLogo + '</td>' : ''}
                <td valign="middle" style="vertical-align:middle;">
                  <div style="margin:0;font-size:20px;line-height:1.25;font-weight:700;letter-spacing:0;color:${ink};">${name}</div>
                  ${tagline ? '<div style="margin:4px 0 0;font-size:13px;line-height:1.4;font-weight:600;color:' + quiet + ';">' + tagline + '</div>' : ''}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        ${socialBlock}
        ${contactBlock}
        <tr>
          <td bgcolor="#F7F9FB" style="background:#F7F9FB;padding:8px 32px 22px;font-family:${FONT};">
            <div style="border-top:1px solid ${BRAND_COLORS.border};padding-top:14px;font-size:12px;line-height:1.6;color:${quiet};">
              This is an automated message from <strong style="color:${ink};">${name}</strong>. Please do not reply to this email.<br>
              &copy; ${year} <strong style="color:${ink};">${name}</strong>. All rights reserved.
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


function emailIdentityText(company) {
  const c = company ?? DEFAULT_COMPANY;
  const lines = ['', c.name || ''];
  if (c.tagline) lines.push(String(c.tagline));
  for (const row of [c.address, c.phone, c.email, c.website]) {
    if (row && String(row).trim()) lines.push(String(row).trim());
  }
  for (const s of Array.isArray(c.socials) ? c.socials : []) {
    if (s && s.label && s.url) lines.push(String(s.label) + ': ' + String(s.url));
  }
  return lines.join('\n');
}

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
    text: [text || stripTags(bodyHtml), emailIdentityText(opts.company)].filter(Boolean).join('\n'),
  };
}
