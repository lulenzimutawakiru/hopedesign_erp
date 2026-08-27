/** Hope Design Group mark — paper mill columns + security-print register bar. */

type Size = 'sm' | 'md' | 'lg';
type Tone = 'hope' | 'navy' | 'paper';

const PX: Record<Size, number> = { sm: 28, md: 38, lg: 56 };

export function BrandMark({
  size = 'md',
  tone = 'hope',
  title = 'Hope Design Group',
  className,
}: {
  size?: Size;
  tone?: Tone;
  title?: string;
  className?: string;
}) {
  const px = PX[size];
  const fill = tone === 'navy' ? '#0B1F33' : tone === 'paper' ? '#F5F7FA' : '#1261A0';
  const paper = tone === 'paper' ? '#0B1F33' : '#FFFFFF';
  const bar = tone === 'paper' ? '#00A6A6' : '#00A6A6';
  const register = tone === 'paper' ? '#0B1F33' : '#0B1F33';
  return (
    <span className={`brand-mark brand-mark-${size} ${className ?? ''}`} style={{ width: px, height: px }} aria-hidden={title ? undefined : true}>
      <svg viewBox="0 0 40 40" width={px} height={px} role="img" aria-label={title}>
        <title>{title}</title>
        <rect width="40" height="40" rx="8" fill={fill} />
        <rect x="8" y="8" width="6.2" height="24" rx="1.2" fill={paper} />
        <rect x="25.8" y="8" width="6.2" height="24" rx="1.2" fill={paper} />
        <rect x="8" y="17" width="24" height="6" rx="1" fill={bar} />
        <rect x="18.6" y="14.4" width="2.8" height="11.2" rx="0.4" fill={register} />
        <rect x="14.4" y="18.6" width="11.2" height="2.8" rx="0.4" fill={register} />
      </svg>
    </span>
  );
}

export function BrandLockup({
  inverted = false,
  compact = false,
}: {
  inverted?: boolean;
  compact?: boolean;
}) {
  return (
    <span className={`brand-lockup ${inverted ? 'is-inverted' : ''}`}>
      <BrandMark size={compact ? 'sm' : 'md'} tone={inverted ? 'hope' : 'hope'} />
      <span className="brand-lockup-copy">
        <strong>Hope OS</strong>
        {!compact && <span className="brand-sub">Design Group</span>}
      </span>
    </span>
  );
}
