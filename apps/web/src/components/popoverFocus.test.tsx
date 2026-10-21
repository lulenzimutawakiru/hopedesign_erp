import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { useMenu, usePopover } from './popoverFocus';

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

function TestMenu() {
  const [open, setOpen] = useState(false);
  const { rootRef, triggerRef, panelRef } = useMenu(open, () => setOpen(false));
  return (
    <div ref={rootRef}>
      <button ref={triggerRef} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        Menu
      </button>
      {open && (
        <div role="menu" ref={panelRef}>
          <button role="menuitem">One</button>
          <button role="menuitem">Two</button>
          <button role="menuitem">Three</button>
        </div>
      )}
    </div>
  );
}

describe('useMenu', () => {
  it('roves focus across menuitems with arrow keys', () => {
    render(<TestMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));

    const one = screen.getByRole('menuitem', { name: 'One' });
    const two = screen.getByRole('menuitem', { name: 'Two' });
    const three = screen.getByRole('menuitem', { name: 'Three' });

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(one);

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(two);

    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(one);

    fireEvent.keyDown(document, { key: 'End' });
    expect(document.activeElement).toBe(three);

    fireEvent.keyDown(document, { key: 'Home' });
    expect(document.activeElement).toBe(one);
  });

  it('still closes on Escape and returns focus to the trigger', () => {
    render(<TestMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'One' }));

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Menu' }));
  });
});
