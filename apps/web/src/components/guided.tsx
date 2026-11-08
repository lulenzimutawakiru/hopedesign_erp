import type { ReactNode } from 'react';

/**
 * Guided-workflow primitives — one question at a time, a visible progress
 * track, big tap targets, and a single primary action per step. Used to turn
 * dense forms into a sequence a first-time user can follow without training.
 */

export function GuidedProgress({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="guided-progress" aria-label="Progress">
      {steps.map((label, i) => (
        <li
          key={label}
          className={`guided-progress-step ${i < current ? 'is-done' : ''} ${i === current ? 'is-on' : ''}`}
          aria-current={i === current ? 'step' : undefined}
        >
          <span className="guided-progress-dot">{i < current ? '✓' : i + 1}</span>
          <span className="guided-progress-label">{label}</span>
        </li>
      ))}
    </ol>
  );
}

export function StepShell({
  step,
  of,
  title,
  hint,
  onBack,
  children,
  footer,
}: {
  step: number;
  of: number;
  title: string;
  hint?: string;
  onBack?: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="guided">
      <header className="guided-head">
        {onBack ? (
          <button type="button" className="btn btn-ghost guided-back" onClick={onBack}>
            ← Back
          </button>
        ) : (
          <span className="guided-back-spacer" />
        )}
        <div className="guided-meta">Step {step} of {of}</div>
        <h1 className="guided-title">{title}</h1>
        {hint ? <p className="muted guided-hint">{hint}</p> : null}
      </header>
      <div className="guided-body">{children}</div>
      {footer ? <div className="guided-foot">{footer}</div> : null}
    </div>
  );
}

export function ChoiceGrid({ children }: { children: ReactNode }) {
  return (
    <div className="guided-choice-grid" role="list">
      {children}
    </div>
  );
}

export function Choice({
  icon,
  label,
  hint,
  selected,
  onClick,
}: {
  icon: string;
  label: string;
  hint?: string;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="listitem"
      className={`guided-choice ${selected ? 'is-on' : ''}`}
      onClick={onClick}
      aria-pressed={selected ?? false}
    >
      <span className="guided-choice-icon" aria-hidden="true">{icon}</span>
      <span className="guided-choice-text">
        <strong>{label}</strong>
        {hint ? <span>{hint}</span> : null}
      </span>
    </button>
  );
}
