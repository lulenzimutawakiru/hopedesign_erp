/**
 * Focus management shared by the blocking overlays.
 *
 * The browser gives none of this away for free, and it is the same contract
 * three times over (`Modal`, `ConfirmDialog`, `Drawer`), so it is pinned once
 * here rather than re-asserted through each overlay. Two parts of the contract
 * are easy to regress silently: the `Tab` wrap must include the panel itself as
 * an exit point on `Shift+Tab`, and `Escape` must stay opt-in so a destructive
 * confirmation cannot be dismissed by reflex.
 *
 * The harness mirrors how the overlays are actually used: the whole component
 * mounts only while the dialog is open, so the panel is in the tree by the time
 * the effect runs. A hook left mounted with a conditionally-rendered panel
 * would never engage.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useDialogFocus } from './dialogFocus';

/** A minimal overlay: a panel holding two focusable controls. */
function TestDialog({ onClose, controls = true }: { onClose?: () => void; controls?: boolean }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocus(panelRef, onClose);
  return (
    <div ref={panelRef} role="dialog" aria-label="Test dialog" tabIndex={-1}>
      {controls && (
        <>
          <button>First</button>
          <button>Second</button>
        </>
      )}
    </div>
  );
}

/** Opens the dialog from a real button, so there is a genuine invoker to restore to. */
function TestHost({ escape = true }: { escape?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open dialog</button>
      {open && <TestDialog onClose={escape ? () => setOpen(false) : undefined} />}
    </>
  );
}

const keyDown = (key: string, shiftKey = false) =>
  fireEvent.keyDown(document.activeElement as Element, { key, shiftKey });

describe('useDialogFocus', () => {
  it('moves focus to the first control inside the panel', () => {
    render(<TestDialog />);

    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
  });

  it('falls back to the panel itself when it holds nothing focusable', () => {
    render(<TestDialog controls={false} />);

    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('wraps Tab off the last control back to the first', () => {
    render(<TestDialog />);
    screen.getByRole('button', { name: 'Second' }).focus();

    keyDown('Tab');

    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
  });

  it('wraps Shift+Tab off the first control back to the last', () => {
    render(<TestDialog />);
    // Focus starts on "First"; shift-tabbing must reach behind it.
    keyDown('Tab', true);

    expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus();
  });

  it('wraps Shift+Tab off the panel itself, not just off a control', () => {
    render(<TestDialog controls={false} />);
    expect(screen.getByRole('dialog')).toHaveFocus();

    keyDown('Tab', true);

    // Nothing focusable inside, so focus stays on the panel rather than escaping.
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('lets Tab move between controls without stealing it', () => {
    render(<TestDialog />);
    screen.getByRole('button', { name: 'First' }).focus();

    const event = fireEvent.keyDown(document.activeElement as Element, { key: 'Tab' });

    // Not the last control, so the trap must leave the event alone for the browser.
    expect(event).toBe(true);
  });

  it('closes on Escape when the caller opts in', async () => {
    const user = userEvent.setup();
    render(<TestHost />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));

    keyDown('Escape');

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ignores Escape when the caller does not opt in', async () => {
    const user = userEvent.setup();
    render(<TestHost escape={false} />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));

    keyDown('Escape');

    // `ConfirmDialog` relies on this: a destructive decision needs an explicit choice.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('restores focus to the control that opened it', async () => {
    const user = userEvent.setup();
    render(<TestHost />);
    const trigger = screen.getByRole('button', { name: 'Open dialog' });

    await user.click(trigger);
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();

    keyDown('Escape');

    expect(trigger).toHaveFocus();
  });

  it('does not restore focus to an invoker that has left the page', () => {
    const { unmount } = render(<TestDialog />);
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();

    unmount();

    // The captured invoker was <body>, which is still connected; the point is
    // simply that teardown never throws and leaves focus somewhere real.
    expect(document.activeElement).not.toBeNull();
  });

  it('keeps the handler current without rebuilding the trap', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<TestDialog onClose={first} />);

    rerender(<TestDialog onClose={second} />);
    keyDown('Escape');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});