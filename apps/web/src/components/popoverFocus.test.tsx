import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { usePopover } from './popoverFocus';

function TestPopover() {
  const [open, setOpen] = useState(false);
  const { rootRef, triggerRef } = usePopover(open, () => setOpen(false));
  return (
    <div ref={rootRef}>
      <button ref={triggerRef} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        Menu
      </button>
      {open && (
        <div>
          <button>Item one</button>
        </div>
      )}
    </div>
  );
}

describe('usePopover', () => {
  it('closes on Escape and returns focus to the trigger', () => {
    render(<TestPopover />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));

    const item = screen.getByRole('button', { name: 'Item one' });
    item.focus();
    expect(document.activeElement).toBe(item);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('button', { name: 'Item one' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Menu' }));
  });

  it('closes on an outside click', () => {
    render(<TestPopover />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByRole('button', { name: 'Item one' })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole('button', { name: 'Item one' })).not.toBeInTheDocument();
  });
});
