/**
 * Corporate brand marks.
 *
 * Branding is asset-driven: every mark renders an image uploaded through
 * Settings -> Company profile. No built-in artwork is ever drawn, so a tenant
 * without an uploaded asset gets text-only chrome instead of a placeholder logo.
 *
 * Uploaded logos are wide wordmarks (the production assets are ~2170x725), so
 * marks are sized by height and take their natural width up to a per-size cap.
 */

import { useState } from 'react';

type Size = 'sm' | 'md' | 'lg';

/** Rendered height in px for the primary mark. */
const MARK_HEIGHT: Record<Size, number> = { sm: 28, md: 38, lg: 56 };
/** Widest the primary mark may grow, so a wide wordmark cannot crowd the chrome. */
const MARK_MAX_WIDTH: Record<Size, number> = { sm: 104, md: 170, lg: 260 };

/** Header-right marks sit shorter than the primary mark. */
const WORDMARK_HEIGHT: Record<Size, number> = { sm: 20, md: 26, lg: 40 };
const WORDMARK_MAX_WIDTH: Record<Size, number> = { sm: 96, md: 150, lg: 220 };

function isHttpUrl(url: string | undefined): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim());
}

/** True when an uploaded (http/https) brand asset is available for the given slot. */
export function hasBrandAsset(url?: string): boolean {
  return isHttpUrl(url);
}

function BrandImage({
  url,
  height,
  maxWidth,
  title,
  className,
}: {
  url?: string;
  height: number;
  maxWidth: number;
  title?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!isHttpUrl(url) || failed) return null;
  return (
    <span className={`brand-mark ${className ?? ''}`.trim()} style={{ height }}>
      <img
        src={url}
        alt={title ?? ''}
        style={{ height, maxWidth }}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </span>
  );
}

/** Primary brand mark rendered from the uploaded `logo_url`. Nothing when unset. */
export function BrandMark({
  size = 'md',
  title,
  className,
  logoUrl,
}: {
  size?: Size;
  title?: string;
  className?: string;
  logoUrl?: string;
}) {
  return (
    <BrandImage
      url={logoUrl}
      height={MARK_HEIGHT[size]}
      maxWidth={MARK_MAX_WIDTH[size]}
      title={title}
      className={`brand-mark-${size} ${className ?? ''}`}
    />
  );
}

/** Secondary brand mark for the right-hand header slot, from the uploaded `footer_logo_url`. */
export function BrandWordmark({
  size = 'md',
  title,
  className,
  logoUrl,
}: {
  size?: Size;
  title?: string;
  className?: string;
  logoUrl?: string;
}) {
  return (
    <BrandImage
      url={logoUrl}
      height={WORDMARK_HEIGHT[size]}
      maxWidth={WORDMARK_MAX_WIDTH[size]}
      title={title}
      className={`brand-mark-wordmark brand-mark-wordmark-${size} ${className ?? ''}`}
    />
  );
}

export function BrandLockup({
  inverted = false,
  compact = false,
  name = 'Company',
  subtitle,
  logoUrl,
}: {
  inverted?: boolean;
  compact?: boolean;
  name?: string;
  subtitle?: string;
  logoUrl?: string;
}) {
  return (
    <span className={`brand-lockup ${inverted ? 'is-inverted' : ''}`}>
      <BrandMark size={compact ? 'sm' : 'md'} logoUrl={logoUrl} />
      <span className="brand-lockup-copy">
        <strong>{name || 'Company'}</strong>
        {!compact && subtitle ? <span className="brand-sub">{subtitle}</span> : null}
      </span>
    </span>
  );
}
