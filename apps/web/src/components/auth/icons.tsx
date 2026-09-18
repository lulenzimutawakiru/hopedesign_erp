/**
 * Sign-in chrome iconography.
 *
 * The web app carries no icon dependency, so the sign-in surface draws its own
 * inline SVG. Every glyph is a 24x24 stroke path on `currentColor`, which keeps
 * it themeable, scalable and consistent with the button and field colours
 * without pulling in a library for a dozen shapes.
 *
 * Icons are decorative by default (`aria-hidden`); pass `title` only when the
 * glyph is the sole carrier of meaning, and the element becomes `role="img"`
 * with an accessible name.
 */

import type { ReactNode } from 'react';

export interface IconProps {
  /** Rendered square size in px. */
  size?: number;
  /** Accessible name. When omitted the glyph is hidden from assistive tech. */
  title?: string;
  className?: string;
}

const STROKE = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function Icon({ size = 18, title, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      {...STROKE}
      width={size}
      height={size}
      className={className ? `auth-icon ${className}` : 'auth-icon'}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 12.4a4.1 4.1 0 1 0 0-8.2 4.1 4.1 0 0 0 0 8.2Z" />
      <path d="M4.4 20.2a7.6 7.6 0 0 1 15.2 0" />
    </Icon>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4.6" y="10.2" width="14.8" height="10.2" rx="2.2" />
      <path d="M8.2 10.2V7.6a3.8 3.8 0 0 1 7.6 0v2.6" />
      <path d="M12 14.4v2.2" />
    </Icon>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.6 12S6 6.4 12 6.4 21.4 12 21.4 12 18 17.6 12 17.6 2.6 12 2.6 12Z" />
      <circle cx="12" cy="12" r="2.9" />
    </Icon>
  );
}

export function EyeOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.6 6.8A9.3 9.3 0 0 1 12 6.4c6 0 9.4 5.6 9.4 5.6a16 16 0 0 1-2.9 3.5" />
      <path d="M6.3 8.3A16 16 0 0 0 2.6 12S6 17.6 12 17.6c1.5 0 2.8-.4 4-.9" />
      <path d="M10 10a2.9 2.9 0 0 0 4 4" />
      <path d="M3.6 3.6l16.8 16.8" />
    </Icon>
  );
}

export function ShieldCheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.2 5 6v5.4c0 4.3 2.9 7.6 7 9.4 4.1-1.8 7-5.1 7-9.4V6l-7-2.8Z" />
      <path d="M9 12.1l2.2 2.2 4-4.2" />
    </Icon>
  );
}

export function GlobeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M3.6 12h16.8" />
      <path d="M12 3.4c2.2 2.4 3.3 5.3 3.3 8.6S14.2 18.2 12 20.6c-2.2-2.4-3.3-5.3-3.3-8.6S9.8 5.8 12 3.4Z" />
    </Icon>
  );
}

export function HelpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M9.7 9.4a2.5 2.5 0 0 1 4.7 1.2c0 1.7-2.3 2.1-2.3 3.6" />
      <path d="M12.1 17.2h.01" />
    </Icon>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4.3 3.1 19.4h17.8L12 4.3Z" />
      <path d="M12 10v4.1" />
      <path d="M12 17h.01" />
    </Icon>
  );
}

export function CheckCircleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M8.3 12.2l2.5 2.5 4.9-5.1" />
    </Icon>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 11v5.2" />
      <path d="M12 7.9h.01" />
    </Icon>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M18.6 12H5.4" />
      <path d="M11 5.6 4.6 12l6.4 6.4" />
    </Icon>
  );
}

export function MailIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.2" y="5.4" width="17.6" height="13.2" rx="2.2" />
      <path d="m3.9 7.2 8.1 5.6 8.1-5.6" />
    </Icon>
  );
}

export function PhoneIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8.1 3.8 10 8l-2 1.7a11.4 11.4 0 0 0 5.4 5.4l1.7-2 4.2 1.9v3.1c0 1-.9 1.9-1.9 1.8A16.6 16.6 0 0 1 3.2 6.2c0-1 .8-1.9 1.8-1.9h3.1Z" />
    </Icon>
  );
}

export function KeyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="15.8" r="3.6" />
      <path d="m10.7 13.2 7.6-7.6" />
      <path d="m15.3 5.6 3.1 3.1" />
      <path d="m13.2 7.7 3.1 3.1" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 12.6 4.6 4.6L19 6.8" />
    </Icon>
  );
}

export interface BrandGlyphProps {
  /** Rendered square size in px. */
  size?: number;
  /** Accessible name. When omitted the glyph is hidden from assistive tech. */
  title?: string;
  className?: string;
  /** Background plate colour. */
  plate?: string;
  /** Upright bar colour. */
  bar?: string;
  /** Horizontal band colour. */
  band?: string;
  /** Centre cross colour. */
  cross?: string;
}

/**
 * The HOPE DESIGN mark, drawn inline.
 *
 * This is the same artwork the organisation ships as `public/logo.svg` and
 * `public/favicon.svg`. Corporate marks elsewhere in the app are strictly
 * asset-driven (see `components/BrandMark`), which leaves text-only chrome
 * whenever a tenant has not uploaded a wordmark. Drawing the organisation's own
 * shipped glyph here means the sign-in header always carries real brand
 * artwork, and it costs no request and no dependency.
 */
export function BrandGlyph({
  size = 40,
  title,
  className,
  plate = '#1261A0',
  bar = '#FFFFFF',
  band = '#00A6A6',
  cross = '#0B1F33',
}: BrandGlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      className={className ? `auth-glyph ${className}` : 'auth-glyph'}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <rect width="40" height="40" rx="8" fill={plate} />
      <rect x="8" y="8" width="6.2" height="24" rx="1.2" fill={bar} />
      <rect x="25.8" y="8" width="6.2" height="24" rx="1.2" fill={bar} />
      <rect x="8" y="17" width="24" height="6" rx="1" fill={band} />
      <rect x="18.6" y="14.4" width="2.8" height="11.2" rx="0.4" fill={cross} />
      <rect x="14.4" y="18.6" width="11.2" height="2.8" rx="0.4" fill={cross} />
    </svg>
  );
}
