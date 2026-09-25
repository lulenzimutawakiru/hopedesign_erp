/**
 * Focus management shared by the three blocking overlays: `Modal`,
 * `ConfirmDialog` and `Drawer`.
 *
 * Three call sites is where the house rule (`component-library.md` §8 — read
 * §100) says to extract rather than duplicate, and the contract is genuinely
 * identical across all three: remember the control that opened the overlay,
 * move focus inside it, keep `Tab` inside while it is open, and hand focus back
 * on the way out.
 *
 * `Escape` is opted into per call site rather than baked in. `Modal` and
 * `Drawer` close on `Escape`; `ConfirmDialog` deliberately does not — it
 * front-loads a destructive decision (`accessibility.md` §6 item 2), so the
 * only ways out are its explicit "Keep as-is" control or the backdrop. A
 * reflex keypress must not stand in for an informed choice.
 */

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useDialogFocus<T extends HTMLElement>(
  panelRef: RefObject<T>,
  onEscape?: () => void
): void {
  // The callback is held in a ref so the effect below can depend on nothing but
  // the panel. Callers pass inline arrows, so binding the handler directly
  // would tear down and rebuild the trap on every render — which would rip
  // focus out of a field mid-keystroke.
  const escapeRef = useRef(onEscape);
  useEffect(() => {
    escapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const invoker = document.activeElement as HTMLElement | null;
    // Note: no visibility filter. `offsetParent` is always null under jsdom, so
    // filtering would collapse the list and silently defeat the trap in tests.
    const focusables = () => Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));

    (focusables()[0] ?? panel).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!escapeRef.current) return;
        event.preventDefault();
        escapeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || current === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Only restore if the invoker is still on screen; a control that unmounted
      // with its page would otherwise swallow focus into nowhere.
      if (invoker?.isConnected) invoker.focus();
    };
  }, [panelRef]);
}
