/**
 * Focus behavior shared by the anchored, non-modal popovers: `ScopeChip`,
 * `UserMenu` and `CreateMenu`.
 *
 * These are deliberately *not* `useDialogFocus` — they do not trap Tab, so a
 * keyboard user can tab straight out of a menu into the page. What they do need
 * is (a) close on an outside click and (b) hand focus back to the trigger on
 * Escape, so dismissing a menu never dumps focus onto `<body>`.
 */

import { useEffect, useRef, type RefObject } from 'react';

export function usePopover(
  open: boolean,
  onClose: () => void
): { rootRef: RefObject<HTMLDivElement>; triggerRef: RefObject<HTMLButtonElement> } {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Latest-ref so the listeners can be registered once instead of churning on
  // every render (same reason useDialogFocus holds its callback in a ref).
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) closeRef.current();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      closeRef.current();
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return { rootRef, triggerRef };
}
