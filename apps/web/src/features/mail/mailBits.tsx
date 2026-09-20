/**
 * Small presentation primitives shared by the Company mail screens.
 *
 * `ui.tsx` Badge() derives its tone from a workflow status string, so it cannot
 * express delivery or classification tone. Mail screens therefore paint the tone
 * computed by `mailDelivery.ts` directly - the tone itself is never guessed here.
 */
import type { DeliveryTone } from './mailDelivery';

export function ToneBadge({ tone, label, title }: { tone: DeliveryTone; label: string; title?: string }) {
  return (
    <span className={'badge ' + tone} title={title}>
      <span className="badge-icon" aria-hidden>
        ●
      </span>
      {label}
    </span>
  );
}

/** A muted, non-interactive note used to explain why something cannot be done. */
export function BlockedNote({ children }: { children: string }) {
  return <p className="cell-sub">{children}</p>;
}
