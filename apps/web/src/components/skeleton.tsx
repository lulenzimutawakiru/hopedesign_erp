/**
 * Skeleton primitives. Kept import-free (no auth, no router) so both the low-level
 * ui module and the higher-level states module can compose them without a cycle.
 */

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skel-wrap" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="skel" />)}
    </div>
  );
}

export function Line({ w }: { w?: string }) {
  return <span className="skel skel-line" style={w ? { width: w } : undefined} aria-hidden />;
}

export function TableSkeleton({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="skel-wrap" aria-busy="true" aria-label="Loading table">
      <div className="skel-table" aria-hidden>
        <div className="skel-tr skel-tr-head">
          {Array.from({ length: cols }).map((_, i) => <span key={i} className="skel skel-cell" />)}
        </div>
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="skel-tr">
            {Array.from({ length: cols }).map((_, c) => (
              <span key={c} className="skel skel-cell" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CardSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="skel-cards" aria-busy="true" aria-label="Loading summary">
      {Array.from({ length: count }).map((_, i) => <span key={i} className="skel skel-card" aria-hidden />)}
    </div>
  );
}

export function FormSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="skel-form" aria-busy="true" aria-label="Loading form">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skel-field" aria-hidden>
          <span className="skel skel-line" style={{ width: '32%' }} />
          <span className="skel skel-input" />
        </div>
      ))}
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="skel-dash" aria-busy="true" aria-label="Loading dashboard">
      <CardSkeleton count={4} />
      <div className="skel-panels" aria-hidden>
        <span className="skel skel-panel" />
        <span className="skel skel-panel" />
      </div>
    </div>
  );
}
